// RC012 exact one-Tunnel, one-Plugin profile transition planner.
// No write, network call, privilege elevation, OAuth, cert export or daemon.
// The owner remains responsible for the atomically staged cutover/rollback.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseMainTunnelBinding} from '../packaging/unified/migration-preflight.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const sha=value=>createHash('sha256').update(value).digest('hex');
const ownerCertFile=p=>{
  if(typeof p!=='string'||p.length<4||p.length>2048
    ||!path.isAbsolute(p)||/[\r\n\u0000]/.test(p)
    ||p.split(/[\\/]/).includes('..'))fail('RC012_TUNNEL_CERT_PATH_INVALID');
  return JSON.stringify(p);
};
/**
 * Build a candidate YAML entirely in memory from an owner-controlled old
 * main-channel profile. Only the main URL and additive mTLS keys change.
 * Never print returned candidateYaml (may include key references).
 */
export function planOwnerPrivateTunnelCutover({
  currentYaml,protectedPort,clientCertPath,clientKeyPath,clientCaPath
}={}){
  if(typeof currentYaml!=='string'||Buffer.byteLength(currentYaml,'utf8')>16384
    ||currentYaml.includes('\0')||!Number.isSafeInteger(protectedPort)
    ||protectedPort<1024||protectedPort>65535)
    fail('RC012_OWNER_TUNNEL_PLAN_INPUT_INVALID');
  const old=parseMainTunnelBinding(currentYaml);
  if(!old||old.tls||old.port===protectedPort)
    fail('RC012_OWNER_TUNNEL_SINGLE_PLAINTEXT_MAIN_REQUIRED');
  const cert=ownerCertFile(clientCertPath),key=ownerCertFile(clientKeyPath);
  const ca=ownerCertFile(clientCaPath);
  const lines=currentYaml.split(/\r?\n/);
  if(lines.some(line=>/^ca_bundle\s*:/.test(line)))
    fail('RC012_OWNER_TUNNEL_EXISTING_CA_CONFLICT');
  const starts=lines.map((v,i)=>/^mcp:\s*(?:#.*)?$/.test(v)?i:-1).filter(i=>i>=0);
  if(starts.length!==1)fail('RC012_OWNER_TUNNEL_MCP_BLOCK_INVALID');
  const start=starts[0];
  const next=lines.findIndex((v,i)=>i>start&&/^[a-zA-Z][\w.-]*:/.test(v));
  const end=next===-1?lines.length:next;
  if(lines.slice(start+1,end).some(v=>/^ {2}(?:client_cert|client_key)\s*:/.test(v)))
    fail('RC012_OWNER_TUNNEL_ALREADY_HAS_TLS_IDENTITY');
  const candidates=[];
  let foundMain=false,foundUrls=false;
  for(let i=start+1;i<end;i++){
    const line=lines[i];
    if(/^ {2}server_urls:\s*(?:#.*)?$/.test(line)){
      foundUrls=true;foundMain=false;continue;
    }
    if(/^ {2}[A-Za-z][\w.-]*:/.test(line)){
      foundUrls=false;foundMain=false;continue;
    }
    if(!foundUrls)continue;
    const channel=/^ {4}- channel:\s*([A-Za-z0-9._-]+)\s*$/.exec(line);
    if(channel){foundMain=channel[1]==='main';continue;}
    if(!foundMain)continue;
    const url=/^( {6}url: )(?:'([^']+)'|"([^"]+)"|([^\s#]+))\s*$/.exec(line);
    if(url){
      const value=url[2]??url[3]??url[4];
      if(value!=='http://127.0.0.1:'+old.port+'/mcp')
        fail('RC012_OWNER_TUNNEL_MAIN_URL_DRIFT');
      candidates.push(i);
    }
  }
  if(candidates.length!==1)fail('RC012_OWNER_TUNNEL_MAIN_URL_AMBIGUOUS');
  lines[candidates[0]]='      url: https://127.0.0.1:'+protectedPort+'/mcp';
  lines.splice(start+1,0,
    '  client_cert: '+cert,
    '  client_key: '+key
  );
  const last=lines.at(-1)===''?lines.length-1:lines.length;
  lines.splice(last,0,'ca_bundle: '+ca);
  const candidateYaml=lines.join('\n');
  const target=parseMainTunnelBinding(candidateYaml);
  if(!target||target.tls!==true||target.port!==protectedPort
    ||!candidateYaml.includes('  client_cert: '+cert)
    ||!candidateYaml.includes('  client_key: '+key))
    fail('RC012_OWNER_TUNNEL_CANDIDATE_INVALID');
  // Never leak unchanged owner API key / Tunnel ID. The only change is a
  // terminal TLS target and three additive, local, owner-private file refs.
  return Object.freeze({
    schema:1,mode:'OFFLINE_PLAN_NO_CUTOVER',
    sourceSha256:sha(currentYaml),candidateSha256:sha(candidateYaml),
    sourcePort:old.port,protectedPort,
    originalTunnelControlPlanePreserved:true,
    originalApiKeyReferencePreserved:true,
    ownerNativeConsentRequired:true,rollbackRequired:true,
    activeTunnelChanged:false,
    candidateYaml
  });
}
