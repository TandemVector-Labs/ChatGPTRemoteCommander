import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createOwnerGuiReadOnlyProxy } from '../src/gui-owner-delegation.mjs';

const cfg = () => ({
  powerMode: { guiControl: { enabled: true } },
  ownerGuiDelegation: { enabled: true, port: 48837, authFile: path.join(os.tmpdir(), 'owner-gui-auth.key') }
});
const authorized = () => 'a'.repeat(64);
const primary = () => ({ enabled: true, available: false, uncertain: false, blocked: false });
const make = ({ status = primary, handler = () => ({ enabled: true, available: true, screens: [1] }),
                code = 200, secret = authorized() } = {}) => {
  const captured = [];
  const proxy = createOwnerGuiReadOnlyProxy({
    config: cfg(), primaryStatus: status,
    readFileImpl: async () => secret,
    fetchImpl: async (url, request) => {
      captured.push({ url, request, rpc: JSON.parse(request.body) });
      return { status: code, text: async () => JSON.stringify({
        jsonrpc: '2.0', id: 1,
        result: { structuredContent: handler(), isError: false }
      }) };
    }
  });
  return { proxy, captured };
};

test('disabled by default', () => assert.equal(createOwnerGuiReadOnlyProxy({ config: {}, primaryStatus: primary }), null));
test('invalid destination and credential path fail at construction', () => {
  let c = cfg(); c.ownerGuiDelegation.port = 80;
  assert.throws(() => createOwnerGuiReadOnlyProxy({config:c, primaryStatus:primary}), /PORT_INVALID/);
  c = cfg(); c.ownerGuiDelegation.authFile = 'relative.txt';
  assert.throws(() => createOwnerGuiReadOnlyProxy({config:c, primaryStatus:primary}), /AUTH_PATH_INVALID/);
});
test('blocked, uncertain, and pending primary records fail closed without IO', async () => {
  for (const data of [{uncertain:true},{incidentPending:true},{incidentStoreUnavailable:true},{blocked:true}]) {
    const {proxy,captured} = make({status:()=>({...primary(),...data})});
    const r=await proxy.execute('gui_status');
    assert.equal(r.handled,false);
    assert.equal(captured.length,0);
  }
});
test('primary available remains authoritative', async () => {
  const {proxy,captured}=make({status:()=>({...primary(),available:true})});
  assert.equal((await proxy.execute('gui_status')).handled,false);
  assert.equal(captured.length,0);
});
test('unsupported GUI input is never proxied', async () => {
  const {proxy,captured}=make();
  for(const tool of ['gui_type_text','gui_mouse_click','gui_move_mouse','run_shell']) {
    assert.equal((await proxy.execute(tool,{})).handled,false);
  }
  assert.equal(captured.length,0);
});
test('takeover begin fails without making network request', async () => {
  const {proxy,captured}=make();
  await assert.rejects(()=>proxy.execute('gui_session_begin',{mode:'takeover'}),/OBSERVE_ONLY/);
  assert.equal(captured.length,0);
});
test('loopback, bearer header, and delegated status', async () => {
  const {proxy,captured}=make();
  const res=await proxy.execute('gui_status',{});
  assert.equal(res.handled,true);
  assert.equal(res.value.delegated,true);
  assert.equal(res.value.available,true);
  assert.equal(captured.length,1);
  assert.equal(captured[0].url,'http://127.0.0.1:48837/mcp');
  assert.equal(captured[0].request.redirect,'error');
  assert.equal(captured[0].request.headers['x-rc-owner-gui-auth'],authorized());
  assert.equal(captured[0].rpc.params.name,'gui_status');
});
test('downstream unavailable cannot be called ready', async () => {
  const {proxy}=make({handler:()=>({available:false,enabled:true})});
  assert.equal((await proxy.execute('gui_status')).handled,false);
});
test('upstream 403 and malformed credentials fail closed', async () => {
  const a=make({code:403});
  await assert.rejects(()=>a.proxy.execute('gui_status'),/TRANSPORT_UNAVAILABLE/);
  const b=make({secret:'not-a-secret'});
  await assert.rejects(()=>b.proxy.execute('gui_status'),/CREDENTIAL_INVALID/);
  assert.equal(b.captured.length,0);
});
test('validated status/lease pass through and image content preserves contract', async () => {
  const lease=make({handler:()=>({ok:true,lease:'xyz',mode:'observe'})});
  assert.deepEqual((await lease.proxy.execute('gui_session_begin',{mode:'observe'},{requestId:'existing-lease-test-1'})).value,{ok:true,lease:'xyz',mode:'observe'});
  const calls=[];
  const imageProxy=createOwnerGuiReadOnlyProxy({
    config:cfg(), primaryStatus:primary, readFileImpl:async()=>authorized(),
    fetchImpl:async(_url,opts)=>{
      calls.push(JSON.parse(opts.body).params.name);
      return {status:200,text:async()=>JSON.stringify({
        jsonrpc:'2.0',id:1,result:{
          content:[{type:'image',mimeType:'image/jpeg',data:'/9j/'},{type:'text',text:'metadata'}],
          structuredContent:{frame:'safe'},isError:false
        }
      })};
    }
  });
  const r=await imageProxy.execute('gui_screenshot',{lease:'xyz'});
  assert.equal(r.handled,true);
  assert.equal(r.value.__mcpContent[0].type,'image');
  assert.equal(r.value.__structuredContent.frame,'safe');
  assert.deepEqual(calls,['gui_screenshot']);
});
test('malformed JSON and downstream errors are generic', async () => {
  const p=createOwnerGuiReadOnlyProxy({
    config:cfg(),primaryStatus:primary,readFileImpl:async()=>authorized(),
    fetchImpl:async()=>({status:200,text:async()=>'<html>bad</html>'})
  });
  await assert.rejects(()=>p.execute('gui_status'),/INVALID_RESPONSE/);
  const q=createOwnerGuiReadOnlyProxy({
    config:cfg(),primaryStatus:primary,readFileImpl:async()=>authorized(),
    fetchImpl:async()=>({status:200,text:async()=>JSON.stringify({jsonrpc:'2.0',id:1,result:{isError:true}})})
  });
  await assert.rejects(()=>q.execute('gui_status'),/RPC_REJECTED/);
});

test('observe lease forwards a stable, distinct mutation correlation without credential leakage', async () => {
  const {proxy,captured} = make({handler:()=>({ok:true,mode:'observe',lease:'lease-only'})});
  await assert.rejects(()=>proxy.execute('gui_session_begin',{mode:'observe'}),/OWNER_GUI_REQUEST_ID_REQUIRED/);
  assert.equal(captured.length,0);
  const metadata={requestId:'session-test-987'};
  await proxy.execute('gui_session_begin',{mode:'observe'},metadata);
  await proxy.execute('gui_session_begin',{mode:'observe'},metadata);
  await proxy.execute('gui_session_end',{lease:'lease-only'},metadata);
  assert.equal(captured.length,3);
  const [first,retry,end]=captured.map(v=>v.rpc.params.arguments.requestId);
  assert.match(first,/^ogui-[a-f0-9]{48}$/);
  assert.equal(first,retry);
  assert.notEqual(first,end);
  assert.ok(!JSON.stringify(captured.map(v=>v.rpc)).includes('session-test-987'));
});