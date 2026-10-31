import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseLoginArgs, openOfficialLogin, runLogin } from '../tools/notion-login.mjs';

test('CLI profile and port parsing reject invalid options and preserve private callback', () => {
  assert.deepEqual(parseLoginArgs([]), {profile:'default',port:49732,openBrowser:false,help:false,probe:false});
  assert.deepEqual(parseLoginArgs(['--profile','mcp-a','--port','49743','--probe']).port,49743);
  assert.throws(() => parseLoginArgs(['--profile','../foo']),/NOTION_LOGIN_PROFILE_INVALID/);
  assert.throws(() => parseLoginArgs(['--port','0']),/NOTION_LOGIN_PORT_INVALID/);
  assert.throws(() => parseLoginArgs(['--port','abc']),/NOTION_LOGIN_PORT_INVALID/);
  assert.throws(() => parseLoginArgs(['--unknown']),/NOTION_LOGIN_ARGUMENT_UNKNOWN/);
  assert.throws(() => parseLoginArgs(['--port']),/NOTION_LOGIN_ARGUMENT_REQUIRED/);
});
test('CLI help and unauthenticated metadata probe never register OAuth client or emit secret', async () => {
  const text=[];
  assert.equal(await runLogin(['--help'],{output:s=>text.push(s)}),0);
  assert.ok(text.join(' ').includes('Usage:'));
  let called=0;
  const probe={status:async()=>({vaultAvailable:true,connected:false}),
    metadata:async()=>{called++;return {authorization_endpoint:'https://mcp.notion.com/authorize'};}};
  const output=[];
  assert.equal(await runLogin(['--probe'],{output:s=>output.push(s),engineFactory:()=>probe}),0);
  assert.equal(called,1);
  assert.deepEqual(output,['NOTION_OAUTH_DISCOVERY_OK mcp.notion.com']);
});
test('CLI uses owner consent and waits for callback, without printing tokens', async () => {
  const server=new EventEmitter();server.listening=true;
  const records=[];
  let done=false;
  const engine={server, status:async()=>({vaultAvailable:true,connected:done}),
    async connectStart(){
      setTimeout(()=>{done=true;server.listening=false;server.emit('close');},15);
      return {authorizationUrl:'https://mcp.notion.com/oauth/authorize?state=fixture'};
    },async verify(){return {workspaceId:'workspace-fixture'};},
    async fetchSelf(){return {workspaceName:'Workspace fixture'};}};
  const output=[];
  const code=await runLogin(['--profile','fixture-profile','--open-browser'],
    {engineFactory:opts=>{records.push(opts);return engine;},
      open:async url=>{assert.ok(url.startsWith('https://mcp.notion.com/'));},
      output:s=>output.push(s)});
  assert.equal(code,0);
  assert.equal(records[0].profile,'fixture-profile');
  assert.ok(output.includes('NOTION_MCP_CONNECTED workspace-fixture'));
  assert.ok(output.includes('NOTION_WORKSPACE Workspace fixture'));
  assert.equal(JSON.stringify(output).includes('access_token'),false);
});
test('CLI fails closed on absent secure vault and does not register client', async()=>{
  const engine={status:async()=>({vaultAvailable:false,connected:false}),connectStart:async()=>{
    throw Error('should not register');}};
  await assert.rejects(runLogin([],{engineFactory:()=>engine}),/NOTION_LOGIN_SECURE_VAULT_REQUIRED/);
});
test('browser opener permits official HTTPS Notion hosts only and passes argument directly', async()=>{
  let cmd,opts;
  await openOfficialLogin('https://mcp.notion.com/oauth/authorize?state=fixture',{
    platform:'win32',
    spawnImpl:(c,args,o)=>{cmd=c;opts={args,o};return {on:()=>{},unref:()=>{}};}});
  assert.equal(cmd,'explorer.exe');
  assert.equal(opts.args.length,1);
  assert.equal(opts.o.detached,true);
  await assert.rejects(openOfficialLogin('http://mcp.notion.com/authorize'),/NOTION_LOGIN_AUTH_URL_UNTRUSTED/);
  await assert.rejects(openOfficialLogin('https://mcp.notion.com.evil.test/'),/NOTION_LOGIN_AUTH_URL_UNTRUSTED/);
});
