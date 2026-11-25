import { readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import {isVerifiedSyntheticNotionBearer} from '../tools/security-audit-history.mjs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repoRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
function git(args, options = {}) {
  const result = spawnSync('git', ['-c',`safe.directory=${repoRoot}`,'-C',repoRoot,...args], {
    cwd:repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout;
}

const patterns = [
  // Match a standalone key prefix, never the trailing "sk-" inside identifiers
  // such as "task-" in historical file paths and Microsoft API identifiers.
  // A genuine key after whitespace, quotes, colon or '=' is still detected.
  ['OpenAI-style secret key', new RegExp('(?<![A-Za-z0-9])' + 's' + 'k-' + '[A-Za-z0-9_-]{20,}', 'i')],
  ['Tunnel identifier', new RegExp('tunnel' + '_' + '[0-9a-f]{32}')],
  ['Private key block', new RegExp('-----BEGIN ' + '(RSA |EC |OPENSSH |DSA |ENCRYPTED )?' + 'PRIVATE KEY-----\\r?\\n' + '(?:(?:Proc-Type:|DEK-Info:)[^\\r\\n]*\\r?\\n)*' + '(?:[A-Za-z0-9+/=]{8,}\\r?\\n){2,}' + '-----END \\1PRIVATE KEY-----', 'im')],
  ['Bearer token literal', new RegExp('Bearer\\s+' + '[A-Za-z0-9._-]{20,}', 'i')],
  ['GitHub token', new RegExp('gh' + '[pousr]_' + '[A-Za-z0-9]{20,}', 'i')],
  ['Developer Windows path', /C:\\Users\\[^\\\r\n]+\\source\\repos\\ChatGPTRemoteCommander/i]
];

// Reject every real private-key marker, except this precisely known V2 test
// placeholder (a JavaScript string containing the literal backslash-n and
// the word "fixture"; it is not a PEM or a credential). This exception applies
// to individual marker occurrences, including those in git history. It must
// never suppress a separate PEM marker anywhere in the same file or commit.
const mockPemHeader = '-----BEGIN ' + 'PRIVATE KEY-----';
const mockPemLiteral = mockPemHeader + String.raw`\\nfixture`;
const mockPemCodeLiteral = 'pkcs8.indexOf("' + mockPemHeader + '")';
// Exact synthetic OAuth fixture from the historical V2 QA test; no other bearer is exempt.
// Exact synthetic bearer-shaped fixtures in historical QA tests; all other
// bearer values remain detectable, including one-character near-matches.
// Only historical QA's fixed synthetic tunnel label is exempt. Its
// exact bytes were committed in an isolated doctor fixture and are not
// a live tunnel ID. All other 32-hex tunnel IDs remain audit findings.
// Preserve committed history; never rewrite it to silence a scanner.
const knownSyntheticTunnelLabel='tunnel'+'_'+'0123456789abcdef'.repeat(2);
const syntheticTunnelPattern=new RegExp(knownSyntheticTunnelLabel+'(?![0-9a-f])','g');
const mockBearerLiterals = [
  'Bearer ' + 'verified-test-bearer',
  'Bearer ' + 'dummy-super-secret-12345',
  // Historical G1 negative-login probe only: commit 47e2494f (tools/v1-01/installed-g1-readonly-probe.mjs).
  // This fixed noncredential value is deliberately rejected by the test Host.
  'Bearer ' + 'deliberately-invalid-g1-probe',
];
const mockBearerLiteralPatterns = mockBearerLiterals.map(literal=>new RegExp(literal+'(?![A-Za-z0-9._-])','g'));
function secretPatternMatches(type,pattern,text) {
  let sample=text;
  if(type==='Private key block')
    sample=sample.replaceAll(mockPemLiteral,'[MOCK_V2_TLS_KEY_PLACEHOLDER]');
  if(type==='Private key block')
    sample=sample.replaceAll(mockPemCodeLiteral,'[PKCS8_HEADER_PARSER]');
  if(type==='Tunnel identifier'){
    syntheticTunnelPattern.lastIndex=0;
    sample=sample.replace(syntheticTunnelPattern,'[NONPRODUCTION_TUNNEL_FIXTURE]');
  }
  if(type==='Bearer token literal') {
    for(const fixturePattern of mockBearerLiteralPatterns) {
      fixturePattern.lastIndex=0;
      sample=sample.replace(fixturePattern,'[SYNTHETIC_BEARER_TEST_FIXTURE]');
    }
  }
  pattern.lastIndex=0;
  return pattern.test(sample);
}
const openAiPattern=patterns.find(([type])=>type==='OpenAI-style secret key')[1];
const syntheticOpenAiKey='s'+'k-'+'A'.repeat(32);
for(const context of [
  syntheticOpenAiKey, 'Authorization: Bearer '+syntheticOpenAiKey,
  'token="'+syntheticOpenAiKey+'"', 'key='+syntheticOpenAiKey,
  '('+syntheticOpenAiKey+')'
]){
  if(!secretPatternMatches('OpenAI-style secret key',openAiPattern,context))
    throw new Error('SECURITY_AUDIT_KEY_BOUNDARY_POSITIVE_CONTROL_FAILED');
}
for(const context of [
  'ta'+syntheticOpenAiKey,
  'registeredta'+syntheticOpenAiKey,
  'x'+syntheticOpenAiKey,
  'service_task-'+('A'.repeat(26))
]){
  if(secretPatternMatches('OpenAI-style secret key',openAiPattern,context))
    throw new Error('SECURITY_AUDIT_KEY_BOUNDARY_FALSE_POSITIVE');
}
const pemHeaderPattern=patterns.find(([type])=>type==='Private key block')[1];
const pemNewline=String.fromCharCode(10);
const pemBody=[
  'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=',
  'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo='
];
function syntheticPem(label,footerLabel=label,body=pemBody,lineEnding=pemNewline){
  return '-----BEGIN '+label+'PRIVATE KEY-----'+lineEnding+
    body.join(lineEnding)+lineEnding+
    '-----END '+footerLabel+'PRIVATE KEY-----';
}
// Six real PEM label families, including the previously missed DSA and encrypted forms.
for(const label of ['', 'RSA ', 'EC ', 'OPENSSH ', 'DSA ', 'ENCRYPTED ']){
  pemHeaderPattern.lastIndex=0;
  if(!pemHeaderPattern.test(syntheticPem(label)))
    throw new Error('SECURITY_AUDIT_CURRENT_TREE_PEM_POSITIVE_CONTROL_FAILED:'+(label||'PRIVATE'));
}
const pemNegativeControls=[
  '-----BEGIN '+'PRIVATE KEY-----',
  syntheticPem('', 'RSA '),
  syntheticPem('', '', ['!!!!!!!!!!','!!!!!!!!!!'])
];
for(let i=0;i<pemNegativeControls.length;i++){
  pemHeaderPattern.lastIndex=0;
  if(pemHeaderPattern.test(pemNegativeControls[i]))
    throw new Error('SECURITY_AUDIT_CURRENT_TREE_PEM_NEGATIVE_CONTROL_FAILED:'+i);
}
if(secretPatternMatches('Private key block',pemHeaderPattern,mockPemLiteral)
  ||secretPatternMatches('Private key block',pemHeaderPattern,mockPemCodeLiteral)
  ||!secretPatternMatches('Private key block',pemHeaderPattern,mockPemLiteral+' '+syntheticPem('ENCRYPTED ')))
  throw new Error('SECURITY_AUDIT_PEM_FIXTURE_EXCEPTION_REGRESSION');
pemHeaderPattern.lastIndex=0;
if(!pemHeaderPattern.test(syntheticPem('OPENSSH ','OPENSSH ',pemBody,'\r\n')))
  throw new Error('SECURITY_AUDIT_CURRENT_TREE_PEM_CRLF_CONTROL_FAILED');
const bearerPattern=patterns.find(([type])=>type==='Bearer token literal')[1];
if(mockBearerLiterals.some(literal=>secretPatternMatches('Bearer token literal',bearerPattern,literal))
  ||!secretPatternMatches('Bearer token literal',bearerPattern,'Bearer '+'A'.repeat(20))
  ||mockBearerLiterals.some(literal=>!secretPatternMatches('Bearer token literal',bearerPattern,literal+'x')))
  throw new Error('Bearer pattern exception regression');

const tunnelPattern = patterns.find(([type]) => type === 'Tunnel identifier')[1];
if (!tunnelPattern.test('tunnel' + '_' + '0123456789abcdef'.repeat(2)) || tunnelPattern.test('tunnel_control_plane_fresh') || tunnelPattern.test('TUNNEL_HEALTH_UNKNOWN_LISTENER')) {
  // Pure matcher control, before the sole known QA fixture exception.

  throw new Error('Tunnel identifier audit pattern regression');
}
if(secretPatternMatches('Tunnel identifier',tunnelPattern,knownSyntheticTunnelLabel)
  ||!secretPatternMatches('Tunnel identifier',tunnelPattern,knownSyntheticTunnelLabel+'a')
  ||!secretPatternMatches('Tunnel identifier',tunnelPattern,
      'tunnel'+'_'+'f'.repeat(32))
  ||!secretPatternMatches('Tunnel identifier',tunnelPattern,
      knownSyntheticTunnelLabel+' '+('tunnel'+'_'+'e'.repeat(32))))
  throw new Error('SECURITY_AUDIT_SYNTHETIC_TUNNEL_EXCEPTION_REGRESSION');

// Scan complete Git history without buffering the entire potentially multi-GB patch.
// Lines are bounded; anything above the bound fails closed instead of being skipped.
function makeHistoryScanner(rules) {
  const hits = new Set();
  let pending = '', preceding = '';
  let currentCommit = '', currentPath = '';
  let parentPem = null, currentPem = null;
  const limit = 16 * 1024 * 1024;
  function advancePem(state, content) {
    const header=content.match(/^-----BEGIN (RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----$/i);
    if(header){state.active={label:header[1]??'',bodyChars:0};return;}
    if(!state.active)return;
    const footer=content.match(/^-----END (RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----$/i);
    if(footer){
      if((footer[1]??'')===state.active.label&&state.active.bodyChars>=32)
        hits.add('Private key block');
      state.active=null;return;
    }
    if(/^[A-Za-z0-9+/=]{8,}$/.test(content)){state.active.bodyChars+=content.length;return;}
    if(state.active.bodyChars===0&&/^(?:Proc-Type:|DEK-Info:)/i.test(content))return;
    state.active=null;
  }
  function resetPem(){parentPem={active:null};currentPem={active:null};}
  resetPem();
  function scanLine(line) {
    // Track exact history origin so the sole historical Notion test bearer
    // cannot mask a secret in any other file or commit.
    const commit=/^commit ([0-9a-f]{40})(?:\r?\n|$)/.exec(line);
    if(commit){currentCommit=commit[1];currentPath='';preceding='';resetPem();return;}
    const patch=/^diff --git a\/(.+?) b\/(.+?)(?:\r?\n|$)/.exec(line);
    if(patch){
      currentPath=patch[1]===patch[2]?patch[1]:'';
      preceding='';resetPem();return;
    }
    if(/^diff --(?:cc|combined) /.test(line))currentPath='';
    if(/^(?:diff --(?:cc|combined) |@@)/.test(line)){
      preceding='';resetPem();return;
    }
    const raw=line.trimEnd();
    const side=raw[0],content=raw.slice(1).trim();
    if(side===' '){
      advancePem(parentPem,content);
      advancePem(currentPem,content);
    }else if(side==='+'){
      parentPem.active=null;
      advancePem(currentPem,content);
    }else if(side==='-'){
      currentPem.active=null;
      advancePem(parentPem,content);
    }else{
      resetPem();
    }
    const sample=preceding+line;
    for(const [name,pattern] of rules){
      if(name==='Private key block')continue;
      if(name==='Bearer token literal'){
        const flags=pattern.flags.includes('g')?pattern.flags:pattern.flags+'g';
        const finder=new RegExp(pattern.source,flags);
        for(const match of sample.matchAll(finder)){
          if(isVerifiedSyntheticNotionBearer(name,match[0],
              {commit:currentCommit,file:currentPath}))continue;
          if(secretPatternMatches(name,pattern,match[0]))hits.add(name);
        }
      }else if(secretPatternMatches(name,pattern,sample))hits.add(name);
    }
    preceding=sample.slice(-512);
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
const syntheticNotionHistoryProbe=(commit,path,literal)=>{
  const scanner=makeHistoryScanner(patterns);
  scanner.write('commit '+commit+'\n');
  scanner.write('diff --git a/'+path+' b/'+path+'\n');
  scanner.write('+Authorization: '+literal+'\n');
  return scanner.finish();
};
const fakeNotionBearer='Bearer '+'FIXTURE_PRIVATE_ACCESS';
const verifiedNotionFile='test/notion-mcp-engine.test.mjs';
const validFixtureCommit='7b28ae4ffbfc3094c70647fd1ad8c4c491ba7bf5';
if(syntheticNotionHistoryProbe(validFixtureCommit,verifiedNotionFile,fakeNotionBearer).has('Bearer token literal')
  ||!syntheticNotionHistoryProbe('0'.repeat(40),verifiedNotionFile,fakeNotionBearer).has('Bearer token literal')
  ||!syntheticNotionHistoryProbe(validFixtureCommit,'src/notion-mcp-engine.mjs',fakeNotionBearer).has('Bearer token literal')
  ||!syntheticNotionHistoryProbe(validFixtureCommit,verifiedNotionFile,'Bearer '+'A'.repeat(30)).has('Bearer token literal'))
  throw new Error('SECURITY_AUDIT_NOTION_EXACT_PROVENANCE_REGRESSION');

const markerOnlyProbe=makeHistoryScanner(patterns);
markerOnlyProbe.write('commit '+'f'.repeat(40)+'\n');
markerOnlyProbe.write('diff --git a/vendor/parser.mjs b/vendor/parser.mjs\n');
markerOnlyProbe.write("+const marker = '"+mockPemHeader+"';\n");
if(markerOnlyProbe.finish().has('Private key block'))
  throw new Error('SECURITY_AUDIT_PRIVATE_KEY_MARKER_FALSE_POSITIVE');
const fakeBlockLines=[
  '-----BEGIN PRIVATE KEY-----',
  'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=',
  'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=',
  '-----END PRIVATE KEY-----'
];
for(const side of ['+','-']){
  const block=fakeBlockLines.map(line=>side+line).join('\n')+'\n';
  const probe=makeHistoryScanner(patterns);
  probe.write('commit '+'f'.repeat(40)+'\n');
  probe.write('diff --git a/test/key-fixture.mjs b/test/key-fixture.mjs\n');
  probe.write(block);
  if(!probe.finish().has('Private key block'))
    throw new Error('SECURITY_AUDIT_HISTORY_PEM_POSITIVE_CONTROL_FAILED:'+side);
}
const boundaryProbe = makeHistoryScanner(patterns);
boundaryProbe.write('tunnel' + '_' + 'f'.repeat(16));
boundaryProbe.write('f'.repeat(16)+'\nBearer \n');
boundaryProbe.write('A'.repeat(25) + '\n');
const boundaryResetProbe = makeHistoryScanner(patterns);
boundaryResetProbe.write('Bearer \n');
boundaryResetProbe.write('diff --git a/a b/a\n');
boundaryResetProbe.write('A'.repeat(25) + '\n');
if(boundaryResetProbe.finish().has('Bearer token literal'))
  throw new Error('SECURITY_AUDIT_PATCH_BOUNDARY_REGRESSION');
const probed = boundaryProbe.finish();
if (!probed.has('Tunnel identifier') || !probed.has('Bearer token literal')) {
  throw new Error('SECURITY_AUDIT_STREAM_SCANNER_REGRESSION');
}
async function scanCompleteHistory() {
  const args = ['-c',`safe.directory=${repoRoot}`,'-C',repoRoot,'log', '--all', '-p', '--no-color', '--no-ext-diff'];
  const child = spawn('git', args, { cwd:repoRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
    if (secretPatternMatches(type,pattern,text))
      findings.push({ scope: 'CURRENT', type, location: file });
  }
}

for (const forbidden of ['config.local.json', '.env', 'connections.local.json']) {
  if (tracked.includes(forbidden)) findings.push({ scope: 'CURRENT', type: 'Forbidden tracked file', location: forbidden });
}
for (const expectedIgnored of ['config.local.json', '.env', 'connections.local.json', 'credentials/example.dpapi', 'downloads/example.zip']) {
  const ignored = spawnSync('git', ['-c',`safe.directory=${repoRoot}`,'-C',repoRoot,'check-ignore', '-q', '--', expectedIgnored], {cwd:repoRoot});
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
