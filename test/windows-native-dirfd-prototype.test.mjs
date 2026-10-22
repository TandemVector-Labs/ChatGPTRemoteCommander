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
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-native-dirfd-regression-'));
  // Each build uses a separate output and intermediate root; never mix
  // the race-instrumented test binary with the ordinary Release executable.
  const build=(name,defines)=>{
   const output=path.join(work,name,'bin'),intermediate=path.join(work,name,'obj');
   fs.mkdirSync(output,{recursive:true});fs.mkdirSync(intermediate,{recursive:true});
   const args=['build',project,'-c','Release','--nologo','-v','quiet',
    '-p:OutputPath='+output,'-p:BaseIntermediateOutputPath='+intermediate,
    '-p:AppendTargetFrameworkToOutputPath=false'];
   if(defines)args.push('-p:DefineConstants='+defines);
   const result=spawnSync('dotnet',args,{encoding:'utf8',timeout:120000});
   assert.equal(result.status,0,'dotnet isolated '+name+' build failed: '+result.stderr+' '+result.stdout);
   return path.join(output,'NativeDirfdProbe.exe');
  };
  const exe=build('test-only','CTMESH_TEST_RACE');
  const releaseExe=build('release',null);
  const root=path.join(work,'transfer'),original=path.join(root,'jobs','Linux'),
   external=path.join(work,'outside');
  fs.mkdirSync(original,{recursive:true});fs.mkdirSync(external);
  const inside=path.join(original,'record-001.json'),outside=path.join(external,'record-001.json');
  const queued='{"status":"QUEUED"}',forged='{"status":"PUBLISHED"}';
  fs.writeFileSync(inside,queued);fs.writeFileSync(outside,forged);
  const read=(relative)=>spawnSync(exe,[root,relative],{encoding:'utf8',timeout:8000});
  try{
   await t.test('ordinary Release build rejects test hook, accepts only two arguments',()=>{
    const release=spawnSync(releaseExe,[root,'jobs\\Linux\\record-001.json'],{encoding:'utf8',timeout:8000});
    assert.equal(release.status,0,release.stderr);
    assert.equal(Buffer.from(release.stdout.trim(),'base64').toString('utf8'),queued);
    const marker=path.join(work,'forbidden.marker');
    const denied=spawnSync(releaseExe,[root,'jobs\\Linux\\record-001.json',marker],{encoding:'utf8',timeout:8000});
    assert.notEqual(denied.status,0,'Release must not expose race/test marker');
    assert.match(denied.stderr,/Usage: RootAbsolute RelFile/);
    assert.equal(fs.existsSync(marker),false);
   });
   await t.test('absolute and drive-prefixed relative path arguments fail closed',()=>{
    for(const candidate of ['C:\\Windows\\system.ini','\\Windows\\system.ini','..\\outside']){
     const p=spawnSync(releaseExe,[root,candidate],{encoding:'utf8',timeout:8000});
     assert.notEqual(p.status,0,'Rejected path '+candidate);
    }
   });
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