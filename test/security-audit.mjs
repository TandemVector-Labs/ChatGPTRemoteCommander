import { readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
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
// Preserve complete-history streaming, including cross-line secret detection.
// One immutable Notion mock assertion may be classified per original Git commit,
// only at the exact diff path, diff kind and SHA-256 of the matched literal.
// This is a review candidate; it is NOT an owner security-policy approval.
const knownFixtureKinds = new Map([
  ['7b28ae4ffbfc3094c70647fd1ad8c4c491ba7bf5', '+'],
  ['7602330376070ca3681838e49bf7f932179a04d9', ' ']
]);
const knownFixtureSha256 = '753fbcab19311b48b629811e9bc841272ad59190d7299d62715a105f467e22d7';
const knownFixtureDiff = 'diff --git a/test/notion-mcp-engine.test.mjs b/test/notion-mcp-engine.test.mjs';
function makeHistoryScanner(rules) {
  const hits = new Set(), recognized = new Set();
  let pending = '', preceding = '', currentCommit = null, currentDiff = null;
  const limit = 16 * 1024 * 1024;
  function isExactFixture(line, match) {
    if (knownFixtureKinds.get(currentCommit) !== line[0] ||
        currentDiff !== knownFixtureDiff || recognized.has(currentCommit)) return false;
    const content = line.replace(/\r?\n$/, '');
    if (!/^[ +]\s*assert\.equal\(options\.headers\.Authorization,'Bearer\s+[A-Za-z0-9._-]{20,}'\);$/.test(content))
      return false;
    if (createHash('sha256').update(match).digest('hex') !== knownFixtureSha256) return false;
    recognized.add(currentCommit);
    return true;
  }
  function scanLine(line) {
    const commitLine = /^commit ([0-9a-f]{40})\r?\n?$/.exec(line);
    if (commitLine) { currentCommit = commitLine[1]; currentDiff = null; }
    else if (line.startsWith('diff --git ')) currentDiff = line.replace(/\r?\n$/, '');
    const sample = preceding + line;
    for (const [name, pattern] of rules) {
      const matcher = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '') + 'g');
      for (const m of sample.matchAll(matcher)) {
        // Previously fully scanned prefix matches must not be reclassified.
        if (m.index + m[0].length <= preceding.length) continue;
        // Cross-line matches are ALWAYS findings; never silently classify them.
        if (name === 'Bearer token literal' && m.index >= preceding.length &&
            isExactFixture(line, m[0])) continue;
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
      return hits;
    },
    get recognizedFixtureCount() { return recognized.size; }
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
// Adversarial probe: a different bearer value at the same spoofed path and
// historical commit identity MUST remain a finding.
const hostileProbe = makeHistoryScanner(patterns);
hostileProbe.write('commit 7b28ae4ffbfc3094c70647fd1ad8c4c491ba7bf5\\n');
hostileProbe.write(knownFixtureDiff + '\\n');
hostileProbe.write("+assert.equal(options.headers.Authorization,'Bearer " + 'Z'.repeat(30) + "');\\n");
if (!hostileProbe.finish().has('Bearer token literal') ||
    hostileProbe.recognizedFixtureCount !== 0) {
  throw new Error('SECURITY_AUDIT_EXACT_FIXTURE_FAIL_CLOSED_REGRESSION');
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
    return { hits: scanner.finish(), bytes, knownFixtures: scanner.recognizedFixtureCount };
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
console.log('SECURITY_AUDIT_HISTORY_BYTES ' + historyScan.bytes);
if (historyScan.knownFixtures) console.log('AUDIT_KNOWN_TEST_FIXTURE_SIGNATURES ' + historyScan.knownFixtures);
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
