import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createCompanionSession, writeCompanionObservation } from '../src/companion-session.mjs';
import { companionEndpoint, observeCompanion, parseCompanionExportArgs, readCompanionBinding } from '../tools/companion-export.mjs';
import { evaluateCompanionAcl, proveCompanionPrivateDirectory, verifyCompanionPrivateDirectory, verifyCompanionPrivateFile } from '../src/companion-private-directory.mjs';
import { parseCompanionJson } from '../src/companion-json.mjs';

const cfgHash = 'a'.repeat(64);
const binding = { appId: 'app-test', accountId: 'account-test', profileId: 'profile-test', workflowId: 'project-test',
  projectRoot: '/example/project', chatUrl: 'https://chatgpt.com/c/test-chat' };
const identity = { appId: null, profile: binding.profileId, deviceName: 'test-host', version: '0.10.4', commit: null,
  configSha256: cfgHash, routeGeneration: null };
const names = ['system_status', 'workflow_companion_snapshot'];
const runtime = { name: 'chatgpt-remote-commander', version: '0.10.4', deviceName: 'test-host', configSha256: cfgHash,
  instance: { profile: binding.profileId } };
async function snapshot() {
  return createCompanionSession({ binding, identity, readWorkflow: () => ({ state: { id: binding.workflowId, revision: 1,
    root: binding.projectRoot, configSha256: cfgHash, checkpoint: null, steps: [] } }), readOperations: () => [], readBackendTools: () => names }).observe({ id: binding.workflowId });
}
function transport(observation, change = null) {
  const calls = [];
  return { calls, async fetchImpl(url, options) {
    const body = JSON.parse(options.body); calls.push({ url, body, options });
    let result;
    if (body.method === 'server/discover') result = { supportedVersions: ['2026-07-28'] };
    else if (body.method === 'tools/list') result = { tools: names.map(name => ({ name })) };
    else if (body.params.name === 'system_status') result = { isError: false, structuredContent: runtime };
    else result = { isError: false, structuredContent: observation };
    if (change) result = change(result, body, calls.length);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  } };
}

// Test-only read-only telemetry. Neither these flags nor token ownership can
// authorize an export; the unchanged production privacy proof still decides.
function validatedFixtureAclDiagnostic(value) {
  const keys = ['broadAllowPresent', 'hashSDDL', 'ownerMatchesTokenOwner', 'ownerMatchesUser', 'pathValid',
    'requiredCurrentUserRights', 'rulesValid', 'schemaValid', 'tokenOwnerMatchesUser', 'tokenOwnerStatus'];
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), keys.sort());
  for (const key of ['ownerMatchesUser', 'pathValid', 'schemaValid', 'rulesValid', 'broadAllowPresent', 'requiredCurrentUserRights']) {
    assert.equal(typeof value[key], 'boolean');
  }
  assert.match(value.hashSDDL, /^[a-f0-9]{64}$/);
  assert.ok(['OBSERVED', 'MISSING'].includes(value.tokenOwnerStatus));
  for (const key of ['ownerMatchesTokenOwner', 'tokenOwnerMatchesUser']) {
    if (value.tokenOwnerStatus === 'MISSING') assert.equal(value[key], null);
    else assert.equal(typeof value[key], 'boolean');
  }
  return value;
}
const fixtureAclDiagnosticScript = String.raw`
$ErrorActionPreference='Stop'
$taskPath=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:RC_DIAG_FIXTURE_PATH))
$taskRoot=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:RC_DIAG_FIXTURE_ROOT))
$taskRootItem=Get-Item -LiteralPath $taskRoot -Force
if(-not $taskRootItem.PSIsContainer -or ($taskRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $taskRootItem.Name -notlike 'rc-companion-private-test-*'){throw 'Fixture guard'}
$taskItem=Get-Item -LiteralPath $taskPath -Force
if(($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (-not [string]::Equals($taskItem.FullName,$taskRootItem.FullName,[StringComparison]::OrdinalIgnoreCase) -and ($taskItem.PSIsContainer -or -not [string]::Equals($taskItem.Directory.FullName,$taskRootItem.FullName,[StringComparison]::OrdinalIgnoreCase)))){throw 'Fixture child guard'}
$taskAcl=Get-Acl -LiteralPath $taskItem.FullName
$taskIdentity=[Security.Principal.WindowsIdentity]::GetCurrent()
$taskCurrent=$taskIdentity.User.Value
$taskOwner=$taskAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
$taskTokenOwner=$null
try{if($null -ne $taskIdentity.Owner){$taskTokenOwner=$taskIdentity.Owner.Value}}catch{}
$taskRules=@($taskAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {@{sid=$_.IdentityReference.Value;access=$_.AccessControlType.ToString();rights=[int64]$_.FileSystemRights}})
$taskProof=@{path=$taskItem.FullName;ownerSid=$taskOwner;currentSid=$taskCurrent;sddl=$taskAcl.Sddl;rules=$taskRules}
$taskRoundTrip=($taskProof | ConvertTo-Json -Depth 5 -Compress) | ConvertFrom-Json
$taskSidPattern='^S-1-[0-9]+(?:-[0-9]+)+$'
$taskSchemaValid=(($taskRoundTrip.PSObject.Properties.Name | Sort-Object) -join ',') -ceq 'currentSid,ownerSid,path,rules,sddl'
$taskSchemaValid=$taskSchemaValid -and ($taskRoundTrip.path -is [string]) -and ($taskRoundTrip.currentSid -match $taskSidPattern) -and ($taskRoundTrip.ownerSid -is [string]) -and ($taskRoundTrip.sddl -is [string]) -and ($taskRoundTrip.sddl.Length -ge 8) -and ($taskRoundTrip.sddl.Length -le 32768)
$taskRulesValid=($taskRoundTrip.rules -is [Array]) -and ($taskRules.Count -gt 0) -and ($taskRules.Count -le 256)
$taskBroad=$false;$taskCurrentRights=$false
foreach($taskRule in $taskRules){
 $taskRuleValid=(($taskRule.Keys | Sort-Object) -join ',') -ceq 'access,rights,sid'
 $taskRuleValid=$taskRuleValid -and ($taskRule.sid -match $taskSidPattern) -and ($taskRule.access -in @('Allow','Deny')) -and ($taskRule.rights -is [long]) -and ($taskRule.rights -ge 0) -and ($taskRule.rights -le 9007199254740991)
 $taskRulesValid=$taskRulesValid -and $taskRuleValid
 if($taskRule.access -eq 'Allow' -and $taskRule.rights -gt 0 -and $taskRule.sid -notin @($taskCurrent,'S-1-5-18','S-1-5-32-544')){$taskBroad=$true}
 if($taskRule.access -eq 'Allow' -and $taskRule.sid -eq $taskCurrent -and (($taskRule.rights -band 3) -eq 3)){$taskCurrentRights=$true}
}
$taskHash=[Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($taskAcl.Sddl))
$taskTokenStatus=if($null -eq $taskTokenOwner){'MISSING'}else{'OBSERVED'}
@{ownerMatchesUser=($taskOwner -ceq $taskCurrent);ownerMatchesTokenOwner=$(if($null -eq $taskTokenOwner){$null}else{$taskOwner -ceq $taskTokenOwner});tokenOwnerMatchesUser=$(if($null -eq $taskTokenOwner){$null}else{$taskTokenOwner -ceq $taskCurrent});tokenOwnerStatus=$taskTokenStatus;pathValid=[string]::Equals([IO.Path]::GetFullPath($taskPath),$taskItem.FullName,[StringComparison]::OrdinalIgnoreCase);schemaValid=[bool]$taskSchemaValid;rulesValid=[bool]$taskRulesValid;broadAllowPresent=$taskBroad;requiredCurrentUserRights=$taskCurrentRights;hashSDDL=([BitConverter]::ToString($taskHash)).Replace('-','').ToLowerInvariant()} | ConvertTo-Json -Depth 3 -Compress
`;
function emitFixtureAclDiagnostic(actualRoot, target, phase, kind) {
  if (process.platform !== 'win32') return;
  const missing = { status: 'MISSING', schema: 1, phase, kind,
    tokenOwnerEvidence: 'POWERSHELL_CHILD_ONLY_NODE_TOKEN_UNPROVEN' };
  try {
    assert.ok(['BEFORE_BINDING_READ', 'WRITER_FAILURE'].includes(phase));
    assert.ok(['DIRECTORY', 'BINDING', 'LOCK', 'TEMPORARY', 'SNAPSHOT'].includes(kind));
    assert.equal(fs.realpathSync.native(actualRoot), actualRoot);
    assert.match(path.basename(actualRoot), /^rc-companion-private-test-/);
    const rootBefore = fs.lstatSync(actualRoot, { bigint: true });
    assert.equal(rootBefore.isDirectory(), true); assert.equal(rootBefore.isSymbolicLink(), false);
    assert.ok(target === actualRoot || path.dirname(target) === actualRoot);
    const before = fs.lstatSync(target, { bigint: true });
    assert.equal(before.isSymbolicLink(), false);
    if (target !== actualRoot) { assert.equal(before.isFile(), true); assert.equal(before.nlink, 1n); }
    const run = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', fixtureAclDiagnosticScript], {
      env: { ...process.env, RC_DIAG_FIXTURE_PATH: Buffer.from(target).toString('base64'), RC_DIAG_FIXTURE_ROOT: Buffer.from(actualRoot).toString('base64') },
      windowsHide: true, shell: false, encoding: 'utf8', timeout: 5000, maxBuffer: 16384 });
    if (run.error || run.signal || run.status !== 0 || run.stderr.trim()) throw new Error('DIAGNOSTIC_MISSING');
    const value = validatedFixtureAclDiagnostic(JSON.parse(run.stdout));
    const after = fs.lstatSync(target, { bigint: true }), rootAfter = fs.lstatSync(actualRoot, { bigint: true });
    assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino); assert.equal(after.size, before.size);
    assert.equal(after.mtimeNs, before.mtimeNs); assert.equal(rootAfter.dev, rootBefore.dev); assert.equal(rootAfter.ino, rootBefore.ino);
    console.log(JSON.stringify({ companionFixtureAclDiagnostic: { ...missing, status: 'OBSERVED', ...value } }));
  } catch {
    // A missing diagnostic is never authority and must not replace the gate error.
    console.log(JSON.stringify({ companionFixtureAclDiagnostic: missing }));
  }
}
function writeFixtureObservation(actualRoot, observation) {
  try {
    return writeCompanionObservation(actualRoot, observation, {
      verifyPrivateDirectory: process.platform === 'win32' ? verifyCompanionPrivateDirectory : null,
      verifyPrivateFile: process.platform === 'win32' ? verifyCompanionPrivateFile : null });
  } catch (error) {
    try {
      emitFixtureAclDiagnostic(actualRoot, actualRoot, 'WRITER_FAILURE', 'DIRECTORY');
      const receipt = error.companionWrite;
      for (const [field, kind, pattern] of [
        ['lockFile', 'LOCK', /^\.commander-companion-export\.lock$/],
        ['temporaryFile', 'TEMPORARY', /^\.commander-companion-\d{16}-[a-f0-9-]{36}\.tmp$/],
        ['publishedFile', 'SNAPSHOT', /^commander-companion-\d{16}-[a-f0-9-]{36}\.json$/]]) {
        if (typeof receipt?.[field] === 'string' && pattern.test(receipt[field])) {
          emitFixtureAclDiagnostic(actualRoot, path.join(actualRoot, receipt[field]), 'WRITER_FAILURE', kind);
        }
      }
    } catch { /* Only diagnostic failure is ignored; the original gate is rethrown. */ }
    throw error;
  }
}

test('synthetic administrator owner mismatch remains rejected and diagnostic is redacted only', () => {
  const currentSid = 'S-1-5-21-1-2-3-1001';
  const acl = { path: 'C:\\example\\private', currentSid, ownerSid: 'S-1-5-32-544', sddl: 'D:(A;OICI;FA;;;OW)',
    rules: [{ sid: currentSid, access: 'Allow', rights: 2032127 }, { sid: 'S-1-5-32-544', access: 'Allow', rights: 2032127 }] };
  assert.throws(() => evaluateCompanionAcl(acl, acl.path), /COMPANION_ACL_INVALID/);
  const flags = { ownerMatchesUser: false, ownerMatchesTokenOwner: true, tokenOwnerMatchesUser: false, tokenOwnerStatus: 'OBSERVED',
    pathValid: true, schemaValid: true, rulesValid: true, broadAllowPresent: false, requiredCurrentUserRights: true, hashSDDL: 'a'.repeat(64) };
  assert.deepEqual(validatedFixtureAclDiagnostic(flags), flags);
  assert.deepEqual(validatedFixtureAclDiagnostic({ ...flags, tokenOwnerStatus: 'MISSING', ownerMatchesTokenOwner: null, tokenOwnerMatchesUser: null }).tokenOwnerStatus, 'MISSING');
  assert.throws(() => validatedFixtureAclDiagnostic({ ...flags, path: acl.path }));
  assert.throws(() => validatedFixtureAclDiagnostic({ ...flags, sddl: acl.sddl }));
  assert.throws(() => validatedFixtureAclDiagnostic({ ...flags, ownerSid: acl.ownerSid }));
  assert.doesNotMatch(JSON.stringify(flags), /S-1-|C:\\\\|D:\(/);
});
test('endpoint is exact literal loopback MCP only', () => {
  assert.equal(companionEndpoint('http://127.0.0.1:12345/mcp'), 'http://127.0.0.1:12345/mcp');
  for (const endpoint of ['http://localhost:12345/mcp', 'https://127.0.0.1:12345/mcp', 'http://127.0.0.1:12345/mcp?q=x',
    'http://user@127.0.0.1:12345/mcp', 'http://192.168.1.1:12345/mcp', 'http://127.1:12345/mcp']) assert.throws(() => companionEndpoint(endpoint), /ENDPOINT_INVALID/);
});
test('wire parser rejects duplicate escaped keys, malformed UTF8, BOM and deep containers', () => {
  assert.deepEqual(parseCompanionJson(Buffer.from('{"name":"محلی"}')), { name: 'محلی' });
  for (const raw of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '\ufeff{}', '['.repeat(33) + '0' + ']'.repeat(33)]) {
    assert.throws(() => parseCompanionJson(Buffer.from(raw)), /JSON_INVALID/);
  }
  assert.throws(() => parseCompanionJson(Buffer.from([0xff])), /JSON_INVALID/);
});
test('closed CLI rejects unknown, repeated and incomplete arguments', () => {
  const args = ['--endpoint', 'http://127.0.0.1:12345/mcp', '--profile-directory', path.resolve(os.tmpdir(), 'example'), '--workflow-id', binding.workflowId];
  assert.equal(parseCompanionExportArgs(args).id, binding.workflowId);
  for (const bad of [[...args, '--command', 'node'], [...args, '--workflow-id', binding.workflowId], args.slice(0, -1)]) assert.throws(() => parseCompanionExportArgs(bad), /ARGUMENT_INVALID/);
});
test('native observation is modern, read-only and does not infer chat exposure', async () => {
  const view = await snapshot(), fake = transport(view);
  const actual = await observeCompanion({ endpoint: 'http://127.0.0.1:12345/mcp', id: binding.workflowId, binding }, fake);
  assert.equal(actual.currentChat.state, 'UNKNOWN'); assert.equal(actual.reconciliation.actionAllowed, false);
  assert.deepEqual(fake.calls.map(c => c.body.method === 'tools/call' ? c.body.params.name : c.body.method),
    ['server/discover', 'system_status', 'tools/list', 'workflow_companion_snapshot', 'system_status']);
  for (const call of fake.calls) { assert.equal(call.options.redirect, 'error'); assert.equal(call.options.headers.origin, undefined);
    assert.equal(call.body.params._meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28'); }
});
test('runtime changes across observation prevent export', async () => {
  const fake = transport(await snapshot(), (result, _body, index) => index === 5 ? { ...result, structuredContent: { ...runtime, configSha256: 'b'.repeat(64) } } : result);
  await assert.rejects(observeCompanion({ endpoint: 'http://127.0.0.1:12345/mcp', id: binding.workflowId, binding }, fake), /RUNTIME_DRIFT/);
});
test('wrong profile/project/chat or unavailable tool fails without a write', async () => {
  const fake = transport(await snapshot());
  await assert.rejects(observeCompanion({ endpoint: 'http://127.0.0.1:12345/mcp', id: binding.workflowId, binding: { ...binding, profileId: 'wrong-profile' } }, fake), /PROFILE_ID_MISMATCH/);
  await assert.rejects(observeCompanion({ endpoint: 'http://127.0.0.1:12345/mcp', id: binding.workflowId, binding: { ...binding, chatUrl: 'https://chatgpt.com/c/other' } }, transport(await snapshot())), /OPERATOR_BINDING_MISMATCH/);
  const absent = transport(await snapshot(), (result, body) => body.method === 'tools/list' ? { tools: [{ name: 'system_status' }] } : result);
  await assert.rejects(observeCompanion({ endpoint: 'http://127.0.0.1:12345/mcp', id: binding.workflowId, binding }, absent), /CATALOG_UNAVAILABLE/);
});
test('duplicate catalog and oversized or invalid UTF8 response fail closed', async () => {
  const options = { endpoint: 'http://127.0.0.1:12345/mcp', id: binding.workflowId, binding };
  const duplicates = transport(await snapshot(), (result, body) => body.method === 'tools/list' ? { tools: [{ name: 'system_status' }, { name: 'system_status' }] } : result);
  await assert.rejects(observeCompanion(options, duplicates), /CATALOG_UNAVAILABLE/);
  await assert.rejects(observeCompanion(options, { fetchImpl: async () => new Response('x'.repeat(524289), { headers: { 'content-type': 'application/json' } }) }), /RESPONSE_LIMIT/);
  await assert.rejects(observeCompanion(options, { fetchImpl: async () => new Response(Uint8Array.of(0xff), { headers: { 'content-type': 'application/json' } }) }));
});
test('actual isolated private profile supports immutable no-clobber exports', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-companion-private-test-'));
  const actualRoot = fs.realpathSync.native(directory);
  try {
    if (process.platform === 'win32') {
      // Only this newly owned test fixture gets an ACL. Never edits a user profile.
      const script = String.raw`$ErrorActionPreference='Stop';$taskPath=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:RC_PRIVATE_TEST_PATH));$taskItem=Get-Item -LiteralPath $taskPath -Force;if(-not $taskItem.PSIsContainer -or ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $taskItem.Name -notlike 'rc-companion-private-test-*'){throw 'Fixture identity'};$taskAcl=[Security.AccessControl.DirectorySecurity]::new();$taskSid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$taskAcl.SetOwner($taskSid);$taskAcl.SetAccessRuleProtection($true,$false);foreach($taskWho in @($taskSid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))){$taskRule=[Security.AccessControl.FileSystemAccessRule]::new($taskWho,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$taskAcl.AddAccessRule($taskRule)};Set-Acl -LiteralPath $taskPath -AclObject $taskAcl`;
      const setup = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, RC_PRIVATE_TEST_PATH: Buffer.from(actualRoot).toString('base64') }, windowsHide: true, shell: false, encoding: 'utf8', timeout: 5000 });
      assert.equal(setup.status, 0, setup.stderr);
    } else fs.chmodSync(directory, 0o700);
    assert.equal(proveCompanionPrivateDirectory(actualRoot).private, true);
    fs.writeFileSync(path.join(actualRoot, 'commander-binding.json'), JSON.stringify(binding), { flag: 'wx', mode: 0o600 });
    const legacy = path.join(actualRoot, 'commander-companion.json');
    fs.writeFileSync(legacy, 'unknown owned test fixture; do not overwrite', { flag: 'wx', mode: 0o600 });
    emitFixtureAclDiagnostic(actualRoot, actualRoot, 'BEFORE_BINDING_READ', 'DIRECTORY');
    emitFixtureAclDiagnostic(actualRoot, path.join(actualRoot, 'commander-binding.json'), 'BEFORE_BINDING_READ', 'BINDING');
    assert.deepEqual(readCompanionBinding(actualRoot).binding, binding);
    const result = writeFixtureObservation(actualRoot, await snapshot());
    assert.equal(result.private, true); assert.equal(result.workflowMutation, false);
    assert.match(path.basename(result.path), /^commander-companion-\d{16}-[a-f0-9-]{36}\.json$/);
    assert.equal(JSON.parse(fs.readFileSync(result.path, 'utf8')).currentChat.state, 'UNKNOWN');
    const original = fs.readFileSync(result.path);
    const second = writeFixtureObservation(actualRoot, await snapshot());
    assert.notEqual(second.path, result.path);
    assert.deepEqual(fs.readFileSync(result.path), original);
    assert.equal(fs.lstatSync(second.path).nlink, 1);
    assert.equal(fs.readFileSync(legacy, 'utf8'), 'unknown owned test fixture; do not overwrite');
    assert.equal(fs.existsSync(path.join(actualRoot, '.commander-companion-export.lock')), false);
    if (process.platform === 'win32') {
      const broaden = String.raw`$ErrorActionPreference='Stop';$taskPath=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:RC_PRIVATE_TEST_FILE));$taskItem=Get-Item -LiteralPath $taskPath -Force;if($taskItem.PSIsContainer -or ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $taskItem.Name -ne 'commander-binding.json' -or $taskItem.Directory.Name -notlike 'rc-companion-private-test-*'){throw 'Fixture identity'};$taskAcl=Get-Acl -LiteralPath $taskPath;$taskRule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow');$taskAcl.AddAccessRule($taskRule);Set-Acl -LiteralPath $taskPath -AclObject $taskAcl`;
      const run = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', broaden], { env: { ...process.env, RC_PRIVATE_TEST_FILE: Buffer.from(path.join(actualRoot, 'commander-binding.json')).toString('base64') }, windowsHide: true, shell: false, encoding: 'utf8', timeout: 5000 });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(proveCompanionPrivateDirectory(actualRoot).private, true);
      assert.throws(() => readCompanionBinding(actualRoot), /DIRECTORY_NOT_PRIVATE/);
    }
  } finally {
    // Exact owned fixture only; never recursively removes a profile/workspace.
    assert.equal(fs.realpathSync.native(directory), actualRoot); assert.match(path.basename(directory), /^rc-companion-private-test-/);
    assert.equal(fs.lstatSync(directory).isSymbolicLink(), false); fs.rmSync(directory, { recursive: true });
  }
});

test('real isolated modern MCP enforces anonymous quarantine or verifies authorized snapshot without mutation', async t => {
  const owned = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-companion-http-test-')));
  const app = path.join(owned, 'app'), project = path.join(owned, 'project');
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let child;
  try {
    fs.mkdirSync(app); fs.mkdirSync(project);
    fs.cpSync(path.join(repository, '..', '..', 'src'), path.join(app, 'src'), { recursive: true });
    const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const localBinding = { ...binding, projectRoot: project };
    const config = { host: '127.0.0.1', port, deviceName: 'Isolated companion fixture', instance: { profile: binding.profileId, isolated: true },
      allowedRoots: [project], allowedPrograms: ['node'], maxReadBytes: 1048576, maxWriteBytes: 1048576,
      maxCommandMs: 15000, auditLog: path.join(owned, 'audit.jsonl'), runtimeState: path.join(owned, 'runtime.json'),
      agentExtensions: { enabled: false }, durableDelivery: { directory: path.join(owned, 'delivery') },
      powerMode: { enabled: false }, durableWorkflows: { enabled: true, directory: path.join(owned, 'memory'),
        scheduler: { enabled: false }, executionTools: ['system_status'], companion: { binding: localBinding } } };
    const configPath = path.join(owned, 'config.json'); fs.writeFileSync(configPath, JSON.stringify(config));
    child = spawn(process.execPath, [path.join(app, 'src', 'server-v0.3.mjs')], { cwd: app,
      env: { ...process.env, REMOTE_COMMANDER_CONFIG: configPath }, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => output = (output + data).slice(-16384)); child.stderr.on('data', data => output = (output + data).slice(-16384));
    const endpoint = `http://127.0.0.1:${port}/mcp`, deadline = Date.now() + 10000;
    let healthy = false, verifiedHealth;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('ISOLATED_SERVER_EXITED ' + output);
      try { const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(300) });
        const health = await response.json(); if (health.configSha256 === (await import('node:crypto')).createHash('sha256').update(JSON.stringify(config)).digest('hex')) { verifiedHealth = health; healthy = true; break; }
      } catch { /* short bounded startup observation */ }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(healthy, true, output);
    if (verifiedHealth.privilegedLegacyHttpQuarantined === true) {
      // The hosted/native security policy must not be bypassed by this fixture.
      // This branch validates a real denial, NOT the positive trusted-transport gate.
      for (const headers of [
        { 'content-type': 'application/json' },
        { 'content-type': 'application/json', authorization: 'Bearer forged', 'x-request-id': 'forged' }
      ]) {
        const denial = await fetch(endpoint, { method: 'POST', headers,
          body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'workflow_create',
              arguments: { id: binding.workflowId, root: project,
                goal: 'Must not create', acceptance: [], steps: [] } } }),
          signal: AbortSignal.timeout(3000) });
        assert.equal(denial.status, 403);
        assert.deepEqual(await denial.json(), { error: 'trusted_transport_required' });
      }
      t.diagnostic('TRUSTED_TRANSPORT_POSITIVE_GATE_NOT_RUN: anonymous privileged HTTP correctly quarantined');
      return;
    }
    async function call(name, args) {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), signal: AbortSignal.timeout(3000) });
      const payload = await response.json(); assert.equal(response.status, 200, JSON.stringify(payload)); const result = payload.result; assert.equal(result.isError, false, JSON.stringify(result)); return result.structuredContent;
    }
    await call('workflow_create', { id: binding.workflowId, root: project, goal: 'Isolated observation only',
      acceptance: ['Observer does not alter revision'], steps: [{ id: 'inspect', title: 'Inspect only' }] });
    const before = await call('workflow_get', { id: binding.workflowId });
    const observed = await observeCompanion({ endpoint, id: binding.workflowId, binding: localBinding });
    const after = await call('workflow_get', { id: binding.workflowId });
    assert.deepEqual(after, before); assert.equal(observed.identity.version, '0.10.4'); assert.equal(observed.backend.state, 'CONFIRMED');
    assert.equal(observed.currentChat.state, 'UNKNOWN'); assert.equal(observed.reconciliation.actionAllowed, false);
    assert.equal(observed.project.root, project); assert.equal(observed.project.revision, before.state.revision);
  } finally {
    if (child && child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
    assert.equal(fs.realpathSync.native(owned), owned); assert.match(path.basename(owned), /^rc-companion-http-test-/);
    fs.rmSync(owned, { recursive: true });
  }
});

test('endpoint refuses port zero even on a literal loopback MCP hostname', () => {
  for (const endpoint of [
    'http://127.0.0.1:0/mcp',
    'http://[::1]:0/mcp'
  ]) {
    assert.throws(() => companionEndpoint(endpoint), /COMPANION_ENDPOINT_INVALID/, endpoint);
  }
});