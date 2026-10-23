import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
test('native Windows guard prevents rename of a pinned directory',async t=>{
 if(process.platform!=='win32'){t.skip('Windows native only');return}
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-win-guard-'));
 const dir=path.join(root,'private');
 fs.mkdirSync(dir);
 let child;
 try{
  const script=path.resolve('tools/commander-transfer-mesh/win-dest-pin.ps1');
  child=spawn('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',script],{
    env:{...process.env,CTMESH_PIN_DEST:dir},stdio:['pipe','pipe','pipe'],windowsHide:true
  });
  await new Promise((resolve,reject)=>{
    let out='',err='';
    const tm=setTimeout(()=>reject(Error('GUARD_TIMEOUT '+err.slice(0,140))),10000);
    const fail=e=>{clearTimeout(tm);reject(e);};
    child.on('error',fail);
    child.once('exit',code=>fail(Error('GUARD_EXIT_'+code+' '+err.slice(0,160))));
    child.stderr.on('data',b=>{err+=b.toString()});
    child.stdout.on('data',b=>{out+=b.toString();if(out.includes('CTMESH_PIN_READY')){clearTimeout(tm);resolve()}})
  });
  assert.throws(()=>fs.renameSync(dir,dir+'.moved'),e=>['EPERM','EACCES','EBUSY'].includes(e.code));
  assert.equal(fs.existsSync(dir),true);
 }finally{
  if(child){child.stdin.end(String.fromCharCode(10));await new Promise(r=>{if(child.exitCode!==null)return r();const tm=setTimeout(()=>{child.kill();r()},5000);child.once('exit',()=>{clearTimeout(tm);r()})})}
  fs.rmSync(root,{recursive:true,force:true,maxRetries:4,retryDelay:120});
 }
});
