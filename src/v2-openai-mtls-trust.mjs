// V2 G1: operator-reviewed public OpenAI Connectors mTLS trust anchors.
// Bundled from https://developers.openai.com/plugins/mtls/openai-root-ca.pem
// and https://developers.openai.com/plugins/mtls/openai-connectors-mtls-ca.pem
// 2026-10-29. Only publicly published CA certificates; no private keys.
// A real HTTPS listener must ALSO provide its own server certificate/private
// key, require client certificates, and keep the v2 OAuth and session gates.
import {readFileSync} from 'node:fs';
import {X509Certificate,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT_URL=new URL('../assets/trust/openai/root-ca.pem',import.meta.url);
const INTERMEDIATE_URL=new URL('../assets/trust/openai/connectors-mtls-intermediate-ca.pem',import.meta.url);
const TRUST=Object.freeze({
 rootPemSha256:'3a565b5c83c83ba2de085de28733e3c6af01af9b347322b93caf3a03d42c5cbe',
 intermediatePemSha256:'7485f98dfbb7db119ca99d5748ac7a86baa73ddede878d3263a50cba2c4f6dd8',
 rootDerSha256:'493d9a1edc48d558f5a28764b20605205a50e1df4840231e342f2e0e8cdd5be9',
 intermediateDerSha256:'da3d8e2e32ee4981ea1152c1456f866c863dbde2fbf4f8eba8850df74b656816'
});
function fail(code){throw Object.assign(new Error(code),{code});}
function digest(data){return createHash('sha256').update(data).digest('hex');}
function requireCertificate(buf,sha){
 const bytes=Buffer.isBuffer(buf)?buf:Buffer.from(buf??'');
 if(digest(bytes)!==sha)fail('V2_OPENAI_CA_BUNDLE_UNTRUSTED');
 try{return new X509Certificate(bytes);}catch{fail('V2_OPENAI_CA_BUNDLE_UNTRUSTED');}
}
/** Validate the pinned public certificates before installing trust in Node TLS. */
export function loadV2OpenAiClientCaBundle({
 rootPem=readFileSync(ROOT_URL),
 intermediatePem=readFileSync(INTERMEDIATE_URL),
 now=Date.now()
}={}){
 if(!Number.isSafeInteger(now))fail('V2_OPENAI_CA_CLOCK_INVALID');
 const root=requireCertificate(rootPem,TRUST.rootPemSha256);
 const intermediate=requireCertificate(intermediatePem,TRUST.intermediatePemSha256);
 if(!root.ca||!intermediate.ca
   ||digest(root.raw)!==TRUST.rootDerSha256
   ||digest(intermediate.raw)!==TRUST.intermediateDerSha256
   ||!root.checkIssued(root)||!root.verify(root.publicKey)
   ||!intermediate.checkIssued(root)||!intermediate.verify(root.publicKey)
   ||root.subject===intermediate.subject
   ||new Date(root.validFrom).getTime()>now||new Date(root.validTo).getTime()<=now
   ||new Date(intermediate.validFrom).getTime()>now
   ||new Date(intermediate.validTo).getTime()<=now)
   fail('V2_OPENAI_CA_BUNDLE_UNTRUSTED');
 const ca=Object.freeze([
   Buffer.from(rootPem).toString('utf8'),
   Buffer.from(intermediatePem).toString('utf8')
 ]);
 return Object.freeze({
   ca,intermediateDerSha256:TRUST.intermediateDerSha256,
   expectedClientDns:'mtls.prod.connectors.openai.com',
   sources:Object.freeze([
     'https://developers.openai.com/plugins/mtls/openai-root-ca.pem',
     'https://developers.openai.com/plugins/mtls/openai-connectors-mtls-ca.pem'
   ])
 });
}
/** TLS server options; source of server key/cert must be a protected secret store. */
export function createV2OpenAiClientTlsOptions({certificatePem,privateKeyPem,now=Date.now()}={}){
 if(typeof certificatePem!=='string'
   ||!certificatePem.includes('BEGIN CERTIFICATE')
   ||typeof privateKeyPem!=='string'||!privateKeyPem.includes('PRIVATE KEY'))
   fail('V2_HTTPS_SERVER_IDENTITY_REQUIRED');
 const trust=loadV2OpenAiClientCaBundle({now});
 return Object.freeze({
   cert:certificatePem,key:privateKeyPem,ca:trust.ca,
   requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2',
   honorCipherOrder:true
 });
}
export const V2_OPENAI_CONNECTORS_CA_PIN=TRUST.intermediateDerSha256;
