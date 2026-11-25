import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createBrowserProcessClient} from '../src/browser-process.mjs';

const helperScript=String.raw`
import {createInterface} from 'node:readline';
process.stdout.write(JSON.stringify({ok:true,ready:true,protocol:1})+'\n');
const rl=createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of rl){
  const req=JSON.parse(line);
  await new Promise(resolve=>setTimeout(resolve,req.delayMs??0));
  process.stdout.write(JSON.stringify({ok:true,action:req.action,done:true})+'\n');
}
`;
async function fixture({timeoutMs=90,slowActionTimeoutMs=500}={}){
  const folder=await mkdtemp(path.join(os.tmpdir(),'v104-helper-timeout-test-'));
  const helper=path.join(folder,'helper.mjs');
  await writeFile(helper,helperScript,'utf8');
  const client=createBrowserProcessClient({
    file:process.execPath,args:[helper],
    timeoutMs,slowActionTimeoutMs,startupTimeoutMs:3000,
    gracefulCloseMs:100,forceCloseMs:100
  });
  return {client,cleanup:async()=>{try{await client.close();}catch{} await rm(folder,{recursive:true,force:true});}};
}

test('native transfers, navigation and wait use a bounded extended helper deadline',async()=>{
 const f=await fixture();
 try{
  for(const action of ['transfer_upload','transfer_download','navigate','wait']){
    const result=await f.client.invoke({action,delayMs:175});
    assert.equal(result.done,true,action);
    assert.equal(result.action,action);
  }
  assert.equal((await f.client.invoke({action:'ordinary',delayMs:0})).done,true);
 }finally{await f.cleanup();}
});
test('ordinary actions retain the 90 ms deadline',async()=>{
 const f=await fixture();
 try{await assert.rejects(f.client.invoke({action:'ordinary',delayMs:250}),/BROWSER_HELPER_TIMEOUT/);}
 finally{await f.cleanup();}
});
test('even transfer actions fail at the bounded long-action deadline',async()=>{
 const f=await fixture({timeoutMs:90,slowActionTimeoutMs:300});
 try{await assert.rejects(f.client.invoke({action:'transfer_download',delayMs:900}),/BROWSER_HELPER_TIMEOUT/);}
 finally{await f.cleanup();}
});
test('long-action budget cannot reduce the configured ordinary timeout',async()=>{
 const f=await fixture({timeoutMs:300,slowActionTimeoutMs:120});
 try{
  const r=await f.client.invoke({action:'transfer_upload',delayMs:180});
  assert.equal(r.done,true);
 }finally{await f.cleanup();}
});
