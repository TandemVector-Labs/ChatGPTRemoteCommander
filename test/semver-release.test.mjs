import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {compareReleaseVersions,parseReleaseVersion} from '../tools/semver-release.mjs';
const cli=fileURLToPath(new URL('../tools/semver-release.mjs',import.meta.url));
test('SemVer dev/rc/stable numeric ordering and rollback',()=>{
 for(const [a,b] of [
 ['0.11.0-dev.7','0.11.0-dev.6'],['0.11.0-rc.1','0.11.0-dev.999'],
 ['0.11.0','0.11.0-rc.99'],['0.11.0-dev.7','0.10.26'],
 ['1.0.0','0.11.0'],['0.11.0-dev.15','0.11.0-dev.14'],['0.11.0-dev.14','0.11.0-dev.13'],['0.11.0-dev.13','0.11.0-dev.12'],['0.11.0-dev.12','0.11.0-dev.11'],['0.11.0-dev.11','0.11.0-dev.10'],['0.11.0-dev.10','0.11.0-dev.9']]){
  assert.equal(compareReleaseVersions(a,b),1,a);assert.equal(compareReleaseVersions(b,a),-1,b);
 }
 for(const v of ['0.11.0-dev.7','0.11.0','0.10.20'])assert.equal(compareReleaseVersions(v,v),0);
 assert.equal(parseReleaseVersion('0.11.0-dev.7').phase,'dev');
});
test('Version input fails closed for ambiguous and unsupported labels',()=>{
 for(const s of ['','v0.11.0','0.11','0.11.0-nightly.1','0.11.0-dev.0','00.1.2','1.02.3','1.2.03',
 '1.2.3-dev.01','1.2.3+metadata','1.2.3-rc','1.2.3\nx','1.2.3 '.repeat(18)]){
  assert.throws(()=>parseReleaseVersion(s),/RC_VERSION_INVALID/,s);
 }
});
test('CLI comparisons are consistent and invalid comparison exits nonzero',()=>{
 for(const [a,b,expected] of [['0.11.0-dev.7','0.10.26','gt'],
 ['0.11.0-dev.7','0.11.0-dev.7','eq'],['0.10.20','0.11.0-dev.7','lt']]){
  const x=spawnSync(process.execPath,[cli,'compare',a,b],{encoding:'utf8',timeout:7000});
  assert.equal(x.status,0);assert.equal(x.stdout.trim(),expected);
 }
 const bad=spawnSync(process.execPath,[cli,'compare','bad','0.10.20'],{encoding:'utf8',timeout:7000});
 assert.equal(bad.status,2);assert.match(bad.stderr,/RC_VERSION_COMPARE_INVALID/);
});
test('native updaters use same compare semantics without widening Stable discovery',()=>{
 const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
 const linux=read('auto-update-linux.sh'),win=read('auto-update-windows.ps1');
 assert.match(linux,/tools\/semver-release.mjs/);
 assert.match(win,/tools\\semver-release.mjs/);
 for(const v of ['AUTO_UPDATE_VERSION_COMPARE_INVALID','function Test-VersionGreater','version_gt(){'])
  assert.ok((win+linux).includes(v));
 assert.ok(win.includes("if($release.draft -or $release.prerelease)"),'stable discovery unchanged');
 assert.ok(linux.includes('^v[0-9]+\\\\.[0-9]+\\\\.[0-9]+$')||linux.includes('^v[0-9]+\\.[0-9]+\\.[0-9]+$'));
});
