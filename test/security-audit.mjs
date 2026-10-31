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
// Scan complete Git history without buffering the entire potentially multi-GB patch.
// Lines are bounded; anything above the bound fails closed instead of being skipped.
function makeHistoryScanner(rules) {
  const hits = new Set();
  let pending = '', preceding = '', currentCommit = null, currentFile = null;
  const limit = 16 * 1024 * 1024;
  // Git's +/- prefix is patch metadata, not file content. Scan each side
  // independently within one file hunk, preserving a real newline boundary.
  // These cross-line findings MUST NOT use the single-line mock fixture exception.
  const bearerRule = rules.find(([type]) => type === 'Bearer token literal')?.[1];
  let hunk = false, addedTail = '', removedTail = '';
  function scanDiffSide(line) {
    if (/^commit [0-9a-f]{40}\r?\n?$/.test(line) || line.startsWith('diff --git ')) {
      hunk = false; addedTail = ''; removedTail = '';
      return;
    }
    if (line.startsWith('@@ ')) {
      hunk = true; addedTail = ''; removedTail = '';
      return;
    }
    if (!hunk || !bearerRule) return;
    const kind = line[0];
    if (kind !== '+' && kind !== '-' && kind !== ' ') {
      addedTail = ''; removedTail = '';
      return;
    }
    const content = line.slice(1).replace(/\r?\n$/, '');
    function append(previous) {
      const sample = previous ? previous + '\n' + content : content;
      const boundary = previous.length;
      const matcher = new RegExp(bearerRule.source, bearerRule.flags.replace(/[gy]/g, '') + 'g');
      for (const match of sample.matchAll(matcher)) {
        if (previous && match.index < boundary && match.index + match[0].length > boundary)
          hits.add('Bearer token literal');
      }
      return sample.slice(-512);
    }
    if (kind === '+' || kind === ' ') addedTail = append(addedTail);
    else addedTail = '';
    if (kind === '-' || kind === ' ') removedTail = append(removedTail);
    else removedTail = '';
  }
  function scanLine(line) {
    // Git emits immutable commit boundaries and per-file diff headers.
    // Keep provenance while streaming; never buffer full history or raw hits.
    const commit = /^commit ([0-9a-f]{40})(?:\r?\n|$)/.exec(line);
    if (commit) { currentCommit = commit[1]; currentFile = '(commit metadata)'; }
    const changedFile = /^diff --git a\/(.+?) b\/(.+?)\r?\n?$/.exec(line);
    if (changedFile) {
      const candidate = changedFile[2];
      currentFile = /^[a-zA-Z0-9._/-]{1,128}$/.test(candidate)
        ? candidate : '(nonstandard path)';
    }
    const sample = preceding + line;
    for (const [name, pattern] of rules) {
      const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
      const finder = new RegExp(pattern.source, flags);
      for (const match of sample.matchAll(finder)) {
        if (isVerifiedSyntheticNotionBearer(name, match[0], {commit:currentCommit,file:currentFile})) continue;
        hits.add(name);
      }
    }
    preceding = sample.slice(-512);
    scanDiffSide(line);
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
