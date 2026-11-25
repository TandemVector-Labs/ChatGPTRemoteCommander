import test from 'node:test';
import assert from 'node:assert/strict';
import { assessAccessStatus, verifyPrivilegedBrokerProof, createAccessStatusReader } from '../src/full-access-status.mjs';
import { probeWindowsAdministrator } from '../src/windows-admin-token.mjs';

const base = (tier = 'FULL_ACCESS') => ({
  capabilityProfile: { tier, explicitlyAuthorized: true },
  powerMode: { enabled: true, fullFilesystem: true }
});
const root = { ok:true, action:'os.probe', root:true, effectiveUid:0 };
const system = { ok:true, action:'os.probe', isSystem:true, sid:'S-1-5-18' };
const standardToken = {ok:true,isAdmin:false,isSystem:false,elevation:'standard',source:'local-process-token'};

test('broker capabilities do not advertise unprovisioned Linux mutation as granted', () => {
  const status=assessAccessStatus(base(),root,{platform:'linux',effectiveUid:1000});
  assert.equal(status.broker.verified,true);
  assert.deepEqual(status.broker.supportedActions,
    ['os.probe','system_unit.status','system_unit.start']);
  assert.deepEqual(status.broker.allowedActions,
    ['os.probe','system_unit.status']);
  assert.deepEqual(status.broker.nativeGrantRequiredActions,
    ['system_unit.start']);
  assert.deepEqual(status.broker.allowedMutations,[]);
  assert.equal(status.broker.nativeProfileBindingVerified,false);
  const windows=assessAccessStatus(base(),system,{platform:'win32',adminToken:standardToken});
  assert.deepEqual(windows.broker.allowedActions,['os.probe','broker.task.status']);
  assert.deepEqual(windows.broker.nativeGrantRequiredActions,[]);
  assert.deepEqual(windows.broker.allowedMutations,[]);
});

test('Linux native root broker permits effective tier only for explicitly enrolled full access', () => {
  const staged=assessAccessStatus(base(), root, {platform:'linux',effectiveUid:1000});
  assert.equal(staged.configuredTier,'FULL_ACCESS');
  assert.equal(staged.effectiveTier,'STANDARD');
  assert.equal(staged.broker.verified,true);
  assert.equal(staged.fullAccessActive,false);
  assert.equal(staged.operationalFullAccess,false);
  assert.equal(staged.fullAccessBlocker,'LINUX_ROOT_PROCESS_NOT_ELEVATED');
  assert.equal(assessAccessStatus(base(), root, {platform:'linux'}).broker.unrestrictedAdminShell,false);
  assert.equal(assessAccessStatus(base('FULL_POWER'), root, {platform:'linux',effectiveUid:0}).effectiveTier,'STANDARD');
  assert.equal(assessAccessStatus(base('STANDARD'), root, {platform:'linux'}).effectiveTier,'STANDARD');
});

test('Windows native SYSTEM proof must match exact SID and current action', () => {
  assert.equal(verifyPrivilegedBrokerProof(system,'win32'),true);
  for(const bad of [
    {...system,sid:'S-1-5-32-544'}, {...system,action:'system_unit.start'},
    {...system,isSystem:false}, {...system,ok:false}
  ]) assert.equal(verifyPrivilegedBrokerProof(bad,'win32'),false);
  assert.equal(assessAccessStatus(base(),system,{platform:'win32'}).fullAccessActive,false);
  assert.equal(assessAccessStatus(base(),system,{platform:'win32'}).broker.verified,true);
});


test('Windows current-token probe distinguishes standard, elevated and SYSTEM identities',async()=>{
  const run=async stdout=>probeWindowsAdministrator({
    platform:'win32',
    execute:(_file,_args,_options,callback)=>callback(null,stdout,'')
  });
  assert.deepEqual(await run('RC_NON_ELEVATED_USER_TOKEN'),standardToken);
  assert.deepEqual(await run('RC_ELEVATED_ADMIN_TOKEN'),{
    ok:true,isAdmin:true,isSystem:false,elevation:'high',source:'local-process-token'
  });
  assert.deepEqual(await run('RC_SYSTEM_TOKEN'),{
    ok:true,isAdmin:true,isSystem:true,elevation:'system',source:'local-process-token'
  });
  assert.equal((await probeWindowsAdministrator({platform:'linux'})).code,'WINDOWS_TOKEN_NOT_APPLICABLE');
});

test('missing or forged proof never promotes restricted host access', () => {
  for(const proof of [null,{}, {ok:true}, {ok:true,root:true,effectiveUid:1000,action:'os.probe'}]) {
    const status=assessAccessStatus(base(),proof,{platform:'linux'});
    assert.equal(status.fullAccessActive,false);
    assert.equal(status.effectiveTier,'STANDARD');
    assert.equal(status.enrollmentRequired,true);
  }
  const standard=base('STANDARD');
  assert.equal(assessAccessStatus(standard,root,{platform:'linux'}).effectiveTier,'STANDARD');
});

test('explicit owner grant and enabled app power are mandatory even with root proof', () => {
  const ungranted=base(); ungranted.capabilityProfile.explicitlyAuthorized=false;
  assert.equal(assessAccessStatus(ungranted,root,{platform:'linux',effectiveUid:0}).fullAccessActive,false);
  assert.equal(assessAccessStatus(ungranted,root,{platform:'linux',effectiveUid:0}).fullAccessBlocker,'FULL_ACCESS_OWNER_GRANT_REQUIRED');
  const off=base(); off.powerMode.enabled=false;
  assert.equal(assessAccessStatus(off,root,{platform:'linux',effectiveUid:0}).effectiveTier,'STANDARD');
  assert.equal(assessAccessStatus(off,root,{platform:'linux',effectiveUid:0}).fullAccessBlocker,'POWER_MODE_DISABLED');
});

test('cached successful probe, force refresh and revoked broker fail closed',async () => {
  let count=0; let time=100;
  const read=createAccessStatusReader({
    config:base(), platform:'linux', ttlMs:1000, now:()=>time,
    probe:async(action)=>{ assert.equal(action,'os.probe');count++; return count===1?root:{ok:false,code:'BROKER_DOWN'}; }
  });
  assert.equal((await read()).broker.verified,true);
  assert.equal((await read()).fullAccessActive,false);
  assert.equal(count,1);
  time=1200;
  const revoked=await read();
  assert.equal(revoked.fullAccessActive,false);
  assert.equal(revoked.broker.code,'BROKER_DOWN');
  assert.equal(count,2);
  const forced=await read({force:true});
  assert.equal(forced.fullAccessActive,false);
  assert.equal(count,3);
});


test('forced host-token refresh bypasses an older in-flight probe before returning authorization status', async()=>{
  const c=base('FULL_ACCESS');
  Object.assign(c.powerMode,{allowShell:true,allowProcessControl:true,blockedShellPatterns:[]});
  let resolveFirst;
  let brokerCalls=0;
  let tokenCalls=0;
  const read=createAccessStatusReader({
    config:c,platform:'win32',ttlMs:15000,
    probe:async()=>{brokerCalls++;if(brokerCalls===1)return new Promise(resolve=>{resolveFirst=resolve;});return system;},
    probeWindowsAdmin:async()=>{
      tokenCalls++;
      return tokenCalls===1?standardToken:{
        ok:true,isAdmin:true,isSystem:false,elevation:'high',source:'local-process-token'
      };
    }
  });
  const first=read();
  while(!resolveFirst) await Promise.resolve();
  const forced=read({force:true});
  resolveFirst({ok:false,code:'BROKER_STALE'});
  const before=await first;
  const after=await forced;
  assert.equal(before.broker.code,'BROKER_STALE');
  assert.equal(before.effectiveTier,'FULL_POWER');
  assert.equal(after.broker.verified,true);
  assert.equal(after.effectiveTier,'FULL_ACCESS');
  assert.equal(brokerCalls,2);
  assert.equal(tokenCalls,2);
});

test('broker client transport errors never make full access active',async()=>{
  const read=createAccessStatusReader({config:base(),platform:'win32',probe:async()=>{throw Error('transport');}});
  const status=await read();
  assert.equal(status.fullAccessActive,false);
  assert.equal(status.broker.code,'BROKER_PROBE_FAILED');
});


test('hostExecution is owner-scoped FULL_HOST_USER, never native system elevation',()=>{
  const c=base('FULL_POWER');
  Object.assign(c.powerMode,{allowShell:true,blockedShellPatterns:[],allowProcessControl:true});
  const result=assessAccessStatus(c,root,{platform:'linux',effectiveUid:1000});
  assert.equal(result.hostExecution.mode,'FULL_HOST_USER');
  assert.equal(result.hostExecution.osTokenBoundaryApplies,true);
  assert.equal(result.hostExecution.nativeElevationNotImplied,true);
  assert.equal(result.hostExecution.externalApprovalsNotBypassed,true);
  assert.equal(result.broker.unrestrictedAdminShell,false);
  assert.equal(result.effectiveTier,'FULL_POWER');
  for(const [field,val] of [['fullFilesystem',false],['allowShell',false],['blockedShellPatterns',['restricted']]]){
    const d=structuredClone(c);d.powerMode[field]=val;
    const changed=assessAccessStatus(d,root,{platform:'linux',effectiveUid:1000});
    if(field==='blockedShellPatterns') {
      assert.equal(changed.hostExecution.mode,'FULL_HOST_USER');
      assert.equal(changed.hostExecution.noCommanderShellPatternRestrictions,false);
    } else assert.equal(changed.hostExecution.mode,'RESTRICTED');
  }
  const noOwner=structuredClone(c);noOwner.capabilityProfile.explicitlyAuthorized=false;
  assert.equal(assessAccessStatus(noOwner,root,{platform:'linux'}).hostExecution.mode,'RESTRICTED');
  const standard=structuredClone(c);standard.capabilityProfile.tier='STANDARD';
  assert.equal(assessAccessStatus(standard,root,{platform:'linux'}).hostExecution.mode,'RESTRICTED');
});

test('Windows elevated admin remains separate from fixed broker and host-user mode',()=>{
  const c=base();Object.assign(c.powerMode,{allowShell:true,allowProcessControl:true,blockedShellPatterns:[]});
  const admin={ok:true,isAdmin:true,elevation:'high',source:'local-process-token'};
  const status=assessAccessStatus(c,null,{platform:'win32',adminToken:admin});
  assert.equal(status.effectiveTier,'FULL_ACCESS');
  assert.equal(status.hostExecution.mode,'RESTRICTED');
  assert.equal(status.broker.operationalFullAccess,false);
  assert.equal(status.broker.unrestrictedAdminShell,false);
  assert.equal(status.nativeAdmin.unrestrictedAdminShell,true);
  assert.equal(status.broker.verified,false);
  assert.equal(assessAccessStatus(c,system,{platform:'win32',adminToken:standardToken}).effectiveTier,'FULL_POWER');
});

test('Linux current-process root token qualifies only with unrestricted approved shell scope',()=>{
  const c=base();
  Object.assign(c.powerMode,{allowShell:true,allowProcessControl:true,blockedShellPatterns:[]});
  const owner=assessAccessStatus(c,null,{platform:'linux',effectiveUid:0});
  assert.equal(owner.configuredTier,'FULL_ACCESS');
  assert.equal(owner.effectiveTier,'FULL_ACCESS');
  assert.equal(owner.operationalFullAccess,true);
  assert.equal(owner.fullAccessActive,true);
  assert.equal(owner.nativeRoot.verified,true);
  assert.equal(owner.nativeRoot.scope,'current-process-effective-uid');
  assert.equal(owner.nativeRoot.unrestrictedRootShell,true);
  assert.equal(owner.nativeAdmin.verified,false);
  assert.equal(owner.broker.verified,false);
  const regular=assessAccessStatus(c,root,{platform:'linux',effectiveUid:1000});
  assert.equal(regular.nativeRoot.verified,false);
  assert.equal(regular.effectiveTier,'FULL_POWER');
  assert.equal(regular.fullAccessBlocker,'LINUX_ROOT_PROCESS_NOT_ELEVATED');
  for (const field of ['allowShell','allowProcessControl','fullFilesystem']) {
    const restricted=structuredClone(c);
    restricted.powerMode[field]=false;
    const result=assessAccessStatus(restricted,root,{platform:'linux',effectiveUid:0});
    assert.equal(result.fullAccessActive,false);
    assert.equal(result.fullAccessBlocker,'FULL_ACCESS_SHELL_SCOPE_REQUIRED');
  }
  const denyPatterns=structuredClone(c);denyPatterns.powerMode.blockedShellPatterns=['restricted'];
  assert.equal(assessAccessStatus(denyPatterns,root,{platform:'linux',effectiveUid:0}).effectiveTier,'STANDARD');
  const missingGrant=structuredClone(c);missingGrant.capabilityProfile.explicitlyAuthorized=false;
  assert.equal(assessAccessStatus(missingGrant,root,{platform:'linux',effectiveUid:0}).fullAccessActive,false);
  assert.equal(assessAccessStatus(base('FULL_POWER'),root,{platform:'linux',effectiveUid:0}).effectiveTier,'STANDARD');
  assert.equal(assessAccessStatus(c,null,{platform:'win32',effectiveUid:0}).fullAccessActive,false);
});


test('effective tier never advertises FULL_POWER for restricted host execution across modes and tokens',()=>{
  for(const platform of ['linux','win32']){
    for(const tier of ['STANDARD','FULL_POWER','FULL_ACCESS']){
      const restricted=base(tier);
      restricted.capabilityProfile.explicitlyAuthorized=false;
      Object.assign(restricted.powerMode,{allowShell:true,blockedShellPatterns:[],allowProcessControl:true});
      const verifiedNative=platform==='linux'?
        {platform,effectiveUid:0}:{platform,adminToken:{ok:true,isAdmin:true,elevation:'high',source:'local-process-token'}};
      const status=assessAccessStatus(restricted,platform==='linux'?root:system,verifiedNative);
      assert.equal(status.hostExecution.mode,'RESTRICTED');
      assert.equal(status.effectiveTier,'STANDARD',platform+' '+tier+' without owner grant');
      assert.equal(status.fullAccessActive,false);
      assert.equal(status.broker.unrestrictedAdminShell,false);
    }
    for(const tier of ['FULL_POWER','FULL_ACCESS']){
      const restricted=base(tier);
      restricted.powerMode.allowShell=false;
      restricted.powerMode.blockedShellPatterns=[];
      const status=assessAccessStatus(restricted,platform==='linux'?root:system,{
        platform,effectiveUid:1000,adminToken:platform==='win32'?standardToken:null
      });
      assert.equal(status.hostExecution.mode,'RESTRICTED');
      assert.equal(status.effectiveTier,'STANDARD',platform+' '+tier+' no active shell');
      assert.equal(status.fullAccessActive,false);
    }
    const legitimate=base('FULL_POWER');
    Object.assign(legitimate.powerMode,{allowShell:true,blockedShellPatterns:[],allowProcessControl:true});
    const allowed=assessAccessStatus(legitimate,platform==='linux'?root:system,{
      platform,effectiveUid:1000,adminToken:platform==='win32'?standardToken:null
    });
    assert.equal(allowed.hostExecution.mode,'FULL_HOST_USER');
    assert.equal(allowed.effectiveTier,'FULL_POWER');
  }
});


test('FULL_ACCESS fallback never claims Full Host User on a pattern-restricted shell', () => {
  for (const platform of ['linux','win32']) {
    const c=base('FULL_ACCESS');
    Object.assign(c.powerMode,{allowShell:true,allowProcessControl:true,blockedShellPatterns:['protected']});
    const opts=platform==='linux'
      ? {platform,effectiveUid:1000}
      : {platform,adminToken:standardToken};
    const status=assessAccessStatus(c,null,opts);
    assert.equal(status.configuredTier,'FULL_ACCESS');
    assert.equal(status.fullAccessActive,false);
    assert.equal(status.hostExecution.noCommanderShellPatternRestrictions,false);
    assert.equal(status.effectiveTier,'STANDARD',platform+' restricted downgrade');
    const power=structuredClone(c);power.capabilityProfile.tier='FULL_POWER';
    const powerStatus=assessAccessStatus(power,null,opts);
    assert.equal(powerStatus.effectiveTier,'FULL_POWER',platform+' intentional Full Power restrictions remain distinct');
  }
});

test('missing or malformed configured tiers fail closed to STANDARD regardless of legacy power flags', () => {
  const invalidTiers = [undefined, null, '', 'FULLPOWER', 'ADMIN', 'ROOT', 'full_access', 1, {}];
  for (const tier of invalidTiers) {
    const config = base('FULL_POWER');
    if (tier === undefined) delete config.capabilityProfile.tier;
    else config.capabilityProfile.tier = tier;
    Object.assign(config.powerMode, {
      enabled: true, fullFilesystem: true, allowShell: true,
      allowProcessControl: true, blockedShellPatterns: []
    });
    const status = assessAccessStatus(config, root, { platform: 'linux', effectiveUid: 0 });
    assert.equal(status.configuredTier, 'STANDARD');
    assert.equal(status.effectiveTier, 'STANDARD');
    assert.equal(status.hostExecution.mode, 'RESTRICTED');
    assert.equal(status.fullAccessActive, false);
    assert.equal(status.operationalFullAccess, false);
  }
});
