// V1-01/V0.12 standalone cryptographic J01 regression based on the reviewed V1-03 QA suite.
// This excludes only the separate V1-03 GUI-provider mock; NO enrolled credential or OS approval is claimed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash,randomBytes,sign} from 'node:crypto';
import {j01WebAuthnChallenge,createJ01WebAuthnVerifier} from '../src/gui-j01-webauthn-verifier.mjs';

const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}); // TEST EPHEMERAL
const other=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const credentialId=randomBytes(32).toString('base64url'); // NOT AN ENROLLED DEVICE
const rpId='commander.qa.example.test',origin='https://commander.qa.example.test';
const signerPrincipal='qa-webauthn-signer';
const keyId='TEST-ONLY-P256-NOT-ENROLLED';
const nonce='12345678-1234-4abc-8abc-123456789abc';
const session={ownerPrincipal:'TEST_OWNER',sessionId:'2',seatId:'seat',displayId:'display',interactive:true,ownerAuthenticated:true};
const context={incidentId:'incident-j01',operationId:'task-93',callerPrincipal:'trusted-mock-host-caller'};
const scope={pointer:true,keyboard:false};
function payload(overrides={}, n=nonce){
 const t=Date.now();
 return {protocol:'Commander-J01-OS-OWNER-GRANT-V1',origin:'OS_PROTECTED_OWNER_SIGNER',
 signerPrincipal,keyId,...context,
 ownerPrincipal:session.ownerPrincipal,sessionId:session.sessionId,
 seatId:session.seatId,displayId:session.displayId,
 consentNonce:n,requestedInput:{...scope},ttlSeconds:15,
 issuedAtMs:t,expiresAtMs:t+14000,ownerInteracted:true,...overrides};
}
function assertion(p, opts={}){
 const auth=Buffer.alloc(37);
 createHash('sha256').update(rpId).digest().copy(auth,0);
 auth[32]=0x05;
 auth.writeUInt32BE(1,33);
 if(opts.flags!==undefined)auth[32]=opts.flags;
 if(opts.counter!==undefined)auth.writeUInt32BE(opts.counter,33);
 if(opts.otherRp)createHash('sha256').update(opts.otherRp).digest().copy(auth,0);
 const c={type:'webauthn.get',challenge:j01WebAuthnChallenge(p),origin,crossOrigin:false};
 if(opts.origin!==undefined)c.origin=opts.origin;
 if(opts.challenge!==undefined)c.challenge=opts.challenge;
 if(opts.crossOrigin!==undefined)c.crossOrigin=opts.crossOrigin;
 if(opts.topOrigin!==undefined)c.topOrigin=opts.topOrigin;
 const client=Buffer.from(JSON.stringify(c),'utf8');
 const signature=sign('sha256',Buffer.concat([auth,createHash('sha256').update(client).digest()]),
   opts.otherSigner?other.privateKey:keys.privateKey);
 return {credentialId:opts.otherId??credentialId,
  authenticatorData:auth.toString('base64url'),
  clientDataJSON:client.toString('base64url'),
  signature:signature.toString('base64url')};
}
function store({archiveOk=true,alreadyConsumed=false,counter=0}={}){
 const nonces=new Set(alreadyConsumed?[nonce]:[]),archived=[];
 let last=counter;
 return {
  nonces,archived,
  async consumeNonce(x) {
    if(nonces.has(x.consentNonce))return {consumed:false,counterAccepted:false};
    if(x.signCount!==0 || last!==0) {
      if(x.signCount<=last)return {consumed:false,counterAccepted:false};
    }
    nonces.add(x.consentNonce);
    last=x.signCount;
    return {consumed:true,counterAccepted:true};
  },
  async archiveExactGrant(x){
    if(!archiveOk)return {archived:false};
    archived.push(x);return {archived:true};
  }
 };
}
function verifier(db=store(), key=keys.publicKey, opts={}){
 return createJ01WebAuthnVerifier({
  enrolledPublicKey:key,enrolledCredentialId:credentialId,rpId,origin,
  signerPrincipal,keyId,consumeNonce:db.consumeNonce.bind(db),
  archiveExactGrant:db.archiveExactGrant.bind(db),...opts});
}
function expected(n=nonce){
 return {...context,session,requestedInput:scope,ttlSeconds:15,consentNonce:n};
}
function signedGrant(p=payload(),options={}){
 return {payload:p,webAuthnAssertion:assertion(p,options)};
}
test('synthetic P256 assertion verifies UP/UV, RP hash, origin, challenge, signer and audit',async()=>{
 const db=store(),verify=verifier(db);
 const p=payload(),result=await verify({signedOwnerGrant:signedGrant(p),expected:expected()});
 assert.equal(result.verified,true);
 assert.equal(result.archiveConfirmed,true);
 assert.equal(result.grantConsumed,true);
 assert.equal(db.archived.length,1);
 assert.equal(db.nonces.size,1);
});
test('independently persisted nonce prohibits replay of same assertion',async()=>{
 const v=verifier(),g=signedGrant();
 assert.equal((await v({signedOwnerGrant:g,expected:expected()})).verified,true);
 assert.equal((await v({signedOwnerGrant:g,expected:expected()})).code,'J01_REPLAY_OR_COUNTER_NOT_RESERVED');
});
test('signCount monotonicity enforces test credential counter',async()=>{
 const p=payload();
 const v=verifier(store({counter:8}));
 const r=await v({signedOwnerGrant:signedGrant(p,{counter:8}),expected:expected()});
 assert.equal(r.code,'J01_REPLAY_OR_COUNTER_NOT_RESERVED');
});
test('zero hardware signCount can be accepted only with fresh atomic nonce',async()=>{
 const p=payload(),v=verifier();
 const g=signedGrant(p,{counter:0});
 assert.equal((await v({signedOwnerGrant:g,expected:expected()})).verified,true);
 assert.equal((await v({signedOwnerGrant:g,expected:expected()})).verified,false);
});
test('archive failure denies positive cryptographic proof',async()=>{
 const v=verifier(store({archiveOk:false})),g=signedGrant();
 const r=await v({signedOwnerGrant:g,expected:expected()});
 assert.equal(r.code,'J01_SIGNED_GRANT_ARCHIVE_UNCONFIRMED');
 assert.equal(r.verified,false);
});
for(const [name,opts,code] of [
 ['UV absent',{flags:0x01},'J01_WEBAUTHN_USER_VERIFICATION_REQUIRED'],
 ['UP absent',{flags:0x04},'J01_WEBAUTHN_USER_VERIFICATION_REQUIRED'],
 ['unsupported authenticator extension',{flags:0x85},'J01_WEBAUTHN_FLAGS_UNSUPPORTED'],
 ['bad RP hash',{otherRp:'attacker.test'},'J01_WEBAUTHN_RPID_MISMATCH'],
 ['wrong origin',{origin:'https://phishing.example.test'},'J01_WEBAUTHN_CHALLENGE_OR_ORIGIN_MISMATCH'],
 ['wrong challenge',{challenge:randomBytes(32).toString('base64url')},'J01_WEBAUTHN_CHALLENGE_OR_ORIGIN_MISMATCH'],
 ['cross origin',{crossOrigin:true},'J01_WEBAUTHN_CHALLENGE_OR_ORIGIN_MISMATCH'],
 ['top origin not allowed',{topOrigin:origin},'J01_WEBAUTHN_CHALLENGE_OR_ORIGIN_MISMATCH'],
 ['unregistered credential',{otherId:randomBytes(32).toString('base64url')},'J01_WEBAUTHN_CREDENTIAL_MISMATCH'],
 ['different signing key',{otherSigner:true},'J01_WEBAUTHN_SIGNATURE_INVALID']
]){
 test('rejects '+name+' even with signed synthetic assertion',async()=>{
  const p=payload(),r=await verifier()({
    signedOwnerGrant:signedGrant(p,opts),expected:expected()
  });
  assert.equal(r.code,code);
 });
}
for(const [name,mutate] of [
 ['wrong operation',p=>{p.operationId='other-operation'}],
 ['wrong incident',p=>{p.incidentId='other-incident'}],
 ['wrong caller',p=>{p.callerPrincipal='forged-other-chat'}],
 ['wrong owner',p=>{p.ownerPrincipal='other-OS-owner'}],
 ['wrong session',p=>{p.sessionId='100'}],
 ['input scope escalated',p=>{p.requestedInput.keyboard=true}],
 ['other nonce',p=>{p.consentNonce='87654321-1234-4abc-8abc-123456789abc'}],
 ['wrong TTL',p=>{p.ttlSeconds=120}]
])test('rejects signed '+name+' by exact task/session binding',async()=>{
 const p=payload();mutate(p);
 const r=await verifier()({signedOwnerGrant:signedGrant(p),expected:expected()});
 assert.equal(r.code,'J01_SIGNED_GRANT_CONTEXT_MISMATCH');
});
test('signature bytes tampering always denied',async()=>{
 const g=signedGrant(),sig=g.webAuthnAssertion.signature;
 g.webAuthnAssertion.signature=(sig.startsWith('A')?'B':'A')+sig.slice(1);
 assert.equal((await verifier()({signedOwnerGrant:g,expected:expected()})).code,
  'J01_WEBAUTHN_SIGNATURE_INVALID');
});
test('grant expiry before verification denied',async()=>{
 const p=payload({issuedAtMs:Date.now()-30000,expiresAtMs:Date.now()-20000});
 assert.equal((await verifier()({signedOwnerGrant:signedGrant(p),expected:expected()})).code,
  'J01_GRANT_EXPIRED_OR_TIME_INVALID');
});
test('private key object cannot be enrolled as trusted public credential',()=>{
 assert.throws(()=>verifier(store(),keys.privateKey),/J01_WEBAUTHN_PROTECTED_ENROLLMENT_REQUIRED/);
});
test('missing owner-enrolled credential cannot produce an accepted verifier',()=>{
 assert.throws(()=>createJ01WebAuthnVerifier({
  enrolledPublicKey:keys.publicKey,enrolledCredentialId:'',rpId,origin,
  signerPrincipal,keyId,consumeNonce:()=>({consumed:true,counterAccepted:true}),
  archiveExactGrant:()=>({archived:true})
 }),/J01_WEBAUTHN_PROTECTED_ENROLLMENT_REQUIRED/);
});
test('untrusted RP origin is refused at initialization',()=>{
 assert.throws(()=>verifier(store(),keys.publicKey,{origin:'https://attacker.test'}),
  /J01_WEBAUTHN_PROTECTED_RP_ORIGIN_REQUIRED/);
});
test('verified WebAuthn UV grant returns unique archived binding epochs across owner regrants',async()=>{
 const db=store(),verify=verifier(db);
 const secondNonce='87654321-1234-4abc-8abc-123456789abc';
 const a=payload({},nonce),b=payload({},secondNonce);
 const ga=signedGrant(a,{counter:1}),gb=signedGrant(b,{counter:2});
 const one=await verify({signedOwnerGrant:ga,expected:expected(nonce)});
 const two=await verify({signedOwnerGrant:gb,expected:expected(secondNonce)});
 assert.equal(one.verified,true);
 assert.equal(two.verified,true);
 assert.match(one.bindingId,/^[a-f0-9]{64}$/);
 assert.match(two.bindingId,/^[a-f0-9]{64}$/);
 assert.equal(one.bindingId,one.grantSha256);
 assert.equal(two.bindingId,two.grantSha256);
 assert.notEqual(one.bindingId,two.bindingId);
 assert.equal(db.archived.length,2);
 const replay=await verify({signedOwnerGrant:ga,expected:expected(nonce)});
 assert.equal(replay.verified,false);
 assert.equal(Object.hasOwn(replay,'bindingId'),false);
 const failed=await verifier(store({archiveOk:false}))({
   signedOwnerGrant:ga,expected:expected(nonce)});
 assert.equal(failed.verified,false);
 assert.equal(Object.hasOwn(failed,'bindingId'),false);
});