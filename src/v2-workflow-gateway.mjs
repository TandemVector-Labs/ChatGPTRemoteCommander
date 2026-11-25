// V2-G1 candidate adapter using the EXISTING durable Commander WorkflowStore.
// No external API is registered here. Calls must originate from a separately
// authenticated principal/session worker; route fields are never identity proof.
import { normalizeV2Route, assertV2CallerBinding } from './v2-routing-contract.mjs';

function fail(code) { throw Object.assign(new Error(code), { code }); }
function fn(value) { if (typeof value !== 'function') fail('V2_WORKFLOW_TRUSTED_SERVICE_REQUIRED'); }
export async function executeV2WorkflowStep({
  route, stepId, expectedRevision, tool, arguments: args,
  workflowStore, observedCaller, grantRegistry, authorizeTool, dispatch
}) {
  const r = normalizeV2Route(route);
  if (r.target.kind !== 'workflow-root' || r.operationId !== stepId) fail('V2_WORKFLOW_TARGET_OR_STEP_MISMATCH');
  if (!workflowStore || typeof workflowStore.get !== 'function' || typeof workflowStore.call !== 'function'
    || !grantRegistry || typeof grantRegistry.isAllowed !== 'function') fail('V2_WORKFLOW_TRUSTED_SERVICE_REQUIRED');
  fn(observedCaller); fn(authorizeTool); fn(dispatch);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail('V2_WORKFLOW_REVISION_REQUIRED');
  if (typeof tool !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(tool)) fail('V2_WORKFLOW_TOOL_INVALID');
  const check = async () => {
    assertV2CallerBinding(r, await observedCaller());
    // This is not a path-based permission expansion. Device and profile are
    // verified against immutable state stored by WorkflowStore.
    const state = workflowStore.get(r.target.id).state;
    if (state.id !== r.target.id || state.device !== r.hostId
      || state.authority?.profileId !== r.profileId) fail('V2_WORKFLOW_STATE_AUTHORITY_MISMATCH');
    if (grantRegistry.isAllowed(r, tool) !== true) fail('V2_GRANT_REQUIRED');
    return state;
  };
  await check(); // including cached receipt reads, before the store is touched by a call
  return workflowStore.call({
    id: r.target.id, stepId, expectedRevision, tool, arguments: args
  }, {
    validate: async (resolvedTool, resolvedArgs, state) => {
      await check();
      if (state.id !== r.target.id || state.device !== r.hostId
        || state.authority?.profileId !== r.profileId) fail('V2_WORKFLOW_STATE_AUTHORITY_MISMATCH');
      if (await authorizeTool(resolvedTool, resolvedArgs, state) !== true) fail('V2_WORKFLOW_TOOL_AUTH_REQUIRED');
      await check();
    },
    dispatch: async (resolvedTool, resolvedArgs, state) => {
      await check();
      // Actual root lease + PREPARED/EXECUTING/UNCERTAIN state already owned by
      // WorkflowStore.call. Never implement a second competing root lease.
      return dispatch(resolvedTool, resolvedArgs, state);
    }
  });
}
