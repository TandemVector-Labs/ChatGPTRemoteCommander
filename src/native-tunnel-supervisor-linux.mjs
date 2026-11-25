// Native v0.12 per-owner Tunnel liveness supervisor.
// No privileged MCP grants. Each unit owns only its own child and credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {spawn,execFile} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const base='/usr/lib/chatgpt-remote-commander';
const MAX_BODY=16384;
const PROFILE=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_AGE=86400000;
// Six failed 30-second Polls are sufficient after a verified HTTPS WAN route.
// Shared/isolated staged progression, per-profile 15-minute restart cooldown
// and current-Tunnel successful-peer proof remain unchanged.
const STALE=180000;
const FRESH=120000;
const COOLDOWN=900000;
const STAGE=120000;

export function parseNativeHealthPort(text){
  const match=String(text).match(/^[ \t]*listen_addr:[ \t]*['"]?127\.0\.0\.1:(\d{4,5})(?:['"]|[ \t\r\n]|$)/m);
  const port=Number(match?.[1]);
  return Number.isInteger(port)&&port>=1024&&port<=65535?port:null;
}

export function parseNativeLastPoll(payload){
  if(payload?.component!=='control-plane')return null;
  const stamp=payload?.details?.last_success;
  if(typeof stamp!=='string'||!(/^\d{4}-\d\d-\d\dT/.test(stamp)))return null;
  const ms=Date.parse(stamp);
  return Number.isSafeInteger(ms)&&ms>0?ms:null;
}

export function chooseNativeRecovery({now,startedAt,ownLast,peers,marker,previous}){
  if(!Number.isSafeInteger(now)||!Number.isSafeInteger(startedAt)
    ||!Number.isSafeInteger(ownLast)||now-startedAt<STALE
    ||now-ownLast<STALE||now-ownLast>MAX_AGE||ownLast>now)return false;
  if(Number.isSafeInteger(previous)&&now-previous<COOLDOWN)return false;
  if(!Array.isArray(peers)||peers.length>20)return false;
  const profiles=new Set();
  let fresh=0,stale=0,freshPeer=null;
  for(const p of peers){
    if(!PROFILE.test(p?.profile??'')||profiles.has(p.profile)
      ||!Number.isSafeInteger(p.last)||p.last>now)return false;
    profiles.add(p.profile);
    const age=now-p.last;
    if(age>=0&&age<=FRESH){fresh++;freshPeer=p;}
    else if(age>=STALE&&age<=MAX_AGE)stale++;
    else return false;
  }
  const hasMarker=marker!==null&&marker!==undefined;
  if(hasMarker){
    if(!Number.isSafeInteger(marker.at)||marker.at>now
      ||typeof marker.profile!=='string'||!PROFILE.test(marker.profile)
      ||now-marker.at<STAGE)return false;
  }
  if(fresh===0&&stale===peers.length){
    // A failed recovery must never cascade into other owners.
    return !hasMarker||(now-marker.at>=COOLDOWN
      &&ownLast>marker.at&&peers.every(p=>p.last>marker.at));
  }
  if(fresh===1&&stale===peers.length-1){
    return hasMarker&&marker.profile===freshPeer.profile
      &&freshPeer.last>marker.at;
  }
  // Two independently successful peer polls justify isolated recovery.
  return fresh>=2&&fresh+stale===peers.length;
}

function trustedDir(dir){
  const st=fs.lstatSync(dir);
  if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()
    ||(st.mode&0o077)!==0)throw Error('NATIVE_TUNNEL_WATCHDOG_STATE_UNTRUSTED');
}
function nativeStateDir(){
  const root=path.join(os.homedir(),'.local','state','chatgpt-remote-commander');
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const dir=path.join(root,'native-tunnel-watchdog');
  fs.mkdirSync(dir,{mode:0o700,recursive:true});
  trustedDir(dir);
  return dir;
}
function readState(dir){
  try{
    const file=path.join(dir,'state.json'),st=fs.lstatSync(file);
    if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()
      ||(st.mode&0o077)!==0)throw Error('NATIVE_TUNNEL_WATCHDOG_STATE_UNTRUSTED');
    const data=JSON.parse(fs.readFileSync(file,'utf8'));
    if(data?.schema!==1||typeof data.restarts!=='object'
      ||Array.isArray(data.restarts))throw Error('NATIVE_TUNNEL_WATCHDOG_STATE_CORRUPT');
    return data;
  }catch(e){
    if(e.code==='ENOENT')return {schema:1,marker:null,restarts:{}};
    throw e;
  }
}
function writeState(dir,value){
  const temp=path.join(dir,'state-'+process.pid+'.new');
  const fd=fs.openSync(temp,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}
  finally{fs.closeSync(fd);}
  fs.renameSync(temp,path.join(dir,'state.json'));
}
async function boundedJson(url){
  const response=await fetch(url,{signal:AbortSignal.timeout(2500),redirect:'error'});
  if(response.status!==200||!response.body)return null;
  const reader=response.body.getReader();
  const chunks=[];let bytes=0;
  try{
    while(true){
      const {value,done}=await reader.read();
      if(done)break;
      bytes+=value.byteLength;
      if(bytes>MAX_BODY){await reader.cancel();return null;}
      chunks.push(value);
    }
  }finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));}
  catch{return null;}
}
async function lastPoll(port){
  try{return parseNativeLastPoll(await boundedJson(
    'http://127.0.0.1:'+port+'/health/control-plane'));}
  catch{return null;}
}
export function parseNativeControlPlaneOrigin(text){
  const match=String(text).match(/^\s*control_plane:\s*\n\s*base_url:\s*['\"]?([^\s'\"]+)/m);
  if(!match)return null;
  try{
    const url=new URL(match[1]);
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash
      ||!url.hostname||url.hostname==='localhost'||url.hostname.endsWith('.local')
      ||url.hostname.startsWith('127.')||url.hostname==='::1')return null;
    return url.origin;
  }catch{return null;}
}
function verifiedNetwork(origin){
  if(typeof origin!=='string')return Promise.resolve(false);
  return new Promise(resolve=>{
    // curl uses the system's validated TLS and existing proxy/network settings.
    // This contains no key, authorization, cookies, or privilege from the owner.
    execFile('/usr/bin/curl',[
      '--silent','--show-error','--proto','=https','--tlsv1.2',
      '--connect-timeout','3','--max-time','8','--max-redirs','0',
      '--output','/dev/null','--write-out','%{http_code} %{ssl_verify_result}',
      origin+'/v1/models'
    ],{encoding:'utf8',timeout:9500,maxBuffer:128,env:process.env},
    (error,stdout)=>resolve(!error&&stdout.trim()==='401 0'));
  });
}
function portFromFile(file){
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid())return null;
  return parseNativeHealthPort(fs.readFileSync(file,'utf8'));
}
function acquireLock(dir){
  const lock=path.join(dir,'guard.lock');
  try{fs.mkdirSync(lock,{mode:0o700});}
  catch(e){
    if(e.code!=='EEXIST')throw e;
    // Stale guard from an interrupted process is recovered only after
    // its owner PID no longer exists and a conservative five-minute grace.
    try{
      const info=JSON.parse(fs.readFileSync(path.join(lock,'owner.json'),'utf8'));
      const age=Date.now()-info.at;
      if(!Number.isSafeInteger(info.pid)||info.pid<2||age<300000)return null;
      try{process.kill(info.pid,0);return null;}
      catch(err){if(err.code!=='ESRCH')return null;}
      fs.unlinkSync(path.join(lock,'owner.json'));
      fs.rmdirSync(lock);
      fs.mkdirSync(lock,{mode:0o700});
    }catch{return null;}
  }
  fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({
    pid:process.pid,at:Date.now()
  }),{mode:0o600,flag:'wx'});
  return ()=>{
    fs.unlinkSync(path.join(lock,'owner.json'));
    fs.rmdirSync(lock);
  };
}

export async function nativeRecoveryCheck({
  profile,configDir,ownPort,startedAt,now=Date.now()
}){
  const dir=nativeStateDir();
  const unlock=acquireLock(dir);
  if(!unlock)return false;
  try{
    const ownLast=await lastPoll(ownPort);
    if(!ownLast||now-ownLast<STALE||now-startedAt<STALE)return false;
    const peers=[];
    for(const name of fs.readdirSync(configDir).sort()){
      if(!name.endsWith('.yaml'))continue;
      const id=name.slice(0,-5);
      if(!PROFILE.test(id)||id===profile)continue;
      const port=portFromFile(path.join(configDir,name));
      if(!port||port===ownPort)return false;
      const last=await lastPoll(port);
      if(!last)return false; // incomplete evidence cannot kill a live child
      peers.push({profile:id,last});
    }
    const state=readState(dir);
    if(!chooseNativeRecovery({now,startedAt,ownLast,peers,
      marker:state.marker,previous:state.restarts[profile]}))return false;
    const config=fs.readFileSync(path.join(configDir,profile+'.yaml'),'utf8');
    if(!(await verifiedNetwork(parseNativeControlPlaneOrigin(config))))return false;
    state.marker={profile,at:now};
    state.restarts[profile]=now;
    writeState(dir,state);
    return true;
  }finally{unlock();}
}
export async function runNativeSupervisor(profile,configDir,credentialDir){
  if(!PROFILE.test(profile)||!path.isAbsolute(configDir)
    ||typeof credentialDir!=='string'||!path.isAbsolute(credentialDir))
    throw Error('NATIVE_TUNNEL_PROFILE_INVALID');
  const file=path.join(configDir,profile+'.yaml');
  const port=portFromFile(file);
  if(!port)throw Error('NATIVE_TUNNEL_HEALTH_PORT_MISSING');
  const secret=path.join(credentialDir,'api-key');
  const st=fs.lstatSync(secret);
  if(!st.isFile()||st.isSymbolicLink())throw Error('NATIVE_TUNNEL_CREDENTIAL_INVALID');
  const apiKey=fs.readFileSync(secret,'utf8').trim();
  if(!apiKey)throw Error('NATIVE_TUNNEL_CREDENTIAL_EMPTY');
  const env={...process.env,CONTROL_PLANE_API_KEY:apiKey};
  delete env.OPENAI_API_KEY;
  const child=spawn(path.join(base,'tunnel','tunnel-client'),[
    'run','--profile',profile,'--profile-dir',configDir,'--log.file','stdout'
  ],{env,stdio:'inherit'});
  // Do not retain the credential value in the environment of the supervisor.
  let stopping=false,checking=false;
  const stop=()=>{stopping=true;child.kill('SIGTERM');};
  process.on('SIGTERM',stop);
  process.on('SIGINT',stop);
  const startedAt=Date.now();
  const timer=setInterval(async()=>{
    if(checking||stopping||child.exitCode!==null||child.killed)return;
    checking=true;
    try{
      if(await nativeRecoveryCheck({profile,configDir,ownPort:port,startedAt})){
        process.stderr.write('NATIVE_TUNNEL_STALE_STAGED_RESTART profile='+profile+'\n');
        child.kill('SIGTERM');
        setTimeout(()=>child.kill('SIGKILL'),4000).unref();
      }
    }catch(e){
      process.stderr.write('NATIVE_TUNNEL_WATCHDOG_DEFERRED '+String(e.code||e.message).slice(0,100)+'\n');
    }finally{checking=false;}
  },30000);
  await new Promise(resolve=>{
    child.once('error',()=>resolve());
    child.once('exit',()=>resolve());
  });
  clearInterval(timer);
  return stopping?0:75; // systemd Restart=on-failure preserves per-owner unit only
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  runNativeSupervisor(process.argv[2],process.argv[3],process.env.CREDENTIALS_DIRECTORY)
    .then(code=>{process.exitCode=code;})
    .catch(e=>{
      process.stderr.write('NATIVE_TUNNEL_SUPERVISOR_ERROR '+String(e.code||e.message).slice(0,100)+'\n');
      process.exitCode=78;
    });
}
