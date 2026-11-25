import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { GUI_RULES, guiError, guiToolDefinitions, validateGuiInput } from './gui-contract.mjs';
import { createGuiProcessClient, runGuiProcess } from './gui-process.mjs';
import { createGuiInputIncidentStore } from './gui-incident-store.mjs';
import { evaluateGuiTakeover, mustReleaseGuiLease } from './gui-universal-policy.mjs';
import { createGuiNativeSessionProvider } from './gui-native-session-provider.mjs';
import { createWindowsGuiNativeAdapter } from './gui-windows-native-provider.mjs';
import { createLinuxGuiInputCaptureAdapter } from './gui-linux-input-capture-provider.mjs';
export { guiToolDefinitions };

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stopFile = path.join(project, 'var', 'GUI_STOP');
const globalStopFile = process.platform === 'linux' ? path.join(process.env.XDG_STATE_HOME || path.join(process.env.HOME || '', '.local', 'state'), 'chatgpt-remote-commander', 'GUI_STOP') : null;
const windowsHelper = path.join(project, 'tools', 'gui-control.ps1');
// Select a native helper for the *actual session*, never GNOME Mutter on KDE.
const kdeDesktop = (() => {
  if (process.platform === 'linux' && process.env.RC_FORCE_KDE_PORTAL === '1') return true;
  if (/(?:^|:)(?:KDE|plasma)(?=:|$)/i.test(
    [process.env.XDG_CURRENT_DESKTOP ?? '', process.env.XDG_SESSION_DESKTOP ?? ''].join(':'))) return true;
  if (process.platform !== 'linux') return false;
  try {
    const uid = process.getuid();
    const sessions = execFileSync('/usr/bin/loginctl', ['list-sessions','--no-legend','--no-pager'],
      { encoding:'utf8', timeout:2500, maxBuffer:32768 });
    for (const line of sessions.split('\n')) {
      const [sid, owner] = line.trim().split(/\s+/);
      if (String(owner) !== String(uid) || !/^[A-Za-z0-9]+$/.test(sid || '')) continue;
      const detail = execFileSync('/usr/bin/loginctl', ['show-session',sid,
        '-p','Desktop','-p','Type','-p','Active'],
        { encoding:'utf8', timeout:2500, maxBuffer:8192 });
      if (/^Desktop=KDE$/m.test(detail) && /^Type=wayland$/m.test(detail) &&
          /^Active=yes$/m.test(detail)) return true;
    }
  } catch { /* Missing session metadata never grants input. */ }
  return false;
})();
const linuxHelper = path.join(project, 'tools', kdeDesktop ?
  'gui-control-kde-portal.py' : 'gui-control-linux.py');
const backendSpec = platform => platform === 'win32'
  ? { file: 'pwsh.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', windowsHelper, '-Server'], oneShotArgs: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', windowsHelper] }
  : platform === 'linux'
    ? { file: 'python3', args: [linuxHelper, '--server'], oneShotArgs: [linuxHelper] }
    : null;
const defaultBackend = backendSpec(process.platform);
const persistentHelper = defaultBackend ? createGuiProcessClient({ file: defaultBackend.file, args: defaultBackend.args, timeoutForRequest: request => kdeDesktop && request.action==='screenshot' ? 60000 : 15000 }) : null;
const invokeDefault = request => {
  if (persistentHelper) return persistentHelper.invoke(request);
  if (!defaultBackend) throw guiError('GUI_PLATFORM_BACKEND_UNSUPPORTED');
  return runGuiProcess(request, { file: defaultBackend.file, args: defaultBackend.oneShotArgs });
};
const closeInvokeDefault = () => persistentHelper?.close();
async function stopped() {
  for (const candidate of [stopFile, globalStopFile].filter(Boolean)) {
    try { await access(candidate); return true; }
    catch (error) { if (error.code !== 'ENOENT') throw guiError('GUI_STOP_CHECK_FAILED'); }
  }
  return false;
}
const sameToken = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const bound = (v, low, high, defaultValue) => Number.isSafeInteger(v) ? Math.max(low, Math.min(high, v)) : defaultValue;

/** One controller per MCP process. A lease prevents accidental cross-chat input.
 * It is NOT an account/OS sandbox. Another authorized shell or OS user can bypass
 * application coordination; distinct trust levels require separate OS sessions.
 */
export function createGuiController({ platform = process.platform, now = () => performance.now(), token = () => randomBytes(24).toString('hex'), isStopped = stopped,
  invoke = invokeDefault, closeInvoke = closeInvokeDefault, incidentStore = createGuiInputIncidentStore(), takeoverProvider = undefined } = {}) {
  const nativeTakeoverProvider = takeoverProvider !== undefined ? takeoverProvider :
    platform === 'win32' && process.platform === 'win32'
      ? createGuiNativeSessionProvider(createWindowsGuiNativeAdapter({projectRoot:project}))
      : platform === 'linux' && process.platform === 'linux'
        ? createGuiNativeSessionProvider(createLinuxGuiInputCaptureAdapter({projectRoot:project}))
        : null;
  let session = null;
  let frame = null;
  let busy = false;
  let queuedObservation = null;
  let uncertain = false;
  let emergencyRevision = 0;
  let lastEmergencyEvent = null;
  let emergencyRelease = Promise.resolve();
  function current() { return session; }
  if (typeof nativeTakeoverProvider?.subscribeEmergency === 'function') {
    nativeTakeoverProvider.subscribeEmergency(event => {
      if (!mustReleaseGuiLease(event)) return;
      emergencyRevision++;
      lastEmergencyEvent = event;
      const revoked = session;
      session = null;
      frame = null;
      if (revoked?.nativeLeaseId && typeof nativeTakeoverProvider.release === 'function') {
        emergencyRelease = Promise.resolve()
          .then(() => nativeTakeoverProvider.release({platform,leaseId:revoked.nativeLeaseId,reason:event}))
          .then(result => { if (result?.ok !== true) uncertain = true; })
          .catch(() => { uncertain = true; })
          .finally(() => { try { closeInvoke(); } catch { uncertain = true; } });
      }
    });
  }
  function owns(value) {
    if (!current() || !sameToken(value, session.id)) throw guiError('GUI_LEASE_REQUIRED_OR_EXPIRED');
  }
  async function execute(ctx, name, raw = {}, alreadyWaited = false) {
    const input = validateGuiInput(name, raw);
    const rule = GUI_RULES.get(name);
    const power = ctx.config?.powerMode;
    const cfg = power?.guiControl ?? {};
    const windowsInputActions = new Set(['move','moveRelative','scroll','click','drag','typeText','keyPress','focusWindow']);
    const invokeNative = request => {
      if (request.action==='releaseTakeover' && typeof nativeTakeoverProvider?.release==='function')
        return nativeTakeoverProvider.release({platform,ctx,...request});
      if (platform==='win32' && session?.mode==='takeover' &&
          windowsInputActions.has(request.action) &&
          typeof nativeTakeoverProvider?.invokeInput==='function')
        return nativeTakeoverProvider.invokeInput(request);
      return invoke(platform==='linux' && kdeDesktop && cfg.kdePortalRuntime===true
        ? {...request,kdePortalRuntime:true} : request);
    };
    await emergencyRelease;
    async function releaseProtection(target, reason) {
      if (!target?.nativeLeaseId) { await closeInvoke(); return; }
      let released = null;
      try { released = await invokeNative({ action:'releaseTakeover', leaseId:target.nativeLeaseId, reason, stopFile }); }
      catch { /* Process/agent disconnect is the OS adapter's secondary release mechanism. */ }
      await closeInvoke();
      if (released?.ok !== true) {
        uncertain = true;
        throw guiError('GUI_INPUT_PROTECTION_RELEASE_UNCONFIRMED');
      }
    }
    async function expireSession() {
      if (session && session.expires <= now()) {
        const expired = session;
        session = null; frame = null;
        await releaseProtection(expired, 'LEASE_EXPIRED');
      }
    }
    await expireSession();
    const supported = platform === 'win32' || platform === 'linux';
    const enabled = supported && power?.enabled === true && cfg.enabled === true;
    const blocked = await isStopped();
    let pendingIncident = null, incidentStoreUnavailable = false;
    try { pendingIncident = await incidentStore.pending(); }
    catch { incidentStoreUnavailable = true; } // A corrupt/unreadable record never grants input.
    const uncertainNow = uncertain || !!pendingIncident;
    // Any observed safety stop, disabled input or unreadable J01 evidence
    // permanently revokes a preexisting takeover lease. Recovery of the
    // underlying condition never silently restores prior desktop input rights.
    if ((!enabled || blocked || incidentStoreUnavailable || uncertainNow) &&
        current()?.mode === 'takeover') {
      const revoked = session;
      session.mode = 'observe';
      session.authorization = uncertainNow ? 'incident-observe-only' : 'safety-stop-revoked';
      frame = null;
      await releaseProtection(revoked, uncertainNow ? 'INCIDENT_REVIEW_REQUIRED' : blocked ? 'LOCAL_STOP' : 'POLICY_REVOKED');
    }
    if (name === 'gui_status' && (!enabled || blocked || incidentStoreUnavailable)) return {
      enabled, available: false, inputAvailable: false, blocked, uncertain: uncertainNow,
      busy, leased: !!current(), incidentStoreUnavailable, incidentPending: !!pendingIncident,
      reason: !supported ? 'PLATFORM_BACKEND_UNSUPPORTED' : blocked ? 'LOCAL_GUI_STOP' :
        incidentStoreUnavailable ? 'GUI_INCIDENT_STORAGE_UNAVAILABLE' : 'GUI_DISABLED'
    };
    if (!enabled) throw guiError('GUI_DISABLED_OR_UNSUPPORTED');
    if (blocked) throw guiError('GUI_LOCAL_STOP');
    if (incidentStoreUnavailable) throw guiError('GUI_INCIDENT_STORAGE_UNAVAILABLE');
    // An unacknowledged historical input may already have executed. Read-only
    // desktop observation must not be confused with permission to send input:
    // this code never resolves/replays the journal or opens a takeover lease.
    const observeOnly = uncertainNow;
    if (name === 'gui_status' && observeOnly) {
      let native = {ok:false,available:false};
      if (!busy) {
        try {native=await invokeNative({action:'status',stopFile});}
        catch { /* A read-only backend failure cannot release the incident. */ }
      }
      const readOnlyAvailable=native?.ok===true&&native.available===true;
      return {
        enabled, available: false, readOnlyAvailable, inputAvailable: false,
        blocked:false, uncertain:true, busy, leased: !!current(),
        incidentStoreUnavailable:false, incidentPending:!!pendingIncident,
        incident:pendingIncident??null, reason:'GUI_INCIDENT_REVIEW_REQUIRED'
      };
    }
    if (observeOnly) {
      const observations = new Set([
        'gui_session_begin','gui_session_renew','gui_session_end',
        'gui_screenshot','gui_cursor_position','gui_list_windows'
      ]);
      if (!observations.has(name) ||
          (name==='gui_session_begin' && input.mode==='takeover'))
        throw guiError('GUI_INCIDENT_REVIEW_REQUIRED');
    }
    // One bounded waiter for read-only observation or lease cleanup only.
    // Never queue mouse/keyboard/focus; their observed frame could be stale.
    if (busy) {
      const readOnly = new Set(['gui_status','gui_screenshot','gui_list_windows','gui_cursor_position','gui_session_end']);
      if (alreadyWaited || !readOnly.has(name) || queuedObservation) throw guiError('GUI_BUSY');
      await new Promise((resolve, reject) => {
        const ticket = { resolve, timer: null };
        ticket.timer = setTimeout(() => {
          if (queuedObservation === ticket) queuedObservation = null;
          reject(guiError('GUI_BUSY'));
        }, 2500);
        queuedObservation = ticket;
      });
      // Full re-admission: STOP, incident, lease, permissions and frame state may have changed.
      return execute(ctx, name, raw, true);
    }
    busy = true;
    try {
      if (name === 'gui_session_begin') {
        if (current()) throw guiError('GUI_LEASE_BUSY');
        const status = await invokeNative({ action: 'status', stopFile });
        if (status?.ok !== true) throw guiError(status?.error || 'GUI_NATIVE_FAILED');
        if (status.available !== true) throw guiError('GUI_DESKTOP_UNAVAILABLE');
        // Full Power and historical persistent grants do not replace per-task native owner consent.
        const mode = observeOnly ? 'observe' : input.mode ?? 'observe';
        const ttlSeconds = input.ttlSeconds ?? 60;
        let policy = null;
        if (mode === 'takeover') {
          const admissionEmergencyRevision = emergencyRevision;
          const requestedInput = { pointer:cfg.allowMouse === true, keyboard:cfg.allowKeyboard === true };
          const grant = nativeTakeoverProvider
            ? await nativeTakeoverProvider({ platform, ctx, requestedInput, ttlSeconds, stopFile })
            : await invokeNative({ action:'beginTakeover', requestedInput, ttlSeconds, currentTaskExplicit:true, stopFile });
          if (emergencyRevision !== admissionEmergencyRevision) {
            if (grant?.inputProtectionReceipt?.leaseId) {
              try { await invokeNative({action:'releaseTakeover',leaseId:grant.inputProtectionReceipt.leaseId,reason:lastEmergencyEvent??'EMERGENCY_DURING_ADMISSION',stopFile}); }
              catch { await closeInvoke(); }
            }
            throw guiError('GUI_EMERGENCY_RELEASE_DURING_ADMISSION');
          }
          if (grant?.ok !== true || !grant.takeoverEvidence || !grant.inputProtectionReceipt) {
            if (grant?.inputProtectionReceipt?.leaseId) {
              try { await invokeNative({action:'releaseTakeover',leaseId:grant.inputProtectionReceipt.leaseId,reason:'INVALID_GRANT',stopFile}); }
              catch { await closeInvoke(); }
            }
            throw guiError(grant?.error || 'GUI_TAKEOVER_EVIDENCE_UNAVAILABLE');
          }
          policy = evaluateGuiTakeover({
            ...grant.takeoverEvidence,
            nowMs:Date.now(),
            currentTaskExplicit:true,
            incidentPending:false,
            localStopActive:false,
            requestedInput,
            leaseTtlSeconds:ttlSeconds,
            inputProtectionReceipt:grant.inputProtectionReceipt
          });
          if (policy.status !== 'GRANTED') {
            try { await invokeNative({action:'releaseTakeover',leaseId:grant.inputProtectionReceipt.leaseId,reason:policy.code,stopFile}); }
            catch { await closeInvoke(); }
            throw guiError(policy.code);
          }
        }
        session = {
          id:token(),
          expires:policy ? now() + Math.max(0,policy.expiresAtMs-Date.now()) : now() + ttlSeconds * 1000,
          mode,
          authorization:observeOnly ? 'incident-observe-only' : mode==='takeover' ? 'universal-'+policy.approvalMode.toLowerCase() : 'observe-default',
          nativeLeaseId:policy?.inputProtectionLeaseId??null,
          nativeProtectionExpiresAtMs:policy?.inputProtectionExpiresAtMs??null,
          takeoverPolicy:policy
        };
        if (session.expires <= now()) {
          const expired = session; session = null;
          await releaseProtection(expired,'LEASE_EXPIRED_DURING_ADMISSION');
          throw guiError('GUI_INPUT_PROTECTION_LEASE_EXPIRED');
        }
        frame = null;
        return { ok:true,lease:session.id,ttlSeconds,mode,authorization:session.authorization,
          coordinationOnly:mode!=='takeover',interactiveTakeover:mode==='takeover',
          takeoverApproval:policy?.approvalMode??null,
          inputProtection:policy?.inputProtection??null };
      }
      if (name === 'gui_status') {
        const status = await invokeNative({ action: 'status', stopFile });
        if (status?.ok !== true) throw guiError(status?.error || 'GUI_NATIVE_FAILED');
        return { ...status, enabled, busy: false, leased: !!current(), backend: status.backend ?? (platform === 'win32' ? 'windows-user32-gdi' : 'gnome-shell-wayland'), policy: {
          allowScreenshot: cfg.allowScreenshot === true, allowWindowEnumeration: cfg.allowWindowEnumeration === true || cfg.allowWindowFocus === true, allowMouse: cfg.allowMouse === true,
          allowKeyboard: cfg.allowKeyboard === true, allowWindowFocus: cfg.allowWindowFocus === true,
          defaultSessionMode: 'observe', explicitTakeoverRequired: true,
          interactionPolicy: 'explicit-current-request-only', backgroundPreferred: true,
          workflowTakeoverAllowed: false, ownerAuthorizedTakeover: cfg.ownerAuthorizedTakeover === true,
          staleSchemaTakeoverFallback: cfg.ownerAuthorizedTakeover === true && ctx.config?.capabilityProfile?.tier === 'FULL_POWER' && ctx.config?.capabilityProfile?.explicitlyAuthorized === true,
          foregroundInterferenceByDefault: false
        } };
      }
      owns(input.lease);
      if (name === 'gui_session_renew') {
        if (session.mode === 'takeover') {
          // No renewal may extend the Core lease beyond the native input-protection lease.
          // A new takeover requires fresh provider evidence and a new protection receipt.
          session.mode='observe';session.authorization='takeover-renewal-requires-readmission';frame=null;
          await releaseProtection(session,'RENEWAL_REQUIRES_READMISSION');
          throw guiError('GUI_TAKEOVER_RENEWAL_REQUIRES_NEW_ADMISSION');
        }
        session.expires = now() + (input.ttlSeconds ?? 60) * 1000;
        return { ok:true,ttlSeconds:input.ttlSeconds??60 };
      }
      if (name === 'gui_session_end') {
        const ended = session;
        session = null; frame = null;
        await releaseProtection(ended, 'OWNER_RELEASE');
        return {ok:true};
      }
      // Listing windows is observational and does not require permission to shift focus.
      // Preserve legacy allowWindowFocus=true configurations during migration.
      const allowed = rule.capability === 'allowWindowEnumeration'
        ? (cfg.allowWindowEnumeration === true || cfg.allowWindowFocus === true)
        : cfg[rule.capability] === true;
      if (!allowed) throw guiError('GUI_CAPABILITY_DISABLED');
      const isInput = rule.annotations.destructiveHint === true;
      if (isInput && session.mode !== 'takeover') throw guiError('GUI_TAKEOVER_NOT_AUTHORIZED');
      let observed = null;
      if (isInput) {
        if (!frame || !sameToken(input.frame, frame.id) || now() - frame.at > 15000) throw guiError('GUI_FRESH_FRAME_REQUIRED');
        observed = frame.snapshot;
        frame = null; // Consume BEFORE attempting injection. Never replay an uncertain action.
      }
      const { lease: ignoredLease, frame: ignoredFrame, ...parameters } = input;
      const request = { ...parameters, action: rule.action, stopFile }; // Fixed dispatch LAST, never user-controllable.
      if (isInput) request.expected = observed;
      if (name === 'gui_screenshot') {
        request.maxWidth = Math.min(parameters.maxWidth ?? 1600, bound(cfg.maxScreenshotWidth, 320, 1920, 1600));
        request.maxBytes = bound(cfg.maxScreenshotBytes, 262144, 4194304, 2097152);
      }
      // Write and fsync a minimal private pending record BEFORE any mutating helper call.
      // A crash between dispatch and native acknowledgment must not reset safety on restart.
      let pendingHandle = null;
      if (isInput) {
        try { pendingHandle = await incidentStore.begin(name); if(platform==='linux' && kdeDesktop) request.nativeOperationId=pendingHandle.id; }
        catch {
          const revoked = session; session = null; frame = null;
          await releaseProtection(revoked, 'INCIDENT_STORAGE_UNAVAILABLE');
          throw guiError('GUI_INCIDENT_STORAGE_UNAVAILABLE');
        }
      }
      let result;
      try { result = await invokeNative(request); }
      catch (error) {
        if (isInput) {
          // Exact Linux click pre-dispatch rejection only; no input was ever applied.
          const linuxNotApplied = platform === 'linux' && name === 'gui_mouse_click' &&
            ['GUI_FOREGROUND_OR_GEOMETRY_CHANGED','GUI_POINT_OUTSIDE_MONITOR'].includes(error?.guiCode) &&
            error?.guiNotApplied === true;
          // Windows focus only: native helper's exact pre-dispatch mutex receipt.
          // Does not resolve historical incidents, change other input, or permit replay.
          const windowsMutexNotSubmitted = platform === 'win32' && name === 'gui_focus_window' &&
            error?.guiCode === 'GUI_NATIVE_BUSY' && error?.guiNotApplied === true &&
            error?.guiWindowsMutexPreDispatch === true;
          const kdeNotApplied = platform === 'linux' && kdeDesktop &&
            error?.guiKdePreDispatch === true && error?.guiNotApplied === true &&
            ['GUI_KDE_PRECHECK_FAILED','GUI_FOREGROUND_OR_GEOMETRY_CHANGED'].includes(error?.guiCode);
          const provenNoEffect = linuxNotApplied || windowsMutexNotSubmitted || kdeNotApplied;
          if (provenNoEffect) {
            try { await incidentStore.resolve(pendingHandle); }
            catch { uncertain = true; session = null; frame = null; closeInvoke(); throw guiError('GUI_INCIDENT_STORAGE_UNAVAILABLE'); }
          }
          uncertain = !provenNoEffect;
          const revoked = session; session = null; frame = null;
          await releaseProtection(revoked, provenNoEffect ? 'NATIVE_PRE_DISPATCH_REJECTED' : 'NATIVE_OUTCOME_UNCERTAIN');
        }
        throw error;
      }
      if (result?.ok !== true) {
        if (isInput) {
          uncertain = true; const revoked = session; session = null; frame = null;
          await releaseProtection(revoked, 'NATIVE_OUTCOME_UNCERTAIN');
        }
        throw guiError(result?.error || 'GUI_NATIVE_FAILED');
      }
      if (isInput) {
        try { await incidentStore.resolve(pendingHandle); }
        catch {
          uncertain = true; const revoked = session; session = null; frame = null;
          await releaseProtection(revoked, 'INCIDENT_RESOLUTION_UNCONFIRMED');
          throw guiError('GUI_INCIDENT_STORAGE_UNAVAILABLE');
        }
      }
      if (name === 'gui_screenshot') {
        const { data, mimeType, ...meta } = result;
        if (!['image/jpeg', 'image/png'].includes(mimeType) || typeof data !== 'string' || data.length === 0 || data.length % 4 || data.length > Math.ceil(request.maxBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw guiError('GUI_INVALID_IMAGE');
        const bytes = Buffer.from(data, 'base64');
        const signature = mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
        const snap = meta.snapshot;
        if (bytes.length > request.maxBytes || !signature || !snap || typeof snap.foreground !== 'string' || !Number.isInteger(snap.processId) || !snap.bounds || ['left','top','width','height'].some(k => !Number.isSafeInteger(snap.bounds[k])) || !Number.isSafeInteger(snap.screenIndex)) throw guiError('GUI_INVALID_IMAGE_METADATA');
        if (!Number.isSafeInteger(meta.width) || !Number.isSafeInteger(meta.height) || meta.width < 1 || meta.height < 1 || meta.width > request.maxWidth || meta.height > 16384 || snap.bounds.width < 1 || snap.bounds.height < 1) throw guiError('GUI_INVALID_IMAGE_DIMENSIONS');
        if (!session || !sameToken(input.lease,session.id)) throw guiError('GUI_LEASE_REQUIRED_OR_EXPIRED');
        if (session.expires <= now()) {
          const expired=session;session=null;frame=null;
          await releaseProtection(expired,'LEASE_EXPIRED_DURING_OPERATION');
          throw guiError('GUI_LEASE_REQUIRED_OR_EXPIRED');
        }
        frame = { id: token(), at: now(), snapshot: snap };
        const structured = { ...meta, frame: frame.id, frameMaxAgeMs: 15000, bytes: bytes.length, mimeType };
        return { __mcpContent: [{ type: 'image', mimeType, data }, { type: 'text', text: JSON.stringify(structured) }], __structuredContent: structured };
      }
      return isInput ? { ...result, submitted: true, visualVerificationRequired: true } : result;
    } finally {
      busy = false;
      if (queuedObservation) {
        const ticket = queuedObservation;
        queuedObservation = null;
        clearTimeout(ticket.timer);
        ticket.resolve();
      }
    }
  }
  return { execute };
}
const controller = createGuiController();
export async function executeGuiTool(ctx, name, input) { return controller.execute(ctx, name, input); }
