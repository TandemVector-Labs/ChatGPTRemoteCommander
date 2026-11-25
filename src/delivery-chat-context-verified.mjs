// V1-06 source-level verifier for a Host-signed, current-chat binding.
// This is NOT an issuer, ChatGPT session reader, browser login adapter or
// authorization grant. The only trusted inputs are native Host callbacks,
// pinned public Ed25519 keys and expected host/profile identifiers.
// Never obtain the signed envelope, keys or binding validity from MCP input.
import {KeyObject, randomBytes, verify} from 'node:crypto';

const DOMAIN = 'commander.delivery.current-chat.v1';
const CLAIMS = Object.freeze([
  'issuer','audience','source','hostId','principalId','profileId',
  'conversationId','correlationId','bindingId','sessionId',
  'issuedAtMs','expiresAtMs','challenge'
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EPOCH = /^[a-f0-9]{32,64}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{32}$/;
const fail = code => { throw Object.assign(new Error(code), {code}); };
const safe = value => typeof value === 'string' && ID.test(value)
  && value !== '.' && value !== '..';
function exact(input, keys, code) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== keys.length) fail(code);
  const clean = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input,key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor,'value'))
      fail(code);
    clean[key] = descriptor.value;
  }
  return Object.freeze(clean);
}
function signatureBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(value))
    fail('DELIVERY_CHAT_CONTEXT_SIGNATURE_INVALID');
  const bytes = Buffer.from(value,'base64url');
  if (bytes.length !== 64 || bytes.toString('base64url') !== value)
    fail('DELIVERY_CHAT_CONTEXT_SIGNATURE_INVALID');
  return bytes;
}
function signedBytes(keyId,claims) {
  return Buffer.from(JSON.stringify([
    DOMAIN,keyId,...CLAIMS.map(key => claims[key])
  ]),'utf8');
}
const IDENTITY_FIELDS = Object.freeze([
  'hostId','principalId','profileId','conversationId'
]);
async function boundedNativeRead(callback, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(callback),
      new Promise((_,reject)=>{
        timer=setTimeout(()=>{
          reject(Object.assign(new Error('DELIVERY_CHAT_CONTEXT_NATIVE_TIMEOUT'),
            {code:'DELIVERY_CHAT_CONTEXT_NATIVE_TIMEOUT'}));
        },timeoutMs);
      })
    ]);
  }finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A challenge is generated for every observation. The native Host issuer
 * signs this one challenge along with the exact chat, session and consent
 * epoch. An old signed envelope cannot be replayed into a fresh observation.
 * isBindingCurrent is a separate trusted native callback; a valid signature
 * from a revoked owner session never grants access. Every delivery operation
 * still requires its own action authorization and presentation verification.
 *
 * On key rotation, replace this adapter with one made from the new pinned key
 * set. The Host must not revoke the old signer before draining in-flight calls.
 */
export function createSignedCurrentChatBindingAdapter({
  issuer,audience,expectedHostId,expectedProfileId,publicKeys,
  fetchSignedContext,isBindingCurrent,now=Date.now,maxAgeMs=15000,
  maxNativeWaitMs=5000
}={}) {
  if (![issuer,audience,expectedHostId,expectedProfileId].every(safe)
    || !(publicKeys instanceof Map) || publicKeys.size < 1 || publicKeys.size > 32
    || typeof fetchSignedContext !== 'function'
    || typeof isBindingCurrent !== 'function'
    || typeof now !== 'function' || !Number.isSafeInteger(maxAgeMs)
    || maxAgeMs < 1000 || maxAgeMs > 30000
    || !Number.isSafeInteger(maxNativeWaitMs)
    || maxNativeWaitMs < 100 || maxNativeWaitMs > 30000)
    fail('DELIVERY_CHAT_CONTEXT_TRUST_REQUIRED');

  const keys = new Map();
  for (const [keyId,key] of publicKeys) {
    if (!safe(keyId) || !(key instanceof KeyObject)
      || key.type !== 'public' || key.asymmetricKeyType !== 'ed25519')
      fail('DELIVERY_CHAT_CONTEXT_TRUST_REQUIRED');
    keys.set(keyId,key);
  }

  const readContext = async () => {
    const challenge = randomBytes(24).toString('base64url');
    const signed = await boundedNativeRead(
      () => fetchSignedContext(Object.freeze({challenge})),maxNativeWaitMs);
    const envelope = exact(signed,['schema','keyId','claims','signature'],
      'DELIVERY_CHAT_CONTEXT_ENVELOPE_INVALID');
    if (envelope.schema !== 1 || !safe(envelope.keyId))
      fail('DELIVERY_CHAT_CONTEXT_ENVELOPE_INVALID');
    const key = keys.get(envelope.keyId);
    if (!key) fail('DELIVERY_CHAT_CONTEXT_KEY_UNTRUSTED');
    const claims = exact(envelope.claims,CLAIMS,
      'DELIVERY_CHAT_CONTEXT_CLAIMS_INVALID');
    if (claims.issuer !== issuer || claims.audience !== audience
      || claims.source !== 'HOST_SIGNED_CURRENT_CHAT_CONTEXT'
      || claims.hostId !== expectedHostId
      || claims.profileId !== expectedProfileId)
      fail('DELIVERY_CHAT_CONTEXT_SCOPE_MISMATCH');
    if (['hostId','principalId','profileId','conversationId',
      'correlationId','sessionId'].some(field => !safe(claims[field]))
      || typeof claims.bindingId !== 'string' || !EPOCH.test(claims.bindingId)
      || typeof claims.challenge !== 'string'
      || !CHALLENGE.test(claims.challenge) || claims.challenge !== challenge)
      fail('DELIVERY_CHAT_CONTEXT_SCOPE_MISMATCH');

    const current = now();
    if (!Number.isSafeInteger(current)
      || !Number.isSafeInteger(claims.issuedAtMs)
      || !Number.isSafeInteger(claims.expiresAtMs)
      || claims.expiresAtMs <= claims.issuedAtMs
      || claims.expiresAtMs - claims.issuedAtMs > 30000
      || claims.issuedAtMs > current
      || claims.issuedAtMs < current - maxAgeMs
      || claims.expiresAtMs <= current)
      fail('DELIVERY_CHAT_CONTEXT_EXPIRED');
    if (!verify(null,signedBytes(envelope.keyId,claims),key,
      signatureBytes(envelope.signature)))
      fail('DELIVERY_CHAT_CONTEXT_SIGNATURE_INVALID');

    const context = Object.freeze(Object.fromEntries([
      ...IDENTITY_FIELDS,'correlationId','bindingId','sessionId'
    ].map(field => [field,claims[field]])));
    if (await boundedNativeRead(() => isBindingCurrent(context),maxNativeWaitMs) !== true)
      fail('DELIVERY_CHAT_CONTEXT_BINDING_REVOKED');
    // The native consent check is asynchronous: a proof can expire while the
    // Host verifies owner permission. Recheck the exact signed lifetime after
    // the last awaited trust boundary, not only before native authorization.
    const afterGrant = now();
    if (!Number.isSafeInteger(afterGrant)
      || claims.issuedAtMs > afterGrant
      || claims.issuedAtMs < afterGrant - maxAgeMs
      || claims.expiresAtMs <= afterGrant)
      fail('DELIVERY_CHAT_CONTEXT_EXPIRED');
    return context;
  };

  return Object.freeze({
    observeCaller: async () => {
      const context = await readContext();
      return Object.freeze(Object.fromEntries(
        [...IDENTITY_FIELDS,'sessionId'].map(field => [field,context[field]])
      ));
    },
    resolveBinding: async caller => {
      const context = await readContext();
      // Never accept an input-derived or cross-chat binding, even with
      // a valid signature for another current owner session.
      if (!caller || typeof caller !== 'object' || Array.isArray(caller)
        || IDENTITY_FIELDS.some(field => caller[field] !== context[field])
        || caller.sessionId !== context.sessionId)
        fail('DELIVERY_CHAT_CONTEXT_CALLER_CHANGED');
      return context;
    }
  });
}
