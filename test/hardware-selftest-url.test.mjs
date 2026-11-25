import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const cli=fileURLToPath(new URL('../tools/hardware-selftest.mjs',import.meta.url));

async function harness(fn){
  const received=[];
  const server=http.createServer(async(req,res)=>{
    received.push(req.url);
    for await(const _ of req){}
    const payload={jsonrpc:'2.0',id:1,result:{structuredContent:{
      instance:{profile:'default'},platform:'fixture',arch:'x64',
      version:'fixture-version',deviceName:'fixture-device'
    }}};
    res.writeHead(200,{'content-type':'application/json','connection':'close'});
    res.end(JSON.stringify(payload));
  });
  const root=await mkdtemp(path.join(os.tmpdir(),'rc012-hw-ssrf-'));
  const conf=path.join(root,'config.json');
  await writeFile(conf,JSON.stringify({instance:{profile:'default'}}));
  try{
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(0,'127.0.0.1',resolve);
    });
    await fn({port:server.address().port,conf,received});
  }finally{
    await new Promise((resolve,reject)=>{
      server.close(error=>error?reject(error):resolve());
      server.closeAllConnections();
    });
    await rm(root,{recursive:true,force:true});
  }
}
function run(url,conf){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[cli,'--url',url,'--config',conf,'--timeout-ms','1500'],
      {stdio:['ignore','pipe','pipe'],windowsHide:true});
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>stdout+=chunk.toString('utf8'));
    child.stderr.on('data',chunk=>stderr+=chunk.toString('utf8'));
    child.once('error',reject);
    child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));
  });
}

test('hardware selftest rejects arbitrary loopback paths before making an HTTP request',async()=>{
  await harness(async({port,conf,received})=>{
    const result=await run('http://127.0.0.1:'+port+'/admin/mcp',conf);
    assert.notEqual(result.code,0);
    assert.deepEqual(received,[]);
  });
});

test('hardware selftest rejects query and fragment without HTTP I/O',async()=>{
  await harness(async({port,conf,received})=>{
    for(const pathSuffix of ['/mcp?token=value','/mcp#fragment']){
      const result=await run('http://127.0.0.1:'+port+pathSuffix,conf);
      assert.notEqual(result.code,0,pathSuffix);
    }
    assert.deepEqual(received,[]);
  });
});

test('hardware selftest still works against exact local MCP URL',async()=>{
  await harness(async({port,conf,received})=>{
    const result=await run('http://127.0.0.1:'+port+'/mcp',conf);
    assert.equal(result.code,0,result.stderr);
    assert.match(result.stdout,/HARDWARE_SELFTEST_PASS/);
    assert.deepEqual(received,['/mcp']);
  });
});