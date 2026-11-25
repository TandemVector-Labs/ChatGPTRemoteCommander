import { requestPrivilegeBroker } from './privilege-client.mjs';
import { probeWindowsAdministrator } from './windows-admin-token.mjs';
import { verifyPrivilegedBrokerProof } from './capability-profile.mjs';
export { verifyPrivilegedBrokerProof } from './capability-profile.mjs';

const BROKER_ACTIONS = Object.freeze({
  linux: Object.freeze(['os.probe', 'system_unit.status', 'system_unit.start']),
  win32: Object.freeze(['os.probe', 'broker.task.status'])
});

/**
 * Configured tier expresses owner intent; effective tier is determined at
 * runtime. A broker grants only its documented fixed operations, never a
 * generic elevated shell. STANDARD is never auto-promoted by broker presence.
 */
export function assessAccessStatus(config, proof, {
  platform = process.platform, adminToken = null,
  // Never infer native root from the broker's separate root process.
  effectiveUid = platform === 'linux' ? process.geteuid?.() : null
} = {}) {
  const profile = config?.capabilityProfile ?? {};
  // Runtime status must never infer an authorized tier from legacy or malformed power flags.
  // Explicit legacy migration belongs in normalizeCapabilityProfile, not this admission/status path.
  const configuredTier = ['STANDARD', 'FULL_POWER', 'FULL_ACCESS'].includes(profile.tier)
    ? profile.tier : 'STANDARD';
  const nativeBrokerVerified = verifyPrivilegedBrokerProof(proof, platform);
  const grantedByOwner = profile.explicitlyAuthorized === true;
  const fullPowerEnabled = config?.powerMode?.enabled === true;
  // Native SYSTEM/root broker identity does not imply a shell grant.
  // On Windows, an actual elevated token on this *same worker* does.
  // Restricted shell policy or restricted filesystem still disqualifies it.
  const nativeAdminTokenVerified = platform === 'win32' &&
    adminToken?.ok === true && adminToken?.isAdmin === true &&
    adminToken?.isSystem !== true && adminToken?.elevation === 'high' &&
    adminToken?.source === 'local-process-token';
  // This worker must itself be root. A root broker with a UID 1000 worker
  // is only a fixed-action helper, never an unrestricted root shell.
  const nativeRootTokenVerified = platform === 'linux' && effectiveUid === 0;
  // FULL_POWER is owner-token execution, never an elevated Administrator,
  // SYSTEM or root process. A standard/non-elevated token is sufficient; an
  // unknown token probe must not be treated as an ordinary owner token.
  const nativeNonElevatedTokenVerified = platform === 'win32' &&
    adminToken?.ok === true && adminToken?.isAdmin === false &&
    adminToken?.isSystem !== true && adminToken?.elevation === 'standard' &&
    adminToken?.source === 'local-process-token';
  const nativeNonRootTokenVerified = platform === 'linux' &&
    Number.isSafeInteger(effectiveUid) && effectiveUid > 0;
  const hostUserTokenVerified = platform === 'win32' ? nativeNonElevatedTokenVerified
    : platform === 'linux' ? nativeNonRootTokenVerified : false;
  const pm = config?.powerMode ?? {};
  const hostFilesystem = fullPowerEnabled && configuredTier !== 'STANDARD' &&
    grantedByOwner && pm.fullFilesystem === true;
  const shellAvailable = fullPowerEnabled && configuredTier !== 'STANDARD' &&
    grantedByOwner && pm.allowShell === true;
  const noCommanderShellPatternRestrictions = shellAvailable &&
    Array.isArray(pm.blockedShellPatterns) && pm.blockedShellPatterns.length === 0;
  // A configured FULL_ACCESS tier may downgrade to FULL_POWER only when its
  // complete base host-user Shell scope remains intact. Pattern-limited Shell
  // is still a valid explicit restriction for a separately enrolled FULL_POWER.
  const hostUserAccess = hostUserTokenVerified && hostFilesystem && shellAvailable &&
    (configuredTier !== 'FULL_ACCESS' || noCommanderShellPatternRestrictions);
  const adminShellScope = pm.allowShell === true && pm.fullFilesystem === true &&
    pm.allowProcessControl === true && Array.isArray(pm.blockedShellPatterns) &&
    pm.blockedShellPatterns.length === 0;
  // Elevated host capability is operational only when this profile explicitly enrolled FULL_ACCESS.
  // A STANDARD/FULL_POWER profile must not acquire the tier by running under an elevated OS token.
  const operationalFullAccess = configuredTier === 'FULL_ACCESS' && grantedByOwner &&
    fullPowerEnabled && (nativeAdminTokenVerified || nativeRootTokenVerified) && adminShellScope;
  const fullAccessActive = operationalFullAccess;
  const effectiveTier = !fullPowerEnabled || configuredTier === 'STANDARD' ? 'STANDARD'
    : fullAccessActive ? 'FULL_ACCESS' : hostUserAccess ? 'FULL_POWER' : 'STANDARD';
  // Report the first real enrollment prerequisite, including missing owner
  // consent and disabled Power Mode. Do not treat a healthy broker as an OS
  // privilege grant on the current worker.
  const fullAccessBlocker = configuredTier !== 'FULL_ACCESS' || fullAccessActive ? null
    : !grantedByOwner ? 'FULL_ACCESS_OWNER_GRANT_REQUIRED'
    : !fullPowerEnabled ? 'POWER_MODE_DISABLED'
    : platform === 'win32' ? (!nativeAdminTokenVerified
      ? 'WINDOWS_ADMIN_TOKEN_NOT_ELEVATED' : 'FULL_ACCESS_SHELL_SCOPE_REQUIRED')
    : platform === 'linux' ? (!nativeRootTokenVerified
      ? 'LINUX_ROOT_PROCESS_NOT_ELEVATED' : 'FULL_ACCESS_SHELL_SCOPE_REQUIRED')
    : 'PRIVILEGED_ACTION_SCOPE_NOT_READY';
  return {
    configuredTier,
    effectiveTier,
    // FULL_HOST_USER is ordinary owner-token command/file access, not
    // operating-system elevation, and is never a protected-action grant.
    hostExecution: {
      mode: hostUserAccess ? 'FULL_HOST_USER' : 'RESTRICTED',
      hostFilesystem,
      shellAvailable,
      noCommanderShellPatternRestrictions,
      currentProcessTokenVerified: hostUserTokenVerified,
      osTokenBoundaryApplies: true,
      nativeElevationNotImplied: true,
      externalApprovalsNotBypassed: true
    },
    fullAccessConfigured: configuredTier === 'FULL_ACCESS',
    fullAccessActive,
    operationalFullAccess,
    fullAccessBlocker,
    enrollmentRequired: configuredTier === 'FULL_ACCESS' && !fullAccessActive,
    nativeAdmin: {
      verified: nativeAdminTokenVerified,
      nonElevatedTokenVerified: nativeNonElevatedTokenVerified,
      scope: nativeAdminTokenVerified || nativeNonElevatedTokenVerified ? 'current-process-token' : 'unverified',
      unrestrictedAdminShell: platform === 'win32' && operationalFullAccess
    },
    nativeRoot: {
      verified: nativeRootTokenVerified,
      nonRootTokenVerified: nativeNonRootTokenVerified,
      scope: nativeRootTokenVerified || nativeNonRootTokenVerified ? 'current-process-effective-uid' : 'unverified',
      unrestrictedRootShell: platform === 'linux' && operationalFullAccess
    },
    broker: {
      verified: nativeBrokerVerified,
      actionScope: 'fixed-allowlist',
      // The fixed native Broker never grants unrestricted admin shell access;
      // a separately elevated worker belongs to nativeAdmin, not broker.
      operationalFullAccess: false,
      privilegeIdentity: nativeBrokerVerified ? (platform === 'win32' ? 'SYSTEM' : 'root') : null,
      code: nativeBrokerVerified ? 'NATIVE_BROKER_VERIFIED'
        : (typeof proof?.code === 'string' ? proof.code : 'BROKER_NOT_VERIFIED'),
      // A broker can implement a privileged action while this profile has
      // no native grant for it. Status must not present such an action as
      // currently allowed, nor infer per-profile isolation from peer UID.
      supportedActions: [...(BROKER_ACTIONS[platform] ?? [])],
      allowedActions: nativeBrokerVerified
        ? (BROKER_ACTIONS[platform] ?? []).filter(a => a !== 'system_unit.start') : [],
      allowedMutations: [],
      nativeGrantRequiredActions: platform === 'linux' ? ['system_unit.start'] : [],
      nativeProfileBindingVerified: false,
      unrestrictedAdminShell: false
    }
  };
}

export function createAccessStatusReader({
  config, platform = process.platform, probe = requestPrivilegeBroker,
  probeWindowsAdmin = probeWindowsAdministrator,
  now = () => Date.now(), ttlMs = 15_000
}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0 || ttlMs > 120_000) {
    throw new Error('ACCESS_STATUS_CACHE_TTL_INVALID');
  }
  let cached = null;
  let validUntil = 0;
  let pending = null;
  return async function readAccessStatus({ force = false } = {}) {
    const clock = now();
    if (!force && cached && clock < validUntil) return cached;
    if (pending) {
      // A forced authorization recheck must not inherit an older in-flight
      // probe. Wait for it to settle, then start one fresh native observation.
      if (!force) return pending;
      await pending.catch(() => {});
      return readAccessStatus({ force: true });
    }
    pending = (async () => {
      let result;
      try { result = await probe('os.probe', { platform }); }
      catch { result = { ok: false, code: 'BROKER_PROBE_FAILED' }; }
      let adminToken = null;
      if (platform === 'win32') {
        try { adminToken = await probeWindowsAdmin({ platform }); }
        catch { adminToken = {ok:false,code:'WINDOWS_TOKEN_PROBE_FAILED'}; }
      }
      const status = assessAccessStatus(config, result, { platform, adminToken });
      cached = status;
      validUntil = now() + ttlMs;
      return status;
    })();
    try { return await pending; }
    finally { pending = null; }
  };
}
