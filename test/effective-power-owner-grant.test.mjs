import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {effectivePowerMode} from '../src/effective-power-mode.mjs';
import {assessAccessStatus} from '../src/full-access-status.mjs';
import {runShell} from '../src/power-tools-v0.3.mjs';

function accessStatus(cfg, effectiveUid = 1000) {
  return assessAccessStatus(cfg, null, {platform:'linux',effectiveUid});
}
function config(tier, explicitlyAuthorized, disabledCapabilities = []) {
  return {
    powerMode: {
      enabled: true, fullFilesystem: true, allowShell: true,
      allowProcessControl: true, maxCommandMs: 4000,
      maxOutputBytes: 4096, blockedShellPatterns: []
    },
    capabilityProfile: {tier, explicitlyAuthorized, disabledCapabilities}
  };
}

test('raw FULL flags cannot execute Shell in STANDARD or without owner grant', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rc-effective-power-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  for (const cfg of [config('STANDARD', false), config('STANDARD', true),
    config('FULL_POWER', false), config('FULL_POWER', true, ['shell.execute'])]) {
    assert.equal(effectivePowerMode(cfg, {accessStatus:accessStatus(cfg)}).allowShell, false);
    await assert.rejects(
      runShell({roots: [dir], config: cfg}, {
        command: 'echo SHOULD_NOT_RUN', cwd: dir, timeoutMs: 2000
      }),
      /shell execution is disabled|Power Mode is disabled/i
    );
  }
});

test('a separately authorized owner FULL_POWER grant executes only harmless local echo', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rc-effective-grant-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const cfg = config('FULL_POWER', true);
  const status = accessStatus(cfg);
  assert.equal(effectivePowerMode(cfg, {accessStatus:status}).allowShell, true);
  const result = await runShell({roots: [dir], config: cfg, accessStatus:status},
    {command: 'echo OWNER_GRANTED_TEST', cwd: dir, timeoutMs: 3000});
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /OWNER_GRANTED_TEST/);
});

test('explicit capability revocation restricts filesystem, process and browser independently', () => {
  const cfg = config('FULL_POWER', true, [
    'filesystem.full', 'process.control', 'browser.background'
  ]);
  cfg.powerMode.browserControl = {enabled: true, allowInput: true};
  const effective = effectivePowerMode(cfg, {accessStatus:accessStatus(cfg)});
  assert.equal(effective.fullFilesystem, false);
  assert.equal(effective.allowProcessControl, false);
  assert.equal(effective.allowPersistentTerminal, false);
  assert.equal(effective.browserControl.enabled, false);
  assert.equal(effective.browserControl.allowInput, false);
});

test('STANDARD and FULL_POWER never inherit an elevated host token; FULL_ACCESS requires it', () => {
  const power = config('FULL_POWER', true);
  const full = config('FULL_ACCESS', true);
  const standard = config('STANDARD', true);
  const powerAsRoot = accessStatus(power, 0);
  const fullAsOwner = accessStatus(full, 1000);
  const fullAsRoot = accessStatus(full, 0);
  assert.equal(powerAsRoot.effectiveTier, 'STANDARD');
  assert.equal(effectivePowerMode(power, {accessStatus:powerAsRoot}).enabled, false);
  assert.equal(fullAsOwner.effectiveTier, 'FULL_POWER');
  assert.equal(effectivePowerMode(full, {accessStatus:fullAsOwner}).enabled, true);
  assert.equal(effectivePowerMode(full, {accessStatus:fullAsOwner}).allowShell, true);
  assert.equal(fullAsRoot.effectiveTier, 'FULL_ACCESS');
  assert.equal(effectivePowerMode(full, {accessStatus:fullAsRoot}).enabled, true);
  assert.equal(effectivePowerMode(standard, {accessStatus:accessStatus(standard)}).enabled, false);
});


test('Windows token tiers are distinct and STANDARD never inherits an elevated Administrator token', () => {
  const standardToken = {ok:true,isAdmin:false,isSystem:false,elevation:'standard',source:'local-process-token'};
  const elevatedToken = {ok:true,isAdmin:true,isSystem:false,elevation:'high',source:'local-process-token'};
  const power = config('FULL_POWER', true);
  const full = config('FULL_ACCESS', true);
  const standard = config('STANDARD', true);
  const powerStatus = assessAccessStatus(power, null, {platform:'win32',adminToken:standardToken});
  const powerAsAdmin = assessAccessStatus(power, null, {platform:'win32',adminToken:elevatedToken});
  const fullStatus = assessAccessStatus(full, null, {platform:'win32',adminToken:elevatedToken});
  const standardStatus = assessAccessStatus(standard, null, {platform:'win32',adminToken:elevatedToken});
  assert.equal(powerStatus.effectiveTier, 'FULL_POWER');
  assert.equal(powerAsAdmin.effectiveTier, 'STANDARD');
  assert.equal(effectivePowerMode(power, {accessStatus:powerAsAdmin}).enabled, false);
  assert.equal(fullStatus.effectiveTier, 'FULL_ACCESS');
  assert.equal(fullStatus.fullAccessActive, true);
  assert.equal(standardStatus.effectiveTier, 'STANDARD');
  assert.equal(effectivePowerMode(standard, {accessStatus:standardStatus}).enabled, false);
});

test('FULL_ACCESS cannot fall back to FULL_POWER when its shell policy is restricted', () => {
  const cfg = config('FULL_ACCESS', true);
  cfg.powerMode.blockedShellPatterns = ['rm'];
  const status = accessStatus(cfg, 0);
  assert.equal(status.effectiveTier, 'STANDARD');
  assert.equal(status.fullAccessBlocker, 'FULL_ACCESS_SHELL_SCOPE_REQUIRED');
  assert.equal(effectivePowerMode(cfg, {accessStatus:status}).enabled, false);
});

test('missing, mismatched or stale host access status fails closed', () => {
  const cfg = config('FULL_POWER', true);
  assert.equal(effectivePowerMode(cfg).enabled, false);
  assert.equal(effectivePowerMode(cfg, {accessStatus:{configuredTier:'FULL_ACCESS',effectiveTier:'FULL_ACCESS',operationalFullAccess:true,nativeRoot:{verified:true}}}).enabled, false);
  assert.equal(effectivePowerMode(cfg, {accessStatus:{configuredTier:'FULL_POWER',effectiveTier:'FULL_POWER'}}).enabled, false);
});
