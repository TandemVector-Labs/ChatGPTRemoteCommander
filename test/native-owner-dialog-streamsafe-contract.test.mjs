import test from 'node:test';
import assert from 'node:assert/strict';
import {execNativeOwnerDialogStreamed} from '../src/native-owner-session-provider-linux.mjs';

function runChild(code,timeout=3500){
  return new Promise(resolve=>{
    execNativeOwnerDialogStreamed(
      process.execPath,['-e',code],
      {env:process.env,timeout,windowsHide:true,maxBuffer:4096},
      (error,stdout,stderr)=>resolve({error,stdout,stderr})
    );
  });
}

test('GTK warning stderr exceeding 4 KiB never terminates native dialog',async()=>{
  const result=await runChild(
    'process.stderr.write("W".repeat(2*1024*1024));process.stdout.write("OK")'
  );
  assert.equal(result.error,null);
  assert.equal(result.stdout,'OK');
  assert.equal(result.stderr,'');
});

test('a nonzero native dialog exit is denial even if stdout contains approval-like text',async()=>{
  const result=await runChild('process.stdout.write("Approve");process.exit(1)');
  assert.ok(result.error);
  assert.notEqual(result.error.code,0);
});

test('oversized dialog stdout fails closed independently of stderr volume',async()=>{
  const result=await runChild('process.stdout.write("A".repeat(2048))');
  assert.ok(result.error);
  assert.equal(result.error.code,'NATIVE_DIALOG_STDOUT_LIMIT');
});

test('native dialog timeout cannot be mistaken for successful approval',async()=>{
  const result=await runChild('setTimeout(()=>process.stdout.write("late"),1500)',300);
  assert.ok(result.error);
});
