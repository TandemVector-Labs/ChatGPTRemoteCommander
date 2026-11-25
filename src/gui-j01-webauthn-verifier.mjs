// J01 WebAuthn / Windows Hello assertion verifier — QA candidate, NOT enrollment.
// Trust comes from a separately enrolled protected authenticator credential.
// No private key, key enrollment, fake owner UI, user login or OS input occurs here.
import {createHash,createPublicKey,verify as cryptoVerify,timingSafeEqual} from 'node:crypto';
import {canonicalJ01Grant} from './gui-j01-owner-grant-verifier.mjs';

const RECORD=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const WORD=x=>typeof x==='string'&&x.length>0&&x.length<=256&&!/[\x00-\x1f\x7f]/.test(x);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail=code=>Object.freeze({verified:false,code,grantConsumed:false});
const schema=(o,keys)=>RECORD(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
const b64=/^[A-Za-z0-9_-]+$/;
const sha256=b=>createHash('sha256').update(b).digest();
function decodeB64(value, min,max) {
  if(typeof value!=='string'||value.length<2||value.length>max*2||!b64.test(value))
    return null;
  const raw=Buffer.from(value,'base64url');
  if(raw.length<min||raw.length>max||raw.toString('base64url')!==value)return null;
  return raw;
}
function trustedKey(input){
  if(input?.type==='public')return input;
  if(typeof input==='string'&&input.startsWith('-----BEGIN PUBLIC KEY-----')){
    try{return createPublicKey(input)}catch{return null}
  }
  return null;
}
function buildChallenge(payload) {
  return sha256(canonicalJ01Grant(payload)).toString('base64url');
}
export function createJ01WebAuthnVerifier({
  enrolledPublicKey, enrolledCredentialId, rpId, origin,
  signerPrincipal, keyId, consumeNonce, archiveExactGrant, clock=Date.now
}={}) {
  const key=trustedKey(enrolledPublicKey);
  const credential=decodeB64(enrolledCredentialId,16,1024);
  if(!key||key.type!=='public'||key.asymmetricKeyType!=='ec'||
     key.asymmetricKeyDetails?.namedCurve!=='prime256v1'||
     !credential||!WORD(signerPrincipal)||!WORD(keyId)||
     typeof consumeNonce!=='function'||typeof archiveExactGrant!=='function'||
     typeof clock!=='function')
    throw new TypeError('J01_WEBAUTHN_PROTECTED_ENROLLMENT_REQUIRED');
  if(typeof rpId!=='string'||rpId.length>253||rpId.includes('/')||rpId.includes(':')||
     typeof origin!=='string'||origin.length>500)
    throw new TypeError('J01_WEBAUTHN_PROTECTED_RP_ORIGIN_REQUIRED');
  let url;
  try{url=new URL(origin)}catch{throw new TypeError('J01_WEBAUTHN_PROTECTED_RP_ORIGIN_REQUIRED')}
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||
      url.search||url.hash||!url.hostname.toLowerCase().endsWith(rpId.toLowerCase())||
      (url.hostname.toLowerCase()!==rpId.toLowerCase() &&
       !url.hostname.toLowerCase().endsWith('.'+rpId.toLowerCase())))
    throw new TypeError('J01_WEBAUTHN_PROTECTED_RP_ORIGIN_REQUIRED');
  const rpHash=sha256(Buffer.from(rpId,'utf8'));
  const publicFingerprint=sha256(key.export({format:'der',type:'spki'})).toString('hex');

  return async function verifyJ01WebAuthn({signedOwnerGrant,expected}={}) {
    if(!schema(signedOwnerGrant,['payload','webAuthnAssertion'])||
       !RECORD(expected)||!schema(signedOwnerGrant.webAuthnAssertion,
         ['credentialId','clientDataJSON','authenticatorData','signature']))
      return fail('J01_WEBAUTHN_ASSERTION_REQUIRED');
    const p=signedOwnerGrant.payload;
    let expectedChallenge;
    try {expectedChallenge=buildChallenge(p)}
    catch{return fail('J01_GRANT_SCHEMA_INVALID')}
    if(p.signerPrincipal!==signerPrincipal||p.keyId!==keyId||
       !WORD(expected.incidentId)||!WORD(expected.operationId)||
       !WORD(expected.callerPrincipal)||
       p.incidentId!==expected.incidentId||
       p.operationId!==expected.operationId||
       p.callerPrincipal!==expected.callerPrincipal||
       !RECORD(expected.session)||
       p.ownerPrincipal!==expected.session.ownerPrincipal||
       p.sessionId!==expected.session.sessionId||
       p.seatId!==expected.session.seatId||
       p.displayId!==expected.session.displayId||
       !UUID.test(expected.consentNonce??'')||
       p.consentNonce!==expected.consentNonce||
       !RECORD(expected.requestedInput)||
       p.requestedInput.pointer!==expected.requestedInput.pointer||
       p.requestedInput.keyboard!==expected.requestedInput.keyboard||
       p.ttlSeconds!==expected.ttlSeconds)
      return fail('J01_SIGNED_GRANT_CONTEXT_MISMATCH');
    const now=clock();
    if(!Number.isSafeInteger(now)||p.issuedAtMs>now+3000||
       now-p.issuedAtMs>30000||p.expiresAtMs<=now||
       p.expiresAtMs>p.issuedAtMs+p.ttlSeconds*1000)
      return fail('J01_GRANT_EXPIRED_OR_TIME_INVALID');
    const a=signedOwnerGrant.webAuthnAssertion;
    if(a.credentialId!==enrolledCredentialId)
      return fail('J01_WEBAUTHN_CREDENTIAL_MISMATCH');
    const clientBytes=decodeB64(a.clientDataJSON,10,8192);
    const authBytes=decodeB64(a.authenticatorData,37,8192);
    const sig=decodeB64(a.signature,16,1024);
    if(!clientBytes||!authBytes||!sig)
      return fail('J01_WEBAUTHN_ASSERTION_ENCODING_INVALID');
    // Current narrow acceptance permits bare 37-byte authenticator data with
    // no extensions or attested-data block. More formats need a reviewed parser.
    if(authBytes.length!==37)
      return fail('J01_WEBAUTHN_AUTHDATA_EXTENSION_UNSUPPORTED');
    if(!timingSafeEqual(authBytes.subarray(0,32),rpHash))
      return fail('J01_WEBAUTHN_RPID_MISMATCH');
    const flags=authBytes[32];
    if((flags&0x05)!==0x05)
      return fail('J01_WEBAUTHN_USER_VERIFICATION_REQUIRED');
    if((flags&0x40)!==0||(flags&0x80)!==0||
       ((flags&0x10)!==0&&(flags&0x08)===0))
      return fail('J01_WEBAUTHN_FLAGS_UNSUPPORTED');
    let client;
    try {client=JSON.parse(clientBytes.toString('utf8'))}
    catch {return fail('J01_WEBAUTHN_CLIENT_DATA_INVALID')}
    if(!RECORD(client)||client.type!=='webauthn.get'||
       client.origin!==origin||client.crossOrigin===true||
       Object.hasOwn(client,'topOrigin')||
       client.challenge!==expectedChallenge)
      return fail('J01_WEBAUTHN_CHALLENGE_OR_ORIGIN_MISMATCH');
    const signedBytes=Buffer.concat([authBytes,sha256(clientBytes)]);
    if(!cryptoVerify('sha256',signedBytes,key,sig))
      return fail('J01_WEBAUTHN_SIGNATURE_INVALID');
    const counter=authBytes.readUInt32BE(33);
    const digest=sha256(Buffer.concat([
      canonicalJ01Grant(p),clientBytes,authBytes,sig
    ])).toString('hex');
    let claimed;
    try{
      claimed=await consumeNonce({
        consentNonce:p.consentNonce,operationId:p.operationId,
        incidentId:p.incidentId,credentialId:enrolledCredentialId,
        signCount:counter,grantSha256:digest,
        expiresAtMs:p.expiresAtMs
      });
    }catch{return fail('J01_REPLAY_REGISTRY_UNAVAILABLE')}
    // Sign count and nonce must be atomically checked/committed by the
    // independently protected credential registry; zero counter still needs
    // durable nonce reservation.
    if(claimed?.consumed!==true||claimed?.counterAccepted!==true)
      return fail('J01_REPLAY_OR_COUNTER_NOT_RESERVED');
    try{
      const archived=await archiveExactGrant({
        grant:signedOwnerGrant,grantSha256:digest,
        enrolledPublicKeyFingerprint:publicFingerprint,
        rpId,origin,attestedCaller:expected.callerPrincipal
      });
      if(archived?.archived!==true)
        return fail('J01_SIGNED_GRANT_ARCHIVE_UNCONFIRMED');
    }catch{return fail('J01_SIGNED_GRANT_ARCHIVE_UNCONFIRMED')}
    return Object.freeze({
      verified:true,code:'J01_WEBAUTHN_OWNER_GRANT_VERIFIED',
      consentNonce:p.consentNonce,grantSha256:digest,
      trustedKeyFingerprint:publicFingerprint,
      signerPrincipal,bindingId:digest,grantConsumed:true,archiveConfirmed:true
    });
  };
}
export function j01WebAuthnChallenge(payload) {
  return buildChallenge(payload);
}
