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
  assert.deepEqual(t.definitions.map(x=>x.name),['notion_mcp_status','notion_mcp_connect_start','notion_mcp_verify']);
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
      handshakes++;
      assert.equal(init.redirect,'error');
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
