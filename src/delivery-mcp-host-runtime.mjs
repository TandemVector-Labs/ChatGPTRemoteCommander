// Source-only V1-06 composition boundary for the V1-00 MCP ingress owner.
// Real ingress authentication, host-secret encryption, approved caller binding,
// and production cutover belong to V1-00 / V1-01 / V1-07.
// Do not expose dispatchHostEvent as an untrusted MCP tool.
import {createAuthenticatedDeliveryTools} from './delivery-authenticated.mjs';
import {createSignedDeliveryPresentationAttestor} from './delivery-presentation-verified.mjs';
import {createSignedCurrentChatBindingAdapter} from './delivery-chat-context-verified.mjs';
import {createDeliveryMcpEventProjection,DELIVERY_MCP_EVENT} from './delivery-mcp-events.mjs';
import {createAuthenticatedMcpEventSubscriptions} from './delivery-mcp-subscriptions.mjs';
import {createMcpEventsCallbackVerifier} from './delivery-mcp-callback-verifier.mjs';
import {createVerifiedWebhookHttpsTransport} from './delivery-mcp-verified-https.mjs';
import {createDeliveryWebhookSender} from './delivery-mcp-send.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EPOCH=/^[a-f0-9]{32,64}$/;
const FIELDS=['hostId','principalId','profileId','conversationId'];
function identity(value){
  if(!value||typeof value!=='object'||Array.isArray(value)
    ||FIELDS.some(k=>typeof value[k]!=='string'||!ID.test(value[k])))
    fail('DELIVERY_EVENTS_HOST_IDENTITY_REQUIRED');
  const sessionId=sessionIdOf(value);
  return Object.freeze({
    ...Object.fromEntries(FIELDS.map(k=>[k,value[k]])),
    ...(sessionId===null?{}:{sessionId})
  });
}
function equal(a,b){return FIELDS.every(k=>a[k]===b[k]);}
function sessionIdOf(binding){
  const d=binding&&Object.getOwnPropertyDescriptor(binding,'sessionId');
  if(!d)return null;
  if(!Object.hasOwn(d,'value')||typeof d.value!=='string'||!ID.test(d.value))
    fail('DELIVERY_EVENTS_BINDING_REQUIRED');
  return d.value;
}
export function createProtectedDeliveryMcpEventsRuntime({
  deliveryStore,subscriptionStore,observeCaller,resolveBinding,
  authorizeDelivery,authorizeSubscription,authorizeSend,attestPresentation,
  sealSecret,unsealSecret,verifiedHttpsTransport,now=Date.now
}={}){
  if(!deliveryStore||!subscriptionStore
    ||typeof subscriptionStore.registrationGeneration!=='function'
    ||typeof subscriptionStore.getActive!=='function'
    ||typeof subscriptionStore.upsert!=='function'
    ||typeof subscriptionStore.remove!=='function'
    ||[observeCaller,resolveBinding,authorizeDelivery,authorizeSubscription,
      authorizeSend,attestPresentation,sealSecret,unsealSecret,now]
      .some(x=>typeof x!=='function'))
    fail('DELIVERY_EVENTS_INTEGRATION_UNAVAILABLE');
  const transport=verifiedHttpsTransport??createVerifiedWebhookHttpsTransport();
  if(!transport||typeof transport.postVerifiedHttps!=='function')
    fail('DELIVERY_EVENTS_HTTPS_TRANSPORT_UNAVAILABLE');

  const protectedDelivery=createAuthenticatedDeliveryTools({
    store:deliveryStore,observeCaller,resolveBinding,
    authorizeDelivery,attestPresentation
  });
  const projection=createDeliveryMcpEventProjection({
    authenticatedDelivery:protectedDelivery
  });
  const verifier=createMcpEventsCallbackVerifier({
    postVerifiedHttps:transport.postVerifiedHttps,now
  });
  const subscriptions=createAuthenticatedMcpEventSubscriptions({
    observeCaller,resolveBinding,authorizeSubscription,
    verifyCallback:verifier.verifyCallback,
    sealSecret,secureStore:subscriptionStore,now
  });
  const sender=createDeliveryWebhookSender({
    projection,subscriptions:subscriptionStore,observeCaller,resolveBinding,
    authorizeSend,unsealSecret,postVerifiedHttps:transport.postVerifiedHttps,now
  });
  const list=async(input={})=>{
    // A single-entry catalog has no pagination. Reject unknown client fields,
    // forged identity, inherited values and getters before observing a host.
    // Accept cursor:null for standard first-page discovery compatibility.
    if(!input||typeof input!=='object'||Array.isArray(input)
      ||Object.getPrototypeOf(input)!==Object.prototype
      ||Reflect.ownKeys(input).some(key=>{
        const d=Object.getOwnPropertyDescriptor(input,key);
        return key!=='cursor'||!d.enumerable||!Object.hasOwn(d,'value')||d.value!==null;
      }))fail('DELIVERY_EVENTS_LIST_ARGUMENTS_INVALID');
    const caller=identity(await observeCaller());
    const binding=await resolveBinding(caller);
    if(!binding||!equal(identity(binding),caller)
      ||typeof binding.correlationId!=='string'||!ID.test(binding.correlationId)
      ||typeof binding.bindingId!=='string'||!EPOCH.test(binding.bindingId))
      fail('DELIVERY_EVENTS_BINDING_REQUIRED');
    const initialSessionId=sessionIdOf(binding);
    const claim=Object.freeze({
      action:'list',caller,correlationId:binding.correlationId,bindingId:binding.bindingId,
      eventName:DELIVERY_MCP_EVENT,callbackUrl:null
    });
    if(await authorizeSubscription(claim)!==true)
      fail('DELIVERY_EVENTS_DISCOVERY_DENIED');
    const assertCurrentBinding=async()=>{
      const current=identity(await observeCaller());
      const bound=await resolveBinding(current);
      if(!equal(caller,current)||!bound||!equal(identity(bound),caller)
        ||bound.correlationId!==binding.correlationId
        ||bound.bindingId!==binding.bindingId)
        fail('DELIVERY_EVENTS_DISCOVERY_SESSION_CHANGED');
      if(sessionIdOf(bound)!==initialSessionId)
        fail('DELIVERY_EVENTS_DISCOVERY_SESSION_CHANGED');
    };
    await assertCurrentBinding();
    // Host callbacks may await native I/O and the owner may revoke permission
    // while binding is checked. Never publish the event catalog on a stale grant.
    if(await authorizeSubscription(claim)!==true)
      fail('DELIVERY_EVENTS_DISCOVERY_DENIED');
    // Authorization itself may switch the active chat; verify once more.
    await assertCurrentBinding();
    return projection.list();
  };
  return Object.freeze({
    // Dispatch only these three exact names at a previously authenticated
    // MCP endpoint. Never extend with a client-controlled host dispatch action.
    methods:Object.freeze({
      'events/list':list,
      'events/subscribe':input=>subscriptions.subscribe(input),
      'events/unsubscribe':input=>subscriptions.unsubscribe(input)
    }),
    dispatchHostEvent:input=>sender.send(input),
    protectedDelivery
  });
}


/**
 * Owner-only composition helper. The trust keys and receipt-fetch callback
 * must come from V1-01/V1-00's protected native host configuration, never
 * from MCP/client request arguments. MCP webhook 2xx remains transport-only.
 */
export function createProtectedDeliveryMcpEventsRuntimeWithSignedPresentation({
  presentationIssuer,presentationAudience,presentationPublicKeys,
  fetchSignedPresentationReceipt,assertWorkerIdentityCurrent,...runtimeOptions
}={}){
  if(Object.hasOwn(runtimeOptions,'attestPresentation'))
    fail('DELIVERY_EVENTS_PRESENTATION_CONFIG_AMBIGUOUS');
  if(typeof assertWorkerIdentityCurrent!=='function')
    fail('DELIVERY_PRESENTATION_TRUST_REQUIRED');
  const attestPresentation=createSignedDeliveryPresentationAttestor({
    issuer:presentationIssuer,audience:presentationAudience,
    publicKeys:presentationPublicKeys,
    fetchSignedReceipt:fetchSignedPresentationReceipt,
    assertWorkerIdentityCurrent,
    now:runtimeOptions.now??Date.now
  });
  return createProtectedDeliveryMcpEventsRuntime({
    ...runtimeOptions,attestPresentation
  });
}


/**
 * Trusted Host composition with two independent signed boundaries:
 * a fresh Host-signed current-chat challenge and a signed presentation ACK.
 * This helper never obtains keys or native consent from MCP arguments.
 * The Host must separately provide owner authorization and protected ingress.
 */
export function createProtectedDeliveryMcpEventsRuntimeWithSignedChatIdentity({
  chatContext,...options
}={}) {
  if (Object.hasOwn(options,'observeCaller')
    || Object.hasOwn(options,'resolveBinding'))
    fail('DELIVERY_CHAT_CONTEXT_CONFIG_AMBIGUOUS');
  const identityCallbacks=createSignedCurrentChatBindingAdapter(chatContext);
  return createProtectedDeliveryMcpEventsRuntimeWithSignedPresentation({
    ...options,...identityCallbacks
  });
}

// Safe MCP error boundary for V1-00's public tool dispatcher.
// Wrap every public V1-06 tool callback with callProtectedDeliveryMcpTool().
// Only allowlisted failure classes cross the MCP boundary; raw exception
// messages, stacks, callback URLs, identities, receipts and secrets never do.
const MCP_FAILURES = Object.freeze({
  DELIVERY_AUTH_TRUSTED_INTEGRATION_REQUIRED: ['AUTHENTICATED_HOST_REQUIRED','Authenticated host identity and current-chat binding are unavailable.'],
  DELIVERY_AUTH_CALLER_REQUIRED: ['AUTHENTICATED_HOST_REQUIRED','Authenticated host identity and current-chat binding are unavailable.'],
  DELIVERY_CHAT_CONTEXT_TRUST_REQUIRED: ['AUTHENTICATED_HOST_REQUIRED','Authenticated Host-issued current-chat context is unavailable.'],
  DELIVERY_CHAT_CONTEXT_ENVELOPE_INVALID: ['AUTHENTICATED_HOST_REQUIRED','The Host-issued current-chat proof was invalid.'],
  DELIVERY_CHAT_CONTEXT_CLAIMS_INVALID: ['AUTHENTICATED_HOST_REQUIRED','The Host-issued current-chat proof was invalid.'],
  DELIVERY_CHAT_CONTEXT_KEY_UNTRUSTED: ['AUTHENTICATED_HOST_REQUIRED','The Host current-chat signing key is untrusted.'],
  DELIVERY_CHAT_CONTEXT_SCOPE_MISMATCH: ['CHAT_BINDING_MISMATCH','The Host current-chat context does not match this session.'],
  DELIVERY_CHAT_CONTEXT_SIGNATURE_INVALID: ['AUTHENTICATED_HOST_REQUIRED','The Host current-chat signature could not be verified.'],
  DELIVERY_CHAT_CONTEXT_EXPIRED: ['CHAT_BINDING_CHANGED','The Host current-chat context is stale or expired.'],
  DELIVERY_CHAT_CONTEXT_NATIVE_TIMEOUT: ['AUTHENTICATED_HOST_REQUIRED','The native Host current-chat attestation timed out.'],
  DELIVERY_CHAT_CONTEXT_BINDING_REVOKED: ['OWNER_CONSENT_REQUIRED','The current owner chat grant is no longer active.'],
  DELIVERY_CHAT_CONTEXT_CALLER_CHANGED: ['CHAT_SESSION_CHANGED','The active Host conversation changed during this request.'],
  DELIVERY_AUTH_BINDING_SESSION_INVALID: ['CHAT_SESSION_CHANGED','The authenticated Host session binding was invalid.'],
  DELIVERY_SEND_BINDING_SESSION_INVALID: ['CHAT_SESSION_CHANGED','The authenticated Host session binding was invalid.'],
  DELIVERY_EVENTS_BINDING_SESSION_INVALID: ['CHAT_SESSION_CHANGED','The authenticated Host session binding was invalid.'],
  DELIVERY_CHAT_CONTEXT_CONFIG_AMBIGUOUS: ['INTEGRATION_UNAVAILABLE','The Host current-chat integration is not configured safely.'],
  DELIVERY_EVENTS_HOST_IDENTITY_REQUIRED: ['AUTHENTICATED_HOST_REQUIRED','Authenticated host identity and current-chat binding are unavailable.'],
  DELIVERY_EVENTS_INTEGRATION_UNAVAILABLE: ['INTEGRATION_UNAVAILABLE','The protected delivery host integration is not configured.'],
  DELIVERY_EVENTS_BINDING_REQUIRED: ['CHAT_BINDING_REQUIRED','The current conversation is not bound to an authorized owner session.'],
  DELIVERY_AUTH_BINDING_REQUIRED: ['CHAT_BINDING_REQUIRED','The current conversation is not bound to an authorized owner session.'],
  DELIVERY_AUTH_BINDING_MISMATCH: ['CHAT_BINDING_MISMATCH','The authenticated caller does not match the current conversation binding.'],
  DELIVERY_AUTH_BINDING_CHANGED: ['CHAT_BINDING_CHANGED','The owner-authorized conversation binding changed during this request.'],
  DELIVERY_EVENTS_BINDING_CHANGED: ['CHAT_BINDING_CHANGED','The owner-authorized conversation binding changed during this request.'],
  DELIVERY_SEND_BINDING_CHANGED: ['CHAT_BINDING_CHANGED','The owner-authorized conversation binding changed during this request.'],
  DELIVERY_AUTH_SESSION_CHANGED: ['CHAT_SESSION_CHANGED','The active authenticated account or conversation changed during this request.'],
  DELIVERY_EVENTS_DISCOVERY_SESSION_CHANGED: ['CHAT_SESSION_CHANGED','The active authenticated account or conversation changed during this request.'],
  DELIVERY_EVENTS_SESSION_CHANGED: ['CHAT_SESSION_CHANGED','The active authenticated account or conversation changed during this request.'],
  DELIVERY_SEND_SESSION_CHANGED: ['CHAT_SESSION_CHANGED','The active authenticated account or conversation changed during this request.'],
  DELIVERY_AUTH_ARGUMENTS_INVALID: ['REQUEST_INVALID','The protected delivery request is invalid.'],
  DELIVERY_AUTH_BINDING_EPOCH_REQUIRED: ['CONSENT_EPOCH_REQUIRED','A current owner-consent epoch is required for this conversation.'],
  DELIVERY_AUTH_CORRELATION_MISMATCH: ['CHAT_BINDING_MISMATCH','The authenticated caller does not match the current conversation binding.'],
  DELIVERY_AUTH_OPERATION_NOT_ALLOWED: ['OPERATION_NOT_ALLOWED','This protected delivery operation is not permitted.'],
  DELIVERY_AUTH_RESULT_EPOCH_MISMATCH: ['CONSENT_EPOCH_MISMATCH','This result belongs to a different owner-consent epoch.'],
  DELIVERY_AUTH_UNTRUSTED_IDENTITY: ['AUTHENTICATED_HOST_REQUIRED','Authenticated host identity and current-chat binding are unavailable.'],
  DELIVERY_EVENTS_CALLER_UNVERIFIED: ['AUTHENTICATED_HOST_REQUIRED','Authenticated host identity and current-chat binding are unavailable.'],
  DELIVERY_EVENTS_CALLBACK_INVALID: ['CALLBACK_CONFIG_INVALID','The event callback configuration is invalid.'],
  DELIVERY_EVENTS_SECRET_INVALID: ['CALLBACK_CONFIG_INVALID','The event callback configuration is invalid.'],
  DELIVERY_EVENTS_SECRET_NOT_SEALED: ['CALLBACK_CONFIG_INVALID','The event callback secret is not protected by the local secret store.'],
  DELIVERY_EVENTS_CURSOR_UNSUPPORTED: ['REQUEST_INVALID','The protected delivery request is invalid.'],
  DELIVERY_EVENTS_FILTER_INVALID: ['REQUEST_INVALID','The protected delivery request is invalid.'],
  DELIVERY_EVENTS_LIST_ARGUMENTS_INVALID: ['REQUEST_INVALID','The protected delivery request is invalid.'],
  DELIVERY_EVENTS_MODE_INVALID: ['SUBSCRIPTION_INVALID','The event subscription is invalid.'],
  DELIVERY_EVENTS_NAME_INVALID: ['SUBSCRIPTION_INVALID','The event subscription is invalid.'],
  DELIVERY_EVENTS_TTL_INVALID: ['SUBSCRIPTION_INVALID','The event subscription is invalid.'],
  DELIVERY_EVENTS_REGISTRATION_FENCE_INVALID: ['SUBSCRIPTION_CHANGED','The event subscription changed during delivery.'],
  DELIVERY_EVENTS_CLOCK_INVALID: ['REQUEST_INVALID','The protected delivery request is invalid.'],
  DELIVERY_SEND_EVENT_INVALID: ['REQUEST_INVALID','The protected delivery request is invalid.'],
  DELIVERY_SEND_ID_INVALID: ['REQUEST_INVALID','The protected delivery request is invalid.'],
  DELIVERY_SEND_RESPONSE_INVALID: ['CALLBACK_RESPONSE_INVALID','The event callback response could not be validated.'],
  DELIVERY_SEND_TRUSTED_HOST_REQUIRED: ['AUTHENTICATED_HOST_REQUIRED','Authenticated host identity and current-chat binding are unavailable.'],
  DELIVERY_ORIGIN_EVENT_INVALID: ['REQUEST_INVALID','The protected delivery request is invalid.'],
  DELIVERY_ORIGIN_EXPECTED_CONTEXT_REQUIRED: ['ORIGINAL_HOST_RECEIPT_REQUIRED','The original execution host could not attest this result.'],
  DELIVERY_PRESENTATION_ENVELOPE_INVALID: ['PRESENTATION_PROOF_INVALID','The host presentation receipt could not be verified for this delivery.'],
  DELIVERY_PRESENTATION_REQUEST_INVALID: ['REQUEST_INVALID','The protected delivery request is invalid.'],
  DELIVERY_EGRESS_AUTHORIZATION_CALLBACK_INVALID: ['CALLBACK_EGRESS_DENIED','The callback endpoint did not satisfy the approved HTTPS egress policy.'],
  DELIVERY_EGRESS_BODY_INVALID: ['REQUEST_INVALID','The protected delivery request is invalid.'],
  DELIVERY_EGRESS_HEADERS_INVALID: ['CALLBACK_EGRESS_DENIED','The callback endpoint did not satisfy the approved HTTPS egress policy.'],
  DELIVERY_EGRESS_HOST_REQUIRED: ['CALLBACK_EGRESS_DENIED','The callback endpoint did not satisfy the approved HTTPS egress policy.'],
  DELIVERY_EGRESS_POLICY_INVALID: ['CALLBACK_EGRESS_DENIED','The callback endpoint did not satisfy the approved HTTPS egress policy.'],
  DELIVERY_CALLBACK_INPUT_INVALID: ['REQUEST_INVALID','The protected delivery request is invalid.'],
  DELIVERY_CALLBACK_RANDOM_ID_INVALID: ['REQUEST_INVALID','The protected delivery request is invalid.'],
  DELIVERY_CALLBACK_SECRET_INVALID: ['CALLBACK_CONFIG_INVALID','The event callback configuration is invalid.'],
  DELIVERY_CALLBACK_TRUSTED_HOST_REQUIRED: ['AUTHENTICATED_HOST_REQUIRED','Authenticated host identity and current-chat binding are unavailable.'],
  DELIVERY_WEBHOOK_CLOCK_INVALID: ['REQUEST_INVALID','The protected delivery request is invalid.'],
  DELIVERY_WEBHOOK_PAYLOAD_INVALID: ['REQUEST_INVALID','The protected delivery request is invalid.'],
  DELIVERY_WEBHOOK_PAYLOAD_TOO_LARGE: ['REQUEST_INVALID','The protected delivery request exceeds the allowed size.'],
  DELIVERY_WEBHOOK_SECRET_INVALID: ['CALLBACK_CONFIG_INVALID','The event callback configuration is invalid.'],
  DELIVERY_WEBHOOK_SUBSCRIPTION_INVALID: ['SUBSCRIPTION_INVALID','The event subscription is invalid or no longer active.'],
  DELIVERY_AUTH_GRANT_REQUIRED: ['OWNER_CONSENT_REQUIRED','A current owner grant is required for this conversation.'],
  DELIVERY_EVENTS_DISCOVERY_DENIED: ['OWNER_CONSENT_REQUIRED','A current owner grant is required for this conversation.'],
  DELIVERY_EVENTS_SUBSCRIPTION_DENIED: ['OWNER_CONSENT_REQUIRED','A current owner grant is required for this conversation.'],
  DELIVERY_SEND_GRANT_REQUIRED: ['OWNER_CONSENT_REQUIRED','A current owner grant is required for this conversation.'],
  DELIVERY_AUTH_PRESENTATION_REQUIRED: ['PRESENTATION_PROOF_REQUIRED','An independently verified host presentation receipt is required before ACK.'],
  DELIVERY_PRESENTATION_TRUST_REQUIRED: ['PRESENTATION_PROOF_REQUIRED','An independently verified host presentation receipt is required before ACK.'],
  DELIVERY_AUTH_PRESENTATION_MISMATCH: ['PRESENTATION_PROOF_INVALID','The host presentation receipt does not match this delivery attempt.'],
  DELIVERY_PRESENTATION_SIGNATURE_INVALID: ['PRESENTATION_PROOF_INVALID','The host presentation receipt could not be verified for this delivery.'],
  DELIVERY_PRESENTATION_SCOPE_MISMATCH: ['PRESENTATION_PROOF_INVALID','The host presentation receipt does not match this delivery attempt.'],
  DELIVERY_PRESENTATION_EXPIRED: ['PRESENTATION_PROOF_EXPIRED','The host presentation receipt is expired or outside the allowed time window.'],
  DELIVERY_PRESENTATION_KEY_UNTRUSTED: ['PRESENTATION_KEY_UNTRUSTED','The host presentation signing key is not trusted.'],
  DELIVERY_PRESENTATION_ISSUER_MISMATCH: ['PRESENTATION_ISSUER_MISMATCH','The host presentation issuer or audience did not match.'],
  DELIVERY_PRESENTATION_WORKER_NOT_CURRENT: ['WORKER_IDENTITY_NOT_CURRENT','The originating worker is no longer active for this delivery.'],
  DELIVERY_ORIGIN_TRUSTED_HOST_REQUIRED: ['ORIGINAL_HOST_RECEIPT_REQUIRED','The original execution host could not attest this result.'],
  DELIVERY_ORIGIN_RECEIPT_INVALID: ['ORIGINAL_HOST_RECEIPT_INVALID','The original execution receipt is invalid.'],
  DELIVERY_ORIGIN_RECEIPT_MISMATCH: ['ORIGINAL_HOST_RECEIPT_MISMATCH','The original execution receipt did not match this result.'],
  DELIVERY_ORIGIN_OPERATION_MISMATCH: ['ORIGINAL_OPERATION_MISMATCH','The result did not match the originally admitted operation.'],
  DELIVERY_CALLBACK_NOT_REACHABLE: ['CALLBACK_UNREACHABLE','The event callback endpoint could not be verified.'],
  DELIVERY_CALLBACK_UNVERIFIED: ['CALLBACK_VERIFICATION_FAILED','The event callback did not prove possession of its verification challenge.'],
  DELIVERY_EVENTS_CALLBACK_UNVERIFIED: ['CALLBACK_VERIFICATION_FAILED','The event callback did not prove possession of its verification challenge.'],
  DELIVERY_EGRESS_DNS_UNSAFE: ['CALLBACK_EGRESS_DENIED','The callback endpoint did not satisfy the approved HTTPS egress policy.'],
  DELIVERY_EGRESS_URL_INVALID: ['CALLBACK_EGRESS_DENIED','The callback endpoint did not satisfy the approved HTTPS egress policy.'],
  DELIVERY_EGRESS_AUTHORIZATION_DENIED: ['CALLBACK_EGRESS_DENIED','The callback endpoint did not satisfy the approved HTTPS egress policy.'],
  DELIVERY_EGRESS_TIMEOUT: ['CALLBACK_TIMEOUT','The callback request exceeded its bounded time limit.'],
  DELIVERY_EGRESS_RESPONSE_INTERRUPTED: ['CALLBACK_RESPONSE_INCOMPLETE','The callback response ended before verification completed.'],
  DELIVERY_EGRESS_RESPONSE_TOO_LARGE: ['CALLBACK_RESPONSE_INVALID','The callback response exceeded the allowed size.'],
  DELIVERY_SEND_SUBSCRIPTION_INACTIVE: ['SUBSCRIPTION_INACTIVE','The event subscription is no longer active.'],
  DELIVERY_SEND_SUBSCRIPTION_CHANGED: ['SUBSCRIPTION_CHANGED','The event subscription changed during delivery.'],
  DELIVERY_SEND_SUBSCRIPTION_MISMATCH: ['SUBSCRIPTION_MISMATCH','The event subscription does not match the authenticated conversation.'],
  DELIVERY_EVENTS_SUBSCRIPTION_SUPERSEDED: ['SUBSCRIPTION_CHANGED','The event subscription changed during delivery.'],
  DELIVERY_EVENTS_SUBSCRIPTION_INVALID: ['SUBSCRIPTION_INVALID','The event subscription is invalid or no longer active.']
});

const GENERIC_MCP_FAILURE = Object.freeze({
  code: 'DELIVERY_INTEGRATION_FAILED',
  message: 'Protected delivery failed closed; no trusted acknowledgement was asserted.'
});

function ownDataString(value, key) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value')
    && typeof descriptor.value === 'string' ? descriptor.value : null;
}

/**
 * Convert a V1-06 callback exception into a bounded MCP tool error.
 * This deliberately does not return Error.message, stack, URL, identity,
 * delivery identifiers, callback response bodies or secret-bearing fields.
 */
export function toProtectedDeliveryMcpErrorResult(error) {
  const internalCode = ownDataString(error, 'deliveryCode') ?? ownDataString(error, 'code');
  const mapped = internalCode && Object.hasOwn(MCP_FAILURES, internalCode) ? MCP_FAILURES[internalCode] : null;
  const code = mapped?.[0] ?? GENERIC_MCP_FAILURE.code;
  const message = mapped?.[1] ?? GENERIC_MCP_FAILURE.message;
  return Object.freeze({
    isError: true,
    content: Object.freeze([Object.freeze({type:'text',text:message})]),
    structuredContent: Object.freeze({ok:false,code})
  });
}

/**
 * MCP ingress adapter. V1-00 must use this wrapper for every public V1-06
 * tool callback so trusted Host callback failures remain safe and actionable.
 * Successful values are returned unchanged; thrown errors are normalized.
 */
export async function callProtectedDeliveryMcpTool(callback, ...args) {
  try {
    return await callback(...args);
  } catch (error) {
    return toProtectedDeliveryMcpErrorResult(error);
  }
}


/**
 * V1-06's public tools/call handoff for the V1-00 dispatcher.
 * Only these five protected delivery tools may enter the public tool catalog.
 * The internal dispatchHostEvent, subscription methods and runtime rotation
 * are deliberately not exposed as public tools.
 *
 * The caller MUST inject a runtime backed by independently authenticated
 * current-chat identity, revocable consent and signed presentation receipts.
 * This function supplies safe error wrapping, not an identity authority.
 */
const PROTECTED_DELIVERY_PUBLIC_TOOLS = Object.freeze([
  'delivery_list', 'delivery_get', 'delivery_claim', 'delivery_ack',
  'delivery_read_artifact'
]);
export function createProtectedDeliveryMcpToolCallbacks(runtime) {
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)
    || !runtime.protectedDelivery
    || typeof runtime.protectedDelivery.execute !== 'function')
    fail('DELIVERY_EVENTS_INTEGRATION_UNAVAILABLE');
  return Object.freeze(Object.fromEntries(
    PROTECTED_DELIVERY_PUBLIC_TOOLS.map(name => [
      name,
      input => callProtectedDeliveryMcpTool(
        () => runtime.protectedDelivery.execute(name, input ?? {})
      )
    ])
  ));
}
