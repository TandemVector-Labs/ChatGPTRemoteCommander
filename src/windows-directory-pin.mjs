// Windows security guard: reuse the project's reviewed native NT-handle pinning
// mechanism while retaining every held directory handle during pathname I/O.
// This is not a replacement for original-owner NTFS ACL admission.
import path from 'node:path';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('../tools/commander-transfer-mesh/win-dest-pin.ps1',import.meta.url));
const invalid=()=>Object.assign(new Error('GUI_INCIDENT_STORAGE_UNAVAILABLE'),
  {guiCode:'GUI_INCIDENT_STORAGE_UNAVAILABLE'});
const dirIdentity=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&
  a.isDirectory()&&b.isDirectory()&&!a.isSymbolicLink()&&!b.isSymbolicLink();

async function pinnedDir(dir,operation,expected){
  if(process.platform!=='win32')throw invalid();
  const child=spawn('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',script],{
    env:{...process.env,CTMESH_PIN_DEST:dir},stdio:['pipe','pipe','pipe'],windowsHide:true
  });
  let ready=false,stdout='',stderr='',settled=false;
  const handshake=new Promise((resolve,reject)=>{
    // Startup can exceed 12s on a saturated hosted Windows runner. Keep a bounded, fail-closed readiness deadline.
    const timer=setTimeout(()=>finish(invalid()),30000);
    function finish(error){
      if(settled)return;settled=true;clearTimeout(timer);
      error?reject(error):resolve();
    }
    child.on('error',()=>finish(invalid()));
    child.on('exit',()=>{if(!ready)finish(invalid())});
    child.stdout.on('data',bytes=>{
      stdout+=bytes.toString('utf8');
      if(stdout.length>2048)return finish(invalid());
      if(stdout.includes('CTMESH_PIN_READY')){ready=true;finish();}
    });
    child.stderr.on('data',bytes=>{stderr+=bytes.toString('utf8');if(stderr.length>2048)finish(invalid())});
  });
  try{
    await handshake;
    const now=await fs.lstat(dir);
    if(!now.isDirectory()||now.isSymbolicLink())throw invalid();
    if(expected&&!dirIdentity(expected,now))throw invalid();
    return await operation();
  }catch(e){if(e?.guiCode)throw e;throw invalid();}
  finally{
    try{child.stdin.end(String.fromCharCode(10));}catch{}
    if(!ready)child.kill();
    await new Promise(resolve=>{
      if(child.exitCode!==null||child.signalCode!==null)return resolve();
      const timer=setTimeout(()=>{child.kill();resolve()},4000);
      child.once('exit',()=>{clearTimeout(timer);resolve()});
    });
  }
}
export async function withPinnedWindowsDirectory(input,operation,{create=false,missingOk=false}={}){
  if(process.platform!=='win32')throw invalid();
  if(typeof input!=='string'||!(/^[A-Za-z]:[\\/]/).test(input))throw invalid();
  const folder=path.resolve(input),root=path.parse(folder).root;
  if(folder===root)throw invalid();
  const missing=[];
  let nearest=folder,st;
  for(;;){
    try{
      st=await fs.lstat(nearest);
      if(!st.isDirectory()||st.isSymbolicLink())throw invalid();
      break;
    }catch(e){
      if(e.code!=='ENOENT')throw invalid();
      if(!create&&missingOk)return operation(null);
      if(!create)throw invalid();
      missing.unshift(nearest);
      const next=path.dirname(nearest);
      if(next===nearest)throw invalid();
      nearest=next;
    }
  }
  async function descend(current,expected,index){
    return pinnedDir(current,async ()=>{
      if(index===missing.length)return operation({folderPath:folder});
      const next=missing[index];
      if(path.dirname(next)!==current)throw invalid();
      try{await fs.mkdir(next,{mode:0o700});}
      catch{throw invalid();}
      let created;
      try{created=await fs.lstat(next);}
      catch{throw invalid();}
      if(!created.isDirectory()||created.isSymbolicLink())throw invalid();
      return descend(next,created,index+1);
    },expected);
  }
  return descend(nearest,st,0);
}
