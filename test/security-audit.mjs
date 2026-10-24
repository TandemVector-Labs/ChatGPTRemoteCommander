import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

function git(args, options = {}) {
  const result = spawnSync('git', args, {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout;
}

const patterns = [
  ['OpenAI-style secret key', new RegExp('s' + 'k-' + '[A-Za-z0-9_-]{20,}', 'i')],
  ['Tunnel identifier', new RegExp('tunnel' + '_' + '[0-9a-f]{32}')],
  ['Private key block', new RegExp('-----BEGIN ' + '(?:RSA |EC |OPENSSH )?' + 'PRIVATE KEY-----', 'i')],
  ['Bearer token literal', new RegExp('Bearer\\s+' + '[A-Za-z0-9._-]{20,}', 'i')],
  ['GitHub token', new RegExp('gh' + '[pousr]_' + '[A-Za-z0-9]{20,}', 'i')],
  ['Developer Windows path', /C:\\Users\\[^\\\r\n]+\\source\\repos\\ChatGPTRemoteCommander/i]
];
const tunnelPattern = patterns.find(([type]) => type === 'Tunnel identifier')[1];
if (!tunnelPattern.test('tunnel' + '_' + '0123456789abcdef'.repeat(2)) || tunnelPattern.test('tunnel_control_plane_fresh') || tunnelPattern.test('TUNNEL_HEALTH_UNKNOWN_LISTENER')) {
  throw new Error('Tunnel identifier audit pattern regression');
}
const findings = [];
const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
for (const file of tracked) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch { continue; }
  for (const [type, pattern] of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push({ scope: 'CURRENT', type, location: file });
  }
}

for (const forbidden of ['config.local.json', '.env', 'connections.local.json']) {
  if (tracked.includes(forbidden)) findings.push({ scope: 'CURRENT', type: 'Forbidden tracked file', location: forbidden });
}
for (const expectedIgnored of ['config.local.json', '.env', 'connections.local.json', 'credentials/example.dpapi', 'downloads/example.zip']) {
  const ignored = spawnSync('git', ['check-ignore', '-q', '--', expectedIgnored]);
  if (ignored.status !== 0) findings.push({ scope: 'CURRENT', type: 'Expected ignore missing', location: expectedIgnored });
}

// Report only provenance. Never print matching bytes, context, raw paths or tokens.
// The existing regexes and fail-closed HISTORY admission remain unchanged.
function historyProvenance(history, match) {
  const index = match.index;
  const lineStart = history.lastIndexOf('\n', index) + 1;
  const linePrefix = history.slice(lineStart, index + 1);
  const kind = linePrefix.startsWith('+') ? 'added' :
    linePrefix.startsWith('-') ? 'removed' : 'context-or-metadata';
  const blockStart = history.lastIndexOf('\ncommit ', index);
  const commitStart = blockStart >= 0 ? blockStart + 1 :
    (history.startsWith('commit ') ? 0 : -1);
  const commit = commitStart >= 0 ?
    /^commit ([0-9a-f]{40})\b/.exec(history.slice(commitStart, commitStart + 55))?.[1] ?? null : null;
  return { commit, kind, acrossLines: /\r?\n/.test(match[0]) };
}

// Exact negative-adjudication of a *historical test assertion*, not a pattern waiver.
// Restrict by original immutable commits, diff path, line kind/shape and SHA-256
// of the complete fixed test literal. Any changed or newly introduced bearer
// still fails. The recognized fixture is never printed.
const knownFixtureKinds = new Map([
  ['7b28ae4ffbfc3094c70647fd1ad8c4c491ba7bf5', 'added'],
  ['7602330376070ca3681838e49bf7f932179a04d9', 'context-or-metadata']
]);
const knownFixtureSha256='753fbcab19311b48b629811e9bc841272ad59190d7299d62715a105f467e22d7';
function isExactHistoricalNotionTestFixture(history, match, provenance) {
  if (provenance.acrossLines || knownFixtureKinds.get(provenance.commit)!==provenance.kind) return false;
  const commitStart=history.lastIndexOf('\ncommit ',match.index);
  const diffStart=history.lastIndexOf('\ndiff --git ',match.index);
  if (diffStart<=commitStart) return false;
  const diffLineEnd=history.indexOf('\n',diffStart+1);
  if (diffLineEnd<0 || history.slice(diffStart+1,diffLineEnd)!==
    'diff --git a/test/notion-mcp-engine.test.mjs b/test/notion-mcp-engine.test.mjs') return false;
  const lineStart=history.lastIndexOf('\n',match.index)+1;
  const lineEnd=history.indexOf('\n',match.index);
  const line=history.slice(lineStart,lineEnd<0?history.length:lineEnd);
  if (!/^[ +]\s*assert\.equal\(options\.headers\.Authorization,'Bearer\s+[A-Za-z0-9._-]{20,}'\);$/.test(line)) return false;
  return createHash('sha256').update(match[0]).digest('hex')===knownFixtureSha256;
}
const history = git(['log', '--all', '-p', '--no-color', '--no-ext-diff']);
for (const [index, [type, pattern]] of patterns.entries()) {
  // Preserve the existing detection and fail-closed outcome. Count additional
  // matches so an early synthetic fixture cannot mask later historical secrets.
  // Bound metadata reporting and traversal to avoid exposing matching bytes or
  // allowing an adversarial history to exhaust the audit runner.
  const globalPattern = new RegExp(pattern.source, pattern.flags.replace(/g/g, '') + 'g');
  const samples = [];
  const seen = new Set(), acceptedFixtureCommits = new Set();
  let matchCount = 0, moreThanLimit = false;
  for (const match of history.matchAll(globalPattern)) {
    const p = historyProvenance(history, match);
    if (type === 'Bearer token literal' &&
        isExactHistoricalNotionTestFixture(history,match,p) &&
        !acceptedFixtureCommits.has(p.commit)) {
      acceptedFixtureCommits.add(p.commit);
      continue;
    }
    if (++matchCount > 10000) { moreThanLimit = true; break; }
    if (samples.length < 8) {
      const signature = [p.commit, p.kind, p.acrossLines].join(':');
      if (!seen.has(signature)) { seen.add(signature); samples.push(p); }
    }
  }
  if (acceptedFixtureCommits.size)
    console.log('AUDIT_KNOWN_TEST_FIXTURE_SIGNATURES '+acceptedFixtureCommits.size);
  if (matchCount) findings.push({
    scope: 'HISTORY', type, ruleId: 'H' + String(index + 1).padStart(2, '0'),
    location: 'git log --all -p', provenance: samples[0] || null,
    matchCount: moreThanLimit ? null : matchCount,
    moreThanLimit, otherProvenance: samples.slice(1)
  });
}
const emails = [...new Set(git(['log', '--all', '--format=%ae%n%ce']).split(/\r?\n/).filter(Boolean))].sort();
if (emails.length) {
  console.log('COMMIT_EMAILS (public metadata, not credentials):');
  for (const email of emails) console.log(`  ${email}`);
}

if (findings.length) {
  console.error('SECURITY_AUDIT_FAIL');
  for (const finding of findings) console.error(JSON.stringify(finding));
  process.exit(1);
}
console.log('SECURITY_AUDIT_PASS');
console.log('No secret-key, tunnel-id, private-key, bearer-token, GitHub-token, tracked local-config, or developer-path finding detected.');
