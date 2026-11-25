import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { executePowerTool } from '../src/power-tools-v0.3.mjs';
import { assessAccessStatus } from '../src/full-access-status.mjs';
import { shellSpec, shellName } from '../src/platform.mjs';

test('Linux shell execution ignores ambient SHELL executable replacement', {skip:process.platform!=='linux'},()=>{
  const old=process.env.SHELL;
  try{
    process.env.SHELL='/tmp/untrusted-shell-selection';
    assert.deepEqual(shellSpec('printf safe'),
      {file:'/bin/bash',args:['-c','printf safe']});
    assert.deepEqual(shellSpec('',true),
      {file:'/bin/bash',args:['--noprofile','--norc']});
    assert.equal(shellName(),'/bin/bash');
  }finally{
    if(old===undefined)delete process.env.SHELL;
    else process.env.SHELL=old;
  }
});

const digest=value=>createHash('sha256').update(value).digest('hex');
function fixture({required=true,run}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-v102-power-access-'));
  const config={
    capabilityProfile:{tier:'FULL_POWER',explicitlyAuthorized:true,disabledCapabilities:[]},
    powerMode:{
      enabled:true,fullFilesystem:true,allowShell:true,allowProcessControl:true,
      blockedShellPatterns:[],maxFileBytes:1024,
      backupRoot:path.join(root,'.backups'),backupRetentionSnapshots:2
    },
    executionAccess:{required}
  };
  const ctx={
    roots:[root],
    config,
    accessStatus:assessAccessStatus(config,null,{platform:'linux',effectiveUid:1000})
  };
  if(run)ctx.executionAccess={run};
  return {root,ctx,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}

test('required protected write fails closed without a trusted Host provider',async t=>{
  const f=fixture({required:true});t.after(f.cleanup);
  const target=path.join(f.root,'blocked.txt');
  await assert.rejects(
    executePowerTool(f.ctx,'write_file',{path:target,content:'must-not-write'}),
    error=>error?.code==='V102_EXECUTION_ACCESS_REQUIRED'
  );
  assert.equal(fs.existsSync(target),false);
});

test('required protected write executes only through the Host authorization callback',async t=>{
  const calls=[];
  const f=fixture({required:true,run:async(action,execute)=>{
    calls.push(action);
    const result=await execute();
    return {result,authorization:{grantId:'test-grant',authorized:true}};
  }});t.after(f.cleanup);
  const target=path.join(f.root,'approved.txt');
  const result=await executePowerTool(f.ctx,'write_file',{path:target,content:'approved'});
  assert.equal(fs.readFileSync(target,'utf8'),'approved');
  assert.equal(calls.length,1);
  assert.equal(calls[0].tool,'write_file');
  assert.deepEqual(calls[0].args,{path:target,content:'approved'});
  assert.equal(result.sha256,digest('approved'));
});

test('missing authorization receipt is rejected when provider does not execute the mutation',async t=>{
  const f=fixture({required:true,run:async()=>({result:null})});t.after(f.cleanup);
  const target=path.join(f.root,'unreceipted.txt');
  await assert.rejects(
    executePowerTool(f.ctx,'write_file',{path:target,content:'no-receipt'}),
    error=>error?.code==='V102_EXECUTION_RECEIPT_REQUIRED'
  );
  assert.equal(fs.existsSync(target),false);
});

test('unprotected read-only status remains available when protected effects require a provider',async t=>{
  const f=fixture({required:true});t.after(f.cleanup);
  f.ctx.config.powerMode.fullFilesystem=false;
  const result=await executePowerTool(f.ctx,'power_status',{});
  assert.equal(result.enabled,true);
  assert.equal(result.fullFilesystem,false);
});

test('profiles without required execution grants retain the legacy power-tool path',async t=>{
  const f=fixture({required:false});t.after(f.cleanup);
  const target=path.join(f.root,'legacy.txt');
  const result=await executePowerTool(f.ctx,'write_file',{path:target,content:'legacy'});
  assert.equal(fs.readFileSync(target,'utf8'),'legacy');
  assert.equal(result.sha256,digest('legacy'));
});
