import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, stat, rm } from 'node:fs/promises';
import { defaultBrowserCompanionRoot, sanitizeMonitorSnapshot, writeBrowserCompanionMonitor } from '../src/browser-companion-monitor.mjs';

test('default roots are platform-separated from Chromium profile data',()=>{
  assert.equal(defaultBrowserCompanionRoot({platform:'win32',env:{LOCALAPPDATA:'C:\\Users\\u\\AppData\\Local'},home:'C:\\Users\\u'}),'C:\\Users\\u\\AppData\\Local\\ChatGPTRemoteCommander\\browser-companion');
  assert.equal(defaultBrowserCompanionRoot({platform:'linux',env:{XDG_STATE_HOME:'/tmp/state'},home:'/home/u'}),'/tmp/state/chatgpt-remote-commander/browser-companion');
});

test('monitor snapshot is bounded and strips untrusted extra fields',()=>{
  const s=sanitizeMonitorSnapshot({
    identity:{deviceName:'host',profile:'default',version:'0.10.19',configSha256:'a'.repeat(64),port:48832,platform:'linux',secret:'no'},
    gui:{enabled:true,available:true,uncertain:true,backend:'gnome-mutter-remote-desktop',sessionType:'wayland',capabilities:{screenshot:true,mouse:true,keyboard:true,focus:true,other:true}},
    browser:{enabled:true,available:true,uncertain:true,backend:'chromium-cdp'},
    workflows:{enabled:true,engineEnabled:true,runCount:3},
    extensions:{items:[{id:'project-execution-brain',version:'1.3.1',path:'/secret'}]},
    operations:{active:1,lockedKeys:2}
  },1000);
  assert.equal(s.kind,'COMMANDER_LIVE_MONITOR');
  assert.equal(s.expiresAtEpochMs,11000);
  assert.deepEqual(s.extensions.items,[{id:'project-execution-brain',version:'1.3.1'}]);
  assert.equal('secret' in s.identity,false);
  assert.equal('other' in s.gui.capabilities,false);
  assert.equal(s.gui.uncertain,true);
  assert.equal(s.browser.uncertain,true);
  const unavailable=sanitizeMonitorSnapshot({
    identity:{deviceName:'host',profile:'default',version:'0.10.19',configSha256:'c'.repeat(64),port:48831,platform:'win32'},
    gui:{enabled:true,available:false,backend:'',sessionType:'',reason:''},
    browser:{enabled:true,available:false,backend:'',reason:''},
    workflows:{enabled:true,engineEnabled:true,runCount:0},
    extensions:{items:[]},
    operations:{active:0,lockedKeys:0}
  },1500);
  assert.equal(unavailable.gui.backend,null);
  assert.equal(unavailable.gui.sessionType,null);
  assert.equal(unavailable.gui.reason,null);
  assert.equal(unavailable.browser.backend,null);
  assert.equal(unavailable.browser.reason,null);
});

test('Windows-style GUI status falls back to policy capabilities without overriding explicit capability fields',()=>{
  const base={
    identity:{deviceName:'win-host',profile:'default',version:'0.10.20',configSha256:'e'.repeat(64),port:48831,platform:'win32'},
    gui:{enabled:true,available:true,uncertain:false,backend:'windows-user32-gdi',sessionType:null,reason:null,
      policy:{allowScreenshot:true,allowMouse:true,allowKeyboard:true,allowWindowFocus:true}},
    browser:{enabled:true,available:true,uncertain:false,backend:'chromium-cdp',reason:null},
    workflows:{enabled:true,engineEnabled:true,runCount:0},
    extensions:{items:[]},
    operations:{active:0,lockedKeys:0}
  };
  const fallback=sanitizeMonitorSnapshot(base,4000);
  assert.deepEqual(fallback.gui.capabilities,{screenshot:true,mouse:true,keyboard:true,focus:true});
  const explicit=sanitizeMonitorSnapshot({...base,gui:{...base.gui,capabilities:{screenshot:false,mouse:false,keyboard:false,focus:false}}},4000);
  assert.deepEqual(explicit.gui.capabilities,{screenshot:false,mouse:false,keyboard:false,focus:false});
});

test('linux monitor writer creates owner-private bounded snapshot',{skip:process.platform!=='linux'},async()=>{
  const base=await mkdtemp(path.join(os.tmpdir(),'rc-monitor-'));
  const root=path.join(base,'state','browser-companion');
  try{
    const receipt=await writeBrowserCompanionMonitor(root,{
      identity:{deviceName:'host',profile:'default',version:'0.10.19',configSha256:'b'.repeat(64),port:48832,platform:'linux'},
      gui:{enabled:true,available:false,reason:'TEST'},
      browser:{enabled:true,available:false,reason:'TEST'},
      workflows:{enabled:false,engineEnabled:false,runCount:0},
      extensions:{items:[]},
      operations:{active:0,lockedKeys:0}
    },{platform:'linux',now:()=>2000});
    const raw=await readFile(receipt.target,'utf8');
    const parsed=JSON.parse(raw);
    assert.equal(parsed.observedAtEpochMs,2000);
    assert.equal((await stat(root)).mode & 0o777,0o700);
    assert.equal((await stat(receipt.target)).mode & 0o777,0o600);
  }finally{await rm(base,{recursive:true,force:true});}
});

test('windows fresh user install creates missing monitor root',{skip:process.platform!=='win32'},async()=>{
  const base=await mkdtemp(path.join(os.tmpdir(),'rc-monitor-new-win-'));
  const root=path.join(base,'fresh','browser-companion');
  try{
    const receipt=await writeBrowserCompanionMonitor(root,{
      identity:{deviceName:'host',profile:'default',version:'0.11.0-dev.105',platform:'win32'},
      gui:{enabled:false,available:false},
      browser:{enabled:false,available:false},
      workflows:{enabled:false,engineEnabled:false,runCount:0},
      extensions:{items:[]},
      operations:{active:0,lockedKeys:0}
    },{platform:'win32',now:()=>5000});
    assert.equal((await stat(root)).isDirectory(),true);
    assert.equal(JSON.parse(await readFile(receipt.target,'utf8')).observedAtEpochMs,5000);
  }finally{await rm(base,{recursive:true,force:true});}
});
test('windows monitor writer uses a pre-created local root without POSIX mode assumptions',{skip:process.platform!=='win32'},async()=>{
  const base=await mkdtemp(path.join(os.tmpdir(),'rc-monitor-win-'));
  const root=path.join(base,'browser-companion');
  try{
    await mkdir(root);
    const receipt=await writeBrowserCompanionMonitor(root,{
      identity:{deviceName:'host',profile:'default',version:'0.10.19',configSha256:'d'.repeat(64),port:48831,platform:'win32'},
      gui:{enabled:true,available:false,uncertain:false,reason:'TEST'},
      browser:{enabled:true,available:false,uncertain:false,reason:'TEST'},
      workflows:{enabled:false,engineEnabled:false,runCount:0},
      extensions:{items:[]},
      operations:{active:0,lockedKeys:0}
    },{platform:'win32',now:()=>3000});
    const parsed=JSON.parse(await readFile(receipt.target,'utf8'));
    assert.equal(parsed.identity.platform,'win32');
    assert.equal(parsed.observedAtEpochMs,3000);
  }finally{await rm(base,{recursive:true,force:true});}
});
