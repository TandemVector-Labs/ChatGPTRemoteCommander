import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {runCli} from '../tools/enroll-full-access-profile.mjs';
import {requestPrivilegeBroker, privilegeBrokerStatus} from '../src/privilege-client.mjs';
import {assessAccessStatus} from '../src/full-access-status.mjs';
import {privilegedOperationStatus, startPrivilegedCommanderUnit} from '../src/privileged-operations.mjs';

// Structural runtime fixture only; the native broker checks below remain real and no server is launched.
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function writeRuntimeFixture(runtimeRoot,{quarantineModule=true,wireGuard=true,effectiveModule=true,wireEffective=true,wireServerEffective=true,wireServerAccessStatus=true,wireWindowsTokenRefresh=true,wireProtectedIngress=true}={}) {
  const src=path.join(runtimeRoot,'src');
  await mkdir(src,{recursive:true});
  const guard=wireGuard
    ? "if (rejectLegacyPrivilegedMcp(req, res, privilegedLegacyHttp)) return;"
    : "return dispatch(req, res);";
  await writeFile(path.join(src,'server-v0.3.mjs'),[
    "import { assessAccessStatus, createAccessStatusReader } from './full-access-status.mjs';",
    "import { legacyPrivilegedMcpQuarantine, rejectLegacyPrivilegedMcp } from './full-access-http-quarantine.mjs';",
    ...(wireProtectedIngress ? [
      "import { createV2CandidateHttpIngress } from './v2-mcp-http-ingress.mjs';",
      "import { createV101ProtectedRouterBridge } from './full-access-protected-router-bridge.mjs';",
      "const v2Ingress = await createV2CandidateHttpIngress({ attestTransport, dispatcherFactory });",
      "if (url.pathname === '/v2/mcp') return v2Ingress.handleRequest(req,res);"
    ] : []),
    ...(wireEffective ? [
      wireServerEffective
        ? "import { effectivePowerMode, hasEffectiveFullFilesystem } from './effective-power-mode.mjs';"
        : "import { hasEffectiveFullFilesystem } from './effective-power-mode.mjs';"
    ] : []),
    ...(wireServerAccessStatus ? [
      ...(wireWindowsTokenRefresh ? [
        "const readWindowsAdminToken = async () => process.platform === 'win32' ? await probeWindowsAdministrator({ platform: process.platform }) : null;",
        "const readAccessStatus = createAccessStatusReader({ config, probeWindowsAdmin: readWindowsAdminToken });"
      ] : ["const readAccessStatus = createAccessStatusReader({ config });"]),
      "const initialAccessStatus = await readAccessStatus();"
    ] : []),
    ...(wireEffective ? [
      ...(wireServerEffective ? [
        "const effectivePower = effectivePowerMode(config, { accessStatus: initialAccessStatus });",
        "const ctx = { config, accessStatus: initialAccessStatus };",
        "config.powerMode = effectivePower;",
        "const GUI_ENABLED = effectivePower.guiControl?.enabled === true;",
        "const BROWSER_ENABLED = effectivePower.browserControl?.enabled === true;",
        "const currentExecutionContext = () => ({config:{...config,powerMode:effectivePowerMode(config,{accessStatus:ctx.accessStatus})}});",
        "const scopedCtx = currentExecutionContext();",
        "if (scopedCtx.config.powerMode?.guiControl?.enabled !== true) throw Error('GUI_CONTROL_NOT_EFFECTIVE');",
        "if (scopedCtx.config.powerMode?.browserControl?.enabled !== true) throw Error('BROWSER_CONTROL_NOT_EFFECTIVE');",
        "const transferMesh = config.transferMesh?.enabled === true && effectivePower.enabled === true;"
      ] : []),
      "const LEGACY_FULL_FILESYSTEM = hasEffectiveFullFilesystem(config, { accessStatus: initialAccessStatus });"
    ] : []),
    "const privilegedLegacyHttp = legacyPrivilegedMcpQuarantine({ configuredTier: 'FULL_POWER' });",
    "async function status() {",
    "  const accessStatus = await readAccessStatus();",
    "  ctx.accessStatus = accessStatus;",
    "  return {",
    "        accessStatus,",
    "        privilegedLegacyHttpQuarantined: privilegedLegacyHttp.quarantine,",
    "  };",
    "}",
    "function handle(req, res) {",
    "  "+guard,
    "  const message = await readJsonBody(req);",
    "}"
  ].join("\n"));
  await writeFile(path.join(src,'full-access-status.mjs'),
    "export function verifyPrivilegedBrokerProof() {}\nexport function assessAccessStatus(config) { return {configuredTier:config?.capabilityProfile?.tier ?? 'STANDARD',effectiveTier:'STANDARD',hostExecution:{mode:'RESTRICTED'}}; }\nexport function createAccessStatusReader() { return async()=>({effectiveTier:'STANDARD'}); }\n");
  await writeFile(path.join(src,'capability-profile.mjs'),
    "export const FULL_ACCESS_NATIVE_BROKER_PROOF_REQUIRED = 'FULL_ACCESS_NATIVE_BROKER_PROOF_REQUIRED';\n");
  await writeFile(path.join(src,'privilege-client.mjs'),
    "export async function requestPrivilegeBroker() {}\n");
  await writeFile(path.join(src,'windows-admin-token.mjs'),
    "export async function probeWindowsAdministrator() {}\n");
  if(effectiveModule) await writeFile(path.join(src,'effective-power-mode.mjs'),[
    "function fullAccessIsOperational(accessStatus) { return accessStatus?.effectiveTier==='FULL_ACCESS' && accessStatus?.operationalFullAccess===true && (accessStatus?.nativeAdmin?.verified===true || accessStatus?.nativeRoot?.verified===true); }",
    "export function hasAuthorizedFullPower(config, {accessStatus=null}={}) { const profile=config?.capabilityProfile; const h=accessStatus?.hostExecution; const owner=h?.mode==='FULL_HOST_USER' && h.hostFilesystem===true && h.shellAvailable===true && (accessStatus?.nativeAdmin?.nonElevatedTokenVerified === true || accessStatus?.nativeRoot?.nonRootTokenVerified === true); const full=fullAccessIsOperational(accessStatus); if(config?.powerMode?.enabled!==true || profile?.explicitlyAuthorized!==true)return false; if(profile.tier==='FULL_POWER')return accessStatus?.configuredTier==='FULL_POWER' && accessStatus?.effectiveTier==='FULL_POWER' && owner; if(profile.tier !== 'FULL_ACCESS' || accessStatus?.configuredTier !== 'FULL_ACCESS') return false; return (accessStatus?.effectiveTier==='FULL_POWER' && owner) || full; }",
    "export function hasEffectiveFullFilesystem(config, options={}) { return config?.powerMode?.fullFilesystem === true && hasAuthorizedFullPower(config, options) && !(config?.capabilityProfile?.disabledCapabilities ?? []).includes('filesystem.full'); }",
    "export function effectivePowerMode(config, options={}) { return { ...config.powerMode, fullFilesystem:hasEffectiveFullFilesystem(config, options), allowShell:hasAuthorizedFullPower(config, options) && config.powerMode?.allowShell === true && !(config?.capabilityProfile?.disabledCapabilities ?? []).includes('shell.execute') }; }"
  ].join("\\n"));
  await writeFile(path.join(src,'power-tools-v0.3.mjs'),
    wireEffective ? "import { effectivePowerMode } from './effective-power-mode.mjs';\\nconst scope = effectivePowerMode(ctx.config, { accessStatus: ctx.accessStatus });\\n" : "export const rawPowerFlags = true;\\n");
  await writeFile(path.join(src,'tools-v0.3.mjs'),
    wireEffective ? "import { hasEffectiveFullFilesystem } from './effective-power-mode.mjs';\\nreturn hasEffectiveFullFilesystem(ctx.config, { accessStatus: ctx.accessStatus });\\n" : "export const rawFilesystemFlags = true;\\n");
  await writeFile(path.join(src,'execution-access-guard.mjs'),
    "if (TIER_RANK[accessStatus.effectiveTier] < TIER_RANK[policy.minimumTier]) fail('V102_HOST_EFFECTIVE_TIER_REQUIRED');\\nconst fresh = await readAccessStatus({force:true});\\nif (fresh.effectiveTier !== expected.effectiveTier) fail('V102_HOST_EFFECTIVE_TIER_CHANGED_BEFORE_EFFECT');\\nif (TIER_RANK[decision.effectiveTier] > TIER_RANK[expected.effectiveTier]) fail('V102_EFFECTIVE_TIER_EXCEEDS_HOST_TIER');\\n");
  const toolsRoot=path.join(runtimeRoot,'tools');
  await mkdir(toolsRoot,{recursive:true});
  await writeFile(path.join(toolsRoot,'operation-worker.mjs'),
    "import { createAccessStatusReader } from '../src/full-access-status.mjs';\\nconst readAccessStatus = createAccessStatusReader({config});\\nconst accessStatus = await readAccessStatus();\\nconst loaded = await loadV102WorkerExecutionAccess({ config, spec, projectDir, accessStatus, readAccessStatus });\\n");
  if(quarantineModule) await writeFile(path.join(src,'full-access-http-quarantine.mjs'),[
    "export function legacyPrivilegedMcpQuarantine() {}",
    "export function rejectLegacyPrivilegedMcp() {}",
    "const privilegedConfig = configuredTier === 'FULL_POWER' || configuredTier === 'FULL_ACCESS';",
    "const quarantine = requireTrustedIngress !== false || privilegedConfig;"
  ].join("\n"));
}

test('native broker enrollment preflight: disposable profile and guarded runtime fixture', {
  skip:process.env.RC_NATIVE_FULL_ACCESS_QA!=='1'
},async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'rc-native-fullaccess-'));
  const runtimeRoot=path.join(dir,'runtime-ready');
  await writeRuntimeFixture(runtimeRoot);
  try {
    const file=path.join(dir,'config.json');
    const old={instance:{profile:'qa-disposable'},
      capabilityProfile:{id:'qa-disposable',tier:'FULL_POWER',explicitlyAuthorized:true,
        persistAcrossUpdates:true,disabledCapabilities:[],source:'explicit-user-authorization'},
      powerMode:{enabled:true,fullFilesystem:true,allowShell:true,allowProcessControl:true,blockedShellPatterns:[]}};
    await writeFile(file,JSON.stringify(old,null,2)+'\n');
    const args=['--config',file,'--runtime-root',runtimeRoot];
    const pre=await runCli(['--check',...args]);
    assert.equal(pre.brokerVerified,true);
    assert.equal(pre.runtimeReady,true,JSON.stringify(pre.runtimeChecks ?? {code:pre.runtimeInspectionCode,file:pre.runtimeInspectionFile}));
    const sha=createHash('sha256').update(await readFile(file)).digest('hex');
    const result=await runCli(['--apply',...args,'--expected-sha',sha]);
    assert.equal(result.mode,'APPLIED');
    const now=JSON.parse(await readFile(file,'utf8'));
    assert.equal(now.capabilityProfile.tier,'FULL_ACCESS');
    // Real native privilege identity does not imply operational FULL_ACCESS.
    const response=await requestPrivilegeBroker('os.probe');
    const native=assessAccessStatus(now,response,{
      platform:process.platform,effectiveUid:1000,
      adminToken:process.platform==='win32'
        ? {ok:true,isAdmin:false,isSystem:false,elevation:'standard',source:'local-process-token'}
        : null
    });
    assert.equal(native.broker.verified,true);
    assert.equal(native.configuredTier,'FULL_ACCESS');
    assert.equal(native.effectiveTier,'FULL_POWER');
    assert.equal(native.fullAccessActive,false);
    assert.equal(native.fullAccessBlocker,process.platform === 'win32'
      ? 'WINDOWS_ADMIN_TOKEN_NOT_ELEVATED' : 'LINUX_ROOT_PROCESS_NOT_ELEVATED');
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('FULL_ACCESS enrollment remains blocked until the real V2 trusted ingress is wired', {
  skip:process.env.RC_NATIVE_FULL_ACCESS_QA!=='1'
},async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'rc-native-fullaccess-no-v2-'));
  const runtimeRoot=path.join(dir,'runtime-no-v2');
  await writeRuntimeFixture(runtimeRoot,{wireProtectedIngress:false});
  try {
    const file=path.join(dir,'config.json');
    const old={instance:{profile:'qa-disposable'},
      capabilityProfile:{id:'qa-disposable',tier:'FULL_POWER',explicitlyAuthorized:true,
        persistAcrossUpdates:true,disabledCapabilities:[],source:'explicit-user-authorization'},
      powerMode:{enabled:true,fullFilesystem:true,allowShell:true,allowProcessControl:true,blockedShellPatterns:[]}};
    await writeFile(file,JSON.stringify(old,null,2)+'\n');
    const args=['--config',file,'--runtime-root',runtimeRoot];
    const pre=await runCli(['--check',...args]);
    assert.equal(pre.brokerVerified,true);
    assert.equal(pre.runtimeReady,false);
    assert.equal(pre.canApply,false);
    assert.equal(pre.runtimeChecks.protectedIngressWired,false);
    const sha=createHash('sha256').update(await readFile(file)).digest('hex');
    await assert.rejects(
      runCli(['--apply',...args,'--expected-sha',sha]),
      /FULL_ACCESS_RUNTIME_NOT_DEPLOYED/
    );
    const unchanged=JSON.parse(await readFile(file,'utf8'));
    assert.equal(unchanged.capabilityProfile.tier,'FULL_POWER');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('native enrollment fails closed when quarantine module or server hook is missing', {
  skip:process.env.RC_NATIVE_FULL_ACCESS_QA!=='1'
},async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'rc-native-runtime-gate-'));
  try {
    const file=path.join(dir,'config.json');
    const old={instance:{profile:'qa-disposable'},
      capabilityProfile:{id:'qa-disposable',tier:'FULL_POWER',explicitlyAuthorized:true,
        persistAcrossUpdates:true,disabledCapabilities:[],source:'explicit-user-authorization'},
      powerMode:{enabled:true,fullFilesystem:true,allowShell:true,allowProcessControl:true,blockedShellPatterns:[]}};
    await writeFile(file,JSON.stringify(old,null,2)+'\n');
    for(const [name,options] of [
      ['missing-quarantine-module',{quarantineModule:false,wireGuard:true}],
      ['missing-server-hook',{quarantineModule:true,wireGuard:false}],
      ['missing-effective-power-module',{effectiveModule:false,wireEffective:true}],
      ['missing-effective-power-wiring',{effectiveModule:true,wireEffective:false}],
      ['missing-server-effective-filter',{effectiveModule:true,wireEffective:true,wireServerEffective:false}],
      ['missing-current-worker-access-status',{effectiveModule:true,wireEffective:true,wireServerEffective:true,wireServerAccessStatus:false}],
      ['missing-fresh-windows-token-probe',{effectiveModule:true,wireEffective:true,wireServerEffective:true,wireServerAccessStatus:true,wireWindowsTokenRefresh:false}]
    ]) {
      const runtimeRoot=path.join(dir,name);
      await writeRuntimeFixture(runtimeRoot,options);
      const original=await readFile(file);
      const args=['--config',file,'--runtime-root',runtimeRoot];
      const check=await runCli(['--check',...args]);
      assert.equal(check.brokerVerified,true);
      assert.equal(check.runtimeReady,false);
      assert.equal(check.canApply,false);
      await assert.rejects(
        runCli(['--apply',...args,'--expected-sha',sha256(original)]),
        /FULL_ACCESS_RUNTIME_NOT_DEPLOYED/
      );
      assert.equal(sha256(await readFile(file)),sha256(original));
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});

// Read-only native broker check. The same local OS user can own several
// Commander profiles; this does NOT establish native per-profile identity.
test('native broker status stays scoped and FULL_POWER cannot authorize a privileged mutation', {
  skip:process.env.RC_NATIVE_FULL_ACCESS_QA!=='1'
},async()=>{
  const profileId='qa-disposable';
  const ctx={config:{
    powerMode:{enabled:true}, instance:{profile:profileId},
    capabilityProfile:{id:profileId,tier:'FULL_POWER',explicitlyAuthorized:true},
    privilegedOperations:{allowStartCommanderSystemUnit:true,
      ownerGrant:{profileId,action:'system_unit.start',approved:true,revoked:false}}
  }};
  const receipts=[];
  const status=await privilegedOperationStatus(ctx,{record:async e=>receipts.push(e)});
  assert.equal(status.brokerVerified,true);
  assert.equal(status.targetStatus.ok,true,
    `native fixed-action status failed: ${status.targetStatus.code ?? 'UNKNOWN'}`);
  assert.equal(status.operationalFullAccess,false);
  assert.equal(status.nativeProfileBindingVerified,false);
  assert.deepEqual(status.allowedMutations,[]);
  const nativeBroker=await privilegeBrokerStatus();
  assert.equal(nativeBroker.installed,true);
  assert.equal(nativeBroker.nativeProfileBindingVerified,false);
  assert.deepEqual(nativeBroker.allowedMutations,[],
    'declared native actions do not imply a per-profile mutation grant');
  assert.deepEqual(nativeBroker.allowedActions,process.platform==='linux'
    ? ['os.probe','system_unit.status']
    : ['os.probe','broker.task.status']);
  assert.deepEqual(nativeBroker.nativeGrantRequiredActions,process.platform==='linux'
    ? ['system_unit.start'] : []);
  assert.equal(receipts.length,1);
  if(process.platform==='linux') {
    await assert.rejects(startPrivilegedCommanderUnit(ctx),
      /PRIVILEGED_ACTION_OWNER_POLICY_REQUIRED/);
  } else if(process.platform==='win32') {
    assert.equal(status.targetStatus.task,'ChatGPTRemoteCommander-PrivilegeBroker');
  }
});
