// V2-G1 guarded operation adapter. NOT wired to the legacy loopback MCP HTTP endpoint.
// The endpoint transport guard is not a user/chat authenticator. The four callbacks
// below must come from an authorized principal/session worker and existing Commander
// access/lease/receipt services, not from request headers, tool arguments, or model text.
import { createHash } from 'node:crypto';
import {
  normalizeV2Route, assertV2CallerBinding, v2ResourceLeaseKey,
  v2OperationKey
} from './v2-routing-contract.mjs';

function fail(code) {
  throw Object.assign(new Error(code), { code });
}
function requireFunction(value) {
  if (typeof value !== 'function') fail('V2_TRUSTED_DEPENDENCY_REQUIRED');
}
/**
 * Fail-closed single-operation admission.
 * @param {object} route - Requested, untrusted routing selection.
 * @param {object} services - Trusted host dependencies (never composed from RPC args).
 *   observedCaller(): immutable authenticated principal/profile/conversation/host binding
 *   hasGrant(route): true iff registry currently permits this exact target and action
 *   withLease(resourceKey, work): invokes work only while holding a host-global lease
 *   receiptStore: existing MutationIdempotencyStore (durable scoped at-most-once)
 *   execute(route): effect through the already-authorized Commander tool entrypoint
 * @param {string} tool - Exact approved Commander tool identity for receipt conflict checking.
 */
export async function executeV2BoundOperation(route, services, tool) {
  const r = normalizeV2Route(route);
  if (!services || typeof services !== 'object') fail('V2_TRUSTED_DEPENDENCY_REQUIRED');
  for (const name of ['observedCaller', 'hasGrant', 'withLease', 'execute']) {
    requireFunction(services[name]);
  }
  if (!services.receiptStore || typeof services.receiptStore.execute !== 'function') fail('V2_TRUSTED_DEPENDENCY_REQUIRED');
  if (typeof tool !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(tool)) fail('V2_INVALID_TOOL');

  const check = async () => {
    // Fail closed if the identity provider cannot supply a verified exact identity.
    const observed = await services.observedCaller();
    assertV2CallerBinding(r, observed);
    if (await services.hasGrant(r, tool) !== true) fail('V2_GRANT_REQUIRED');
  };
  await check();  // No queue/receipt reservation on wrong principal or denied grant.
  const resource = v2ResourceLeaseKey(r);
  const requestId = createHash('sha256').update(v2OperationKey(r)).digest('hex');
  // The caller's shared lease implementation must be machine-global and canonical,
  // NOT an in-process Map or a per-chat lock. The existing WorkflowStore owns roots.
  return services.withLease(resource, async () => {
    await check(); // Protect the gap between admission and lease acquisition.
    return services.receiptStore.execute(
      { requestId, tool, input: services.receiptInput??{ route: r } },
      async () => {
        await check(); // Protect the gap between receipt reservation and effect.
        return services.execute(r);
      }
    );
  });
}
