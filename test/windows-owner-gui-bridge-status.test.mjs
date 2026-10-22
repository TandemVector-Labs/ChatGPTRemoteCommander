import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuiController } from '../src/gui-tools-windows.mjs';

const attested = () => ({
  ok: true, authenticated: true, protocol: 1,
  backend: 'windows-owner-session-namedpipe-readonly',
  ownerSession: 1, ownerDisplayWidth: 3440, ownerDisplayHeight: 1440,
  operations: ['status'], screenshot: false, mouse: false, keyboard: false, focus: false
});
function fixture(probe, optIn = true) {
  let calls = 0;
  const gui = createGuiController({
    platform: 'win32', isStopped: async () => false,
    incidentStore: { pending: async () => null },
    invoke: async () => ({ ok: true, available: false, session: 0, screens: [] }),
    ownerSessionStatusProbe: async () => { calls++; return probe(); }
  });
  const ctx = { config: { powerMode: { enabled: true, guiControl: {
    enabled: true, ownerSessionBridgeReadOnly: optIn, allowScreenshot: true, allowMouse: true
  } } } };
  return { gui, ctx, calls: () => calls };
}
test('opt-in signed Session 1 readiness never promotes Session 0 gui_status to interactive availability', async () => {
  const s = fixture(attested);
  const status = await s.gui.execute(s.ctx, 'gui_status');
  assert.equal(status.available, false);
  assert.deepEqual(status.screens, []);
  assert.equal(status.session, 0);
  assert.deepEqual(status.ownerSessionBridge, {
    state:'AUTHENTICATED_READONLY',ownerSession:1,
    displayWidth:3440,displayHeight:1440,
    screenshot:false,input:false,takeover:false,nativeGuiRoutable:false
  });
  assert.equal(s.calls(), 1);
  await assert.rejects(() => s.gui.execute(s.ctx, 'gui_session_begin', {mode:'observe'}), /GUI_DESKTOP_UNAVAILABLE/);
  assert.equal(s.calls(), 1);
});
test('bridge does not even probe without explicit opt-in', async () => {
  const s = fixture(attested, false);
  const status = await s.gui.execute(s.ctx, 'gui_status');
  assert.equal(status.available, false);
  assert.equal(Object.hasOwn(status, 'ownerSessionBridge'), false);
  assert.equal(s.calls(), 0);
});
test('invalid or forged owner session status fails closed and never grants a lease', async () => {
  for (const bad of [
    {...attested(),authenticated:false}, {...attested(),operations:['status','click']},
    {...attested(),screenshot:true}, {...attested(),ownerDisplayWidth:0},
    {...attested(),ownerSession:0}, {...attested(),ownerSession:'1'}, {...attested(),backend:'forged'},
    {...attested(),mouse:true}, {...attested(),protocol:2}, null
  ]) {
    const s = fixture(() => bad);
    const status = await s.gui.execute(s.ctx, 'gui_status');
    assert.equal(status.available, false);
    assert.deepEqual(status.ownerSessionBridge,{state:'UNAVAILABLE',nativeGuiRoutable:false});
    await assert.rejects(() => s.gui.execute(s.ctx,'gui_session_begin',{mode:'observe'}),/GUI_DESKTOP_UNAVAILABLE/);
  }
  const s = fixture(() => { throw new Error('private error'); });
  assert.deepEqual((await s.gui.execute(s.ctx,'gui_status')).ownerSessionBridge,
    {state:'UNAVAILABLE',nativeGuiRoutable:false});
});
test('emergency stop suppresses owner-session probe and never resumes the core native GUI', async () => {
  let probes = 0;
  const gui = createGuiController({
    platform:'win32',isStopped:async()=>true,incidentStore:{pending:async()=>null},
    invoke:async()=>{throw new Error('must not run native helper');},
    ownerSessionStatusProbe:async()=>{probes++;return attested();}
  });
  const status=await gui.execute({config:{powerMode:{enabled:true,guiControl:{enabled:true,ownerSessionBridgeReadOnly:true}}}},'gui_status');
  assert.equal(status.available,false);
  assert.equal(status.reason,'LOCAL_GUI_STOP');
  assert.equal(probes,0);
});
