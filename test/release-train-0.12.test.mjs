import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {parseReleaseVersion,compareReleaseVersions} from '../tools/semver-release.mjs';

const manifest=JSON.parse(readFileSync(new URL('../docs/release-train-0.12.json',import.meta.url),'utf8'));
test('0.12 development train has one valid NoPromote identity and a pinned source base',()=>{
 assert.equal(manifest.train,'0.12');
 assert.equal(manifest.firstStable,'0.12.0','0.12 is the first target operational stable baseline');
 assert.equal(manifest.majorTarget,'1.0.0','major product maturity remains a later milestone');
 assert.equal(manifest.fleetCoverage.scope,'all-known-commander1-connectors');
 assert.equal(manifest.fleetCoverage.expectedHostIds.length,8);
 assert.deepEqual(manifest.fleetCoverage.acceptedHostIds,[]);
 assert.equal(manifest.fleetCoverage.mappingVerified,false);
 assert.equal(manifest.fleetCoverage.bootLoginAndRollbackVerified,false);
 assert.equal(manifest.sourceVersion,'0.12.0-dev.9');
 assert.equal(manifest.status,'INTEGRATION_CANDIDATE_NOT_FINAL');
 assert.equal(manifest.sourceBaseSha,'40256873627780cc7b62359935e43bac5ef856b3');
 assert.equal(manifest.isStable,false);
 assert.equal(manifest.publishApproved,false);
 assert.equal(manifest.autoupdateApproved,false);
 assert.equal(manifest.installedPromotionApproved,false);
 assert.ok(manifest.components.length>=1);
 assert.ok(manifest.components.every(x=>x.required===true&&x.verified===false));
 assert.ok(Object.values(manifest.acceptance).every(x=>x===false));
 const sourceCheckout=existsSync(new URL('../.git',import.meta.url));
 const ignore=new URL('../.npmignore',import.meta.url);
 const privateOutputs=new URL('../outputs/',import.meta.url);
 if(sourceCheckout){
  assert.ok(existsSync(ignore),'Git source must retain the packaging exclusion policy');
  assert.match(readFileSync(ignore,'utf8'),/^outputs\/$/m);
 }else{
  assert.equal(existsSync(privateOutputs),false,'installed package must not carry private QA outputs');
 }
});
test('0.12.0-dev.9 advances every 0.11 release and rejects noncanonical leading zero',()=>{
 assert.equal(parseReleaseVersion('0.12.0-dev.9').revision,9n);
 for(const old of ['0.11.0-dev.105','0.11.0-dev.23','0.11.0-dev.19','0.11.0','0.11.1'])
  assert.equal(compareReleaseVersions('0.12.0-dev.9',old),1,old);
 assert.equal(compareReleaseVersions('0.12.0-dev.9','0.12.0-dev.8'),1,'dev.9 upgrades installed dev.8');
 assert.throws(()=>parseReleaseVersion('0.12.0-dev.01'),/RC_VERSION_INVALID/);
});
