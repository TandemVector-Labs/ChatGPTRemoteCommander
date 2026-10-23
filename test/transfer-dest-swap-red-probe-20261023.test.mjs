import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTransferMeshTools } from '../src/transfer-tools.mjs';

test('GREEN: native child rejects substituted destination after Core admission', async (t) => {
  // This fixture substitutes a Windows directory junction. Linux admission has
  // a separate capability and descriptor-bound path security contract.
  if(process.platform!=='win32')return t.skip('Win32 junction/NT handle race fixture');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(),'rc-dest-swap-qa-'));
  const a = path.join(sandbox,'a'), b=path.join(sandbox,'b'), outside=path.join(sandbox,'outside');
  const src=path.join(a,'inputs'), dstRoot=path.join(b,'outputs'), dest=path.join(dstRoot,'allowed');
  const hook=path.join(sandbox,'swap-hook.cjs'), marker=path.join(sandbox,'swap-marker');
  const save = process.env.NODE_OPTIONS;
  try {
    for(const p of [a,b,outside,src,dest])fs.mkdirSync(p,{recursive:true});
    const cli=path.resolve('tools/commander-transfer-mesh/pilot-cli.mjs');
    for(const [p,alias] of [[a,'PC'],[b,'Linux']]){
      fs.copyFileSync(cli,path.join(p,'transfer.mjs'));
      fs.writeFileSync(path.join(p,'node.json'),JSON.stringify({alias,schema:'ctmesh-node-v1'}));
    }
    const sender=createTransferMeshTools({config:{powerMode:{enabled:true},transferMesh:{
      enabled:true,root:a,sourceRoots:[src],destinationRoots:[src]}}});
    const file=path.join(src,'outside-boundary-sentinel.dat');
    fs.writeFileSync(file,'ONLY-SYNTHETIC-TEST-CONTENT');
    assert.equal((await sender.execute('transfer_mesh_send',{peer:'Linux',path:file,id:'dest-swap-qa-001'})).status,'QUEUED');
    const incoming=path.join(b,'pairs','PC','transfers','dest-swap-qa-001');
    fs.mkdirSync(path.dirname(incoming),{recursive:true});
    fs.cpSync(path.join(a,'pairs','Linux','transfers','dest-swap-qa-001'),incoming,{recursive:true});
    fs.writeFileSync(hook,[
      "const fs=require('node:fs'),path=require('node:path');",
      "fs.writeFileSync(process.env.RC_DEST_SWAP_MARKER+'.loaded',process.argv.join('|'));",
      "const original=fs.lstatSync;let swapped=false;",
      "fs.lstatSync=function(dir,...args){",
      " if(!swapped&&process.argv.includes('receive')&&path.resolve(String(dir)).toLowerCase()===process.env.RC_DEST_SWAP_TARGET.toLowerCase()){",
      "  swapped=true;",
      "  fs.renameSync(dir,String(dir)+'.original');",
      "  fs.symlinkSync(process.env.RC_DEST_SWAP_OUTSIDE,dir,process.platform==='win32'?'junction':'dir');",
      "  fs.writeFileSync(process.env.RC_DEST_SWAP_MARKER,'SWAPPED_BEFORE_RECEIVE');",
      " }",
      " return original.call(this,dir,...args);",
      "};"
    ].join('\n'));
    process.env.NODE_OPTIONS='--require='+hook;
    process.env.RC_DEST_SWAP_TARGET=dest;
    process.env.RC_DEST_SWAP_OUTSIDE=outside;
    process.env.RC_DEST_SWAP_MARKER=marker;
    const receiver=createTransferMeshTools({config:{powerMode:{enabled:true},transferMesh:{
      enabled:true,root:b,sourceRoots:[dstRoot],destinationRoots:[dstRoot]}}});
    let result,error;
    try{result=await receiver.execute('transfer_mesh_receive',{peer:'PC',id:'dest-swap-qa-001',dest});}
    catch(e){error=String(e.message);}
    const outsideFile=path.join(outside,path.basename(file));
    const markerFired=fs.existsSync(marker);
    const escaped=fs.existsSync(outsideFile);
    t.diagnostic(JSON.stringify({markerFired,hookLoaded:fs.existsSync(marker+'.loaded'),escaped,status:result?.status,errorCode:(error||'').match(/CTMESH_ERROR: ([A-Z_]+)/)?.[1]||null}));
    assert.equal(markerFired,true,'attack hook reached the actual native child');
    assert.equal(escaped,false,'payload must never materialize outside the admitted destination');
    assert.equal(result,undefined,'substituted destination must not report delivered');
    assert.match(error||'',/DESTINATION_PIN_FAILED|DESTINATION_IDENTITY_CHANGED|DESTINATION_ANCESTOR_REJECTED/);
  } finally {
    if(save===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=save;
    for(const k of ['RC_DEST_SWAP_TARGET','RC_DEST_SWAP_OUTSIDE','RC_DEST_SWAP_MARKER'])delete process.env[k];
    try{const l=fs.lstatSync(dest);if(l.isSymbolicLink())fs.rmdirSync(dest);}catch{}
    fs.rmSync(sandbox,{recursive:true,force:true});
  }
});
