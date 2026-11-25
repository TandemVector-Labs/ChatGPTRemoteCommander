import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createOwnerWorkspaceProxy} from '../src/owner-workspace-proxy.mjs';
const conf={ownerWorkspaceDelegation:{enabled:true,port:48839,authFile:path.resolve('/tmp/rc-ownerauth')}};
const auth='a'.repeat(64);
test('reply is bounded before the complete oversized stream is buffered',async()=>{
 let pushed=0;
 const total=160;
 const fetchImpl=async()=>new Response(new ReadableStream({
  pull(controller){if(pushed>=total){controller.close();return;}
   pushed++;controller.enqueue(new Uint8Array(65536));}
 }),{status:200});
 const proxy=createOwnerWorkspaceProxy({config:conf,readFileImpl:async()=>auth,fetchImpl});
 await assert.rejects(()=>proxy.execute('workspace_plan'),/WORKSPACE_OWNER_REPLY_LIMIT/);
 assert.ok(pushed<150,'stream consumed too many chunks before enforcing bound: '+pushed);
});
test('valid small streamed JSON response keeps existing contract',async()=>{
 const value={jsonrpc:'2.0',id:1,result:{structuredContent:{ok:true,kind:'fixture'}}};
 const proxy=createOwnerWorkspaceProxy({config:conf,readFileImpl:async()=>auth,fetchImpl:async()=>new Response(JSON.stringify(value),{status:200})});
 assert.deepEqual(await proxy.execute('workspace_plan'),{handled:true,value:{ok:true,kind:'fixture'}});
});
