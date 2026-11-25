import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const ext=await readFile(new URL('../gnome-extension/chatgpt-remote-commander-linux-safe-v2@god13emad/extension.js',import.meta.url),'utf8');
const helper=await readFile(new URL('../tools/gui-control-linux.py',import.meta.url),'utf8');
const controller=await readFile(new URL('../src/gui-tools-windows.mjs',import.meta.url),'utf8');
const shell=await readFile(new URL('../src/power-tools-v0.3.mjs',import.meta.url),'utf8');
const updater=await readFile(new URL('../auto-update-linux.sh',import.meta.url),'utf8');
const installer=await readFile(new URL('../tools/install-gnome-gui-extension.sh',import.meta.url),'utf8');
test('GNOME extension never creates or injects raw virtual input',()=>{
  for(const re of [/create_virtual_device\s*\(/,/notify_keyval\s*\(/,/notify_button\s*\(/,/notify_absolute_motion\s*\(/,/notify_relative_motion\s*\(/,/\bxdotool\b/i,/\bXTEST\b/i]) assert.doesNotMatch(ext,re);
  assert.match(ext,/get_current_time_roundtrip/); assert.match(ext,/GUI_INPUT_MUST_USE_MUTTER_REMOTE_DESKTOP/); assert.match(ext,/this\._service\?\.destroy\(\)/);
});
test('GNOME 50 compositor and monitor compatibility remains guarded',()=>{
  assert.match(ext,/Main\.layoutManager\.monitors/);
  assert.match(ext,/Meta\.is_wayland_compositor===undefined\|\|Meta\.is_wayland_compositor\(\)/);
  assert.doesNotMatch(ext,/global\.display\.get_n_monitors/);
  assert.doesNotMatch(ext,/global\.display\.get_primary_monitor/);
});
test('Linux helper uses Mutter RemoteDesktop with bounded per-operation release/stop',()=>{
  for(const x of ['org.gnome.Mutter.RemoteDesktop','CreateSession','Start','Stop','NotifyKeyboardKeycode','NotifyPointerButton','NotifyPointerMotionRelative','NotifyPointerAxisDiscrete','OPERATION_TIMEOUT_S','GUI_OPERATION_TIMEOUT']) assert.match(helper,new RegExp(x.replaceAll('.','\\.')));
  assert.match(helper,/for code in list\(reversed\(self\.buttons\)\)/); assert.match(helper,/for code in list\(reversed\(self\.keys\)\)/);
  assert.match(helper,/session-is-owner/); assert.match(helper,/clipboard_owner_generation/); assert.match(helper,/GUI_CLIPBOARD_OWNER_NOT_CONFIRMED/);
  assert.match(helper,/return self\.clipboard_transfer_count/,'paste confirmation baseline must be taken only after clipboard ownership is confirmed');
  assert.match(helper,/['"]protocol['"]:1/,'persistent helper handshake must remain protocol 1 compatible');
});
test('uncertain native input invalidates lease/frame/helper',()=>{
  assert.match(controller,/uncertain = true;[\s\S]{0,120}session = null; frame = null; closeInvoke\(\);/);
  assert.match(controller,/globalStopFile/);
});
test('direct shell GUI injection remains blocked independent of Full Power shell patterns',()=>{
  assert.match(shell,/assertNoDirectLinuxGuiMutation\(command\)/);
  for(const x of ['xdotool','ydotool','wtype','xte','setxkbmap','xmodmap','xinput']) assert.match(shell,new RegExp(x));
});

test('auto-update remains explicit-ref, expected-commit and candidate-first before promotion',()=>{
  assert.match(updater,/--source-ref/);
  assert.match(updater,/--expected-commit/);
  assert.match(updater,/stage expected commit mismatch/);
  assert.match(updater,/NO_PROMOTE/);
  assert.match(updater,/AUTO_UPDATE_CANDIDATE_PASS/);
  assert.match(updater,/run_gate/);
});

test('GNOME upgrade uses only exact-hash known-safe fallback when v2 is undiscoverable',()=>{
  assert.match(installer,/SAFE_FALLBACK_UUID='chatgpt-remote-commander-linux-safe@god13emad'/);
  assert.match(installer,/SAFE_FALLBACK_EXTENSION_SHA256='084c6c1244b25b4a714b0978d7f59b0b02fa8dbce45a962bff6cda6d18a17caa'/);
  assert.match(installer,/SAFE_FALLBACK_METADATA_SHA256='71375ff9ff21387355de83275be8a4b42361626208bcc120e7e41e6ffb08688e'/);
  assert.match(installer,/v2_known_before=false/);
  assert.match(installer,/activate_safe_fallback/);
  assert.match(installer,/GNOME_GUI_EXTENSION_FALLBACK_ACTIVE/);
  assert.match(installer,/new-uuid-not-discoverable/);
  assert.doesNotMatch(installer,/gnome-shell --replace/);
  assert.doesNotMatch(installer,/killall\s+gnome-shell/);
});

test('literal text uses Mutter clipboard plus physical keycodes, never extension clipboard or keysym remapping',()=>{
  assert.doesNotMatch(ext,/St\.Clipboard|clipboardStage|clipboardRestore/);
  for(const marker of ['EnableClipboard','SetSelection','SelectionRead','SelectionWrite','SelectionWriteDone','SelectionTransfer']) assert.match(helper,new RegExp(marker));
  assert.match(helper,/rd\.keycode\(29,true\)/i); assert.match(helper,/rd\.keycode\(47,true\)/i);
  assert.match(helper,/clipboard_restore\(saved\)/); assert.match(helper,/GUI_CLIPBOARD_OWNER_NOT_CONFIRMED/);
  assert.match(helper,/clipboard_owner_generation/); assert.match(helper,/clipboard_session_is_owner/);
  assert.doesNotMatch(helper,/NotifyKeyboardKeysym/);
});

test('GNOME owner window inventory reports real monitor index and frame rectangle',()=>{
 assert.match(ext,/w\.get_monitor\(\)/);
 assert.match(ext,/w\.get_frame_rect\(\)/);
 assert.match(ext,/screenIndex/);
 assert.match(ext,/bounds=\{left:rect\.x,top:rect\.y,width:rect\.width,height:rect\.height\}/);
});
