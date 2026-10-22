import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { NotionMcpEngine, createNotionMcpTools, generatePKCE } from '../src/notion-mcp-engine.mjs';
function fakeVault() {
  let data = null;
  return { available:true, backend:'test-in-memory', async load(){return structuredClone(data);},
    async save(value){data=structuredClone(value);} };
}
const respond = (status, json, contentType='application/json') => ({
  ok: status >= 200 && status < 300, status,
  headers:{ get(key){return key === 'content-type' ? contentType : null;} },
  async json(){ return json; },
  async text(){return typeof json === 'string' ? json : JSON.stringify(json);}
});
async function freePort() {
  const srv=net.createServer();await new Promise(resolve=>srv.listen(0,'127.0.0.1',resolve));
  const port=srv.address().port; await new Promise(resolve=>srv.close(resolve));return port;
}
const fakeMetadata = {
  authorization_endpoint:'https://api.notion.com/mcp/authorize',
  token_endpoint:'https://api.notion.com/mcp/token',
  registration_endpoint:'https://api.notion.com/mcp/register',
  code_challenge_methods_supported:['S256']
};
test('PKCE verifier is random and challenge is SHA-256 base64url', () => {
  const one=generatePKCE(), two=generatePKCE();
  assert.notEqual(one.verifier, two.verifier);
  assert.equal(one.verifier.length,43);
  assert.equal(one.challenge, createHash('sha256').update(one.verifier).digest('base64url'));
});
test('Notion MCP is opt-in and never exposes arbitrary HTTP execution', async () => {
  const t=createNotionMcpTools({ config:{} });
  assert.deepEqual(await t.execute('notion_mcp_status'),{enabled:false,connected:false});
  assert.deepEqual(t.definitions.map(x=>x.name),['notion_mcp_status','notion_mcp_connect_start','notion_mcp_verify','notion_mcp_list_tools','notion_mcp_fetch_self','notion_mcp_fetch_page']);
  assert.equal(JSON.stringify(t.definitions).includes('access_token'),false);
  await assert.rejects(t.execute('notion_mcp_connect_start'),/NOTION_MCP_DISABLED/);
});
test('official discovery, DCR, OAuth PKCE, callback and MCP handshake without secret exposure',async()=>{
  const vault=fakeVault(), port=await freePort();const requests=[];
  const engine=new NotionMcpEngine({
    config:{enabled:true, redirectUri:'http://127.0.0.1:'+port+'/notion/mcp/callback'}, vault,
    fetchImpl:async (url,options={})=>{
      requests.push({url, options});
      assert.equal(options.redirect,'error');
      if(url.endsWith('/.well-known/oauth-protected-resource')) return respond(200,{authorization_servers:['https://api.notion.com']});
      if(url.endsWith('/.well-known/oauth-authorization-server')) return respond(200,fakeMetadata);
      if(url.endsWith('/mcp/register')) {
        const reg=JSON.parse(options.body);
        assert.equal(reg.token_endpoint_auth_method,'none');
        assert.equal(reg.redirect_uris[0], 'http://127.0.0.1:'+port+'/notion/mcp/callback');
        return respond(201,{client_id:'fixture-dcr-client-id'});
      }
      if(url.endsWith('/mcp/token')){
        const body=new URLSearchParams(options.body);
        assert.equal(body.get('grant_type'),'authorization_code');
        assert.equal(body.get('client_id'),'fixture-dcr-client-id');
        assert.equal(body.get('code'),'fixture-code');
        assert.equal(body.get('code_verifier').length,43);
        assert.equal(body.has('client_secret'),false);
        return respond(200,{access_token:'FIXTURE_PRIVATE_ACCESS',refresh_token:'FIXTURE_PRIVATE_REFRESH',
          workspace_id:'fixture-workspace',user_id:'fixture-user'});
      }
      if(url==='https://mcp.notion.com/mcp'){
        assert.equal(options.headers.Authorization,'Bearer FIXTURE_PRIVATE_ACCESS');
        const body=JSON.parse(options.body);
        if(body.method==='notifications/initialized')return respond(202,{});
        if(body.method==='tools/list')return respond(200,{jsonrpc:'2.0',id:2,result:{tools:[
          {name:'notion-fetch',inputSchema:{type:'object',properties:{id:{type:'string'}}}},
          {name:'notion-search',inputSchema:{type:'object',properties:{query:{type:'string'}}}}]}});
        if(body.method==='tools/call') {
          assert.equal(body.params.name,'notion-fetch');
          assert.equal(body.params.arguments.id,'self');
          return respond(200,{jsonrpc:'2.0',id:3,result:{structuredContent:{self:{
            workspace_id:'fixture-workspace',workspace_name:'Fixture Notion',user_id:'fixture-user',
            current_tool_access:{ai_search:{status:'not_enabled'}} }}}});
        }
        assert.equal(body.method,'initialize');
        return respond(200,{jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-06-18',serverInfo:{name:'Notion MCP'}}});
      }
      throw Error('unexpected mock URL '+url);
    }
  });
  try {
    const start=await engine.connectStart();
    const repeated=await engine.connectStart();
    assert.equal(start.authorizationUrl,repeated.authorizationUrl);
    const auth=new URL(start.authorizationUrl);
    assert.equal(auth.searchParams.get('code_challenge_method'),'S256');
    assert.equal(auth.searchParams.get('client_id'),'fixture-dcr-client-id');
    assert.equal(auth.searchParams.has('client_secret'),false);
    let res=await fetch('http://127.0.0.1:'+port+'/notion/mcp/callback?code=evil&state=wrong');
    assert.equal(res.status,400);
    const state=auth.searchParams.get('state');
    res=await fetch('http://127.0.0.1:'+port+'/notion/mcp/callback?code=fixture-code&state='+state);
    assert.equal(res.status,200);
    assert.equal((await engine.status()).connected,true);
    assert.equal((await engine.status()).workspaceId,'fixture-workspace');
    assert.equal((await engine.verify()).connected,true);
    assert.equal((await engine.verify()).serverName,'Notion MCP');
    assert.deepEqual((await engine.listTools()).names,['notion-fetch','notion-search']);
    const self = await engine.fetchSelf();
    assert.equal(self.workspaceId,'fixture-workspace');
    assert.equal(self.workspaceName,'Fixture Notion');
    assert.equal(self.aiSearchStatus,'not_enabled');
    assert.equal(JSON.stringify(await engine.status()).includes('FIXTURE_PRIVATE'),false);
    assert.equal(JSON.stringify(await vault.load()).includes('FIXTURE_PRIVATE_ACCESS'),true);
    assert.equal(requests.filter(x=>x.url.endsWith('/mcp/register')).length,1);
  }finally{engine.server?.close();}
});
test('OAuth denial consumes callback, closes listener, and never exchanges code',async()=>{
  const vault=fakeVault(),port=await freePort();let exchanged=false;
  const engine=new NotionMcpEngine({config:{enabled:true,redirectUri:'http://127.0.0.1:'+port+'/notion/mcp/callback'},vault,
  fetchImpl:async(url,init)=>{
    if(url.endsWith('/.well-known/oauth-protected-resource'))return respond(200,{authorization_servers:['https://api.notion.com']});
    if(url.endsWith('/.well-known/oauth-authorization-server'))return respond(200,fakeMetadata);
    if(url.endsWith('/mcp/register'))return respond(201,{client_id:'fixture-client'});
    exchanged=true;throw Error('Unexpected token exchange');
  }});
  try{
    const url=new URL((await engine.connectStart()).authorizationUrl);
    const res=await fetch('http://127.0.0.1:'+port+'/notion/mcp/callback?error=access_denied&state='+url.searchParams.get('state'));
    assert.equal(res.status,400);
    assert.equal(engine.pending,null);
    assert.equal(engine.server,null);
    assert.equal(exchanged,false);
  }finally{engine.server?.close();}
});
test('reject unsafe OAuth discovery and fail closed before local listener',async()=>{
  const vault=fakeVault();
  const engine=new NotionMcpEngine({config:{enabled:true,redirectUri:'http://127.0.0.1:49783/notion/mcp/callback'},vault,
  fetchImpl:async()=>respond(200,{authorization_servers:['http://127.0.0.1:8510/steal']})});
  await assert.rejects(engine.connectStart(),/NOTION_MCP_DISCOVERY_UNTRUSTED/);
  assert.equal(engine.server,null);
});
test('MCP verify rotates tokens and keeps errors bounded',async()=>{
  const vault=fakeVault();
  await vault.save({access_token:'expired',refresh_token:'rotating',client_id:'client-fixture',
    token_endpoint:'https://api.notion.com/mcp/token',workspace_id:'workspace-fixture'});
  let handshakes=0;
  const engine=new NotionMcpEngine({config:{enabled:true},vault,fetchImpl:async(url,init)=>{
    if(url==='https://mcp.notion.com/mcp'){
      assert.equal(init.redirect,'error');
      const body=JSON.parse(init.body);
      if(body.method==='notifications/initialized')return respond(202,{});
      handshakes++;
      if(init.headers.Authorization==='Bearer expired')return respond(401,{});
      return respond(200,{jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-06-18'}});
    }
    if(url.endsWith('/mcp/token')) {
      const params=new URLSearchParams(init.body);
      assert.equal(params.get('grant_type'),'refresh_token');
      assert.equal(params.get('client_secret'),null);
      return respond(200,{access_token:'updated',refresh_token:'rotated'});
    }
    throw Error('Unexpected route');
  }});
  const result=await engine.verify();
  assert.equal(result.connected,true);
  assert.equal(handshakes,2);
  assert.equal((await vault.load()).refresh_token,'rotated');
  assert.equal(JSON.stringify(result).includes('updated'),false);
});
test('MCP client parses bounded SSE reply without forwarding tool requests', async()=>{
  const engine=new NotionMcpEngine({config:{enabled:true},vault:fakeVault(),
    fetchImpl:async()=>respond(200,
      'event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-06-18'}})+'\n\n',
      'text/event-stream')});
  const r=await engine.mcpPost('synthetic-fixture',{jsonrpc:'2.0',id:1,method:'initialize',params:{}});
  assert.equal(r.payload.result.protocolVersion,'2025-06-18');
});

test('MCP session identifier is propagated to initialized and read-only calls', async () => {
  const vault=fakeVault();
  await vault.save({access_token:'fixture',workspace_id:'test-space'});
  const observed=[];
  const engine=new NotionMcpEngine({config:{enabled:true},vault,fetchImpl:async(url,init)=>{
    const rpc=JSON.parse(init.body);
    observed.push({method:rpc.method,session:init.headers['Mcp-Session-Id'] ?? null});
    if(rpc.method==='initialize')return {
      ...respond(200,{jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-06-18'}}),
      headers:{get(key){return key==='mcp-session-id'?'opaque-fixture-session':
        key==='content-type'?'application/json':null;}}
    };
    if(rpc.method==='notifications/initialized') return respond(202,{});
    if(rpc.method==='tools/list') return respond(200,{jsonrpc:'2.0',id:2,result:{tools:[
      {name:'notion-fetch'},{name:'notion-search'},{name:'other-mutating-tool'}]}});
    if(rpc.method==='tools/call'){
      assert.deepEqual(rpc.params,{name:'notion-fetch',arguments:{id:'self'}});
      return respond(200,{jsonrpc:'2.0',id:3,result:{content:[{type:'text',text:JSON.stringify({
        self:{workspace_id:'space-a',workspace_name:'Fixture',user_id:'u-1',
          current_tool_access:{ai_search:{status:'available'}}}})}]}});
    }
    throw Error('unexpected request');
  }});
  assert.equal((await engine.listTools()).count,3);
  const identity=await engine.fetchSelf();
  assert.equal(identity.workspaceId,'space-a');
  assert.equal(identity.aiSearchStatus,'available');
  assert.deepEqual(observed.map(x=>x.method),[
    'initialize','notifications/initialized','tools/list','tools/list','tools/call']);
  assert.deepEqual(observed.map(x=>x.session),[null,'opaque-fixture-session',
    'opaque-fixture-session','opaque-fixture-session','opaque-fixture-session']);
});
test('MCP read-only transport rejects oversized streamed replies before buffering them', async () => {
  const vault=fakeVault();
  const engine=new NotionMcpEngine({config:{enabled:true},vault,fetchImpl:async()=>{
    const body=new ReadableStream({start(controller){
      controller.enqueue(new Uint8Array(22000));
      controller.enqueue(new Uint8Array(22000));
      controller.close();
    }});
    return {ok:true,status:200,headers:{get(k){return k==='content-type'?'application/json':null;}},body};
  }});
  await assert.rejects(engine.mcpPost('fixture',{jsonrpc:'2.0',id:1,method:'initialize',params:{}}),
    /NOTION_MCP_RESPONSE_TOO_LARGE/);
});

test('hosted MCP large real-world tool schemas are bounded yet returned as names only', async () => {
  const vault=fakeVault();
  await vault.save({access_token:'fixture-existing',workspace_id:'fixture-space'});
  const hugeSchema='Synthetic description for regression only. '.repeat(2300);
  const engine=new NotionMcpEngine({config:{enabled:true},vault,fetchImpl:async(url,init)=>{
    const rpc=JSON.parse(init.body);
    if(rpc.method==='initialize')return respond(200,{jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-06-18'}});
    if(rpc.method==='notifications/initialized')return respond(202,{});
    if(rpc.method==='tools/list')return respond(200,{jsonrpc:'2.0',id:2,result:{tools:[
      {name:'notion-fetch',description:hugeSchema,inputSchema:{type:'object',properties:{}}},
      {name:'notion-search',description:'Search'}]}});
    throw Error('unexpected fixture call');
  }});
  const result=await engine.listTools();
  assert.equal(result.count,2);
  assert.deepEqual(result.names,['notion-fetch','notion-search']);
  assert.equal(JSON.stringify(result).includes('Synthetic description'),false);
});
test('fixed Notion self fetch accepts bounded large identity response and strips extra data', async()=>{
  const vault=fakeVault(); await vault.save({access_token:'fixture-existing'});
  const engine=new NotionMcpEngine({config:{enabled:true},vault,fetchImpl:async(url,init)=>{
    const rpc=JSON.parse(init.body);
    if(rpc.method==='initialize')return respond(200,{jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-06-18'}});
    if(rpc.method==='notifications/initialized')return respond(202,{});
    if(rpc.method==='tools/list')return respond(200,{jsonrpc:'2.0',id:2,result:{tools:[{name:'notion-fetch'}]}});
    if(rpc.method==='tools/call')return respond(200,{jsonrpc:'2.0',id:3,result:{structuredContent:{
      self:{workspace_id:'fixture-workspace',workspace_name:'Fixture Name',user_id:'fixture-user'},
      unused_description:'Synthetic bulk data for read-only self fixture. '.repeat(2300)
    }}});
    throw Error('unexpected fixture call');
  }});
  const self=await engine.fetchSelf();
  assert.equal(self.workspaceId,'fixture-workspace');
  assert.equal(self.workspaceName,'Fixture Name');
  assert.equal(self.userId,'fixture-user');
  assert.equal(JSON.stringify(self).includes('Synthetic bulk'),false);
});
test('large payload exception is method-scoped; other methods keep 32KB response limit',async()=>{
  const hugeDescription='Synthetic oversized transport fixture. '.repeat(2500);
  const engine=new NotionMcpEngine({config:{enabled:true},vault:fakeVault(),
    fetchImpl:async()=>respond(200,{jsonrpc:'2.0',id:2,result:{value:hugeDescription}})});
  const valid=await engine.mcpPost('fixture',{jsonrpc:'2.0',id:2,method:'tools/list'});
  assert.equal(valid.httpStatus,200);
  await assert.rejects(engine.mcpPost('fixture',{jsonrpc:'2.0',id:2,method:'other'}),
    /NOTION_MCP_RESPONSE_TOO_LARGE/);
});
test('even official tools/list rejects streams beyond its 512KiB bound',async()=>{
  const engine=new NotionMcpEngine({config:{enabled:true},vault:fakeVault(),
    fetchImpl:async()=>({
      ok:true,status:200,headers:{get(k){return k==='content-type'?'application/json':null;}},
      body:new ReadableStream({start(controller){controller.enqueue(new Uint8Array(300000));controller.enqueue(new Uint8Array(300000));controller.close();}})
    })});
  await assert.rejects(engine.mcpPost('fixture',{jsonrpc:'2.0',id:2,method:'tools/list'}),
    /NOTION_MCP_RESPONSE_TOO_LARGE/);
});

test('MCP project page fetch validates strict UUID and returns bounded text only',async()=>{
  const vault=fakeVault();
  await vault.save({access_token:'synthetic-token',workspace_id:'test-workspace'});
  const pageId='400d5b4a86f6812db36cd9f00711a063';
  const data='Page fixture content '.repeat(950);
  const calls=[];
  const engine=new NotionMcpEngine({config:{enabled:true},vault,fetchImpl:async(url,init)=>{
    const rpc=JSON.parse(init.body);calls.push(rpc.method);
    if(rpc.method==='initialize')return respond(200,{jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-06-18'}});
    if(rpc.method==='notifications/initialized')return respond(202,{});
    if(rpc.method==='tools/list')return respond(200,{jsonrpc:'2.0',id:2,result:{tools:[{name:'notion-fetch'}]}});
    if(rpc.method==='tools/call'){
      assert.deepEqual(rpc.params,{name:'notion-fetch',arguments:{id:pageId}});
      return respond(200,{jsonrpc:'2.0',id:4,result:{content:[{type:'text',text:data}]}});
    }
    throw Error('unexpected provider call');
  }});
  const page=await engine.fetchPage({pageId});
  assert.equal(page.pageId,pageId);
  assert.equal(page.content.length,6000);
  assert.equal(page.textTruncated,true);
  assert.equal(page.contentBytes,Buffer.byteLength(data));
  assert.equal(page.content,data.slice(0,6000));
  assert.deepEqual(calls,['initialize','notifications/initialized','tools/list','tools/call']);
  await assert.rejects(engine.fetchPage({pageId:'https://evil.example/test'}),/NOTION_MCP_PAGE_ID_INVALID/);
  await assert.rejects(engine.fetchPage({pageId:'self'}),/NOTION_MCP_PAGE_ID_INVALID/);
  await assert.rejects(engine.fetchPage({pageId:'400d5b4a86f6812db36cd9f00711a063\nAuthorization: secret'}),/NOTION_MCP_PAGE_ID_INVALID/);
  assert.equal(calls.length,4);
  const hyphenated='400d5b4a-86f6-812d-b36c-d9f00711a063';
  const other=await engine.fetchPage({pageId:hyphenated});
  assert.equal(other.pageId,pageId);
});
test('MCP page fetch provider error is fail-closed without passing error text through',async()=>{
  const vault=fakeVault();await vault.save({access_token:'fixture'});
  const engine=new NotionMcpEngine({config:{enabled:true},vault,fetchImpl:async(url,init)=>{
    const rpc=JSON.parse(init.body);
    if(rpc.method==='initialize')return respond(200,{jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-06-18'}});
    if(rpc.method==='notifications/initialized')return respond(202,{});
    if(rpc.method==='tools/list')return respond(200,{jsonrpc:'2.0',id:2,result:{tools:[{name:'notion-fetch'}]}});
    return respond(200,{jsonrpc:'2.0',id:4,result:{isError:true,content:[{type:'text',text:'synthetic internal provider error fixture'}]}});
  }});
  await assert.rejects(engine.fetchPage({pageId:'400d5b4a86f6812db36cd9f00711a063'}),/NOTION_MCP_PAGE_FETCH_FAILED/);
});
test('MCP bounded large page response does not expand arbitrary tools/call transport cap',async()=>{
  const fixture='Synthetic test page body '.repeat(3500);
  const engine=new NotionMcpEngine({config:{enabled:true},vault:fakeVault(),
    fetchImpl:async()=>respond(200,{jsonrpc:'2.0',id:4,result:{content:[{type:'text',text:fixture}]}})});
  const fetchCall={jsonrpc:'2.0',id:4,method:'tools/call',
    params:{name:'notion-fetch',arguments:{id:'400d5b4a86f6812db36cd9f00711a063'}}};
  const ok=await engine.mcpPost('fixture',fetchCall);
  assert.equal(ok.httpStatus,200);
  const other={jsonrpc:'2.0',id:4,method:'tools/call',
    params:{name:'notion-delete',arguments:{id:'400d5b4a86f6812db36cd9f00711a063'}}};
  await assert.rejects(engine.mcpPost('fixture',other),/NOTION_MCP_RESPONSE_TOO_LARGE/);
});
