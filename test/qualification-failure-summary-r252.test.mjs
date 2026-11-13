import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const helper=path.join(root,'tools/qualification-failure-summary-r252.mjs');
function fixture(t,content) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rc-r252-summary-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'qualification-output-qualification-test-abcdef123456-deadbeef.stdout.log');
 fs.writeFileSync(file,content);
 const digest=crypto.createHash('sha256').update(content).digest('hex');
 return {file,digest,exec:(given=digest)=>spawnSync(process.execPath,[helper,file,given],{encoding:'utf8',timeout:2000})};
}
test('sha-attested typed diagnostic reveals only test names, counts and codes',t=>{
 const f=fixture(t,'RC_QUAL_PHASE_START_00\nRC_QUAL_PHASE_PASS_00\nRC_QUAL_PHASE_START_01\n# Subtest: browser worker setup\nnot ok 4 - renderer wait timeout\n# fail 1\nWORKFLOW_TIMEOUT details hidden\n');
 const result=f.exec();
 assert.equal(result.status,0,result.stderr);
 assert.match(result.stdout,/R252_FAILED_TEST=renderer wait timeout/);
 assert.match(result.stdout,/R252_TAP_FAIL=1/);
 assert.match(result.stdout,/R252_LAST_SUBTEST=browser worker setup/);
 assert.match(result.stdout,/R252_FAILURE_TOKEN=WORKFLOW_TIMEOUT/);
 assert.match(result.stdout,/R252_UNFINISHED_PHASE=01/);
 assert.match(result.stdout,/R252_LAST_PHASE_PASSED=00/);
 assert.doesNotMatch(result.stdout,/details hidden/);
});
test('non TAP failure retains recent safe subtest, without exposing raw secrets',t=>{
 const f=fixture(t,'# Subtest: worker setup\nFATAL_ERROR token=abc123\n# Subtest: api-key-is-sensitive\n');
 const result=f.exec();
 assert.equal(result.status,0);
 assert.match(result.stdout,/R252_FAILURE_TOKEN=FATAL_ERROR/);
 assert.match(result.stdout,/R252_LAST_SUBTEST=\[REDACTED\]/);
 assert.doesNotMatch(result.stdout,/abc123|api-key-is-sensitive/);
});
test('changed bytes, untrusted path, symlink and empty output fail closed',t=>{
 const f=fixture(t,'# pass 4\n');
 assert.equal(f.exec('0'.repeat(64)).status,3);
 const aliasDir=path.join(path.dirname(f.file),'alias');
 fs.mkdirSync(aliasDir);
 const symlink=path.join(aliasDir,path.basename(f.file));
 try {
  fs.symlinkSync(f.file,symlink);
  assert.equal(spawnSync(process.execPath,[helper,symlink,f.digest],{encoding:'utf8'}).status,3);
 } catch(error) {
  if(!['EPERM','EACCES','ENOTSUP'].includes(error.code))throw error;
 }
 fs.writeFileSync(f.file,'');
 assert.equal(f.exec(crypto.createHash('sha256').update('').digest('hex')).status,3);
});
test('Windows isolated rollback invokes the redacted diagnostic after verified log hash',()=>{
 const source=fs.readFileSync(path.join(root,'test/release-rollback-windows-v01025.ps1'),'utf8');
 const hash=source.indexOf("Get-FileHash -LiteralPath $inner -Algorithm SHA256");
 const helper=source.indexOf("qualification-failure-summary-r252.mjs");
 assert.ok(hash>=0&&helper>hash);
 assert.ok(source.includes('R252_SUMMARY_FAILED_FAIL_CLOSED'));
});
