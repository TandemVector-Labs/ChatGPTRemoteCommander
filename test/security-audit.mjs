import { readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

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
// The source commit below contains one demonstrably synthetic bearer header in a
// Notion OAuth fixture. Preserve the committed evidence; do not rewrite published Git
// history or silence the bearer rule globally. Scope the exception to one exact byte
// sequence and one test path. Original commit is recorded only as provenance;
// shallow release clones can present the same file as a different root commit.
const FIXTURE_PATH = 'test/notion-mcp-engine.test.mjs';
const FIXTURE_ORIGIN = '7b28ae4ffbfc3094c70647fd1ad8c4c491ba7bf5';
const FIXTURE_BEARER = 'Bearer ' + 'FIXTURE_PRIVATE_ACCESS';
function scrubFixture(value) { return value.split(FIXTURE_BEARER).join('Bearer [KNOWN-SYNTHETIC-FIXTURE]'); }
const tunnelPattern = patterns.find(([type]) => type === 'Tunnel identifier')[1];
if (!tunnelPattern.test('tunnel' + '_' + '0123456789abcdef'.repeat(2)) || tunnelPattern.test('tunnel_control_plane_fresh') || tunnelPattern.test('TUNNEL_HEALTH_UNKNOWN_LISTENER')) {
  throw new Error('Tunnel identifier audit pattern regression');
}
// Scan complete Git history without buffering the entire potentially multi-GB patch.
// Lines are bounded; anything above the bound fails closed instead of being skipped.
function makeHistoryScanner(rules) {
  const hits = new Set();
  let pending = '', preceding = '', commit = null, diffPath = null;
  const limit = 16 * 1024 * 1024;
  function scanLine(line) {
    const commitMatch = /^commit ([0-9a-f]{40})/.exec(line);
    if (commitMatch) { commit = commitMatch[1]; diffPath = null; }
    const diffMatch = /^diff --git a\/(.+) b\/(.+)\r?\n?$/.exec(line);
    if (diffMatch) diffPath = diffMatch[2].trim();
    const acceptedSynthetic = diffPath === FIXTURE_PATH;
    const sample = preceding + (acceptedSynthetic ? scrubFixture(line) : line);
    for (const [name, pattern] of rules) {
      pattern.lastIndex = 0;
      if (pattern.test(sample)) hits.add(name);
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
      return hits;
    }
  };
}
const boundaryProbe = makeHistoryScanner(patterns);
boundaryProbe.write('tunnel' + '_0123456789abcdef');
boundaryProbe.write('0123456789abcdef\nBearer \n');
boundaryProbe.write('A'.repeat(25) + '\n');
const probed = boundaryProbe.finish();
if (!probed.has('Tunnel identifier') || !probed.has('Bearer token literal')) {
  throw new Error('SECURITY_AUDIT_STREAM_SCANNER_REGRESSION');
}
// Regression guard: one historical fixture is exempt, but an unrelated bearer
// (even in the same file/commit) must always be detected.
const syntheticProbe = makeHistoryScanner(patterns);
syntheticProbe.write('commit ' + FIXTURE_ORIGIN + '\n');
syntheticProbe.write('diff --git a/' + FIXTURE_PATH + ' b/' + FIXTURE_PATH + '\n');
syntheticProbe.write('+Authorization: ' + FIXTURE_BEARER + '\n');
if (syntheticProbe.finish().has('Bearer token literal')) throw new Error('SECURITY_AUDIT_SYNTHETIC_EXCEPTION_FAILED');
const strictProbe = makeHistoryScanner(patterns);
strictProbe.write('commit ' + FIXTURE_ORIGIN + '\n');
strictProbe.write('diff --git a/' + FIXTURE_PATH + ' b/' + FIXTURE_PATH + '\n');
strictProbe.write('+Authorization: Bearer ' + 'notasyntheticfixturelongtokenz12345' + '\n');
if (!strictProbe.finish().has('Bearer token literal')) throw new Error('SECURITY_AUDIT_SYNTHETIC_EXCEPTION_OVERBROAD');
// Shallow release clones reassign the introducing file diff to their shallow HEAD.
// The exact fixture remains exempt there; a different file never gets this exemption.
const shallowProbe = makeHistoryScanner(patterns);
shallowProbe.write('commit ' + 'f'.repeat(40) + '\n');
shallowProbe.write('diff --git a/' + FIXTURE_PATH + ' b/' + FIXTURE_PATH + '\n');
shallowProbe.write('+Authorization: ' + FIXTURE_BEARER + '\n');
if (shallowProbe.finish().has('Bearer token literal')) throw new Error('SECURITY_AUDIT_SHALLOW_FIXTURE_FAILED');
const foreignFileProbe = makeHistoryScanner(patterns);
foreignFileProbe.write('commit ' + FIXTURE_ORIGIN + '\n');
foreignFileProbe.write('diff --git a/src/other.mjs b/src/other.mjs\n');
foreignFileProbe.write('+Authorization: ' + FIXTURE_BEARER + '\n');
if (!foreignFileProbe.finish().has('Bearer token literal')) throw new Error('SECURITY_AUDIT_CROSS_FILE_EXCEPTION_OVERBROAD');
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
    return { hits: scanner.finish(), bytes };
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
  const content = file === FIXTURE_PATH ? scrubFixture(text) : text;
  for (const [type, pattern] of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) findings.push({ scope: 'CURRENT', type, location: file });
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
console.log('SECURITY_AUDIT_HISTORY_BYTES ' + historyScan.bytes);
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
