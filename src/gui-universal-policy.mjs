// OS-neutral GUI authorization and lifecycle policy.
// Native providers report capabilities; this module never performs OS input,
// grants permissions, blocks physical input, owns leases, or clears incidents.
export const GUI_UNIVERSAL_POLICY = Object.freeze({
  ownerIdleAutoApprovalMs: 60_000,
  approvalPromptAutoApprovalMs: 60_000,
  activityEvidenceMaxAgeMs: 5_000,
  maximumLeaseSeconds: 120,
  minimumLeaseSeconds: 10,
  emergencyEvents: Object.freeze([
    'OS_SECURE_ATTENTION','SESSION_LOCKED','SESSION_SWITCHED','SESSION_LOGGED_OUT',
    'PORTAL_DEACTIVATED','PORTAL_CLOSED','AGENT_DISCONNECTED','AGENT_PROCESS_EXITED',
    'LOCAL_STOP','LEASE_EXPIRED','OWNER_REVOKED'
  ])
});
const fail = code => Object.freeze({status:'BLOCKED',code,autoElevate:false,autoReplay:false});
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;
const finite = value => Number.isFinite(value);
const bool = value => typeof value === 'boolean';

function validSession(session) {
  return isRecord(session) && nonEmpty(session.ownerPrincipal) &&
    nonEmpty(session.sessionId) && nonEmpty(session.seatId) &&
    nonEmpty(session.displayId) && session.interactive === true &&
    session.ownerAuthenticated === true;
}
function validActivity(activity, nowMs) {
  return isRecord(activity) && activity.source === 'physical' &&
    activity.reliable === true && activity.excludesSyntheticInput === true &&
    finite(activity.observedAtMs) && activity.observedAtMs <= nowMs &&
    nowMs - activity.observedAtMs <= GUI_UNIVERSAL_POLICY.activityEvidenceMaxAgeMs &&
    finite(activity.idleMs) && activity.idleMs >= 0;
}

export function validateGuiProviderDescriptor(provider) {
  if (!isRecord(provider) || !nonEmpty(provider.providerId) ||
      !nonEmpty(provider.platform) || !nonEmpty(provider.transport) ||
      !validSession(provider.session) || !isRecord(provider.capabilities))
    return fail('GUI_PROVIDER_DESCRIPTOR_INVALID');
  const caps = provider.capabilities;
  for (const key of ['observe','screenshot','activityDetection','physicalInputProtection',
    'emergencyRelease','pointer','keyboard','semanticInvoke','isolatedDesktop']) {
    if (!bool(caps[key])) return fail('GUI_PROVIDER_CAPABILITY_INVALID');
  }
  if (caps.activityDetection === true &&
      (provider.activityEvidenceSource !== 'physical' ||
       provider.activityEvidenceIncludesSynthetic === true))
    return fail('GUI_ACTIVITY_EVIDENCE_NOT_PHYSICAL');
  if (caps.isolatedDesktop === true && provider.isolationAuthority !== 'owner-approved')
    return fail('GUI_ISOLATION_NOT_OWNER_AUTHORIZED');
  return Object.freeze({status:'VALID',providerId:provider.providerId,platform:provider.platform,
    session:Object.freeze({...provider.session}),capabilities:Object.freeze({...caps}),
    autoElevate:false,autoReplay:false});
}

export function evaluateGuiTakeover(input = {}) {
  if (!isRecord(input) || !finite(input.nowMs) || input.nowMs < 0)
    return fail('GUI_POLICY_INPUT_INVALID');
  const providerResult = validateGuiProviderDescriptor(input.provider);
  if (providerResult.status !== 'VALID') return providerResult;
  if (input.currentTaskExplicit !== true) return fail('GUI_CURRENT_TASK_AUTHORIZATION_REQUIRED');
  if (input.ownerRevoked === true) return fail('GUI_OWNER_REVOKED');
  if (input.incidentPending === true) return fail('GUI_INCIDENT_REVIEW_REQUIRED');
  if (input.localStopActive === true) return fail('GUI_LOCAL_STOP');
  const expected=input.expectedSession, actual=providerResult.session;
  if (!validSession(expected) || expected.ownerPrincipal!==actual.ownerPrincipal ||
      expected.sessionId!==actual.sessionId || expected.seatId!==actual.seatId ||
      expected.displayId!==actual.displayId) return fail('GUI_OWNER_SESSION_MISMATCH');
  const caps=providerResult.capabilities;
  if (!caps.observe || !caps.screenshot || !caps.activityDetection || !caps.emergencyRelease)
    return fail('GUI_REQUIRED_PROVIDER_CAPABILITY_UNAVAILABLE');
  const requested=input.requestedInput??{};
  if (!isRecord(requested) || !bool(requested.pointer) || !bool(requested.keyboard))
    return fail('GUI_INPUT_SCOPE_INVALID');
  if (requested.pointer && !caps.pointer) return fail('GUI_POINTER_UNAVAILABLE');
  if (requested.keyboard && !caps.keyboard) return fail('GUI_KEYBOARD_UNAVAILABLE');
  if (!requested.pointer && !requested.keyboard) return fail('GUI_INPUT_SCOPE_EMPTY');
  const protectedPhysical=caps.physicalInputProtection===true;
  const approvedIsolation=caps.isolatedDesktop===true &&
    input.provider.isolationAuthority==='owner-approved';
  if ((requested.pointer || requested.keyboard) && !protectedPhysical && !approvedIsolation)
    return fail('GUI_PHYSICAL_INPUT_PROTECTION_UNAVAILABLE');
  if (!validActivity(input.activityEvidence,input.nowMs))
    return fail('GUI_ACTIVITY_EVIDENCE_UNAVAILABLE_OR_STALE');
  if (input.approvalDenied===true) return fail('GUI_OWNER_DENIED');

  let approvalMode=null;
  if (input.explicitOwnerApproval===true) approvalMode='EXPLICIT';
  else if (input.activityEvidence.idleMs>=GUI_UNIVERSAL_POLICY.ownerIdleAutoApprovalMs)
    approvalMode='AUTO_IDLE_60S';
  else if (input.approvalPromptVisible===true && finite(input.approvalPromptElapsedMs) &&
      input.approvalPromptElapsedMs>=GUI_UNIVERSAL_POLICY.approvalPromptAutoApprovalMs &&
      input.approvalDenied!==true)
    approvalMode='AUTO_UNREJECTED_PROMPT_60S';
  else return Object.freeze({status:'WAITING_OWNER',code:'GUI_OWNER_APPROVAL_PENDING',
    showApprovalPrompt:true,autoElevate:false,autoReplay:false});

  const ttl=input.leaseTtlSeconds??GUI_UNIVERSAL_POLICY.maximumLeaseSeconds;
  if (!Number.isInteger(ttl) || ttl<GUI_UNIVERSAL_POLICY.minimumLeaseSeconds ||
      ttl>GUI_UNIVERSAL_POLICY.maximumLeaseSeconds) return fail('GUI_LEASE_TTL_INVALID');
  const expectedProtectionKind=protectedPhysical?'NATIVE_PHYSICAL_INPUT_PROTECTION':'OWNER_APPROVED_ISOLATED_DESKTOP';
  const receipt=input.inputProtectionReceipt;
  if (!isRecord(receipt) || receipt.active!==true ||
      receipt.kind!==expectedProtectionKind ||
      receipt.providerId!==providerResult.providerId ||
      receipt.sessionId!==providerResult.session.sessionId ||
      !nonEmpty(receipt.leaseId) || receipt.leaseId.length>128 ||
      receipt.releaseOnAgentExit!==true || receipt.releaseOnEmergency!==true ||
      !finite(receipt.expiresAtMs) || receipt.expiresAtMs<=input.nowMs ||
      receipt.expiresAtMs>input.nowMs+ttl*1000) {
    return fail('GUI_INPUT_PROTECTION_NOT_ACQUIRED');
  }
  return Object.freeze({status:'GRANTED',code:'GUI_TAKEOVER_ADMITTED',approvalMode,
    providerId:providerResult.providerId,platform:providerResult.platform,session:providerResult.session,
    requestedInput:Object.freeze({...requested}),
    inputProtection:expectedProtectionKind,inputProtectionLeaseId:receipt.leaseId,
    inputProtectionExpiresAtMs:receipt.expiresAtMs,
    leaseTtlSeconds:ttl,expiresAtMs:Math.min(input.nowMs+ttl*1000,receipt.expiresAtMs),autoElevate:false,autoReplay:false});
}

export function mustReleaseGuiLease(event) {
  return GUI_UNIVERSAL_POLICY.emergencyEvents.includes(event);
}

export function classifyGuiActionOutcome(receipt = {}) {
  if (!isRecord(receipt)) return fail('GUI_ACTION_RECEIPT_INVALID');
  if (receipt.actionIssued===false)
    return Object.freeze({status:'NOT_DISPATCHED',retryPolicy:'NEW_OWNER_DECISION',autoReplay:false});
  if (receipt.actionIssued!==true || receipt.nativeAcknowledged!==true)
    return Object.freeze({status:'UNCERTAIN',code:'GUI_NATIVE_OUTCOME_UNKNOWN',
      retryPolicy:'OWNER_RECONCILIATION_REQUIRED',autoReplay:false});
  if (receipt.foregroundStatus!=='PRESERVED')
    return Object.freeze({status:'UNCERTAIN',code:'GUI_FOREGROUND_NONINTERFERENCE_UNPROVEN',
      retryPolicy:'OWNER_RECONCILIATION_REQUIRED',autoReplay:false});
  if (receipt.independentVerification!==true)
    return Object.freeze({status:'ACKNOWLEDGED_UNVERIFIED',code:'GUI_APPLICATION_RESULT_NOT_VERIFIED',
      retryPolicy:'VERIFY_WITHOUT_REPLAY',autoReplay:false});
  return Object.freeze({status:'VERIFIED',code:'GUI_ACTION_VERIFIED',retryPolicy:'NONE',autoReplay:false});
}
