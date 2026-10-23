import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';

test('Core-to-Pilot source ancestor replacement must not send an out-of-allowlist file',async t=>{
 if(process.platform!=='linux'){t.skip('Linux-only source-root race');return;}
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-pilot-core-'));
 const allowed=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-allowed-'));
 const outside=fs.mkdtempSync(path.join(os.tmpdir(),'ctmesh-outside-'));
 const pilot=path.resolve(import.meta.dirname,'../tools/commander-transfer-mesh/pilot-cli.mjs');
 const sourceDir=path.join(allowed,'movable'),source=path.join(sourceDir,'sample.bin');
 const destination=path.join(outside,'sample.bin'),id='core-allowed-race-001';
 const oldExec=cp.execFile; let swapped=false;
 try{
  fs.mkdirSync(sourceDir);
  fs.writeFileSync(source,'ALLOWED-BY-CORE');
  fs.writeFileSync(destination,'UNAUTHORIZED-DATA');
  fs.writeFileSync(path.join(root,'node.json'),JSON.stringify({schema:'ctmesh-node-v1',alias:'PC'}));
  fs.copyFileSync(pilot,path.join(root,'transfer.mjs'));
  cp.execFile=function(file,args,options,callback){
   if(!swapped&&args[1]==='send'){
    swapped=true;
    fs.renameSync(sourceDir,sourceDir+'.original');
    fs.symlinkSync(outside,sourceDir,'dir');
   }
   return oldExec.call(this,file,args,options,callback);
  };
  // Preserve execFile's native promisify contract so the test hook retains {stdout,stderr}.
  const sym=Symbol.for('nodejs.util.promisify.custom');
  cp.execFile[sym]=function(file,args,options){
   if(!swapped&&args[1]==='send'){
    swapped=true;
    fs.renameSync(sourceDir,sourceDir+'.original');
    fs.symlinkSync(outside,sourceDir,'dir');
   }
   return oldExec[sym](file,args,options);
  };
  syncBuiltinESMExports();
  const {createTransferMeshTools}=await import('../src/transfer-tools.mjs');
  const app=createTransferMeshTools({config:{powerMode:{enabled:true},
   transferMesh:{enabled:true,root,sourceRoots:[allowed],destinationRoots:[allowed],maxSourceBytes:1024}}});
  let result,error;
  try{result=await app.execute('transfer_mesh_send',{peer:'Linux',path:source,id});}
  catch(e){error=e;}
  assert.equal(swapped,true,'Adversarial ancestor replacement must fire after Core policy check');
  const payload=path.join(root,'pairs','Linux','transfers',id,'payload.bin');
  const hasOutside=fs.existsSync(payload)&&fs.readFileSync(payload,'utf8')==='UNAUTHORIZED-DATA';
  assert.equal(hasOutside,false,'Out-of-allowlist source must not be queued; status='+result?.status+' error='+error?.message);
 }finally{
  cp.execFile=oldExec;syncBuiltinESMExports();
  fs.rmSync(root,{recursive:true,force:true});
  fs.rmSync(allowed,{recursive:true,force:true});
  fs.rmSync(outside,{recursive:true,force:true});
 }
});
