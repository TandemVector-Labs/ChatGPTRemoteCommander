#!/usr/bin/env node
// V1-01 release-source composition gate. No install, listener or grant changes.
// SOURCE_COVERAGE_PASS is NEVER an authenticated G1 or FULL_ACCESS verdict.
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isVersionAtLeast} from './run-pinned-v2-interop.mjs';

export const V101_ACCEPTED_ADAPTER_SHA256='2b9793250e4a537f19890a3865d05238d6ccb46cb735c88677cb4daba6f00445';
export const V102_ACCEPTED_WIN_JOB_SHA256='57b50598798c328ee6fb06c926e8eb16b4da71dc83ac76344e41952383a848d4';
// Independently tested V1-03/J01 verifier modules, NOT a protected signer or enrolled credential.
export const J01_VERIFIER_SHA256=Object.freeze({
  'src/gui-j01-owner-grant-verifier.mjs':'07c1969c11d2eaffd90bcb7d11b6b4fb0133dd1cb50f8b6af8fb49d047e2a34a',
  'src/gui-j01-webauthn-verifier.mjs':'1614dbfc7627dfd7aa38f5676716e9a00787f3984f2f8ed45197eb70d89127be'
});
export const G1_TRUST_ASSETS_SHA256=Object.freeze({
  'assets/trust/openai/root-ca.pem':'3a565b5c83c83ba2de085de28733e3c6af01af9b347322b93caf3a03d42c5cbe',
  'assets/trust/openai/connectors-mtls-intermediate-ca.pem':'7485f98dfbb7db119ca99d5748ac7a86baa73ddede878d3263a50cba2c4f6dd8'
});
export const G1_MODULES=Object.freeze([
  'src/server-v0.3.mjs',
  'src/native-owner-administration-authorizer.mjs',
  'src/native-owner-session-provider-linux.mjs',
  'src/native-owner-session-provider-windows.mjs',
  'src/native-owner-session-windows.ps1',
  'src/v101-linux-owner-security-bootstrap.mjs',
  'src/v101-windows-owner-security-bootstrap.mjs',
  'src/v101-g1-loopback-runtime.mjs',
  'src/v101-g1-canonical-workflow-runtime.mjs',
  'src/v101-private-tunnel-owner-host.mjs',
  'src/v2-private-tunnel-https-gateway.mjs',
  'src/v2-private-tunnel-mtls-attestor.mjs',
  'src/v2-platform-session-proof.mjs',
  'src/v2-oauth-provider-discovery.mjs',
  'src/full-access-http-quarantine.mjs',
  'src/full-access-protected-router-bridge.mjs',
  'src/gui-j01-owner-grant-verifier.mjs',
  'src/gui-j01-webauthn-verifier.mjs',
  'src/v101-v2-protected-dispatcher.mjs',
  'src/v2-authorized-operation.mjs',
  'src/v2-caller-assertion.mjs',
  'src/v2-direct-mtls-attestor.mjs',
  'src/v2-grant-registry.mjs',
  'src/v2-mcp-http-ingress.mjs',
  'src/v2-mcp-oauth-contract.mjs',
  'src/v2-mcp-workflow-dispatcher.mjs',
  'src/v2-native-owner-session-bindings.mjs',
  'src/v2-oauth-caller.mjs',
  'src/v2-oauth-jwks.mjs',
  'src/v2-oauth-provider-preflight.mjs',
  'src/v2-oauth-resource-metadata.mjs',
  'src/v2-openai-mtls-trust.mjs',
  'src/v2-routing-contract.mjs',
  'src/v2-workflow-gateway.mjs'
]);
const WIN_BINARY='tools/windows-job-runner/dist/win-x64/CommanderWindowsJobRunner.exe';
const WIN_MANIFEST='tools/windows-job-runner/release-manifest.json';
const BASE=Object.freeze({
  gate:'V101_G1_RELEASE_SOURCE_COVERAGE',
  productionG1Accepted:false,authenticatedCallerProved:false,
  nativeOwnerGrantProved:false,installedIngressProved:false,
  signedChatIdentityProved:false,rollbackProved:false,
  j01CredentialEnrolled:false,j01NativeSignerAccepted:false,
  operationalFullAccessProved:false
});
function safeFile(root,relative,maxBytes=1024*1024){
  const abs=path.join(root,relative);
  try{
    const st=lstatSync(abs);
    if(!st.isFile()||st.isSymbolicLink()||st.size<1||st.size>maxBytes)return null;
    if(realpathSync.native(abs).toLowerCase()!==path.resolve(abs).toLowerCase())return null;
    return readFileSync(abs);
  }catch{return null;}
}
function digest(bytes){return createHash('sha256').update(bytes).digest('hex');}
export function parseArgs(args){
  if(!Array.isArray(args)||args.length!==3)throw Error('V101_BUNDLE_ARGUMENTS_REQUIRED');
  const opts=Object.create(null);
  for(const raw of args){
    if(typeof raw!=='string'||!raw.startsWith('--')||raw.indexOf('=')<1)
      throw Error('V101_BUNDLE_ARGUMENTS_INVALID');
    const k=raw.slice(0,raw.indexOf('=')),v=raw.slice(raw.indexOf('=')+1);
    if(!['--root','--minimum-version','--target-platform'].includes(k)
      ||!v||Object.hasOwn(opts,k))throw Error('V101_BUNDLE_ARGUMENTS_INVALID');
    opts[k]=v;
  }
  if(!path.isAbsolute(opts['--root']??'')
    ||!['win32','linux'].includes(opts['--target-platform']))
    throw Error('V101_BUNDLE_SCOPE_INVALID');
  return {root:path.resolve(opts['--root']),
    minimumVersion:opts['--minimum-version'],
    platform:opts['--target-platform']};
}
export function assessG1ReleaseBundle({root,minimumVersion='0.11.0-dev.23',platform='win32'}={}){
  const denied=(code,other={})=>({...BASE,status:'BLOCKED',code,...other});
  if(typeof root!=='string'||!path.isAbsolute(root)
    ||!['win32','linux'].includes(platform))return denied('SOURCE_ROOT_INVALID');
  let stat;
  try{stat=lstatSync(root);}catch{return denied('SOURCE_ROOT_MISSING');}
  if(!stat.isDirectory()||stat.isSymbolicLink()
     ||realpathSync.native(root).toLowerCase()!==path.resolve(root).toLowerCase())
    return denied('SOURCE_ROOT_INVALID');
  const pkg=safeFile(root,'package.json');
  let version;
  try{version=JSON.parse(pkg?.toString('utf8')??'null')?.version;}
  catch{return denied('PACKAGE_VERSION_INVALID');}
  try{
    if(!isVersionAtLeast(version,minimumVersion))
      return denied('DOWNGRADE_OR_STALE_RELEASE',{version,minimumVersion});
  }catch{return denied('PACKAGE_VERSION_INVALID');}
  const missing=G1_MODULES.filter(rel=>!safeFile(root,rel));
  if(missing.length)return denied('G1_MODULES_OMITTED_FROM_RELEASE',{
    version,missing,countRequired:G1_MODULES.length});
  // Presence is not enough: Windows text-mode checkout or packaging may
  // rewrite the exact public mTLS trust anchors, invalidating their pin.
  for(const [relative,expected] of Object.entries(G1_TRUST_ASSETS_SHA256)){
    const bytes=safeFile(root,relative);
    if(!bytes||digest(bytes)!==expected)
      return denied('G1_TRUST_ASSET_NOT_PINNED',{version,asset:relative});
  }
  const adapter=safeFile(root,'src/v101-v2-protected-dispatcher.mjs');
  if(digest(adapter)!==V101_ACCEPTED_ADAPTER_SHA256)
    return denied('V101_ADAPTER_NOT_PINNED',{version});
  for(const [relative,expected] of Object.entries(J01_VERIFIER_SHA256)){
    if(digest(safeFile(root,relative))!==expected)
      return denied('J01_VERIFIER_NOT_PINNED',{version,module:relative});
  }
  if(platform==='win32'){
    const manifest=safeFile(root,WIN_MANIFEST,16384);
    const binary=safeFile(root,WIN_BINARY,100*1024*1024);
    let entry;
    try{entry=JSON.parse(manifest?.toString('utf8')??'null');}
    catch{return denied('WINDOWS_JOB_RUNNER_NOT_VERIFIED',{version});}
    if(!binary||!entry||entry.runnerSha256!==V102_ACCEPTED_WIN_JOB_SHA256
       ||digest(binary)!==V102_ACCEPTED_WIN_JOB_SHA256)
      return denied('WINDOWS_JOB_RUNNER_NOT_VERIFIED',{version});
  }
  return {...BASE,status:'SOURCE_COVERAGE_PASS_NOT_G1_ACCEPTANCE',
    code:'G1_J01_SOURCE_PRESENT_NOT_ENROLLED_OR_WIRED',
    version,platform,countChecked:G1_MODULES.length+(platform==='win32'?2:0)};
}
export function main(args=process.argv.slice(2)){
  let verdict;
  try{verdict=assessG1ReleaseBundle(parseArgs(args));}
  catch{verdict={...BASE,status:'BLOCKED',code:'INVALID_COMMAND_ARGUMENTS'};}
  process.stdout.write(JSON.stringify(verdict)+'\n');
  return verdict.status==='SOURCE_COVERAGE_PASS_NOT_G1_ACCEPTANCE'?0:3;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  process.exitCode=main();
