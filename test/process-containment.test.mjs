import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import {
  isTrustedProcessCessationProof,
  isSerializedProcessCessationProof,
  serializeProcessCessationProof,
  runContainedProjectCommand,
  processContainmentAvailable
} from '../src/process-containment.mjs';

function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-contained-command-'));
  const operationId=randomUUID();
  const binding={
    workflowId:'flowproof',stepId:'prove',operationId,
    rootFingerprint:createHash('sha256').update(root).digest('hex'),
    revision:7,
    leaseId:createHash('sha256').update('lease:'+operationId).digest('hex'),
    fencingToken:19
  };
  return {root,binding};
}
test('contained commands reject unsafe timer bounds before touching native process providers',async()=>{
  const {root,binding}=fixture();
  let coerced=false;
  const trap={valueOf(){coerced=true;throw Error('UNTRUSTED_COERCION');}};
  try{
    for(const timeoutMs of [
      undefined,null,NaN,Infinity,-Infinity,0,-1,999,3600001,
      2147483648,1.5,'1000','30000',trap
    ]){
      await assert.rejects(
        runContainedProjectCommand({
          program:'this-command-must-never-be-started',args:[],cwd:root,
          timeoutMs,outputLimit:32768,env:process.env,binding
        }),
        error=>error?.workflowCode==='PROCESS_CONTAINMENT_TIMEOUT_INVALID',
        'invalid timeout should fail before any native operation'
      );
    }
    assert.equal(coerced,false,'caller-controlled valueOf must not be invoked');
    assert.deepEqual(fs.readdirSync(root),[],'rejected invocations leave no artifacts');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('trusted cessation proofs cannot be minted through public module exports',async()=>{
  const api=await import('../src/process-containment.mjs');
  assert.equal(Object.hasOwn(api,'issueTrustedProcessCessationProof'),false);
  const {root,binding}=fixture();
  try{
    const fabricated={
      schema:1,...binding,provider:'test-provider',runId:binding.operationId,
      activeProcesses:0,verified:true,outcome:'fabricated',cleanupRequired:false,
      completedAt:new Date().toISOString(),proofDigest:'0'.repeat(64)
    };
    assert.equal(isTrustedProcessCessationProof(fabricated,binding),false);
    assert.equal(serializeProcessCessationProof(fabricated),null);
    assert.equal(isSerializedProcessCessationProof(fabricated,binding),false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('Windows Job Object PID-list parser matches the Win32 DWORD header and pointer-sized PID array',()=>{
  const runner=fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','tools','run-owned-process-tree-windows.ps1'),'utf8');
  assert.match(runner,/int headerBytes=8;/);
  assert.match(runner,/UInt32 assigned=unchecked\(\(UInt32\)Marshal\.ReadInt32\(mem,0\)\)/);
  assert.match(runner,/UInt32 count=unchecked\(\(UInt32\)Marshal\.ReadInt32\(mem,4\)\)/);
  assert.match(runner,/Marshal\.ReadIntPtr\(mem,headerBytes\+\(i\*IntPtr\.Size\)\)/);
  assert.match(runner,/count!=assigned \|\| count>\(UInt32\)capacity/);
});

test('Linux systemd ExitType=cgroup waits for detached descendants before issuing proof', {
  timeout:20000
}, async t=>{
  if(process.platform!=='linux' || !(await processContainmentAvailable())) return t.skip('host-local systemd cgroup provider unavailable');
  const {root,binding}=fixture();
  try{
    const marker=path.join(root,'descendant-completed.txt');
    const command=`setsid /bin/sh -c 'sleep 1; printf completed > "${marker}"' </dev/null >/dev/null 2>&1 & printf main-complete`;
    const result=await runContainedProjectCommand({
      program:'/bin/bash',args:['-c',command],cwd:root,timeoutMs:10000,
      outputLimit:32768,env:process.env,binding
    });
    assert.equal(result.exitCode,0,JSON.stringify(result));
    assert.equal(result.isError,false,JSON.stringify(result));
    assert.equal(result.containment.verified,true,JSON.stringify(result.containment));
    assert.equal(result.containment.activeProcesses,0);
    assert.equal(fs.readFileSync(marker,'utf8'),'completed','the contained runner must wait for the detached descendant');
    assert.ok(isTrustedProcessCessationProof(result.processCessationProof,binding));
    const persisted=serializeProcessCessationProof(result.processCessationProof);
    assert.ok(isSerializedProcessCessationProof(persisted,binding));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('Linux timeout cleanup kills detached descendants and still proves an empty cgroup', {
  timeout:20000
}, async t=>{
  if(process.platform!=='linux' || !(await processContainmentAvailable())) return t.skip('host-local systemd cgroup provider unavailable');
  const {root,binding}=fixture();
  try{
    const marker=path.join(root,'must-not-appear.txt');
    const command=`setsid /bin/sh -c 'sleep 3; printf leaked > "${marker}"' </dev/null >/dev/null 2>&1 & printf main-exited`;
    const result=await runContainedProjectCommand({
      program:'/bin/bash',args:['-c',command],cwd:root,timeoutMs:1000,
      outputLimit:32768,env:process.env,binding
    });
    assert.equal(result.timedOut,true,JSON.stringify(result));
    assert.equal(result.containment.verified,true,JSON.stringify(result.containment));
    assert.equal(result.containment.activeProcesses,0);
    assert.ok(isTrustedProcessCessationProof(result.processCessationProof,binding));
    await new Promise(resolve=>setTimeout(resolve,3200));
    assert.equal(fs.existsSync(marker),false,'a killed descendant must not perform a delayed mutation');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('Windows Job Object waits for detached descendants before issuing proof', {
  timeout:25000
}, async t=>{
  if(process.platform!=='win32' || !(await processContainmentAvailable())) return t.skip('host-local Windows Job Object provider unavailable');
  const {root,binding}=fixture();
  try{
    const marker=path.join(root,'descendant-completed.txt');
    const childScript=path.join(root,'child.ps1');
    const escapedMarker=marker.replaceAll("'","''");
    fs.writeFileSync(childScript,`Start-Sleep -Seconds 1\nSet-Content -LiteralPath '${escapedMarker}' -Value 'completed'\n`);
    const childArgs=`-NoProfile -NonInteractive -File "${childScript}"`;
    const parentScript=`Start-Process -FilePath 'pwsh.exe' -ArgumentList '${childArgs}' | Out-Null; Write-Output 'parent-done'`;
    const result=await runContainedProjectCommand({
      program:'pwsh.exe',args:['-NoProfile','-NonInteractive','-Command',parentScript],
      cwd:root,timeoutMs:10000,outputLimit:32768,env:process.env,binding
    });
    assert.equal(result.exitCode,0,JSON.stringify(result));
    assert.equal(result.isError,false,JSON.stringify(result));
    assert.equal(result.containment.verified,true,JSON.stringify(result.containment));
    assert.equal(result.containment.cleanupVerified,true,JSON.stringify(result.containment));
    assert.equal(result.containment.activeAfterCleanup,0);
    assert.equal(fs.readFileSync(marker,'utf8').trim(),'completed');
    assert.ok(isTrustedProcessCessationProof(result.processCessationProof,binding));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('Windows Job Object terminates a descendant that outlives an exited parent before proof', {
  timeout:25000
}, async t=>{
  if(process.platform!=='win32' || !(await processContainmentAvailable())) return t.skip('host-local Windows Job Object provider unavailable');
  const {root,binding}=fixture();
  try{
    const marker=path.join(root,'must-not-appear-after-parent-exit.txt');
    const escapedMarker=marker.replaceAll("'","''");
    const childScript=path.join(root,'child.ps1');
    fs.writeFileSync(childScript,`Start-Sleep -Seconds 4\nSet-Content -LiteralPath '${escapedMarker}' -Value 'leaked'\n`);
    const childArgs=`-NoProfile -NonInteractive -File "${childScript}"`;
    const parentScript=`Start-Process -FilePath 'pwsh.exe' -ArgumentList '${childArgs}' | Out-Null; Write-Output 'parent-done'`;
    const result=await runContainedProjectCommand({
      program:'pwsh.exe',args:['-NoProfile','-NonInteractive','-Command',parentScript],
      cwd:root,timeoutMs:10000,outputLimit:32768,env:process.env,binding
    });
    assert.equal(result.timedOut,false,JSON.stringify(result));
    assert.equal(result.exitCode,125,JSON.stringify(result));
    assert.equal(result.isError,false,JSON.stringify(result));
    assert.equal(result.containment.status,'DESCENDANT_LEAK_CLEANED',JSON.stringify(result.containment));
    assert.equal(result.containment.cleanupRequired,true,JSON.stringify(result.containment));
    assert.equal(result.containment.cleanupVerified,true,JSON.stringify(result.containment));
    assert.ok(result.containment.activeBeforeCleanup>0,JSON.stringify(result.containment));
    assert.equal(result.containment.activeAfterCleanup,0);
    assert.ok(isTrustedProcessCessationProof(result.processCessationProof,binding));
    await new Promise(resolve=>setTimeout(resolve,4300));
    assert.equal(fs.existsSync(marker),false,'a descendant outliving its parent must be terminated before proof');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('Windows Job Object timeout kills every owned descendant before proof', {
  timeout:25000
}, async t=>{
  if(process.platform!=='win32' || !(await processContainmentAvailable())) return t.skip('host-local Windows Job Object provider unavailable');
  const {root,binding}=fixture();
  try{
    const marker=path.join(root,'must-not-appear.txt');
    const escapedMarker=marker.replaceAll("'","''");
    const childScript=path.join(root,'child.ps1');
    fs.writeFileSync(childScript,`Start-Sleep -Seconds 8\nSet-Content -LiteralPath '${escapedMarker}' -Value 'leaked'\n`);
    const childArgs=`-NoProfile -NonInteractive -File "${childScript}"`;
    const parentScript=`Start-Process -FilePath 'pwsh.exe' -ArgumentList '${childArgs}' | Out-Null; Start-Sleep -Seconds 10; Write-Output 'parent-done'`;
    const result=await runContainedProjectCommand({
      program:'pwsh.exe',args:['-NoProfile','-NonInteractive','-Command',parentScript],
      cwd:root,timeoutMs:3000,outputLimit:32768,env:process.env,binding
    });
    assert.equal(result.timedOut,true,JSON.stringify(result));
    assert.equal(result.containment.verified,true,JSON.stringify(result.containment));
    assert.equal(result.containment.cleanupVerified,true,JSON.stringify(result.containment));
    assert.equal(result.containment.cleanupRequired,true,JSON.stringify(result.containment));
    assert.ok(result.containment.activeBeforeCleanup >= 2,JSON.stringify(result.containment));
    assert.equal(result.containment.activeAfterCleanup,0);
    assert.ok(isTrustedProcessCessationProof(result.processCessationProof,binding));
    await new Promise(resolve=>setTimeout(resolve,6000));
    assert.equal(fs.existsSync(marker),false,'a killed Windows job descendant must not perform a delayed mutation');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
