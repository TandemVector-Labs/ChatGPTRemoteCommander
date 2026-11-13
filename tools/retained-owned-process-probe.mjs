import fs from 'node:fs';
import path from 'node:path';

// Extra *read-only* Linux signal. /proc cannot establish the absence of all
// descendants, remote users, sockets or transient workers; never authorize
// retirement based solely on this scan.
const MAX_PROCESSES=8192;
const MAX_CMDLINE_BYTES=65536;
const matches=(candidate,value)=>{
  if(typeof value!=='string'||!value)return false;
  return value===candidate||value.startsWith(candidate+path.sep)||
    value.startsWith(candidate+' (deleted)')||value.includes(candidate+path.sep);
};
export function probeOwnedRetainedReferences(entries,{procRoot='/proc',ownerUid=process.getuid?.()}={}){
  if(process.platform!=='linux'||!Number.isSafeInteger(ownerUid))
    throw Error('PROC_PROOF_LINUX_ONLY');
  if(!Array.isArray(entries)||entries.length>1024)throw Error('PROC_PROOF_BOUNDED_ENTRIES');
  const paths=entries.map(x=>{
    if(!Array.isArray(x)||x.length>3||!x.every(p=>typeof p==='string'&&path.isAbsolute(p)&&p.length<4096))
      throw Error('PROC_PROOF_INVALID_PATHS');
    return x.map(p=>path.resolve(p));
  });
  let scanned=0,unreadableOwned=0,vanished=0,otherUser=0;
  const refs=paths.map(()=>[]);
  const candidates=fs.readdirSync(procRoot).filter(x=>/^[1-9][0-9]*$/.test(x));
  if(candidates.length>MAX_PROCESSES)throw Error('PROC_PROOF_TOO_MANY_PROCESSES');
  for(const id of candidates){
    if(Number(id)===process.pid)continue;
    const root=path.join(procRoot,id);
    let owner;
    try{owner=fs.statSync(root).uid;}
    catch(error){if(error.code==='ENOENT'||error.code==='ESRCH'){vanished++;continue;}throw error;}
    if(owner!==ownerUid){otherUser++;continue;}
    scanned++;
    let cwd='',cmdline=[],cwdUnreadable=false;
    try{cwd=fs.readlinkSync(path.join(root,'cwd'));}
    catch(error){if(!['ENOENT','ESRCH'].includes(error.code))cwdUnreadable=true;}
    try{const b=fs.readFileSync(path.join(root,'cmdline'));
      if(b.length>MAX_CMDLINE_BYTES)throw Error('PROC_PROOF_UNBOUNDED_CMDLINE');
      cmdline=b.toString('utf8').split('\0').filter(Boolean);
    }catch(error){
      if(error.code==='ENOENT'||error.code==='ESRCH'){vanished++;continue;}
      unreadableOwned++;continue;
    }
    // A blocked cwd /proc link does not hide a readable matching cmdline.
    // But absent command-line evidence cannot certify that an owned process
    // with inaccessible cwd does not own a deleted historical directory.
    let anyMatch=false;
    for(let i=0;i<paths.length;i++){
      const matched=paths[i].some(p=>matches(p,cwd)||cmdline.some(arg=>matches(p,arg)||
        arg.includes(p+' ')));
      if(matched){refs[i].push(Number(id));anyMatch=true;}
    }
    if(cwdUnreadable&&!anyMatch)unreadableOwned++;
  }
  return {scope:'SAME_UID_LINUX_PROC_PATHS_ONLY',scanned,otherUser,vanished,
    unreadableOwned,refPids:refs.map(p=>p.slice(0,100))};
}
