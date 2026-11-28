import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createTransferMeshTools} from '../src/transfer-tools.mjs';
const cli=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../tools/commander-transfer-mesh/pilot-cli.mjs');
function fixture(id,destOverride=null){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'tvl-trusted-ancestor-'));
 const dest=destOverride||path.join(root,'out'),data=Buffer.from('synthetic-ancestry-only-fixture');
 const incoming=path.join(root,'pairs','PC','transfers',id);
 if(destOverride)assert.equal(fs.lstatSync(dest).isDirectory(),true);
 else fs.mkdirSync(dest);
 fs.mkdirSync(incoming,{recursive:true});
 fs.copyFileSync(cli,path.join(root,'transfer.mjs'));
 fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias:'Linux',schema:'ctmesh-node-v1'}));
 fs.writeFileSync(path.join(incoming,'payload.bin'),data);
 fs.writeFileSync(path.join(incoming,'manifest.json'),JSON.stringify({
  schema:'ctmesh-v1',id,from:'PC',to:'Linux',name:'sample.bin',
  bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex'),
  createdAt:new Date().toISOString()
 })+'\n');
 const identity=fs.lstatSync(dest,{bigint:true});
 return {
  root,dest,data,id,
  run(...extra){return spawnSync(process.execPath,[cli,'receive','--peer','PC','--id',id,
   '--dest',dest,'--dest-dev',String(identity.dev),'--dest-ino',String(identity.ino),...extra],
   {env:{...process.env,COMMANDER_TRANSFER_HOME:root},encoding:'utf8',timeout:12000});},
  tools(strict){return createTransferMeshTools({config:{
   powerMode:{enabled:true},transferMesh:{enabled:true,root,
    sourceRoots:[root],destinationRoots:[dest],requireTrustedLinuxAncestry:strict}
  }});},
  close(){fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
 };
}
test('Linux strict ancestry fails closed before publication under same-user-owned parent',t=>{
 if(process.platform!=='linux'||process.geteuid()===0)return t.skip('non-root Linux policy');
 const f=fixture('strict-owned-01');
 try{
  const r=f.run('--require-trusted-linux-ancestry','1');
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/DESTINATION_TRUSTED_LINUX_ANCESTRY_REQUIRED/);
  assert.equal(fs.existsSync(path.join(f.dest,'sample.bin')),false);
  assert.equal(fs.existsSync(path.join(f.dest,'.ctmesh-'+f.id+'.part')),false);
  assert.doesNotMatch(r.stdout,/DELIVERED_HASH_VERIFIED/);
 }finally{f.close();}
});
test('Linux strict ancestry rejects malformed explicit flag instead of silently ignoring',t=>{
 if(process.platform!=='linux')return t.skip('Linux only');
 const f=fixture('strict-invalid-02');
 try{
  const r=f.run('--require-trusted-linux-ancestry','0');
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/DESTINATION_TRUSTED_LINUX_ANCESTRY_OPTION_INVALID/);
  assert.equal(fs.existsSync(path.join(f.dest,'sample.bin')),false);
 }finally{f.close();}
});
test('Linux legacy non-strict destination remains compatible and hash-verified',t=>{
 if(process.platform!=='linux')return t.skip('Linux only');
 const f=fixture('strict-legacy-03');
 try{
  const r=f.run();
  assert.equal(r.status,0,r.stderr);
  assert.equal(JSON.parse(r.stdout).status,'DELIVERED_HASH_VERIFIED');
  assert.deepEqual(fs.readFileSync(path.join(f.dest,'sample.bin')),f.data);
 }finally{f.close();}
});
test('Core propagates strict Linux ancestry policy to receiver and fails closed',async t=>{
 if(process.platform!=='linux'||process.geteuid()===0)return t.skip('non-root Linux Core policy');
 const f=fixture('strict-core-04');
 try{
  const core=f.tools(true);
  await assert.rejects(()=>core.execute('transfer_mesh_receive',{peer:'PC',id:f.id,dest:f.dest}),
    /DESTINATION_TRUSTED_LINUX_ANCESTRY_REQUIRED/);
  assert.equal(fs.existsSync(path.join(f.dest,'sample.bin')),false);
 }finally{f.close();}
});
test('Core leaves default receive unchanged when strict ancestry is disabled',async t=>{
 if(process.platform!=='linux')return t.skip('Linux-only Core');
 const f=fixture('strict-coredefault-05');
 try{
  const r=await f.tools(false).execute('transfer_mesh_receive',{peer:'PC',id:f.id,dest:f.dest});
  assert.equal(r.status,'DELIVERED_HASH_VERIFIED');
  assert.deepEqual(fs.readFileSync(path.join(f.dest,'sample.bin')),f.data);
 }finally{f.close();}
});

test('strict mode denies hostile rename attempt before publishing',t=>{
 if(process.platform!=='linux'||process.geteuid()===0)return t.skip('non-root Linux policy');
 const f=fixture('strict-race-06');
 const hook=path.join(f.root,'pre-rename-hook.cjs'),marker=path.join(f.root,'rename-reached');
 const outside=path.join(f.root,'outside');
 fs.mkdirSync(outside);
 try{
  fs.writeFileSync(hook,[
   "const fs=require('node:fs'),mod=require('node:module');",
   "const old=fs.existsSync;let done=false;",
   "fs.existsSync=function(p,...args){",
   " if(!done&&String(p).startsWith('/proc/self/fd/')&&String(p).endsWith('/sample.bin')){",
   "  done=true;fs.renameSync(process.env.TVL_DEST,process.env.TVL_OUTSIDE+'/moved');",
   "  fs.writeFileSync(process.env.TVL_MARKER,'RENAME_REACHED');",
   " }return old.call(this,p,...args);};mod.syncBuiltinESMExports();"
  ].join('\n'));
  const st=fs.lstatSync(f.dest,{bigint:true});
  const r=spawnSync(process.execPath,[cli,'receive','--peer','PC','--id',f.id,'--dest',f.dest,
   '--dest-dev',String(st.dev),'--dest-ino',String(st.ino),'--require-trusted-linux-ancestry','1'],{
   env:{...process.env,COMMANDER_TRANSFER_HOME:f.root,NODE_OPTIONS:'--require='+hook,
    TVL_DEST:f.dest,TVL_OUTSIDE:outside,TVL_MARKER:marker},
   encoding:'utf8',timeout:12000
  });
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/DESTINATION_TRUSTED_LINUX_ANCESTRY_REQUIRED/);
  assert.equal(fs.existsSync(marker),false,'untrusted parent rejected before hostile rename hook');
  assert.equal(fs.existsSync(path.join(outside,'moved','sample.bin')),false);
  assert.equal(fs.existsSync(path.join(f.dest,'sample.bin')),false);
 }finally{f.close();}
});
test('strict Linux ancestry config fails closed on non-Linux rather than silently downgrading',async t=>{
 if(process.platform==='linux')return t.skip('unsupported-platform contract');
 const f=fixture('strict-win-07');
 try{
  await assert.rejects(()=>f.tools(true).execute('transfer_mesh_receive',{peer:'PC',id:f.id,dest:f.dest}),
   /TRANSFER_TRUSTED_LINUX_ANCESTRY_UNSUPPORTED/);
  assert.equal(fs.existsSync(path.join(f.dest,'sample.bin')),false);
 }finally{f.close();}
});

test('Core rejects malformed strict ancestry configuration instead of silent downgrade',t=>{
 if(process.platform!=='linux')return t.skip('Linux only');
 const f=fixture('strict-badconfig-09');
 try{
  assert.throws(()=>createTransferMeshTools({config:{powerMode:{enabled:true},transferMesh:{
   enabled:true,root:f.root,sourceRoots:[f.root],destinationRoots:[f.dest],
   requireTrustedLinuxAncestry:'true'
  }}}),/TRANSFER_TRUSTED_LINUX_ANCESTRY_CONFIG_INVALID/);
 }finally{f.close();}
});
test('Linux strict ancestry permits root-managed parent and blocks live rename of approved leaf',t=>{
 if(process.platform!=='linux')return t.skip('Linux separate-principal contract');
 const parent=process.env.TVL_TRUSTED_ANCESTRY_PARENT;
 if(!parent)return t.skip('positive fixture requires ephemeral root-provisioned parent');
 assert.notEqual(process.geteuid(),0,'positive fixture cannot run as root');
 const s=fs.lstatSync(parent);
 assert.equal(s.uid,0,'parent must be owned by independent root principal');
 assert.equal(s.mode&0o022,0,'trusted parent cannot be group/other writable');
 const dest=path.join(parent,'admitted');
 assert.equal(fs.lstatSync(dest).uid,process.geteuid(),'receiver must own approved leaf, not its parent');
 const f=fixture('strict-trusted-08',dest);
 const marker=path.join(f.root,'attempted-rename');
 const outside=path.join(f.root,'outside');fs.mkdirSync(outside);
 const hook=path.join(f.root,'rename-hook.cjs');
 try{
  fs.writeFileSync(hook,[
   "const fs=require('node:fs'),mod=require('node:module');",
   "const oldExists=fs.existsSync,oldRename=fs.renameSync;let done=false;",
   "fs.existsSync=function(p,...args){",
   " if(!done&&String(p).startsWith('/proc/self/fd/')&&String(p).endsWith('/sample.bin')){",
   "  done=true;let outcome='MOVED';",
   "  try{oldRename(process.env.TVL_DEST,process.env.TVL_OUTSIDE+'/moved');}",
   "  catch(e){outcome='BLOCKED_'+String(e.code||'ERROR');}",
   "  fs.writeFileSync(process.env.TVL_MARKER,outcome);",
   " }return oldExists.call(this,p,...args);};mod.syncBuiltinESMExports();"
  ].join('\n'));
  const st=fs.lstatSync(dest,{bigint:true});
  const r=spawnSync(process.execPath,[cli,'receive','--peer','PC','--id',f.id,'--dest',dest,
   '--dest-dev',String(st.dev),'--dest-ino',String(st.ino),'--require-trusted-linux-ancestry','1'],{
   env:{...process.env,COMMANDER_TRANSFER_HOME:f.root,NODE_OPTIONS:'--require='+hook,
    TVL_DEST:dest,TVL_OUTSIDE:outside,TVL_MARKER:marker},
   encoding:'utf8',timeout:15000
  });
  assert.equal(r.status,0,r.stderr);
  assert.equal(JSON.parse(r.stdout).status,'DELIVERED_HASH_VERIFIED');
  assert.ok(fs.existsSync(marker),'attack reached actual final-target publication');
  assert.match(fs.readFileSync(marker,'utf8'),/^BLOCKED_/,
    'root-controlled parent must deny leaf rename');
  assert.equal(fs.existsSync(path.join(outside,'moved','sample.bin')),false);
  assert.deepEqual(fs.readFileSync(path.join(dest,'sample.bin')),f.data);
 }finally{
  if(fs.existsSync(path.join(dest,'sample.bin')))fs.unlinkSync(path.join(dest,'sample.bin'));
  f.close();
 }
});
