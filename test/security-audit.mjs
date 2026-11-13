import { readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import {isVerifiedSyntheticNotionBearer} from '../tools/security-audit-history.mjs';

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

// Exactly two synthetic TLS fixture literals were added in this historical commit.
// They contain a literal "\\nfixture" string, never a PEM payload. Suppress only
// these exact diff additions in this exact commit/file; any other PEM marker still fails.
const knownSyntheticTlsFixture = Object.freeze({
  commit: 'd890bd978b07aa738ceeef97bd6af2782538bac1',
  path: 'test/v2-mcp-http-ingress.test.mjs'
});
const syntheticPemHeader = '-----BEGIN ' + 'PRIVATE KEY-----';
const syntheticFixturePrefix = "+  privateKeyPem:'" + syntheticPemHeader + String.raw`\\nfixture` + "'";
const knownSyntheticFixtureLines = new Set([
  syntheticFixturePrefix + ',',
  syntheticFixturePrefix + '});'
]);
function scanSyntheticFixtureException(line, commit, path) {
  if (commit !== knownSyntheticTlsFixture.commit ||
      path !== knownSyntheticTlsFixture.path) return { line, excepted: false };
  const trimmed = line.replace(/\r?\n$/, '');
  if (!knownSyntheticFixtureLines.has(trimmed)) return { line, excepted: false };
  return { line: line.replace(syntheticPemHeader, '[SYNTHETIC_TLS_FIXTURE]'), excepted: true };
}

// Scan complete Git history without buffering the entire potentially multi-GB patch.
// Lines are bounded; anything above the bound fails closed instead of being skipped.
function makeHistoryScanner(rules) {
  const hits = new Set();
  let pending = '', preceding = '', currentCommit = '', currentPath = '', exceptions = 0;
  const limit = 16 * 1024 * 1024;
  function scanLine(line) {
    const commitMatch = /^commit ([0-9a-f]{40})\r?\n?$/.exec(line);
    if (commitMatch) { currentCommit = commitMatch[1]; currentPath = ''; }
    const pathMatch = /^diff --git a\/(.+) b\/(.+)\r?\n?$/.exec(line);
    if (pathMatch) currentPath = pathMatch[1] === pathMatch[2] ? pathMatch[1] : '';
    const filtered = scanSyntheticFixtureException(line, currentCommit, currentPath);
    if (filtered.excepted) exceptions += 1;
    const sample = preceding + filtered.line;
    for (const [name, pattern] of rules) {
      const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
      const finder = new RegExp(pattern.source, flags);
      for (const match of sample.matchAll(finder)) {
        if (isVerifiedSyntheticNotionBearer(name, match[0],
            { commit: currentCommit, file: currentPath })) continue;
        hits.add(name);
      }
    }
    preceding = sample.slice(-512);
  }
  return {
    write(text) {
      pending += text;
      for (;;) {
        const at = pending.indexOf('\n');
        if (at < 0) break;
        scanLine(pending.slice(0, at + 1));
        pending = pending.slice(at + 1);
      }
      if (pending.length > limit) throw new Error('SECURITY_AUDIT_HISTORY_LINE_TOO_LONG');
    },
    finish() {
      if (pending) { scanLine(pending); pending = ''; }
      return { hits, exceptions };
    }
  };
}
const boundaryProbe = makeHistoryScanner(patterns);
boundaryProbe.write('tunnel' + '_0123456789abcdef');
boundaryProbe.write('0123456789abcdef\nBearer \n');
boundaryProbe.write('A'.repeat(25) + '\n');
const probed = boundaryProbe.finish().hits;
if (!probed.has('Tunnel identifier') || !probed.has('Bearer token literal')) {
  throw new Error('SECURITY_AUDIT_STREAM_SCANNER_REGRESSION');
}
async function scanCompleteHistory() {
  const args = ['log', '--all', '-p', '--no-color', '--no-ext-diff'];
  const child = spawn('git', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const scanner = makeHistoryScanner(patterns);
  const decoder = new StringDecoder('utf8');
  let stderr = '', bytes = 0;
  const errors = (async () => {
    for await (const chunk of child.stderr) stderr = (stderr + chunk.toString('utf8')).slice(-4096);
  })();
  try {
    for await (const chunk of child.stdout) {
      bytes += chunk.length;
      scanner.write(decoder.write(chunk));
    }
    scanner.write(decoder.end());
    const done = await closed;
    await errors;
    if (done.code !== 0 || done.signal) {
      throw new Error('git log --all -p failed: ' + stderr.slice(-1024));
    }
    return { ...scanner.finish(), bytes };
  } catch (error) {
    if (child.exitCode === null) child.kill();
    await closed.catch(() => {});
    await errors.catch(() => {});
    throw error;
  }
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

const historyScan = await scanCompleteHistory();
for (const type of historyScan.hits) {
  findings.push({ scope: 'HISTORY', type, location: 'git log --all -p' });
}

const safeFixtureProbe = makeHistoryScanner(patterns);
safeFixtureProbe.write('commit ' + knownSyntheticTlsFixture.commit + '\n');
safeFixtureProbe.write('diff --git a/' + knownSyntheticTlsFixture.path +
  ' b/' + knownSyntheticTlsFixture.path + '\n');
for (const fixtureLine of knownSyntheticFixtureLines) safeFixtureProbe.write(fixtureLine + '\n');
const approvedFixture = safeFixtureProbe.finish();
if (approvedFixture.hits.has('Private key block') || approvedFixture.exceptions !== 2) {
  throw new Error('SECURITY_AUDIT_KNOWN_FIXTURE_REGRESSION');
}
const wrongCommitProbe = makeHistoryScanner(patterns);
wrongCommitProbe.write('commit ' + '0'.repeat(40) + '\n');
wrongCommitProbe.write('diff --git a/' + knownSyntheticTlsFixture.path +
  ' b/' + knownSyntheticTlsFixture.path + '\n');
wrongCommitProbe.write([...knownSyntheticFixtureLines][0] + '\n');
if (!wrongCommitProbe.finish().hits.has('Private key block')) {
  throw new Error('SECURITY_AUDIT_UNKNOWN_COMMIT_MUST_FAIL');
}
const realKeyProbe = makeHistoryScanner(patterns);
realKeyProbe.write('commit ' + knownSyntheticTlsFixture.commit + '\n');
realKeyProbe.write('diff --git a/' + knownSyntheticTlsFixture.path +
  ' b/' + knownSyntheticTlsFixture.path + '\n');
realKeyProbe.write('+  privateKeyPem:\'' + syntheticPemHeader + 'REAL_KEY_CONTENT' + '\n');
if (!realKeyProbe.finish().hits.has('Private key block')) {
  throw new Error('SECURITY_AUDIT_REAL_KEY_MUST_FAIL');
}

console.log('SECURITY_AUDIT_HISTORY_BYTES ' + historyScan.bytes);
console.log('SECURITY_AUDIT_EXACT_SYNTHETIC_FIXTURE_EXCEPTIONS ' + historyScan.exceptions);
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
