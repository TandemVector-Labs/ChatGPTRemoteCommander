import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cli=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../tools/commander-transfer-mesh/pilot-cli.mjs');
function fixture(id){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-devino-'));
 const dest=path.join(root,'out'),input=Buffer.from('disposable identity-bound payload');
 const inbound=path.join(root,'pairs','PC','transfers',id);
 fs.mkdirSync(dest);
 fs.mkdirSync(inbound,{recursive:true});
 fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({alias:'Linux',schema:'ctmesh-node-v1'}));
 fs.writeFileSync(path.join(inbound,'payload.bin'),input);
 fs.writeFileSync(path.join(inbound,'manifest.json'),JSON.stringify({
  schema:'ctmesh-v1',id,from:'PC',to:'Linux',name:'sample.bin',
  bytes:input.length,sha256:crypto.createHash('sha256').update(input).digest('hex'),
  createdAt:new Date().toISOString()
 })+'\n');
 const stats=fs.lstatSync(dest,{bigint:true});
 function run(...extra){return spawnSync(process.execPath,[cli,'receive','--peer','PC','--id',id,'--dest',dest,...extra],
  {env:{...process.env,COMMANDER_TRANSFER_HOME:root},encoding:'utf8',timeout:12000,windowsHide:true});}
 return {root,dest,input,stats,run,close:()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50})};
}
for(const kind of ['mismatch','match','incomplete','invalid']){
 test('Core-to-Pilot destination identity '+kind,()=>{
  const f=fixture('devino-'+kind+'-001');
  try{
   const flags=kind==='mismatch'?['--dest-dev',String(f.stats.dev),'--dest-ino',String(f.stats.ino+1n)]
     :kind==='match'?['--dest-dev',String(f.stats.dev),'--dest-ino',String(f.stats.ino)]
     :kind==='incomplete'?['--dest-dev',String(f.stats.dev)]
     :['--dest-dev','oops','--dest-ino',String(f.stats.ino)];
   const res=f.run(...flags);
   if(kind==='match'){
    assert.equal(res.status,0,res.stderr);
    assert.deepEqual(fs.readFileSync(path.join(f.dest,'sample.bin')),f.input);
    assert.equal(JSON.parse(res.stdout).status,'DELIVERED_HASH_VERIFIED');
   }else{
    assert.notEqual(res.status,0);
    assert.match(res.stderr,new RegExp(kind==='mismatch'?'DESTINATION_IDENTITY_CHANGED'
       :kind==='incomplete'?'DESTINATION_IDENTITY_INCOMPLETE':'DESTINATION_IDENTITY_INVALID'));
    assert.equal(fs.existsSync(path.join(f.dest,'sample.bin')),false);
   }
  }finally{f.close();}
 });
}
