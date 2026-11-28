import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const cli=fileURLToPath(new URL('./durable-send.mjs',import.meta.url));
function installedCli(root){
 const target=path.join(root,'durable-send.mjs');
 if(!fs.existsSync(target))fs.copyFileSync(cli,target,fs.constants.COPYFILE_EXCL);
 return target;
}
const call=(root,...argv)=>JSON.parse(execFileSync(process.execPath,[installedCli(root),...argv],{
  env:{...process.env,COMMANDER_TRANSFER_HOME:root},encoding:'utf8',timeout:6000
}).trim());
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('durable transfer refuses a symlinked internal publication root', {skip:process.platform==='win32'},async()=>{
 const base=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-path-alias-')));
 const home=path.join(base,'owner'),outside=path.join(base,'outside');
 const id='alias-reject-001';
 try{
  fs.mkdirSync(home);fs.mkdirSync(outside);
  fs.writeFileSync(path.join(home,'node.json'),JSON.stringify({alias:'PC'}));
  const allowed=path.join(home,'allowed');fs.mkdirSync(allowed);
  const source=path.join(allowed,'payload.bin');fs.writeFileSync(source,'test payload');
  fs.symlinkSync(outside,path.join(home,'pairs'),'dir');
  let admitted=false,failedEarly=false,state=null;
  try{
   const r=call(home,'enqueue','--peer','Linux','--path',source,'--source-root',allowed,'--id',id);
   admitted=r.status==='QUEUED';
  }catch(error){
   failedEarly=true;
   assert.match(String(error?.stderr??error),/TRANSFER_DIRECTORY_UNSAFE/);
  }
  if(admitted){
   for(let i=0;i<80;i++){
    const j=call(home,'job-status','--peer','Linux','--id',id);
    state=j.status;
    if(['FAILED','PUBLISHED','CANCELLED'].includes(state))break;
    await delay(40);
   }
   assert.equal(state,'FAILED','symlinked publication unexpectedly accepted: '+state);
  }else assert.equal(failedEarly,true);
  assert.equal(fs.existsSync(path.join(outside,'Linux','transfers',id,'payload.bin')),false,
   'payload escaped the configured transfer root');
 }finally{fs.rmSync(base,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

for(const components of [
 ['jobs'],['jobs','Linux'],['staging'],['staging','Linux'],
 ['pairs','Linux'],['pairs','Linux','transfers']
]){
 test('durable enqueue fails closed for aliased '+components.join('/'),{skip:process.platform==='win32'},()=>{
  const base=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-alias-fixture-')));
  const home=path.join(base,'owner'),outside=path.join(base,'outside');
  try{
   fs.mkdirSync(home);fs.mkdirSync(outside);
   fs.writeFileSync(path.join(home,'node.json'),JSON.stringify({alias:'PC'}));
   const allowed=path.join(home,'allowed');fs.mkdirSync(allowed);
   const source=path.join(allowed,'payload.bin');fs.writeFileSync(source,'confidential fixture');
   const link=path.join(home,...components);
   fs.mkdirSync(path.dirname(link),{recursive:true});
   fs.symlinkSync(outside,link,'dir');
   assert.throws(()=>call(home,'enqueue','--peer','Linux','--path',source,
    '--source-root',allowed,'--id','alias-unsafe-003'),/TRANSFER_DIRECTORY_UNSAFE/);
   assert.deepEqual(fs.readdirSync(outside),[],'alias destination was modified');
  }finally{fs.rmSync(base,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
 });
}


test('durable transfer rejects an aliased configured root before inspecting queue state',{skip:process.platform==='win32'},()=>{
 const base=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-root-alias-')));
 const home=path.join(base,'owner'),outside=path.join(base,'outside');
 try{
  fs.mkdirSync(outside);installedCli(outside);fs.symlinkSync(outside,home,'dir');
  assert.throws(()=>call(home,'job-status','--peer','Linux','--id','root-alias-001'),/TRANSFER_ROOT_MISMATCH|TRANSFER_ROOT_UNSAFE/);
  assert.deepEqual(fs.readdirSync(outside),['durable-send.mjs']);
 }finally{fs.rmSync(base,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});


test('durable transfer rejects an alias in the configured root ancestry',()=>{
 const base=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-root-ancestor-')));
 const outside=path.join(base,'outside'),alias=path.join(base,'alias');
 try{
  fs.mkdirSync(path.join(outside,'owner'),{recursive:true});installedCli(path.join(outside,'owner'));
  fs.symlinkSync(outside,alias,process.platform==='win32'?'junction':'dir');
  const home=path.join(alias,'owner');
  assert.equal(fs.lstatSync(home).isSymbolicLink(),false);
  assert.throws(()=>call(home,'job-status','--peer','Linux','--id','ancestor-alias-001'),/TRANSFER_ROOT_MISMATCH|TRANSFER_ROOT_UNSAFE/);
  assert.deepEqual(fs.readdirSync(path.join(outside,'owner')),['durable-send.mjs']);
 }finally{fs.rmSync(base,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

// owner root and internal file custody: fixtures are confined to a temporary tree.
test('durable transfer refuses an ambiguous relative configured root',()=>{
 const base=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-relative-root-')));
 try{
  const home=path.join(base,'owner');fs.mkdirSync(home);
  fs.mkdirSync(path.join(home,'jobs','Linux'),{recursive:true});
  fs.writeFileSync(path.join(home,'jobs','Linux','custody-001.json'),JSON.stringify({status:'PUBLISHED',bytes:1}));
  assert.throws(()=>execFileSync(process.execPath,[installedCli(home),'job-status','--peer','Linux','--id','custody-001'],{
    cwd:base,env:{...process.env,COMMANDER_TRANSFER_HOME:'owner'},encoding:'utf8',timeout:6000
  }),/TRANSFER_ROOT_ABSOLUTE_REQUIRED/);
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});

test('durable transfer refuses a shared-writable configured root',{skip:process.platform==='win32'},()=>{
 const base=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-owner-root-')));
 try{
  const home=path.join(base,'owner');fs.mkdirSync(home);fs.chmodSync(home,0o777);
  fs.mkdirSync(path.join(home,'jobs','Linux'),{recursive:true});
  fs.writeFileSync(path.join(home,'jobs','Linux','custody-002.json'),JSON.stringify({status:'PUBLISHED',bytes:1}));
  assert.throws(()=>call(home,'job-status','--peer','Linux','--id','custody-002'),/TRANSFER_ROOT_CUSTODY_UNSAFE/);
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});

for(const [kind,rel] of [
 ['symlink',['jobs','Linux','custody-003.json']],
 ['hardlink',['staging','Linux','custody-003.part']],
 ['symlink',['pairs','Linux','transfers','custody-003','manifest.json']]
]){
 test('durable transfer refuses preexisting internal '+kind+' '+rel.at(-1),{skip:kind==='symlink'&&process.platform==='win32'},()=>{
  const base=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-file-custody-')));
  try{
   const home=path.join(base,'owner');fs.mkdirSync(home);
   const record=path.join(home,'jobs','Linux','custody-003.json');
   const outside=path.join(base,'synthetic.txt');
   const data=JSON.stringify({status:'PUBLISHED',bytes:1});
   fs.mkdirSync(path.dirname(record),{recursive:true});
   fs.writeFileSync(outside,data);
   if(rel[0]!=='jobs')fs.writeFileSync(record,data);
   const leaf=path.join(home,...rel);fs.mkdirSync(path.dirname(leaf),{recursive:true});
   if(kind==='hardlink')fs.linkSync(outside,leaf);else fs.symlinkSync(outside,leaf,'file');
   assert.throws(()=>call(home,'job-status','--peer','Linux','--id','custody-003'),/TRANSFER_FILE_UNSAFE/);
   assert.equal(fs.readFileSync(outside,'utf8'),data);
  }finally{fs.rmSync(base,{recursive:true,force:true});}
 });
}

test('installed CLI cannot select another configured root',()=>{
 const base=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-root-binding-')));
 try{
  const own=path.join(base,'own'),other=path.join(base,'other');
  fs.mkdirSync(own);fs.mkdirSync(other);
  const installed=path.join(own,'durable-send.mjs');
  fs.copyFileSync(cli,installed);
  fs.mkdirSync(path.join(other,'jobs','Linux'),{recursive:true});
  const record=path.join(other,'jobs','Linux','binding-001.json');
  const data=JSON.stringify({status:'PUBLISHED',bytes:1});
  fs.writeFileSync(record,data);
  assert.throws(()=>execFileSync(process.execPath,[installed,'job-status','--peer','Linux','--id','binding-001'],{
   env:{...process.env,COMMANDER_TRANSFER_HOME:other},encoding:'utf8',timeout:6000
  }),/TRANSFER_ROOT_MISMATCH/);
  assert.equal(fs.readFileSync(record,'utf8'),data);
  assert.deepEqual(fs.readdirSync(own),['durable-send.mjs']);
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});

test('installed CLI defaults to its own root without an environment override',()=>{
 const base=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-own-root-')));
 try{
  const own=path.join(base,'own');fs.mkdirSync(own);
  const script=installedCli(own);
  fs.mkdirSync(path.join(own,'jobs','Linux'),{recursive:true});
  const record=path.join(own,'jobs','Linux','binding-002.json');
  const data=JSON.stringify({status:'PUBLISHED',bytes:1});
  fs.writeFileSync(record,data);
  const env={...process.env};delete env.COMMANDER_TRANSFER_HOME;
  // The legacy default is confined to this fixture as well.
  env.HOME=path.join(base,'unused-home');env.LOCALAPPDATA=path.join(base,'unused-appdata');
  const out=JSON.parse(execFileSync(process.execPath,[script,'job-status','--peer','Linux','--id','binding-002'],{
   env,encoding:'utf8',timeout:6000
  }));
  assert.equal(out.status,'PUBLISHED');
  assert.equal(fs.readFileSync(record,'utf8'),data);
  assert.equal(fs.existsSync(env.LOCALAPPDATA),false);
  assert.equal(fs.existsSync(env.HOME),false);
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
