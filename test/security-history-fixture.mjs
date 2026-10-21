import { createHash } from 'node:crypto';

// Inert test fixture at commit 7602330, test/notion-mcp-engine.test.mjs.
// This hash is never an exception for the CURRENT source check.
export const PINNED_BEARER_HISTORY_FIXTURE = Object.freeze({
  path: 'test/notion-mcp-engine.test.mjs',
  sha256: '753fbcab19311b48b629811e9bc841272ad59190d7299d62715a105f467e22d7'
});

export function isApprovedHistoricalBearerFixture(history, index, match, evidence = PINNED_BEARER_HISTORY_FIXTURE) {
  if (typeof history !== 'string' || typeof match !== 'string' || !Number.isInteger(index) || index < 0) return false;
  const diffStart = history.lastIndexOf('\ndiff --git a/', index);
  const commitStart = history.lastIndexOf('\ncommit ', index);
  if (diffStart < 0 || diffStart < commitStart) return false;
  const end = history.indexOf('\n', diffStart + 1);
  if (end < 0) return false;
  const header = history.slice(diffStart + 1, end);
  const expected = 'diff --git a/' + evidence.path + ' b/' + evidence.path;
  if (header !== expected) return false;
  const lineStart = history.lastIndexOf('\n', index) + 1;
  if (!/^[ +-]/.test(history.slice(lineStart, index))) return false;
  return createHash('sha256').update(match, 'utf8').digest('hex') === evidence.sha256;
}

export function hasUnexpectedHistoricalBearer(history, bearerPattern, evidence = PINNED_BEARER_HISTORY_FIXTURE) {
  const flags = bearerPattern.flags.includes('g') ? bearerPattern.flags : bearerPattern.flags + 'g';
  const all = new RegExp(bearerPattern.source, flags);
  let m;
  while ((m = all.exec(history)) !== null) {
    if (!isApprovedHistoricalBearerFixture(history, m.index, m[0], evidence)) return true;
  }
  return false;
}
