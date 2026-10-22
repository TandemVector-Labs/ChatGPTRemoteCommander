import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {evaluateWindowsRelease} from '../tools/verify-windows-release-policy.mjs';

const policy=JSON.parse(readFileSync('docs/UNSIGNED_WINDOWS_RELEASE_POLICY.json','utf8'));
const releaseNotes=readFileSync('docs/RELEASE_0.10.24.md','utf8');
const credits=readFileSync('docs/PUBLISHER_AND_MAINTAINERS.md','utf8');
const example={signed:'false',version:'0.10.24',tag:'v0.10.24',policy,releaseNotes};

test('specific owner approves v0.10.24 unsigned public preview with provenance only',()=>{
 assert.equal(policy.version,'0.10.24');
 assert.equal(policy.tag,'v0.10.24');
 assert.equal(policy.scope,'only-this-version');
 assert.equal(policy.allowUnsignedWithGitHubAttestation,true);
 assert.equal(policy.releaseChannel,'public-prerelease-not-stable');
 assert.equal(policy.stableAutoUpdateAllowed,false);
 assert.match(policy.riskAcknowledgement,/SmartScreen/);
 assert.match(policy.riskAcknowledgement,/do not replace Authenticode/);
 const status=evaluateWindowsRelease(example);
 assert.equal(status.allowed,true);
 assert.equal(status.mode,'UNSIGNED_WITH_REQUIRED_SIGSTORE_PROVENANCE');
});

test('a valid signed same-version installer still qualifies independently',()=>{
 const x=evaluateWindowsRelease({...example,signed:'true'});
 assert.equal(x.allowed,true);
 assert.equal(x.mode,'AUTHENTICODE_SIGNED');
});

test('future and historical unsigned versions require new approval',()=>{
 for(const version of ['0.10.25','0.10.23']){
  assert.throws(()=>evaluateWindowsRelease({...example,version,tag:'v'+version}),/WINDOWS_UNSIGNED_RELEASE_NOT_AUTHORIZED/);
 }
});

test('unexpected signing status fails closed rather than guessing',()=>{
 for(const signed of ['','unknown','NotSigned','True','FALSE'])
  assert.throws(()=>evaluateWindowsRelease({...example,signed}),/WINDOWS_RELEASE_SIGNATURE_STATUS_UNVERIFIED/);
});

test('expanded policy, wrong source evidence and mismatched tag fail closed',()=>{
 assert.throws(()=>evaluateWindowsRelease({...example,tag:'v0.10.20'}),/WINDOWS_RELEASE_TAG_VERSION_MISMATCH/);
 for(const change of [
  {scope:'all-versions'},
  {allowUnsignedWithGitHubAttestation:false},
  {publishedInstallerSignature:'Valid'},
  {verification:''},
  {riskAcknowledgement:''},
  {tag:'v0.10.25'},
  {version:'0.10.25'}
 ]){
  assert.throws(()=>evaluateWindowsRelease({...example,policy:{...policy,...change}}),/WINDOWS_UNSIGNED_RELEASE_NOT_AUTHORIZED/);
 }
});

test('public company and release disclosure are unambiguous without false OS publisher promise',()=>{
 for(const keyword of ['Windows installer: UNSIGNED','Unknown publisher','SmartScreen','GitHub attestation',
  'v0.10.20','J01','TandemVector Labs','Aliakbar Emadoddin','mohammadmohammadzadeh19960-code','prerelease'])
  assert.ok(releaseNotes.includes(keyword),keyword);
 assert.match(credits,/not evidence of independently verified legal incorporation/);
 assert.ok(credits.includes('does NOT authorize unsigned **v0.10.25**'));
 assert.match(credits,/not substitutes for Authenticode/);
});

test('company branding in package and Windows installer is project metadata only',()=>{
 const pkg=JSON.parse(readFileSync('package.json','utf8'));
 const inno=readFileSync('installer/RemoteCommander.iss','utf8');
 const csproj=readFileSync('desktop/RemoteCommanderDashboard/RemoteCommanderDashboard.csproj','utf8');
 const installer=readFileSync('desktop/install-windows.ps1','utf8');
 assert.equal(pkg.author,'Aliakbar Emadoddin (GOD13emad)');
 assert.deepEqual(pkg.contributors,['MMZ (mohammadmohammadzadeh19960-code)']);
 assert.match(pkg.publisherBrand,/TandemVector Labs/);
 assert.match(inno,/AppPublisher=TandemVector Labs/);
 assert.match(csproj,/<Company>TandemVector Labs<\/Company>/);
 assert.match(csproj,/<Authors>Aliakbar Emadoddin;MMZ<\/Authors>/);
 assert.match(installer,/-Name Publisher -Value 'TandemVector Labs'/);
 assert.match(releaseNotes,/do not replace Authenticode/);
});

test('native release verifier admits this exact unsigned version and disallows a future one',()=>{
 const base={...process.env,RELEASE_VERSION:'0.10.24',RELEASE_TAG:'v0.10.24'};
 const unsigned=spawnSync(process.execPath,['tools/verify-windows-release-policy.mjs'],{
  encoding:'utf8',env:{...base,SETUP_SIGNED:'false'}});
 assert.equal(unsigned.status,0,unsigned.stderr);
 assert.match(unsigned.stdout,/UNSIGNED_WITH_REQUIRED_SIGSTORE_PROVENANCE/);
 const signed=spawnSync(process.execPath,['tools/verify-windows-release-policy.mjs'],{
  encoding:'utf8',env:{...base,SETUP_SIGNED:'true'}});
 assert.equal(signed.status,0,signed.stderr);
 assert.match(signed.stdout,/AUTHENTICODE_SIGNED/);
 const future=spawnSync(process.execPath,['tools/verify-windows-release-policy.mjs'],{
  encoding:'utf8',env:{...base,RELEASE_VERSION:'0.10.25',RELEASE_TAG:'v0.10.25',SETUP_SIGNED:'false'}});
 assert.notEqual(future.status,0);
});

test('CLI rejects hostile version before any release-policy file access',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const cwd=mkdtempSync(join(tmpdir(),'release-policy-version-validation-'));
 try {
  const {fileURLToPath}=await import('node:url');
 const cli=fileURLToPath(new URL('../tools/verify-windows-release-policy.mjs',import.meta.url));
  for(const version of ['../../outside','0.10.23\n','0.10.23/../../outside','0.10.23\u2028','', '0.10.23.1']) {
   const out=spawnSync(process.execPath,[cli],{
    cwd,encoding:'utf8',
    env:{...process.env,SETUP_SIGNED:'false',RELEASE_VERSION:version,RELEASE_TAG:'v'+version}
   });
   assert.notEqual(out.status,0,version);
   assert.match(out.stderr,/WINDOWS_RELEASE_TAG_VERSION_MISMATCH/,version);
   assert.doesNotMatch(out.stderr,/ENOENT|EACCES/,version);
  }
  const approvedVersion=JSON.parse(readFileSync(new URL('../docs/UNSIGNED_WINDOWS_RELEASE_POLICY.json',import.meta.url),'utf8')).version;
  const valid=spawnSync(process.execPath,[cli],{
   cwd,encoding:'utf8',
   env:{...process.env,SETUP_SIGNED:'false',RELEASE_VERSION:approvedVersion,RELEASE_TAG:'v'+approvedVersion}
  });
  assert.equal(valid.status,0,valid.stderr);
  assert.match(valid.stdout,/UNSIGNED_WITH_REQUIRED_SIGSTORE_PROVENANCE/);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});

test('signed future builds need no dynamically selected release-notes file, unsigned future fails closed',async()=>{
 const cli=(await import('node:url')).fileURLToPath(new URL('../tools/verify-windows-release-policy.mjs',import.meta.url));
 const future={...process.env,RELEASE_VERSION:'99.99.99',RELEASE_TAG:'v99.99.99'};
 const signed=spawnSync(process.execPath,[cli],{encoding:'utf8',env:{...future,SETUP_SIGNED:'true'}});
 assert.equal(signed.status,0,signed.stderr);
 assert.match(signed.stdout,/AUTHENTICODE_SIGNED/);
 const unsigned=spawnSync(process.execPath,[cli],{encoding:'utf8',env:{...future,SETUP_SIGNED:'false'}});
 assert.notEqual(unsigned.status,0);
 assert.match(unsigned.stderr,/WINDOWS_UNSIGNED_RELEASE_NOT_AUTHORIZED/);
 assert.doesNotMatch(unsigned.stderr,/ENOENT|EACCES/);
});