import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { guiToolDefinitions, validateGuiInput } from '../src/gui-contract.mjs';
import { createGuiController } from '../src/gui-tools-windows.mjs';
import { createGuiProcessClient, runGuiProcess } from '../src/gui-process.mjs';
import { validateTransport } from '../src/transport-guard.mjs';

const config = () => ({ config: { powerMode: { enabled: true, guiControl: { enabled: true, allowScreenshot: true, allowMouse: true, allowKeyboard: true, allowWindowFocus: true } } } });
// Deliberately a protocol fixture, NOT proof of real screen capture.
const image = () => ({ ok: true, data: Buffer.from('89504e470d0a1a0a00000000', 'hex').toString('base64'), mimeType: 'image/png', width: 800, height: 600, snapshot: { screenIndex: 0, bounds: { left: -800, top: 0, width: 800, height: 600 }, foreground: '123', processId: 10 } });
function memoryIncidentStore() {
  let active = null, sequence = 0;
  return {
    pending: async () => active,
    begin: async tool => {
      if (active) throw new Error('GUI_INCIDENT_UNRESOLVED');
      active = { id: 'fixture-'+(++sequence), tool };
      return active;
    },
    resolve: async handle => {
      if (!active || active.id !== handle?.id || active.tool !== handle?.tool)
        throw new Error('GUI_INCIDENT_RESOLUTION_MISMATCH');
      active = null;
    }
  };
}
function setup(custom = {}) {
  let time = 1000, counter = 0, stop = false;
  const calls = [];
  const c = createGuiController({ platform: 'win32', now: () => time, token: () => (++counter).toString(16).padStart(48, '0'), isStopped: async () => stop,
    invoke: async r => { calls.push(r); return r.action === 'screenshot' ? image() : { ok: true, available: true }; },
    incidentStore: memoryIncidentStore(), ...custom });
  const ctx = config();
  const run = (name, args = {}) => c.execute(ctx, name, args);
  return { ctx, run, calls, time: n => { time += n; }, stop: () => { stop = true; } };
}
async function prepared(s) {
  const { lease } = await s.run('gui_session_begin', { mode:'takeover', explicitUserAuthorization:'Explicit test authorization for disposable fixture' });
  const shot = await s.run('gui_screenshot', { lease });
  return { lease, frame: shot.__structuredContent.frame };
}

test('15 unique, closed-schema GUI tools; mutating input is marked destructive', () => {
  assert.equal(guiToolDefinitions.length, 15);
  assert.equal(new Set(guiToolDefinitions.map(d => d.name)).size, 15);
  for (const d of guiToolDefinitions) assert.equal(d.inputSchema.additionalProperties, false);
  for (const name of ['gui_mouse_click','gui_mouse_drag','gui_key_press','gui_type_text','gui_focus_window']) assert.equal(guiToolDefinitions.find(d => d.name === name).annotations.destructiveHint, true);
});
const invalid = [
  ['gui_screenshot', { lease:'x', action:'typeText', text:'NOT_SENT' }],
  ['gui_mouse_move', { lease:'x', frame:'y', action:'screenshot', x:0,y:0 }],
  ['gui_mouse_move', { lease:'x', frame:'y', x:NaN,y:0 }],
  ['gui_mouse_move', { lease:'x', frame:'y', x:Infinity,y:0 }],
  ['gui_mouse_move', { lease:'x', frame:'y', x:'10',y:0 }],
  ['gui_mouse_move', { lease:'x', frame:'y', x:0.5,y:0 }],
  ['gui_mouse_move', { lease:'x', frame:'y', x:1.01,y:0,coordinateMode:'relative' }],
  ['gui_mouse_click', { lease:'x', frame:'y', x:0,y:0,clicks:5000 }],
  ['gui_mouse_click', { lease:'x', frame:'y', x:0,y:0,button:'other' }],
  ['gui_mouse_drag', { lease:'x', frame:'y', from:{}, to:{} }],
  ['gui_mouse_drag', { lease:'x', frame:'y', from:{x:0,y:0,action:'typeText'}, to:{x:0,y:0} }],
  ['gui_mouse_drag', { lease:'x', frame:'y', from:{x:0,y:0},to:{x:1,y:1},durationMs:100000 }],
  ['gui_mouse_delta', { lease:'x', frame:'y', dx:1001,dy:0 }],
  ['gui_mouse_scroll', { lease:'x', frame:'y', delta:100000 }],
  ['gui_key_press', { lease:'x', frame:'y', keys:['CTRL','BOGUS'] }],
  ['gui_key_press', { lease:'x', frame:'y', keys:['CTRL','CONTROL'] }],
  ['gui_key_press', { lease:'x', frame:'y', keys:['ESC'] }],
  ['gui_key_press', { lease:'x', frame:'y', keys:['A'],holdMs:Infinity }],
  ['gui_type_text', { lease:'x', frame:'y', text:'A'.repeat(1025) }],
  ['gui_type_text', { lease:'x', frame:'y', text:'A'.repeat(50),intervalMs:100 }],
  ['gui_type_text', { lease:'x', frame:'y', text:'\u0000' }],
  ['gui_type_text', { lease:'x', frame:'y', text:'\ud800' }],
  ['gui_focus_window', { lease:'x', frame:'y' }],
  ['gui_focus_window', { lease:'x', frame:'y',handle:'5',titleContains:'Any' }],
  ['gui_focus_window', { lease:'x', frame:'y',handle:'0' }],
  ['gui_screenshot', { lease:'x',screenIndex:-1 }],
  ['gui_screenshot', { lease:'x',maxWidth:100000 }],
  ['gui_status', { __mcpContent:[] }],
  ['gui_status', JSON.parse('{"__proto__":{"x":1}}')],
  ['gui_status', null],
  ['gui_session_begin', { ttlSeconds:999999 }],
  ['gui_session_begin', { mode:'takeover' }],
  ['gui_session_begin', { mode:'observe', explicitUserAuthorization:'not allowed here' }],
  ['gui_no_such_tool', {}]
];
for (const [i,[name,args]] of invalid.entries()) test(`reject invalid request ${i+1}: ${name}`, async () => {
  const s = setup(); await assert.rejects(s.run(name,args), /GUI_/); assert.equal(s.calls.length,0);
});
test('literal multilingual Unicode + punctuation accepted, no shell interpretation', () => {
  const text = 'سلام +{}[] test 日本語 😀\n';
  assert.equal(validateGuiInput('gui_type_text', {lease:'l',frame:'f',text}).text,text);
});
test('key aliases are validated and normalized before any injection', () => {
  assert.deepEqual(validateGuiInput('gui_key_press',{lease:'l',frame:'f',keys:['Control','a']}).keys,['CTRL','A']);
});
test('zero-interference desktop policy is machine-readable and fail-closed', async () => {
  const s=setup();
  const status=await s.run('gui_status');
  assert.equal(status.policy.interactionPolicy,'explicit-current-request-only');
  assert.equal(status.policy.defaultSessionMode,'observe');
  assert.equal(status.policy.backgroundPreferred,true);
  assert.equal(status.policy.workflowTakeoverAllowed,false);
  assert.equal(status.policy.foregroundInterferenceByDefault,false);
});

test('Windows GUI read-only status identifies absent display without inventing an RDP cause', async () => {
  const s=setup({platform:'win32',invoke:async () => ({ok:true,enabled:true,available:false,session:2,screens:[]})});
  const status=await s.run('gui_status');
  assert.equal(status.enabled,true);
  assert.equal(status.available,false);
  assert.equal(status.reason,'GUI_NO_ACTIVE_DISPLAY');
  assert.deepEqual(status.screens,[]);
  await assert.rejects(s.run('gui_session_begin'),/GUI_DESKTOP_UNAVAILABLE/);
});

test('native backend reason is preserved and active Windows display stays available', async () => {
  const denied=setup({platform:'win32',invoke:async () => ({ok:true,available:false,reason:'NATIVE_BACKEND_ISSUE',screens:[]})});
  assert.equal((await denied.run('gui_status')).reason,'NATIVE_BACKEND_ISSUE');
  const ready=setup({platform:'win32',invoke:async () => ({ok:true,available:true,screens:[{width:1920,height:1080}]})});
  assert.equal((await ready.run('gui_status')).available,true);
  assert.equal((await ready.run('gui_status')).reason,undefined);
});

test('GUI not enabled is fail closed even if Power Mode enabled', async () => {
  const s=setup(); s.ctx.config.powerMode.guiControl.enabled=false;
  assert.equal((await s.run('gui_status')).available,false);
  await assert.rejects(s.run('gui_session_begin'),/GUI_DISABLED/); assert.equal(s.calls.length,0);
});
test('unsupported platforms do not claim native GUI support', async () => {
  const s=setup({platform:'darwin'}); assert.equal((await s.run('gui_status')).reason,'PLATFORM_BACKEND_UNSUPPORTED');
});
test('Linux controller exposes the GNOME backend when the native helper is ready', async () => {
  const s=setup({platform:'linux',invoke:async r=>r.action==='status'?{ok:true,available:true,backend:'gnome-shell-wayland',screens:[{index:0,left:0,top:0,width:1920,height:1080,primary:true}]}:image()});
  const status=await s.run('gui_status');
  assert.equal(status.available,true);assert.equal(status.backend,'gnome-shell-wayland');assert.equal(status.enabled,true);
});
test('disabled screenshot capability is enforced before invoking helper', async () => {
  const s=setup(); const {lease}=await s.run('gui_session_begin'); s.ctx.config.powerMode.guiControl.allowScreenshot=false;
  await assert.rejects(s.run('gui_screenshot',{lease}),/GUI_CAPABILITY_DISABLED/); assert.equal(s.calls.length,1);
});
test('mouse permission cannot be escalated to keyboard via extra action', async () => {
  const s=setup(); const a=await prepared(s); s.ctx.config.powerMode.guiControl.allowKeyboard=false;
  await assert.rejects(s.run('gui_mouse_move',{...a,x:0,y:0,action:'typeText',text:'NO'}),/GUI_INVALID/);
  await assert.rejects(s.run('gui_key_press',{...a,keys:['A']}),/GUI_CAPABILITY_DISABLED/);
  assert.equal(s.calls.length,2);
});
test('owner-authorized Full-Power fallback permits takeover for stale client schema', async () => {
  const s=setup();
  s.ctx.config.capabilityProfile={tier:'FULL_POWER',explicitlyAuthorized:true};
  s.ctx.config.powerMode.guiControl.ownerAuthorizedTakeover=true;
  const begun=await s.run('gui_session_begin');
  assert.equal(begun.mode,'takeover');
  assert.equal(begun.authorization,'owner-persisted');
  const shot=await s.run('gui_screenshot',{lease:begun.lease});
  const clicked=await s.run('gui_mouse_click',{lease:begun.lease,frame:shot.__structuredContent.frame,x:1,y:1});
  assert.equal(clicked.submitted,true);
});

test('owner fallback is denied without explicit Full-Power profile authorization', async () => {
  const s=setup();
  s.ctx.config.powerMode.guiControl.ownerAuthorizedTakeover=true;
  s.ctx.config.capabilityProfile={tier:'STANDARD',explicitlyAuthorized:false};
  const begun=await s.run('gui_session_begin');
  assert.equal(begun.mode,'observe');
});

test('observe-only is the default and blocks desktop mutation before native input', async () => {
  const s=setup(); const {lease,mode}=await s.run('gui_session_begin'); assert.equal(mode,'observe');
  const shot=await s.run('gui_screenshot',{lease});
  await assert.rejects(s.run('gui_mouse_click',{lease,frame:shot.__structuredContent.frame,x:1,y:1}),/GUI_TAKEOVER_NOT_AUTHORIZED/);
  assert.equal(s.calls.length,2); assert.equal(s.calls[0].action,'status'); assert.equal(s.calls[1].action,'screenshot');
});
test('takeover mode requires explicit authorization and permits guarded mutation', async () => {
  const s=setup(); const a=await prepared(s); const r=await s.run('gui_mouse_click',{...a,x:1,y:1});
  assert.equal(r.submitted,true); assert.equal(s.calls.at(-1).action,'click');
});
test('single desktop lease prevents second chat from taking control', async () => {
  const s=setup(); await s.run('gui_session_begin'); await assert.rejects(s.run('gui_session_begin'),/GUI_LEASE_BUSY/);
});
test('session end and lease expiry close the persistent helper lifecycle', async () => {
  let closed=0;
  const s=setup({closeInvoke:()=>{closed++;}});
  const {lease}=await s.run('gui_session_begin',{ttlSeconds:10});
  await s.run('gui_session_end',{lease});
  assert.equal(closed,1);
  const b=await s.run('gui_session_begin',{ttlSeconds:10});
  s.time(10001);
  await assert.rejects(s.run('gui_session_renew',{lease:b.lease}),/GUI_LEASE_REQUIRED/);
  assert.equal(closed,2);
});
test('wrong lease cannot end or renew another session', async () => {
  const s=setup(); await s.run('gui_session_begin');
  for (const n of ['gui_session_end','gui_session_renew','gui_screenshot']) await assert.rejects(s.run(n,{lease:'not-yours'}),/GUI_LEASE_REQUIRED/);
});
test('Unicode token lookalike never reaches timingSafeEqual with unequal buffers', async () => {
  const s=setup(); await s.run('gui_session_begin'); await assert.rejects(s.run('gui_screenshot',{lease:'é'.repeat(48)}),/GUI_LEASE_REQUIRED/);
});
test('expired lease cannot be renewed, a new session gets a new token', async () => {
  const s=setup(); const a=await s.run('gui_session_begin',{ttlSeconds:10}); s.time(10001);
  await assert.rejects(s.run('gui_session_renew',{lease:a.lease}),/GUI_LEASE_REQUIRED/);
  const b=await s.run('gui_session_begin'); assert.notEqual(a.lease,b.lease);
});
test('input without fresh frame refused', async () => {
  const s=setup(); const {lease}=await s.run('gui_session_begin',{mode:'takeover',explicitUserAuthorization:'Explicit test authorization for fixture'});
  await assert.rejects(s.run('gui_key_press',{lease,frame:'invented',keys:['A']}),/GUI_FRESH_FRAME/);
});
test('single-use frame permits exactly one input, screenshot remains in MCP image content', async () => {
  const s=setup(); const a=await prepared(s);
  const r=await s.run('gui_mouse_click',{...a,x:-500,y:20});
  assert.equal(r.submitted,true); assert.equal(r.visualVerificationRequired,true);
  assert.equal(s.calls.at(-1).action,'click'); assert.equal(s.calls.at(-1).expected.foreground,'123');
  assert.equal(s.calls.at(-1).lease,undefined); assert.equal(s.calls.at(-1).frame,undefined);
  await assert.rejects(s.run('gui_mouse_click',{...a,x:-500,y:20}),/GUI_FRESH_FRAME/);
});
test('stale screenshot rejected after 15 seconds', async () => {
  const s=setup(); const a=await prepared(s); s.time(15001);
  await assert.rejects(s.run('gui_key_press',{...a,keys:['A']}),/GUI_FRESH_FRAME/);
});
test('new screenshot invalidates the prior frame', async () => {
  const s=setup(); const a=await prepared(s); await s.run('gui_screenshot',{lease:a.lease});
  await assert.rejects(s.run('gui_key_press',{...a,keys:['A']}),/GUI_FRESH_FRAME/);
});
test('local emergency stop rejects capture and input without killing services', async () => {
  const s=setup(); const a=await prepared(s); s.stop();
  assert.equal((await s.run('gui_status')).blocked,true);
  await assert.rejects(s.run('gui_key_press',{...a,keys:['A']}),/GUI_LOCAL_STOP/);
  assert.equal(s.calls.length,2);
});
test('uncertain native outcome suspends further GUI actions; no blind retry', async () => {
  let count=0;
  const s=setup({invoke:async r=>{count++;if(r.action==='status')return{ok:true,available:true};if(r.action==='screenshot')return image();throw new Error('GUI_SENDINPUT_FAILED');}});
  const a=await prepared(s); await assert.rejects(s.run('gui_key_press',{...a,keys:['A']}),/GUI_SENDINPUT_FAILED/);
  await assert.rejects(s.run('gui_screenshot',{lease:a.lease}),/GUI_OUTCOME_UNCERTAIN/);
  assert.equal((await s.run('gui_status')).uncertain,true);assert.equal(count,3);
});

test('Linux attested pre-dispatch click rejection preserves no-effect without replaying input',async()=>{
  let clicks=0;
  const s=setup({platform:'linux',invoke:async r=>{
    if(r.action==='status')return {ok:true,available:true};
    if(r.action==='screenshot')return image();
    if(r.action==='click'){clicks++;throw Object.assign(new Error('GUI_FOREGROUND_OR_GEOMETRY_CHANGED'),{guiCode:'GUI_FOREGROUND_OR_GEOMETRY_CHANGED',guiNotApplied:true});}
    return {ok:true};
  }});
  const a=await prepared(s);
  await assert.rejects(s.run('gui_mouse_click',{...a,x:-720,y:10}),/GUI_FOREGROUND_OR_GEOMETRY_CHANGED/);
  assert.notEqual((await s.run('gui_status')).uncertain,true);
  await assert.rejects(s.run('gui_screenshot',{lease:a.lease}),/GUI_LEASE_REQUIRED_OR_EXPIRED/);
  const next=await s.run('gui_session_begin',{mode:'observe'});
  const fresh=await s.run('gui_screenshot',{lease:next.lease});
  assert.ok(fresh.__structuredContent.frame);
  assert.equal(clicks,1);
  await s.run('gui_session_end',{lease:next.lease});
});

for(const [platform,tool,code,attested] of [
  ['win32','gui_focus_window','GUI_FOCUS_NOT_CONFIRMED',true],
  ['linux','gui_mouse_click','GUI_FOREGROUND_OR_GEOMETRY_CHANGED',false],
  ['linux','gui_key_press','GUI_FOREGROUND_OR_GEOMETRY_CHANGED',true],
  ['linux','gui_mouse_click','GUI_SENDINPUT_FAILED',true]
])test('unknown input is still fail-closed on '+platform+'/'+tool+'/'+code+'/'+attested,async()=>{
  const s=setup({platform,invoke:async r=>{
    if(r.action==='status')return {ok:true,available:true};
    if(r.action==='screenshot')return image();
    throw Object.assign(new Error(code),{guiCode:code,guiNotApplied:attested});
  }});
  const a=await prepared(s);
  const args=tool==='gui_focus_window'?{...a,handle:'123'}:tool==='gui_key_press'?{...a,keys:['A']}:{...a,x:-750,y:5};
  await assert.rejects(s.run(tool,args),/GUI_/);
  assert.equal((await s.run('gui_status')).uncertain,true);
  await assert.rejects(s.run('gui_session_begin',{mode:'observe'}),/GUI_OUTCOME_UNCERTAIN/);
});

test('Linux native no-effect attestation occurs before MutterInput dispatch',async()=>{
  const source=await fs.readFile(new URL('../tools/gui-control-linux.py',import.meta.url),'utf8');
  const begin=source.indexOf('def handle_input(req):');
  const end=source.indexOf('\ndef ',begin+1);
  assert.ok(begin>=0&&end>begin);
  const body=source.slice(begin,end);
  assert.ok(body.includes("if action=='click' and e.code=='GUI_FOREGROUND_OR_GEOMETRY_CHANGED'"));
  assert.ok(body.includes("'effect':'NOT_APPLIED','phase':'PRE_DISPATCH_GUARD'"));
  assert.ok(body.indexOf('observed=guard(req,deadline)')<body.indexOf('with MutterInput(req,deadline)'));
});

test('persistent helper propagates exact pre-dispatch no-effect receipt without auto retry',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'rc-gui-noeffect-'));
  let client;
  try{
    const helper=path.join(folder,'helper.cjs');
    const source=[
      "process.stdout.write(JSON.stringify({ok:true,ready:true,protocol:1})+'\\n');",
      "let buf='';let count=0;process.stdin.setEncoding('utf8');",
      "process.stdin.on('data',part=>{buf+=part;while(buf.includes('\\n')){const p=buf.indexOf('\\n');const line=buf.slice(0,p);buf=buf.slice(p+1);const req=JSON.parse(line);count++;const value=req.mode==='guard'?{ok:false,error:'GUI_FOREGROUND_OR_GEOMETRY_CHANGED',effect:'NOT_APPLIED',phase:'PRE_DISPATCH_GUARD'}:{ok:true,count};process.stdout.write(JSON.stringify(value)+'\\n');}});"
    ].join('');
    await fs.writeFile(helper,source);
    client=createGuiProcessClient({file:process.execPath,args:[helper],startupTimeoutMs:2500,timeoutMs:2500});
    await assert.rejects(client.invoke({mode:'guard'}),e=>e.guiCode==='GUI_FOREGROUND_OR_GEOMETRY_CHANGED'&&e.guiNotApplied===true);
    const state=await client.invoke({mode:'status'});
    assert.equal(state.ok,true);assert.equal(state.count,2);
  }finally{client?.close();await fs.rm(folder,{recursive:true,force:true});}
});

test('concurrent GUI requests are rejected, not queued for stale execution', async () => {
  let unblock;
  const s=setup({invoke:r => r.action==='status' ? Promise.resolve({ok:true,available:true}) : new Promise(resolve=>{unblock=()=>resolve(image());})});
  const {lease}=await s.run('gui_session_begin'); const pending=s.run('gui_screenshot',{lease});
  await new Promise(resolve=>setImmediate(resolve)); await assert.rejects(s.run('gui_screenshot',{lease}),/GUI_BUSY/);
  unblock(); await pending;
});
test('expired lease during slow capture does not acquire a new frame', async () => {
  let advance;
  const s=setup({invoke:async r=>{if(r.action==='status')return{ok:true,available:true};advance();return image();}});
  advance=()=>s.time(10001);const {lease}=await s.run('gui_session_begin',{ttlSeconds:10});
  await assert.rejects(s.run('gui_screenshot',{lease}),/GUI_LEASE_REQUIRED/);
});
for(const mutation of [r=>({...r,data:'garbage'}),r=>({...r,mimeType:'text/html'}),r=>({...r,snapshot:null}),r=>({...r,width:100000}),r=>({...r,data:'AAAA'})]) test('invalid native image rejected',async()=>{
  const s=setup({invoke:async r=>r.action==='status'?{ok:true,available:true}:mutation(image())});
  const {lease}=await s.run('gui_session_begin');await assert.rejects(s.run('gui_screenshot',{lease}),/GUI_INVALID_IMAGE/);
});
for(const [headers,code] of [[{host:'attacker.invalid:47831'},403],[{host:'127.0.0.1:47831.evil'},403],[{host:'127.0.0.1:47831',origin:'https://evil.invalid'},403],[{host:'127.0.0.1:47831',origin:'null'},403],[{host:'127.0.0.1:47831','sec-fetch-site':'cross-site'},403],[{host:'127.0.0.1:47831','content-type':'text/plain'},415]]) test(`HTTP admission refuses ${JSON.stringify(headers)}`,()=>{
  assert.throws(()=>validateTransport({method:'POST',headers},{port:47831}),e=>e.httpStatus===code);
});
for(const host of ['127.0.0.1:47831','localhost:47831','[::1]:47831']) test('nonbrowser JSON request retains '+host,()=>{
  validateTransport({method:'POST',headers:{host,'content-type':'application/json; charset=utf-8'}},{port:47831});
});
test('persistent helper reuses one process, bounds output, and restarts after timeout',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rc-gui-persistent-'));
  let client;
  try {
    const helper=path.join(root,'helper.cjs');
    await fs.writeFile(helper,`process.stdout.write(JSON.stringify({ok:true,ready:true,protocol:1})+'\\n');let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;for(;;){const i=b.indexOf('\\n');if(i<0)break;const line=b.slice(0,i);b=b.slice(i+1);const r=JSON.parse(line);if(r.mode==='valid')process.stdout.write(JSON.stringify({ok:true,pid:process.pid})+'\\n');else if(r.mode==='failure')process.stdout.write(JSON.stringify({ok:false,error:'GUI_LOCAL_STOP'})+'\\n');else if(r.mode==='large')process.stdout.write('x'.repeat(10000)+'\\n');else if(r.mode==='bad')process.stdout.write('not JSON\\n');else if(r.mode==='hang'){}else process.stdout.write(JSON.stringify({ok:true})+'\\n');}});`);
    client=createGuiProcessClient({file:process.execPath,args:[helper],timeoutMs:300,maxBytes:4096,startupTimeoutMs:2000});
    const a=await client.invoke({mode:'valid'}),b=await client.invoke({mode:'valid'});
    assert.equal(a.pid,b.pid);
    await assert.rejects(client.invoke({mode:'failure'}),/GUI_LOCAL_STOP/);
    client.close();client=createGuiProcessClient({file:process.execPath,args:[helper],timeoutMs:300,maxBytes:4096,startupTimeoutMs:2000});
    await assert.rejects(client.invoke({mode:'large'}),/GUI_HELPER_OUTPUT_LIMIT/);
    client.close();client=createGuiProcessClient({file:process.execPath,args:[helper],timeoutMs:300,maxBytes:4096,startupTimeoutMs:2000});
    await assert.rejects(client.invoke({mode:'bad'}),/GUI_HELPER_BAD_JSON/);
    client.close();client=createGuiProcessClient({file:process.execPath,args:[helper],timeoutMs:150,maxBytes:4096,startupTimeoutMs:2000});
    await assert.rejects(client.invoke({mode:'hang'}),/GUI_HELPER_TIMEOUT/);
    const restarted=await client.invoke({mode:'valid'});assert.equal(restarted.ok,true);
  } finally { client?.close();await fs.rm(root,{recursive:true,force:true}); }
});

test('helper process JSON lifecycle, malformed JSON and output bounds',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rc-gui-test-'));
  try {
    const helper=path.join(root,'helper.cjs');
    await fs.writeFile(helper,"let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const r=JSON.parse(s);if(r.mode==='valid')process.stdout.write(JSON.stringify({ok:true}));else if(r.mode==='large')process.stdout.write('x'.repeat(10000));else if(r.mode==='bad')process.stdout.write('not JSON');else if(r.mode==='failure')process.stdout.write(JSON.stringify({ok:false,error:'GUI_LOCAL_STOP'}));else if(r.mode==='hang')setInterval(()=>{},1000);});");
    const options={file:process.execPath,args:[helper],timeoutMs:3000,maxBytes:4096};
    assert.equal((await runGuiProcess({mode:'valid'},options)).ok,true);
    await assert.rejects(runGuiProcess({mode:'large'},options),/GUI_HELPER_OUTPUT_LIMIT/);
    await assert.rejects(runGuiProcess({mode:'bad'},options),/GUI_HELPER_BAD_JSON/);
    await assert.rejects(runGuiProcess({mode:'failure'},options),/GUI_LOCAL_STOP/);
    await assert.rejects(runGuiProcess({mode:'hang'},{...options,timeoutMs:200}),/GUI_HELPER_TIMEOUT/);
    await assert.rejects(runGuiProcess({}, {file:path.join(root,'not-an-executable'),args:[],timeoutMs:200}),/GUI_HELPER_START_FAILED/);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
