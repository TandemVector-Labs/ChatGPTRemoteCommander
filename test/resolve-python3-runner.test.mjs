import test from 'node:test';
import assert from 'node:assert/strict';
import {resolvePython3Runner} from '../tools/resolve-python3-runner.mjs';

test('Windows uses existing Python 3 launcher when available',()=>{
  const calls=[];
  const run=(bin,args,opts)=>{
    calls.push({bin,args,opts});
    return {status:bin==='py'?0:1,error:null,signal:null};
  };
  const result=resolvePython3Runner({platform:'win32',run});
  assert.deepEqual(result,{command:'py',prefixArgs:['-3']});
  assert.equal(calls.length,1);
  assert.equal(calls[0].args[0],'-3');
  assert.equal(calls[0].opts.timeout,5000);
});

test('Windows without optional py launcher selects an actual Python 3 interpreter',()=>{
  const invoked=[];
  const run=(bin,args)=>{
    invoked.push(bin);
    if(bin==='py')return {status:null,error:Object.assign(new Error('ENOENT'),{code:'ENOENT'})};
    if(bin==='python3')return {status:9009,error:null,signal:null}; // WindowsApps alias
    if(bin==='python')return {status:0,error:null,signal:null};
    throw new Error('UNEXPECTED');
  };
  const result=resolvePython3Runner({platform:'win32',run});
  assert.deepEqual(result,{command:'python',prefixArgs:[]});
  assert.deepEqual(invoked,['py','python3','python']);
  assert.equal(Object.isFrozen(result),true);
  assert.equal(Object.isFrozen(result.prefixArgs),true);
});

test('Rejects all missing, wrong-version, aliases and timed-out Python probes',()=>{
  const run=()=>({status:null,error:Object.assign(new Error('ETIMEDOUT'),{code:'ETIMEDOUT'}),signal:null});
  assert.throws(()=>resolvePython3Runner({platform:'win32',run}),/RELEASE_TRAIN_PYTHON3_REQUIRED/);
  assert.throws(()=>resolvePython3Runner({platform:'win32',run:()=>({status:9009})}),/RELEASE_TRAIN_PYTHON3_REQUIRED/);
  assert.throws(()=>resolvePython3Runner({platform:'linux',run:()=>({status:1})}),/RELEASE_TRAIN_PYTHON3_REQUIRED/);
});

test('Linux only invokes python3, never py/python aliases',()=>{
  const calls=[];
  const result=resolvePython3Runner({platform:'linux',run:(bin,args)=>{
    calls.push({bin,args});
    return {status:0,error:null,signal:null};
  }});
  assert.deepEqual(result,{command:'python3',prefixArgs:[]});
  assert.deepEqual(calls.map(x=>x.bin),['python3']);
});

test('Unsupported bootstrap parameters reject before probing',()=>{
  assert.throws(()=>resolvePython3Runner({platform:'darwin'}),/PLATFORM_INVALID/);
  assert.throws(()=>resolvePython3Runner({platform:'win32',run:3}),/PLATFORM_INVALID/);
});
