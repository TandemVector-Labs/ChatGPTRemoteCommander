import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify, createPublicKey } from 'node:crypto';
import { createV2JwksTokenVerifier,fetchV2Jwks } from '../src/v2-oauth-jwks.mjs';
import { createV2OAuthObservedCaller } from '../src/v2-oauth-caller.mjs';
import { v2ActionDigest } from '../src/v2-caller-assertion.mjs';

const ISS='https://idp.example.test/',AUD='https://commander.example.test/mcp';
const JWKS='https://idp.example.test/keys.json',NOW=1780000000000;
const pairs={
  EdDSA:generateKeyPairSync('ed25519'),
  RS256:generateKeyPairSync('rsa',{modulusLength:2048}),
  ES256:generateKeyPairSync('ec',{namedCurve:'prime256v1'})
};
const jwk=(alg,kid=alg)=>({...pairs[alg].publicKey.export({format:'jwk'}),kid,alg,use:'sig',key_ops:['verify']});
let loads=0;
let keys={keys:Object.keys(pairs).map(a=>jwk(a))};
const response=(data=keys)=>new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
const get=async(_url,options)=>{loads++;assert.equal(options.redirect,'error');return response();};
const config={issuer:ISS,audience:AUD,jwksUri:JWKS,request:get,now:()=>NOW};
const payload=(changes={})=>({iss:ISS,aud:AUD,sub:'user-1',scope:'commander.workflow read',
    exp:Math.floor(NOW/1000)+60,nbf:Math.floor(NOW/1000)-60,...changes});
function token(alg='EdDSA',p=payload(),key=pairs[alg].privateKey,head={}){
  const header=Buffer.from(JSON.stringify({alg,kid:alg,typ:'at+jwt',...head})).toString('base64url');
  const body=Buffer.from(JSON.stringify(p)).toString('base64url'), data=Buffer.from(header+'.'+body);
  const sig=alg==='EdDSA'?sign(null,data,key):alg==='RS256'?sign('RSA-SHA256',data,key)
     :sign('sha256',data,{key,dsaEncoding:'ieee-p1363'});
  return header+'.'+body+'.'+sig.toString('base64url');
}
test('EdDSA, RS256 and ES256 signature + key-type verification',async()=>{
  const verify=createV2JwksTokenVerifier(config);
  for(const a of Object.keys(pairs)){
    const claims=await verify(token(a));
    assert.equal(claims.subject,'user-1');
    assert.deepEqual(claims.scopes,['commander.workflow','read']);
    assert.equal(claims.audience,AUD);
  }
});
test('Keycloak access-token typ is explicitly pinned and the exact resource audience is normalized',async()=>{
  const defaultVerifier=createV2JwksTokenVerifier(config);
  const jwtTypToken=token('RS256',payload({
    aud:[AUD,'https://tenant.example.test/userinfo']
  }),pairs.RS256.privateKey,{typ:'JWT'});
  await assert.rejects(defaultVerifier(jwtTypToken),{code:'V2_JWT_HEADER_REJECTED'});

  const jwtProfile=createV2JwksTokenVerifier({...config,tokenType:'JWT'});
  const claims=await jwtProfile(jwtTypToken);
  assert.equal(claims.issuer,ISS);
  assert.equal(claims.audience,AUD);

  const wrongAudience=token('RS256',payload({
    aud:['https://other.example.test/api']
  }),pairs.RS256.privateKey,{typ:'JWT'});
  await assert.rejects(jwtProfile(wrongAudience),{
    code:'V2_JWT_ISSUER_OR_AUDIENCE_MISMATCH'
  });
  const duplicateAudience=token('RS256',payload({
    aud:[AUD,AUD]
  }),pairs.RS256.privateKey,{typ:'JWT'});
  await assert.rejects(jwtProfile(duplicateAudience),{
    code:'V2_JWT_ISSUER_OR_AUDIENCE_MISMATCH'
  });
  const wrongTyp=token('RS256',payload(),pairs.RS256.privateKey,{typ:'at+jwt'});
  await assert.rejects(jwtProfile(wrongTyp),{code:'V2_JWT_HEADER_REJECTED'});
  assert.throws(()=>createV2JwksTokenVerifier({...config,tokenType:'dpop+jwt'}),
    {code:'V2_JWKS_CONFIG_REQUIRED'});
});
test('Auth0 upstream bearer is not accepted directly by the Commander Keycloak issuer boundary',async()=>{
  const verify=createV2JwksTokenVerifier(config);
  const upstream=token('EdDSA',payload({
    iss:'https://tenant.eu.auth0.com/'
  }));
  await assert.rejects(verify(upstream),{
    code:'V2_JWT_ISSUER_OR_AUDIENCE_MISMATCH'
  });
});
test('signature corruption and wrong JWKS issuer key reject',async()=>{
  const verify=createV2JwksTokenVerifier(config);
  const t=token();
  const parts=t.split('.');
  const badPayload=Buffer.from(JSON.stringify({...payload(),sub:'other-user'})).toString('base64url');
  await assert.rejects(verify(parts[0]+'.'+badPayload+'.'+parts[2]),{code:'V2_JWT_SIGNATURE_INVALID'});
  const extra=generateKeyPairSync('ed25519');
  const forged=token('EdDSA',payload(),extra.privateKey);
  await assert.rejects(verify(forged),{code:'V2_JWT_SIGNATURE_INVALID'});
});
test('issuer and audience checked independently, no confused deputy',async()=>{
  const verify=createV2JwksTokenVerifier(config);
  for(const p of [payload({iss:'https://another-idp.example.test/'}),
    payload({aud:'https://other.example.test/mcp'})])
    await assert.rejects(verify(token('EdDSA',p)),{code:'V2_JWT_ISSUER_OR_AUDIENCE_MISMATCH'});
});
test('time, scope, typ and algorithm cannot be bypassed',async()=>{
  const verify=createV2JwksTokenVerifier(config);
  await assert.rejects(verify(token('EdDSA',payload({exp:Math.floor(NOW/1000)}))),{code:'V2_JWT_NOT_CURRENT'});
  await assert.rejects(verify(token('EdDSA',payload({nbf:Math.floor(NOW/1000)+1}))),{code:'V2_JWT_NOT_CURRENT'});
  await assert.rejects(verify(token('EdDSA',payload({scope:null}))),{code:'V2_JWT_SCOPES_INVALID'});
  await assert.rejects(verify(token('EdDSA',payload(),pairs.EdDSA.privateKey,{typ:'JWT'})),{code:'V2_JWT_HEADER_REJECTED'});
  await assert.rejects(verify(token('EdDSA',payload(),pairs.EdDSA.privateKey,{alg:'none'})),{code:'V2_JWT_HEADER_REJECTED'});
});
test('duplicate key IDs, private keys and unsupported algorithms rejected',async()=>{
  const duplicate=createV2JwksTokenVerifier({...config,request:async()=>response({keys:[jwk('EdDSA'),jwk('EdDSA')]})});
  await assert.rejects(duplicate(token()),{code:'V2_JWKS_KEY_AMBIGUOUS_OR_MISSING'});
  const bad={...jwk('EdDSA'),d:'secret'};
  const privateKey=createV2JwksTokenVerifier({...config,request:async()=>response({keys:[bad]})});
  await assert.rejects(privateKey(token()),{code:'V2_JWKS_PRIVATE_KEY_REJECTED'});
});
test('JWKS fetched once within cache lifetime and refresh forced for unknown kid',async()=>{
  loads=0;
  const verify=createV2JwksTokenVerifier(config);
  await Promise.all([verify(token()),verify(token())]);
  assert.equal(loads,1);
  const bad=token('EdDSA',payload(),pairs.EdDSA.privateKey,{kid:'key-does-not-exist'});
  await assert.rejects(verify(bad),{code:'V2_JWKS_KEY_AMBIGUOUS_OR_MISSING'});
  assert.equal(loads,2);
});
test('HTTPS, redirect, malformed and oversized JWKS fetch fail closed',async()=>{
  await assert.rejects(fetchV2Jwks('http://127.0.0.1/jwks'),{code:'V2_JWKS_CONFIG_REQUIRED'});
  await assert.rejects(fetchV2Jwks(JWKS,{request:async()=>new Response('[]')}),{code:'V2_JWKS_INVALID'});
  await assert.rejects(fetchV2Jwks(JWKS,{request:async()=>new Response('a'.repeat(70000))}),{code:'V2_JWKS_TOO_LARGE'});
  const redirected=await response();
  Object.defineProperty(redirected,'url',{value:'https://evil.example/keys'});
  await assert.rejects(fetchV2Jwks(JWKS,{request:async()=>redirected}),{code:'V2_JWKS_REDIRECT_NOT_ALLOWED'});
});
test('invalid JWT string, unsigned parts and untrusted key header denied',async()=>{
  const verify=createV2JwksTokenVerifier(config);
  for(const t of ['', 'no.jwt', 'aaaa.bbbb.cccc',token().split('.').slice(0,2).join('.')])
    await assert.rejects(verify(t));
});
test('verified JWKS token drives existing OAuth caller, but does not prove ChatGPT chat source',async()=>{
  const route={hostId:'host',principalId:'user-1',profileId:'alice',conversationId:'chat-a',
    operationId:'write',target:{kind:'workflow-root',id:'flow-a'}};
  const args={path:'a.txt',content:'ok'};
  const internal=generateKeyPairSync('ed25519');
  const fields=['issuer','audience','hostId','principalId','profileId','conversationId','operationId',
    'targetKind','targetId','osSessionId','tool','argumentsHash','issuedAtMs','expiresAtMs','nonce'];
  const c={issuer:'internal-issuer',audience:'internal-audience',hostId:'host',principalId:'user-1',
    profileId:'alice',conversationId:'chat-a',operationId:'write',targetKind:'workflow-root',
    targetId:'flow-a',osSessionId:'owner-session',tool:'write_text',
    argumentsHash:v2ActionDigest('write_text',args),issuedAtMs:NOW-1,expiresAtMs:NOW+10000,nonce:'unique-nonce'};
  const signed=Buffer.from(JSON.stringify([2,'internal',...fields.map(f=>c[f])]));
  const assertion={schema:2,keyId:'internal',claims:c,
    signature:sign(null,signed,internal.privateKey).toString('base64url')};
  const verifyAccessToken=createV2JwksTokenVerifier(config);
  const observed=createV2OAuthObservedCaller({
    route,tool:'write_text',args,assertion,
    assertionTrust:{issuer:'internal-issuer',audience:'internal-audience',publicKeys:new Map([['internal',internal.publicKey]])},
    readAuthorization:async()=> 'Bearer '+token('RS256'),verifyAccessToken,
    resolvePrincipal:async x=>x==='user-1'?'user-1':null,
    observedNativeSession:async()=> 'owner-session',
    now:()=>NOW,issuer:ISS,audience:AUD
  });
  assert.equal((await observed()).conversationId,'chat-a');
});

test('issuer identity is exact and does not add or remove trailing slash',async()=>{
  const plainIssuer='https://idp.example.test';
  const v=createV2JwksTokenVerifier({...config,issuer:plainIssuer});
  const accepted=await v(token('EdDSA',payload({iss:plainIssuer})));
  assert.equal(accepted.issuer,plainIssuer);
  await assert.rejects(v(token('EdDSA',payload({iss:ISS}))),{code:'V2_JWT_ISSUER_OR_AUDIENCE_MISMATCH'});
});


test('untrusted unknown JWT key IDs cannot force unbounded JWKS requests',async()=>{
  let nowMs=NOW,requests=0;
  const verifier=createV2JwksTokenVerifier({
    ...config,now:()=>nowMs,request:async()=>{requests++;return response();}
  });
  assert.equal((await verifier(token())).subject,'user-1');
  assert.equal(requests,1);
  for(let i=0;i<6;i++){
    await assert.rejects(verifier(token('EdDSA',payload(),pairs.EdDSA.privateKey,
      {kid:'unauthorized-'+i})),{code:'V2_JWKS_KEY_AMBIGUOUS_OR_MISSING'});
  }
  assert.equal(requests,2); // One refresh per bounded window, not six network calls
  nowMs+=30001;
  await assert.rejects(verifier(token('EdDSA',payload(),pairs.EdDSA.privateKey,
    {kid:'rotation-test'})),{code:'V2_JWKS_KEY_AMBIGUOUS_OR_MISSING'});
  assert.equal(requests,3); // A fresh key rotation can eventually be discovered
});
test('expired during slow JWKS fetch is refused after cryptographic verification',async()=>{
  let nowMs=NOW;
  const p=payload({exp:Math.floor(NOW/1000)+2});
  const verifier=createV2JwksTokenVerifier({...config,
    now:()=>nowMs,
    request:async()=>{
      nowMs+=3000;
      return response();
    }
  });
  await assert.rejects(verifier(token('EdDSA',p)),{code:'V2_JWT_NOT_CURRENT'});
});
test('JWT headers with critical or embedded key directives are refused',async()=>{
  const verify=createV2JwksTokenVerifier(config);
  for(const head of [
    {crit:['unknown']},{b64:false},{jku:'https://attacker.example/jwks'},
    {jwk:jwk('EdDSA')},{x5u:'https://attacker.example/cert'}
  ]){
    await assert.rejects(verify(token('EdDSA',payload(),pairs.EdDSA.privateKey,head)),
      {code:'V2_JWT_HEADER_REJECTED'});
  }
});
test('scope-less and numeric dates outside JS precise range are refused',async()=>{
  const verify=createV2JwksTokenVerifier(config);
  await assert.rejects(verify(token('EdDSA',payload({scope:'   '}))),
    {code:'V2_JWT_SCOPES_INVALID'});
  await assert.rejects(verify(token('EdDSA',payload({exp:Number.MAX_SAFE_INTEGER}))),
    {code:'V2_JWT_TIME_INVALID'});
});
test('RSA public keys below 2048 bits are rejected even if signature verifies',async()=>{
  // Synthetic signed 1024-bit RSA public test vector. The private key was
  // discarded during fixture generation and is never stored or generated by CI.
  const modulus='xBHnjevBTeQRLRPTQM8JkfQcYOB3x8HW8MOg2Az0TXjh1RvGQ5d-JUOT43FNr4iKAoZHhEohE9VHHw7X8P0MhaUw1VqHsfiPJeFUFHwELRUviGdy44hVt0pETjwbsqEL4Y9RWL0HO8JHjl2FHyvGHN3LZN2kTjAbKFFohMKTlsc';
  const proof='ptWDvQcy436_z9cVQChh7aDeZweXjg6zWaQ1TZQEM9JMpAhEV-adLlrEG4OwKiBH0e7p1LmLtq2NVIEPx5ItjYTRPlB8MWeWhQpGcdFS9cJBY8HICW4cWh0RwYN8tU1yAzufTGyOsJ5lTLr0OD1aPR7SqtYIvE6rNs4r59seHGw';
  const weakPublic={kty:'RSA',n:modulus,e:'AQAB'};
  const weakJwk={...weakPublic,kid:'RS256',alg:'RS256',use:'sig',key_ops:['verify']};
  const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'RS256',typ:'at+jwt'})).toString('base64url');
  const body=Buffer.from(JSON.stringify(payload())).toString('base64url');
  const signedData=header+'.'+body;
  // Establish the negative fixture is genuinely signed under its short key,
  // so the verifier must reject the JWKS modulus rather than a bad signature.
  assert.equal(verify('RSA-SHA256',Buffer.from(signedData),
    createPublicKey({key:weakPublic,format:'jwk'}),Buffer.from(proof,'base64url')),true);
  const verifier=createV2JwksTokenVerifier({...config,
    request:async()=>response({keys:[weakJwk]})});
  await assert.rejects(verifier(signedData+'.'+proof),
    {code:'V2_JWKS_KEY_REJECTED'});
});
