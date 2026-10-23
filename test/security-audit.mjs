import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

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

const history = git(['log', '--all', '-p', '--no-color', '--no-ext-diff']);
for (const [index, [type, pattern]] of patterns.entries()) {
  pattern.lastIndex = 0;
  const match = pattern.exec(history);
  if (match) findings.push({
    scope: 'HISTORY', type, ruleId: 'H' + String(index + 1).padStart(2, '0'),
    location: 'git log --all -p', provenance: historyProvenance(history, match)
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
