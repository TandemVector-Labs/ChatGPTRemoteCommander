// Private Secure MCP Tunnel -> owner MCP HTTPS boundary. The local
// tunnel-client must supply its own operator-pinned mTLS client certificate.
// OpenAI's direct connector client CA is NOT trusted on this separate hop.
// No listener or credential is created on import.
import https from 'node:https';
import tls from 'node:tls';
import {X509Certificate} from 'node:crypto';
import {createV2CandidateHttpIngress} from './v2-mcp-http-ingress.mjs';
import {createV2PrivateTunnelMtlsAttestor,createV2OwnerPinnedPrivatePairAttestor} from './v2-private-tunnel-mtls-attestor.mjs';
import {createV2PrivatePairMcpIngress} from './v2-private-pair-mcp-http-ingress.mjs';
import {isProxy} from 'node:util/types';

const SHA=/^[a-f0-9]{64}$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};
function exactPrivateOwnerPair(value){
  const fields=['expectedTunnelIdHash','expectedOwnerSidHash',
    'resolveCurrentOwnerSidHash','ownerStack','operationGate'];
  const optional=['resolveTrustedConversation','trustedToolCatalog',
    'validateToolInput','resolveTrustedToolRoute'];
  if(!value||typeof value!=='object'||Array.isArray(value)||isProxy(value)
    ||![Object.prototype,null].includes(Object.getPrototypeOf(value)))
    fail('V2_TUNNEL_PRIVATE_PAIR_BOOTSTRAP_REQUIRED');
  const keys=Reflect.ownKeys(value);
  if(keys.some(k=>typeof k!=='string'||![...fields,...optional].includes(k))
    ||fields.some(k=>!keys.includes(k)))
    fail('V2_TUNNEL_PRIVATE_PAIR_BOOTSTRAP_REQUIRED');
  const obj=Object.create(null);
  for(const field of keys){
    const d=Object.getOwnPropertyDescriptor(value,field);
    if(!d||!Object.hasOwn(d,'value')||!d.enumerable)
      fail('V2_TUNNEL_PRIVATE_PAIR_BOOTSTRAP_REQUIRED');
    obj[field]=d.value;
  }
  if(![obj.expectedTunnelIdHash,obj.expectedOwnerSidHash].every(x=>
    typeof x==='string'&&SHA.test(x))
    ||typeof obj.resolveCurrentOwnerSidHash!=='function'
    ||typeof (obj.resolveTrustedConversation
      ??obj.ownerStack?.resolveTrustedConversation)!=='function'
    ||typeof obj.ownerStack?.requestOwnerBinding!=='function'
    ||typeof obj.operationGate?.execute!=='function')
    fail('V2_TUNNEL_PRIVATE_PAIR_BOOTSTRAP_REQUIRED');
  // The canonical owner stack can provide the trusted pair-scope resolver
  // directly; external per-conversation resolvers remain opt-in and must be
  // independently authenticated. Neither reads MCP _meta as authority.
  obj.resolveTrustedConversation=obj.resolveTrustedConversation
    ??obj.ownerStack.resolveTrustedConversation;
  return Object.freeze(obj);
}
function certificate(pem,code){
  if(typeof pem!=='string'||pem.length>32768
    ||!pem.includes('BEGIN CERTIFICATE'))fail(code);
  try{return new X509Certificate(pem);}catch{fail(code);}
}
function key(pem){
  if(typeof pem!=='string'||pem.length>32768
    ||!pem.includes('PRIVATE KEY'))fail('V2_TUNNEL_TLS_SERVER_KEY_REQUIRED');
}

export function createV2CandidatePrivateTunnelHttpsGateway({
  resource,authorizationServers,scopes=['commander.workflow'],
  certificatePem,privateKeyPem,clientCaPem,expectedClientLeafDerSha256,
  profileId,resolveTransportIdentity,dispatcherFactory,
  platformSessionProofAuthority,privateOwnerPair=null,now=Date.now,maxBodyBytes=65536
}={}){
  const privatePair=privateOwnerPair===null?null:exactPrivateOwnerPair(privateOwnerPair);
  if(privatePair&&(dispatcherFactory!==undefined||platformSessionProofAuthority!==undefined))
    fail('V2_TUNNEL_PRIVATE_PAIR_MODE_CONFLICT');
  if(typeof now!=='function'||(!privatePair&&typeof dispatcherFactory!=='function')
    ||typeof resolveTransportIdentity!=='function'
    ||typeof expectedClientLeafDerSha256!=='string'
    ||!SHA.test(expectedClientLeafDerSha256))
    fail('V2_TUNNEL_HTTPS_TRUSTED_BOOTSTRAP_REQUIRED');
  const current=now();
  if(!Number.isSafeInteger(current))
    fail('V2_TUNNEL_HTTPS_CLOCK_INVALID');
  const serverCert=certificate(certificatePem,'V2_TUNNEL_TLS_SERVER_IDENTITY_REQUIRED');
  const ca=certificate(clientCaPem,'V2_TUNNEL_TLS_CLIENT_CA_REQUIRED');
  key(privateKeyPem);
  if(ca.ca!==true||!ca.checkIssued(ca)||!ca.verify(ca.publicKey)
    ||Date.parse(ca.validFrom)>current||Date.parse(ca.validTo)<=current)
    fail('V2_TUNNEL_TLS_CLIENT_CA_UNTRUSTED');
  if(Date.parse(serverCert.validFrom)>current
    ||Date.parse(serverCert.validTo)<=current)
    fail('V2_TUNNEL_TLS_SERVER_IDENTITY_EXPIRED');
  try{tls.createSecureContext({
    cert:certificatePem,key:privateKeyPem,ca:clientCaPem,
    minVersion:'TLSv1.3'
  });}catch{fail('V2_TUNNEL_TLS_SERVER_KEY_MISMATCH');}
  const attestTransport=privatePair
    ?createV2OwnerPinnedPrivatePairAttestor({
      expectedClientLeafDerSha256,profileId,resolveTransportIdentity,now,
      expectedTunnelIdHash:privatePair.expectedTunnelIdHash,
      expectedOwnerSidHash:privatePair.expectedOwnerSidHash,
      resolveCurrentOwnerSidHash:privatePair.resolveCurrentOwnerSidHash
    })
    :createV2PrivateTunnelMtlsAttestor({
      expectedClientLeafDerSha256,profileId,resolveTransportIdentity,now
    });
  const ingress=privatePair?createV2PrivatePairMcpIngress({
    attestTransport,
    resolveTrustedConversation:privatePair.resolveTrustedConversation,
    ownerStack:privatePair.ownerStack,operationGate:privatePair.operationGate,
    trustedToolCatalog:privatePair.trustedToolCatalog??[],
    validateToolInput:privatePair.validateToolInput,
    resolveTrustedToolRoute:privatePair.resolveTrustedToolRoute,maxBodyBytes
  }):createV2CandidateHttpIngress({
    resource,authorizationServers,scopes,attestTransport,
    dispatcherFactory,platformSessionProofAuthority,maxBodyBytes
  });
  const tlsOptions=Object.freeze({
    cert:certificatePem,key:privateKeyPem,ca:clientCaPem,
    requestCert:true,rejectUnauthorized:true,
    minVersion:'TLSv1.3',honorCipherOrder:true
  });
  return Object.freeze({
    requiredTransport:privatePair?'owner-pinned-private-tunnel-mtls':'private-tunnel-client-mtls',
    protectedResource:privatePair?null:ingress.protectedResource,
    createUnboundTlsServer:()=>https.createServer(tlsOptions,ingress.handle)
  });
}
