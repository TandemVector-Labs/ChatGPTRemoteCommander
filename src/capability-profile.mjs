import { createHash } from 'node:crypto';

// Standalone enrollment policy: no dependency on native runtime/status modules.
export function verifyPrivilegedBrokerProof(proof, platform = process.platform) {
  if (proof?.ok !== true || proof.action !== 'os.probe') return false;
  if (platform === 'linux') return proof.root === true && proof.effectiveUid === 0;
  if (platform === 'win32') return proof.isSystem === true && proof.sid === 'S-1-5-18';
  return false;
}

export const CAPABILITY_SCHEMA_VERSION = 4;
export const CAPABILITY_PROFILE_REVISION = 'capability-profile-r4';

export const FULL_WORKFLOW_EXECUTION_TOOLS = Object.freeze([
  'system_status','list_directory','read_text','write_text','run_project_command',
  'power_status','file_info','read_file','write_file','create_directory','copy_path','move_path','delete_path','search_files',
  'run_shell','system_info','list_processes','kill_process','start_terminal','read_terminal','send_terminal','stop_terminal',
  'gui_status','gui_session_begin','gui_session_renew','gui_session_end',
  'gui_screenshot','gui_list_windows','gui_cursor_position',
  'gui_mouse_move','gui_mouse_delta','gui_mouse_scroll','gui_mouse_click','gui_mouse_drag',
  'gui_type_text','gui_key_press','gui_focus_window'
]);

export const CAPABILITIES = Object.freeze([
  'filesystem.full',
  'shell.execute',
  'shell.unrestricted',
  'terminal.persistent',
  'process.control',
  'process.terminate',
  'filesystem.permanent_delete',
  'gui.screenshot',
  'gui.mouse',
  'gui.keyboard',
  'gui.window_focus',
  'browser.background',
  'browser.navigate',
  'browser.input',
  'browser.screenshot',
  'workflow.durable',
  'workflow.autonomous_resume',
  'workflow.scheduler',
  'workflow.reconcile',
  'workflow.checkpoint',
  'workflow.project_brain',
  'workflow.execution_profile_persistence',
  'workflow.project_engine',
  'workflow.crash_recovery',
  'workflow.durable_queue',
  'lifecycle.auto_update',
  'lifecycle.zero_downtime_update'
]);

function clone(value) { return JSON.parse(JSON.stringify(value ?? {})); }
function bool(value) { return value === true; }
function list(value) { return Array.isArray(value) ? [...value] : []; }

export function deriveCapabilitySet(config = {}) {
  const pm = config.powerMode ?? {};
  const gui = pm.guiControl ?? {};
  const browser = pm.browserControl ?? {};
  const wf = config.durableWorkflows ?? {};
  const continuation = wf.continuation ?? {};
  const scheduler = wf.scheduler ?? {};
  const out = new Set();
  if (bool(pm.enabled) && bool(pm.fullFilesystem)) out.add('filesystem.full');
  if (bool(pm.enabled) && bool(pm.allowShell)) {
    out.add('shell.execute');
    if (Array.isArray(pm.blockedShellPatterns) && pm.blockedShellPatterns.length === 0) out.add('shell.unrestricted');
  }
  if (bool(pm.enabled) && bool(pm.allowProcessControl)) {
    out.add('process.control');
    out.add('process.terminate');
    if (bool(pm.allowShell)) out.add('terminal.persistent');
  }
  if (bool(pm.enabled) && bool(pm.allowPermanentDelete)) out.add('filesystem.permanent_delete');
  if (bool(gui.enabled) && bool(gui.allowScreenshot)) out.add('gui.screenshot');
  if (bool(gui.enabled) && bool(gui.allowMouse)) out.add('gui.mouse');
  if (bool(gui.enabled) && bool(gui.allowKeyboard)) out.add('gui.keyboard');
  if (bool(gui.enabled) && bool(gui.allowWindowFocus)) out.add('gui.window_focus');
  if (bool(browser.enabled)) {
    out.add('browser.background');
    if (bool(browser.allowNavigate)) out.add('browser.navigate');
    if (bool(browser.allowInput)) out.add('browser.input');
    if (bool(browser.allowScreenshot)) out.add('browser.screenshot');
  }
  if (bool(wf.enabled)) {
    out.add('workflow.durable');
    out.add('workflow.reconcile');
    out.add('workflow.checkpoint');
  }
  if (bool(continuation.enabled)) out.add('workflow.autonomous_resume');
  if (bool(scheduler.enabled)) {
    out.add('workflow.scheduler');
    out.add('workflow.durable_queue');
    out.add('workflow.crash_recovery');
  }
  if (bool(wf.projectBrain?.enabled)) out.add('workflow.project_brain');
  if (bool(wf.executionProfile?.persist)) out.add('workflow.execution_profile_persistence');
  const profile = config.capabilityProfile ?? {};
  const disabled = new Set(Array.isArray(profile.disabledCapabilities) ? profile.disabledCapabilities : []);
  if ((profile.tier === 'FULL_POWER' || profile.tier === 'FULL_ACCESS') && profile.explicitlyAuthorized === true && !disabled.has('workflow.project_engine')) out.add('workflow.project_engine');
  if (config.autoUpdate?.enabled === true) out.add('lifecycle.auto_update');
  if (config.autoUpdate?.zeroDowntime === true) out.add('lifecycle.zero_downtime_update');
  return [...out].sort();
}

export function normalizeCapabilityProfile(profile, config, { id = 'default', legacyExplicit = false } = {}) {
  const current = profile && typeof profile === 'object' && !Array.isArray(profile) ? clone(profile) : {};
  const inferredFull = config?.powerMode?.enabled === true && config?.powerMode?.fullFilesystem === true;
  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    revision: CAPABILITY_PROFILE_REVISION,
    id: typeof current.id === 'string' && current.id ? current.id : id,
    tier: current.tier === 'FULL_ACCESS' ? 'FULL_ACCESS' : current.tier === 'FULL_POWER' || (current.tier == null && inferredFull) ? 'FULL_POWER' : 'STANDARD',
    explicitlyAuthorized: current.explicitlyAuthorized === true || (current.explicitlyAuthorized == null && legacyExplicit && inferredFull),
    persistAcrossUpdates: current.persistAcrossUpdates !== false,
    autoEnableNewCapabilities: current.autoEnableNewCapabilities === true || (current.autoEnableNewCapabilities == null && inferredFull),
    disabledCapabilities: Array.isArray(current.disabledCapabilities)
      ? [...new Set(current.disabledCapabilities.filter(x => typeof x === 'string' && x.length <= 128))].sort() : [],
    grantedCapabilities: deriveCapabilitySet(config),
    source: typeof current.source === 'string' && current.source ? current.source : (legacyExplicit && inferredFull ? 'legacy-full-power-migration' : 'config-derived')
  };
}

export function mergeConfigDefaults(defaultConfig, existingConfig) {
  const next = clone(defaultConfig);
  const existing = clone(existingConfig);
  const merge = (target, source) => {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
        merge(target[key], value);
      } else {
        target[key] = clone(value);
      }
    }
  };
  merge(next, existing);
  return next;
}

export function migrateCapabilityConfig({
  defaultConfig,
  existingConfig = null,
  profileId = 'default',
  requestPower = false,
  requestFullAccess = false,
  nativeBrokerProof = null,
  nativeBrokerPlatform = process.platform,
  requestStandard = false,
  requestGui = undefined,
  continuationDefaults = true,
  workflowDirectory = null,
  disableCapabilities = [],
  enableCapabilities = []
}) {
  if (!defaultConfig || typeof defaultConfig !== 'object' || Array.isArray(defaultConfig)) throw new Error('CAPABILITY_DEFAULT_CONFIG_REQUIRED');
  if ([requestPower, requestStandard, requestFullAccess].filter(Boolean).length > 1) throw new Error('CAPABILITY_MODE_CONFLICT');
  if (requestFullAccess && !verifyPrivilegedBrokerProof(nativeBrokerProof, nativeBrokerPlatform)) {
    throw new Error('FULL_ACCESS_NATIVE_BROKER_PROOF_REQUIRED');
  }
  const hadExisting = !!existingConfig;
  const existing = existingConfig ? clone(existingConfig) : {};
  const prior = normalizeCapabilityProfile(existing.capabilityProfile, existing, { id: profileId, legacyExplicit: hadExisting });
  const preserveExplicit = hadExisting && (prior.tier === 'FULL_POWER' || prior.tier === 'FULL_ACCESS') && prior.explicitlyAuthorized === true && prior.persistAcrossUpdates === true && !requestStandard;
  // Standard authorization is a persisted restriction, never authority to
  // restore stale Power flags. Legacy partial profiles without an explicit tier
  // retain their existing scope; a new requestPower still takes precedence.
  const inferredPartial = existing.capabilityProfile?.source === 'config-derived'
    && prior.explicitlyAuthorized === false && prior.autoEnableNewCapabilities === false
    && existing.powerMode?.enabled === true && existing.powerMode?.fullFilesystem === false;
  const preserveStandard = hadExisting && existing.capabilityProfile?.tier === 'STANDARD' && !inferredPartial;
  const next = mergeConfigDefaults(defaultConfig, existing);
  const disabled = new Set(prior.disabledCapabilities ?? []);
  const guiCapabilities=['gui.screenshot','gui.mouse','gui.keyboard','gui.window_focus'];
  if (requestGui === false) for (const cap of guiCapabilities) disabled.add(cap);
  if (requestGui === true) for (const cap of guiCapabilities) disabled.delete(cap);
  // Per-capability overrides are the most explicit instruction and therefore
  // take precedence over broad mode/GUI switches.
  for (const cap of disableCapabilities ?? []) {
    if (!CAPABILITIES.includes(cap)) throw new Error('CAPABILITY_UNKNOWN_DISABLE');
    disabled.add(cap);
  }
  for (const cap of enableCapabilities ?? []) {
    if (!CAPABILITIES.includes(cap)) throw new Error('CAPABILITY_UNKNOWN_ENABLE');
    disabled.delete(cap);
  }

  next.powerMode ??= {};
  next.powerMode.guiControl ??= {};
  next.powerMode.browserControl ??= {};
  next.powerMode.codexControl ??= {};
  next.powerMode.guiControl.interactionPolicy = 'explicit-current-request-only';
  next.powerMode.guiControl.defaultSessionMode = 'observe';
  next.powerMode.guiControl.backgroundPreferred = true;
  next.powerMode.guiControl.workflowTakeoverAllowed = false;
  next.powerMode.guiControl.ownerAuthorizedTakeover = existing.powerMode?.guiControl?.ownerAuthorizedTakeover === true;
  next.powerMode.codexControl.allowLaunch = existing.powerMode?.codexControl?.allowLaunch === true;
  next.powerMode.browserControl.backgroundFirst = true;
  next.powerMode.browserControl.allowForegroundFallback = true;
  next.powerMode.browserControl.foregroundFallback = 'explicit-current-request-only';
  next.powerMode.browserControl.workflowBrowserAllowed = false;
  next.powerMode.browserControl.userBrowserProfileReuse = false;
  next.powerMode.browserControl.savedPasswordExtraction = false;
  next.durableWorkflows ??= {};
  next.durableWorkflows.continuation ??= {};
  next.durableWorkflows.scheduler ??= {};
  next.durableWorkflows.projectBrain ??= {};
  next.durableWorkflows.executionProfile ??= {};

  const enableFull = requestPower || requestFullAccess || preserveExplicit;
  if (enableFull) {
    const on = cap => !disabled.has(cap);
    next.powerMode.enabled = true;
    next.powerMode.fullFilesystem = on('filesystem.full');
    next.powerMode.allowShell = on('shell.execute');
    next.powerMode.allowProcessControl = on('process.control');
    next.powerMode.allowPermanentDelete = on('filesystem.permanent_delete');
    next.powerMode.blockedShellPatterns = on('shell.unrestricted') ? [] : (next.powerMode.blockedShellPatterns ?? []);
    next.powerMode.guiControl.enabled = on('gui.screenshot') || on('gui.mouse') || on('gui.keyboard') || on('gui.window_focus');
    next.powerMode.guiControl.allowScreenshot = on('gui.screenshot');
    next.powerMode.guiControl.allowMouse = on('gui.mouse');
    next.powerMode.guiControl.allowKeyboard = on('gui.keyboard');
    next.powerMode.guiControl.allowWindowFocus = on('gui.window_focus');
    next.powerMode.browserControl.enabled = on('browser.background');
    next.powerMode.browserControl.allowNavigate = on('browser.navigate');
    next.powerMode.browserControl.allowInput = on('browser.input');
    next.powerMode.browserControl.allowScreenshot = on('browser.screenshot');
    next.autoUpdate = {
      ...(next.autoUpdate ?? {}),
      enabled: on('lifecycle.auto_update'),
      zeroDowntime: on('lifecycle.zero_downtime_update'),
      channel: next.autoUpdate?.channel ?? 'stable',
      intervalMinutes: next.autoUpdate?.intervalMinutes ?? 15
    };
  } else if (requestStandard || preserveStandard || !hadExisting) {
    next.powerMode.enabled = false;
    next.powerMode.fullFilesystem = false;
    next.powerMode.allowShell = false;
    next.powerMode.allowProcessControl = false;
    next.powerMode.allowPermanentDelete = false;
    next.powerMode.guiControl.enabled = false;
    next.powerMode.browserControl.enabled = false;
    next.powerMode.browserControl.allowNavigate = false;
    next.powerMode.browserControl.allowInput = false;
    next.powerMode.browserControl.allowScreenshot = false;
  }
  // Full Power automatically enables every known workflow capability unless explicitly opted out.
  if (enableFull && next.durableWorkflows.enabled === true) {
    next.durableWorkflows.executionTools = [...FULL_WORKFLOW_EXECUTION_TOOLS];
  }
  if (continuationDefaults && next.durableWorkflows.enabled === true) {
    next.durableWorkflows.continuation = {
      ...(next.durableWorkflows.continuation ?? {}),
      enabled: enableFull ? !disabled.has('workflow.autonomous_resume') : true,
      blindMutationReplay: false,
      readOnly: 'automatic',
      idempotentMutation: 'verify_then_retry',
      uncertainMutation: 'reconcile',
      destructive: 'never_blind',
      externalSideEffect: 'reconcile_or_idempotency_key'
    };
    next.durableWorkflows.scheduler = {
      ...(next.durableWorkflows.scheduler ?? {}),
      enabled: enableFull ? !disabled.has('workflow.scheduler') : true,
      resumeInterrupted: true,
      resumeAfterRestart: true,
      resumeAfterUpdate: true,
      oneWriterPerRoot: true,
      maxConcurrentProjects: Math.max(1, Number(next.durableWorkflows.scheduler?.maxConcurrentProjects ?? 1))
    };
    next.durableWorkflows.projectBrain = {
      ...(next.durableWorkflows.projectBrain ?? {}),
      enabled: enableFull ? !disabled.has('workflow.project_brain') : true
    };
    next.durableWorkflows.executionProfile = {
      ...(next.durableWorkflows.executionProfile ?? {}),
      persist: enableFull ? !disabled.has('workflow.execution_profile_persistence') : true,
      fallbackPolicy: next.durableWorkflows.executionProfile?.fallbackPolicy ?? 'equivalent-or-better'
    };
  }
  if (enableFull && !disabled.has('workflow.durable') && next.durableWorkflows.enabled !== true && typeof workflowDirectory === 'string' && workflowDirectory) {
    next.durableWorkflows.enabled = true;
    next.durableWorkflows.directory = workflowDirectory;
    next.durableWorkflows.executionTools = [...FULL_WORKFLOW_EXECUTION_TOOLS];
    if (continuationDefaults) {
      next.durableWorkflows.continuation = {
        enabled: !disabled.has('workflow.autonomous_resume'), blindMutationReplay: false, readOnly: 'automatic',
        idempotentMutation: 'verify_then_retry', uncertainMutation: 'reconcile',
        destructive: 'never_blind', externalSideEffect: 'reconcile_or_idempotency_key'
      };
      next.durableWorkflows.scheduler = {
        enabled: !disabled.has('workflow.scheduler'), resumeInterrupted: true, resumeAfterRestart: true, resumeAfterUpdate: true,
        oneWriterPerRoot: true, maxConcurrentProjects: 1
      };
      next.durableWorkflows.projectBrain = { enabled: !disabled.has('workflow.project_brain') };
      next.durableWorkflows.executionProfile = { persist: !disabled.has('workflow.execution_profile_persistence'), fallbackPolicy: 'equivalent-or-better' };
    }
  }

  const explicit = requestPower || requestStandard || requestFullAccess ? true : prior.explicitlyAuthorized;
  next.capabilityProfile = normalizeCapabilityProfile({
    ...prior,
    id: profileId,
    tier: requestFullAccess || (preserveExplicit && prior.tier === 'FULL_ACCESS' && !requestPower) ? 'FULL_ACCESS' : enableFull ? 'FULL_POWER' : 'STANDARD',
    explicitlyAuthorized: explicit,
    persistAcrossUpdates: true,
    autoEnableNewCapabilities: enableFull,
    disabledCapabilities: [...disabled].sort(),
    source: requestFullAccess ? 'native-broker-verified-enrollment' : requestPower || requestStandard ? 'explicit-user-authorization' : prior.source
  }, next, { id: profileId, legacyExplicit: hadExisting });

  return {
    config: next,
    profile: next.capabilityProfile,
    previousProfile: prior,
    preservedExplicitAuthority: preserveExplicit,
    sha256: createHash('sha256').update(JSON.stringify(next, null, 2) + '\n').digest('hex')
  };
}

export function compareCapabilityState(expectedConfig, actualConfig) {
  const expectedProfile = normalizeCapabilityProfile(expectedConfig?.capabilityProfile, expectedConfig, { legacyExplicit: true });
  const actualProfile = normalizeCapabilityProfile(actualConfig?.capabilityProfile, actualConfig, { legacyExplicit: true });
  const expected = new Set(expectedProfile.grantedCapabilities);
  const actual = new Set(actualProfile.grantedCapabilities);
  const missing = [...expected].filter(x => !actual.has(x)).sort();
  const unexpected = [...actual].filter(x => !expected.has(x)).sort();
  const tiers = { STANDARD: 0, FULL_POWER: 1, FULL_ACCESS: 2 };
  const tierRegression = tiers[actualProfile.tier] < tiers[expectedProfile.tier];
  return {
    ok: missing.length === 0 && !tierRegression,
    regression: missing.length > 0 || tierRegression,
    code: missing.length ? 'CONFIG_REGRESSION' : tierRegression ? 'ACCESS_TIER_REGRESSION' : 'OK',
    expectedTier: expectedProfile.tier,
    actualTier: actualProfile.tier,
    missing,
    unexpected,
    expectedCapabilities: [...expected].sort(),
    actualCapabilities: [...actual].sort()
  };
}
