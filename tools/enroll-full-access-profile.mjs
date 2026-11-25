#!/usr/bin/env node
// One profile at a time. Never installs a privileged service, bypasses UAC/sudo,
// or changes operating-system permissions. Requires the existing native broker.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, lstat, open, rename, unlink } from 'node:fs/promises';
import { requestPrivilegeBroker } from '../src/privilege-client.mjs';
import { verifyPrivilegedBrokerProof } from '../src/full-access-status.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function assertNoDuplicateJsonKeys(raw) {
  const stack = [];
  for(let i=0;i<raw.length;) {
    const c=raw[i];
    if(c==='"') {
      let j=i+1, escaped=false;
      for(;j<raw.length;j++) {
        if(escaped){escaped=false;continue;}
        if(raw[j]==='\\'){escaped=true;continue;}
        if(raw[j]==='"')break;
      }
      if(j===raw.length)throw Error('INVALID_JSON_STRING');
      const top=stack.at(-1);
      if(top?.type==='object' && top.expectKey) {
        const key=JSON.parse(raw.slice(i,j+1));
        if(top.keys.has(key))throw Error('DUPLICATE_JSON_KEY');
        top.keys.add(key);top.expectKey=false;
      }
      i=j+1;continue;
    }
    if(c==='{')stack.push({type:'object',keys:new Set(),expectKey:true});
    else if(c==='[')stack.push({type:'array'});
    else if(c==='}'||c===']')stack.pop();
    else if(c===',' && stack.at(-1)?.type==='object')stack.at(-1).expectKey=true;
    i++;
  }
}

export function prepareFullAccessProfile(config, proof, platform) {
  if(!config || typeof config!=='object' || Array.isArray(config))throw Error('CONFIG_INVALID');
  const profile=config.capabilityProfile;
  if(!profile || profile.explicitlyAuthorized!==true || profile.tier!=='FULL_POWER' &&
      profile.tier!=='FULL_ACCESS' || config.powerMode?.enabled!==true) {
    throw Error('PROFILE_REQUIRES_EXPLICIT_FULL_POWER_OWNER_GRANT');
  }
  if(!verifyPrivilegedBrokerProof(proof,platform))throw Error('NATIVE_PRIVILEGED_BROKER_NOT_VERIFIED');
  if(profile.tier==='FULL_ACCESS')return {changed:false,config};
  return {changed:true,config:{
    ...config,
    capabilityProfile:{
      ...profile,tier:'FULL_ACCESS',source:'native-broker-verified-enrollment',
      persistAcrossUpdates:true
    }
  }};
}

export async function inspectRuntime(runtimeRoot) {
  const files={
    server:path.join(runtimeRoot,'src','server-v0.3.mjs'),
    status:path.join(runtimeRoot,'src','full-access-status.mjs'),
    profile:path.join(runtimeRoot,'src','capability-profile.mjs'),
    quarantine:path.join(runtimeRoot,'src','full-access-http-quarantine.mjs'),
    privilegeClient:path.join(runtimeRoot,'src','privilege-client.mjs'),
    windowsToken:path.join(runtimeRoot,'src','windows-admin-token.mjs'),
    effective:path.join(runtimeRoot,'src','effective-power-mode.mjs'),
    powerTools:path.join(runtimeRoot,'src','power-tools-v0.3.mjs'),
    legacyTools:path.join(runtimeRoot,'src','tools-v0.3.mjs'),
    executionGuard:path.join(runtimeRoot,'src','execution-access-guard.mjs'),
    worker:path.join(runtimeRoot,'tools','operation-worker.mjs')
  };
  try {
    for(const [name,file] of Object.entries(files)) {
      const st=await lstat(file);
      if(!st.isFile()||st.isSymbolicLink())return {ready:false,code:'RUNTIME_FILE_INVALID',file:name};
    }
    const [s,p,q,st,e,pw,tf,v102,worker]=await Promise.all([
      readFile(files.server,'utf8'),readFile(files.profile,'utf8'),
      readFile(files.quarantine,'utf8'),readFile(files.status,'utf8'),
      readFile(files.effective,'utf8'),readFile(files.powerTools,'utf8'),
      readFile(files.legacyTools,'utf8'),readFile(files.executionGuard,'utf8'),
      readFile(files.worker,'utf8')
    ]);
    const guardAt=s.indexOf('if (rejectLegacyPrivilegedMcp(req, res, privilegedLegacyHttp)) return;');
    const dispatchAt=s.indexOf('const message = await readJsonBody(req);');
    const effectivePowerChecks={
      hasAuthorizedFullPower:e.includes('export function hasAuthorizedFullPower'),
      fullAccessTierGate:e.includes("profile.tier !== 'FULL_ACCESS' || accessStatus?.configuredTier !== 'FULL_ACCESS'"),
      nativeAdminNonElevatedGate:e.includes("accessStatus?.nativeAdmin?.nonElevatedTokenVerified === true"),
      nativeRootNonRootGate:e.includes("accessStatus?.nativeRoot?.nonRootTokenVerified === true"),
      fullAccessOperationalGate:e.includes('fullAccessIsOperational'),
      hasEffectiveFilesystem:e.includes('export function hasEffectiveFullFilesystem'),
      effectivePowerMode:e.includes('export function effectivePowerMode'),
      serverEffectiveFilter:s.includes('const effectivePower = effectivePowerMode(config, { accessStatus: initialAccessStatus })'),
      guiFilter:s.includes('effectivePower.guiControl'),
      browserFilter:s.includes('effectivePower.browserControl'),
      serverFilesystemFilter:s.includes('hasEffectiveFullFilesystem(config, { accessStatus: initialAccessStatus })'),
      serverGuiExecutionGate:s.includes("scopedCtx.config.powerMode?.guiControl?.enabled !== true"),
      serverBrowserExecutionGate:s.includes("scopedCtx.config.powerMode?.browserControl?.enabled !== true"),
      transferMeshGate:s.includes('config.transferMesh?.enabled === true && effectivePower.enabled === true'),
      powerToolsFilter:pw.includes('effectivePowerMode(ctx.config, { accessStatus: ctx.accessStatus })'),
      legacyToolsFilter:tf.includes('hasEffectiveFullFilesystem(ctx.config, { accessStatus: ctx.accessStatus })'),
      executionHostTierGate:v102.includes('V102_HOST_EFFECTIVE_TIER_REQUIRED') &&
        v102.includes('expected.effectiveTier') && v102.includes('V102_EFFECTIVE_TIER_EXCEEDS_HOST_TIER') &&
        v102.includes('readAccessStatus({force:true})') && v102.includes('V102_HOST_EFFECTIVE_TIER_CHANGED_BEFORE_EFFECT'),
      workerAccessStatus:worker.includes('createAccessStatusReader') && worker.includes('readAccessStatus') &&
        worker.includes('loadV102WorkerExecutionAccess({ config, spec, projectDir, accessStatus, readAccessStatus })')
    };
    const checks={
      statusWired:s.includes('const readAccessStatus = createAccessStatusReader({') &&
        s.includes('const initialAccessStatus = await readAccessStatus();') &&
        s.includes('ctx.accessStatus = accessStatus;') &&
        s.includes('accessStatus: initialAccessStatus'),
      statusRefresh:s.includes('const accessStatus = await readAccessStatus();'),
      windowsTokenRefresh:s.includes('const readWindowsAdminToken = async () => process.platform === \'win32\'') &&
        s.includes('probeWindowsAdmin: readWindowsAdminToken'),
      quarantineWired:s.includes('legacyPrivilegedMcpQuarantine') &&
        s.includes('const privilegedLegacyHttp = legacyPrivilegedMcpQuarantine({') &&
        guardAt>=0 && dispatchAt>guardAt &&
        s.includes('privilegedLegacyHttpQuarantined: privilegedLegacyHttp.quarantine'),
      quarantineStrict:q.includes("configuredTier === 'FULL_POWER' || configuredTier === 'FULL_ACCESS'") &&
        q.includes('requireTrustedIngress !== false') &&
        q.includes('export function rejectLegacyPrivilegedMcp'),
      protectedIngressWired:s.includes('createV2CandidateHttpIngress') &&
        s.includes('createV101ProtectedRouterBridge') &&
        s.includes('dispatcherFactory') && s.includes('v2Ingress.handleRequest') &&
        s.includes("'/v2/mcp'"),
      statusReady:(st.includes('export function verifyPrivilegedBrokerProof') || st.includes("export { verifyPrivilegedBrokerProof } from './capability-profile.mjs';")) &&
        st.includes('export function createAccessStatusReader'),
      effectivePowerReady:Object.values(effectivePowerChecks).every(Boolean),
      ownerGrantGate:p.includes('FULL_ACCESS_NATIVE_BROKER_PROOF_REQUIRED')
    };
    return {ready:Object.values(checks).every(Boolean),checks:{...checks,effectivePowerChecks}};
  }catch {
    return {ready:false,code:'RUNTIME_INSPECTION_FAILED'};
  }
}

async function writePrivate(file,buffer) {
  const fd=await open(file,'wx',0o600);
  try{await fd.writeFile(buffer);await fd.sync();}
  finally{await fd.close();}
}

function parseArgs(argv) {
  const opts={};
  for(let i=0;i<argv.length;i++) {
    const k=argv[i];
    if(k==='--check'||k==='--apply') {
      if(opts.mode)throw Error('ONE_MODE_REQUIRED');
      opts.mode=k;
    } else if(['--config','--runtime-root','--expected-sha'].includes(k)) {
      if(opts[k] || !argv[i+1])throw Error('ARGUMENT_INVALID');
      opts[k]=argv[++i];
    } else throw Error('ARGUMENT_UNKNOWN');
  }
  if(!opts.mode || !opts['--config'] || !opts['--runtime-root'])throw Error('CONFIG_RUNTIME_AND_MODE_REQUIRED');
  if(opts.mode==='--apply' && !/^[a-f0-9]{64}$/.test(opts['--expected-sha']||''))throw Error('EXACT_CONFIG_SHA_REQUIRED');
  if(!path.isAbsolute(opts['--config'])||!path.isAbsolute(opts['--runtime-root']))throw Error('ABSOLUTE_PATH_REQUIRED');
  return opts;
}

export async function runCli(argv, { probe=requestPrivilegeBroker, platform=process.platform }={}) {
  const opts=parseArgs(argv);
  const filename=path.resolve(opts['--config']);
  const runtimeRoot=path.resolve(opts['--runtime-root']);
  const st=await lstat(filename);
  if(!st.isFile() || st.isSymbolicLink())throw Error('REGULAR_CONFIG_REQUIRED');
  const original=await readFile(filename);
  if(original.byteLength>4*1024*1024)throw Error('CONFIG_TOO_LARGE');
  const originalSha=digest(original);
  if(opts['--expected-sha'] && originalSha!==opts['--expected-sha'])throw Error('CONFIG_SHA_CHANGED');
  const raw=original.toString('utf8');
  assertNoDuplicateJsonKeys(raw);
  const config=JSON.parse(raw);
  const runtimeInspection=await inspectRuntime(runtimeRoot);
  const runtimeReady=runtimeInspection.ready;
  const proof=await probe('os.probe',{platform});
  const proposed=prepareFullAccessProfile(config,proof,platform);
  const response={profile:config.instance?.profile||config.capabilityProfile?.id||'default',
    beforeTier:config.capabilityProfile.tier,afterTier:proposed.config.capabilityProfile.tier,
    brokerVerified:true,runtimeReady,
    runtimeChecks:runtimeInspection.checks ?? null,
    runtimeInspectionCode:runtimeInspection.code ?? null,
    runtimeInspectionFile:runtimeInspection.file ?? null,
    configSha256:originalSha,changed:proposed.changed,
    configuredTierOnly:true,operationalFullAccess:false,fullAccessActive:false,
    privilegedActionGrantRequired:true};
  if(opts.mode==='--check')return {...response,mode:'CHECK',canApply:runtimeReady};
  if(!runtimeReady)throw Error('FULL_ACCESS_RUNTIME_NOT_DEPLOYED');
  if(!proposed.changed)return {...response,mode:'NO_OP'};
  const updated=Buffer.from(JSON.stringify(proposed.config,null,2)+'\n','utf8');
  const dir=path.dirname(filename);
  const backup=path.join(dir,'.'+path.basename(filename)+'.before-full-access-'+originalSha.slice(0,12));
  const temp=path.join(dir,'.'+path.basename(filename)+'.full-access-stage-'+randomUUID());
  try { await writePrivate(backup,original); }
  catch (error) {
    if (error?.code !== 'EEXIST' || digest(await readFile(backup)) !== originalSha) {
      throw Error('ENROLLMENT_BACKUP_CONFLICT');
    }
  }
  try {
    await writePrivate(temp,updated);
    if(digest(await readFile(filename))!==originalSha)throw Error('CONFIG_CHANGED_DURING_ENROLLMENT');
    await rename(temp,filename);
  } finally {await unlink(temp).catch(()=>{});}
  const confirm=await readFile(filename);
  if(digest(confirm)!==digest(updated))throw Error('CONFIG_WRITE_NOT_VERIFIED');
  return {...response,mode:'APPLIED',updatedSha256:digest(updated),
    effectiveTierRequiresRuntimeRestart:true,privilegedActionGrantRequired:true,
    backupCreated:true};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result)))
    .catch(error=>{console.error(String(error?.message||error));process.exitCode=1;});
}
