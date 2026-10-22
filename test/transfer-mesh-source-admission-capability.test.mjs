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
