// V1-06 protected delivery adapter (not a standalone identity provider).
// Requires V1-01/V1-07 to inject independently authenticated, owner-bound callbacks.
// Protected results MUST carry an immutable bindingEpochHash from original trusted publish;
// unbound legacy deliveries are intentionally invisible to this protected adapter.
// NEVER derive caller identity, authorization, or correlation bindings from MCP arguments.
import {createHash} from 'node:crypto';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONSENT_EPOCH = /^[a-f0-9]{32,64}$/;
function verifiedEpoch(binding) {
  const field = Object.getOwnPropertyDescriptor(binding,'bindingId');
  if (!field || !Object.hasOwn(field,'value') || typeof field.value !== 'string'
    || !CONSENT_EPOCH.test(field.value)) fail('DELIVERY_AUTH_BINDING_EPOCH_REQUIRED');
  return field.value;
}
// sessionId is optional for legacy Host adapters, mandatory when supplied by
// the signed current-chat adapter. A reconnect may change session between
// separate calls, but never during a single claim or ACK.
function trustedSessionId(binding) {
  const descriptor = Object.getOwnPropertyDescriptor(binding,'sessionId');
  if (!descriptor) return null;
  if (!Object.hasOwn(descriptor,'value') || typeof descriptor.value !== 'string'
    || !ID.test(descriptor.value)) fail('DELIVERY_AUTH_BINDING_SESSION_INVALID');
  return descriptor.value;
}
const FIELDS = Object.freeze(['hostId','principalId','profileId','conversationId']);
const INPUT_FIELDS = Object.freeze({
  delivery_list: ['correlationId','after','limit','includeDelivered'],
  delivery_get: ['correlationId','deliveryId'],
  delivery_claim: ['correlationId','deliveryId','attemptId','leaseMs'],
  delivery_ack: ['correlationId','deliveryId','attemptId'],
  delivery_read_artifact: ['correlationId','deliveryId','offset','maxBytes']
});
const USER_METHODS = new Set(Object.keys(INPUT_FIELDS));
const UNTRUSTED_FIELDS = new Set([
  'caller','principal','principalId','profileId','conversationId',
  'hostId','auth','authorization','binding','attestation'
]);
const fail = code => { throw Object.assign(new Error(code), {deliveryCode:code}); };
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const WORKER_ID=/^cw_[a-f0-9]{64}$/;
const WORKER_KEY_ID=/^[a-f0-9]{64}$/;
function workerIdentity(value) {
  if (!record(value) || Object.getPrototypeOf(value)!==Object.prototype
    || Reflect.ownKeys(value).length!==3) fail('DELIVERY_AUTH_WORKER_IDENTITY_INVALID');
  const read=key=>{
    const d=Object.getOwnPropertyDescriptor(value,key);
    if(!d||!d.enumerable||!Object.hasOwn(d,'value'))
      fail('DELIVERY_AUTH_WORKER_IDENTITY_INVALID');
    return d.value;
  };
  const workerId=read('workerId'),workerKeyId=read('workerKeyId');
  const workerGrantRevision=read('workerGrantRevision');
  if(typeof workerId!=='string'||!WORKER_ID.test(workerId)
    ||typeof workerKeyId!=='string'||!WORKER_KEY_ID.test(workerKeyId)
    ||!Number.isSafeInteger(workerGrantRevision)||workerGrantRevision<1)
    fail('DELIVERY_AUTH_WORKER_IDENTITY_INVALID');
  return Object.freeze({workerId,workerKeyId,workerGrantRevision});
}
function identity(value, code) {
  if (!record(value) || FIELDS.some(k => typeof value[k] !== 'string' || !ID.test(value[k]))) fail(code);
  const sessionId=trustedSessionId(value);
  return Object.freeze({
    ...Object.fromEntries(FIELDS.map(k => [k,value[k]])),
    ...(sessionId===null?{}:{sessionId})
  });
}
function equalIdentity(a,b) { return FIELDS.every(k => a[k] === b[k]); }
function safeArgs(name, args) {
  if (!record(args) || Object.getPrototypeOf(args) !== Object.prototype) fail('DELIVERY_AUTH_ARGUMENTS_INVALID');
  const allowed = new Set(INPUT_FIELDS[name]);
  const snapshot = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(args))) {
    if (UNTRUSTED_FIELDS.has(key)) fail('DELIVERY_AUTH_UNTRUSTED_IDENTITY');
    if (!allowed.has(key) || !descriptor.enumerable || !Object.hasOwn(descriptor,'value')
      || descriptor.value === null || (typeof descriptor.value !== 'string'
      && typeof descriptor.value !== 'number' && typeof descriptor.value !== 'boolean'))
      fail('DELIVERY_AUTH_ARGUMENTS_INVALID');
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

/**
 * Protected-only delivery entrypoint. The embedding host must provide all
 * callbacks from outside client-controlled HTTP/MCP request data:
 *   observeCaller() -> independently authenticated host/principal/profile/chat;
 *   resolveBinding(caller) -> same identity + trusted opaque correlationId;
 *   authorizeDelivery(operation) -> true only for a currently granted action.
 *   attestPresentation(receiptRequest) -> independently verified host evidence
 *     that this exact attempt/result was shown to the authenticated target.
 *     Never accept a client-supplied "presentation receipt" as this callback.
 *
 * This module does not authenticate ChatGPT, open a listener, or change legacy
 * tools. The V1-00 integrator must route protected calls here only after V1-01
 * principal verification and V1-07 transport checks; otherwise fail closed.
 */
export function createAuthenticatedDeliveryTools({
  store, observeCaller, resolveBinding, authorizeDelivery, attestPresentation
} = {}) {
  if (!store || typeof store.list !== 'function' || typeof store.get !== 'function'
    || typeof store.claim !== 'function' || typeof store.ack !== 'function'
    || typeof store.readArtifact !== 'function'
    || typeof observeCaller !== 'function'
    || typeof resolveBinding !== 'function'
    || typeof authorizeDelivery !== 'function') fail('DELIVERY_AUTH_TRUSTED_INTEGRATION_REQUIRED');

  return Object.freeze({
    async execute(name, input = {}) {
      if (!USER_METHODS.has(name)) fail('DELIVERY_AUTH_OPERATION_NOT_ALLOWED');
      const args = safeArgs(name,input);
      const caller = identity(await observeCaller(), 'DELIVERY_AUTH_CALLER_REQUIRED');
      const rawBound = await resolveBinding(caller);
      const bound = identity(rawBound, 'DELIVERY_AUTH_BINDING_REQUIRED');
      if (!equalIdentity(caller,bound) || typeof rawBound.correlationId !== 'string' || !ID.test(rawBound.correlationId)) fail('DELIVERY_AUTH_BINDING_MISMATCH');
      if (args.correlationId !== undefined && args.correlationId !== rawBound.correlationId)
        fail('DELIVERY_AUTH_CORRELATION_MISMATCH');
      const bindingId = verifiedEpoch(rawBound);
      const initialSessionId = trustedSessionId(rawBound);
      const bindingEpochHash = createHash('sha256').update(bindingId).digest('hex');
      const checkItem = item => {
        if (item.bindingEpochHash !== bindingEpochHash)
          fail('DELIVERY_AUTH_RESULT_EPOCH_MISMATCH');
        return item;
      };
      const recheckCurrentBinding = async () => {
        const observed = identity(await observeCaller(), 'DELIVERY_AUTH_CALLER_REQUIRED');
        if (!equalIdentity(caller,observed)) fail('DELIVERY_AUTH_SESSION_CHANGED');
        const currentRaw = await resolveBinding(observed);
        const current = identity(currentRaw, 'DELIVERY_AUTH_BINDING_REQUIRED');
        if (!equalIdentity(observed,current)
          || currentRaw.correlationId !== rawBound.correlationId
          || verifiedEpoch(currentRaw) !== bindingId)
          fail('DELIVERY_AUTH_BINDING_CHANGED');
      if (trustedSessionId(currentRaw) !== initialSessionId)
        fail('DELIVERY_AUTH_SESSION_CHANGED');
      };
      const scopedArgs = Object.freeze({...args, correlationId:rawBound.correlationId});
      const operation = Object.freeze({
        name, caller, correlationId:rawBound.correlationId, bindingId,
        deliveryId:args.deliveryId, attemptId:args.attemptId, args:scopedArgs
      });
      if (await authorizeDelivery(operation) !== true) fail('DELIVERY_AUTH_GRANT_REQUIRED');

      // A native session may change while asynchronous authorization is pending.
      // Re-attest the actual caller and its project binding immediately before
      // the synchronous store action; never retry an ambiguous post-effect ACK.
      const currentCaller = identity(await observeCaller(), 'DELIVERY_AUTH_CALLER_REQUIRED');
      if (!equalIdentity(caller,currentCaller)) fail('DELIVERY_AUTH_SESSION_CHANGED');
      const currentBoundRaw = await resolveBinding(currentCaller);
      const currentBound = identity(currentBoundRaw,'DELIVERY_AUTH_BINDING_REQUIRED');
      if (!equalIdentity(currentCaller,currentBound)
        || currentBoundRaw.correlationId !== rawBound.correlationId
        || verifiedEpoch(currentBoundRaw) !== bindingId)
        fail('DELIVERY_AUTH_BINDING_CHANGED');
      if (trustedSessionId(currentBoundRaw) !== initialSessionId)
        fail('DELIVERY_AUTH_SESSION_CHANGED');
      // The verified binding callback itself may await native I/O while the
      // owner's grant is revoked. Never rely only on the pre-binding grant.
      if (await authorizeDelivery(operation) !== true)
        fail('DELIVERY_AUTH_GRANT_REQUIRED');
      // An async grant callback can itself change/revoke the native consent.
      // Re-check immediately after the final policy await, before store access.
      await recheckCurrentBinding();
      if (name === 'delivery_list') return store.list({...scopedArgs,bindingEpochHash});
      if (name === 'delivery_get') return checkItem(store.get(scopedArgs.deliveryId,scopedArgs.correlationId));
      if (name === 'delivery_claim') {
        checkItem(store.get(scopedArgs.deliveryId,scopedArgs.correlationId));
        return store.claim(scopedArgs);
      }
      if (name === 'delivery_ack') {
        // Caller authentication and knowledge of an attemptId do not prove
        // presentation to ChatGPT. Native verified presentation is mandatory.
        if (typeof attestPresentation !== 'function') fail('DELIVERY_AUTH_PRESENTATION_REQUIRED');
        const item = checkItem(store.get(scopedArgs.deliveryId, scopedArgs.correlationId));
        if (item.attemptId !== scopedArgs.attemptId
          || (item.state !== 'DELIVERY_PENDING' && item.state !== 'DELIVERED'))
          fail('DELIVERY_AUTH_PRESENTATION_MISMATCH');
        const worker = item.workerIdentity == null ? null : workerIdentity(item.workerIdentity);
        if (item.originReceiptHash != null && !worker)
          fail('DELIVERY_AUTH_WORKER_IDENTITY_REQUIRED');
        const receiptRequest = Object.freeze({
          ...caller, bindingId, deliveryId:scopedArgs.deliveryId, correlationId:scopedArgs.correlationId,
          attemptId:scopedArgs.attemptId, resultHash:item.resultHash,
          ...(worker ? worker : {})
        });
        const proof = await attestPresentation(receiptRequest);
        if (!record(proof) || proof.verified !== true
          || typeof proof.presentationId !== 'string' || !ID.test(proof.presentationId)
          || FIELDS.some(k=>proof[k] !== caller[k])
          || ['bindingId','deliveryId','correlationId','attemptId','resultHash',
             ...(worker ? ['workerId','workerKeyId','workerGrantRevision'] : [])]
            .some(k=>proof[k] !== receiptRequest[k]))
          fail('DELIVERY_AUTH_PRESENTATION_MISMATCH');
        // A user can switch tabs/accounts while a native receipt is checked.
        // Refuse ACK if either the attested caller or its binding changed.
        const receiptCaller = identity(await observeCaller(), 'DELIVERY_AUTH_CALLER_REQUIRED');
        if (!equalIdentity(caller,receiptCaller)) fail('DELIVERY_AUTH_SESSION_CHANGED');
        const receiptBoundRaw = await resolveBinding(receiptCaller);
        const receiptBound = identity(receiptBoundRaw, 'DELIVERY_AUTH_BINDING_REQUIRED');
        if (!equalIdentity(receiptCaller,receiptBound)
          || receiptBoundRaw.correlationId !== rawBound.correlationId
          || verifiedEpoch(receiptBoundRaw) !== bindingId)
          fail('DELIVERY_AUTH_BINDING_CHANGED');
      if (trustedSessionId(receiptBoundRaw) !== initialSessionId)
        fail('DELIVERY_AUTH_SESSION_CHANGED');
        // A presentation verifier can await native I/O while a user revokes
        // authorization. Require a fresh positive grant after that wait.
        if (await authorizeDelivery(operation) !== true) fail('DELIVERY_AUTH_GRANT_REQUIRED');
        const finalCaller = identity(await observeCaller(), 'DELIVERY_AUTH_CALLER_REQUIRED');
        if (!equalIdentity(caller,finalCaller)) fail('DELIVERY_AUTH_SESSION_CHANGED');
        const finalBoundRaw = await resolveBinding(finalCaller);
        const finalBound = identity(finalBoundRaw, 'DELIVERY_AUTH_BINDING_REQUIRED');
        if (!equalIdentity(finalCaller,finalBound)
          || finalBoundRaw.correlationId !== rawBound.correlationId
          || verifiedEpoch(finalBoundRaw) !== bindingId)
          fail('DELIVERY_AUTH_BINDING_CHANGED');
      if (trustedSessionId(finalBoundRaw) !== initialSessionId)
        fail('DELIVERY_AUTH_SESSION_CHANGED');
        // A separate native session/binding round can outlast the prior
        // authorization result; require a new positive owner grant before ACK.
        if (await authorizeDelivery(operation) !== true)
          fail('DELIVERY_AUTH_GRANT_REQUIRED');
        await recheckCurrentBinding();
        return store.ack(scopedArgs);
      }
      if (name === 'delivery_read_artifact') {
        checkItem(store.get(scopedArgs.deliveryId,scopedArgs.correlationId));
        return store.readArtifact(scopedArgs);
      }
      fail('DELIVERY_AUTH_OPERATION_NOT_ALLOWED');
    }
  });
}
