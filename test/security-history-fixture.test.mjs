import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isApprovedHistoricalBearerFixture, hasUnexpectedHistoricalBearer, PINNED_BEARER_HISTORY_FIXTURE } from './security-history-fixture.mjs';

const path = 'test/notion-mcp-engine.test.mjs';
const bearer = 'Bearer ' + ['synthetic', '-fixture-', 'abcdefghijklmnopqrst'].join('');
const extraBearer = 'Bearer ' + ['other', '-fixture-', '12345678901234567890'].join('');
const evidence = { path, sha256: createHash('sha256').update(bearer).digest('hex') };
const pattern = new RegExp('Bearer\\s+' + '[A-Za-z0-9._-]{20,}', 'i');
const diff = (file, val) => ['commit ' + 'a'.repeat(40), '', 'diff --git a/' + file + ' b/' + file, '@@ -1 +1 @@', '+  assert.equal(header,' + JSON.stringify(val) + ');', ''].join('\n');

test('strict, exact synthetic historical test fixture exemption only', () => {
 const text=diff(path,bearer);
 const index=text.indexOf(bearer);
 assert.equal(isApprovedHistoricalBearerFixture(text,index,bearer,evidence),true);
 assert.equal(hasUnexpectedHistoricalBearer(text,pattern,evidence),false);
 assert.equal(hasUnexpectedHistoricalBearer(text,pattern),true);
 assert.equal(PINNED_BEARER_HISTORY_FIXTURE.sha256.length,64);
});
test('reject other locations, same token outside approved test diff', () => {
 assert.equal(hasUnexpectedHistoricalBearer(diff('src/service.mjs',bearer),pattern,evidence),true);
});
test('reject another token in the same file even with approved token present', () => {
 assert.equal(hasUnexpectedHistoricalBearer(diff(path,bearer)+diff(path,extraBearer),pattern,evidence),true);
});
test('reject spoofed headers and cross-commit metadata', () => {
 const text='commit ' + 'a'.repeat(40) + '\n' + 'diff --git a/' + path + ' b/' + path + '\n' + 'commit ' + 'b'.repeat(40) + '\n+ '+bearer;
 assert.equal(hasUnexpectedHistoricalBearer(text,pattern,evidence),true);
});
test('the unmodified CURRENT pattern still flags a Bearer literal', () => {
 assert.equal(pattern.test(bearer),true);
});
