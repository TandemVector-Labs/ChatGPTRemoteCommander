import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateWindowsRelease } from '../tools/verify-windows-release-policy.mjs';
const read=p=>readFileSync(p,'utf8');
const json=p=>JSON.parse(read(p));
const newVersion='0.10.25', previousVersion='0.10.24';
const previousTag='v0.10.24';

test('candidate source runtime and plugin identity agree without public release claims',()=>{
  assert.equal(json('package.json').version,newVersion);
  assert.match(read('src/server-v0.3.mjs'),/const VERSION = '0\.10\.25';/);
  for(const p of ['plugin-template/plugin.json','plugin-template/.codex-plugin/plugin.json'])
    assert.equal(json(p).version,newVersion,p);
  const cs=read('desktop/RemoteCommanderDashboard/RemoteCommanderDashboard.csproj');
  for(const token of ['<Version>0.10.25</Version>','<FileVersion>0.10.25.0</FileVersion>',
                       '<AssemblyVersion>0.10.25.0</AssemblyVersion>'])
    assert.ok(cs.includes(token),token);
  assert.match(read('docs/RELEASE_CANDIDATE_0.10.25.md'),/SOURCE CANDIDATE ONLY/);
});

test('installer default remains at prior verified Preview rather than untagged candidate',()=>{
  for(const p of ['install.ps1','install.sh','server-install-windows.ps1','server-install-linux.sh'])
    assert.ok(read(p).includes(previousTag),p);
  assert.ok(read('server-install-windows.ps1').includes('ServerInstaller/0.10.24'));
  assert.match(read('test/release-assets-contract.test.mjs'),/0\.10\.25/);
});

test('historical scoped unsigned Preview policy refuses v0.10.25',()=>{
  const policy=json('docs/UNSIGNED_WINDOWS_RELEASE_POLICY.json');
  assert.equal(policy.version,previousVersion);
  assert.equal(policy.tag,previousTag);
  assert.equal(policy.scope,'only-this-version');
  assert.equal(policy.stableAutoUpdateAllowed,false);
  assert.equal(policy.publishedInstallerSignature,'NotSigned');
  assert.match(policy.riskAcknowledgement,/SmartScreen/);
  const notes=read('docs/RELEASE_0.10.24.md');
  assert.throws(()=>evaluateWindowsRelease({
    signed:'false',version:newVersion,tag:'v'+newVersion,policy,releaseNotes:notes
  }),/WINDOWS_UNSIGNED_RELEASE_NOT_AUTHORIZED/);
  assert.match(read('docs/RELEASE_CANDIDATE_0.10.25.md'),/does NOT authorize unsigned v0\.10\.25/);
});

test('future tagged release workflow remains guarded and no automatic publisher promotion',()=>{
  const workflow=read('.github/workflows/release-sync.yml');
  for(const part of ['--verify-tag','--draft','--source-ref','--source-digest',
                     '--signer-workflow','refs/tags/$tag^{commit}'])
    assert.ok(workflow.includes(part),part);
  assert.ok(read('test/release-assets-contract.test.mjs').includes('RELEASE_0.10.24.md'));
  assert.ok(read('docs/RELEASE_0.10.21.md').includes('Core v0.10.21'));
});

test('current publication documents use canonical organization while keeping historical source lineage',()=>{
  const attribution=read('docs/PUBLISHER_AND_MAINTAINERS.md');
  const candidate=read('docs/RELEASE_CANDIDATE_0.10.25.md');
  for(const doc of [attribution,candidate]){
    assert.match(doc,/TandemVector-Labs\/ChatGPTRemoteCommander/);
    assert.match(doc,/Aliakbar Emadoddin/);
    assert.match(doc,/MMZ/);
  }
  assert.match(attribution,/Usefull-Skills/,'migration provenance must be preserved');
  assert.match(attribution,/v0\.10\.24 only/);
  assert.match(candidate,/SOURCE CANDIDATE ONLY/);
  assert.match(candidate,/local Commander Core `0\.10\.25` runtime/);
  assert.doesNotMatch(candidate,/NOT tagged, released, installed/);
  assert.doesNotMatch(attribution,/\*\*Distribution repository:\*\*\s*https:\/\/github\.com\/GOD13emad/);
});
