import { requestPrivilegeBroker, requestGrantedPrivilegeBroker } from './privilege-client.mjs';
import { loadNativeGrantCredential } from './native-grant-credentials.mjs';

const FIXED_TARGET = Object.freeze({
  linux: { action: 'system_unit.status', kind: 'systemd-unit', name: 'chatgpt-remote-commander.service' },
  win32: { action: 'broker.task.status', kind: 'scheduled-task', name: 'ChatGPTRemoteCommander-PrivilegeBroker' }
});

function assertPower(ctx) {
  if (ctx?.config?.powerMode?.enabled !== true) throw new Error('POWER_MODE_DISABLED');
}
/**
 * Application-level defense in depth. This checks only trusted runtime config.
 * A same-UID client can still address the current native Linux broker directly:
 * broker-side per-profile actor verification remains a separate release gate.
 * The ownerGrant here must never be advertised as native OS authorization.
 */
export function fixedStartProfilePolicy(ctx) {
  const config = ctx?.config;
  const profile = config?.capabilityProfile;
  const id = profile?.id;
  const grant = config?.privilegedOperations?.ownerGrant;
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) &&
    config?.instance?.profile === id &&
    config?.powerMode?.enabled === true &&
    profile?.tier === 'FULL_ACCESS' &&
    profile?.explicitlyAuthorized === true &&
    config?.privilegedOperations?.allowStartCommanderSystemUnit === true &&
    grant?.approved === true && grant?.revoked === false &&
    grant?.profileId === id && grant?.action === 'system_unit.start';
}

function verifiedIdentity(platform, answer) {
  if (!answer || answer.ok !== true || answer.action !== 'os.probe') return false;
  if (platform === 'win32') return answer.isSystem === true && answer.sid === 'S-1-5-18';
  if (platform === 'linux') return answer.root === true && answer.effectiveUid === 0;
  return false;
}

/**
 * Real fixed-action broker diagnostics. A verified root/SYSTEM identity is
 * not authority for arbitrary commands or newly registered service actions.
 */
export async function privilegedOperationStatus(ctx, {
  platform = process.platform, request = requestPrivilegeBroker, record = async () => {}
} = {}) {
  assertPower(ctx);
  const target = FIXED_TARGET[platform];
  if (!target) return {
    supported: false, brokerVerified: false, operationalFullAccess: false,
    unrestrictedAdminShell: false, code: 'PRIVILEGED_PLATFORM_UNSUPPORTED'
  };
  const identity = await request('os.probe', { platform });
  const brokerVerified = verifiedIdentity(platform, identity);
  const state = brokerVerified
    ? await request(target.action, { platform })
    : { ok: false, code: identity?.code || 'BROKER_IDENTITY_NOT_VERIFIED' };
  await record({ action: 'privileged_operation_status', ok: brokerVerified && state.ok === true,
    platform, target: target.name });
  return {
    supported: true,
    brokerVerified,
    actionScope: 'fixed-allowlist',
    operationalFullAccess: false,
    unrestrictedAdminShell: false,
    ownerApprovalForNewActionsRequired: true,
    target,
    targetStatus: state,
    // App policy is not the broker's actor authentication or an OS-wide grant.
    nativeProfileBindingVerified: false,
    // A config flag alone is not broker admission. Do not advertise it as an
    // operationally available mutation before native credential provisioning.
    allowedMutations: [],
    appPolicyEligibleMutations: platform === 'linux' && fixedStartProfilePolicy(ctx)
      ? ['system_unit.start'] : []
  };
}

/**
 * This is the only existing privileged mutation supported by the Linux broker.
 * There are deliberately no user-supplied commands, service names or paths.
 * The current production unit is usually user-level; do not start a missing
 * system-level unit or silently change its installation.
 */
export async function startPrivilegedCommanderUnit(ctx, {
  platform = process.platform, request = requestPrivilegeBroker,
  requestAuthorized = requestGrantedPrivilegeBroker, nativeGrantKey = null,
  credentialLoader = loadNativeGrantCredential, record = async () => {}
} = {}) {
  assertPower(ctx);
  if (platform !== 'linux') throw new Error('PRIVILEGED_ACTION_PLATFORM_NOT_SUPPORTED');
  if (!fixedStartProfilePolicy(ctx)) {
    await record({ action: 'system_unit.start', phase: 'app-profile-admission',
      ok: false, reason: 'PRIVILEGED_ACTION_OWNER_POLICY_REQUIRED' });
    throw new Error('PRIVILEGED_ACTION_OWNER_POLICY_REQUIRED');
  }
  await record({ action: 'system_unit.start', phase: 'app-profile-admission',
    profileId: ctx.config.capabilityProfile.id, ok: true });
  // The trusted systemd service supplies a binary key via
  // LoadCredentialEncrypted. Never read keys from config or MCP arguments.
  let grantKey = nativeGrantKey;
  if (grantKey === null) {
    try {
      grantKey = await credentialLoader(ctx.config.capabilityProfile.id, { platform });
    } catch {
      grantKey = null; // Fail closed without leaking credential details.
    }
  }
  if (!Buffer.isBuffer(grantKey) || grantKey.length !== 32) {
    await record({ action: 'system_unit.start', phase: 'native-grant-admission',
      profileId: ctx.config.capabilityProfile.id, ok: false,
      reason: 'PRIVILEGED_NATIVE_PROFILE_CREDENTIAL_REQUIRED' });
    throw new Error('PRIVILEGED_NATIVE_PROFILE_CREDENTIAL_REQUIRED');
  }
  const identity = await request('os.probe', { platform });
  if (!verifiedIdentity(platform, identity)) throw new Error('PRIVILEGED_BROKER_IDENTITY_REQUIRED');
  const before = await request('system_unit.status', { platform });
  if (!before?.ok || before.action !== 'system_unit.status' ||
      before.unit !== FIXED_TARGET.linux.name || before.state?.LoadState !== 'loaded') {
    await record({ action: 'system_unit.start', target: FIXED_TARGET.linux.name,
      ok: false, reason: 'UNIT_NOT_INSTALLED_OR_UNVERIFIED' });
    throw new Error('PRIVILEGED_UNIT_NOT_INSTALLED_OR_UNVERIFIED');
  }
  if (before.state.ActiveState === 'active') {
    return { ok: true, changed: false, unit: FIXED_TARGET.linux.name, state: before.state };
  }
  await record({ action: 'system_unit.start', target: FIXED_TARGET.linux.name, phase: 'attempt', ok: false });
  // Never issue the legacy unauthenticated mutation request, even when the
  // installed broker still implements the historical protocol.
  const started = await requestAuthorized('system_unit.start', {
    platform, profileId: ctx.config.capabilityProfile.id, grantKey
  });
  const after = await request('system_unit.status', { platform });
  const ok = started?.ok === true && after?.ok === true &&
    after.unit === FIXED_TARGET.linux.name && after.state?.ActiveState === 'active';
  await record({ action: 'system_unit.start', target: FIXED_TARGET.linux.name,
    phase: 'verified-effect', ok });
  if (!ok) throw new Error('PRIVILEGED_UNIT_START_NOT_VERIFIED');
  return { ok: true, changed: true, unit: FIXED_TARGET.linux.name, state: after.state };
}
