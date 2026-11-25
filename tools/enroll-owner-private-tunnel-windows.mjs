// Native Windows owner enrollment for ONE existing private Tunnel per account.
// Only owner-approved, non-secret identity pins; no Tunnel/API-key change,
// listener, ChatGPT binding, Worker grant, install, elevation or Full Access.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,X509Certificate} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createWindowsNativeOwnerSessionProvider}
  from '../src/native-owner-session-provider-windows.mjs';
import {verifyLinuxTunnelHealthPayload}
  from '../src/native-tunnel-client-observer-linux.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HASH=/^[a-f0-9]{64}$/;
const APPDATA=process.env.APPDATA;
const NATIVE_PS='C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const SCRIPT=path.join(path.dirname(fileURLToPath(import.meta.url)),
  'inspect-owner-tunnel-process-windows.ps1');
const digest=b=>createHash('sha256').update(b).digest('hex');
function regular(p,max=65536){
  const st=fs.lstatSync(p);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1
    ||st.size<1||st.size>max)
    fail('RC012_WINDOWS_OWNER_FILE_UNTRUSTED');
  return fs.readFileSync(p);
}
function directory(p){
  const st=fs.lstatSync(p);
  if(!st.isDirectory()||st.isSymbolicLink())
    fail('RC012_WINDOWS_OWNER_DIRECTORY_UNTRUSTED');
}
function ownerYaml(profile){
  const p=path.join(APPDATA,'tunnel-client',profile+'.yaml');
  const raw=regular(p,16384);
  const yaml=raw.toString('utf8').replace(/\r\n/g,'\n');
  const matches=[...yaml.matchAll(/^health:[ \t]*(?:#.*)?$/gm)];
  if(matches.length!==1)fail('RC012_WINDOWS_TUNNEL_HEALTH_BINDING_REQUIRED');
  const section=yaml.slice(matches[0].index+matches[0][0].length)
    .split(/(?=^[A-Za-z][\w.-]*:)/m,1)[0];
  const ports=[...section.matchAll(/^  listen_addr:[ \t]*["']?(127\.0\.0\.1:(\d{4,5}))["']?[ \t]*$/gm)];
  if(ports.length!==1)fail('RC012_WINDOWS_TUNNEL_HEALTH_BINDING_REQUIRED');
  const port=Number(ports[0][2]);
  if(!Number.isInteger(port)||port<1024||port>65535)
    fail('RC012_WINDOWS_TUNNEL_HEALTH_BINDING_REQUIRED');
  return {port,yamlSha256:digest(raw)};
}
function currentNativeProcess(profile,port){
  if(!fs.existsSync(NATIVE_PS)||!fs.existsSync(SCRIPT))
    fail('RC012_WINDOWS_TUNNEL_NATIVE_HELPER_MISSING');
  let raw;
  try{raw=execFileSync(NATIVE_PS,[
    '-NoLogo','-NoProfile','-NonInteractive','-File',SCRIPT,
    '-Profile',profile,'-HealthPort',String(port)
  ],{encoding:'utf8',timeout:10000,windowsHide:true,maxBuffer:4096});}
  catch{fail('RC012_WINDOWS_TUNNEL_NATIVE_PROCESS_NOT_ATTESTED');}
  let r;try{r=JSON.parse(raw);}catch{fail('RC012_WINDOWS_TUNNEL_PROCESS_RECORD_INVALID');}
  if(r?.schema!==1||r?.source!=='windows-native-owner-cim-tcp'
    ||r.profileId!==profile||r.healthPort!==port
    ||!Number.isSafeInteger(r.pid)||r.pid<1
    ||!Number.isSafeInteger(r.startedAtMs)||r.startedAtMs<1
    ||r.matchCount!==1||r.socketOwned!==true||r.processOwned!==true
    ||typeof r.executablePath!=='string'||!path.isAbsolute(r.executablePath)
    ||typeof r.executableSha256!=='string'||!HASH.test(r.executableSha256))
    fail('RC012_WINDOWS_TUNNEL_PROCESS_RECORD_INVALID');
  return r;
}
async function health(port,startedAtMs){
  const get=async(endpoint)=>{
    const res=await fetch('http://127.0.0.1:'+port+endpoint,
      {signal:AbortSignal.timeout(3000)});
    if(res.status!==200)fail('RC012_WINDOWS_TUNNEL_HEALTH_STATUS_INVALID');
    return res;
  };
  const [h,r,details,control]=await Promise.all([
    get('/healthz'),get('/readyz'),get('/health?details=true'),
    get('/health/control-plane')
  ]);
  await Promise.all([h.text(),r.text()]);
  const a=await details.json(),b=await control.json();
  const info=verifyLinuxTunnelHealthPayload({
    runtimeHealth:a,controlHealth:b,startedAtMs
  });
  return info;
}
function recordOwner(dir,record){
  const dest=path.join(dir,'owner-tunnel-trust.json');
  const allowed=Object.keys(record).sort().join(',');
  if(fs.existsSync(dest)){
    const parsed=JSON.parse(regular(dest,4096).toString('utf8'));
    const keys=Object.keys(parsed).sort().join(',');
    if(keys!==allowed||Object.keys(record)
      .some(k=>k!=='enrolledAtMs'&&parsed[k]!==record[k]))
      fail('RC012_WINDOWS_TUNNEL_OWNER_PIN_DRIFT');
    return {reused:true,record:parsed};
  }
  const data=JSON.stringify(record)+'\n';
  if(Buffer.byteLength(data)>4096)fail('RC012_WINDOWS_OWNER_PIN_BOUNDS');
  let fd,created=false;
  try{
    fd=fs.openSync(dest,fs.constants.O_WRONLY|fs.constants.O_CREAT
      |fs.constants.O_EXCL,0o600);
    created=true;fs.writeFileSync(fd,data);fs.fsyncSync(fd);fs.closeSync(fd);fd=null;
    const check=JSON.parse(regular(dest,4096).toString('utf8'));
    if(Object.keys(record).some(k=>check[k]!==record[k]))
      fail('RC012_WINDOWS_TUNNEL_PIN_READBACK_MISMATCH');
    return {reused:false,record:check};
  }catch(e){
    if(fd!==null&&fd!==undefined)fs.closeSync(fd);
    if(created)fs.unlinkSync(dest);
    throw e;
  }
}
// Windows COMPUTERNAME can be truncated to 15 characters while os.hostname()
// reports the full host identity. For read-only preflight, derive the host
// locally instead of requiring shell callers to guess its spelling. Mutating
// enrollment STILL requires an explicit exact host argument and native consent.
export function resolveWindowsOwnerEnrollmentArgs(args,localHost){
  if(!Array.isArray(args)||typeof localHost!=='string'||!ID.test(localHost))
    fail('RC012_WINDOWS_OWNER_TUNNEL_ENROLL_ARGS_INVALID');
  const ownerLocalReadOnly=args.length===2&&args[1]==='--preflight';
  if(!ownerLocalReadOnly&&(args.length<2||args.length>3))
    fail('RC012_WINDOWS_OWNER_TUNNEL_ENROLL_ARGS_INVALID');
  const [profile,host,mode]=ownerLocalReadOnly
    ?[args[0],localHost,'--preflight']
    :[args[0],args[1],args[2]??null];
  if(![profile,host].every(x=>typeof x==='string'&&ID.test(x))
    ||(mode!==null&&mode!=='--preflight'))
    fail('RC012_WINDOWS_OWNER_TUNNEL_ENROLL_ARGS_INVALID');
  if(localHost.toLowerCase()!==host.toLowerCase())
    fail('RC012_WINDOWS_OWNER_TUNNEL_HOST_MISMATCH');
  return Object.freeze({profile,host,mode});
}
async function main(){
  if(process.platform!=='win32'||!APPDATA||!path.isAbsolute(APPDATA))
    fail('RC012_WINDOWS_OWNER_TUNNEL_ENROLL_ARGS_INVALID');
  const {profile,host,mode}=resolveWindowsOwnerEnrollmentArgs(
    process.argv.slice(2),os.hostname());
  const dir=path.join(APPDATA,'ChatGPTRemoteCommander','private-pair',
    profile==='chatgpt-remote-commander'?'default':profile);
  directory(dir);
  const y=ownerYaml(profile);
  const cert=new X509Certificate(regular(path.join(dir,'client.crt')));
  const sha=digest(cert.raw);
  if(cert.ca!==false||Date.parse(cert.validTo)<=Date.now()
    ||Date.parse(cert.validFrom)>Date.now())
    fail('RC012_WINDOWS_TUNNEL_CLIENT_CERT_UNTRUSTED');
  const owner=createWindowsNativeOwnerSessionProvider();
  const seat=await owner.getOwnerSessionSnapshot();
  const p=currentNativeProcess(profile,y.port);
  await health(y.port,p.startedAtMs);
  const record={
    schema:1,kind:'windows-owner-private-one-tunnel',hostId:host,
    profileId:profile,ownerSidHash:seat.ownerSidHash,
    expectedExecutablePath:p.executablePath,
    expectedExecutableSha256:p.executableSha256,
    healthPort:y.port,expectedClientLeafDerSha256:sha,
    enrolledAtMs:Date.now()
  };
  if(mode==='--preflight'){
    console.log(JSON.stringify({result:'RC012_WINDOWS_TUNNEL_OWNER_PREFLIGHT_PASS',
      profile,host,ownerSeatVerified:true,processOwnerVerified:true,
      pidSocketBound:true,controlPlanePollVerified:true,ownerConsentRequested:false}));
    return;
  }
  const pinPath=path.join(dir,'owner-tunnel-trust.json');
  if(!fs.existsSync(pinPath)){
    const message=[
      'Approve exactly this existing local Windows private Tunnel identity?',
      'Host: '+host,'Account profile: '+profile,
      'Current PID: '+p.pid,'Health listener: 127.0.0.1:'+y.port,
      'Tunnel executable SHA-256: '+p.executableSha256,
      'mTLS client SHA-256: '+sha,'Windows owner: '+seat.ownerSidHash.slice(0,12),
      '',
      'This stores non-secret owner-trust pins only. It does not grant',
      'ChatGPT access, Full Access, system elevation, or modify Tunnel/API keys.'
    ].join('\n');
    const approved=await owner.requestConsent({
      title:'Commander - Enroll existing Windows private Tunnel',
      message,expectedOwnerSidHash:seat.ownerSidHash,
      expectedOsSessionId:seat.osSessionId
    });
    if(!approved)fail('RC012_WINDOWS_TUNNEL_NATIVE_OWNER_CONSENT_REQUIRED');
  }
  const seatAfter=await owner.getOwnerSessionSnapshot();
  const current=currentNativeProcess(profile,y.port);
  const healthNow=await health(y.port,current.startedAtMs);
  if(seatAfter.ownerSidHash!==seat.ownerSidHash
    ||seatAfter.osSessionId!==seat.osSessionId
    ||current.pid!==p.pid||current.startedAtMs!==p.startedAtMs
    ||current.executableSha256!==p.executableSha256
    ||ownerYaml(profile).yamlSha256!==y.yamlSha256
    ||digest(new X509Certificate(regular(path.join(dir,'client.crt'))).raw)!==sha
    ||!Number.isSafeInteger(healthNow.lastPollAtMs))
    fail('RC012_WINDOWS_TUNNEL_PIN_CHANGED_DURING_CONSENT');
  const result=recordOwner(dir,record);
  console.log(JSON.stringify({
    result:'RC012_WINDOWS_OWNER_SINGLE_TUNNEL_PIN_ENROLLED_PASS',
    host,profile,reused:result.reused,ownerConsentRequested:!result.reused,
    nativeOwnerVerified:true,processAndSocketVerified:true,
    controlPlanePollVerified:true,noApiKeyRead:true,
    tunnelChanged:false,workerGrantIssued:false,fullAccessActive:false
  }));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(e=>{
    console.error(e?.code??'RC012_WINDOWS_OWNER_TUNNEL_ENROLL_FAILED');
    process.exitCode=2;
  });
