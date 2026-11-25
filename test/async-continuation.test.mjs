import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAsyncOperationTools } from '../src/async-operations.mjs';

function fixture(){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'rc-async-continuation-'));
  const state=path.join(base,'state');
  const config={instance:{profile:'test'},asyncOperations:{stateDir:state,maxOutputBytes:1024*1024}};
  // The test spawns a real worker from the installed source tree. It must not
  // inherit the owner's config.local.json / production executionAccess policy.
  // A fixture-only config keeps the positive synthetic worker test isolated;
  // the native worker still enforces required grants for actual installations.
  const testConfigPath=path.join(base,'worker-config.json');
  fs.writeFileSync(testConfigPath,JSON.stringify({...config,executionAccess:{required:false}}),{mode:0o600});
  const inheritedConfigPath=process.env.REMOTE_COMMANDER_CONFIG;
  process.env.REMOTE_COMMANDER_CONFIG=testConfigPath;
  return {base,state,config,dispose:async()=>{
    const deadline=Date.now()+3000;
    try {
      while(true){
        try{fs.rmSync(base,{recursive:true,force:true,maxRetries:4,retryDelay:25});return;}
        catch(error){
          if(!['ENOTEMPTY','EBUSY','EPERM'].includes(error?.code)||Date.now()>=deadline)throw error;
          await new Promise(r=>setTimeout(r,25));
        }
      }
    } finally {
      if(inheritedConfigPath===undefined)delete process.env.REMOTE_COMMANDER_CONFIG;
      else process.env.REMOTE_COMMANDER_CONFIG=inheritedConfigPath;
    }
  }};
}
function timeout(ms){return new Promise((_,reject)=>setTimeout(()=>reject(new Error('TEST_TIMEOUT')),ms));}
async function waitTerminal(api,operationId,timeoutMs=2000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const state=await api.execute('operation_status',{operationId});
    if(['SUCCEEDED','FAILED','TIMED_OUT','CANCELLED','UNCERTAIN'].includes(state.status))return state;
    await new Promise(r=>setTimeout(r,20));
  }
  throw new Error('TERMINAL_WAIT_TIMEOUT');
}

test('operation terminal event triggers attached continuation without status polling',async()=>{
  const f=fixture();
  let validated=0;
  let resolveTerminal;
  const terminal=new Promise(r=>{resolveTerminal=r;});
  const api=createAsyncOperationTools({
    config:f.config,
    prepare:async()=>({file:process.execPath,args:['-e','setTimeout(()=>process.exit(0),80)'],cwd:f.base,timeoutMs:3000,outputLimit:65536}),
    validateContinuation:async c=>{validated+=1;assert.equal(c.projectId,'p1');assert.equal(c.root,f.base);},
    onTerminal:async state=>{resolveTerminal(state);return {handoffId:'handoff-1',state:'QUEUED'};}
  });
  try{
    const started=await api.execute('operation_start',{
      requestId:'req-1',tool:'run_project_command',arguments:{},
      continuation:{projectId:'p1',eventKey:'op:req-1',root:f.base,phase:'solve',summary:'solver finished'}
    });
    assert.equal(started.continuationAttached,true);
    assert.equal(validated,1);
    const state=await Promise.race([terminal,timeout(4000)]);
    assert.equal(state.status,'SUCCEEDED',JSON.stringify({failureCode:state.failureCode,exitCode:state.exitCode}));
    assert.equal(state.continuation.projectId,'p1');
    assert.equal(state.continuation.eventKey,'op:req-1');
  }finally{await api.close();await f.dispose();}
});

test('continuation metadata is part of request idempotency identity',async()=>{
  const f=fixture();
  const api=createAsyncOperationTools({
    config:f.config,
    prepare:async()=>({file:process.execPath,args:['-e','setTimeout(()=>process.exit(0),50)'],cwd:f.base,timeoutMs:3000,outputLimit:65536}),
    validateContinuation:async()=>{},
    onTerminal:async()=>({handoffId:'h',state:'QUEUED'})
  });
  try{
    const input={requestId:'req-2',tool:'run_project_command',arguments:{},
      continuation:{projectId:'p1',eventKey:'op:req-2',root:f.base,summary:'a'}};
    const a=await api.execute('operation_start',input);
    const b=await api.execute('operation_start',input);
    assert.equal(a.operationId,b.operationId);
    assert.equal(b.duplicate,true);
    await assert.rejects(api.execute('operation_start',{
      ...input,continuation:{projectId:'p1',eventKey:'op:req-2',root:f.base,summary:'changed'}
    }),/REQUEST_ID_CONFLICT/);
    const settled=await waitTerminal(api,a.operationId);
    assert.equal(settled.status,'SUCCEEDED',JSON.stringify({failureCode:settled.failureCode,exitCode:settled.exitCode}));
  }finally{await api.close();await f.dispose();}
});

test('restart reconciliation recovers terminal continuation after watcher is gone',async()=>{
  const f=fixture();
  let firstCalls=0;
  const first=createAsyncOperationTools({
    config:f.config,
    prepare:async()=>({file:process.execPath,args:['-e','setTimeout(()=>process.exit(0),180)'],cwd:f.base,timeoutMs:3000,outputLimit:65536}),
    validateContinuation:async()=>{},
    onTerminal:async()=>{firstCalls+=1;return {handoffId:'first',state:'QUEUED'};}
  });
  try{
    await first.execute('operation_start',{
      requestId:'req-3',tool:'run_project_command',arguments:{},
      continuation:{projectId:'p1',eventKey:'op:req-3',root:f.base}
    });
    await first.close();
    await new Promise(r=>setTimeout(r,450));
    assert.equal(firstCalls,0);
    let resolveRecovered;
    const recovered=new Promise(r=>{resolveRecovered=r;});
    const second=createAsyncOperationTools({
      config:f.config,
      prepare:async()=>{throw new Error('unused');},
      validateContinuation:async()=>{},
      onTerminal:async state=>{resolveRecovered(state);return {handoffId:'recovered',state:'QUEUED'};}
    });
    try{
      const state=await Promise.race([recovered,timeout(8000)]);
      assert.equal(state.status,'SUCCEEDED',JSON.stringify({failureCode:state.failureCode,exitCode:state.exitCode}));
      assert.equal(state.continuation.eventKey,'op:req-3');
    }finally{await second.close();}
  }finally{await f.dispose();}
});

test('unbound continuation validation prevents worker creation',async()=>{
  const f=fixture();
  const api=createAsyncOperationTools({
    config:f.config,
    prepare:async()=>({file:process.execPath,args:['-e','process.exit(0)'],cwd:f.base,timeoutMs:3000,outputLimit:65536}),
    validateContinuation:async()=>{throw new Error('CONVERSATION_NOT_BOUND');},
    onTerminal:async()=>null
  });
  try{
    await assert.rejects(api.execute('operation_start',{
      requestId:'req-4',tool:'run_project_command',arguments:{},
      continuation:{projectId:'p1',eventKey:'op:req-4',root:f.base}
    }),/CONVERSATION_NOT_BOUND/);
    assert.equal(fs.existsSync(path.join(f.state,'operations')),false);
  }finally{await api.close();await f.dispose();}
});
