#!/usr/bin/env node
// User-local, opt-in Notion MCP OAuth/PKCE login. No cookies, browser secrets or static client credentials.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { NotionMcpEngine } from '../src/notion-mcp-engine.mjs';

export function parseLoginArgs(argv) {
  const result = { profile: 'default', port: 49732, openBrowser: false, help: false, probe: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--open-browser') result.openBrowser = true;
    else if (arg === '--probe') result.probe = true;
    else if (arg === '--profile' || arg === '--port') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error('NOTION_LOGIN_ARGUMENT_REQUIRED');
      result[arg === '--profile' ? 'profile' : 'port'] = argv[++i];
    } else throw new Error('NOTION_LOGIN_ARGUMENT_UNKNOWN');
  }
  if (!/^[A-Za-z0-9_-]{1,76}$/.test(result.profile)) throw new Error('NOTION_LOGIN_PROFILE_INVALID');
  const port = Number(result.port);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('NOTION_LOGIN_PORT_INVALID');
  result.port = port;
  if (result.help && argv.length > 1) throw new Error('NOTION_LOGIN_ARGUMENTS_INVALID');
  return result;
}
export async function openOfficialLogin(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !(target.hostname === 'notion.com' || target.hostname.endsWith('.notion.com'))
      || target.username || target.password || target.port || target.hash) {
    throw new Error('NOTION_LOGIN_AUTH_URL_UNTRUSTED');
  }
  const command = platform === 'win32' ? 'explorer.exe' : platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawnImpl(command, [url], { windowsHide: true, stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref?.();
}
export async function runLogin(argv, { output = console.log, engineFactory = config => new NotionMcpEngine(config),
  open = openOfficialLogin } = {}) {
  const opts = parseLoginArgs(argv);
  if (opts.help) {
    output('Usage: node tools/notion-login.mjs [--profile PROFILE] [--port 49732] [--open-browser] [--probe]');
    output('Requires owner approval in the official Notion browser page. Tokens stay in the OS vault.');
    return 0;
  }
  const engine = engineFactory({ config: { enabled: true,
    redirectUri: 'http://127.0.0.1:' + opts.port + '/notion/mcp/callback' }, profile: opts.profile });
  const initial = await engine.status();
  if (!initial.vaultAvailable) throw new Error('NOTION_LOGIN_SECURE_VAULT_REQUIRED');
  if (opts.probe) {
    const metadata = await engine.metadata();
    output('NOTION_OAUTH_DISCOVERY_OK ' + new URL(metadata.authorization_endpoint).hostname);
    return 0;
  }
  if (initial.connected) {
    const verified = await engine.verify();
    output('NOTION_ALREADY_CONNECTED ' + (verified.workspaceId ?? 'workspace-not-disclosed'));
    return 0;
  }
  const started = await engine.connectStart();
  output('NOTION_OWNER_CONSENT_REQUIRED - open this on the SAME computer running Commander.');
  if (opts.openBrowser) {
    await open(started.authorizationUrl);
    output('NOTION_AUTHORIZATION_BROWSER_OPEN_REQUESTED');
  } else {
    output('NOTION_AUTHORIZATION_URL ' + started.authorizationUrl);
  }
  const server = engine.server;
  if (!server) throw new Error('NOTION_LOGIN_CALLBACK_NOT_STARTED');
  let interrupted = false;
  const terminate = () => {
    interrupted = true;
    engine.pending = null;
    if (engine.server) { engine.server.close(); engine.server = null; }
  };
  process.once('SIGINT', terminate);
  process.once('SIGTERM', terminate);
  try {
    await new Promise(resolve => { if (!server.listening) return resolve(); server.once('close', resolve); });
  } finally {
    process.off('SIGINT', terminate);
    process.off('SIGTERM', terminate);
  }
  if (interrupted) throw new Error('NOTION_LOGIN_INTERRUPTED');
  const after = await engine.status();
  if (!after.connected) throw new Error('NOTION_LOGIN_NOT_AUTHORIZED_OR_EXPIRED');
  const verified = await engine.verify();
  output('NOTION_MCP_CONNECTED ' + (verified.workspaceId ?? 'workspace-id-unavailable'));
  try {
    const identity = await engine.fetchSelf();
    output('NOTION_WORKSPACE ' + (identity.workspaceName ?? identity.workspaceId ?? 'unavailable'));
  } catch { output('NOTION_READ_ONLY_IDENTITY_NOT_YET_VERIFIED'); }
  return 0;
}
const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  runLogin(process.argv.slice(2)).then(code => { process.exitCode = code; },
    err => { console.error('NOTION_LOGIN_GATE_OPEN ' + (err.code ?? err.message));
      process.exitCode = 1; });
}
