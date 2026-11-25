import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { classifyToolSchemaCompatibility, evaluateSchemaContinuity, validateLocalSchemaEndpoint } from '../tools/schema-continuity-gate.mjs';

function server(handler){return http.createServer(handler);}
let portCursor=20000+(process.pid%10000);
async function listen(s){
  for(let attempt=0;attempt<500;attempt+=1){
    const port=portCursor++;
    if(portCursor>45000)portCursor=20000;
    try{
      await new Promise((resolve,reject)=>{
        const cleanup=()=>{s.off('error',onError);s.off('listening',onListening);};
        const onError=error=>{cleanup();reject(error);};
        const onListening=()=>{cleanup();resolve();};
        s.once('error',onError);s.once('listening',onListening);s.listen(port,'127.0.0.1');
      });
      return port;
    }catch(error){
      if(error?.code!=='EADDRINUSE')throw error;
    }
  }
  throw new Error('SAFE_TEST_PORT_UNAVAILABLE');
}
async function close(s){
  // Revoke actively held HTTP sockets after stopping new requests. A lingering
  // test connection must not keep the Windows qualification child alive.
  await new Promise((resolve,reject)=>{
    s.close(error=>error?reject(error):resolve());
    s.closeAllConnections();
  });
}
function schemaServer(tools){return server(async(req,res)=>{for await(const _ of req){}const data=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:1,result:{tools}}));res.writeHead(200,{'content-type':'application/json','content-length':data.length,'connection':'close'});res.end(data);});}
function statusServer(schemaContinuity){return server((req,res)=>{const data=Buffer.from(JSON.stringify({ok:true,router:true,schemaContinuity}));res.writeHead(200,{'content-type':'application/json','content-length':data.length,'connection':'close'});res.end(data);});}
const tool=(required=[])=>({name:'write_text',inputSchema:{type:'object',properties:{path:{type:'string'},requestId:{type:'string'}},required}});

async function run(oldTools,newTools,continuity){
 const a=schemaServer(oldTools),b=schemaServer(newTools),r=statusServer(continuity);
 const [ap,bp,rp]=await Promise.all([listen(a),listen(b),listen(r)]);
 try{return await evaluateSchemaContinuity({oldUrl:`http://127.0.0.1:${ap}/mcp`,candidateUrl:`http://127.0.0.1:${bp}/mcp`,routerUrl:`http://127.0.0.1:${rp}/router/status`});}
 finally{await Promise.all([close(a),close(b),close(r)]);}
}

test('R479 fixture teardown closes an intentionally active HTTP request',{timeout:2500},async()=>{
  const fixture=server((_req,_res)=>{}); // deliberate pending HTTP response
  const port=await listen(fixture);
  const incoming=once(fixture,'request');
  const client=http.get('http://127.0.0.1:'+port+'/pending');
  client.on('error',()=>{}); // connection is deliberately aborted at teardown
  try{
    await incoming;
    await close(fixture);
    assert.equal(fixture.listening,false);
  }finally{
    client.destroy();
    if(fixture.listening)await close(fixture);
  }
});

test('unchanged tool schema does not require negotiated refresh',async()=>{const x=await run([tool([])],[tool([])],null);assert.equal(x.ok,true);assert.equal(x.decision,'UNCHANGED_SCHEMA');});
test('changed tool schema blocks without router continuity support',async()=>{const x=await run([tool([])],[tool(['requestId'])],null);assert.equal(x.ok,false);assert.equal(x.decision,'ROUTER_CONTINUITY_UNSUPPORTED');});
test('changed tool schema blocks after any legacy MCP traffic',async()=>{const x=await run([tool([])],[tool(['requestId'])],{legacyMcpSeen:true,toolsListSubscribers:1});assert.equal(x.ok,false);assert.equal(x.decision,'LEGACY_HOST_SEEN');});
test('changed tool schema blocks when tools-list refresh is not negotiated',async()=>{const x=await run([tool([])],[tool(['requestId'])],{legacyMcpSeen:false,toolsListSubscribers:0});assert.equal(x.ok,false);assert.equal(x.decision,'TOOLS_LIST_REFRESH_UNNEGOTIATED');});
test('changed tool schema passes with modern negotiated refresh and no legacy host',async()=>{const x=await run([tool([])],[tool(['requestId'])],{legacyMcpSeen:false,toolsListSubscribers:1});assert.equal(x.ok,true);assert.equal(x.decision,'NEGOTIATED_REFRESH');});


test('backward-compatible enum extension passes without negotiated refresh',async()=>{
  const old=[{name:'operation_start',inputSchema:{type:'object',additionalProperties:false,properties:{tool:{type:'string',enum:['run_shell','run_project_command']}},required:['tool']}}];
  const next=[{name:'operation_start',inputSchema:{type:'object',additionalProperties:false,properties:{tool:{type:'string',enum:['run_shell','run_project_command','copy_path','move_path','delete_path']}},required:['tool']}}];
  const x=await run(old,next,null);
  assert.equal(x.ok,true);
  assert.equal(x.backwardCompatible,true);
  assert.equal(x.decision,'BACKWARD_COMPATIBLE_SCHEMA');
});

test('classifier allows additive tools and optional properties',()=>{
  const old=[{name:'x',inputSchema:{type:'object',additionalProperties:false,properties:{a:{type:'string'}},required:['a']}}];
  const next=[
    {name:'x',inputSchema:{type:'object',additionalProperties:false,properties:{a:{type:'string'},b:{type:'integer'}},required:['a']}},
    {name:'new_tool',inputSchema:{type:'object',properties:{}}}
  ];
  assert.deepEqual(classifyToolSchemaCompatibility(old,next),{compatible:true,reasons:[]});
});

test('classifier rejects removed tools, new required fields and narrowed constraints',()=>{
  const base={name:'x',inputSchema:{type:'object',additionalProperties:false,properties:{a:{type:'string',maxLength:100},mode:{type:'string',enum:['a','b']}},required:['a']}};
  assert.equal(classifyToolSchemaCompatibility([base],[]).compatible,false);
  const required={...base,inputSchema:{...base.inputSchema,required:['a','mode']}};
  assert.match(classifyToolSchemaCompatibility([base],[required]).reasons.join('|'),/required_added/);
  const narrowedEnum={...base,inputSchema:{...base.inputSchema,properties:{...base.inputSchema.properties,mode:{type:'string',enum:['a']}}}};
  assert.match(classifyToolSchemaCompatibility([base],[narrowedEnum]).reasons.join('|'),/enum_narrowed/);
  const narrowedLength={...base,inputSchema:{...base.inputSchema,properties:{...base.inputSchema.properties,a:{type:'string',maxLength:10}}}};
  assert.match(classifyToolSchemaCompatibility([base],[narrowedLength]).reasons.join('|'),/maxLength_narrowed/);
});

test('classifier rejects newly imposed pattern and closed additional properties',()=>{
  const old=[{name:'x',inputSchema:{type:'object',properties:{a:{type:'string'}}}}];
  const pattern=[{name:'x',inputSchema:{type:'object',properties:{a:{type:'string',pattern:'^x$'}}}}];
  assert.match(classifyToolSchemaCompatibility(old,pattern).reasons.join('|'),/pattern_changed/);
  const closed=[{name:'x',inputSchema:{type:'object',additionalProperties:false,properties:{a:{type:'string'}}}}];
  assert.match(classifyToolSchemaCompatibility(old,closed).reasons.join('|'),/additional_properties_narrowed/);
});

test('SSRF guard rejects remote, credentialed, redirectable and malformed schema endpoints before I/O',async()=>{
  for(const value of [
    'http://example.com:47831/mcp',
    'http://10.0.0.1:47831/mcp',
    'http://user:password@127.0.0.1:47831/mcp',
    'http://127.0.0.1:47831/mcp?token=x',
    'http://127.0.0.1:47831/mcp#secret',
    'file:///tmp/mcp',
    'https://127.0.0.1:47831/mcp',
    'http://127.0.0.1:47831/evil',
    'http://127.0.0.1:47831/mcp/../secret',
    'http://127.0.0.1:47831/mcp%2f..%2fadmin',
    'http://127.0.0.1/mcp'
  ]){
    assert.throws(()=>validateLocalSchemaEndpoint(value),/SCHEMA_ENDPOINT_/);
    await assert.rejects(evaluateSchemaContinuity({
      oldUrl:value,candidateUrl:'http://127.0.0.1:47832/mcp',
      routerUrl:'http://127.0.0.1:47833/router/status'
    }),/SCHEMA_ENDPOINT_/);
  }
  assert.equal(validateLocalSchemaEndpoint('http://127.0.0.1:47831/mcp','mcp'),
    'http://127.0.0.1:47831/mcp');
  assert.equal(validateLocalSchemaEndpoint('http://[::1]:47831/router/status','router'),
    'http://[::1]:47831/router/status');
  assert.throws(()=>validateLocalSchemaEndpoint('http://127.0.0.1:47831/mcp','router'),/SCHEMA_ENDPOINT_LOOPBACK_REQUIRED/);
});

test('SSRF guard blocks redirects from a loopback schema endpoint to a different destination',async()=>{
 const source=server((req,res)=>{res.writeHead(302,{location:'http://example.com/'});res.end();});
 const port=await listen(source);
 try{
  await assert.rejects(evaluateSchemaContinuity({
    oldUrl:`http://127.0.0.1:${port}/mcp`,
    candidateUrl:`http://127.0.0.1:${port}/mcp`,
    routerUrl:`http://127.0.0.1:${port}/router/status`
  }),/redirect|fetch failed/i);
 }finally{await close(source);}
});

test('schema endpoint reconstruction retains canonical permitted loopback forms',()=>{
  for(const host of ['127.0.0.1','localhost','[::1]']){
    for(const endpoint of ['/mcp','/router/status']){
      const input=`http://${host}:47831${endpoint}`;
      const role=endpoint==='/mcp'?'mcp':'router';
      assert.equal(validateLocalSchemaEndpoint(input,role),input);
    }
  }
});

test('schema preflight rejects an unsafe later endpoint before contacting the first',async()=>{
  let requests=0;
  const source=server((_req,res)=>{requests+=1;res.end('{}');});
  const port=await listen(source);
  const safe=`http://127.0.0.1:${port}/mcp`;
  try{
    await assert.rejects(evaluateSchemaContinuity({
      oldUrl:safe,candidateUrl:'http://example.com:47832/mcp',
      routerUrl:'http://127.0.0.1:47833/router/status'
    }),/SCHEMA_ENDPOINT_LOOPBACK_REQUIRED/);
    await assert.rejects(evaluateSchemaContinuity({
      oldUrl:safe,candidateUrl:safe,routerUrl:'http://10.0.0.1:47833/router/status'
    }),/SCHEMA_ENDPOINT_LOOPBACK_REQUIRED/);
    assert.equal(requests,0);
  }finally{await close(source);}
});