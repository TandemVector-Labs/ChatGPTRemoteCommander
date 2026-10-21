import test from 'node:test';
import assert from 'node:assert/strict';
import {historyMatchProvenance,isVerifiedSyntheticNotionBearer} from '../tools/security-audit-history.mjs';

const commit='7b28ae4ffbfc3094c70647fd1ad8c4c491ba7bf5';
const file='test/notion-mcp-engine.test.mjs';
const synthetic='Bearer '+'FIXTURE_PRIVATE_ACCESS';
const history='commit '+commit+'\nAuthor: fixture-only\n' +
  'diff --git a/'+file+' b/'+file+'\n' +
  '+assert.equal(mock.Authorization,'+JSON.stringify(synthetic)+');\n';

test('audit permits only the exact known historical fake-vault OAuth assertion',()=>{
  const offset=history.indexOf(synthetic);
  assert.ok(offset>0);
  const provenance=historyMatchProvenance(history,offset);
  assert.deepEqual(provenance,{commit,file});
  assert.equal(isVerifiedSyntheticNotionBearer('Bearer token literal',synthetic,provenance),true);
  assert.equal(isVerifiedSyntheticNotionBearer('Bearer token literal',synthetic,{commit,file:'src/notion-mcp-engine.mjs'}),false);
  assert.equal(isVerifiedSyntheticNotionBearer('Bearer token literal',synthetic,{commit:'0'.repeat(40),file}),false);
  assert.equal(isVerifiedSyntheticNotionBearer('Bearer token literal','Bearer '+'REAL_TOKEN_1234567890123456',provenance),false);
  assert.equal(isVerifiedSyntheticNotionBearer('GitHub token',synthetic,provenance),false);
});
test('historical provenance never promotes a commit-message match to a changed file',()=>{
  const source='commit '+commit+'\n    '+synthetic+'\n';
  const index=source.indexOf(synthetic);
  assert.equal(historyMatchProvenance(source,index).file,'(commit metadata)');
  assert.equal(isVerifiedSyntheticNotionBearer('Bearer token literal',synthetic,historyMatchProvenance(source,index)),false);
});
test('reject malformed provenance offsets',()=>{
  assert.throws(()=>historyMatchProvenance('',-1),/HISTORY_PROVENANCE_INPUT_INVALID/);
  assert.throws(()=>historyMatchProvenance('',5),/HISTORY_PROVENANCE_INPUT_INVALID/);
});
