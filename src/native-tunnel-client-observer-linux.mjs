// Linux-only, read-only owner-tunnel process/health observer for the existing
// native-tunnel-attestor. No credentials, arbitrary commands, listeners,
// grants, profile rewrites or control-plane API calls. Only fixed root-owned
// getconf CLK_TCK, owner-pinned /proc facts and that PID's loopback health
// socket are used to authorize a transport observation.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {assertTrustedLinuxMappedRootExecutable} from './native-linux-host-owner-identity.mjs';

const HASH=/^[a-f0-9]{64}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const INSTANCE=/^[A-Za-z0-9][A-Za-z0-9._:-]{15,254}$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};
function safeTime(x){return Number.isSafeInteger(x)&&x>0;}
const digest=b=>createHash('sha256').update(b).digest('hex');

function startMilliseconds(pid,clockTicks){
  const proc='/proc/'+pid;
  const stat=fs.readFileSync(proc+'/stat','utf8');
  const end=stat.lastIndexOf(') ');
  if(end<=0)fail('NATIVE_TUNNEL_PROC_STAT_INVALID');
  const ticks=Number(stat.slice(end+2).trim().split(/\s+/)[19]);
  const boot=Number(fs.readFileSync('/proc/stat','utf8').match(/^btime (\d+)$/m)?.[1]);
  if(!safeTime(ticks)||!safeTime(boot)||!safeTime(clockTicks))
    fail('NATIVE_TUNNEL_PROC_STAT_INVALID');
  const startedAtMs=boot*1000+Math.round(ticks*1000/clockTicks);
  if(!safeTime(startedAtMs))fail('NATIVE_TUNNEL_PROC_STAT_INVALID');
  return startedAtMs;
}

function ownerPid(pid,uid){
  const status=fs.readFileSync('/proc/'+pid+'/status','utf8');
  const found=status.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m);
  return !!found&&found.slice(1).every(v=>Number(v)===uid);
}

function profileArgs(pid,profileId){
  const bytes=fs.readFileSync('/proc/'+pid+'/cmdline');
  if(bytes.length>32768)fail('NATIVE_TUNNEL_COMMAND_LINE_BOUNDS');
  const args=bytes.toString('utf8').split('\0').filter(Boolean);
  const index=args.indexOf('--profile');
  return args.includes('run')&&index>=0&&args[index+1]===profileId
    &&args.filter(x=>x==='--profile').length===1;
}

function socketBelongsToPid(pid,port){
  const key='0100007F:'+port.toString(16).toUpperCase().padStart(4,'0');
  const tcp=fs.readFileSync('/proc/net/tcp','utf8');
  let inode=null;
  for(const line of tcp.split(/\r?\n/).slice(1)){
    const fields=line.trim().split(/\s+/);
    if(fields[1]===key&&fields[3]==='0A'){
      if(inode!==null)return false;
      inode=fields[9]; // kernel TCP inode (not a request-controlled identifier)
    }
  }
  if(typeof inode!=='string'||!/^\d+$/.test(inode))return false;
  let found=0;
  for(const fd of fs.readdirSync('/proc/'+pid+'/fd')){
    try{if(fs.readlinkSync('/proc/'+pid+'/fd/'+fd)==='socket:['+inode+']')found++;}
    catch{/* unrelated descriptor may be replaced while enumerating */}
  }
  return found===1;
}

/** A hostile loopback HTTP responder must not force unbounded buffering. */
export async function parseBoundedLinuxTunnelHealthJson(response){
  if(response?.status!==200)fail('NATIVE_TUNNEL_OBSERVER_HEALTH_DENIED');
    const sizeHeader=response.headers?.get('content-length');
    if(sizeHeader!==null&&(!/^[0-9]{1,8}$/.test(sizeHeader)
      ||Number(sizeHeader)>65536))
      fail('NATIVE_TUNNEL_OBSERVER_HEALTH_BOUNDS');
    if(typeof response.body?.getReader!=='function')
      fail('NATIVE_TUNNEL_OBSERVER_HEALTH_BOUNDS');
    const reader=response.body.getReader(),chunks=[];
    let total=0;
    try{
      while(true){
        const {done,value}=await reader.read();
        if(done)break;
        if(!(value instanceof Uint8Array))fail('NATIVE_TUNNEL_OBSERVER_HEALTH_BOUNDS');
        total+=value.byteLength;
        if(total>65536){
          await reader.cancel().catch(()=>{});
          fail('NATIVE_TUNNEL_OBSERVER_HEALTH_BOUNDS');
        }
        chunks.push(value);
      }
    }finally{reader.releaseLock();}
    try{return JSON.parse(Buffer.concat(chunks,total).toString('utf8'));}
    catch{fail('NATIVE_TUNNEL_OBSERVER_HEALTH_JSON_INVALID');}


}
/** A successful local control-plane poll is necessary; 200 healthz alone
 * does not prove current control-plane authentication or readiness. */
export function verifyLinuxTunnelHealthPayload({
  runtimeHealth,controlHealth,startedAtMs,nowMs=Date.now()
}={}){
  const r=runtimeHealth, c=controlHealth;
  const lastPollAtMs=Date.parse(c?.details?.last_success);
  const fromHealth=Date.parse(r?.runtime?.started_at);
  const instance=r?.runtime?.instance_id;
  if(r?.ready!==true||r?.live!==true||c?.component!=='control-plane'
    ||c?.status!=='ok'||c?.state!=='polling'||c?.limited!==false
    ||c?.details?.consecutive_failures!==0
    ||!Number.isSafeInteger(lastPollAtMs)||lastPollAtMs>nowMs
    ||nowMs-lastPollAtMs>120000
    ||!Number.isSafeInteger(fromHealth)
    ||Math.abs(fromHealth-startedAtMs)>2000
    ||typeof instance!=='string'||!INSTANCE.test(instance))
    fail('NATIVE_TUNNEL_HEALTH_UNVERIFIED');
  return Object.freeze({clientInstanceId:instance,lastPollAtMs});
}

/**
 * Trusted owner-bootstrap dependency for createNativeTunnelAttestor:
 * explicit binary path/hash and private-profile health port MUST come from
 * owner-enrolled local state, never MCP JSON, remote headers or prompt text.
 * A live OS PID and its TCP listener are cross-bound to the same profile,
 * with executable content rehashed for each observation and both startup
 * timestamp and authenticated polling checked before admitting any request.
 */
export function createLinuxTunnelClientObserver({
  profileId,expectedExecutablePath,expectedExecutableSha256,healthPort,
  resolveOwnerSidHash,now=Date.now,fetchImpl=fetch
}={}){
  if(process.platform!=='linux'||typeof profileId!=='string'||!ID.test(profileId)
    ||!path.isAbsolute(expectedExecutablePath)||expectedExecutablePath.includes('\0')
    ||typeof expectedExecutableSha256!=='string'||!HASH.test(expectedExecutableSha256)
    ||!Number.isInteger(healthPort)||healthPort<1024||healthPort>65535
    ||typeof resolveOwnerSidHash!=='function'
    ||typeof now!=='function'||typeof fetchImpl!=='function')
    fail('NATIVE_TUNNEL_OBSERVER_CONFIG_INVALID');
  const uid=process.getuid();
  const trustedBinary=fs.lstatSync(expectedExecutablePath);
  if(!trustedBinary.isFile()||trustedBinary.isSymbolicLink()
    ||(trustedBinary.uid!==0&&trustedBinary.uid!==uid)
    ||(trustedBinary.mode&0o022)!==0
    ||trustedBinary.size<10000||trustedBinary.size>128*1024*1024
    ||digest(fs.readFileSync(expectedExecutablePath))!==expectedExecutableSha256)
    fail('NATIVE_TUNNEL_OBSERVER_BINARY_UNTRUSTED');
  const getconf='/usr/bin/getconf';
  // In rootless hardened userns, root-owned system files are presented as
  // the kernel overflowuid. Validate its kernel mapping and immutable path.
  try{assertTrustedLinuxMappedRootExecutable(getconf);}
  catch{fail('NATIVE_TUNNEL_OBSERVER_CLOCK_UNVERIFIED');}
  const clockTicks=Number(execFileSync(getconf,['CLK_TCK'],{
    encoding:'utf8',timeout:2500,maxBuffer:32
  }).trim());
  if(!Number.isSafeInteger(clockTicks)||clockTicks<10||clockTicks>100000)
    fail('NATIVE_TUNNEL_OBSERVER_CLOCK_UNVERIFIED');

  async function resolveOwnedTunnelProcess(){
    const ownerSidHash=await resolveOwnerSidHash();
    if(typeof ownerSidHash!=='string'||!HASH.test(ownerSidHash))
      fail('NATIVE_TUNNEL_OBSERVER_OWNER_UNVERIFIED');
    const candidates=[];
    for(const name of fs.readdirSync('/proc').filter(v=>/^[0-9]+$/.test(v))){
      const pid=Number(name);
      if(pid<=1)continue;
      try{
        if(fs.readlinkSync('/proc/'+pid+'/exe')!==expectedExecutablePath
          ||!ownerPid(pid,uid)||!profileArgs(pid,profileId))continue;
        const exe=fs.statSync('/proc/'+pid+'/exe');
        if(!exe.isFile()||exe.size!==trustedBinary.size
          ||digest(fs.readFileSync('/proc/'+pid+'/exe'))!==expectedExecutableSha256)
          fail('NATIVE_TUNNEL_OBSERVER_BINARY_CHANGED');
        candidates.push({pid,startedAtMs:startMilliseconds(pid,clockTicks)});
      }catch(error){
        if(error?.code?.startsWith?.('NATIVE_TUNNEL_OBSERVER_'))throw error;
        // A vanished or inaccessible unrelated PID is not an owner match.
      }
    }
    if(candidates.length!==1)fail('NATIVE_TUNNEL_OBSERVER_PROCESS_AMBIGUOUS');
    return Object.freeze({
      source:'native-process-attestor',pid:candidates[0].pid,
      profileId,profileArgumentVerified:true,matchCount:1,running:true,
      ownerSidHash,executablePath:expectedExecutablePath,
      executableSha256:expectedExecutableSha256,
      startedAtMs:candidates[0].startedAtMs
    });
  }
  async function getJson(endpoint){
    const response=await fetchImpl('http://127.0.0.1:'+healthPort+endpoint,{
      signal:AbortSignal.timeout(2500),redirect:'error'
    });
    return parseBoundedLinuxTunnelHealthJson(response);
  }
  async function getStatus200(endpoint){
    const response=await fetchImpl('http://127.0.0.1:'+healthPort+endpoint,{
      signal:AbortSignal.timeout(2500),redirect:'error'
    });
    if(response.status!==200)fail('NATIVE_TUNNEL_OBSERVER_HEALTH_DENIED');
    await response.body?.cancel?.();
    return 200;
  }
  async function probeTunnelHealth(processRecord){
    if(processRecord?.pid<=1||!Number.isSafeInteger(processRecord?.pid)
      ||processRecord.profileId!==profileId
      ||processRecord.executableSha256!==expectedExecutableSha256
      ||processRecord.executablePath!==expectedExecutablePath)
      fail('NATIVE_TUNNEL_OBSERVER_PROCESS_UNVERIFIED');
    if(!socketBelongsToPid(processRecord.pid,healthPort))
      fail('NATIVE_TUNNEL_OBSERVER_SOCKET_NOT_PINNED');
    const [healthz,readyz,runtime,control]=await Promise.all([
      getStatus200('/healthz'),
      getStatus200('/readyz'),
      getJson('/health?details=true'),
      getJson('/health/control-plane')
    ]);
    // /healthz and /readyz return plain text. Their HTTP 200 responses
    // complement the bound process's JSON control-plane polling evidence.
    if(!socketBelongsToPid(processRecord.pid,healthPort))
      fail('NATIVE_TUNNEL_OBSERVER_SOCKET_CHANGED');
    const valid=verifyLinuxTunnelHealthPayload({
      runtimeHealth:runtime,controlHealth:control,
      startedAtMs:processRecord.startedAtMs,nowMs:now()
    });
    return Object.freeze({
      source:'native-tunnel-health-probe',pid:processRecord.pid,profileId,
      ownerSidHash:processRecord.ownerSidHash,
      executablePath:expectedExecutablePath,
      executableSha256:expectedExecutableSha256,
      startedAtMs:processRecord.startedAtMs,
      clientInstanceId:valid.clientInstanceId,
      authenticated:true,controlPlanePollOk:true,
      healthzStatus:healthz,readyzStatus:readyz,
      lastPollAtMs:valid.lastPollAtMs
    });
  }
  return Object.freeze({resolveOwnedTunnelProcess,probeTunnelHealth});
}
