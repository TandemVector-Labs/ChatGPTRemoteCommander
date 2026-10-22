import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';

const cli=path.resolve(import.meta.dirname,'pilot-cli.mjs');

test('Linux outgoing send must not copy swapped source symlink contents',t=>{
 if(process.platform!=='linux'){t.skip('Linux-only source-swap regression');return;}
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-source-swap-'));
 const outside=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-external-secret-'));
 try{
  fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias:'PC',schema:'ctmesh-node-v1'}));
  const original=Buffer.from('PUBLIC-CONTENT-0123456789'),secret=Buffer.from('SECRET-CONTENT-0123456789');
  assert.equal(original.length,secret.length);
  const source=path.join(root,'source.bin'),other=path.join(outside,'outside-secret.bin');
  fs.writeFileSync(source,original);fs.writeFileSync(other,secret);
  const timestamp=new Date('2020-01-01T00:00:00.000Z');
  fs.utimesSync(source,timestamp,timestamp);fs.utimesSync(other,timestamp,timestamp);
  const marker=path.join(root,'attack.marker'),hook=path.join(root,'hook.cjs'),id='source-swap-001';
  fs.writeFileSync(hook,[
   "const fs=require('node:fs'),mod=require('node:module');",
   "const old=fs.lstatSync;let fired=false;",
   "fs.lstatSync=function(file,...args){",
   " const result=old.call(this,file,...args);",
   " if(!fired&&String(file)===process.env.RC_SOURCE){fired=true;",
   "  fs.renameSync(file,file+'.original');",
   "  fs.symlinkSync(process.env.RC_SECRET,file,'file');",
   "  fs.writeFileSync(process.env.RC_MARKER,'SOURCE_SWAP_FIRED');",
   " }",
   " return result;};mod.syncBuiltinESMExports();"
  ].join('\n'));
  const result=spawnSync(process.execPath,['--require',hook,cli,'send','--peer','Linux','--path',source,'--id',id],{
   encoding:'utf8',timeout:15000,env:{...process.env,COMMANDER_TRANSFER_HOME:root,RC_SOURCE:source,RC_SECRET:other,RC_MARKER:marker}
  });
  assert.equal(fs.existsSync(marker),true,'Adversarial source pathname replacement must execute');
  const payload=path.join(root,'pairs','Linux','transfers',id,'payload.bin');
  const staged=path.join(root,'staging','Linux',id+'.part');
  const leaked=[payload,staged].some(p=>fs.existsSync(p)&&fs.readFileSync(p).equals(secret));
  assert.equal(leaked,false,'Outside secret contents must never be staged via swapped source path; exit='+result.status);
 }finally{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});}
});

test('Linux outgoing send rejects same-metadata replacement by a different regular inode',t=>{
 if(process.platform!=='linux'){t.skip('Linux-only source identity regression');return;}
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-inode-swap-'));
 try{
  fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias:'PC',schema:'ctmesh-node-v1'}));
  const source=path.join(root,'source.bin'),attacker=path.join(root,'other.bin'),id='source-inode-001';
  fs.writeFileSync(source,'ORIGINAL-CONTENT');
  fs.writeFileSync(attacker,'FORGEDXX-CONTENT');
  const date=new Date('2020-01-01T00:00:00.000Z');
  fs.utimesSync(source,date,date);fs.utimesSync(attacker,date,date);
  const marker=path.join(root,'swapped.marker'),hook=path.join(root,'swap.cjs');
  fs.writeFileSync(hook,[
   "const fs=require('node:fs'),mod=require('node:module');",
   "const old=fs.lstatSync;let fired=false;",
   "fs.lstatSync=function(p,...args){const st=old.call(this,p,...args);",
   "if(!fired&&String(p)===process.env.RC_SOURCE){fired=true;",
   "fs.renameSync(p,p+'.original');fs.renameSync(process.env.RC_ATTACKER,p);",
   "fs.writeFileSync(process.env.RC_MARKER,'INODE_SWAPPED');}",
   "return st;};mod.syncBuiltinESMExports();"
  ].join('\n'));
  const v=spawnSync(process.execPath,['--require',hook,cli,'send','--peer','Linux','--path',source,'--id',id],{
   encoding:'utf8',timeout:15000,env:{...process.env,COMMANDER_TRANSFER_HOME:root,RC_SOURCE:source,RC_ATTACKER:attacker,RC_MARKER:marker}
  });
  assert.equal(fs.existsSync(marker),true,'Exact-inode swap must fire');
  const out=path.join(root,'pairs','Linux','transfers',id,'payload.bin');
  assert.equal(fs.existsSync(out)&&fs.readFileSync(out,'utf8')==='FORGEDXX-CONTENT',false,
   'Alternative regular inode must never be accepted as original');
  assert.notEqual(v.status,0,'Original inode mismatch must fail closed');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('Linux outgoing send binds source descriptor through pathname replacement during copy',t=>{
 if(process.platform!=='linux'){t.skip('Linux-only held-source-fd regression');return;}
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-open-fd-race-'));
 const outside=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-original-source-'));
 try{
  fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias:'PC',schema:'ctmesh-node-v1'}));
  const source=path.join(root,'source.bin'),other=path.join(outside,'secret.bin'),id='source-open-fd-001';
  fs.writeFileSync(source,'ORIGINAL-CONTENT');fs.writeFileSync(other,'SENSITIVE-CONTENT');
  const marker=path.join(root,'swapped.marker'),hook=path.join(root,'source-fd-hook.cjs');
  fs.writeFileSync(hook,[
   "const fs=require('node:fs'),mod=require('node:module');",
   "const old=fs.copyFileSync;let fired=false;",
   "fs.copyFileSync=function(from,to,...args){",
   "if(!fired&&String(from).startsWith('/proc/self/fd/')){fired=true;",
   "fs.renameSync(process.env.RC_SOURCE,process.env.RC_SOURCE+'.original');",
   "fs.symlinkSync(process.env.RC_SECRET,process.env.RC_SOURCE,'file');",
   "fs.writeFileSync(process.env.RC_MARKER,'POST_OPEN_SWAP');}",
   "return old.call(this,from,to,...args);};mod.syncBuiltinESMExports();"
  ].join('\n'));
  const v=spawnSync(process.execPath,['--require',hook,cli,'send','--peer','Linux','--path',source,'--id',id],{
   encoding:'utf8',timeout:15000,env:{...process.env,COMMANDER_TRANSFER_HOME:root,RC_SOURCE:source,RC_SECRET:other,RC_MARKER:marker}
  });
  assert.equal(fs.existsSync(marker),true,'Swap after opening verified source descriptor must occur');
  const published=path.join(root,'pairs','Linux','transfers',id,'payload.bin');
  const staged=path.join(root,'staging','Linux',id+'.part');
  for(const p of [published,staged])if(fs.existsSync(p))
   assert.notEqual(fs.readFileSync(p,'utf8'),'SENSITIVE-CONTENT','An alternate source must not become outgoing bytes');
  assert.notEqual(v.status,0,'Replaced source pathname must fail closed');
 }finally{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});}
});
