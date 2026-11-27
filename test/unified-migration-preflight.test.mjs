import {createHash} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assessMigration,isLinuxOwnerCommanderLegacyTunnelUnit,candidateNativeDebianVersion,inspectLocalPlatform,readLinuxOwnerTunnelBinding,verifyLinuxPrivateProfileBackup,inspectLinuxNativeCorePayload,parseMainTunnelBinding,classifyObservedRouterStatus,classifyWindowsUninstallRegistryResponse,classifyWindowsUnifiedNsisRegistryResponse,readWindowsOwnerTunnelBinding,windowsOwnerDpapiVerifyOutputAccepted} from '../packaging/unified/migration-preflight.mjs';
import {planOwnerPrivateTunnelCutover} from '../tools/plan-owner-private-tunnel-cutover.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const modulePath=path.join(repo,'packaging/unified/migration-preflight.mjs');

test('Windows exact owner selector has no default or cross-profile credential fallback',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'rc012-windows-scoped-profile-'));
 const folder=path.join(home,'tunnel-client');
 const make=(name,port)=>fs.writeFileSync(path.join(folder,name+'.yaml'),[
  'config_version: 1','control_plane:','  api_key: TEST_ONLY_DO_NOT_USE',
  'mcp:','  server_urls:','    - channel: main',
  '      url: "http://127.0.0.1:'+port+'/mcp"'
 ].join('\n'),{mode:0o600});
 try{
  fs.mkdirSync(folder,{mode:0o700});
  make('aliemad-Server',48833);
  make('MMZ',48834);
  assert.deepEqual(readWindowsOwnerTunnelBinding({appData:home,profileName:'aliemad-Server'}),
    {profilePresent:true,valid:true,port:48833,tls:false});
  assert.deepEqual(readWindowsOwnerTunnelBinding({appData:home,profileName:'MMZ'}),
    {profilePresent:true,valid:true,port:48834,tls:false});
  assert.deepEqual(readWindowsOwnerTunnelBinding({appData:home}),
    {profilePresent:false,valid:false});
  for(const invalid of ['../aliemad-Server','.','..','',null,'a/b']){
    assert.deepEqual(readWindowsOwnerTunnelBinding({appData:home,profileName:invalid}),
      {profilePresent:false,valid:false});
  }
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});

for(const kind of ['Windows','Linux']){
 test(kind+' profile preflight rejects changed descriptor and bounds read before parsing', {
  skip:kind==='Linux'&&process.platform!=='linux'
 },()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'rc012-profile-read-contract-'));
  const directory=kind==='Windows'?path.join(home,'tunnel-client'):path.join(home,'.config','tunnel-client');
  const file=path.join(directory,'fixture.yaml');
  const yaml=port=>['mcp:','  server_urls:','    - channel: main',
    '      url: "http://127.0.0.1:'+port+'/mcp"'].join('\n');
  const read=()=>kind==='Windows'
    ?readWindowsOwnerTunnelBinding({appData:home,profileName:'fixture'})
    :readLinuxOwnerTunnelBinding({home,ownerUid:process.getuid(),profileName:'fixture'});
  const write=()=>fs.writeFileSync(file,yaml(48833),{mode:0o600});
  const originalOpen=fs.openSync,originalReadFile=fs.readFileSync,originalRead=fs.readSync;
  const invalid={profilePresent:true,valid:false};
  try{
   fs.mkdirSync(directory,{recursive:true,mode:0o700});
   write();
   assert.deepEqual(read(),{profilePresent:true,valid:true,port:48833,tls:false});
   let swapped=false,bytes=0,pathReads=0;
   fs.openSync=function(target,...args){
    if(target===file&&!swapped){
     swapped=true;
     fs.renameSync(file,file+'.original');
     fs.writeFileSync(file,yaml(48834),{mode:0o600});
    }
    return originalOpen.call(this,target,...args);
   };
   fs.readFileSync=function(target,...args){
    if(target===file)pathReads++;
    return originalReadFile.call(this,target,...args);
   };
   fs.readSync=function(fd,buffer,offset,length,position){
    const n=originalRead.call(this,fd,buffer,offset,length,position);
    bytes+=n;return n;
   };
   const replaced=read();
   assert.equal(swapped,true);
   assert.deepEqual(replaced,invalid);
   assert.equal(pathReads,0,'unbound path read must not occur');
   assert.equal(bytes,0,'changed inode must be refused before reading');
   fs.openSync=originalOpen;fs.readFileSync=originalReadFile;fs.readSync=originalRead;
   fs.unlinkSync(file);fs.renameSync(file+'.original',file);
   // Grow a validated file immediately after open, before reading.
   let grown=false;
   fs.openSync=function(target,...args){
    const fd=originalOpen.call(this,target,...args);
    if(target===file&&!grown){
     grown=true;fs.appendFileSync(file,'#'+'x'.repeat(20000));
    }
    return fd;
   };
   bytes=0;
   fs.readSync=function(fd,buffer,offset,length,position){
    const n=originalRead.call(this,fd,buffer,offset,length,position);bytes+=n;return n;
   };
   assert.deepEqual(read(),invalid);
   assert.equal(grown,true);assert.equal(bytes,0);
   fs.openSync=originalOpen;fs.readSync=originalRead;
   write();
   // Short reads of a stable descriptor must still decode the complete YAML.
   fs.readSync=function(fd,buffer,offset,length,position){
    return originalRead.call(this,fd,buffer,offset,Math.min(length,3),position);
   };
   assert.deepEqual(read(),{profilePresent:true,valid:true,port:48833,tls:false});
  }finally{
   fs.openSync=originalOpen;fs.readFileSync=originalReadFile;fs.readSync=originalRead;
   fs.rmSync(home,{recursive:true,force:true});
  }
 });
}

test('owner-local legacy Commander tunnels are discovered by executable identity, not host names',()=>{
 const home='/home/owner';
 const unit='profile-A-tunnel.service';
 const exe=path.posix.join(home,'.local','share','ChatGPTRemoteCommander',
   'tools','tunnel-client-v0.0.15-linux-amd64','tunnel-client');
 const fixture={unit,home,
   fragmentPath:path.posix.join(home,'.config','systemd','user',unit),
   execStart:'{ path='+exe+' ; argv[]='+exe+' run --profile profile-A ; ignore_errors=no ; }'};
 assert.equal(isLinuxOwnerCommanderLegacyTunnelUnit(fixture),true);
 for(const bad of [
   {unit:'other.service'},
   {unit:'profile-B-tunnel.service'},
   {fragmentPath:path.posix.join('/','etc','systemd','user',unit)},
   {fragmentPath:path.posix.join(home,'.config','systemd','user','wrong.service')},
   {execStart:fixture.execStart.replace('run --profile profile-A','run --profile other')},
   {execStart:fixture.execStart.replace('tunnel-client-v0.0.15-linux-amd64','misc')},
   {execStart:fixture.execStart.replace(exe+' run',exe+' --api-key=secret run')},
   {home:path.posix.join('/','home','other')},
   {home:'relative'}
 ])assert.equal(isLinuxOwnerCommanderLegacyTunnelUnit({...fixture,...bad}),false);
 const r=assessMigration({platform:'linux',connectionMode:'private-tunnel',
   inventoryReliable:true,nativePackageInstalled:true,
   allNativePayloadPathsAvailable:true,units:[
     {kind:'tunnel',active:true,enabled:true,knownExecutable:false,
       nativeTunnelCompatible:false}
   ]});
 assert.equal(r.activeTunnelUnits,1);
 assert.equal(r.enabledTunnelUnits,1);
 assert.ok(r.blocked.includes('TUNNEL_CUTOVER_UNVERIFIED'));
 assert.ok(r.blocked.includes('ACTIVE_SERVICE_EXECUTABLE_UNMAPPED'));
 assert.equal(r.decision,'NO_PROMOTE');
});

test('read-only Linux inventory preserves Native Tunnel and old live service blockers',()=>{
 const r=assessMigration({platform:'linux',inventoryReliable:true,
    nativePackageInstalled:true,allNativePayloadPathsAvailable:true,
    units:[{kind:'core',active:true,enabled:true,knownExecutable:false},
      {kind:'tunnel',active:true,enabled:true,knownExecutable:true,nativeTunnelCompatible:true}]
 });
 assert.equal(r.decision,'NO_PROMOTE');assert.equal(r.readOnly,true);
 assert.equal(r.activeCoreUnits,1);assert.equal(r.activeTunnelUnits,1);
 assert.equal(r.enabledCoreUnits,1);assert.equal(r.enabledTunnelUnits,1);
 assert.ok(r.blocked.includes('ACTIVE_SERVICE_EXECUTABLE_UNMAPPED'));
 assert.ok(r.blocked.includes('ENABLED_AUTOSTART_EXECUTABLE_UNMAPPED'));
 assert.ok(r.blocked.includes('ACTIVE_SERVICE_ROLLBACK_NOT_TESTED'));
 assert.ok(r.blocked.includes('G1_CURRENT_SESSION_UNVERIFIED'));
 assert.ok(r.blocked.includes('PROFILE_BACKUP_NOT_VERIFIED'));
 assert.ok(r.blocked.includes('UPDATE_ROLLBACK_PROVENANCE_UNVERIFIED'));
 assert.equal(JSON.stringify(r).includes('apikey'),false);
});
test('Linux preflight inventories the one exact owner-private Tunnel without disclosing its API key',{
 skip:process.platform!=='linux'
},()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'rc012-linux-owner-profile-'));
 const folder=path.join(home,'.config','tunnel-client');
 const profile=path.join(folder,'Emad.yaml');
 const key='TEST_ONLY_DO_NOT_LOG_SECRET_TOKEN';
 const yaml=[
  'config_version: 1','control_plane:','  api_key: '+key,
  'mcp:','  server_urls:','    - channel: main',
  '      url: "http://127.0.0.1:47831/mcp"'
 ].join('\n');
 try{
  fs.mkdirSync(folder,{recursive:true,mode:0o700});
  fs.chmodSync(folder,0o700);
  fs.writeFileSync(profile,yaml,{mode:0o600});
  const read=()=>readLinuxOwnerTunnelBinding({home,ownerUid:process.getuid()});
  const good=read();
  assert.deepEqual(good,{profilePresent:true,valid:true,port:47831,tls:false});
  assert.doesNotMatch(JSON.stringify(good),/DO_NOT_LOG|Emad|api_key/);
  const report=assessMigration({platform:'linux',connectionMode:'private-tunnel',
   inventoryReliable:true,nativePackageInstalled:true,
   allNativePayloadPathsAvailable:true,units:[],tunnelProfilePresent:true,
   tunnelProfileValid:good.valid,tunnelTargetPort:good.port,
   tunnelTargetTls:good.tls,tunnelTargetVersion:'0.11.0-dev.23'});
  assert.equal(report.ownerTunnelTargetPort,47831);
  assert.ok(report.blocked.includes('PRIVATE_TUNNEL_HTTPS_MTLS_ROUTE_REQUIRED'));
  fs.chmodSync(profile,0o644);
  assert.deepEqual(read(),{profilePresent:true,valid:false});
  fs.chmodSync(profile,0o600);
  fs.writeFileSync(path.join(folder,'Other.yaml'),yaml,{mode:0o600});
  assert.deepEqual(read(),{profilePresent:true,valid:false});
  const bad=assessMigration({platform:'linux',connectionMode:'private-tunnel',
    inventoryReliable:true,nativePackageInstalled:true,
    allNativePayloadPathsAvailable:true,units:[],tunnelProfilePresent:true,
    tunnelProfileValid:false});
  assert.ok(bad.blocked.includes('OWNER_TUNNEL_MAIN_BINDING_UNVERIFIED'));
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('single native Linux package must contain the actual v0.12 protected Core, native J01 and worker grant modules',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc012-installed-private-core-'));
 const files=[
  'runtime/node','tunnel/native-tunnel-launch.sh','tunnel/tunnel-client',
  'native-config-preflight.mjs','app/src/server-v0.3.mjs',
  'app/src/v012-private-core-runtime.mjs',
  'app/src/v2-private-pair-mcp-http-ingress.mjs',
  'app/src/v2-private-tunnel-https-gateway.mjs',
  'app/src/v2-private-pair-operation-gate.mjs',
  'app/src/v2-private-signed-worker-grant-adapter.mjs',
  'app/src/v101-private-pair-native-owner-stack.mjs',
  'app/src/native-owner-session-provider-linux.mjs',
  'app/src/native-tunnel-attestor.mjs','app/package.json'
 ];
 try{
  assert.equal(inspectLinuxNativeCorePayload(root),false);
  for(const rel of files){
   const f=path.join(root,rel);
   fs.mkdirSync(path.dirname(f),{recursive:true});
   fs.writeFileSync(f,rel==='app/package.json'
     ?'{"version":"0.12.0-dev.1"}':'NONPRODUCTION_QA_MODULE_ONLY');
  }
  assert.equal(inspectLinuxNativeCorePayload(root),true);
  // The SHA-pinned official Node v22 executable is ~125 MB. Sparse sizes
  // exercise real size admission without copying 125 MB in CI fixtures.
  const runtime=path.join(root,'runtime/node');
  fs.truncateSync(runtime,125*1024*1024);
  assert.equal(inspectLinuxNativeCorePayload(root),true);
  fs.truncateSync(runtime,257*1024*1024);
  assert.equal(inspectLinuxNativeCorePayload(root),false);
  fs.truncateSync(runtime,125*1024*1024);
  const probe=path.join(root,'app/src/v012-private-core-runtime.mjs');
  fs.unlinkSync(probe);
  assert.equal(inspectLinuxNativeCorePayload(root),false);
  // Ordinary Windows CI does not have SeCreateSymbolicLinkPrivilege;
  // exercise type rejection there without requiring Developer Mode/admin.
  if(process.platform==='win32'){
    fs.mkdirSync(probe);
    assert.equal(inspectLinuxNativeCorePayload(root),false);
    fs.rmdirSync(probe);
  }else{
    fs.symlinkSync(path.join(root,'app/src/server-v0.3.mjs'),probe);
    assert.equal(inspectLinuxNativeCorePayload(root),false);
    fs.unlinkSync(probe);
  }
  fs.writeFileSync(probe,'NONPRODUCTION_QA_MODULE_ONLY');
  fs.writeFileSync(path.join(root,'app/package.json'),'{"version":"0.11.0-dev.23"}');
  assert.equal(inspectLinuxNativeCorePayload(root),false);
  fs.writeFileSync(path.join(root,'app/package.json'),'{"version":"0.12.0-dev.1"}');
  assert.equal(inspectLinuxNativeCorePayload(root),true);
  const native=assessMigration({platform:'linux',connectionMode:'private-tunnel',
    inventoryReliable:true,nativePackageInstalled:true,
    allNativePayloadPathsAvailable:false,nativeProtectedCoreFilesPresent:false,
    nativePackageIntegrityVerified:false,units:[]});
  assert.ok(native.blocked.includes('NATIVE_PROTECTED_CORE_FILES_NOT_INSTALLED'));
  assert.ok(native.blocked.includes('NATIVE_RUNTIME_TUNNEL_SERVICE_CONTINUITY_UNPROVEN'));
  assert.ok(native.blocked.includes('NATIVE_INSTALLED_PACKAGE_INTEGRITY_UNVERIFIED'));
  assert.equal(native.nativeProtectedCoreFilesPresent,false);
  assert.equal(native.nativePackageIntegrityVerified,false);
  const packageBuild=fs.readFileSync(path.join(repo,'tools/build-native-linux-package.sh'),'utf8');
  for(const rel of files.filter(x=>x.startsWith('app/src/')))
    assert.ok(packageBuild.includes(rel.replace('app/','')),
      'dpkg builder must verify protected module '+rel);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('one product-wide NSIS registration is detected without interpreting a user uninstall command as permission',()=>{
 const output=[
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\e8b3b1a5-66f7-5b0b-b5ed-ddf867067934',
  '    DisplayName    REG_SZ    Remote Commander 0.12.0-dev.8',
  '    DisplayVersion    REG_SZ    0.12.0-dev.8',
  '    UninstallString    REG_SZ    "C:\\Users\\OWNER\\AppData\\Local\\Programs\\RemoteCommander\\Uninstall Remote Commander.exe" /currentuser'
 ].join('\r\n');
 assert.equal(classifyWindowsUnifiedNsisRegistryResponse(output),'unified-nsis');
 for(const version of ['0.12.0','0.13.0-beta.1','1.0.0']){
   const later=output.replaceAll('0.12.0-dev.8',version);
   assert.equal(classifyWindowsUnifiedNsisRegistryResponse(later),'unified-nsis');
 }
 for(const invalid of [
   output.replace('Remote Commander 0.12.0-dev.8','Remote Commander Browser'),
   output.replace('DisplayVersion    REG_SZ    0.12.0-dev.8',
     'DisplayVersion    REG_SZ    0.11.0-dev.8'),
   output.replaceAll('0.12.0-dev.8','0.11.0-dev.8'),
   output.replaceAll('0.12.0-dev.8','1.00.0'),
   output.replace('Uninstall Remote Commander.exe','unknown.exe'),
   output.replace('Remote Commander 0.12.0-dev.8','Remote Commander 0.12.0-dev.8\r\n    DisplayName    REG_SZ    counterfeit'),
   output.repeat(1000),
   ''
 ])assert.equal(classifyWindowsUnifiedNsisRegistryResponse(invalid),'unverified');
 const report=assessMigration({platform:'win32',connectionMode:'private-tunnel',
   inventoryReliable:true,legacyInnoPresent:false,
   nativeUnifiedNsisPresent:true,nativeUnifiedNsisRegistryMatched:true,
   ownerRegisteredInstallerFamily:'unified-nsis'});
 assert.equal(report.existingInstalled,true);
 assert.equal(report.nativeUnifiedNsisDetected,true);
 assert.equal(report.nativeUnifiedNsisRegistryMatched,true);
 assert.equal(report.ownerRegisteredInstallerFamily,'unified-nsis');
 assert.ok(report.blocked.includes('UNIFIED_NSIS_OWNER_UPGRADE_ROLLBACK_UNVERIFIED'));
 assert.ok(!report.blocked.includes('LEGACY_INNO_TO_NSIS_TRANSACTION_MISSING'));
 assert.equal(report.decision,'NO_PROMOTE');
 const ambiguous=assessMigration({...{
   platform:'win32',inventoryReliable:true,connectionMode:'private-tunnel',
   nativeUnifiedNsisPresent:true,ownerRegisteredInstallerFamily:'unverified',
   legacyInnoPresent:false}});
 assert.ok(ambiguous.blocked.includes('OWNER_INSTALLER_IDENTITY_UNVERIFIED'));
 assert.equal(ambiguous.decision,'NO_PROMOTE');
});

test('Windows Inno→NSIS remains blocked without proven reversible cutover',()=>{
 const r=assessMigration({platform:'win32',legacyInnoPresent:true,inventoryReliable:true});
 assert.equal(r.existingInstalled,true);
 assert.equal(r.decision,'NO_PROMOTE');
 assert.ok(r.blocked.includes('LEGACY_INNO_TO_NSIS_TRANSACTION_MISSING'));
 assert.equal(r.promotionAuthority,'EXTERNAL_REQUIRED');
});
test('unknown inventory and stale native paths are explicit blockers',()=>{
 const r=assessMigration({platform:'linux',nativePackageInstalled:true,inventoryReliable:false,
    allNativePayloadPathsAvailable:false,units:[]});
 assert.ok(r.blocked.includes('INVENTORY_UNAVAILABLE'));
 assert.ok(r.blocked.includes('NATIVE_RUNTIME_TUNNEL_SERVICE_CONTINUITY_UNPROVEN'));
 assert.throws(()=>assessMigration({platform:'android'}),/RC012_MIGRATION_PLATFORM_INVALID/);
});
test('self-reported all booleans cannot grant promotion or access',()=>{
 const f={platform:'linux',inventoryReliable:true,nativePackageInstalled:false,
   allNativePayloadPathsAvailable:true,units:[],activeServiceRestoreTested:true,
   profileBackupReceiptVerified:true,featureParityVerified:true,
   g1AuthenticatedCurrentSession:true,j01OwnerNativeConsent:true,
   revocableFullAccessProven:true,trustedPublisherSignature:true,
   signedUpdateRollbackAccepted:true,installedCanaryAccepted:true};
 const r=assessMigration(f);
 assert.deepEqual(r.blocked,[]);
 assert.equal(r.decision,'NO_PROMOTE');
 assert.equal(r.promotionAuthority,'EXTERNAL_REQUIRED');
});
test('local CLI refuses mutating and ambiguous arguments',()=>{
 const r=spawnSync(process.execPath,[modulePath,'--install'],{encoding:'utf8',timeout:5000});
 assert.notEqual(r.status,0);
 assert.match(r.stderr,/RC012_MIGRATION_PREFLIGHT_READ_ONLY_ONLY/);
});
test('read-only Linux CLI prints only sanitized count/flags, never source secrets',()=>{
 if(process.platform!=='linux')return;
 const snapshot=inspectLocalPlatform('linux');
 assert.equal(snapshot.platform,'linux');
 const r=spawnSync(process.execPath,[modulePath,'--read-only'],{encoding:'utf8',timeout:15000});
 assert.equal(r.status,2);
 const parsed=JSON.parse(r.stdout);
 assert.equal(parsed.readOnly,true);
 assert.equal(parsed.promotionAuthority,'EXTERNAL_REQUIRED');
 assert.equal(r.stdout.includes('api-key'),false);
 assert.equal(r.stdout.includes('CREDENTIALS_DIRECTORY'),false);
});

test('main tunnel profile binding is loopback-only, exact and credential-redacted',()=>{
 const profile=[
   'config_version: 1','control_plane:',
   '  tunnel_id: tunnel_abc123fake','  api_key: secret-test-DO-NOT-LEAK',
   'mcp:','  server_urls:','    - channel: main',
   '      url: "http://127.0.0.1:47831/mcp"'
 ].join('\n');
 const valid=parseMainTunnelBinding(profile);
 assert.deepEqual(valid,{port:47831,channel:'main',path:'/mcp',tls:false});
 assert.doesNotMatch(JSON.stringify(valid),/secret|tunnel_abc|api_key/i);
 for(const target of [
   'http://127.0.0.1:47831/mcp?token=bad',
   'http://127.0.0.1:47831/other',
   'http://127.0.0.1:47831@mcp.evil.example/mcp',
   'http://localhost:47831/mcp',
   'http://127.0.0.2:47831/mcp','http://127.0.0.1:80/mcp'
 ])assert.equal(parseMainTunnelBinding(profile.replace(
   'http://127.0.0.1:47831/mcp',target)),null,target);
 assert.deepEqual(parseMainTunnelBinding(profile.replace(
   'http://127.0.0.1:47831/mcp','https://127.0.0.1:49912/mcp')),
   {port:49912,channel:'main',path:'/mcp',tls:true});
 assert.equal(parseMainTunnelBinding(profile+'\n    - channel: main\n      url: "http://127.0.0.1:49912/mcp"'),null);
 assert.equal(parseMainTunnelBinding('mcp:\n  server_urls:\n    - channel: main\n      url: "http://127.0.0.1:47831/mcp"\n'.repeat(400)),null);
});
test('Windows tunnel target on old Core is explicit NoPromote even if other gates self-report true',()=>{
 const base={platform:'win32',inventoryReliable:true,legacyInnoPresent:true,
   tunnelProfilePresent:true,tunnelProfileValid:true,tunnelTargetPort:47831,
   tunnelTargetVersion:'0.11.0-dev.23',
   profileBackupReceiptVerified:true,featureParityVerified:true,
   g1AuthenticatedCurrentSession:true,j01OwnerNativeConsent:true,
   revocableFullAccessProven:true,trustedPublisherSignature:true,
   signedUpdateRollbackAccepted:true,installedCanaryAccepted:true};
 const old=assessMigration(base);
 assert.equal(old.ownerTunnelTargetPort,47831);
 assert.equal(old.ownerTunnelHttpsConfigured,false);
 assert.equal(old.ownerTunnelTargetRuntimeVersion,'0.11.0-dev.23');
 assert.ok(old.blocked.includes('OWNER_TUNNEL_STILL_TARGETS_LEGACY_OR_UNKNOWN_CORE'));
 const unknown=assessMigration({...base,tunnelProfileValid:false});
 assert.ok(unknown.blocked.includes('OWNER_TUNNEL_MAIN_BINDING_UNVERIFIED'));
 assert.equal(unknown.ownerTunnelTargetPort,null);
 const latest=assessMigration({...base,tunnelTargetVersion:'0.12.0-dev.1',tunnelTargetTls:true});
 assert.equal(latest.ownerTunnelHttpsConfigured,true);
 assert.ok(!latest.blocked.includes('OWNER_TUNNEL_STILL_TARGETS_LEGACY_OR_UNKNOWN_CORE'));
 assert.equal(latest.decision,'NO_PROMOTE');
 assert.ok(latest.blocked.includes('LEGACY_INNO_TO_NSIS_TRANSACTION_MISSING'));
});

test('stable-router backend mapping reports chain without trusting mutable owner profile fields',()=>{
 const status={router:true,listenPort:47831,sourceSha256:'f'.repeat(64),
   schema:1,profile:'default',generation:43,
   activePort:48834,activeVersion:'0.11.0-dev.23',
   token:'DO_NOT_EMIT',configPath:'C:/secret'};
 const observed=classifyObservedRouterStatus(status,47831,'0.11.0-dev.23');
 assert.deepEqual(observed,{detected:true,mappingMatches:true,
   backendPort:48834,backendVersion:'0.11.0-dev.23',generation:43});
 assert.doesNotMatch(JSON.stringify(observed),/token|secret|config/i);
 const mismatched=classifyObservedRouterStatus(status,47831,'0.12.0-dev.1');
 assert.equal(mismatched.detected,true);
 assert.equal(mismatched.mappingMatches,false);
 const rejected=[
   {...status,listenPort:49912},
   {...status,router:false},
   {...status,activePort:47831},
   {...status,activePort:80},
   {...status,sourceSha256:'bad'},
   {...status,generation:0},
   {...status,profile:'other'},
   {...status,activeVersion:'0.13.0-dev.1'}
 ];
 for(const entry of rejected)assert.deepEqual(
   classifyObservedRouterStatus(entry,47831,'0.11.0-dev.23'),
   {detected:false,mappingMatches:false});
});
test('router mismatch adds its own hard blocker even with synthetic successful booleans',()=>{
 const f={platform:'win32',inventoryReliable:true,legacyInnoPresent:true,
   tunnelProfilePresent:true,tunnelProfileValid:true,tunnelTargetPort:47831,
   tunnelTargetVersion:'0.11.0-dev.23',routerDetected:true,
   routerMappingMatches:false,routerBackendPort:48834,
   routerBackendVersion:'0.11.0-dev.23'};
 const blocked=assessMigration(f);
 assert.equal(blocked.ownerStableRouterBackendPort,48834);
 assert.equal(blocked.ownerStableRouterBackendVersion,'0.11.0-dev.23');
 assert.equal(blocked.ownerStableRouterMappingMatches,false);
 assert.ok(blocked.blocked.includes('OWNER_STABLE_ROUTER_BACKEND_MISMATCH'));
 const consistent=assessMigration({...f,routerMappingMatches:true});
 assert.equal(consistent.ownerStableRouterMappingMatches,true);
 assert.ok(!consistent.blocked.includes('OWNER_STABLE_ROUTER_BACKEND_MISMATCH'));
 assert.equal(consistent.decision,'NO_PROMOTE');
});

test('plaintext stable router never qualifies as G1 mTLS ingress after synthetic backend upgrade',()=>{
 const old={platform:'win32',inventoryReliable:true,legacyInnoPresent:false,
   tunnelProfilePresent:true,tunnelProfileValid:true,tunnelTargetPort:47831,
   tunnelTargetTls:false,tunnelTargetVersion:'0.12.0-dev.1',
   routerDetected:true,routerMappingMatches:true,
   routerBackendPort:49912,routerBackendVersion:'0.12.0-dev.1',
   profileBackupReceiptVerified:true,featureParityVerified:true,
   g1AuthenticatedCurrentSession:true,j01OwnerNativeConsent:true,
   revocableFullAccessProven:true,trustedPublisherSignature:true,
   signedUpdateRollbackAccepted:true,installedCanaryAccepted:true};
 const result=assessMigration(old);
 assert.equal(result.ownerStableRouterBackendPort,49912);
 assert.equal(result.ownerTunnelHttpsConfigured,false);
 assert.ok(result.blocked.includes('G1_STABLE_ROUTER_PLAINTEXT_MTLS_INCOMPATIBLE'));
 assert.ok(result.blocked.includes('G1_TUNNEL_HTTPS_MTLS_ROUTE_REQUIRED'));
 assert.equal(result.decision,'NO_PROMOTE');
 const direct=assessMigration({...old,tunnelTargetPort:49913,
   tunnelTargetTls:true,routerDetected:false});
 assert.equal(direct.ownerTunnelHttpsConfigured,true);
 assert.ok(!direct.blocked.includes('G1_STABLE_ROUTER_PLAINTEXT_MTLS_INCOMPATIBLE'));
 assert.ok(!direct.blocked.includes('G1_TUNNEL_HTTPS_MTLS_ROUTE_REQUIRED'));
 assert.equal(direct.decision,'NO_PROMOTE');
 const httpsToOldRouter=assessMigration({...old,tunnelTargetTls:true});
 assert.ok(httpsToOldRouter.blocked.includes('G1_STABLE_ROUTER_PLAINTEXT_MTLS_INCOMPATIBLE'));
 assert.equal(httpsToOldRouter.decision,'NO_PROMOTE');
});

test('private account-device Tunnel requires local pair and owner proof, not optional public OAuth',()=>{
 const f={platform:'win32',inventoryReliable:true,legacyInnoPresent:true,
   ownerRegisteredInstallerFamily:'owner-managed-powershell',
   tunnelProfilePresent:true,tunnelProfileValid:true,tunnelTargetPort:47831,
   tunnelTargetVersion:'0.11.0-dev.23',tunnelTargetTls:false,
   routerDetected:true,routerMappingMatches:true,
   routerBackendPort:48834,routerBackendVersion:'0.11.0-dev.23'};
 const r=assessMigration({...f,connectionMode:'private-tunnel'});
 assert.equal(r.connectionMode,'private-tunnel');
 assert.equal(r.decision,'NO_PROMOTE');
 assert.doesNotMatch(JSON.stringify(r),/api[_-]?key|password|bearer/i,
   'renderer-visible report must contain no credential-shaped keys or values');
 for(const legacy of ['G1_STABLE_ROUTER_PLAINTEXT_MTLS_INCOMPATIBLE',
   'G1_TUNNEL_HTTPS_MTLS_ROUTE_REQUIRED','G1_CURRENT_SESSION_UNVERIFIED',
   'LEGACY_INNO_TO_NSIS_TRANSACTION_MISSING'])
   assert.ok(!r.blocked.includes(legacy),legacy);
 for(const required of [
   'PRIVATE_PLUGIN_TUNNEL_PAIR_BINDING_UNVERIFIED',
   'PRIVATE_TUNNEL_LOOPBACK_ISOLATION_UNVERIFIED',
   'PRIVATE_RUNTIME_CREDENTIAL_OWNERSHIP_UNVERIFIED',
   'PRIVATE_PRIVILEGED_INGRESS_NOT_WIRED',
   'OWNER_MANAGED_TO_UNIFIED_NSIS_TRANSACTION_MISSING',
   'OWNER_TUNNEL_STILL_TARGETS_LEGACY_OR_UNKNOWN_CORE',
   'J01_NATIVE_OWNER_CONSENT_UNVERIFIED',
   'PROFILE_BACKUP_NOT_VERIFIED','NATIVE_INSTALLED_CANARY_NOT_ACCEPTED'
 ])assert.ok(r.blocked.includes(required),required);
 const strict=assessMigration({...f,connectionMode:'managed-oauth'});
 assert.equal(strict.connectionMode,'managed-oauth');
 assert.ok(strict.blocked.includes('G1_CURRENT_SESSION_UNVERIFIED'));
 assert.ok(strict.blocked.includes('G1_STABLE_ROUTER_PLAINTEXT_MTLS_INCOMPATIBLE'));
 assert.ok(strict.blocked.includes('G1_TUNNEL_HTTPS_MTLS_ROUTE_REQUIRED'));
 assert.ok(!strict.blocked.includes('PRIVATE_PLUGIN_TUNNEL_PAIR_BINDING_UNVERIFIED'));
 assert.throws(()=>assessMigration({...f,connectionMode:'anonymous-public'}),
   /RC012_MIGRATION_CONNECTION_MODE_INVALID/);
});

test('private URL MCP binding cannot pass privileged cutover through plaintext or legacy Router',()=>{
 const yes={platform:'win32',connectionMode:'private-tunnel',
   inventoryReliable:true,legacyInnoPresent:false,
   ownerRegisteredInstallerFamily:'none',
   tunnelProfilePresent:true,tunnelProfileValid:true,tunnelTargetPort:49912,
   tunnelTargetVersion:'0.12.0-dev.1',tunnelTargetTls:false,
   privatePairBindingVerified:true,privateLocalIngressIsolated:true,
   privateCredentialOwnershipVerified:true,privatePrivilegedIngressReady:true,
   profileBackupReceiptVerified:true,featureParityVerified:true,
   g1AuthenticatedCurrentSession:true,j01OwnerNativeConsent:true,
   activeServiceRestoreTested:true,revocableFullAccessProven:true,
   trustedPublisherSignature:true,signedUpdateRollbackAccepted:true,
   installedCanaryAccepted:true,units:[]};
 const plaintext=assessMigration(yes);
 assert.ok(plaintext.blocked.includes('PRIVATE_TUNNEL_HTTPS_MTLS_ROUTE_REQUIRED'));
 assert.equal(plaintext.decision,'NO_PROMOTE');
 const router=assessMigration({...yes,tunnelTargetTls:true,
   routerDetected:true,routerMappingMatches:true,
   routerBackendPort:49913,routerBackendVersion:'0.12.0-dev.1'});
 assert.ok(router.blocked.includes('PRIVATE_STABLE_ROUTER_MTLS_INCOMPATIBLE'));
 assert.equal(router.decision,'NO_PROMOTE');
 const protectedDirect=assessMigration({...yes,tunnelTargetTls:true});
 assert.equal(protectedDirect.ownerTunnelHttpsConfigured,true);
 assert.ok(!protectedDirect.blocked.includes('PRIVATE_TUNNEL_HTTPS_MTLS_ROUTE_REQUIRED'));
 assert.ok(!protectedDirect.blocked.includes('PRIVATE_STABLE_ROUTER_MTLS_INCOMPATIBLE'));
 assert.deepEqual(protectedDirect.blocked,[]);
 assert.equal(protectedDirect.decision,'NO_PROMOTE',
   'only external native acceptance can promote even when all facts self-report true');
});

test('synthetic fully positive private flags never authorize install or bypass J01',()=>{
 const f={platform:'linux',connectionMode:'private-tunnel',
   inventoryReliable:true,nativePackageInstalled:false,allNativePayloadPathsAvailable:true,
   units:[],privatePairBindingVerified:true,privateLocalIngressIsolated:true,
   privateCredentialOwnershipVerified:true,privatePrivilegedIngressReady:true,
   activeServiceRestoreTested:true,
   profileBackupReceiptVerified:true,featureParityVerified:true,j01OwnerNativeConsent:true,
   revocableFullAccessProven:true,trustedPublisherSignature:true,
   signedUpdateRollbackAccepted:true,installedCanaryAccepted:true};
 const r=assessMigration(f);
 assert.deepEqual(r.blocked,[]);
 assert.equal(r.decision,'NO_PROMOTE');
 assert.equal(r.promotionAuthority,'EXTERNAL_REQUIRED');
 assert.equal(r.connectionMode,'private-tunnel');
 assert.ok(assessMigration({...f,j01OwnerNativeConsent:false}).blocked.includes(
   'J01_NATIVE_OWNER_CONSENT_UNVERIFIED'));
 assert.ok(assessMigration({...f,privatePrivilegedIngressReady:false}).blocked.includes(
   'PRIVATE_PRIVILEGED_INGRESS_NOT_WIRED'));
});

test('registered owner PowerShell uninstaller is distinct from Inno and cannot trigger blind removal',()=>{
 const registryCommand='    UninstallString    REG_SZ    "C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -File "C:\\Users\\Owner\\Remote Commander\\uninstall.ps1"';
 assert.equal(classifyWindowsUninstallRegistryResponse(registryCommand),'owner-managed-powershell');
 assert.equal(classifyWindowsUninstallRegistryResponse(
   '    UninstallString    REG_SZ    "C:\\Users\\Owner\\Remote Commander\\unins000.exe"'),
   'inno-unverified');
 for(const raw of [
   'UninstallString REG_SZ powershell.exe -EncodedCommand something',
   'UninstallString REG_SZ "C:\\Not-Installer\\pwsh.exe" -File "C:\\elsewhere\\other.ps1"',
   'UninstallString REG_SZ "C:\\Program Files\\Any\\Uninstall.exe"',
   registryCommand+'\n'+registryCommand,
   '',
   'x'.repeat(50001)
 ])assert.equal(classifyWindowsUninstallRegistryResponse(raw),'unverified');
 const actual=assessMigration({platform:'win32',inventoryReliable:true,
   legacyInnoPresent:true,ownerRegisteredInstallerFamily:'owner-managed-powershell'});
 assert.equal(actual.ownerRegisteredInstallerFamily,'owner-managed-powershell');
 assert.ok(actual.blocked.includes('OWNER_MANAGED_TO_UNIFIED_NSIS_TRANSACTION_MISSING'));
 assert.ok(!actual.blocked.includes('LEGACY_INNO_TO_NSIS_TRANSACTION_MISSING'));
 assert.equal(actual.decision,'NO_PROMOTE');
 assert.doesNotMatch(JSON.stringify(actual),/C:\\Users\\Owner|uninstall\.ps1/);
 const weird=assessMigration({platform:'win32',inventoryReliable:true,
   legacyInnoPresent:true,ownerRegisteredInstallerFamily:'multiple-or-unverified'});
 assert.ok(weird.blocked.includes('OWNER_INSTALLER_IDENTITY_UNVERIFIED'));
});

test('independently owner-pinned SHA-256 can replace commercial signer, but not migration acceptance',()=>{
  const facts={platform:'linux',inventoryReliable:true,nativePackageInstalled:false,
    allNativePayloadPathsAvailable:true,units:[],activeServiceRestoreTested:true,
    profileBackupReceiptVerified:true,featureParityVerified:true,
    g1AuthenticatedCurrentSession:true,j01OwnerNativeConsent:true,
    revocableFullAccessProven:true,installedCanaryAccepted:true};
  const absent=assessMigration(facts);
  assert.ok(absent.blocked.includes('TRUSTED_RELEASE_PROVENANCE_UNVERIFIED'));
  assert.ok(absent.blocked.includes('UPDATE_ROLLBACK_PROVENANCE_UNVERIFIED'));
  const approved=assessMigration({...facts,
    ownerPinnedNativeReleaseVerified:true,ownerPinnedRollbackVerified:true});
  assert.equal(approved.blocked.length,0);
  assert.equal(approved.decision,'NO_PROMOTE');
  assert.equal(approved.promotionAuthority,'EXTERNAL_REQUIRED');
  const half=assessMigration({...facts,ownerPinnedNativeReleaseVerified:true});
  assert.ok(half.blocked.includes('UPDATE_ROLLBACK_PROVENANCE_UNVERIFIED'));
});

test('owner-private exact one-tunnel plan preserves existing account ID/key and changes only the local MCP hop',()=>{
  const source=[
    'config_version: 1',
    'control_plane:',
    '  tunnel_id: local-tunnel-fixture-id',
    '  api_key: env:EXCLUSIVE_OWNER_FIXTURE_KEY',
    'health:',
    '  listen_addr: 127.0.0.1:47832',
    'mcp:',
    '  server_urls:',
    '    - channel: main',
    '      url: http://127.0.0.1:47831/mcp',
    ''
  ].join('\n');
  const p=process.platform==='win32'?'C:\\Owner\\private':'/home/owner/private';
  const options={currentYaml:source,protectedPort:47999,
    clientCertPath:path.join(p,'client.crt'),
    clientKeyPath:path.join(p,'client.key'),
    clientCaPath:path.join(p,'ca.crt')};
  const plan=planOwnerPrivateTunnelCutover(options);
  assert.equal(plan.mode,'OFFLINE_PLAN_NO_CUTOVER');
  assert.equal(plan.sourcePort,47831);
  assert.equal(plan.protectedPort,47999);
  assert.equal(plan.activeTunnelChanged,false);
  assert.equal(plan.ownerNativeConsentRequired,true);
  assert.equal(plan.originalTunnelControlPlanePreserved,true);
  assert.equal(plan.originalApiKeyReferencePreserved,true);
  assert.equal(parseMainTunnelBinding(plan.candidateYaml).tls,true);
  assert.equal(parseMainTunnelBinding(plan.candidateYaml).port,47999);
  assert.ok(plan.candidateYaml.includes('  tunnel_id: local-tunnel-fixture-id'));
  assert.ok(plan.candidateYaml.includes('  api_key: env:EXCLUSIVE_OWNER_FIXTURE_KEY'));
  assert.ok(plan.candidateYaml.includes('  listen_addr: 127.0.0.1:47832'));
  assert.equal(plan.candidateYaml.split('  tunnel_id:').length,2);
  assert.equal(plan.candidateYaml.split('  api_key:').length,2);
  assert.ok(!JSON.stringify({...plan,candidateYaml:undefined}).includes('EXCLUSIVE_OWNER_FIXTURE_KEY'));
  assert.throws(()=>planOwnerPrivateTunnelCutover({...options,protectedPort:47831}),
    /RC012_OWNER_TUNNEL_SINGLE_PLAINTEXT_MAIN_REQUIRED/);
  assert.throws(()=>planOwnerPrivateTunnelCutover({...options,currentYaml:plan.candidateYaml}),
    /RC012_OWNER_TUNNEL_SINGLE_PLAINTEXT_MAIN_REQUIRED/);
  assert.throws(()=>planOwnerPrivateTunnelCutover({...options,
    currentYaml:source.replace('  server_urls:','  client_key: malicious\n  server_urls:')}),
    /RC012_OWNER_TUNNEL_ALREADY_HAS_TLS_IDENTITY/);
  assert.throws(()=>planOwnerPrivateTunnelCutover({...options,
    currentYaml:source+'ca_bundle: /tmp/other\n'}),
    /RC012_OWNER_TUNNEL_EXISTING_CA_CONFLICT/);
  assert.throws(()=>planOwnerPrivateTunnelCutover({...options,
    currentYaml:source.replace('  server_urls:',
      '  server_urls:\n    - channel: main\n      url: http://127.0.0.1:47831/mcp')}),
    /RC012_OWNER_TUNNEL_SINGLE_PLAINTEXT_MAIN_REQUIRED|RC012_OWNER_TUNNEL_MAIN_URL_AMBIGUOUS/);
  assert.throws(()=>planOwnerPrivateTunnelCutover({...options,
    clientKeyPath:'../secret'}),
    /RC012_TUNNEL_CERT_PATH_INVALID/);
});

test('offline one-Tunnel owner inspection never emits profile contents or writes source',()=>{
  const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'rc012-owner-tunnel-plan-'));
  const windows=process.platform==='win32';
  const profileName=windows?'chatgpt-remote-commander':'Emad';
  try{
    const profileDir=windows?path.join(isolated,'tunnel-client')
      :path.join(isolated,'.config','tunnel-client');
    const certDir=windows?path.join(isolated,'ChatGPTRemoteCommander','private-pair','default')
      :path.join(isolated,'.config','chatgpt-remote-commander','private-pair','default');
    fs.mkdirSync(profileDir,{recursive:true,mode:0o700});
    fs.mkdirSync(certDir,{recursive:true,mode:0o700});
    fs.chmodSync(profileDir,0o700);fs.chmodSync(certDir,0o700);
    const profileFile=path.join(profileDir,profileName+'.yaml');
    const source=[
      'config_version: 1',
      'control_plane:',
      '  tunnel_id: qa-nonproduction-owner-label',
      '  api_key: env:LOCAL_QA_FIXTURE_ONLY',
      'mcp:',
      '  server_urls:',
      '    - channel: main',
      '      url: http://127.0.0.1:47831/mcp',
      ''
    ].join('\n');
    fs.writeFileSync(profileFile,source,{mode:0o600});
    for(const name of ['client.crt','client.key','ca.crt'])
      fs.writeFileSync(path.join(certDir,name),'noncredential-fixture\n',{mode:0o600});
    const script=path.join(repo,'tools','inspect-owner-private-tunnel-cutover.mjs');
    const options={cwd:repo,encoding:'utf8',timeout:6000,
      env:{...process.env,APPDATA:isolated,HOME:isolated}};
    const result=spawnSync(process.execPath,[script,'--target-port=47999',
      '--profile-name='+profileName],options);
    assert.equal(result.status,0,(result.stderr||'').slice(-1000));
    const summary=JSON.parse(result.stdout.trim());
    assert.equal(summary.mode,'OFFLINE_PLAN_NO_CUTOVER');
    assert.equal(summary.profileName,profileName);
    assert.equal(summary.sourcePort,47831);
    assert.equal(summary.protectedPort,47999);
    assert.equal(summary.candidateYamlIncluded,false);
    assert.equal(summary.ownerCredentialsInOutput,false);
    assert.equal(summary.activeTunnelChanged,false);
    assert.equal(summary.rollbackRequired,true);
    assert.ok(!JSON.stringify(summary).includes('LOCAL_QA_FIXTURE_ONLY'));
    assert.ok(!JSON.stringify(summary).includes('qa-nonproduction-owner-label'));
    assert.equal(fs.readFileSync(profileFile,'utf8'),source);
    const invalid=spawnSync(process.execPath,[script,'--target-port=47999',
      '--profile-name=../../escape'],options);
    assert.notEqual(invalid.status,0);
    assert.match(invalid.stderr,/RC012_OWNER_EXACT_PROFILE_REQUIRED/);
    assert.equal(fs.readFileSync(profileFile,'utf8'),source);
  }finally{fs.rmSync(isolated,{recursive:true,force:true});}
});



test('Linux encrypted backup guard independently decrypts an exact owner-local receipt and rejects tampering',{
 skip:process.platform!=='linux'
},()=>{
 const proc=spawnSync('systemd-creds',['--version'],{encoding:'utf8',timeout:2000});
 if(proc.status!==0)return;
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'rc012-owner-backup-qa-'));
 const profile='mmz-linux';
 const credentialName=profile+'-profile-v012';
 const cipherName='tunnel-profile-'+profile+'-owner-restorable.cred';
 const folder=path.join(home,'.config','tunnel-client');
 const recovery=path.join(home,'recovery','rc012-private-qa');
 const sourceFile=path.join(folder,profile+'.yaml');
 const cipherFile=path.join(recovery,cipherName);
 const receiptFile=path.join(recovery,'rc012-owner-private-profile-backups-verified.json');
 const secret='SYNTHETIC_TEST_SECRET_NEVER_LOG';
 const content='mcp:\\n  api_key: '+secret+'\\n';
 const hash=s=>createHash('sha256').update(s).digest('hex');
 const verify=(opts={})=>verifyLinuxPrivateProfileBackup({
  home,ownerUid:process.getuid(),profileName:profile,recoveryDir:recovery,...opts
 });
 try{
  fs.mkdirSync(folder,{recursive:true,mode:0o700});
  fs.mkdirSync(recovery,{recursive:true,mode:0o700});
  fs.chmodSync(recovery,0o700);
  fs.writeFileSync(sourceFile,content,{mode:0o600});
  const enc=spawnSync('systemd-creds',['encrypt','--user','--with-key=host',
    '--name='+credentialName,sourceFile,cipherFile],{timeout:6000,encoding:'utf8'});
  assert.equal(enc.status,0,enc.stderr);
  fs.chmodSync(cipherFile,0o600);
  const payload={schema:1,scope:'MMZ_HOST_THREE_OWNER_PRIVATE_TUNNEL_YAML_ROLLBACK_ONLY',
   sameHostEncryptedRestoreProven:true,profiles:{[profile]:{
    backupFile:cipherName,credentialName,encryption:'systemd-creds-user-host-non-null',
    sourceBytes:fs.statSync(sourceFile).size,cipherBytes:fs.statSync(cipherFile).size,
    sourceSha256:hash(fs.readFileSync(sourceFile)),
    ciphertextSha256:hash(fs.readFileSync(cipherFile))
   }}};
  const save=()=>fs.writeFileSync(receiptFile,JSON.stringify(payload),{mode:0o600});
  save();
  assert.equal(verify(),true);
  // Ambient PATH cannot select the system credential or hashing executables.
  const fakeBin=path.join(home,'untrusted-executables');
  fs.mkdirSync(fakeBin,{mode:0o700});
  const marker=path.join(home,'unexpected-exec-marker');
  for(const name of ['sha256sum','systemd-creds','cut'])
    fs.writeFileSync(path.join(fakeBin,name),
      '#!/bin/sh\nprintf exec >> "$RC020_PATH_MARKER"\nexit 91\n',{mode:0o700});
  const priorPath=process.env.PATH;
  const priorMarker=process.env.RC020_PATH_MARKER;
  let safe;
  try{
    process.env.PATH=fakeBin+path.delimiter+(priorPath??'');
    process.env.RC020_PATH_MARKER=marker;
    safe=verify();
  }finally{
    if(priorPath===undefined)delete process.env.PATH;else process.env.PATH=priorPath;
    if(priorMarker===undefined)delete process.env.RC020_PATH_MARKER;
    else process.env.RC020_PATH_MARKER=priorMarker;
  }
  assert.equal(fs.existsSync(marker),false,
    'preflight must never run attacker-selectable executables from PATH');
  assert.equal(safe,true,'owner-scoped backup remains valid with untrusted PATH');
  assert.equal(verify({profileName:'other-owner'}),false);
  assert.equal(verify({recoveryDir:undefined}),false);
  fs.chmodSync(sourceFile,0o644);
  assert.equal(verify(),false,'non-private source');
  fs.chmodSync(sourceFile,0o600);
  fs.appendFileSync(sourceFile,'# mutation');
  assert.equal(verify(),false,'changed source');
  fs.writeFileSync(sourceFile,content);
  assert.equal(verify(),true);
  payload.profiles[profile].sourceSha256='f'.repeat(64);
  save();
  assert.equal(verify(),false,'forged source hash');
  payload.profiles[profile].sourceSha256=hash(Buffer.from(content));
  save();
  assert.equal(verify(),true);
  payload.profiles[profile].credentialName='wrong-credential';
  save();
  assert.equal(verify(),false,'wrong credential name');
  payload.profiles[profile].credentialName=credentialName;
  save();
  fs.chmodSync(receiptFile,0o644);
  assert.equal(verify(),false,'world-readable receipt');
  fs.chmodSync(receiptFile,0o600);
  const linked=path.join(home,'recovery','linked');
  fs.symlinkSync(recovery,linked);
  assert.equal(verify({recoveryDir:linked}),false,'symlink root');
  assert.equal(verify(),true);
  fs.appendFileSync(cipherFile,'tampered');
  assert.equal(verify(),false,'cipher digest mismatch');
  assert.equal(JSON.stringify({valid:verify()}),'{\"valid\":false}');
  assert.ok(!JSON.stringify({valid:verify()}).includes(secret));
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('one native DEB derives its version from the exact same source and GUI train',()=>{
  assert.equal(candidateNativeDebianVersion('0.12.0-dev.1','0.12.0-dev.1'),
    '0.12.0~dev.1');
  assert.equal(candidateNativeDebianVersion('0.12.0-dev.7','0.12.0-dev.7'),
    '0.12.0~dev.7');
  for(const [source,gui] of [
    ['0.12.0-dev.1','0.12.0-dev.7'],
    ['0.12.0-dev.01','0.12.0-dev.01'],
    ['0.11.0-dev.7','0.11.0-dev.7'],
    ['0.12.0-rc.1','0.12.0-rc.1'],
    ['0.12.0-dev.1+other','0.12.0-dev.1+other'],
    [null,null]
  ]) assert.equal(candidateNativeDebianVersion(source,gui),null,
    String(source)+' / '+String(gui));
});
test('Debian dev.9 candidate is strictly ahead of dev.6 without implying installed admission',{skip:process.platform!=='linux'},()=>{
 const app=JSON.parse(fs.readFileSync(path.join(repo,'package.json'),'utf8'));
 const gui=JSON.parse(fs.readFileSync(path.join(repo,'packaging/unified/package.json'),'utf8'));
 const train=JSON.parse(fs.readFileSync(path.join(repo,'docs/release-train-0.12.json'),'utf8'));
 assert.equal(app.version,'0.12.0-dev.9');
 assert.equal(app.version,gui.version);
 assert.equal(train.sourceVersion,app.version);
 assert.equal(train.installedPromotionApproved,false);
 assert.equal(train.publishApproved,false);
 const cand=candidateNativeDebianVersion(app.version,gui.version);
 assert.equal(cand,'0.12.0~dev.9');
 for(const [lower,relation,upper,expected] of [
   ['0.12.0~dev.6','lt',cand,0],
   [cand,'gt','0.12.0~dev.6',0],
   [cand,'eq',cand,0],
   [cand,'lt','0.12.0',0],
   ['0.12.0~dev.6','gt',cand,1]
 ]){
   const r=spawnSync('dpkg',['--compare-versions',lower,relation,upper],{encoding:'utf8'});
   assert.equal(r.status,expected,lower+' '+relation+' '+upper+' '+r.stderr);
 }
 const preflight=assessMigration({platform:'linux',inventoryReliable:true,
   connectionMode:'private-tunnel',nativePackageInstalled:true,
   allNativePayloadPathsAvailable:true,candidateNativePackageVersionVerified:true,
   candidateNativePackageDowngrade:false,candidateNativePackageSameVersion:false,
   units:[]});
 assert.equal(preflight.decision,'NO_PROMOTE','forward package version is never owner admission');
 assert.ok(preflight.blocked.includes('PRIVATE_PLUGIN_TUNNEL_PAIR_BINDING_UNVERIFIED'));
 assert.ok(preflight.blocked.includes('J01_NATIVE_OWNER_CONSENT_UNVERIFIED'));
 assert.ok(preflight.blocked.includes('UPDATE_ROLLBACK_PROVENANCE_UNVERIFIED'));
});
test('native owner Installer migration rejects downgrade, same-version and unverifiable identity',()=>{
  const base={platform:'linux',connectionMode:'private-tunnel',
    inventoryReliable:true,nativePackageInstalled:true,
    allNativePayloadPathsAvailable:true,
    candidateNativePackageVersionVerified:true,
    candidateNativePackageDowngrade:false,candidateNativePackageSameVersion:false,
    units:[]};
  const upgrade=assessMigration(base);
  assert.equal(upgrade.nativeCandidateVersionComparisonVerified,true);
  assert.ok(!upgrade.blocked.includes('NATIVE_CANDIDATE_PACKAGE_DOWNGRADE_REFUSED'));
  assert.ok(!upgrade.blocked.includes('NATIVE_CANDIDATE_PACKAGE_SAME_VERSION_REFUSED'));
  const downgrade=assessMigration({...base,candidateNativePackageDowngrade:true});
  assert.equal(downgrade.decision,'NO_PROMOTE');
  assert.equal(downgrade.nativeCandidateDowngradeDetected,true);
  assert.ok(downgrade.blocked.includes('NATIVE_CANDIDATE_PACKAGE_DOWNGRADE_REFUSED'));
  const same=assessMigration({...base,candidateNativePackageSameVersion:true});
  assert.ok(same.blocked.includes('NATIVE_CANDIDATE_PACKAGE_SAME_VERSION_REFUSED'));
  const unverifiable=assessMigration({...base,candidateNativePackageVersionVerified:false});
  assert.ok(unverifiable.blocked.includes('NATIVE_CANDIDATE_VERSION_COMPARISON_UNVERIFIED'));
  const windows=assessMigration({platform:'win32',legacyInnoPresent:true,
    candidateNativePackageDowngrade:true,inventoryReliable:true,units:[]});
  assert.equal(windows.nativeCandidateVersionComparisonVerified,null);
  assert.ok(!windows.blocked.includes('NATIVE_CANDIDATE_PACKAGE_DOWNGRADE_REFUSED'));
  for(const report of [downgrade,same,unverifiable])
    assert.equal(JSON.stringify(report).includes('0.12.0~dev.6'),false,
      'do not publish installed DEB revision or owner identity');
});

test('Windows owner DPAPI six-file proof is strictly bound to native success receipt',()=>{
  const marker='RC012_WINDOWS_OWNER_DPAPI_BACKUP_VERIFY_PASS files=6 encrypted=true originalProfileUnchanged=true actualRestoreNotExecuted=true';
  assert.equal(windowsOwnerDpapiVerifyOutputAccepted(0,marker+'\r\n'),true);
  assert.equal(windowsOwnerDpapiVerifyOutputAccepted(1,marker),false);
  assert.equal(windowsOwnerDpapiVerifyOutputAccepted(0,marker+' extra'),false);
  assert.equal(windowsOwnerDpapiVerifyOutputAccepted(0,'RC012_WINDOWS_OWNER_DPAPI_RESTORE_SIMULATION_PASS files=6'),false);
  assert.equal(windowsOwnerDpapiVerifyOutputAccepted(null,marker),false);
});
test('Windows read-only DPAPI preflight pins machine PowerShell independently of ambient ProgramFiles',async()=>{
  const {windowsOwnerDpapiPowerShellExecutable}=await import(
    '../packaging/unified/migration-preflight.mjs');
  assert.equal(typeof windowsOwnerDpapiPowerShellExecutable,'function',
    'the DPAPI executable selector must be explicit and independently testable');
  const expected=path.win32.join('C:\\Program Files','PowerShell','7','pwsh.exe');
  const old=process.env.ProgramFiles;
  try{
    for(const forged of ['Z:\\untrusted\\PowerShell\\7',
      'C:\\Users\\untrusted\\bin','..\\outside','']){
      process.env.ProgramFiles=forged;
      assert.equal(windowsOwnerDpapiPowerShellExecutable(),expected);
    }
  }finally{
    if(old===undefined)delete process.env.ProgramFiles;
    else process.env.ProgramFiles=old;
  }
  const actual=fs.readFileSync(modulePath,'utf8');
  assert.doesNotMatch(actual,/const exe=path\.win32\.join\(programFiles,/,
    'never derive the executable from user-controllable ProgramFiles');
});