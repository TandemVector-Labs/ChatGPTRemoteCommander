import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createTransferMeshTools} from '../src/transfer-tools.mjs';

test('Linux Core refuses legacy Pilot before sensitive send is invoked',async t=>{
 if(process.platform!=='linux'){t.skip('Linux source-admission contract only');return;}
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-legacy-root-'));
 const allowed=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-legacy-allowed-'));
 try{
  const file=path.join(allowed,'approved.bin'),marker=path.join(root,'legacy-send-executed');
  fs.writeFileSync(file,'synthetic only');
  fs.writeFileSync(path.join(root,'transfer.mjs'),[
   "import fs from 'node:fs';",
   "import path from 'node:path';",
   "if(process.argv[2]==='source-admission-capabilities') process.stdout.write('{}\\n');",
   "else if(process.argv[2]==='send'){",
   "fs.writeFileSync(path.join(process.env.COMMANDER_TRANSFER_HOME,'legacy-send-executed'),'UNSAFE');",
   "process.stdout.write('{\\\"status\\\":\\\"QUEUED\\\"}\\n');}"
  ].join('\n'));
  assert.equal(execFileSync(process.execPath,[path.join(root,'transfer.mjs'),'source-admission-capabilities'],{encoding:'utf8'}).trim(),'{}','Legacy stub must be a functioning process');
  const service=createTransferMeshTools({config:{powerMode:{enabled:true},
   transferMesh:{enabled:true,root,sourceRoots:[allowed],destinationRoots:[allowed],maxSourceBytes:1024}}});
  await assert.rejects(()=>service.execute('transfer_mesh_send',{
   peer:'Linux',path:file,id:'legacy-refused-001'
  }),/TRANSFER_SOURCE_BACKEND_INCOMPATIBLE/);
  assert.equal(fs.existsSync(marker),false,'Unqualified backend must never execute send');
 }finally{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(allowed,{recursive:true,force:true});}
});

test('Linux Core rechecks size limit on the exact inode admitted to Pilot after race',async t=>{
 if(process.platform!=='linux'){t.skip('Linux synthetic source admission');return;}
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-quota-control-'));
 const allow=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-quota-allow-'));
 const source=path.join(allow,'source.bin'), replacement=path.join(allow,'replacement.bin'),id='quota-swap-001';
 const cli=path.resolve(import.meta.dirname,'../tools/commander-transfer-mesh/pilot-cli.mjs');
 const originalStat=fs.statSync;let fired=false;
 try{
  fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({schema:'ctmesh-node-v1',alias:'PC'}));
  fs.copyFileSync(cli,path.join(root,'transfer.mjs'));
  fs.writeFileSync(source,Buffer.alloc(8,65));
  fs.writeFileSync(replacement,Buffer.alloc(2048,66));
  const api=createTransferMeshTools({config:{powerMode:{enabled:true},
   transferMesh:{enabled:true,root,sourceRoots:[allow],destinationRoots:[allow],maxSourceBytes:16}}});
  fs.statSync=function(p,...args){const out=originalStat.call(this,p,...args);
   if(!fired&&p===source){fired=true;
    fs.renameSync(source,source+'.original');fs.renameSync(replacement,source);}
   return out;};
  let result,error;
  try{result=await api.execute('transfer_mesh_send',{peer:'Linux',path:source,id});}
  catch(e){error=e;}
  assert.equal(fired,true,'Attacker must replace source after initial size check');
  const payload=path.join(root,'pairs','Linux','transfers',id,'payload.bin');
  const oversized=fs.existsSync(payload)&&originalStat(payload).size>16;
  assert.equal(oversized,false,'Oversized bytes must not be staged; status='+result?.status+' error='+error?.message);
  assert.match(error?.message??'',/TRANSFER_SOURCE_SIZE_QUOTA/,'Reject oversized admitted inode');
 }finally{fs.statSync=originalStat;fs.rmSync(root,{recursive:true,force:true});fs.rmSync(allow,{recursive:true,force:true});}
});
