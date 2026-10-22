import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { GUI_RULES, guiError, guiToolDefinitions, validateGuiInput } from './gui-contract.mjs';
import { createGuiProcessClient, runGuiProcess } from './gui-process.mjs';
import { createGuiInputIncidentStore } from './gui-incident-store.mjs';
export { guiToolDefinitions };

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stopFile = path.join(project, 'var', 'GUI_STOP');
const globalStopFile = process.platform === 'linux' ? path.join(process.env.XDG_STATE_HOME || path.join(process.env.HOME || '', '.local', 'state'), 'chatgpt-remote-commander', 'GUI_STOP') : null;
const windowsHelper = path.join(project, 'tools', 'gui-control.ps1');
const linuxHelper = path.join(project, 'tools', 'gui-control-linux.py');
const backendSpec = platform => platform === 'win32'
  ? { file: 'pwsh.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', windowsHelper, '-Server'], oneShotArgs: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', windowsHelper] }
  : platform === 'linux'
    ? { file: 'python3', args: [linuxHelper, '--server'], oneShotArgs: [linuxHelper] }
    : null;
const defaultBackend = backendSpec(process.platform);
const persistentHelper = defaultBackend ? createGuiProcessClient({ file: defaultBackend.file, args: defaultBackend.args }) : null;
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
  invoke = invokeDefault, closeInvoke = closeInvokeDefault, incidentStore = createGuiInputIncidentStore(), ownerSessionStatusProbe = null } = {}) {
  let session = null;
  let frame = null;
  let busy = false;
  let uncertain = false;
  function current() {
    if (session && session.expires <= now()) { session = null; frame = null; closeInvoke(); }
    return session;
  }
  function owns(value) {
    if (!current() || !sameToken(value, session.id)) throw guiError('GUI_LEASE_REQUIRED_OR_EXPIRED');
  }
  async function execute(ctx, name, raw = {}) {
    const input = validateGuiInput(name, raw);
    const rule = GUI_RULES.get(name);
    const power = ctx.config?.powerMode;
    const cfg = power?.guiControl ?? {};
    const supported = platform === 'win32' || platform === 'linux';
    const enabled = supported && power?.enabled === true && cfg.enabled === true;
    const blocked = await isStopped();
    let pendingIncident = null, incidentStoreUnavailable = false;
    try { pendingIncident = await incidentStore.pending(); }
    catch { incidentStoreUnavailable = true; } // A corrupt/unreadable record never grants input.
    const uncertainNow = uncertain || !!pendingIncident;
    if (name === 'gui_status' && (!enabled || blocked || uncertainNow || incidentStoreUnavailable)) return {
      enabled, available: false, blocked, uncertain: uncertainNow, busy, leased: !!current(),
      incidentStoreUnavailable, incidentPending: !!pendingIncident,
      reason: !supported ? 'PLATFORM_BACKEND_UNSUPPORTED' : blocked ? 'LOCAL_GUI_STOP' :
        incidentStoreUnavailable ? 'GUI_INCIDENT_STORAGE_UNAVAILABLE' :
        uncertainNow ? 'NATIVE_OUTCOME_UNCERTAIN_RESTART_REQUIRED' : 'GUI_DISABLED'
    };
    if (!enabled) throw guiError('GUI_DISABLED_OR_UNSUPPORTED');
    if (blocked) throw guiError('GUI_LOCAL_STOP');
    if (incidentStoreUnavailable) throw guiError('GUI_INCIDENT_STORAGE_UNAVAILABLE');
    if (uncertainNow) throw guiError('GUI_OUTCOME_UNCERTAIN_RESTART_REQUIRED');
    // No stale action queue: concurrent work must retry with a NEW observation.
    if (busy) throw guiError('GUI_BUSY');
    busy = true;
    try {
      if (name === 'gui_session_begin') {
        if (current()) throw guiError('GUI_LEASE_BUSY');
        const status = await invoke({ action: 'status', stopFile });
        if (status?.ok !== true) throw guiError(status?.error || 'GUI_NATIVE_FAILED');
        if (status.available !== true) throw guiError('GUI_DESKTOP_UNAVAILABLE');
        const ownerAuthorizedFallback = cfg.ownerAuthorizedTakeover === true && ctx.config?.capabilityProfile?.tier === 'FULL_POWER' && ctx.config?.capabilityProfile?.explicitlyAuthorized === true;
        const mode = input.mode ?? (ownerAuthorizedFallback ? 'takeover' : 'observe');
        session = { id: token(), expires: now() + (input.ttlSeconds ?? 60) * 1000, mode, authorization: input.mode === 'takeover' ? 'per-call' : ownerAuthorizedFallback ? 'owner-persisted' : 'observe-default' };
        frame = null;
        return { ok: true, lease: session.id, ttlSeconds: input.ttlSeconds ?? 60, mode, authorization: session.authorization, coordinationOnly: true, interactiveTakeover: mode === 'takeover' };
      }
      if (name === 'gui_status') {
        const status = await invoke({ action: 'status', stopFile });
        if (status?.ok !== true) throw guiError(status?.error || 'GUI_NATIVE_FAILED');
        // Owner-session readiness is STATUS metadata, not permission for desktop control.
        // Authenticated Session 1 state never makes Session 0's native GUI available.
        let ownerSessionBridge;
        if (platform === 'win32' && status.available === false &&
            cfg.ownerSessionBridgeReadOnly === true && typeof ownerSessionStatusProbe === 'function') {
          try {
            const proof = await ownerSessionStatusProbe();
            const valid = proof && proof.ok === true && proof.authenticated === true &&
              proof.protocol === 1 && proof.backend === 'windows-owner-session-namedpipe-readonly' &&
              Number.isSafeInteger(proof.ownerSession) && proof.ownerSession > 0 &&
              Number.isSafeInteger(proof.ownerDisplayWidth) && proof.ownerDisplayWidth >= 1 && proof.ownerDisplayWidth <= 16384 &&
              Number.isSafeInteger(proof.ownerDisplayHeight) && proof.ownerDisplayHeight >= 1 && proof.ownerDisplayHeight <= 16384 &&
              Array.isArray(proof.operations) && proof.operations.length === 1 && proof.operations[0] === 'status' &&
              proof.screenshot === false && proof.mouse === false && proof.keyboard === false && proof.focus === false;
            ownerSessionBridge = valid ? {
              state: 'AUTHENTICATED_READONLY', ownerSession: proof.ownerSession,
              displayWidth: proof.ownerDisplayWidth, displayHeight: proof.ownerDisplayHeight,
              screenshot: false, input: false, takeover: false, nativeGuiRoutable: false
            } : { state: 'UNAVAILABLE', nativeGuiRoutable: false };
          } catch { ownerSessionBridge = { state: 'UNAVAILABLE', nativeGuiRoutable: false }; }
        }
        return { ...status, ...(ownerSessionBridge ? { ownerSessionBridge } : {}),
          enabled, busy: false, leased: !!current(), backend: status.backend ?? (platform === 'win32' ? 'windows-user32-gdi' : 'gnome-shell-wayland'), policy: {
          allowScreenshot: cfg.allowScreenshot === true, allowMouse: cfg.allowMouse === true,
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
        session.expires = now() + (input.ttlSeconds ?? 60) * 1000;
        return { ok: true, ttlSeconds: input.ttlSeconds ?? 60 };
      }
      if (name === 'gui_session_end') { session = null; frame = null; closeInvoke(); return { ok: true }; }
      if (cfg[rule.capability] !== true) throw guiError('GUI_CAPABILITY_DISABLED');
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
        try { pendingHandle = await incidentStore.begin(name); }
        catch {
          session = null; frame = null; closeInvoke();
          throw guiError('GUI_INCIDENT_STORAGE_UNAVAILABLE');
        }
      }
      let result;
      try { result = await invoke(request); }
      catch (error) {
        if (isInput) {
          // Exact Linux click pre-dispatch rejection only; no input was ever applied.
          const linuxNotApplied = platform === 'linux' && name === 'gui_mouse_click' &&
            error?.guiCode === 'GUI_FOREGROUND_OR_GEOMETRY_CHANGED' && error?.guiNotApplied === true;
          // Windows focus only: native helper's exact pre-dispatch mutex receipt.
          // Does not resolve historical incidents, change other input, or permit replay.
          const windowsMutexNotSubmitted = platform === 'win32' && name === 'gui_focus_window' &&
            error?.guiCode === 'GUI_NATIVE_BUSY' && error?.guiNotApplied === true &&
            error?.guiWindowsMutexPreDispatch === true;
          const provenNoEffect = linuxNotApplied || windowsMutexNotSubmitted;
          if (provenNoEffect) {
            try { await incidentStore.resolve(pendingHandle); }
            catch { uncertain = true; session = null; frame = null; closeInvoke(); throw guiError('GUI_INCIDENT_STORAGE_UNAVAILABLE'); }
          }
          uncertain = !provenNoEffect;
          session = null; frame = null; closeInvoke();
        }
        throw error;
      }
      if (result?.ok !== true) {
        if (isInput) { uncertain = true; session = null; frame = null; closeInvoke(); }
        throw guiError(result?.error || 'GUI_NATIVE_FAILED');
      }
      if (isInput) {
        try { await incidentStore.resolve(pendingHandle); }
        catch {
          uncertain = true; session = null; frame = null; closeInvoke();
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
        owns(input.lease); // Helper execution must not revive a lease that expired meanwhile.
        frame = { id: token(), at: now(), snapshot: snap };
        const structured = { ...meta, frame: frame.id, frameMaxAgeMs: 15000, bytes: bytes.length, mimeType };
        return { __mcpContent: [{ type: 'image', mimeType, data }, { type: 'text', text: JSON.stringify(structured) }], __structuredContent: structured };
      }
      return isInput ? { ...result, submitted: true, visualVerificationRequired: true } : result;
    } finally { busy = false; }
  }
  return { execute };
}
const controller = createGuiController();
export async function executeGuiTool(ctx, name, input) { return controller.execute(ctx, name, input); }
