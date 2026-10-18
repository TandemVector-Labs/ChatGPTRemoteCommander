import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read = p=>readFileSync(p,'utf8');
const js = p=>JSON.parse(read(p));
const version='0.10.23', tag='v0.10.23';
test('exact new package, runtime, desktop and both plugin manifests agree',()=>{
  assert.equal(js('package.json').version,version);
  assert.match(read('src/server-v0.3.mjs'),/const VERSION = '0\.10\.23';/);
  for(const p of ['plugin-template/plugin.json','plugin-template/.codex-plugin/plugin.json'])
    assert.equal(js(p).version,version,p);
  const cs=read('desktop/RemoteCommanderDashboard/RemoteCommanderDashboard.csproj');
  for(const token of ['<Version>0.10.23</Version>','<FileVersion>0.10.23.0</FileVersion>','<AssemblyVersion>0.10.23.0</AssemblyVersion>'])
    assert.ok(cs.includes(token),token);
});
test('new installers pin new tag and do not silently switch existing deployed stable',()=>{
  for(const p of ['install.ps1','install.sh','server-install-windows.ps1','server-install-linux.sh'])
    assert.ok(read(p).includes(tag),p);
  assert.match(read('server-install-windows.ps1'),/ServerInstaller\/0\.10\.23/);
  assert.ok(read('test/release-assets-contract.test.mjs').includes('0.10.23'));
});
test('new explicit version-scoped unsigned policy preserves warnings, denies future unapproved',()=>{
  const p=js('docs/UNSIGNED_WINDOWS_RELEASE_POLICY.json');
  assert.equal(p.version,version);
  assert.equal(p.tag,tag);
  assert.equal(p.scope,'only-this-version');
  assert.equal(p.allowUnsignedWithGitHubAttestation,true);
  assert.equal(p.publishedInstallerSignature,'NotSigned');
  assert.match(p.riskAcknowledgement,/SmartScreen/);
  const notes=read('docs/RELEASE_0.10.23.md');
  for(const word of ['Windows installer: UNSIGNED','SmartScreen','GitHub attestation','0.10.20','J01'])
    assert.ok(notes.includes(word),word);
  assert.ok(read('docs/RELEASE_0.10.21.md').includes('Core v0.10.21'),'historical provenance preserved');
  assert.ok(read('docs/RELEASE_0.10.22.md').includes('v0.10.22'),'prior tagged release provenance preserved');
  assert.match(read('tools/verify-windows-release-policy.mjs'),/policy\.version !== '0\.10\.23'/);
});
test('tagged release workflow keeps no auto-promotion, signer and immutable source gates',()=>{
  const s=read('.github/workflows/release-sync.yml');
  for(const part of ['--verify-tag','--draft','--source-ref','--source-digest','--signer-workflow','refs/tags/$tag^{commit}'])
    assert.ok(s.includes(part),part);
  assert.ok(read('test/release-assets-contract.test.mjs').includes('RELEASE_0.10.23.md'));
});
