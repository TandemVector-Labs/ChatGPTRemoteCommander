// V1-07 program-allowlisted native process probe.
// A host must pin the exact binary/hash and approve its executable verifier.
// The model/user cannot supply a program, argument vector, environment or shell.
import {createHash} from 'node:crypto';
import {createReadStream,lstatSync,realpathSync} from 'node:fs';
import {execFile as execFileDefault} from 'node:child_process';
import {posix,win32} from 'node:path';

const HASH=/^[a-f0-9]{64}$/;
const OWNER=/^[a-f0-9]{64}$/;
const PROGRAM_ID='tailscale-status';
const SOURCE='native-tailscale-cli-probe';
const ARGS=Object.freeze(['status','--json']);
const fail=code=>{throw Object.assign(new Error(code),{code,nativeProcessProbeCode:code});};

function exactRecord(value,fields,code){
  if(!value||typeof value!=='object'||Array.isArray(value)
    ||![Object.prototype,null].includes(Object.getPrototypeOf(value))
    ||Reflect.ownKeys(value).length!==fields.length)fail(code);
  const out=Object.create(null);
  for(const field of fields){
    const d=Object.getOwnPropertyDescriptor(value,field);
    if(!d||!d.enumerable||!Object.hasOwn(d,'value'))fail(code);
    out[field]=d.value;
  }
  return out;
}
function validatePath(value,platform){
  const pathApi=platform==='win32'?win32:posix;
  if(typeof value!=='string'||value.length<4||value.length>2048
    ||value.includes('\0')||!pathApi.isAbsolute(value))fail('NATIVE_PROCESS_PATH_INVALID');
  const normalized=pathApi.normalize(value);
  const equal=platform==='win32'
    ?normalized.toLowerCase()===value.toLowerCase()
    :normalized===value;
  if(!equal)fail('NATIVE_PROCESS_PATH_INVALID');
  return normalized;
}
function safeEnvironment(platform,source=process.env){
  const keys=platform==='win32'
    ?['SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','HOMEDRIVE','HOMEPATH','PATH']
    :['HOME','USER','LOGNAME','LANG','LC_ALL','XDG_RUNTIME_DIR','PATH'];
  const env=Object.create(null);
  for(const key of keys){
    const value=source[key];
    if(typeof value==='string'&&value.length>0&&!/[\u0000-\u001f\u007f]/.test(value))
      env[key]=value;
  }
  return env;
}
async function sha256File(path){
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(path))hash.update(chunk);
  return hash.digest('hex');
}
function statIdentity(st){
  return Object.freeze({
    dev:st.dev,ino:st.ino,size:st.size,mtimeMs:st.mtimeMs,ctimeMs:st.ctimeMs
  });
}
function sameStat(a,b){
  return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size
    &&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
}
function readTrustedFile(path){
  let st,real;
  try{st=lstatSync(path);real=realpathSync(path);}catch{fail('NATIVE_PROCESS_EXECUTABLE_UNAVAILABLE');}
  if(!st.isFile()||st.isSymbolicLink()||real!==path)
    fail('NATIVE_PROCESS_EXECUTABLE_UNTRUSTED');
  return st;
}
function clock(now){
  const value=now();
  if(!Number.isSafeInteger(value)||value<0)fail('NATIVE_PROCESS_CLOCK_INVALID');
  return value;
}
function runChild(execFileImpl,path,args,options){
  return new Promise(resolve=>{
    let child;
    try{
      child=execFileImpl(path,args,options,(error,stdout)=>{
        const exitCode=!error?0:Number.isInteger(error.code)?error.code:-1;
        const output=typeof stdout==='string'?stdout:
          Buffer.isBuffer(stdout)?stdout.toString('utf8'):'';
        resolve({pid:Number.isSafeInteger(child?.pid)?child.pid:0,exitCode,stdout:output});
      });
    }catch{
      resolve({pid:0,exitCode:-1,stdout:''});
    }
  });
}

/**
 * Create a zero-argument probe for one immutable allowlisted native program.
 * Only the "tailscale-status" program ID and "status --json" vector are accepted.
 * verifyExecutable must validate the platform's native trust policy (for example,
 * root-owned non-writable Linux binary or Authenticode-valid Windows binary).
 */
export function createAllowlistedNativeProcessProbe({
  platform=process.platform,allowedProgram,resolveOwnerSidHash,
  verifyExecutable,execFileImpl=execFileDefault,now=Date.now
}={}){
  if(!['linux','win32'].includes(platform)||typeof resolveOwnerSidHash!=='function'
    ||typeof verifyExecutable!=='function'||typeof execFileImpl!=='function'
    ||typeof now!=='function')fail('NATIVE_PROCESS_PROBE_CONFIG_INVALID');
  const program=exactRecord(allowedProgram,[
    'programId','executablePath','executableSha256','args','timeoutMs','maxBufferBytes'
  ],'NATIVE_PROCESS_ALLOWLIST_ENTRY_INVALID');
  if(program.programId!==PROGRAM_ID||!HASH.test(program.executableSha256??'')
    ||!Array.isArray(program.args)||program.args.length!==ARGS.length
    ||program.args.some((value,index)=>value!==ARGS[index])
    ||!Number.isSafeInteger(program.timeoutMs)||program.timeoutMs<250
    ||program.timeoutMs>15000||!Number.isSafeInteger(program.maxBufferBytes)
    ||program.maxBufferBytes<1024||program.maxBufferBytes>4194304)
    fail('NATIVE_PROCESS_ALLOWLIST_ENTRY_INVALID');
  const executablePath=validatePath(program.executablePath,platform);
  async function run(){
    const ownerBefore=await resolveOwnerSidHash();
    if(!OWNER.test(ownerBefore??''))fail('NATIVE_PROCESS_OWNER_UNVERIFIED');
    const beforeStat=readTrustedFile(executablePath);
    const beforeHash=await sha256File(executablePath);
    if(beforeHash!==program.executableSha256)fail('NATIVE_PROCESS_EXECUTABLE_HASH_MISMATCH');
    const beforeTrusted=await verifyExecutable(Object.freeze({
      platform,executablePath,executableSha256:beforeHash,stat:beforeStat
    }));
    if(beforeTrusted!==true)fail('NATIVE_PROCESS_EXECUTABLE_UNTRUSTED');
    const startedAtMs=clock(now);
    const child=await runChild(execFileImpl,executablePath,[...ARGS],{
      encoding:'utf8',windowsHide:true,shell:false,
      timeout:program.timeoutMs,maxBuffer:program.maxBufferBytes,
      env:safeEnvironment(platform)
    });
    const finishedAtMs=clock(now);
    if(finishedAtMs<startedAtMs||finishedAtMs-startedAtMs>program.timeoutMs+1000)
      fail('NATIVE_PROCESS_DURATION_INVALID');
    if(Buffer.byteLength(child.stdout,'utf8')>program.maxBufferBytes)
      fail('NATIVE_PROCESS_OUTPUT_TOO_LARGE');
    const afterStat=readTrustedFile(executablePath);
    const afterHash=await sha256File(executablePath);
    const afterTrusted=await verifyExecutable(Object.freeze({
      platform,executablePath,executableSha256:afterHash,stat:afterStat
    }));
    if(afterHash!==beforeHash||!sameStat(statIdentity(beforeStat),statIdentity(afterStat))
      ||afterTrusted!==true)fail('NATIVE_PROCESS_EXECUTABLE_CHANGED');
    const ownerAfter=await resolveOwnerSidHash();
    if(ownerAfter!==ownerBefore)fail('NATIVE_PROCESS_OWNER_CHANGED');
    return Object.freeze({
      source:SOURCE,pid:child.pid,ownerSidHash:ownerBefore,
      executablePath,executableSha256:beforeHash,
      startedAtMs,finishedAtMs,exitCode:child.exitCode,stdout:child.stdout
    });
  }
  return Object.freeze({programId:PROGRAM_ID,run});
}
