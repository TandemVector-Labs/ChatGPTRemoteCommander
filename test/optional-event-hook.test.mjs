import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createOptionalEventHook } from '../src/optional-event-hook.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-optional-hook-'));
  const script = path.join(dir, 'observer.mjs');
  fs.writeFileSync(script, '// private synthetic test fixture\n');
  const sha = createHash('sha256').update(fs.readFileSync(script)).digest('hex');
  return { dir, script, sha, config: { enabled: true, extensionId: 'fixture-observer', adapterPath: script, adapterSha256: sha } };
}
function capture() {
  const calls = [];
  const children = [];
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.stdin = { on() {}, end(value) { calls.push({ file, args, options, payload: value }); } };
    child.kill = () => true;
    children.push(child);
    return child;
  };
  return { spawn, calls, children };
}

test('no installed private observer is a no-op and does not start a process', () => {
  const cap = capture();
  const bridge = createOptionalEventHook(undefined, { spawn: cap.spawn });
  assert.equal(bridge.status().enabled, false);
  assert.equal(bridge.status().ready, false);
  assert.equal(bridge.emitTool('workflow_create'), false);
  assert.equal(cap.calls.length, 0);
});

test('an explicitly opted-in SHA-pinned private adapter receives only safe tool outcome metadata', () => {
  const f = fixture();
  try {
    const cap = capture();
    const bridge = createOptionalEventHook(f.config, { spawn: cap.spawn, env: { PATH: 'safe', SECRET_TOKEN: 'must-not-leak' }, randomUUID: () => 'opaque-test-id' });
    assert.equal(bridge.status().ready, true);
    assert.equal(bridge.emitTool('workflow_checkpoint', { failed: true, secret: 'private material' }), true);
    assert.equal(cap.calls.length, 1);
    const got = cap.calls[0];
    assert.equal(got.file, process.execPath);
    assert.deepEqual(got.args, [f.script]);
    assert.equal(got.options.shell, false);
    assert.equal(got.options.env.SECRET_TOKEN, undefined);
    assert.ok(!got.payload.includes('private material'));
    assert.equal(got.payload.endsWith('\n'), true);
    assert.deepEqual(JSON.parse(got.payload), {
      schemaVersion: 1, kind: 'tool_outcome', extensionId: 'fixture-observer',
      tool: 'workflow_checkpoint', failed: true, sessionId: 'opaque-test-id'
    });
    cap.children[0].emit('close', 0);
    assert.equal(bridge.status().relayProcessExitedZero, 1);
    assert.equal(bridge.status().deliveryConfirmed, false);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('runtime unapproved or unlisted tool never reaches observer', () => {
  const f = fixture();
  try {
    const cap = capture();
    const bridge = createOptionalEventHook(f.config, { spawn: cap.spawn });
    for (const name of ['run_shell', 'gui_click', 'PermissionRequest', 'agent_extension_list', '../danger']) {
      assert.equal(bridge.emitTool(name), false);
    }
    assert.equal(cap.calls.length, 0);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('tampered or missing adapter fails closed before invocation, even after ready', () => {
  const f = fixture();
  try {
    const cap = capture();
    const bridge = createOptionalEventHook(f.config, { spawn: cap.spawn });
    assert.equal(bridge.status().ready, true);
    fs.appendFileSync(f.script, '\n// mutated');
    assert.equal(bridge.status().ready, false);
    assert.equal(bridge.emitTool('workflow_create'), false);
    assert.equal(cap.calls.length, 0);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('symlink, hardlink, wrong extension and invalid path fail closed', t => {
  const f = fixture();
  try {
    const cap = capture();
    fs.linkSync(f.script, path.join(f.dir, 'hardlink.mjs'));
    assert.equal(createOptionalEventHook(f.config, { spawn: cap.spawn }).status().ready, false);
    fs.unlinkSync(path.join(f.dir, 'hardlink.mjs'));
    const bad = { ...f.config, adapterPath: path.join(f.dir, 'bad.txt') };
    assert.equal(createOptionalEventHook(bad).status().ready, false);
    if (process.platform === 'win32') {
      assert.equal(createOptionalEventHook({ ...f.config, adapterPath: '\\\\server\\share\\app.mjs' }).status().ready, false);
    }
    try {
      const link = path.join(f.dir, 'link.mjs');
      fs.symlinkSync(f.script, link);
      assert.equal(createOptionalEventHook({ ...f.config, adapterPath: link }).status().ready, false);
    } catch (e) {
      if (e.code !== 'EPERM') throw e;
      t.diagnostic('symlink permission unavailable; hardlink guard verified');
    }
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('at most one relay child is active and an abnormal child never changes tool outcome', () => {
  const f = fixture();
  try {
    const cap = capture();
    const bridge = createOptionalEventHook(f.config, { spawn: cap.spawn });
    assert.equal(bridge.emitTool('workflow_create'), true);
    assert.equal(bridge.emitTool('workflow_checkpoint'), false);
    assert.equal(bridge.status().dropped, 1);
    cap.children[0].emit('error', new Error('synthetic'));
    assert.equal(bridge.status().inFlight, false);
    assert.equal(bridge.emitTool('workflow_resume'), true);
    cap.children[1].emit('close', 2);
    assert.equal(bridge.status().relayProcessExitedZero, 0);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('public Commander source never vendors the specialty adapter, and status remains generic', () => {
  assert.equal(fs.existsSync(new URL('../src/coucou-bridge.mjs', import.meta.url)), false);
  assert.equal(fs.existsSync(new URL('../extensions/coucou-bridge/agent.json', import.meta.url)), false);
  const src = fs.readFileSync(new URL('../src/server-v0.3.mjs', import.meta.url), 'utf8');
  assert.match(src, /createOptionalEventHook\(config\.extensionEventRelay\)/);
  assert.match(src, /extensionEventRelay: extensionEventRelay\.status\(\)/);
  assert.doesNotMatch(src, /createCoucouBridge|coucouBridge\.emitTool/);
  assert.match(src, /extensionEventRelay\.emitTool\(name, \{ failed: result\?\.ok === false \|\| result\?\.isError === true \}\)/);
  assert.doesNotMatch(src, /extensionEventRelay\.emitTool\(name, \{[^\n]*(args|result:|user|project)/);
});
