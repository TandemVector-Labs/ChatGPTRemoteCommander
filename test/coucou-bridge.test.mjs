import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCoucouBridge, createCoucouEvent, verifyCoucouHook, COUCOU_AGENT } from '../src/coucou-bridge.mjs';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
// node:path is imported by the existing extension-manifest test below.
const TRUSTED_TEST_SHA = 'a'.repeat(64);

function harness(config = { enabled: true, hookPath: 'C:\\Program Files\\Coucou\\coucou-hook.exe', hookSha256: TRUSTED_TEST_SHA }, override = {}) {
  const calls = [];
  const children = [];
  let attempted = 0;
  const fakeSpawn = (file, args, options) => {
    attempted++;
    const child = new EventEmitter();
    child.stdin = { on() {}, end(payload) {
      calls.push({ file, args, options, payload: JSON.parse(payload.trim()) });
      queueMicrotask(() => child.emit('close', 0));
    } };
    child.kill = () => { child.emit('close', 1); return true; };
    children.push(child);
    return child;
  };
  const guardedConfig = config?.enabled === true && config.hookSha256 === undefined
    ? { ...config, hookSha256: TRUSTED_TEST_SHA } : config;
  const bridge = createCoucouBridge(guardedConfig, {
    platform: 'win32', fileExists: () => true, verifyHook: () => true, spawn: fakeSpawn,
    randomUUID: () => '00000000-0000-4000-8000-000000000001',
    ...override
  });
  return { bridge, calls, children, get attempted() { return attempted; } };
}

test('default is DISABLED; no subprocess, messages or network activity', () => {
  const x = harness({});
  assert.equal(x.bridge.status().enabled, false);
  assert.equal(x.bridge.emitTool('workflow_run_start'), false);
  assert.equal(x.attempted, 0);
});

test('explicit absolute coucou-hook path required; no arbitrary program execution', () => {
  for (const hookPath of ['', './coucou-hook.exe', 'C:\\temp\\powershell.exe', 'C:\\bin\\coucou-hook.cmd']) {
    const x = harness({ enabled: true, hookPath });
    assert.equal(x.bridge.status().ready, false, hookPath);
    assert.equal(x.bridge.emitTool('workflow_run_start'), false);
  }
});


test('Windows hook refuses UNC, device and drive-relative launch paths', () => {
  for (const hookPath of [
    '\\\\server\\share\\coucou-hook.exe',
    '\\\\?\\C:\\temp\\coucou-hook.exe',
    '\\relative-root\\coucou-hook.exe'
  ]) {
    const x = harness({ enabled: true, hookPath, hookSha256: TRUSTED_TEST_SHA });
    assert.equal(x.bridge.status().ready, false, hookPath);
    assert.equal(x.bridge.emitTool('workflow_run_start'), false);
  }
});

test('bridge requires explicit pinned SHA-256 before executing any user-local hook', () => {
  for (const hookSha256 of ['', 'invalid', '1'.repeat(63), 'zzz'.repeat(22)]) {
    const h = harness({enabled:true,hookPath:'C:\\Coucou\\coucou-hook.exe',hookSha256});
    assert.equal(h.bridge.status().ready,false);
    assert.equal(h.bridge.emitTool('workflow_run_start'),false);
    assert.equal(h.attempted,0);
  }
});

test('replaced hook is rejected on every emit without shell or fallback', () => {
  let trusted=true;
  const h=harness(undefined,{verifyHook:()=>trusted});
  assert.equal(h.bridge.status().ready,true);
  trusted=false;
  assert.equal(h.bridge.status().ready,false);
  assert.equal(h.bridge.emitTool('workflow_run_start'),false);
  assert.equal(h.attempted,0);
});

test('real SHA verification accepts only regular unchanged file content', () => {
  const dir=mkdtempSync(path.join(os.tmpdir(),'rc-coucou-sha-'));
  try {
    const hook=path.join(dir,'coucou-hook');
    writeFileSync(hook,'fixture only; not executable');
    const sha=createHash('sha256').update('fixture only; not executable').digest('hex');
    assert.equal(verifyCoucouHook(hook,sha),true);
    writeFileSync(hook,'modified content');
    assert.equal(verifyCoucouHook(hook,sha),false);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('missing relay is nonfatal; does not execute or suggest installation', () => {
  const x = harness({ enabled: true, hookPath: 'C:\\Coucou\\coucou-hook.exe' }, { fileExists: () => false });
  assert.equal(x.bridge.status().ready, false);
  assert.equal(x.bridge.emitTool('workflow_run_start'), false);
  assert.equal(x.attempted, 0);
});

test('schema uses approved Coucou custom agent and fixed safe event labels only', () => {
  assert.equal(COUCOU_AGENT, 'remote-commander');
  assert.equal(createCoucouEvent('unknown-tool', false, 'id'), null);
  for (const tool of ['workflow_create','workflow_run_start','workflow_run_tick','workflow_checkpoint','workflow_needs_chat','workflow_finalize','operation_start','operation_result']) {
    const payload = createCoucouEvent(tool, false, 'opaque-id');
    assert.equal(payload.coucou_agent, COUCOU_AGENT);
    assert.equal(payload.session_id, 'opaque-id');
    assert.ok(['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Notification','Stop','StopFailure'].includes(payload.hook_event_name));
    assert.equal(payload.cwd, undefined);
    assert.equal(payload.prompt, undefined);
    assert.equal(payload.tool_input, undefined);
    assert.equal(payload.tool_response, undefined);
    assert.equal(payload.request_id, undefined);
    assert.ok(!JSON.stringify(payload).includes('PermissionRequest'));
  }
  assert.equal(createCoucouEvent('workflow_finalize', true, 'id').hook_event_name, 'StopFailure');
  assert.equal(createCoucouEvent('workflow_checkpoint', true, 'id').hook_event_name, 'PostToolUseFailure');
});

test('relay subprocess is shell-free, hidden, nonblocking, and receives no inherited secrets', async () => {
  const x = harness(undefined, { env: {
    PATH: 'C:\\bin', LOCALAPPDATA: 'C:\\Users\\safe\\AppData\\Local',
    OPENAI_API_KEY: 'must-never-leak', SECRET_TOKEN: 'must-never-leak'
  } });
  const payloadArgs = { command: 'private path and OPENAI_API_KEY', password: 'must-never-leak' };
  assert.equal(x.bridge.emitTool('workflow_checkpoint', { args: payloadArgs, result: { file: 'private.txt' } }), true);
  assert.equal(x.calls.length, 1);
  const c = x.calls[0];
  assert.deepEqual(c.args, ['--agent', 'remote-commander', 'PostToolUse']);
  assert.equal(c.options.shell, false);
  assert.equal(c.options.windowsHide, true);
  assert.equal(c.options.cwd, 'C:\\');
  assert.equal(c.options.env.OPENAI_API_KEY, undefined);
  assert.equal(c.options.env.SECRET_TOKEN, undefined);
  assert.equal(c.payload.hook_event_name, 'PostToolUse');
  assert.ok(!JSON.stringify(c.payload).includes('must-never-leak'));
  assert.ok(!JSON.stringify(c.payload).includes('private'));
  await Promise.resolve();
  assert.equal(x.bridge.status().relayProcessExitedZero, 1);
  assert.equal(x.bridge.status().guiDeliveryConfirmed, false);
});

test('read-only calls, arbitrary names and permission events are excluded', () => {
  const x = harness();
  for (const name of ['read_text','system_status','gui_click','PermissionRequest','agent_extension_list','run_shell']) {
    assert.equal(x.bridge.emitTool(name), false, name);
  }
  assert.equal(x.attempted, 0);
});

test('one child in flight bounds resource usage; closure allows next event', async () => {
  const calls = [];
  const child = new EventEmitter();
  child.stdin = { on() {}, end(s) { calls.push(s); } };
  child.kill = () => true;
  const x = harness(undefined, { spawn: () => child });
  assert.equal(x.bridge.emitTool('workflow_run_start'), true);
  assert.equal(x.bridge.emitTool('workflow_checkpoint'), false);
  assert.equal(calls.length, 1);
  child.emit('close', 0);
  assert.equal(x.bridge.emitTool('workflow_checkpoint'), true);
  assert.equal(calls.length, 2);
});

test('spawn failure or relay nonzero must never throw into Commander tool path', async () => {
  const x = harness(undefined, { spawn: () => { throw new Error('relay unavailable'); } });
  assert.doesNotThrow(() => x.bridge.emitTool('workflow_run_start'));
  assert.equal(x.bridge.status().relayProcessExitedZero, 0);
  const y = harness();
  y.bridge.emitTool('workflow_run_start');
  y.children[0].emit('close', 2);
  assert.equal(y.bridge.status().relayProcessExitedZero, 0);
});

test('Linux absolute Unix relay and user-local runtime accepted', () => {
  const x = harness({ enabled: true, hookPath: '/home/agent/.local/share/coucou/bin/coucou-hook' }, { platform: 'linux' });
  assert.equal(x.bridge.status().ready, true);
  assert.equal(x.bridge.emitTool('workflow_create'), true);
  assert.equal(x.calls[0].options.cwd, '/');
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateAgentExtensionManifest } from '../src/agent-extensions.mjs';

test('declarative Coucou extension is valid, owner-scope limited and non-executing', () => {
  const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extensions/coucou-bridge');
  const manifest = JSON.parse(readFileSync(path.join(base, 'agent.json'), 'utf8'));
  const result = validateAgentExtensionManifest(manifest, base);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(manifest.id, 'coucou-bridge');
  assert.equal(manifest.metadata.mmzInstallAllowed, false);
  assert.equal(manifest.router, undefined);
  assert.ok(manifest.safetyGates.includes('no-approval-delegation'));
  assert.ok(manifest.safetyGates.includes('no-chat-delivery-claim'));
});

test('real Core code wires only approved tool outcome without args, and reports bridge status', () => {
  const src = readFileSync(new URL('../src/server-v0.3.mjs', import.meta.url), 'utf8');
  assert.match(src, /createCoucouBridge\(config\.coucouBridge\)/);
  assert.match(src, /coucouBridge: coucouBridge\.status\(\)/);
  assert.match(src, /coucouBridge\.emitTool\(name, \{ failed: result\?\.ok === false \|\| result\?\.isError === true \}\)/);
  assert.doesNotMatch(src, /coucouBridge\.emitTool\(name, \{[^\n]*(arguments|executionArgs|effectArgs|result:)/);
});
