// V2-G1 direct HTTPS option: verifies ChatGPT's OpenAI-managed mTLS client
// certificate at the Node TLS boundary, before resolving any chat namespace.
// A tunnel terminating TLS elsewhere CANNOT use this verifier; its edge must
// supply an independently authenticated, integrity-protected session binding.
// Operator must separately configure HTTPS requestCert:true, rejectUnauthorized:true,
// and trust ONLY the authentic OpenAI Root + Connectors intermediate CA bundle.
// This helper never installs a CA, key, listener, plugin login or OAuth service.
import {createHash} from 'node:crypto';

const EXPECTED_DNS='mtls.prod.connectors.openai.com';
const CLIENT_AUTH_OID='1.3.6.1.5.5.7.3.2';
const SESSION=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function fail(code){throw Object.assign(new Error(code),{code});}
function certificateDnsNames(subjectaltname){
  if(typeof subjectaltname!=='string')return [];
  return subjectaltname.split(/,\s*/).map(x=>x.trim()).filter(Boolean)
    .filter(x=>x.startsWith('DNS:')).map(x=>x.slice(4));
}
/**
 * Secure ONLY for direct TLS, with OpenAI root/intermediate CA configured in
 * the HTTPS listener. The intermediate DER SHA256 is an additional operator
 * pin, never a leaf fingerprint. Only the native owner can bind the platform
 * session ID to a signed action; no request header/body is identity proof.
 */
export function createV2DirectMtlsTransportAttestor({
  intermediateDerSha256,resolveTrustedSession,sessionSource='native-owner',now=Date.now
}){
  if(typeof intermediateDerSha256!=='string'
    ||!/^[a-fA-F0-9]{64}$/.test(intermediateDerSha256)
    ||!['native-owner','openai/session'].includes(sessionSource)
    ||(sessionSource==='native-owner'&&typeof resolveTrustedSession!=='function')
    ||typeof now!=='function')
    fail('V2_MTLS_OPERATOR_CONFIGURATION_REQUIRED');
  const issuerDigest=intermediateDerSha256.toLowerCase();
  return async(request)=>{
    const socket=request?.socket;
    if(!socket||socket.encrypted!==true||socket.authorized!==true
      ||typeof socket.getPeerCertificate!=='function')
      return Object.freeze({authenticated:false});
    let cert;
    try{cert=socket.getPeerCertificate(true);}
    catch{return Object.freeze({authenticated:false});}
    if(!cert||!Buffer.isBuffer(cert.raw)
      ||!Buffer.isBuffer(cert.issuerCertificate?.raw)
      ||cert.raw.equals(cert.issuerCertificate.raw))
      return Object.freeze({authenticated:false});
    const actual= createHash('sha256').update(cert.issuerCertificate.raw).digest('hex');
    if(actual!==issuerDigest)return Object.freeze({authenticated:false});
    // Compare complete DNS SAN entries; substring matches are never trusted.
    if(!certificateDnsNames(cert.subjectaltname).some(name=>name===EXPECTED_DNS))
      return Object.freeze({authenticated:false});
    if(!Array.isArray(cert.ext_key_usage)
      ||!cert.ext_key_usage.includes(CLIENT_AUTH_OID))
      return Object.freeze({authenticated:false});
    const current=now(),start=Date.parse(cert.valid_from),end=Date.parse(cert.valid_to);
    if(!Number.isSafeInteger(current)||!Number.isFinite(start)||!Number.isFinite(end)
      ||current<start||current>=end)return Object.freeze({authenticated:false});
    // OpenAI publishes _meta['openai/session'] on TOOL CALLS. Only after
    // authenticating its actual mTLS client certificate may a dedicated ingress
    // treat this platform-emitted field as a session correlation namespace.
    // The authenticated OAuth principal and per-chat grant are STILL mandatory.
    if(sessionSource==='openai/session')return Object.freeze({
      authenticated:true,peerType:'openai-chatgpt-mtls',
      sessionSource:'openai/session'
    });
    // Alternative native owner resolver for deployments where a trusted
    // platform session binding is already carried outside the HTTP body.
    // It MUST NOT accept x-chat-id or model-supplied route values.
    const trusted=await resolveTrustedSession(Object.freeze({
      peerType:'openai-chatgpt-mtls',
      expectedDns:EXPECTED_DNS,
      validatedIntermediateSha256:issuerDigest
    }),request);
    if(typeof trusted!=='string'||!SESSION.test(trusted))
      return Object.freeze({authenticated:false});
    return Object.freeze({authenticated:true,sessionHandle:trusted});
  };
}
