import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateCompanionBinding, validateCompanionObservation, writeCompanionObservation } from '../src/companion-session.mjs';
import { proveCompanionPrivateDirectory, proveCompanionPrivateFile, verifyCompanionPrivateDirectory, verifyCompanionPrivateFile } from '../src/companion-private-directory.mjs';
import { parseCompanionJson } from '../src/companion-json.mjs';

const fail = code => { throw new Error(code); };
const sha = value => createHash('sha256').update(value).digest('hex');
export function companionEndpoint(value) {
  let url; try { url = new URL(value); } catch { fail('COMPANION_ENDPOINT_INVALID'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || !url.port || !Number.isSafeInteger(Number(url.port))
    || Number(url.port) < 1 || Number(url.port) > 65535
    || url.username || url.password || url.search || url.hash || url.pathname !== '/mcp'
    || value !== url.href) fail('COMPANION_ENDPOINT_INVALID');
  const host = url.hostname === '127.0.0.1' ? '127.0.0.1' : '[::1]';
  return 'http://' + host + ':' + Number(url.port) + '/mcp';
}
export function parseCompanionExportArgs(args) {
  const options = {};
  const keys = new Map([['--endpoint', 'endpoint'], ['--profile-directory', 'directory'], ['--workflow-id', 'id']]);
  for (let i = 0; i < args.length; i += 2) {
    const key = keys.get(args[i]), value = args[i + 1];
    if (!key || typeof value !== 'string' || !value || Object.hasOwn(options, key)) fail('COMPANION_ARGUMENT_INVALID');
    options[key] = value;
  }
  if (Object.keys(options).length !== 3 || !/^[a-z][a-z0-9_-]{0,63}$/.test(options.id)
    || !path.isAbsolute(options.directory)) fail('COMPANION_ARGUMENT_INVALID');
  companionEndpoint(options.endpoint);
  return options;
}
async function boundedJson(response, maxBytes) {
  if (!response.ok || response.redirected || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) fail('COMPANION_HTTP_INVALID');
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxBytes) fail('COMPANION_RESPONSE_LIMIT');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  return parseCompanionJson(raw, { maxBytes });
}
function runtimePin(value) {
  if (!value || value.name !== 'chatgpt-remote-commander' || typeof value.version !== 'string'
    || typeof value.deviceName !== 'string' || !/^[a-f0-9]{64}$/.test(value.configSha256 ?? '')
    || typeof value.instance?.profile !== 'string') fail('COMPANION_RUNTIME_INVALID');
  return JSON.stringify({ name: value.name, version: value.version, deviceName: value.deviceName,
    configSha256: value.configSha256, profile: value.instance.profile });
}
/** This native observer has a closed read-only method set. It never grants the
 * web page a connection, command channel, credential, or execution permit. */
export async function observeCompanion({ endpoint, id, binding }, { fetchImpl = fetch, now = Date.now } = {}) {
  const pinnedEndpoint = companionEndpoint(endpoint); validateCompanionBinding(binding);
  if (id !== binding.workflowId || !/^[a-z][a-z0-9_-]{0,63}$/.test(id)) fail('COMPANION_WORKFLOW_ID_MISMATCH');
  let serial = 0;
  async function rpc(method, params, maxBytes = 512 * 1024) {
    const requestId = ++serial;
    const metadata = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'commander-native-observer', version: '1' } };
    const headers = { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': method };
    if (method === 'tools/call') headers['mcp-name'] = params.name;
    const response = await fetchImpl(pinnedEndpoint, { method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(3000),
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params: { ...params, _meta: metadata } }) });
    const value = await boundedJson(response, maxBytes);
    if (value.jsonrpc !== '2.0' || value.id !== requestId || value.error || !value.result || typeof value.result !== 'object') fail('COMPANION_RPC_INVALID');
    return value.result;
  }
  async function tool(name, args = {}, maxBytes) {
    const result = await rpc('tools/call', { name, arguments: args }, maxBytes);
    if (result.isError !== false || !result.structuredContent) fail('COMPANION_TOOL_UNAVAILABLE');
    return result.structuredContent;
  }
  const discovery = await rpc('server/discover', {});
  if (!discovery.supportedVersions?.includes('2026-07-28')) fail('COMPANION_PROTOCOL_UNAVAILABLE');
  const before = await tool('system_status');
  const beforePin = runtimePin(before);
  if (before.instance.profile !== binding.profileId) fail('COMPANION_PROFILE_ID_MISMATCH');
  const catalog = await rpc('tools/list', {});
  if (!Array.isArray(catalog.tools) || catalog.tools.length > 256
    || catalog.tools.some(tool => typeof tool?.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(tool.name))) fail('COMPANION_CATALOG_INVALID');
  const names = catalog.tools.map(tool => tool.name).sort();
  if (new Set(names).size !== names.length || !names.includes('workflow_companion_snapshot')) fail('COMPANION_CATALOG_UNAVAILABLE');
  const snapshot = await tool('workflow_companion_snapshot', { id }, 128 * 1024);
  const after = await tool('system_status');
  if (runtimePin(after) !== beforePin) fail('COMPANION_RUNTIME_DRIFT');
  validateCompanionObservation(snapshot, { now: now() });
  if (JSON.stringify(snapshot.binding) !== JSON.stringify(binding)) {
    for (const key of Object.keys(binding)) if (snapshot.binding[key] !== binding[key]) fail('COMPANION_OPERATOR_BINDING_MISMATCH');
  }
  if (snapshot.identity.configSha256 !== before.configSha256 || snapshot.identity.profile !== before.instance.profile
    || snapshot.identity.version !== before.version || snapshot.identity.deviceName !== before.deviceName) fail('COMPANION_RUNTIME_DRIFT');
  if (snapshot.backend.state !== 'CONFIRMED' || snapshot.backend.toolCatalogSha256 !== sha(JSON.stringify(names))) fail('COMPANION_CATALOG_DRIFT');
  // Current-chat exposure comes only from the snapshot's trusted host adapter,
  // never from tools/list or client metadata.
  return snapshot;
}
export function readCompanionBinding(directory) {
  proveCompanionPrivateDirectory(directory);
  const target = path.join(directory, 'commander-binding.json');
  const privateFile = proveCompanionPrivateFile(target);
  const initial = fs.lstatSync(target, { bigint: true });
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1n || initial.size > 16384n) fail('COMPANION_BINDING_FILE_INVALID');
  if (process.platform !== 'win32' && (initial.uid !== BigInt(process.getuid()) || (initial.mode & 0o077n) !== 0n)) fail('COMPANION_BINDING_NOT_PRIVATE');
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let raw;
  try {
    const pinned = fs.fstatSync(descriptor, { bigint: true });
    if (!pinned.isFile() || pinned.nlink !== 1n || pinned.dev !== initial.dev || pinned.ino !== initial.ino
      || pinned.size !== initial.size || pinned.mtimeNs !== initial.mtimeNs) fail('COMPANION_BINDING_DRIFT');
    const buffer = Buffer.alloc(16385); let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(descriptor, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length > 16384) fail('COMPANION_BINDING_FILE_INVALID');
    raw = buffer.subarray(0, length);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (after.nlink !== 1n || after.mode !== pinned.mode || after.size !== pinned.size
      || after.mtimeNs !== pinned.mtimeNs || raw.length !== Number(pinned.size)) fail('COMPANION_BINDING_DRIFT');
  } finally { fs.closeSync(descriptor); }
  const afterPath = fs.lstatSync(target, { bigint: true });
  const afterPrivateFile = proveCompanionPrivateFile(target);
  if (afterPath.dev !== initial.dev || afterPath.ino !== initial.ino || afterPath.mtimeNs !== initial.mtimeNs
    || afterPrivateFile.aclSha256 !== privateFile.aclSha256) fail('COMPANION_BINDING_DRIFT');
  let binding; try { binding = parseCompanionJson(raw, { maxBytes: 16384, maxDepth: 12, maxNodes: 4096 }); } catch { fail('COMPANION_BINDING_JSON_INVALID'); }
  validateCompanionBinding(binding);
  return { binding, sha256: sha(raw) };
}
async function main() {
  const options = parseCompanionExportArgs(process.argv.slice(2));
  const pin = readCompanionBinding(options.directory);
  const snapshot = await observeCompanion({ ...options, binding: pin.binding });
  const after = readCompanionBinding(options.directory);
  if (after.sha256 !== pin.sha256) fail('COMPANION_BINDING_DRIFT');
  const receipt = writeCompanionObservation(options.directory, snapshot,
    { verifyPrivateDirectory: process.platform === 'win32' ? verifyCompanionPrivateDirectory : null,
      verifyPrivateFile: process.platform === 'win32' ? verifyCompanionPrivateFile : null });
  console.log(JSON.stringify({ status: 'OBSERVED_ONLY', ...receipt, currentChat: snapshot.currentChat.state,
    reconciliation: snapshot.reconciliation.state, executionAuthority: false }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Preserve uncertain-write status without dumping snapshots, credentials,
    // transport responses, or arbitrary exception objects to the console.
    const write = error.companionWrite;
    console.error(JSON.stringify({ status: 'FAIL', code: error.companionCode ?? error.message,
      ...(write ? { published: write.published === true,
        reconciliationRequired: write.reconciliationRequired === true,
        publishedFile: write.publishedFile, temporaryFile: write.temporaryFile, lockFile: write.lockFile } : {}) }));
    process.exitCode = 1;
  });
}
