#!/usr/bin/env node
// CT Mesh pilot CLI - the transfer transport is the official Syncthing daemon.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
const root=path.resolve(process.env.COMMANDER_TRANSFER_HOME || (process.platform==='win32'
 ?path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'CommanderTransferPilot')
 :path.join(os.homedir(),'.local','share','commander-transfer-pilot')));
// Each deployed CLI is intentionally self-contained; the large-file preflight
// copies only durable-send.mjs. Keep root validation in this executable rather
// than importing an adjacent module that will not ship with the worker.
function assertUnredirectedRoot(){
 const normalized=path.normalize(root),anchor=path.parse(normalized).root;
 let current=anchor;
 for(const part of path.relative(anchor,normalized).split(path.sep)){
  if(!part||part==='.')continue;
  current=path.join(current,part);
  try{
   const st=fs.lstatSync(current);
   if(st.isSymbolicLink()||!st.isDirectory())throw Error('CTMESH_MANAGED_PATH_UNSAFE');
  }catch(e){
   if(e.code==='ENOENT')continue;
   throw Error('CTMESH_MANAGED_PATH_UNSAFE');
  }
 }
}

const args=process.argv.slice(2),cmd=args.shift();
const arg=(k,fallback)=>{const i=args.indexOf('--'+k);if(i<0)return fallback;if(i===args.length-1)throw Error('Missing value '+k);return args[i+1];};
const validAlias=/^(PC|Linux|EmadServer|Amirreza)$/;
const validId=/^[A-Za-z0-9][A-Za-z0-9._-]{2,90}$/;
const fail=(m)=>{throw Error(m);};
// root is an explicitly selected operator trust anchor. Never follow
// pre-existing symlinks beneath it for managed transfer identity/data.
function assertManagedEntry(file,directory){
 let stat;
 try{stat=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return;throw error;}
 if(stat.isSymbolicLink()||(directory?!stat.isDirectory():!stat.isFile()||stat.nlink!==1))
  fail('CTMESH_MANAGED_PATH_UNSAFE');
}
function assertManagedTree(peer,id){
 const pairs=path.join(root,'pairs'),peerDir=path.join(pairs,peer);
 const transfers=path.join(peerDir,'transfers'),dir=path.join(transfers,id);
 for(const folder of [pairs,peerDir,transfers,dir])assertManagedEntry(folder,true);
 for(const file of [path.join(dir,'payload.bin'),path.join(dir,'manifest.json')])
  assertManagedEntry(file,false);
}
function assertManagedStaging(peer,id){
 const staging=path.join(root,'staging'),peerDir=path.join(staging,peer);
 assertManagedEntry(staging,true);
 assertManagedEntry(peerDir,true);
 assertManagedEntry(path.join(peerDir,id+'.part'),false);
}
const json=(o)=>process.stdout.write(JSON.stringify(o)+'\n');
function hash(file){let h=crypto.createHash('sha256'),b=Buffer.allocUnsafe(1048576),fd=fs.openSync(file,'r');
 try{for(;;){const n=fs.readSync(fd,b,0,b.length,null);if(!n)break;h.update(b.subarray(0,n));}}
 finally{fs.closeSync(fd);}return h.digest('hex');}
function transferPaths(peer,self,id){
 if(!validAlias.test(peer)||peer===self)fail('Unknown or self peer');
 if(!validId.test(id))fail('Invalid transfer ID');
 assertManagedTree(peer,id);
 const dir=path.join(root,'pairs',peer,'transfers',id);
 return {dir,payload:path.join(dir,'payload.bin'),manifest:path.join(dir,'manifest.json')};
}

const BLOCK_BYTES=1024*1024;
function receiveLock(lockFile,{peer,id,sha256}){
 const signature={schema:'ctmesh-receive-lock-v1',host:os.hostname(),peer,id,sha256,pid:process.pid};
 const open=()=>fs.openSync(lockFile,'wx',0o600);
 let fd;
 try{fd=open();}
 catch(error){
  if(error.code!=='EEXIST')throw error;
  const before=fs.lstatSync(lockFile);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>2048)fail('Untrusted receive lock; inspect before retry');
  let old;try{old=JSON.parse(fs.readFileSync(lockFile,'utf8'));}catch{fail('Untrusted receive lock; inspect before retry');}
  if(old?.schema!==signature.schema||old.host!==signature.host||old.peer!==peer||old.id!==id||
    old.sha256!==sha256||!Number.isSafeInteger(old.pid)||old.pid<=0)fail('Untrusted receive lock; inspect before retry');
  let alive=true;
  try{process.kill(old.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
  if(alive)fail('Receive already owned by a live or unverified process');
  const after=fs.lstatSync(lockFile);
  if(after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeMs!==before.mtimeMs)
    fail('Receive lock changed during stale-owner verification');
  fs.unlinkSync(lockFile); // Only an exact owned lock with a confirmed dead PID.
  fd=open(); // Exclusive; another concurrent reclaimer wins cleanly.
 }
 try{
  fs.writeFileSync(fd,JSON.stringify(signature)+'\n');
  fs.fsyncSync(fd);
 }catch(e){fs.closeSync(fd);throw e;}
 const owned=fs.fstatSync(fd);
 return ()=>{
  try{
   let current;try{current=fs.lstatSync(lockFile);}catch(e){if(e.code!=='ENOENT')throw e;}
   if(current&&current.dev===owned.dev&&current.ino===owned.ino&&!current.isSymbolicLink())
     fs.unlinkSync(lockFile);
  }finally{fs.closeSync(fd);}
 };
}
function copyVerifiedPartial(source,part,bytes){
 const flags=fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0);
 const sourceFd=fs.openSync(source,flags);
 let partFd,oldBytes=0;
 try{
  if(fs.existsSync(part)){
   const st=fs.lstatSync(part);
   if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>bytes)
     fail('Untrusted or oversized partial; overwrite forbidden');
   oldBytes=st.size;
   partFd=fs.openSync(part,'r+');
   const now=fs.fstatSync(partFd);
   if(now.dev!==st.dev||now.ino!==st.ino||now.size!==st.size)
     fail('Partial changed before safe resume');
  }else partFd=fs.openSync(part,'wx',0o600);
  const from=Buffer.allocUnsafe(BLOCK_BYTES),existing=Buffer.allocUnsafe(BLOCK_BYTES);
  for(let offset=0;offset<oldBytes;){
   const length=Math.min(BLOCK_BYTES,oldBytes-offset);
   if(fs.readSync(sourceFd,from,0,length,offset)!==length ||
      fs.readSync(partFd,existing,0,length,offset)!==length ||
      !from.subarray(0,length).equals(existing.subarray(0,length)))
       fail('Partial prefix failed source verification; retained for inspection');
   offset+=length;
  }
  for(let offset=oldBytes;offset<bytes;){
   const wanted=Math.min(BLOCK_BYTES,bytes-offset),read=fs.readSync(sourceFd,from,0,wanted,offset);
   if(read<=0)fail('Incoming source changed during partial copy');
   let written=0;
   while(written<read){
    const n=fs.writeSync(partFd,from,written,read-written,offset+written);
    if(n<=0)fail('Incomplete local write');
    written+=n;
   }
   offset+=read;
  }
  fs.fsyncSync(partFd);
 }finally{
  if(partFd!==undefined)fs.closeSync(partFd);
  fs.closeSync(sourceFd);
 }
 return oldBytes;
}

function checkIncoming(peer,self,id){
 const p=transferPaths(peer,self,id);
 if(!fs.existsSync(p.payload)||!fs.existsSync(p.manifest))fail('Transfer is pending');
 const m=JSON.parse(fs.readFileSync(p.manifest,'utf8'));
 if(m.schema!=='ctmesh-v1'||m.id!==id||m.from!==peer||m.to!==self)fail('Identity mismatch');
 if(typeof m.name!=='string'||m.name!==path.basename(m.name)||/[\\/:*?"<>|\x00-\x1f]/.test(m.name)||m.name==='.'||m.name==='..')fail('Unsafe filename');
 if(!Number.isSafeInteger(m.bytes)||m.bytes<0||!(/^[0-9a-f]{64}$/.test(m.sha256)))fail('Invalid metadata');
 const stat=fs.lstatSync(p.payload);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==m.bytes||hash(p.payload)!==m.sha256)fail('SHA256/size mismatch');
 return {m,p};
}
try{
 assertUnredirectedRoot();
 assertManagedEntry(path.join(root,'node.json'),false);
 const self=JSON.parse(fs.readFileSync(path.join(root,'node.json'),'utf8')).alias;
 if(!validAlias.test(self))fail('Unrecognized local device');
 if(cmd==='info'){json({schema:'ctmesh-v1',device:self,transport:'Syncthing 2.1.6',root});}
 else{
   const peer=arg('peer');if(!peer)fail('Provide --peer');
   if(cmd==='send'){
     const filename=arg('path');if(!filename)fail('Provide --path');
     const file=path.resolve(filename),st=fs.lstatSync(file),name=path.basename(file);
     if(!st.isFile()||st.isSymbolicLink()||/[\\/:*?"<>|\x00-\x1f]/.test(name))fail('Unsafe source');
     const id=arg('id',crypto.randomUUID()),p=transferPaths(peer,self,id);
     assertManagedStaging(peer,id);
     fs.mkdirSync(path.dirname(p.dir),{recursive:true});
     assertManagedTree(peer,id);
     fs.mkdirSync(p.dir); // reject duplicate transfer identifiers
     const staging=path.join(root,'staging',peer);
     fs.mkdirSync(staging,{recursive:true});
     assertManagedStaging(peer,id);
     const temp=path.join(staging,id+'.part');
     fs.copyFileSync(file,temp,fs.constants.COPYFILE_EXCL);
     const after=fs.statSync(file);
     if(after.size!==st.size||after.mtimeMs!==st.mtimeMs)fail('Source changed while copying');
     const sha256=hash(temp);
     fs.renameSync(temp,p.payload); // copy into observed folder only once complete
     const manifest={schema:'ctmesh-v1',id,from:self,to:peer,name,bytes:st.size,sha256,createdAt:new Date().toISOString()};
     fs.writeFileSync(p.manifest,JSON.stringify(manifest)+'\n',{flag:'wx',mode:0o600});
     json({status:'QUEUED',...manifest});
   }else if(cmd==='status'||cmd==='receive'){
     const id=arg('id');if(!id)fail('Provide --id');
     const p=transferPaths(peer,self,id);
     if(cmd==='status'&&(!fs.existsSync(p.payload)||!fs.existsSync(p.manifest))){json({status:'PENDING',id,peer});}
     else{
       const {m}=checkIncoming(peer,self,id);
       if(cmd==='status')json({status:'RECEIVED_HASH_VERIFIED',...m});
       else{
         const dest=path.resolve(arg('dest',path.join(root,'received')));
         fs.mkdirSync(dest,{recursive:true});
         const target=path.join(dest,m.name);
         if(fs.existsSync(target))fail('Destination exists; overwrite forbidden');
         const part=path.join(dest,'.ctmesh-'+id+'.part');
         const lock=path.join(dest,'.ctmesh-'+id+'.lock');
         const release=receiveLock(lock,{peer,id,sha256:m.sha256});
         let resumedBytes=0;
         try{
           if(fs.existsSync(target))fail('Destination exists; overwrite forbidden');
           resumedBytes=copyVerifiedPartial(p.payload,part,m.bytes);
           // Re-hash source after copy; Syncthing may have changed incoming bytes.
           if(fs.statSync(part).size!==m.bytes||hash(part)!==m.sha256||
             fs.statSync(p.payload).size!==m.bytes||hash(p.payload)!==m.sha256)
               fail('Temporary destination failed verification');
           fs.linkSync(part,target); // atomic and target-exclusive on NTFS/ext4
           fs.unlinkSync(part);
           if(hash(target)!==m.sha256)fail('Final verification failed');
         }finally{release();}
         json({status:'DELIVERED_HASH_VERIFIED',id,path:target,bytes:m.bytes,sha256:m.sha256,
           resumedBytes});
       }
     }
   }else fail('Valid commands: info | send --peer DEVICE --path FILE | status/receive --peer DEVICE --id TRANSFER [--dest DIR]');
 }
}catch(e){process.stderr.write('CTMESH_ERROR: '+e.message+'\n');process.exitCode=1;}
