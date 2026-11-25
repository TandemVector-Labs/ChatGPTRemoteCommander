// OS-neutral adapter orchestration for native GUI session providers.
// OS-specific code owns identity, physical-activity observation, consent UI and
// input interception. This module does not synthesize these capabilities.
import { evaluateGuiTakeover, validateGuiProviderDescriptor } from './gui-universal-policy.mjs';

const REQUIRED = Object.freeze([
  'describeSession',
  'getPhysicalActivityEvidence',
  'requestOwnerApproval',
  'acquireProtection',
  'releaseProtection',
  'subscribeEmergency'
]);
const fail = code => ({ok:false,error:code,autoReplay:false,autoElevate:false});
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);

export function createGuiNativeSessionProvider(adapter) {
  if (!record(adapter) || REQUIRED.some(name => typeof adapter[name] !== 'function')) {
    throw new TypeError('GUI_NATIVE_PROVIDER_ADAPTER_INCOMPLETE');
  }

  const provider = async request => {
    if (!record(request) || request.currentTaskExplicit !== true) {
      return fail('GUI_CURRENT_TASK_AUTHORIZATION_REQUIRED');
    }
    const ttlSeconds = request.ttlSeconds ?? 60;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 10 || ttlSeconds > 120) {
      return fail('GUI_LEASE_TTL_INVALID');
    }
    const requestedInput = request.requestedInput;
    if (!record(requestedInput) || typeof requestedInput.pointer !== 'boolean' ||
        typeof requestedInput.keyboard !== 'boolean' ||
        (!requestedInput.pointer && !requestedInput.keyboard)) {
      return fail('GUI_INPUT_SCOPE_INVALID');
    }

    let descriptor;
    try { descriptor = await adapter.describeSession(); }
    catch { return fail('GUI_OWNER_SESSION_UNAVAILABLE'); }
    const valid = validateGuiProviderDescriptor(descriptor);
    if (valid.status !== 'VALID') return fail(valid.code);
    if (request.platform && descriptor.platform !== request.platform) {
      return fail('GUI_PROVIDER_PLATFORM_MISMATCH');
    }
    const caps = descriptor.capabilities;
    if (!caps.observe || !caps.screenshot || !caps.activityDetection || !caps.emergencyRelease ||
        (requestedInput.pointer && !caps.pointer) ||
        (requestedInput.keyboard && !caps.keyboard)) {
      return fail('GUI_REQUIRED_PROVIDER_CAPABILITY_UNAVAILABLE');
    }
    if ((requestedInput.pointer || requestedInput.keyboard) &&
        !caps.physicalInputProtection &&
        !(caps.isolatedDesktop && descriptor.isolationAuthority === 'owner-approved')) {
      return fail('GUI_PHYSICAL_INPUT_PROTECTION_UNAVAILABLE');
    }

    // A provider may not have a pre-capture physical-idle sensor (notably
    // XDG InputCapture on Wayland). Missing/unreliable pre-capture evidence
    // disables the idle-auto route but may still use the visible 60s prompt
    // route. The protection acquisition must then return fresh physical-only
    // evidence from the activated native capture session.
    let activity = null;
    try {
      const candidate = await adapter.getPhysicalActivityEvidence({session:descriptor.session});
      if (record(candidate) && candidate.source === 'physical' &&
          candidate.reliable === true && candidate.excludesSyntheticInput === true &&
          Number.isFinite(candidate.observedAtMs) && candidate.observedAtMs <= Date.now() &&
          Date.now() - candidate.observedAtMs <= 5000 &&
          Number.isFinite(candidate.idleMs) && candidate.idleMs >= 0) activity = candidate;
    } catch { /* Prompt path remains available; idle-auto never does. */ }
    const idleAutoEligible = activity !== null && activity.idleMs >= 60_000;

    let approval = {
      explicitOwnerApproval:false,
      approvalDenied:false,
      approvalPromptVisible:false,
      approvalPromptElapsedMs:0,
      physicalActivityAfterPrompt:false
    };
    if (!idleAutoEligible) {
      try {
        const response = await adapter.requestOwnerApproval({
          session:descriptor.session,
          requestedInput,
          timeoutMs:60_000,
          physicalActivityEvidence:activity
        });
        if (!record(response)) return fail('GUI_OWNER_APPROVAL_RESPONSE_INVALID');
        approval = {...approval,...response};
      } catch {
        return fail('GUI_OWNER_APPROVAL_UNAVAILABLE');
      }
      if (approval.approvalDenied === true) return fail('GUI_OWNER_DENIED');
      if (approval.explicitOwnerApproval !== true &&
          !(approval.approvalPromptVisible === true &&
            Number.isFinite(approval.approvalPromptElapsedMs) &&
            approval.approvalPromptElapsedMs >= 60_000)) {
        return Object.freeze({
          ok:false,error:'GUI_OWNER_APPROVAL_PENDING',status:'WAITING_OWNER',
          autoReplay:false,autoElevate:false
        });
      }
    }

    // The adapter must acquire native protection and take a fresh physical
    // activity sample atomically enough to reject activity in the admission gap.
    let protection;
    try {
      protection = await adapter.acquireProtection({
        session:descriptor.session,
        provider:descriptor,
        requestedInput,
        ttlSeconds,
        approvalMode:approval.explicitOwnerApproval ? 'EXPLICIT' :
          idleAutoEligible ? 'AUTO_IDLE_60S' : 'AUTO_UNREJECTED_PROMPT_60S'
      });
    } catch (error) {
      // Preserve only a bounded, structured adapter code; never leak raw
      // D-Bus messages, paths, prompts, or input payloads to the caller.
      const code = typeof error?.code === 'string' &&
        /^GUI_[A-Z0-9_]{1,96}$/.test(error.code)
        ? error.code : 'GUI_INPUT_PROTECTION_ACQUISITION_FAILED';
      return fail(code);
    }
    const receipt = protection?.receipt;
    const releaseProvisional = async reason => {
      if (!receipt?.leaseId) return;
      try { await adapter.releaseProtection({session:descriptor.session,leaseId:receipt.leaseId,reason}); }
      catch { /* Adapter's release-on-process-exit and emergency contract remains mandatory. */ }
    };
    if (protection?.ok !== true || !record(receipt)) {
      await releaseProvisional('INVALID_PROTECTION_RECEIPT');
      return fail(protection?.error || 'GUI_INPUT_PROTECTION_NOT_ACQUIRED');
    }
    const freshActivity = protection.activityEvidence;
    if (!record(freshActivity)) {
      await releaseProvisional('ACTIVITY_EVIDENCE_MISSING');
      return fail('GUI_ACTIVITY_EVIDENCE_UNAVAILABLE_OR_STALE');
    }

    const evidence = {
      provider:descriptor,
      expectedSession:descriptor.session,
      activityEvidence:freshActivity,
      currentTaskExplicit:true,
      explicitOwnerApproval:approval.explicitOwnerApproval === true,
      approvalDenied:approval.approvalDenied === true,
      approvalPromptVisible:approval.approvalPromptVisible === true,
      approvalPromptElapsedMs:approval.approvalPromptElapsedMs ?? 0,
      physicalActivityAfterPrompt:approval.physicalActivityAfterPrompt === true,
      requestedInput,
      leaseTtlSeconds:ttlSeconds,
      nowMs:Date.now()
    };
    const admission = evaluateGuiTakeover({
      ...evidence,
      inputProtectionReceipt:receipt
    });
    if (admission.status !== 'GRANTED') {
      await releaseProvisional(admission.code || 'POLICY_REJECTED');
      return fail(admission.code || 'GUI_TAKEOVER_BLOCKED');
    }
    return Object.freeze({
      ok:true,
      takeoverEvidence:evidence,
      inputProtectionReceipt:receipt,
      admission
    });
  };

  provider.release = async request => adapter.releaseProtection(request);
  provider.subscribeEmergency = callback => adapter.subscribeEmergency(callback);
  provider.describeSession = () => adapter.describeSession();
  return provider;
}
