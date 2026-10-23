#!/usr/bin/env node
// CT Mesh pilot CLI - the transfer transport is the official Syncthing daemon.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
// Deployed Pilot can be copied to a standalone transfer.mjs without the repo's
// src/ directory. Preserve the root ancestor preflight inside this CLI.
function assertUnredirectedDirectoryAncestors(input,code='MANAGED_PATH_UNSAFE'){
 if(typeof input!=='string'||!path.isAbsolute(input))throw Error(code);
 const normalized=path.normalize(input);
 // An absolute Windows path may still refer to a network or device namespace.
 // Operator state must be on a local drive, not a UNC/device namespace.
 if(process.platform==='win32'&&!/^[A-Za-z]:[\\/]/.test(normalized))throw Error(code);
 const anchor=path.parse(normalized).root;
 let cur=anchor;
 let verifiedRoot;
 for(const part of path.relative(anchor,normalized).split(path.sep)){
  if(!part||part==='.')continue;
  cur=path.join(cur,part);
  try{
   const st=fs.lstatSync(cur);
   if(st.isSymbolicLink()||!st.isDirectory())throw Error(code);
   if(cur===normalized)verifiedRoot=st;
  }catch(e){if(e.code==='ENOENT')continue;throw Error(code);}
 }
 // Require the owner-selected POSIX transfer root to be private before
 // any peer identity, journal or payload access. Windows ACL validation is
 // separate and cannot be inferred from POSIX uid/mode fields.
 if(process.platform!=='win32'&&typeof process.getuid==='function'){
  // Reuse the already validated final ancestor stat; avoid a second lookup.
  if(!verifiedRoot||verifiedRoot.uid!==process.getuid()||
     (verifiedRoot.mode&0o077)!==0)
   throw Error(code);
 }
}
// Protect new staged directories independent of the invoking shell umask.
process.umask(0o077);
const root=path.resolve(process.env.COMMANDER_TRANSFER_HOME || (process.platform==='win32'
 ?path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'CommanderTransferPilot')
 :path.join(os.homedir(),'.local','share','commander-transfer-pilot')));
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
// On Linux, pin each managed ancestor by directory fd. The final component
// is then accessed relative to the held parent via procfs, even if a peer
// renames its apparent directory pathname after managed-tree preflight.
// The Windows trust boundary instead depends on its protected root NTFS ACL;
// ordinary Node path APIs cannot provide NtCreateFile handle-relative semantics.
function withLinuxPinnedManagedPath(file,read){
 if(process.platform!=='linux')return read(file);
 const rel=path.relative(root,file);
 if(rel===''||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))
  return read(file); // Operator's explicit external source/destination.
 const parts=rel.split(path.sep);
 if(parts.some(p=>!p||p==='.'||p==='..'))fail('UNTRUSTED_MANAGED_ANCESTOR');
 const flags=fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW;
 const fds=[];
 try{
  const rootBefore=fs.lstatSync(root);
  if(!rootBefore.isDirectory()||rootBefore.isSymbolicLink())
   fail('UNTRUSTED_MANAGED_ANCESTOR');
  const rootFd=fs.openSync(root,flags);
  fds.push(rootFd);
  const rootOpened=fs.fstatSync(rootFd),rootNamed=fs.lstatSync(root);
  if(!rootOpened.isDirectory()||
     rootOpened.dev!==rootBefore.dev||rootOpened.ino!==rootBefore.ino||
     rootNamed.dev!==rootOpened.dev||rootNamed.ino!==rootOpened.ino||
     rootNamed.isSymbolicLink()||
     (typeof process.getuid==='function'&&
      (rootOpened.uid!==process.getuid()||(rootOpened.mode&0o077)!==0)))
   fail('UNTRUSTED_MANAGED_ANCESTOR');
  for(const part of parts.slice(0,-1)){
   let next;
   try{next=fs.openSync('/proc/self/fd/'+fds.at(-1)+'/'+part,flags);}
   catch(e){
    if(['ENOTDIR','ELOOP','ENOENT'].includes(e.code))
     fail('UNTRUSTED_MANAGED_ANCESTOR');
    throw e;
   }
   fds.push(next);
   if(!fs.fstatSync(next).isDirectory())fail('UNTRUSTED_MANAGED_ANCESTOR');
  }
  return read('/proc/self/fd/'+fds.at(-1)+'/'+parts.at(-1));
 }finally{for(let n=fds.length-1;n>=0;n--)fs.closeSync(fds[n]);}
}
// A same-digest symlink is still an untrusted source: bind each hash to the
// regular file actually opened, rejecting a swapped final path component.
// This protects the final component on O_NOFOLLOW platforms; a separate
// protected parent directory is still required to exclude ancestor races.
function hash(file){
 return withLinuxPinnedManagedPath(file,name=>hashVerifiedName(name));
}
function hashVerifiedName(file){
 const unsafe=()=>fail('Untrusted hashed file');
 const before=fs.lstatSync(file);
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)unsafe();
 const flags=fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0)|(fs.constants.O_NONBLOCK??0);
 const fd=fs.openSync(file,flags);
 try{
  const opened=fs.fstatSync(fd),named=fs.lstatSync(file);
  const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size;
  if(!opened.isFile()||opened.nlink!==1||
     !named.isFile()||named.isSymbolicLink()||named.nlink!==1||
     !same(before,opened)||!same(opened,named))unsafe();
  const h=crypto.createHash('sha256'),buf=Buffer.allocUnsafe(1048576);
  for(;;){
   const n=fs.readSync(fd,buf,0,buf.length,null);
   if(!n)break;
   h.update(buf.subarray(0,n));
  }
  const after=fs.fstatSync(fd),namedAfter=fs.lstatSync(file);
  if(!after.isFile()||after.nlink!==1||!namedAfter.isFile()||
     namedAfter.isSymbolicLink()||namedAfter.nlink!==1||
     !same(opened,after)||!same(opened,namedAfter)||
     after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs||
     namedAfter.mtimeMs!==opened.mtimeMs||namedAfter.ctimeMs!==opened.ctimeMs)unsafe();
  return h.digest('hex');
 }finally{fs.closeSync(fd);}
}
function transferPaths(peer,self,id){
 if(!validAlias.test(peer)||peer===self)fail('Unknown or self peer');
 if(!validId.test(id))fail('Invalid transfer ID');
 assertManagedTree(peer,id);
 const dir=path.join(root,'pairs',peer,'transfers',id);
 return {dir,payload:path.join(dir,'payload.bin'),manifest:path.join(dir,'manifest.json')};
}

const BLOCK_BYTES=1024*1024;
// A stale lock may be replaced between lstat and read. Bind the JSON read to
// the checked file descriptor, not to a second pathname lookup.

const WIN_DEST_PIN_SCRIPT_B64='IwAgAE4AYQB0AGkAdgBlACAAVwBpAG4AZABvAHcAcwAgAHIAZQBjAGUAaQB2AGUAIABkAGUAcwB0AGkAbgBhAHQAaQBvAG4AIABnAHUAYQByAGQALgAgAEUAbQBiAGUAZABkAGUAZAAgAGkAbgAgAHMAdABhAG4AZABhAGwAbwBuAGUAIABQAGkAbABvAHQALgAKACMAIABFAGEAYwBoACAAZABpAHIAZQBjAHQAbwByAHkAIABjAG8AbQBwAG8AbgBlAG4AdAAgAG8AcABlAG4AcwAgAHIAZQBsAGEAdABpAHYAZQAgAHQAbwAgAGkAdABzACAASABFAEwARAAgAHAAYQByAGUAbgB0ACAATgBUACAAaABhAG4AZABsAGUALAAgAG4AbwB0ACAAdgBpAGEACgAjACAAZgByAGUAcwBoACAAYQBiAHMAbwBsAHUAdABlACAAcABhAHQAaABuAGEAbQBlACAAbABvAG8AawB1AHAALgAgAE4AbwAgAGgAYQBuAGQAbABlACAAcwBoAGEAcgBlAHMAIABkAGUAbABlAHQAZQAvAHIAZQBuAGEAbQBlACAAYQBjAGMAZQBzAHMALgAKACQARQByAHIAbwByAEEAYwB0AGkAbwBuAFAAcgBlAGYAZQByAGUAbgBjAGUAPQAnAFMAdABvAHAAJwAKAEEAZABkAC0AVAB5AHAAZQAgAC0AVAB5AHAAZQBEAGUAZgBpAG4AaQB0AGkAbwBuACAAQAAnAAoAdQBzAGkAbgBnACAAUwB5AHMAdABlAG0AOwAKAHUAcwBpAG4AZwAgAFMAeQBzAHQAZQBtAC4AQwBvAGwAbABlAGMAdABpAG8AbgBzAC4ARwBlAG4AZQByAGkAYwA7AAoAdQBzAGkAbgBnACAAUwB5AHMAdABlAG0ALgBJAE8AOwAKAHUAcwBpAG4AZwAgAFMAeQBzAHQAZQBtAC4AUgB1AG4AdABpAG0AZQAuAEkAbgB0AGUAcgBvAHAAUwBlAHIAdgBpAGMAZQBzADsACgB1AHMAaQBuAGcAIABNAGkAYwByAG8AcwBvAGYAdAAuAFcAaQBuADMAMgAuAFMAYQBmAGUASABhAG4AZABsAGUAcwA7AAoAcAB1AGIAbABpAGMAIABzAHQAYQB0AGkAYwAgAGMAbABhAHMAcwAgAEMAdABNAGUAcwBoAFcAaQBuAEQAaQByAGUAYwB0AG8AcgB5AEcAdQBhAHIAZAAgAHsACgAgAFsAUwB0AHIAdQBjAHQATABhAHkAbwB1AHQAKABMAGEAeQBvAHUAdABLAGkAbgBkAC4AUwBlAHEAdQBlAG4AdABpAGEAbAApAF0AIABzAHQAcgB1AGMAdAAgAFUAbgBpAGMAbwBkAGUAUwB0AHIAaQBuAGcAIAB7AAoAIAAgAHAAdQBiAGwAaQBjACAAdQBzAGgAbwByAHQAIABMAGUAbgBnAHQAaAAsACAATQBhAHgAaQBtAHUAbQBMAGUAbgBnAHQAaAA7ACAAcAB1AGIAbABpAGMAIABJAG4AdABQAHQAcgAgAEIAdQBmAGYAZQByADsACgAgAH0ACgAgAFsAUwB0AHIAdQBjAHQATABhAHkAbwB1AHQAKABMAGEAeQBvAHUAdABLAGkAbgBkAC4AUwBlAHEAdQBlAG4AdABpAGEAbAApAF0AIABzAHQAcgB1AGMAdAAgAE8AYgBqAGUAYwB0AEEAdAB0AHIAaQBiAHUAdABlAHMAIAB7AAoAIAAgAHAAdQBiAGwAaQBjACAAdQBpAG4AdAAgAEwAZQBuAGcAdABoADsAIABwAHUAYgBsAGkAYwAgAEkAbgB0AFAAdAByACAAUgBvAG8AdABEAGkAcgBlAGMAdABvAHIAeQAsAE8AYgBqAGUAYwB0AE4AYQBtAGUAOwAKACAAIABwAHUAYgBsAGkAYwAgAHUAaQBuAHQAIABBAHQAdAByAGkAYgB1AHQAZQBzADsAIABwAHUAYgBsAGkAYwAgAEkAbgB0AFAAdAByACAAUwBlAGMAdQByAGkAdAB5AEQAZQBzAGMAcgBpAHAAdABvAHIALABTAGUAYwB1AHIAaQB0AHkAUQB1AGEAbABpAHQAeQBPAGYAUwBlAHIAdgBpAGMAZQA7AAoAIAB9AAoAIABbAFMAdAByAHUAYwB0AEwAYQB5AG8AdQB0ACgATABhAHkAbwB1AHQASwBpAG4AZAAuAFMAZQBxAHUAZQBuAHQAaQBhAGwAKQBdACAAcwB0AHIAdQBjAHQAIABJAG8AUwB0AGEAdAB1AHMAIAB7AHAAdQBiAGwAaQBjACAASQBuAHQAUAB0AHIAIABTAHQAYQB0AHUAcwAsAEkAbgBmAG8AcgBtAGEAdABpAG8AbgA7AH0ACgAgAFsAUwB0AHIAdQBjAHQATABhAHkAbwB1AHQAKABMAGEAeQBvAHUAdABLAGkAbgBkAC4AUwBlAHEAdQBlAG4AdABpAGEAbAApAF0AIABzAHQAcgB1AGMAdAAgAFQAYQBnAEkAbgBmAG8AIAB7AHAAdQBiAGwAaQBjACAAdQBpAG4AdAAgAEEAdAB0AHIAaQBiAHUAdABlAHMALAAgAFIAZQBwAGEAcgBzAGUAVABhAGcAOwB9AAoAIABbAEQAbABsAEkAbQBwAG8AcgB0ACgAIgBrAGUAcgBuAGUAbAAzADIALgBkAGwAbAAiACwAQwBoAGEAcgBTAGUAdAA9AEMAaABhAHIAUwBlAHQALgBVAG4AaQBjAG8AZABlACwAUwBlAHQATABhAHMAdABFAHIAcgBvAHIAPQB0AHIAdQBlACwARQBuAHQAcgB5AFAAbwBpAG4AdAA9ACIAQwByAGUAYQB0AGUARgBpAGwAZQBXACIAKQBdAAoAIABzAHQAYQB0AGkAYwAgAGUAeAB0AGUAcgBuACAAUwBhAGYAZQBGAGkAbABlAEgAYQBuAGQAbABlACAAQwByAGUAYQB0AGUARgBpAGwAZQBXACgAcwB0AHIAaQBuAGcAIABwAGEAdABoACwAdQBpAG4AdAAgAGEAYwBjAGUAcwBzACwAdQBpAG4AdAAgAHMAaABhAHIAZQAsAAoAIAAgACAASQBuAHQAUAB0AHIAIABzAGUAYwB1AHIAaQB0AHkALAB1AGkAbgB0ACAAZABpAHMAcABvAHMAaQB0AGkAbwBuACwAdQBpAG4AdAAgAGYAbABhAGcAcwAsAEkAbgB0AFAAdAByACAAdABlAG0AcABsAGEAdABlACkAOwAKACAAWwBEAGwAbABJAG0AcABvAHIAdAAoACIAbgB0AGQAbABsAC4AZABsAGwAIgAsAEUAeABhAGMAdABTAHAAZQBsAGwAaQBuAGcAPQB0AHIAdQBlACkAXQAKACAAcwB0AGEAdABpAGMAIABlAHgAdABlAHIAbgAgAGkAbgB0ACAATgB0AEMAcgBlAGEAdABlAEYAaQBsAGUAKABvAHUAdAAgAFMAYQBmAGUARgBpAGwAZQBIAGEAbgBkAGwAZQAgAGgAYQBuAGQAbABlACwAdQBpAG4AdAAgAGEAYwBjAGUAcwBzACwACgAgACAAIAByAGUAZgAgAE8AYgBqAGUAYwB0AEEAdAB0AHIAaQBiAHUAdABlAHMAIABhAHQAdAByAHMALABvAHUAdAAgAEkAbwBTAHQAYQB0AHUAcwAgAHMAdABhAHQAdQBzACwASQBuAHQAUAB0AHIAIABhAGwAbABvAGMAYQB0AGkAbwBuACwACgAgACAAIAB1AGkAbgB0ACAAZgBpAGwAZQBBAHQAdAByAGkAYgB1AHQAZQBzACwAdQBpAG4AdAAgAHMAaABhAHIAZQAsAHUAaQBuAHQAIABkAGkAcwBwAG8AcwBpAHQAaQBvAG4ALAB1AGkAbgB0ACAAbwBwAHQAaQBvAG4AcwAsAEkAbgB0AFAAdAByACAAZQBhACwAdQBpAG4AdAAgAGUAYQBMAGUAbgBnAHQAaAApADsACgAgAFsARABsAGwASQBtAHAAbwByAHQAKAAiAGsAZQByAG4AZQBsADMAMgAuAGQAbABsACIALABTAGUAdABMAGEAcwB0AEUAcgByAG8AcgA9AHQAcgB1AGUAKQBdAAoAIABzAHQAYQB0AGkAYwAgAGUAeAB0AGUAcgBuACAAYgBvAG8AbAAgAEcAZQB0AEYAaQBsAGUASQBuAGYAbwByAG0AYQB0AGkAbwBuAEIAeQBIAGEAbgBkAGwAZQBFAHgAKABTAGEAZgBlAEYAaQBsAGUASABhAG4AZABsAGUAIABoAGEAbgBkAGwAZQAsAAoAIAAgACAAaQBuAHQAIABpAG4AZgBvAEMAbABhAHMAcwAsAG8AdQB0ACAAVABhAGcASQBuAGYAbwAgAGkAbgBmAG8ALAB1AGkAbgB0ACAAbABlAG4AZwB0AGgAKQA7AAoAIABzAHQAYQB0AGkAYwAgAHYAbwBpAGQAIABDAGgAZQBjAGsAKABTAGEAZgBlAEYAaQBsAGUASABhAG4AZABsAGUAIABoACkAIAB7AAoAIAAgAGkAZgAoAGgALgBJAHMASQBuAHYAYQBsAGkAZAAgAHwAfAAgACEARwBlAHQARgBpAGwAZQBJAG4AZgBvAHIAbQBhAHQAaQBvAG4AQgB5AEgAYQBuAGQAbABlAEUAeAAoAGgALAA5ACwAbwB1AHQAIABUAGEAZwBJAG4AZgBvACAAaQBuAGYAbwAsAAoAIAAgACAAIAAgACAAKAB1AGkAbgB0ACkATQBhAHIAcwBoAGEAbAAuAFMAaQB6AGUATwBmADwAVABhAGcASQBuAGYAbwA+ACgAKQApACAAfAB8AAoAIAAgACAAIAAgACgAaQBuAGYAbwAuAEEAdAB0AHIAaQBiAHUAdABlAHMAIAAmACAAMAB4ADQAMQAwACkAIAAhAD0AIAAwAHgAMQAwACkACgAgACAAIAAgACAAdABoAHIAbwB3ACAAbgBlAHcAIABJAE8ARQB4AGMAZQBwAHQAaQBvAG4AKAAiAEQARQBTAFQASQBOAEEAVABJAE8ATgBfAEQASQBSAEUAQwBUAE8AUgBZAF8AVQBOAFQAUgBVAFMAVABFAEQAIgApADsACgAgAH0ACgAgAHMAdABhAHQAaQBjACAAUwBhAGYAZQBGAGkAbABlAEgAYQBuAGQAbABlACAAQwBoAGkAbABkACgAUwBhAGYAZQBGAGkAbABlAEgAYQBuAGQAbABlACAAcABhAHIAZQBuAHQALABzAHQAcgBpAG4AZwAgAGMAbwBtAHAAbwBuAGUAbgB0ACkAewAKACAAIABpAGYAKABTAHQAcgBpAG4AZwAuAEkAcwBOAHUAbABsAE8AcgBXAGgAaQB0AGUAUwBwAGEAYwBlACgAYwBvAG0AcABvAG4AZQBuAHQAKQB8AHwAYwBvAG0AcABvAG4AZQBuAHQAPQA9ACIALgAiAHwAfABjAG8AbQBwAG8AbgBlAG4AdAA9AD0AIgAuAC4AIgB8AHwACgAgACAAIAAgACAAYwBvAG0AcABvAG4AZQBuAHQALgBJAG4AZABlAHgATwBmAEEAbgB5ACgAbgBlAHcAWwBdAHsAJwBcAFwAJwAsACcALwAnACwAJwA6ACcAfQApAD4APQAwACkACgAgACAAIAAgACAAdABoAHIAbwB3ACAAbgBlAHcAIABJAE8ARQB4AGMAZQBwAHQAaQBvAG4AKAAiAEkATgBWAEEATABJAEQAXwBEAEUAUwBUAEkATgBBAFQASQBPAE4AXwBDAE8ATQBQAE8ATgBFAE4AVAAiACkAOwAKACAAIABJAG4AdABQAHQAcgAgAHMAdAByAD0ASQBuAHQAUAB0AHIALgBaAGUAcgBvACwAIABuAGEAbQBlAD0ASQBuAHQAUAB0AHIALgBaAGUAcgBvADsACgAgACAAdAByAHkAewAKACAAIAAgAHMAdAByAD0ATQBhAHIAcwBoAGEAbAAuAFMAdAByAGkAbgBnAFQAbwBIAEcAbABvAGIAYQBsAFUAbgBpACgAYwBvAG0AcABvAG4AZQBuAHQAKQA7AAoAIAAgACAAdgBhAHIAIAB1AHMAPQBuAGUAdwAgAFUAbgBpAGMAbwBkAGUAUwB0AHIAaQBuAGcAIAB7AAoAIAAgACAAIABMAGUAbgBnAHQAaAA9AGMAaABlAGMAawBlAGQAKAAoAHUAcwBoAG8AcgB0ACkAKABjAG8AbQBwAG8AbgBlAG4AdAAuAEwAZQBuAGcAdABoACoAMgApACkALAAKACAAIAAgACAATQBhAHgAaQBtAHUAbQBMAGUAbgBnAHQAaAA9AGMAaABlAGMAawBlAGQAKAAoAHUAcwBoAG8AcgB0ACkAKAAoAGMAbwBtAHAAbwBuAGUAbgB0AC4ATABlAG4AZwB0AGgAKwAxACkAKgAyACkAKQAsAAoAIAAgACAAIABCAHUAZgBmAGUAcgA9AHMAdAByAAoAIAAgACAAfQA7AAoAIAAgACAAbgBhAG0AZQA9AE0AYQByAHMAaABhAGwALgBBAGwAbABvAGMASABHAGwAbwBiAGEAbAAoAE0AYQByAHMAaABhAGwALgBTAGkAegBlAE8AZgA8AFUAbgBpAGMAbwBkAGUAUwB0AHIAaQBuAGcAPgAoACkAKQA7AAoAIAAgACAATQBhAHIAcwBoAGEAbAAuAFMAdAByAHUAYwB0AHUAcgBlAFQAbwBQAHQAcgAoAHUAcwAsAG4AYQBtAGUALABmAGEAbABzAGUAKQA7AAoAIAAgACAAdgBhAHIAIABhAHQAdAByAGkAYgB1AHQAZQBzAD0AbgBlAHcAIABPAGIAagBlAGMAdABBAHQAdAByAGkAYgB1AHQAZQBzAHsACgAgACAAIAAgAEwAZQBuAGcAdABoAD0AKAB1AGkAbgB0ACkATQBhAHIAcwBoAGEAbAAuAFMAaQB6AGUATwBmADwATwBiAGoAZQBjAHQAQQB0AHQAcgBpAGIAdQB0AGUAcwA+ACgAKQAsAAoAIAAgACAAIABSAG8AbwB0AEQAaQByAGUAYwB0AG8AcgB5AD0AcABhAHIAZQBuAHQALgBEAGEAbgBnAGUAcgBvAHUAcwBHAGUAdABIAGEAbgBkAGwAZQAoACkALABPAGIAagBlAGMAdABOAGEAbQBlAD0AbgBhAG0AZQAsAEEAdAB0AHIAaQBiAHUAdABlAHMAPQAwAHgANAAwAAoAIAAgACAAfQA7AAoAIAAgACAALwAvACAARgBJAEwARQBfAFQAUgBBAFYARQBSAFMARQB8AEYASQBMAEUAXwBSAEUAQQBEAF8AQQBUAFQAUgBJAEIAVQBUAEUAUwB8AFMAWQBOAEMASABSAE8ATgBJAFoARQA7ACAAcwBoAGEAcgBlACAAcgBlAGEAZAAvAHcAcgBpAHQAZQAgAG8AbgBsAHkALgAKACAAIAAgAC8ALwAgAEYASQBMAEUAXwBEAEkAUgBFAEMAVABPAFIAWQBfAEYASQBMAEUAfABGAEkATABFAF8ATwBQAEUATgBfAFIARQBQAEEAUgBTAEUAXwBQAE8ASQBOAFQAfABGAEkATABFAF8AUwBZAE4AQwBIAFIATwBOAE8AVQBTAF8ASQBPAF8ATgBPAE4AQQBMAEUAUgBUAC4ACgAgACAAIABpAG4AdAAgAHIAZQBzAHUAbAB0AD0ATgB0AEMAcgBlAGEAdABlAEYAaQBsAGUAKABvAHUAdAAgAFMAYQBmAGUARgBpAGwAZQBIAGEAbgBkAGwAZQAgAGgALAAwAHgAMQAwADAAMABBADAALAAKACAAIAAgACAAIAAgAHIAZQBmACAAYQB0AHQAcgBpAGIAdQB0AGUAcwAsAG8AdQB0ACAAXwAsAEkAbgB0AFAAdAByAC4AWgBlAHIAbwAsADAALAAzACwAMQAsADAAeAAyADAAMAAwADIAMQAsAEkAbgB0AFAAdAByAC4AWgBlAHIAbwAsADAAKQA7AAoAIAAgACAAaQBmACgAcgBlAHMAdQBsAHQAPAAwACkAewBoAD8ALgBEAGkAcwBwAG8AcwBlACgAKQA7AHQAaAByAG8AdwAgAG4AZQB3ACAASQBPAEUAeABjAGUAcAB0AGkAbwBuACgAIgBEAEUAUwBUAEkATgBBAFQASQBPAE4AXwBOAEEAVABJAFYARQBfAE8AUABFAE4AXwBGAEEASQBMAEUARAAiACkAOwB9AAoAIAAgACAAdAByAHkAewBDAGgAZQBjAGsAKABoACkAOwByAGUAdAB1AHIAbgAgAGgAOwB9AGMAYQB0AGMAaAB7AGgALgBEAGkAcwBwAG8AcwBlACgAKQA7AHQAaAByAG8AdwA7AH0ACgAgACAAfQBmAGkAbgBhAGwAbAB5AHsACgAgACAAIABpAGYAKABuAGEAbQBlACEAPQBJAG4AdABQAHQAcgAuAFoAZQByAG8AKQBNAGEAcgBzAGgAYQBsAC4ARgByAGUAZQBIAEcAbABvAGIAYQBsACgAbgBhAG0AZQApADsACgAgACAAIABpAGYAKABzAHQAcgAhAD0ASQBuAHQAUAB0AHIALgBaAGUAcgBvACkATQBhAHIAcwBoAGEAbAAuAEYAcgBlAGUASABHAGwAbwBiAGEAbAAoAHMAdAByACkAOwAKACAAIAB9AAoAIAB9AAoAIABwAHUAYgBsAGkAYwAgAHMAdABhAHQAaQBjACAATABpAHMAdAA8AFMAYQBmAGUARgBpAGwAZQBIAGEAbgBkAGwAZQA+ACAAUABpAG4AKABzAHQAcgBpAG4AZwAgAGwAbwBjAGEAdABpAG8AbgApAHsACgAgACAAaQBmACgAUwB0AHIAaQBuAGcALgBJAHMATgB1AGwAbABPAHIAVwBoAGkAdABlAFMAcABhAGMAZQAoAGwAbwBjAGEAdABpAG8AbgApAHwAfABsAG8AYwBhAHQAaQBvAG4ALgBMAGUAbgBnAHQAaAA8ADMAfAB8AAoAIAAgACAAIAAgACAAIQBDAGgAYQByAC4ASQBzAEwAZQB0AHQAZQByACgAbABvAGMAYQB0AGkAbwBuAFsAMABdACkAfAB8AGwAbwBjAGEAdABpAG8AbgBbADEAXQAhAD0AJwA6ACcAfAB8AAoAIAAgACAAIAAgACAAKABsAG8AYwBhAHQAaQBvAG4AWwAyAF0AIQA9ACcAXABcACcAJgAmAGwAbwBjAGEAdABpAG8AbgBbADIAXQAhAD0AJwAvACcAKQB8AHwAbABvAGMAYQB0AGkAbwBuAC4AUwB0AGEAcgB0AHMAVwBpAHQAaAAoAEAAIgBcAFwAIgApACkACgAgACAAIAAgACAAIAB0AGgAcgBvAHcAIABuAGUAdwAgAEkATwBFAHgAYwBlAHAAdABpAG8AbgAoACIATABPAEMAQQBMAF8ARABSAEkAVgBFAF8ARABFAFMAVABJAE4AQQBUAEkATwBOAF8AUgBFAFEAVQBJAFIARQBEACIAKQA7AAoAIAAgAHMAdAByAGkAbgBnACAAZgB1AGwAbAA9AFAAYQB0AGgALgBHAGUAdABGAHUAbABsAFAAYQB0AGgAKABsAG8AYwBhAHQAaQBvAG4AKQA7AAoAIAAgAHYAYQByACAAaABhAG4AZABsAGUAcwA9AG4AZQB3ACAATABpAHMAdAA8AFMAYQBmAGUARgBpAGwAZQBIAGEAbgBkAGwAZQA+ACgAKQA7AAoAIAAgAHQAcgB5AHsACgAgACAAIAB2AGEAcgAgAGQAcgBpAHYAZQA9AEMAcgBlAGEAdABlAEYAaQBsAGUAVwAoAGYAdQBsAGwALgBTAHUAYgBzAHQAcgBpAG4AZwAoADAALAAyACkAKwBAACIAXAAiACwAMAB4ADEAMAAwADAAQQAwACwAMwAsAAoAIAAgACAAIAAgAEkAbgB0AFAAdAByAC4AWgBlAHIAbwAsADMALAAwAHgAMAAyADIAMAAwADAAMAAwACwASQBuAHQAUAB0AHIALgBaAGUAcgBvACkAOwAKACAAIAAgAGgAYQBuAGQAbABlAHMALgBBAGQAZAAoAGQAcgBpAHYAZQApADsAQwBoAGUAYwBrACgAZAByAGkAdgBlACkAOwAKACAAIAAgAHYAYQByACAAcABhAHIAZQBuAHQAPQBkAHIAaQB2AGUAOwAKACAAIAAgAGYAbwByAGUAYQBjAGgAKAB2AGEAcgAgAGMAbwBtAHAAbwBuAGUAbgB0ACAAaQBuACAAZgB1AGwAbAAuAFMAdQBiAHMAdAByAGkAbgBnACgAMwApAC4AUwBwAGwAaQB0ACgAbgBlAHcAWwBdAHsAJwBcAFwAJwAsACcALwAnAH0ALAAKACAAIAAgACAAIAAgAFMAdAByAGkAbgBnAFMAcABsAGkAdABPAHAAdABpAG8AbgBzAC4AUgBlAG0AbwB2AGUARQBtAHAAdAB5AEUAbgB0AHIAaQBlAHMAKQApAHsACgAgACAAIAAgAHYAYQByACAAbgBlAHgAdAA9AEMAaABpAGwAZAAoAHAAYQByAGUAbgB0ACwAYwBvAG0AcABvAG4AZQBuAHQAKQA7AAoAIAAgACAAIABoAGEAbgBkAGwAZQBzAC4AQQBkAGQAKABuAGUAeAB0ACkAOwBwAGEAcgBlAG4AdAA9AG4AZQB4AHQAOwAKACAAIAAgAH0ACgAgACAAIAByAGUAdAB1AHIAbgAgAGgAYQBuAGQAbABlAHMAOwAKACAAIAB9AGMAYQB0AGMAaAB7AGYAbwByAGUAYQBjAGgAKAB2AGEAcgAgAGgAIABpAG4AIABoAGEAbgBkAGwAZQBzACkAaAAuAEQAaQBzAHAAbwBzAGUAKAApADsAdABoAHIAbwB3ADsAfQAKACAAfQAKAH0ACgAnAEAACgAkAGgAZQBsAGQAPQAkAG4AdQBsAGwACgB0AHIAeQB7AAoAIAAkAGgAZQBsAGQAPQBbAEMAdABNAGUAcwBoAFcAaQBuAEQAaQByAGUAYwB0AG8AcgB5AEcAdQBhAHIAZABdADoAOgBQAGkAbgAoACQAZQBuAHYAOgBDAFQATQBFAFMASABfAFAASQBOAF8ARABFAFMAVAApAAoAIABbAEMAbwBuAHMAbwBsAGUAXQA6ADoATwB1AHQALgBXAHIAaQB0AGUATABpAG4AZQAoACcAQwBUAE0ARQBTAEgAXwBQAEkATgBfAFIARQBBAEQAWQAnACkACgAgAFsAQwBvAG4AcwBvAGwAZQBdADoAOgBPAHUAdAAuAEYAbAB1AHMAaAAoACkACgAgACQAbgB1AGwAbAA9AFsAQwBvAG4AcwBvAGwAZQBdADoAOgBSAGUAYQBkAEwAaQBuAGUAKAApAAoAfQBjAGEAdABjAGgAewAKACAAWwBDAG8AbgBzAG8AbABlAF0AOgA6AEUAcgByAG8AcgAuAFcAcgBpAHQAZQBMAGkAbgBlACgAJwBDAFQATQBFAFMASABfAFAASQBOAF8ARQBSAFIATwBSACcAKQAKACAAZQB4AGkAdAAgADIACgB9AGYAaQBuAGEAbABsAHkAewBpAGYAKAAkAG4AdQBsAGwAIAAtAG4AZQAgACQAaABlAGwAZAApAHsAZgBvAHIAZQBhAGMAaAAoACQAaAAgAGkAbgAgACQAaABlAGwAZAApAHsAJABoAC4ARABpAHMAcABvAHMAZQAoACkAfQB9AH0ACgA=';
// The encoded command is an exact UTF-16LE copy of win-dest-pin.ps1 kept in
// source for human review. A standalone transfer.mjs needs no sibling files.
const expectedDestIdentity=()=>{
 const a=arg('dest-dev'),b=arg('dest-ino');
 if((a===undefined)!==(b===undefined))fail('DESTINATION_IDENTITY_INCOMPLETE');
 if(a===undefined)return null;
 if(!/^(0|[1-9][0-9]*)$/.test(a)||!/^(0|[1-9][0-9]*)$/.test(b))
  fail('DESTINATION_IDENTITY_INVALID');
 return {dev:BigInt(a),ino:BigInt(b)};
};
function verifyDest(file,identity){
 const s=fs.lstatSync(file,{bigint:true});
 if(!s.isDirectory()||s.isSymbolicLink()||
    (identity&&(s.dev!==identity.dev||s.ino!==identity.ino)))fail('DESTINATION_IDENTITY_CHANGED');
}
async function withPinnedDest(dest,identity,fn){
 if(process.platform==='linux'){
  const flags=fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW,fds=[];
  try{
   fds.push(fs.openSync('/',flags));
   for(const part of path.resolve(dest).split(path.sep).filter(Boolean)){
    if(part==='.'||part==='..')fail('DESTINATION_ANCESTOR_REJECTED');
    try{fds.push(fs.openSync('/proc/self/fd/'+fds.at(-1)+'/'+part,flags));}
    catch(e){if(['ELOOP','ENOTDIR','ENOENT'].includes(e.code))fail('DESTINATION_ANCESTOR_REJECTED');throw e;}
   }
   const pinned='/proc/self/fd/'+fds.at(-1);
   // /proc/self/fd/N is a symlink by design; validate the held directory FD,
   // not the procfs link's own lstat type.
   const opened=fs.fstatSync(fds.at(-1),{bigint:true});
   if(!opened.isDirectory()||(identity&&(opened.dev!==identity.dev||opened.ino!==identity.ino)))
    fail('DESTINATION_IDENTITY_CHANGED');
   return await fn(pinned);
  }finally{for(let i=fds.length-1;i>=0;i--)fs.closeSync(fds[i]);}
 }
 if(process.platform!=='win32')fail('DESTINATION_PIN_UNSUPPORTED_PLATFORM');
 const {spawn}=await import('node:child_process');
 const child=spawn('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',WIN_DEST_PIN_SCRIPT_B64],{
  windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,CTMESH_PIN_DEST:dest}
 });
 let ready=false;
 const p=new Promise((resolve,reject)=>{
  let output='',settled=false;
  const timer=setTimeout(()=>finish(new Error('DESTINATION_PIN_TIMEOUT')),12000);
  function finish(e){if(settled)return;settled=true;clearTimeout(timer);if(e)reject(e);else resolve();}
  child.on('error',()=>finish(new Error('DESTINATION_PIN_UNAVAILABLE')));
  child.on('exit',()=>{if(!ready)finish(new Error('DESTINATION_PIN_FAILED'));});
  child.stdout.on('data',b=>{
   output+=b.toString('utf8');
   if(output.length>2048){finish(new Error('DESTINATION_PIN_OUTPUT_INVALID'));return;}
   if(output.includes('CTMESH_PIN_READY')){ready=true;finish();}
  });
 });
 try{
  await p;
  verifyDest(dest,identity);
  return await fn(dest);
 }finally{
  child.stdin.end('\n');
  if(!ready)child.kill();
  await new Promise(resolve=>{
   if(child.exitCode!==null||child.signalCode!==null)return resolve();
   const timer=setTimeout(()=>{child.kill();resolve();},3000);
   child.once('exit',()=>{clearTimeout(timer);resolve();});
  });
 }
}

function receiveLock(lockFile,{peer,id,sha256}){
 const signature={schema:'ctmesh-receive-lock-v1',host:os.hostname(),peer,id,sha256,pid:process.pid};
 const open=()=>fs.openSync(lockFile,'wx',0o600);
 let fd;
 try{fd=open();}
 catch(error){
  if(error.code!=='EEXIST')throw error;
  const before=fs.lstatSync(lockFile);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>2048)fail('Untrusted receive lock; inspect before retry');
  // Verify the stale lock through the descriptor in this ownership scope.
  // Never re-open its JSON through a pathname after the initial lstat.
  let old;
 
  let readFd;
  try{
   const flags=fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0)|(fs.constants.O_NONBLOCK??0);
   readFd=fs.openSync(lockFile,flags);
   const opened=fs.fstatSync(readFd),named=fs.lstatSync(lockFile);
   if(!opened.isFile()||opened.nlink!==1||opened.size<1||opened.size>2048||
      opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size||
      !named.isFile()||named.isSymbolicLink()||named.nlink!==1||
      named.dev!==opened.dev||named.ino!==opened.ino||named.size!==opened.size)
     fail('Untrusted receive lock; inspect before retry');
   const bytes=Buffer.alloc(opened.size);
   let at=0;
   while(at<bytes.length){
    const n=fs.readSync(readFd,bytes,at,bytes.length-at,at);
    if(n<=0)fail('Untrusted receive lock; inspect before retry');
    at+=n;
   }
   const after=fs.fstatSync(readFd),namedAfter=fs.lstatSync(lockFile);
   if(after.dev!==opened.dev||after.ino!==opened.ino||after.size!==opened.size||
      after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs||
      !namedAfter.isFile()||namedAfter.isSymbolicLink()||
      namedAfter.dev!==opened.dev||namedAfter.ino!==opened.ino||
      namedAfter.size!==opened.size)
     fail('Untrusted receive lock; inspect before retry');
   old=JSON.parse(bytes.toString('utf8'));
  }catch{fail('Untrusted receive lock; inspect before retry');}
  finally{if(readFd!==undefined)fs.closeSync(readFd);}
  if(old?.schema!==signature.schema||old.host!==signature.host||old.peer!==peer||old.id!==id||
    old.sha256!==sha256||!Number.isSafeInteger(old.pid)||old.pid<=0)fail('Untrusted receive lock; inspect before retry');
  let alive=true;
  try{process.kill(old.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
  if(alive)fail('Receive already owned by a live or unverified process');
  const after=fs.lstatSync(lockFile);
  if(after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeMs!==before.mtimeMs)
    fail('Receive lock changed during stale-owner verification');
  // Atomically take the *named* stale-lock generation aside, then verify
  // WHICH inode actually moved. A fresh lock can replace it after lstat.
  // Never unlink the active lock pathname on the basis of an older lstat.
  const quarantined=lockFile+'.stale-reclaim-'+crypto.randomUUID();
  try{fs.renameSync(lockFile,quarantined);}
  catch{fail('Receive lock changed during stale-owner verification');}
  let moved;
  try{moved=fs.lstatSync(quarantined);}
  catch{fail('Receive lock changed during stale-owner verification');}
  if(!moved.isFile()||moved.isSymbolicLink()||moved.nlink!==1||
     moved.dev!==after.dev||moved.ino!==after.ino||
     moved.size!==after.size||moved.mtimeMs!==after.mtimeMs){
    // A new generation won the rename race. Restore it only by a
    // destination-exclusive link; never clobber a fresher lock.
    let restored=false;
    try{fs.linkSync(quarantined,lockFile);restored=true;}catch{}
    if(restored){
      try{fs.unlinkSync(quarantined);}catch{}
    } else {
      // If exact restoration is impossible, retain a named fail-closed
      // sentinel unless a concurrent owner has already created its lock.
      try{const guard=fs.openSync(lockFile,'wx',0o600);
       try{fs.writeSync(guard,'UNTRUSTED_RECLAIMED_LOCK\n');fs.fsyncSync(guard);}
       finally{fs.closeSync(guard);}
      }catch{}
    }
    fail('Receive lock changed during stale-owner verification');
  }
  try{fs.unlinkSync(quarantined);}
  catch{fail('Receive lock changed during stale-owner verification');}
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
   if(!current||!current.isFile()||current.isSymbolicLink()||
      current.nlink!==1||current.dev!==owned.dev||current.ino!==owned.ino)
     fail('Receive lock changed during release');
   // The lstat above is only a preflight, not deletion authority. Move the
   // currently named generation, then verify the inode that ACTUALLY moved.
   const retired=lockFile+'.release-retire-'+crypto.randomUUID();
   try{fs.renameSync(lockFile,retired);}
   catch{fail('Receive lock changed during release');}
   let moved;
   try{moved=fs.lstatSync(retired);}
   catch{fail('Receive lock changed during release');}
   if(!moved.isFile()||moved.isSymbolicLink()||moved.nlink!==1||
      moved.dev!==owned.dev||moved.ino!==owned.ino){
     // A newer owner's lock won the rename race. Restore without overwrite
     // and fail closed; never delete the new owner by its old pathname.
     let restored=false;
     try{fs.linkSync(retired,lockFile);restored=true;}catch{}
     if(restored){try{fs.unlinkSync(retired);}catch{}}
     else{
       try{
        const guard=fs.openSync(lockFile,'wx',0o600);
        try{fs.writeSync(guard,'UNTRUSTED_RELEASED_LOCK\\n');fs.fsyncSync(guard);}
        finally{fs.closeSync(guard);}
       }catch{}
     }
     fail('Receive lock changed during release');
   }
   try{fs.unlinkSync(retired);}
   catch{fail('Receive lock changed during release');}
  }finally{fs.closeSync(fd);}
 };
}
// Bind the outgoing source's bytes to the regular-file inode checked before
// staging. Node copyFileSync(path, ...) otherwise follows a symlink substituted
// after the initial lstat, allowing an unrelated file to be queued as trusted.
// Core may select a source only inside an allowlisted root. Revalidate that
// trust boundary in the child after spawn: a source ancestor may change after
// Core's realpath/allowlist check but before Pilot first sees the pathname.
function withLinuxPinnedAllowedSource(file,scope,read){
 if(process.platform!=='linux'||!scope)return read(file);
 const root=scope.root,rel=path.relative(root,file);
 if(!path.isAbsolute(root)||!rel||rel==='..'||rel.startsWith('..'+path.sep)||
    path.isAbsolute(rel))fail('SOURCE_OUTSIDE_APPROVED_ROOT');
 const parts=rel.split(path.sep);
 if(parts.some(p=>!p||p==='.'||p==='..'))fail('SOURCE_OUTSIDE_APPROVED_ROOT');
 const flags=fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW;
 const fds=[];
 try{
  const before=fs.lstatSync(root,{bigint:true});
  if(!before.isDirectory()||before.isSymbolicLink()||
     before.dev!==scope.rootDev||before.ino!==scope.rootIno)
   fail('SOURCE_ROOT_IDENTITY_CHANGED');
  const rootFd=fs.openSync(root,flags);
  fds.push(rootFd);
  const opened=fs.fstatSync(rootFd,{bigint:true});
  if(!opened.isDirectory()||opened.dev!==before.dev||opened.ino!==before.ino)
   fail('SOURCE_ROOT_IDENTITY_CHANGED');
  for(const part of parts.slice(0,-1)){
   let fd;
   try{fd=fs.openSync('/proc/self/fd/'+fds.at(-1)+'/'+part,flags);}
   catch(e){if(['ELOOP','ENOTDIR','ENOENT'].includes(e.code))
    fail('SOURCE_OUTSIDE_APPROVED_ROOT');throw e;}
   fds.push(fd);
   if(!fs.fstatSync(fd).isDirectory())fail('SOURCE_OUTSIDE_APPROVED_ROOT');
  }
  return read('/proc/self/fd/'+fds.at(-1)+'/'+parts.at(-1));
 }finally{for(let i=fds.length-1;i>=0;i--)fs.closeSync(fds[i]);}
}
function copyOutgoingVerifiedSource(file,temp,initial,scope){
 if(process.platform!=='linux'){
  fs.copyFileSync(file,temp,fs.constants.COPYFILE_EXCL);
  return;
 }
 const copy=(sourceName)=>{
  const flags=fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|(fs.constants.O_NONBLOCK??0);
  const fd=fs.openSync(sourceName,flags);
  try{
   const opened=fs.fstatSync(fd),named=fs.lstatSync(sourceName);
   const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&
    a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
   if(!opened.isFile()||opened.nlink!==1||!named.isFile()||
      named.isSymbolicLink()||named.nlink!==1||
      !same(initial,opened)||!same(opened,named))
    fail('Source changed before pinned outgoing copy');
   if(scope){
    const verified=fs.fstatSync(fd,{bigint:true});
    if(verified.dev!==scope.sourceDev||verified.ino!==scope.sourceIno||
       verified.size!==scope.sourceSize||verified.ctimeNs!==scope.sourceCtimeNs)
     fail('SOURCE_ADMISSION_IDENTITY_CHANGED');
   }
   // Copy from the exact descriptor, never from a freshly resolved source path.
   fs.copyFileSync('/proc/self/fd/'+fd,temp,fs.constants.COPYFILE_EXCL);
   const after=fs.fstatSync(fd),namedAfter=fs.lstatSync(sourceName);
   if(!after.isFile()||after.nlink!==1||!namedAfter.isFile()||
      namedAfter.isSymbolicLink()||namedAfter.nlink!==1||
      !same(opened,after)||!same(opened,namedAfter))
    fail('Source changed during pinned outgoing copy');
  }finally{fs.closeSync(fd);}
 };
 return withLinuxPinnedAllowedSource(file,scope,copy);
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

// Identity and incoming manifest JSON are authoritative. Both must be parsed
// from the same descriptor that passed regular-file / pathname identity checks.
function readVerifiedJson(file,code){
 return withLinuxPinnedManagedPath(file,name=>readVerifiedJsonName(name,code));
}
function readVerifiedJsonName(file,code){
 const unsafe=()=>fail(code);
 const before=fs.lstatSync(file),limit=16384;
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||
    before.size<1||before.size>limit)unsafe();
 const flags=fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0)|(fs.constants.O_NONBLOCK??0);
 const fd=fs.openSync(file,flags);
 try{
  const opened=fs.fstatSync(fd),named=fs.lstatSync(file);
  const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size;
  if(!opened.isFile()||opened.nlink!==1||opened.size<1||opened.size>limit||
     !named.isFile()||named.isSymbolicLink()||named.nlink!==1||
     !same(before,opened)||!same(opened,named))unsafe();
  const bytes=Buffer.alloc(opened.size);
  let at=0;
  while(at<bytes.length){
   const n=fs.readSync(fd,bytes,at,bytes.length-at,at);
   if(n<=0)unsafe();
   at+=n;
  }
  const after=fs.fstatSync(fd),namedAfter=fs.lstatSync(file);
  if(!after.isFile()||after.nlink!==1||!namedAfter.isFile()||
     namedAfter.isSymbolicLink()||namedAfter.nlink!==1||
     !same(opened,after)||!same(opened,namedAfter)||
     after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs||
     namedAfter.mtimeMs!==opened.mtimeMs||namedAfter.ctimeMs!==opened.ctimeMs)unsafe();
  return JSON.parse(bytes.toString('utf8'));
 }finally{fs.closeSync(fd);}
}

function checkIncoming(peer,self,id){
 const p=transferPaths(peer,self,id);
 if(!fs.existsSync(p.payload)||!fs.existsSync(p.manifest))fail('Transfer is pending');
 const m=readVerifiedJson(p.manifest,'Untrusted transfer manifest');
 if(m.schema!=='ctmesh-v1'||m.id!==id||m.from!==peer||m.to!==self)fail('Identity mismatch');
 if(typeof m.name!=='string'||m.name!==path.basename(m.name)||/[\\/:*?"<>|\x00-\x1f]/.test(m.name)||m.name==='.'||m.name==='..')fail('Unsafe filename');
 if(!Number.isSafeInteger(m.bytes)||m.bytes<0||!(/^[0-9a-f]{64}$/.test(m.sha256)))fail('Invalid metadata');
 const stat=fs.lstatSync(p.payload);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==m.bytes||hash(p.payload)!==m.sha256)fail('SHA256/size mismatch');
 return {m,p};
}
try{
 if(process.env.COMMANDER_TRANSFER_HOME && !path.isAbsolute(process.env.COMMANDER_TRANSFER_HOME))
  throw Error('CTMESH_MANAGED_PATH_UNSAFE'); // Explicit relative roots must not be rebased onto an arbitrary cwd.
 assertUnredirectedDirectoryAncestors(root,'CTMESH_MANAGED_PATH_UNSAFE');
 assertManagedEntry(path.join(root,'node.json'),false);
 const self=readVerifiedJson(path.join(root,'node.json'),'Untrusted node identity').alias;
 if(!validAlias.test(self))fail('Unrecognized local device');
 if(cmd==='source-admission-capabilities'){json({schema:'ctmesh-source-admission-v1',linuxPinnedRoot:true,linuxPinnedSource:true});}
 else if(cmd==='info'){json({schema:'ctmesh-v1',device:self,transport:'Syncthing 2.1.6',root});}
 else{
   const peer=arg('peer');if(!peer)fail('Provide --peer');
   if(cmd==='send'){
     const filename=arg('path');if(!filename)fail('Provide --path');
     const file=path.resolve(filename),st=fs.lstatSync(file),name=path.basename(file);
     const approvedSourceRoot=arg('source-root');
     let sourceScope;
     if(approvedSourceRoot!==undefined){
      if(process.platform!=='linux'||!path.isAbsolute(approvedSourceRoot))
       fail('SOURCE_ROOT_ADMISSION_INVALID');
      const parseId=(key)=>{
       const value=arg(key);
       if(typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value))
        fail('SOURCE_ROOT_ADMISSION_INVALID');
       return BigInt(value);
      };
      sourceScope={root:path.resolve(approvedSourceRoot),
       rootDev:parseId('root-dev'),rootIno:parseId('root-ino'),
       sourceDev:parseId('source-dev'),sourceIno:parseId('source-ino'),
       sourceSize:parseId('source-size'),sourceCtimeNs:parseId('source-ctime-ns')};
     }
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
     // Linux: hold both managed parents through the exclusive copy, hash and
     // publication rename. A symlink-swapped staging ancestor cannot direct a
     // copy outside the operator-selected root between the final preflight
     // and the actual fs.copyFileSync/fs.renameSync calls.
     const sha256=withLinuxPinnedManagedPath(temp,pinnedTemp=>
      withLinuxPinnedManagedPath(p.payload,pinnedPayload=>{
       copyOutgoingVerifiedSource(file,pinnedTemp,st,sourceScope);
       const after=fs.statSync(file);
       if(after.size!==st.size||after.mtimeMs!==st.mtimeMs)
        fail('Source changed while copying');
       const digest=hash(pinnedTemp);
       fs.renameSync(pinnedTemp,pinnedPayload);
       return digest;
      }));
     const manifest={schema:'ctmesh-v1',id,from:self,to:peer,name,bytes:st.size,sha256,createdAt:new Date().toISOString()};
     withLinuxPinnedManagedPath(p.manifest,pinnedManifest=>
      fs.writeFileSync(pinnedManifest,JSON.stringify(manifest)+'\n',{flag:'wx',mode:0o600}));
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
         const destIdentity=expectedDestIdentity();
         // Core admission already requires this destination to exist. Do not
         // create any directory by pathname before the OS directory pin is held:
         // a swapped ancestor could redirect mkdir outside the allowed root.
         try{verifyDest(dest,destIdentity);}catch(e){
          if(e.code==='ENOENT')fail('DESTINATION_MUST_EXIST');
          throw e;
         }
         await withPinnedDest(dest,destIdentity,async pinnedDest=>{
         const target=path.join(pinnedDest,m.name);
         if(fs.existsSync(target))fail('Destination exists; overwrite forbidden');
         const part=path.join(pinnedDest,'.ctmesh-'+id+'.part');
         const lock=path.join(pinnedDest,'.ctmesh-'+id+'.lock');
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
         json({status:'DELIVERED_HASH_VERIFIED',id,path:path.join(dest,m.name),bytes:m.bytes,sha256:m.sha256,
           resumedBytes});
         });
       }
     }
   }else fail('Valid commands: info | send --peer DEVICE --path FILE | status/receive --peer DEVICE --id TRANSFER [--dest DIR]');
 }
}catch(e){process.stderr.write('CTMESH_ERROR: '+e.message+'\n');process.exitCode=1;}
