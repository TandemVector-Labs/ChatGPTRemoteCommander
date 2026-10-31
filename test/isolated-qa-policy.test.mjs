import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {qualifyIsolatedQa} from '../tools/isolated-qa-policy.mjs';
const manifest=JSON.parse(readFileSync(new URL('../docs/release-train-0.11.json',import.meta.url),'utf8'));
test('exact dev version requires an all-false NoPromote source manifest',()=>{
 assert.equal(qualifyIsolatedQa(manifest.sourceVersion,manifest),'DEVELOPMENT_NOPROMOTE_QA');
 for(const v of ['0.11.0-dev.4','0.11.0-dev.0','0.11.0','0.11.0-rc.1','1.0.0','0.10.27'])
 assert.throws(()=>qualifyIsolatedQa(v,manifest),/RC011_QA_/);
});
test('historical version gates remain isolated QA only',()=>{
 for(const v of ['0.10.24','0.10.25','0.10.26'])assert.equal(qualifyIsolatedQa(v,null),'HISTORICAL_QA');
});
test('publication flags and false component acceptance cannot qualify',()=>{
 for(const patch of [{publishApproved:true},{autoupdateApproved:true},
  {installedPromotionApproved:true},{isStable:true},{releaseTag:'v0.11.0'},
  {channel:'stable'},{sourceVersion:'0.11.0-dev.4'},
  {components:manifest.components.map((x,i)=>i===0?{...x,verified:true}:x)},
  {acceptance:{...manifest.acceptance,rollback:true}},
  {distribution:{noPublicStableAccepted:false}}])
 assert.throws(()=>qualifyIsolatedQa(manifest.sourceVersion,{...manifest,...patch}),/RC011_QA_POLICY_DENIED/);
});
