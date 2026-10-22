import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../tools/security/windows-native-dirfd-prototype/NativeDirfdProbe.csproj');
test('Windows native handle-relative read prototype: pinned parents, no reparse, bounded size',
 {skip:process.platform!=='win32'},async t=>{
  const build=spawnSync('dotnet',['build',project,'-c','Release','--nologo','-v','quiet'],
   {encoding:'utf8',timeout:120000});
  assert.equal(build.status,0,'dotnet SDK/build required on Windows: '+build.stderr+' '+build.stdout);
  const exe=path.join(path.dirname(project),'bin','Release','net10.0','NativeDirfdProbe.exe');
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-native-dirfd-regression-'));
  const root=path.join(work,'transfer'),original=path.join(root,'jobs','Linux'),
   external=path.join(work,'outside');
  fs.mkdirSync(original,{recursive:true});fs.mkdirSync(external);
  const inside=path.join(original,'record-001.json'),outside=path.join(external,'record-001.json');
  const queued='{"status":"QUEUED"}',forged='{"status":"PUBLISHED"}';
  fs.writeFileSync(inside,queued);fs.writeFileSync(outside,forged);
  const read=(relative)=>spawnSync(exe,[root,relative],{encoding:'utf8',timeout:8000});
  try{
   await t.test('baseline reads original record',()=>{
    const p=read('jobs\\Linux\\record-001.json');
    assert.equal(p.status,0,p.stderr);
    assert.equal(Buffer.from(p.stdout.trim(),'base64').toString('utf8'),queued);
   });
   await t.test('ancestor rename and junction substitution cannot redirect a held directory handle',async st=>{
    const marker=path.join(work,'ready.marker');
    const proc=spawn(exe,[root,'jobs\\Linux\\record-001.json',marker],{windowsHide:true});
    let out='',err='';
    proc.stdout.on('data',v=>{out+=v;});proc.stderr.on('data',v=>{err+=v;});
    try{
     let found=false;
     for(let i=0;i<180;i++){
      if(fs.existsSync(marker)){found=true;break;}
      await new Promise(r=>setTimeout(r,15));
     }
     assert.ok(found,'Probe never reached the pinned directory');
     fs.renameSync(original,original+'.original');
     try{fs.symlinkSync(external,original,'junction');}
     catch(e){st.skip('Fixture junction unavailable: '+e.code);return;}
     const exit=await new Promise((resolve,reject)=>{proc.once('error',reject);proc.once('close',resolve);});
     assert.equal(exit,0,err);
     assert.equal(Buffer.from(out.trim(),'base64').toString('utf8'),queued);
     assert.equal(fs.readFileSync(outside,'utf8'),forged);
     assert.equal(fs.readFileSync(path.join(original+'.original','record-001.json'),'utf8'),queued);
    }finally{if(proc.exitCode===null)proc.kill();}
   });
   await t.test('existing ancestor junction is rejected',()=>{
    const p=read('jobs\\Linux\\record-001.json');
    assert.notEqual(p.status,0,p.stdout);
    assert.match(p.stderr,/REPARSE_COMPONENT_REJECTED/);
   });
   await t.test('final-file symlink is rejected',st=>{
    const real=path.join(original+'.original','linked.json');
    try{fs.symlinkSync(outside,real,'file');}
    catch(e){st.skip('File symlink unavailable: '+e.code);return;}
    const p=read('jobs\\Linux.original\\linked.json');
    assert.notEqual(p.status,0,p.stdout);
    assert.match(p.stderr,/REPARSE_COMPONENT_REJECTED/);
   });
   await t.test('oversized journal is rejected',()=>{
    const oversized=path.join(original+'.original','large.json');
    fs.writeFileSync(oversized,'x'.repeat(131073));
    const p=read('jobs\\Linux.original\\large.json');
    assert.notEqual(p.status,0,p.stdout);
    assert.match(p.stderr,/BOUNDED_READ_REJECT/);
   });
  }finally{fs.rmSync(work,{recursive:true,force:true});}
});