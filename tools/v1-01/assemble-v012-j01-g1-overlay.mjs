#!/usr/bin/env node
// Commander V1 0.12.0: reproducible V1-01 G1 + V1-03 J01 security-source handoff.
// This is not a full installer, nor an authenticated production service.
// No network, no process elevation, no application/Router mutation.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {G1_MODULES,J01_VERIFIER_SHA256,
 V101_ACCEPTED_ADAPTER_SHA256,V102_ACCEPTED_WIN_JOB_SHA256}
 from './verify-g1-release-coverage.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const QA_PIN='6b60eb45ff3244a00124a9d1a7e74c81f7e8eec9cbf957cac1bf24de7d22fa6f';
const SOURCE_PINS=Object.freeze({
 'src/v101-v2-protected-dispatcher.mjs':V101_ACCEPTED_ADAPTER_SHA256,
 'src/full-access-protected-router-bridge.mjs':'736a42de2d8429bf5285efd0de2ff9d46039a2e09d37e0b99a30080c9458a129',
 'src/full-access-http-quarantine.mjs':'b98abdc9690bfd7a8b73a94752c7dfa4d75bb074ee20a5bf0d60f75016f967bb',
 ...J01_VERIFIER_SHA256,
 'src/v2-authorized-operation.mjs':'cd3b9100667994c02f9f7d5cf7e62ffc8cc199a92e894f0f2aa7ea228834b697',
 'src/v2-caller-assertion.mjs':'a28abd8a1da1a2697e9b81790979b8841aef1212efc05bedf9aa12b0ca0241fa',
 'src/v2-direct-mtls-attestor.mjs':'f9a9ba2c883609f1698cf9f2142b74325eebd3d462ce5227b912ab326786edbd',
 'src/v2-grant-registry.mjs':'fffb2c1524f4fd9553ee70736ea008791b3d892002cdb1879e62a26b26b830ff',
 'src/v2-mcp-http-ingress.mjs':'ff85e4f553dd0f91b0ee077235c400d265515258590412679115d599ba358198',
 'src/v2-mcp-oauth-contract.mjs':'a46032aae0cc1b3f652576f36bf159a05ea551f6901d6484ea42c0c139c1884a',
 'src/v2-mcp-workflow-dispatcher.mjs':'124d85d79f2c07178ef8de93eeca8b2dcbe99b8dbe5b50c7a06c158bf8f2ef63',
 'src/v2-native-owner-session-bindings.mjs':'b945ae84d80b9c05822f7717dc1af9c50fa60c0794e8387c0a86eb4233aa7a13',
 'src/v2-oauth-caller.mjs':'4c45510a7c40fe3cd9f9eb44328fd45f5aa9e18ea7e0f9f9d09ff512b11a243f',
 'src/v2-oauth-jwks.mjs':'6e3bb0eecdc037875fac3c433e0696321ff868c2e11627cf52c3c8a7bfc6905e',
 'src/v2-oauth-provider-preflight.mjs':'694cdacc63e3754db3a1c9de039ccfe1278fbd8d8fbeb47976586131c27ca9dd',
 'src/v2-oauth-resource-metadata.mjs':'191590f8de49e6938ce17357314d256b74df3009340c6abb50c96015570938d3',
 'src/v2-openai-mtls-trust.mjs':'f3d54dd096d77301262d985e36e1e57f79d3e98c7c0deec06d29d30aa5d481db',
 'src/v2-routing-contract.mjs':'099b77147353069c69177a58e05b30cb984a485bda919f7a28980b4cf2ecb0ac',
 'src/v2-workflow-gateway.mjs':'07befb31852553c60546db57aed302bd9cb6f950755023b4a9e3b4e0134d6a7a',
 'assets/trust/openai/root-ca.pem':'3a565b5c83c83ba2de085de28733e3c6af01af9b347322b93caf3a03d42c5cbe',
 'assets/trust/openai/connectors-mtls-intermediate-ca.pem':'7485f98dfbb7db119ca99d5748ac7a86baa73ddede878d3263a50cba2c4f6dd8',
 'tools/windows-job-runner/dist/win-x64/CommanderWindowsJobRunner.exe':V102_ACCEPTED_WIN_JOB_SHA256
});
const LOCAL=new Set([
 'src/full-access-http-quarantine.mjs',
 'src/full-access-protected-router-bridge.mjs',
 'src/v101-v2-protected-dispatcher.mjs',
 'src/v101-g1-canonical-workflow-runtime.mjs',
 'src/v2-routing-contract.mjs',
 ...Object.keys(J01_VERIFIER_SHA256),
 ...Object.keys(SOURCE_PINS).filter(x=>x.startsWith('assets/')),
 'tools/windows-job-runner/release-manifest.json',
 'tools/windows-job-runner/dist/win-x64/CommanderWindowsJobRunner.exe'
]);
const FILES=Object.freeze([
 ...G1_MODULES.filter(x=>x!=='src/server-v0.3.mjs'),
 ...Object.keys(SOURCE_PINS).filter(x=>x.startsWith('assets/')),
 'tools/windows-job-runner/release-manifest.json',
 'tools/windows-job-runner/dist/win-x64/CommanderWindowsJobRunner.exe'
].filter((x,i,a)=>a.indexOf(x)===i));
const sha=b=>createHash('sha256').update(b).digest('hex');
function fail(code){throw Object.assign(new Error(code),{code});}
function readBounded(root,relative){
 const file=path.join(root,relative),st=fs.lstatSync(file);
 if(!st.isFile()||st.isSymbolicLink()||st.size<1||st.size>100*1024*1024
   ||fs.realpathSync.native(file).toLowerCase()!==path.resolve(file).toLowerCase())
   fail('V012_OVERLAY_SOURCE_INVALID:'+relative);
 return fs.readFileSync(file);
}
export function parseArgs(args){
 if(!Array.isArray(args)||args.length!==2)fail('V012_OVERLAY_ARGS_REQUIRED');
 const v={};
 for(const arg of args){
   if(typeof arg!=='string'||!arg.includes('='))fail('V012_OVERLAY_ARGS_INVALID');
   const i=arg.indexOf('='),key=arg.slice(0,i),value=arg.slice(i+1);
   if(!['--qa-root','--output'].includes(key)||!value||Object.hasOwn(v,key))
     fail('V012_OVERLAY_ARGS_INVALID');
   v[key]=value;
 }
 if(!path.isAbsolute(v['--qa-root'])||!path.isAbsolute(v['--output']))
   fail('V012_OVERLAY_ABSOLUTE_PATHS_REQUIRED');
 return {qa:path.resolve(v['--qa-root']),output:path.resolve(v['--output'])};
}
function run(program,args){
 const x=spawnSync(program,args,{cwd:ROOT,windowsHide:true,encoding:'utf8',
   stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:1024*1024});
 if(x.error||x.signal||x.status!==0)
   fail('V012_OVERLAY_VALIDATION_FAILED:'+program+':'+String(x.error?.code??x.status));
 return x.stdout.trim();
}
export function assembleV012Overlay({qa,output}){
 // The intended destination must not exist. Nothing is removed unless this call
 // created it and observed no competing writer; never overwrite a release.
 if(fs.existsSync(output))fail('V012_OVERLAY_OUTPUT_ALREADY_EXISTS');
 if(!fs.lstatSync(qa).isDirectory()||fs.lstatSync(qa).isSymbolicLink())
   fail('V012_OVERLAY_QA_ROOT_INVALID');
 const pkg=JSON.parse(readBounded(qa,'package.json').toString('utf8'));
 if(pkg.version!=='0.11.0-dev.23')fail('V012_OVERLAY_SOURCE_VERSION_UNEXPECTED');
 const inspect=run(process.execPath,[
   'tools/v1-01/run-pinned-v2-interop.mjs',
   '--candidate-root='+qa,'--minimum-version=0.11.0-dev.23','--inspect']);
 let pin;
 try{pin=JSON.parse(inspect)}catch{fail('V012_OVERLAY_QA_PIN_INVALID')}
 if(pin.sourceSha256!==QA_PIN||pin.status!=='PIN_DISCOVERY_ONLY')
   fail('V012_OVERLAY_QA_PIN_MISMATCH');
 // Strict 18-case compatibility including legacy, OAuth, transport and owner
 // denial; only source fixtures, not a live OAuth or J01 enrollment proof.
 run(process.execPath,[
   'tools/v1-01/run-pinned-v2-interop.mjs',
   '--candidate-root='+qa,'--minimum-version=0.11.0-dev.23',
   '--source-sha256='+QA_PIN]);
 run(process.execPath,['--test','test/j01-binding-v101-bridge.test.mjs',
   'test/v101-j01-webauthn-standalone.test.mjs']);
 const payload=new Map();
 for(const rel of FILES){
   const bytes=readBounded(LOCAL.has(rel)?ROOT:qa,rel);
   if(Object.hasOwn(SOURCE_PINS,rel)&&sha(bytes)!==SOURCE_PINS[rel])
      fail('V012_OVERLAY_FILE_PIN_MISMATCH:'+rel);
   payload.set(rel,bytes);
 }
 let manifest;
 try{manifest=JSON.parse(payload.get(
   'tools/windows-job-runner/release-manifest.json').toString('utf8'));}
 catch{fail('V012_OVERLAY_WIN_JOB_MANIFEST_INVALID')}
 if(manifest.runnerSha256!==V102_ACCEPTED_WIN_JOB_SHA256)
   fail('V012_OVERLAY_WIN_JOB_MANIFEST_PIN_MISMATCH');
 // Validate compatibility of each relative file before creating destination.
 const components=[...payload].map(([name,bytes])=>({
   path:name,sha256:sha(bytes),bytes:bytes.length,
   provenance:LOCAL.has(name)?'V1-01_REVIEWED_LOCAL':'V2_DEV23_PINNED_QA'
 })).sort((a,b)=>a.path.localeCompare(b.path));
 const receipt={
   schema:'COMMANDER_V012_G1_J01_SOURCE_OVERLAY_V1',
   targetRelease:'0.12.0',
   artifactKind:'NON_INSTALLABLE_SOURCE_OVERLAY',
   acceptedV2Input:'0.11.0-dev.23',
   pinnedV2SourceSha256:QA_PIN,
   acceptedV101CommitNotYetIntegrated:true,
   testedJ01Proof:'SYNTHETIC_SIGNER_ONLY',
   needsV103NativeIntegration:true,
   needsV107AuthenticatedRouter:true,
   needsV108OfficialReleaseBuilder:true,
   g1ProductionAccepted:false,j01NativeOwnerEnrolled:false,
   signedCurrentChatProved:false,realOAuthIssuerConfigured:false,
   rolloutAuthorized:false,stablePublished:false,
   payloadFiles:components
 };
 const parent=path.dirname(output);
 if(!fs.statSync(parent).isDirectory()||fs.lstatSync(parent).isSymbolicLink())
   fail('V012_OVERLAY_DESTINATION_PARENT_INVALID');
 let made=false;
 try{
   fs.mkdirSync(output,{recursive:false});made=true;
   for(const [rel,bytes] of payload){
     const target=path.join(output,rel);
     fs.mkdirSync(path.dirname(target),{recursive:true});
     fs.writeFileSync(target,bytes,{flag:'wx'});
     if(sha(readBounded(output,rel))!==sha(bytes))
       fail('V012_OVERLAY_WRITE_READBACK_MISMATCH');
   }
   fs.writeFileSync(path.join(output,'SOURCE-OVERLAY-MANIFEST.json'),
     JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
   const reread=JSON.parse(fs.readFileSync(
     path.join(output,'SOURCE-OVERLAY-MANIFEST.json'),'utf8'));
   if(reread.payloadFiles.length!==FILES.length
      ||reread.g1ProductionAccepted!==false||reread.j01NativeOwnerEnrolled!==false)
     fail('V012_OVERLAY_MANIFEST_VERIFICATION_FAILED');
   process.stdout.write('V012_G1_J01_SOURCE_OVERLAY_CREATED files='+
     FILES.length+' target=0.12.0 productionG1Accepted=false\n');
   return receipt;
 }catch(e){
   if(made)fs.rmSync(output,{recursive:true,force:true});
   throw e;
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{assembleV012Overlay(parseArgs(process.argv.slice(2)))}
 catch(error){process.stderr.write(String(error.code??error.message)+'\n');process.exitCode=1}
}
