import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateCapabilityConfig, compareCapabilityState } from '../src/capability-profile.mjs';
import { assessAccessStatus } from '../src/full-access-status.mjs';

const proof = { ok:true, action:'os.probe', root:true, effectiveUid:0 };
const defaults = () => ({
  powerMode: { enabled:false, guiControl:{}, browserControl:{} },
  durableWorkflows: { enabled:false }, autoUpdate: {enabled:false}
});
const existing = () => ({
  powerMode: { enabled:true, fullFilesystem:true, allowShell:true, allowProcessControl:true,
    blockedShellPatterns:[], guiControl:{enabled:true}, browserControl:{enabled:true} },
  durableWorkflows: {enabled:false}, autoUpdate:{enabled:false},
  capabilityProfile: { id:'owner', tier:'FULL_POWER', explicitlyAuthorized:true,
    persistAcrossUpdates:true, autoEnableNewCapabilities:true, disabledCapabilities:[],
    source:'explicit-user-authorization' }
});

test('FULL_ACCESS explicitly requested requires verified native broker proof', () => {
  assert.throws(()=>migrateCapabilityConfig({defaultConfig:defaults(),existingConfig:existing(),requestFullAccess:true,nativeBrokerPlatform:'linux'}),/FULL_ACCESS_NATIVE_BROKER_PROOF_REQUIRED/);
  assert.throws(()=>migrateCapabilityConfig({defaultConfig:defaults(),existingConfig:existing(),requestFullAccess:true,nativeBrokerProof:{...proof,effectiveUid:1000},nativeBrokerPlatform:'linux'}),/FULL_ACCESS_NATIVE_BROKER_PROOF_REQUIRED/);
  assert.throws(()=>migrateCapabilityConfig({defaultConfig:defaults(),existingConfig:existing(),requestFullAccess:true,requestStandard:true,nativeBrokerProof:proof,nativeBrokerPlatform:'linux'}),/CAPABILITY_MODE_CONFLICT/);
});

test('explicit native broker enrollment persists FULL_ACCESS without granting an unrestricted elevated shell',()=>{
  const first=migrateCapabilityConfig({defaultConfig:defaults(),existingConfig:existing(),profileId:'owner',requestFullAccess:true,nativeBrokerProof:proof,nativeBrokerPlatform:'linux'});
  assert.equal(first.profile.tier,'FULL_ACCESS');
  assert.equal(first.profile.source,'native-broker-verified-enrollment');
  const active=assessAccessStatus(first.config,proof,{platform:'linux',effectiveUid:1000});
  assert.equal(active.configuredTier,'FULL_ACCESS');
  assert.equal(active.effectiveTier,'FULL_POWER');
  assert.equal(active.broker.verified,true);
  assert.equal(active.fullAccessActive,false);
  assert.equal(assessAccessStatus(first.config,proof,{platform:'linux'}).broker.unrestrictedAdminShell,false);
  const repeat=migrateCapabilityConfig({defaultConfig:defaults(),existingConfig:first.config,profileId:'owner'});
  assert.equal(repeat.profile.tier,'FULL_ACCESS');
  assert.equal(assessAccessStatus(repeat.config,{ok:false},{platform:'linux',effectiveUid:1000}).effectiveTier,'FULL_POWER');
  const ordinaryPower=migrateCapabilityConfig({defaultConfig:defaults(),existingConfig:first.config,requestPower:true});
  assert.equal(ordinaryPower.profile.tier,'FULL_POWER');
});

test('STANDARD explicitly demotes FULL_ACCESS and tier downgrade is a regression',()=>{
  const full=migrateCapabilityConfig({defaultConfig:defaults(),existingConfig:existing(),requestFullAccess:true,nativeBrokerProof:proof,nativeBrokerPlatform:'linux'});
  const standard=migrateCapabilityConfig({defaultConfig:defaults(),existingConfig:full.config,requestStandard:true});
  assert.equal(standard.profile.tier,'STANDARD');
  const result=compareCapabilityState(full.config,standard.config);
  assert.equal(result.ok,false);
  assert.equal(result.regression,true);
});
