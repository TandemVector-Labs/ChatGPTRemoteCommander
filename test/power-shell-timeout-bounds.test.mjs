import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {boundedCommandTimeout} from '../src/command-timeout-limits.mjs';
import {assessAccessStatus} from '../src/full-access-status.mjs';
import {prepareShellCommand} from '../src/power-tools-v0.3.mjs';
import {runShell as legacyRunShell} from '../src/power-tools.mjs';
import {prepareProjectCommand} from '../src/tools-v0.3.mjs';
import {runProjectCommand as legacyProjectCommand} from '../src/tools.mjs';

function context(root, maxCommandMs = 4000, authorized = true) {
  const config = {
    capabilityProfile: {tier: 'FULL_POWER', explicitlyAuthorized: true, disabledCapabilities: []},
    powerMode: {
      enabled: true, fullFilesystem: true, allowShell: true,
      maxCommandMs, maxOutputBytes: 4096, blockedShellPatterns: []
    }
  };
  // Synthetic test status only; production authorization is separate.
  return {roots: [root], config,
    ...(authorized ? {accessStatus: assessAccessStatus(config, null,
      {platform: 'linux', effectiveUid: 1000})} : {})};
}

test('shared Shell and project-command timeout validation rejects coercion, non-finite and out-of-range durations', () => {
  for (const invalid of [-1, 0, 0.5, NaN, Infinity, -Infinity,
    3_600_001, 2 ** 31, '3000', true, [], {}]) {
    assert.throws(() => boundedCommandTimeout(invalid, 4000),
      /COMMAND_TIMEOUT_INVALID/);
  }
  let coerced = false;
  const trap = {valueOf() {coerced = true; throw Error('VALUE_OF_USED'); }};
  assert.throws(() => boundedCommandTimeout(trap, 4000),
    /COMMAND_TIMEOUT_INVALID/);
  assert.equal(coerced, false);
  for (const policy of [-1, 0, 500, NaN, Infinity, '4000', 3_600_001]) {
    assert.throws(() => boundedCommandTimeout(1000, policy),
      /COMMAND_TIMEOUT_POLICY_INVALID/);
  }
  assert.equal(boundedCommandTimeout(undefined, 4000), 4000);
  assert.equal(boundedCommandTimeout(null, 4000), 4000);
  assert.equal(boundedCommandTimeout(100, 4000), 1000);
  assert.equal(boundedCommandTimeout(5000, 4000), 4000);
  assert.equal(boundedCommandTimeout(4000, 4000), 4000);
});

test('both authorized Power Shell routes reject invalid timers before spawning', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-timeout-guard-'));
  const ctx = context(root);
  const command = "Write-Output 'NO_EXECUTION'";
  try {
    for (const invalid of [NaN, Infinity, 2 ** 31, -1, 0.5, '3000']) {
      await assert.rejects(prepareShellCommand(ctx, {command, cwd: root, timeoutMs: invalid}),
        /COMMAND_TIMEOUT_INVALID/);
      await assert.rejects(legacyRunShell(ctx, {command, cwd: root, timeoutMs: invalid}),
        /COMMAND_TIMEOUT_INVALID/);
    }
    for (const policy of [NaN, Infinity, '4000', 3_600_001]) {
      const invalidCtx = context(root, policy);
      await assert.rejects(prepareShellCommand(invalidCtx, {command, cwd: root, timeoutMs: 1000}),
        /COMMAND_TIMEOUT_POLICY_INVALID/);
      await assert.rejects(legacyRunShell(invalidCtx, {command, cwd: root, timeoutMs: 1000}),
        /COMMAND_TIMEOUT_POLICY_INVALID/);
    }
    await assert.rejects(prepareShellCommand(context(root, 4000, false),
      {command, cwd: root, timeoutMs: Infinity}), /Power Mode is disabled/);
    await assert.rejects(legacyRunShell(context(root, 4000, false),
      {command, cwd: root, timeoutMs: Infinity}), /Power Mode is disabled/);
    const valid = await prepareShellCommand(ctx, {command, cwd: root, timeoutMs: 6000});
    assert.equal(valid.timeoutMs, 4000);
    assert.deepEqual(fs.readdirSync(root), [], 'rejected inputs must not spawn or write any files');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('project-command route also rejects malformed timeout before process launch', async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-project-timeout-')));
  const cfg = maxCommandMs => ({
    roots: [root],
    config: { allowedPrograms: ['node'], maxCommandMs, powerMode: {enabled: false}}
  });
  const prepare = (context, timeoutMs) => prepareProjectCommand(context, {
    program: 'node', args: ['--version'], cwd: root, timeoutMs
  });
  try {
    for (const invalid of [NaN, Infinity, -Infinity, 2 ** 31, 3_600_001,
      -1, 0, 1.5, '4000', true, [], {}]) {
      await assert.rejects(prepare(cfg(4000), invalid),
        /COMMAND_TIMEOUT_INVALID/);
    }
    let coerced = false;
    const trap = {valueOf() {coerced = true;throw Error('VALUE_OF_USED');}};
    await assert.rejects(prepare(cfg(4000), trap), /COMMAND_TIMEOUT_INVALID/);
    assert.equal(coerced, false);
    for (const invalidPolicy of [NaN, Infinity, -1, 0, 999, 3_600_001, '4000']) {
      await assert.rejects(prepare(cfg(invalidPolicy), 1000),
        /COMMAND_TIMEOUT_POLICY_INVALID/);
    }
    for (const [requested, expected] of [[undefined,4000],[null,4000],[1,1000],[9000,4000],[2000,2000]]) {
      const prepared = await prepare(cfg(4000), requested);
      assert.equal(prepared.timeoutMs, expected);
    }
    assert.deepEqual(fs.readdirSync(root), [], 'preparing commands must never launch or write');
  } finally {
    fs.rmSync(root, {recursive: true,force: true});
  }
});

// The pre-v0.3 legacy project route must not let malformed times reach pwsh.
test('legacy project-command route shares the fail-closed timeout policy',async()=>{
 const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc-legacy-project-')));
 const context=limit=>({roots:[root],config:{allowedPrograms:['node'],maxCommandMs:limit},
  auditLog:path.join(root,'audit.jsonl')});
 const call=(limit,timeout)=>legacyProjectCommand(context(limit),{
  program:'node',args:['--version'],cwd:root,timeoutMs:timeout
 });
 try{
  let coerced=false;
  const trap={valueOf(){coerced=true;throw Error('UNTRUSTED_VALUE_OF')}};
  for(const invalid of [Infinity,NaN,-Infinity,2147483648,3600001,-1,0,1.5,'5000',true,[],{},trap]){
   await assert.rejects(call(4000,invalid),/COMMAND_TIMEOUT_INVALID/);
  }
  assert.equal(coerced,false);
  for(const policy of [Infinity,NaN,-1,0,999,'5000',3600001]){
   await assert.rejects(call(policy,1000),/COMMAND_TIMEOUT_POLICY_INVALID/);
  }
  assert.deepEqual(fs.readdirSync(root),[],'invalid inputs must not spawn or create audit artifacts');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
