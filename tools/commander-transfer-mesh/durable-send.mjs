#!/usr/bin/env node
// Durable local staging; Syncthing handles the encrypted peer data plane.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
// This worker is copied to COMMANDER_TRANSFER_HOME/durable-send.mjs on hosts.
// Keep the minimal path-root guard self-contained so a copied worker can run
// without relative source-tree dependencies.
function assertUnredirectedDirectoryAncestors(input,code='MANAGED_PATH_UNSAFE'){
 if(typeof input!=='string'||!path.isAbsolute(input))throw Error(code);
 const normalized=path.normalize(input);
 // An absolute Windows path may still refer to a network or device namespace.
 // Operator state must be on a local drive, not a UNC/device namespace.
 if(process.platform==='win32'&&!/^[A-Za-z]:[\\/]/.test(normalized))throw Error(code);
 const anchor=path.parse(normalized).root;
 let cur=anchor;
 for(const part of path.relative(anchor,normalized).split(path.sep)){
  if(!part||part==='.')continue;
  cur=path.join(cur,part);
  try{
   const st=fs.lstatSync(cur);
   if(st.isSymbolicLink()||!st.isDirectory())throw Error(code);
  }catch(e){if(e.code==='ENOENT')continue;throw Error(code);}
 }
}
process.umask(0o077);
const root=path.resolve(process.env.COMMANDER_TRANSFER_HOME||(
 process.platform==='win32'?path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'CommanderTransferPilot'):path.join(os.homedir(),'.local','share','commander-transfer-pilot')));
const peers=['PC','Linux','EmadServer','Amirreza'];
const re=/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,90}$/;
const [command,...args]=process.argv.slice(2);
const opt=k=>{const i=args.indexOf('--'+k);return i<0?undefined:args[i+1];};
const assertion=(test,code)=>{if(!test)throw Error(code);};
const within=(file,base)=>{const rel=path.relative(base,file);return rel===''||(rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel));};
// All managed paths are within the operator-selected private transfer root.
// A symlink in an internal ancestor or journal can escape that root even if
// peer/id pass allow-list validation. Reject it before reading or writing.
function assertManagedEntry(file, directory){
 let st;
 try { st=fs.lstatSync(file); }
 catch(e){ if(e.code==='ENOENT')return; throw e; }
 assertion(!st.isSymbolicLink() && (directory ? st.isDirectory() : st.isFile() && st.nlink===1),
   'TRANSFER_MANAGED_PATH_UNSAFE');
}
function safePaths(peer,id){
 assertion(peers.includes(peer)&&re.test(String(id||'')),'INVALID_TRANSFER_ID_OR_PEER');
 const jobDir=path.join(root,'jobs',peer);
 const stageDir=path.join(root,'staging',peer);
 const destination=path.join(root,'pairs',peer,'transfers',id);
 const record=path.join(jobDir,id+'.json'),lock=path.join(jobDir,id+'.lock'),part=path.join(stageDir,id+'.part');
 // The root itself is chosen by the owner; forbid redirection below it.
 for(const dir of [path.join(root,'jobs'),jobDir,path.join(root,'staging'),stageDir,
  path.join(root,'pairs'),path.join(root,'pairs',peer),path.dirname(destination),destination])
  assertManagedEntry(dir,true);
 for(const file of [record,lock,part,path.join(destination,'payload.bin'),path.join(destination,'manifest.json')])
  assertManagedEntry(file,false);
 return {jobDir,stageDir,record,lock,part,destination};
}
const recordRead=p=>JSON.parse(fs.readFileSync(p.record,'utf8'));
function atomicRename(from,to){
 let last;
 const sleeper=new Int32Array(new SharedArrayBuffer(4));
 for(let n=0;n<15;n++){
  try{fs.renameSync(from,to);return;}
  catch(e){
   last=e;
   if(!['EPERM','EBUSY','EACCES'].includes(e.code))throw e;
   Atomics.wait(sleeper,0,0,30+20*n);
  }
 }
 throw last;
}
function save(p,record){
 if(fs.existsSync(p.record) && !['PUBLISHED','CANCELLED','CANCEL_REQUESTED'].includes(record.status)){
  const last=recordRead(p);
  if(['CANCEL_REQUESTED','CANCELLED'].includes(last.status) && !(record.status==='INTERRUPTED' && record.errorCode==='PUBLISH_RECOVERY_REQUIRED'))record.status='CANCEL_REQUESTED';
 }
 const tmp=p.record+'.'+process.pid+'.'+crypto.randomUUID()+'.tmp';
 fs.writeFileSync(tmp,JSON.stringify(record)+'\n',{flag:'wx',mode:0o600});
 atomicRename(tmp,p.record);
}
const summary=j=>({schema:'ctmesh-durable-v1',id:j.id,peer:j.peer,status:j.status,bytes:j.bytes,copiedBytes:j.copiedBytes||0,percent:j.bytes?Math.min(100,Math.floor((j.copiedBytes||0)*100/j.bytes)):100,sha256:j.sha256||null,errorCode:j.errorCode||null});
const reply=j=>console.log(JSON.stringify(j));

const quotas={
 maxSourceBytes:Number(opt('max-source-bytes')??16*1024**3),
 maxPendingBytes:Number(opt('max-pending-bytes')??64*1024**3),
 maxActiveJobs:Number(opt('max-active-jobs')??3)
};
function enforceAdmission(bytes){
 for(const [key,n] of Object.entries(quotas))assertion(Number.isSafeInteger(n)&&n>=1,'QUOTA_INVALID_'+key);
 assertion(quotas.maxSourceBytes<=quotas.maxPendingBytes,'QUOTA_INCONSISTENT');
 assertion(bytes<=quotas.maxSourceBytes,'TRANSFER_SOURCE_SIZE_QUOTA');
 let pending=0,active=0;
 const dir=path.join(root,'jobs');
 for(const peerDir of fs.readdirSync(dir,{withFileTypes:true})){
  if(!peerDir.isDirectory()||!peers.includes(peerDir.name))continue;
  for(const item of fs.readdirSync(path.join(dir,peerDir.name),{withFileTypes:true})){
   if(!item.name.endsWith('.json'))continue;
   assertion(item.isFile()&&!item.isSymbolicLink(),'QUEUE_RECORD_UNSAFE');
   const j=JSON.parse(fs.readFileSync(path.join(dir,peerDir.name,item.name),'utf8'));
   assertion(Number.isSafeInteger(j.bytes)&&j.bytes>=0,'QUEUE_RECORD_INVALID');
   if(['PUBLISHED','CANCELLED'].includes(j.status))continue;
   pending+=j.bytes;
   assertion(Number.isSafeInteger(pending),'QUEUE_BYTES_OVERFLOW');
   if(['QUEUED','COPYING','VERIFYING','CANCEL_REQUESTED'].includes(j.status))active++;
  }
 }
 assertion(pending+bytes<=quotas.maxPendingBytes,'TRANSFER_PENDING_BYTES_QUOTA');
 assertion(active<quotas.maxActiveJobs,'TRANSFER_CONCURRENT_JOBS_QUOTA');
 const disk=fs.statfsSync(root,{bigint:true});
 const available=disk.bavail*disk.bsize;
 // Reserve capacity for existing uncompleted jobs as well as this new one.
 assertion(available>=BigInt(pending)+BigInt(bytes)+64n*1024n*1024n,'TRANSFER_DISK_SPACE_QUOTA');
}

function checkInput(j){
 const input=fs.realpathSync.native(j.path),allow=fs.realpathSync.native(j.sourceRoot);
 assertion(within(input,allow),'SOURCE_SCOPE_CHANGED');
 const st=fs.lstatSync(input);
 assertion(st.isFile()&&!st.isSymbolicLink(),'SOURCE_NOT_REGULAR');
 assertion(st.size===j.bytes&&st.mtimeMs===j.mtimeMs&&st.ino===j.ino&&st.dev===j.dev,'SOURCE_CHANGED');
 return input;
}
const running=pid=>{if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
function launch(p){
 const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'work','--peer',path.basename(p.jobDir),'--id',path.basename(p.record,'.json')],{
   cwd:root,env:{...process.env,COMMANDER_TRANSFER_HOME:root},detached:true,stdio:'ignore',windowsHide:true});
 child.on('error',()=>{});
 child.unref();
 return child.pid;
}
function hash(file){
 const sha=crypto.createHash('sha256'),fd=fs.openSync(file,'r'),buf=Buffer.allocUnsafe(4*1024*1024);
 try{for(let n;(n=fs.readSync(fd,buf,0,buf.length,null))>0;)sha.update(buf.subarray(0,n));}finally{fs.closeSync(fd);}
 return sha.digest('hex');
}
function noExistingArtifact(p){assertion(!fs.existsSync(p.destination),'TRANSFER_ALREADY_PUBLISHED');}
function copyJob(p,j){
 fs.mkdirSync(p.stageDir,{recursive:true});
 const source=checkInput(j);
 const existingPayload=path.join(p.destination,'payload.bin');
 const existingManifest=path.join(p.destination,'manifest.json');
 if(fs.existsSync(existingPayload)){
  assertion(fs.lstatSync(existingPayload).isFile(),'PUBLISHED_PAYLOAD_INVALID');
  const verified=hash(source);
  assertion(hash(existingPayload)===verified,'PUBLISHED_PAYLOAD_HASH_MISMATCH');
  const expected={schema:'ctmesh-v1',id:j.id,from:j.from,to:j.peer,name:j.name,bytes:j.bytes,sha256:verified,createdAt:j.createdAt};
  if(fs.existsSync(existingManifest)){
    const m=JSON.parse(fs.readFileSync(existingManifest,'utf8'));
    assertion(JSON.stringify(m)===JSON.stringify(expected),'PUBLISHED_MANIFEST_DIFFERENT');
  }else{fs.writeFileSync(existingManifest,JSON.stringify(expected)+'\n',{flag:'wx',mode:0o600});}
  j.sha256=verified;j.copiedBytes=j.bytes;j.status='PUBLISHED';save(p,j);return;
 }
 if(fs.existsSync(p.part))assertion(fs.lstatSync(p.part).isFile()&&!fs.lstatSync(p.part).isSymbolicLink(),'BAD_PARTIAL_FILE');
 const input=fs.openSync(source,'r');
 const out=fs.openSync(p.part,fs.existsSync(p.part)?'r+':'wx+',0o600);
 let offset=fs.fstatSync(out).size;
 assertion(offset<=j.bytes,'PARTIAL_TOO_LARGE');
 const buf=Buffer.allocUnsafe(4*1024*1024);
 try{
  j.status='COPYING';j.pid=process.pid;j.copiedBytes=offset;save(p,j);
  while(offset<j.bytes){
   // A cancellation is durable, not an OS-level termination of a shared process.
   const current=recordRead(p);if(['CANCEL_REQUESTED','CANCELLED'].includes(current.status)){j.status='CANCELLED';j.copiedBytes=offset;save(p,j);return;}
   const size=Math.min(buf.length,j.bytes-offset);
   const bytes=fs.readSync(input,buf,0,size,offset);
   assertion(bytes===size,'SHORT_SOURCE_READ');
   let written=0;while(written<bytes){written+=fs.writeSync(out,buf,written,bytes-written,offset+written);}
   offset+=bytes;
   if(offset-j.copiedBytes>=16*1024*1024 || offset===j.bytes){fs.fsyncSync(out);j.copiedBytes=offset;save(p,j);}
  }
  fs.fsyncSync(out);
 }finally{fs.closeSync(input);fs.closeSync(out);}
 checkInput(j);
 j.status='VERIFYING';j.copiedBytes=j.bytes;save(p,j);
 const sourceSha=hash(source),partSha=hash(p.part);
 assertion(sourceSha===partSha,'STAGING_HASH_MISMATCH');
 checkInput(j);
 const recent=recordRead(p);
 if(['CANCEL_REQUESTED','CANCELLED'].includes(recent.status)){j.status='CANCELLED';save(p,j);return;}
 fs.mkdirSync(path.dirname(p.destination),{recursive:true});
 if(fs.existsSync(p.destination)){
  const entry=fs.lstatSync(p.destination);
  assertion(entry.isDirectory()&&!entry.isSymbolicLink(),'TRANSFER_PUBLICATION_PATH_UNSAFE');
  assertion(fs.readdirSync(p.destination).length===0,'TRANSFER_ALREADY_PUBLISHED');
 }else fs.mkdirSync(p.destination,{recursive:false});
 const payload=path.join(p.destination,'payload.bin');
 atomicRename(p.part,payload);
 const manifest={schema:'ctmesh-v1',id:j.id,from:j.from,to:j.peer,name:j.name,bytes:j.bytes,sha256:sourceSha,createdAt:j.createdAt};
 fs.writeFileSync(path.join(p.destination,'manifest.json'),JSON.stringify(manifest)+'\n',{flag:'wx',mode:0o600});
 j.sha256=sourceSha;j.status='PUBLISHED';save(p,j);
}
function worker(p){
 let lockFd;
 try{
  lockFd=fs.openSync(p.lock,'wx',0o600);
  fs.writeFileSync(lockFd,JSON.stringify({pid:process.pid})+'\n');
  const j=recordRead(p);
  assertion(['QUEUED','INTERRUPTED','FAILED'].includes(j.status),'JOB_NOT_RUNNABLE');
  try{copyJob(p,j);}catch(e){j.status='FAILED';j.errorCode=String(e?.message||e).slice(0,100);save(p,j);}
 }catch(e){if(e.code!=='EEXIST')throw e;}
 finally{if(lockFd!==undefined){fs.closeSync(lockFd);fs.rmSync(p.lock,{force:true});}}
}
function inspect(p){
 const j=recordRead(p);
 if(j.status==='CANCEL_REQUESTED' && !running(j.pid)){
  if(fs.existsSync(path.join(p.destination,'payload.bin'))){
   j.status='INTERRUPTED';j.errorCode='PUBLISH_RECOVERY_REQUIRED';save(p,j);return j;
  }
  j.status='CANCELLED';save(p,j);
  return j;
 }
 if(['COPYING','VERIFYING','QUEUED'].includes(j.status) && (
    (j.pid && !running(j.pid)) ||
    (!j.pid && Date.now()-Date.parse(j.createdAt)>30000 && (
      !fs.existsSync(p.lock)||!running(JSON.parse(fs.readFileSync(p.lock,'utf8')).pid)
    ))
  )){
  j.status='INTERRUPTED';j.errorCode='WORKER_EXITED';save(p,j);
 }
 return j;
}
try{
 if(command==='capabilities'){
  reply({schema:'ctmesh-durable-v1',contractVersion:2,admissionQuotas:true,
    supports:['enqueue','job-status','resume','cancel'],workerPersistence:true,hashVerification:'sha256'});
 }else{
 if(process.env.COMMANDER_TRANSFER_HOME && !path.isAbsolute(process.env.COMMANDER_TRANSFER_HOME))
  throw Error('TRANSFER_MANAGED_PATH_UNSAFE'); // Explicit relative roots must not be rebased onto an arbitrary cwd.
 assertUnredirectedDirectoryAncestors(root,'TRANSFER_MANAGED_PATH_UNSAFE');
 const peer=opt('peer'),id=opt('id'),p=safePaths(peer,id);
 if(command==='enqueue'){
  const source=opt('path'),sourceRoot=opt('source-root');
  assertion(typeof source==='string'&&path.isAbsolute(source)&&typeof sourceRoot==='string'&&path.isAbsolute(sourceRoot),'ABSOLUTE_PATH_REQUIRED');
  const real=fs.realpathSync.native(source),allow=fs.realpathSync.native(sourceRoot);
  assertion(within(real,allow),'SOURCE_PATH_NOT_ALLOWED');
  const st=fs.lstatSync(real);assertion(st.isFile()&&!st.isSymbolicLink(),'SOURCE_NOT_REGULAR');
  assertion(!/[\\/:*?"<>|\x00-\x1f]/.test(path.basename(real)),'UNSAFE_FILENAME');
  const node=JSON.parse(fs.readFileSync(path.join(root,'node.json'),'utf8'));
  assertion(peers.includes(node.alias)&&node.alias!==peer,'LOCAL_IDENTITY_INVALID');
  const jobsRoot=path.join(root,'jobs');
  fs.mkdirSync(jobsRoot,{recursive:true});
  fs.mkdirSync(p.jobDir,{recursive:true});
  const admissionLock=path.join(jobsRoot,'.admission.lock');
  // Exclusive reservation: concurrent enqueue processes cannot all pass the same quota snapshot.
  const admissionFd=fs.openSync(admissionLock,'wx',0o600);
  let j;
  try{
    fs.writeFileSync(admissionFd,JSON.stringify({pid:process.pid})+'\n');
    assertion(!fs.existsSync(p.destination),'TRANSFER_ALREADY_PUBLISHED');
    enforceAdmission(st.size);
    j={schema:'ctmesh-durable-v1',id,peer,from:node.alias,path:real,sourceRoot:allow,name:path.basename(real),
      bytes:st.size,mtimeMs:st.mtimeMs,ino:st.ino,dev:st.dev,copiedBytes:0,status:'QUEUED',createdAt:new Date().toISOString()};
    fs.writeFileSync(p.record,JSON.stringify(j)+'\n',{flag:'wx',mode:0o600});
  }finally{
    fs.closeSync(admissionFd);
    fs.rmSync(admissionLock,{force:true});
  }
  launch(p);
  reply(summary(j));
 }else if(command==='work'){worker(p);}
 else if(command==='job-status'){
  reply(summary(inspect(p)));
 }else if(command==='resume'){
  const j=inspect(p);
  assertion(['FAILED','INTERRUPTED'].includes(j.status),'NOT_RESUMABLE');
  if(fs.existsSync(p.lock)){const old=JSON.parse(fs.readFileSync(p.lock,'utf8'));assertion(!running(old.pid),'JOB_STILL_RUNNING');fs.rmSync(p.lock);}
  checkInput(j);
  j.status='QUEUED';j.errorCode=null;j.pid=null;save(p,j);
  launch(p);reply(summary(j));
 }else if(command==='cancel'){
  const j=inspect(p);
  assertion(!['PUBLISHED','CANCELLED'].includes(j.status),'ALREADY_TERMINAL');
  assertion(!fs.existsSync(path.join(p.destination,'payload.bin')),'TRANSFER_PUBLISHED_RECOVERY_REQUIRED');
  j.status=j.status==='COPYING'||j.status==='VERIFYING'?'CANCEL_REQUESTED':'CANCELLED';
  save(p,j);reply(summary(j));
 }else{throw Error('UNKNOWN_COMMAND');}
 }
}catch(e){console.error('CTMESH_DURABLE_ERROR:'+String(e.message||e));process.exitCode=1;}
