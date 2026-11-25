// Private G1 runtime seam for an owner-provisioned, separately authenticated
// V2 HTTPS endpoint. Never binds on import, reuses no plaintext legacy /mcp,
// and cannot authorize FULL_ACCESS or a ChatGPT conversation by itself.
// Trusted OAuth, native owner, dispatcher and TLS callbacks are local-only.
import {createWindowsV101V2CandidateHost} from './v101-windows-owner-security-bootstrap.mjs';
import {createLinuxV101V2CandidateHost} from './v101-linux-owner-security-bootstrap.mjs';
import {createV101PrivateTunnelOwnerHost} from './v101-private-tunnel-owner-host.mjs';
import {createV2CandidatePrivateTunnelHttpsGateway} from './v2-private-tunnel-https-gateway.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const LOOPBACK='127.0.0.1';

function createV101G1Runtime({
  port,hostOptions,platform=process.platform
}={}, {resolveHost,protectedTransport}={}){
  if(platform!==process.platform||!['win32','linux'].includes(platform)
    ||!Number.isInteger(port)||port<0||port>65535
    ||!hostOptions||typeof hostOptions!=='object'||Array.isArray(hostOptions))
    fail('V101_G1_LOOPBACK_BOOTSTRAP_REQUIRED');

  if(typeof resolveHost!=='function'
    ||!['direct-openai-mtls','private-tunnel-client-mtls',
      'owner-pinned-private-tunnel-mtls'].includes(protectedTransport))
    fail('V101_G1_TRUSTED_FACTORY_REQUIRED');
  // Owner host composition checks TLS keys, issuer, route callbacks and
  // independent native session grant dependencies before a socket is opened.
  const candidate=resolveHost({...hostOptions,platform},platform);
  let server,phase='CONSTRUCTED',starting=null,closing=null,closeRequested=false;
  try{
    server=candidate.createUnboundTlsServer();
    if(!server||typeof server.listen!=='function'
      ||typeof server.close!=='function'
      ||server.requestCert!==true||server.rejectUnauthorized!==true)
      fail('V101_G1_TLS_REQUIRED');
    server.requestTimeout=10000;
    server.headersTimeout=5000;
    server.keepAliveTimeout=1000;
    server.maxHeadersCount=32;
    server.maxRequestsPerSocket=64;
  }catch(error){
    candidate.close();
    throw error;
  }
  const runtime={
    get status(){
      // A listening TLS socket is NOT a live G1/J01 or release acceptance proof.
      return Object.freeze({
        phase,bindAddress:LOOPBACK,
        port:phase==='LISTENING'?server.address()?.port??null:null,
        tlsClientCertificateRequired:true,
        protectedTransport,
        authenticatedCurrentChatAccepted:false,
        fullAccessActive:false,
        releaseAccepted:false
      });
    },
    async start(){
      if(phase!=='CONSTRUCTED')fail('V101_G1_ALREADY_STARTED_OR_CLOSED');
      phase='STARTING';
      starting=(async()=>{
        try{
          await new Promise((resolve,reject)=>{
            const onError=error=>{server.removeListener('listening',onListen);reject(error);};
            const onListen=()=>{server.removeListener('error',onError);resolve();};
            server.once('error',onError);
            server.once('listening',onListen);
            try{server.listen(port,LOOPBACK);}catch(error){
              server.removeListener('error',onError);
              server.removeListener('listening',onListen);
              reject(error);
            }
          });
          phase='LISTENING';
          if(closeRequested)fail('V101_G1_CLOSED_DURING_START');
          return runtime.status;
        }catch(error){
          if(!server.listening){
            phase='CLOSED';candidate.close();
          }
          throw error;
        }
      })();
      return starting;
    },
    close(){
      if(closing)return closing;
      if(phase==='CLOSED')return Promise.resolve();
      closeRequested=true;
      closing=(async()=>{
        try{
          if(starting)await starting.catch(()=>{});
          if(server.listening){
            await new Promise((resolve,reject)=>
              server.close(error=>error?reject(error):resolve()));
          }
        }finally{
          phase='CLOSED';
          candidate.close();
        }
      })();
      return closing;
    }
  };
  return Object.freeze(runtime);
}

export function createV101G1LoopbackRuntime(options={}){
  return createV101G1Runtime(options,{
    protectedTransport:'direct-openai-mtls',
    resolveHost:(host,platform)=>(platform==='win32'
      ?createWindowsV101V2CandidateHost
      :createLinuxV101V2CandidateHost)(host)
  });
}
export function createV101G1PrivateTunnelRuntime(options={}){
  return createV101G1Runtime(options,{
    protectedTransport:'private-tunnel-client-mtls',
    resolveHost:host=>createV101PrivateTunnelOwnerHost(host)
  });
}
/**
 * Explicitly owner-started, source-only PRIVATE pair candidate.
 * It reuses the existing loopback runtime and exact pinned TLS gateway.
 * Native J01 consent and signed per-action worker grants remain mandatory;
 * a listening socket never flips the current installed Core or Stable Router.
 */
export function createV101G1PrivatePairRuntime(options={}){
  return createV101G1Runtime(options,{
    protectedTransport:'owner-pinned-private-tunnel-mtls',
    resolveHost:host=>{
      if(typeof host.privateOwnerPair?.ownerStack?.close!=='function')
        fail('V101_PRIVATE_PAIR_OWNER_STACK_REQUIRED');
      const gateway=createV2CandidatePrivateTunnelHttpsGateway(host);
      return Object.freeze({
        createUnboundTlsServer:gateway.createUnboundTlsServer,
        close:()=>host.privateOwnerPair.ownerStack.close()
      });
    }
  });
}
