import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, '..');
const packagePath = path.join(projectDir, 'package.json');
const DEFAULT_ENDPOINT = 'http://127.0.0.1:47831/mcp';
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export function validateEndpoint(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('doctor endpoint must use http or https');
  if (url.username || url.password) throw new Error('doctor endpoint must not contain credentials');
  if (url.search || url.hash) throw new Error('doctor endpoint must not contain query or fragment');
  const host = url.hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error('doctor endpoint must be loopback-only');
  }
  if (url.pathname !== '/mcp') throw new Error('doctor endpoint path must be exactly /mcp');
  if (!url.port || !Number.isSafeInteger(Number(url.port)) ||
    Number(url.port) < 1 || Number(url.port) > 65535) {
    throw new Error('doctor endpoint must include an explicit port');
  }
  const scheme = url.protocol === 'http:' ? 'http' : 'https';
  const pinnedHost = host === '127.0.0.1' ? '127.0.0.1'
    : host === 'localhost' ? 'localhost' : '[::1]';
  return new URL(scheme + '://' + pinnedHost + ':' + Number(url.port) + '/mcp');
}

export function parseArgs(argv) {
  const out = { endpoint: DEFAULT_ENDPOINT, expectedDevice: null, expectedVersion: null, configPath: null, json: false, expectAnonymousQuarantine: false, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--expect-anonymous-quarantine') out.expectAnonymousQuarantine = true;
    else if (arg === '--url') out.endpoint = argv[++i];
    else if (arg === '--expected-device') out.expectedDevice = argv[++i];
    else if (arg === '--expected-version') out.expectedVersion = argv[++i];
    else if (arg === '--config') out.configPath = argv[++i];
    else if (arg === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(out.timeoutMs) || out.timeoutMs < 500 || out.timeoutMs > 30000) {
    throw new Error('--timeout-ms must be an integer between 500 and 30000');
  }
  validateEndpoint(out.endpoint);
  return out;
}

async function readBounded(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error('response too large');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('response too large');
  return text;
}

async function requestJson(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'error' });
    const text = await readBounded(response);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

async function rpc(endpoint, method, params, timeoutMs, id) {
  const body = await requestJson(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })
  }, timeoutMs);
  if (body?.error) throw new Error(`${body.error.code ?? 'RPC'}: ${body.error.message ?? 'RPC error'}`);
  return body?.result;
}

async function toolCall(endpoint, name, args, timeoutMs, id) {
  const result = await rpc(endpoint, 'tools/call', { name, arguments: args }, timeoutMs, id);
  if (result?.isError) {
    const message = result?.content?.map((item) => item?.text).filter(Boolean).join(' ') || `${name} failed`;
    throw new Error(message);
  }
  return result?.structuredContent ?? result;
}

function isExactTrustedTransportDenial(error) {
  const prefix = 'HTTP 403: ';
  if (!(error instanceof Error) || !error.message.startsWith(prefix)) return false;
  try {
    const body = JSON.parse(error.message.slice(prefix.length));
    return body && typeof body === 'object' && !Array.isArray(body) &&
      Object.keys(body).length === 1 && body.error === 'trusted_transport_required';
  } catch {
    return false;
  }
}

async function fileSha256(filePath) {
  const data = await readFile(filePath);
  return createHash('sha256').update(data).digest('hex');
}

export async function runDoctor(options = {}) {
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  const endpoint = validateEndpoint(options.endpoint || DEFAULT_ENDPOINT);
  const expectedVersion = options.expectedVersion || pkg.version;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const checks = [];
  const warnings = [];
  const quarantineOnly = options.expectAnonymousQuarantine === true;
  let id = 1;

  const health = new URL(endpoint.href);
  health.pathname = '/health';
  health.search = '';
  health.hash = '';

  try {
    const healthBody = await requestJson(health, { method: 'GET' }, timeoutMs);
    checks.push({ name: 'health', ok: true, detail: healthBody?.status || healthBody?.ok || 'HTTP 200' });
  } catch (error) {
    checks.push({ name: 'health', ok: false, detail: error.message });
  }

  let status = null;
  try {
    status = await toolCall(endpoint, 'system_status', {}, timeoutMs, id++);
    if (quarantineOnly) {
      status = null;
      checks.push({ name: 'system_status', ok: false, detail: 'anonymous tool unexpectedly accepted' });
    } else {
      checks.push({ name: 'system_status', ok: true, detail: `${status?.deviceName || 'unknown'} / ${status?.version || 'unknown'}` });
    }
  } catch (error) {
    const denied = quarantineOnly && isExactTrustedTransportDenial(error);
    checks.push({ name: 'system_status', ok: denied, detail: denied ? 'HTTP 403 trusted_transport_required' : error.message });
  }

  let toolNames = [];
  try {
    const listed = await rpc(endpoint, 'tools/list', undefined, timeoutMs, id++);
    toolNames = Array.isArray(listed?.tools) ? listed.tools.map((tool) => tool.name) : [];
    const required = ['system_status', 'list_directory', 'read_text', 'write_text', 'run_project_command'];
    const missing = required.filter((name) => !toolNames.includes(name));
    if (quarantineOnly) {
      toolNames = [];
      checks.push({ name: 'tools/list', ok: false, detail: 'anonymous tool list unexpectedly accepted' });
    } else {
      checks.push({ name: 'tools/list', ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(', ')}` : `${toolNames.length} tools` });
    }
  } catch (error) {
    const denied = quarantineOnly && isExactTrustedTransportDenial(error);
    checks.push({ name: 'tools/list', ok: denied, detail: denied ? 'HTTP 403 trusted_transport_required' : error.message });
  }

  if (status) {
    checks.push({ name: 'version', ok: status.version === expectedVersion, detail: `expected ${expectedVersion}; active ${status.version ?? 'unknown'}` });
    if (options.expectedDevice) {
      checks.push({ name: 'device', ok: status.deviceName === options.expectedDevice, detail: `expected ${options.expectedDevice}; active ${status.deviceName ?? 'unknown'}` });
    }
    if (options.configPath) {
      const configPath = path.resolve(options.configPath);
      const expectedSha = await fileSha256(configPath);
      checks.push({ name: 'configSha256', ok: status.configSha256 === expectedSha, detail: status.configSha256 === expectedSha ? 'match' : 'mismatch' });
    }
    if (status.powerMode?.enabled && status.powerMode?.fullFilesystem && status.allowedRootsEnforced !== false) {
      warnings.push('Power Mode reports fullFilesystem=true but allowedRootsEnforced is not false.');
    }
  }

  const failures = checks.filter((check) => !check.ok);
  return {
    ok: failures.length === 0,
    qualificationScope: quarantineOnly ? 'ANONYMOUS_QUARANTINE_ONLY' : 'LEGACY_DOCTOR',
    expected: { version: expectedVersion, device: options.expectedDevice || null },
    active: status ? {
      version: status.version ?? null,
      deviceName: status.deviceName ?? null,
      configSha256: status.configSha256 ?? null,
      protocols: status.protocols ?? [],
      powerModeEnabled: status.powerMode?.enabled === true,
      fullFilesystem: status.powerMode?.fullFilesystem === true,
      guiEnabled: status.guiControl?.enabled === true
    } : null,
    tools: { count: toolNames.length, guiCount: toolNames.filter((name) => name.startsWith('gui_')).length },
    checks,
    warnings
  };
}

function printHuman(report) {
  for (const check of report.checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}: ${check.detail}`);
  }
  for (const warning of report.warnings) console.log(`WARN  ${warning}`);
  console.log(report.ok ? (report.qualificationScope === 'ANONYMOUS_QUARANTINE_ONLY' ? 'REMOTE_COMMANDER_QUARANTINE_ONLY_PASS' : 'REMOTE_COMMANDER_DOCTOR_PASS') : 'REMOTE_COMMANDER_DOCTOR_FAIL');
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = await runDoctor(options);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printHuman(report);
    process.exitCode = report.ok ? 0 : 2;
  } catch (error) {
    console.error(`REMOTE_COMMANDER_DOCTOR_ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invoked === import.meta.url) await main();
