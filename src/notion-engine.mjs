import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, lstat, unlink } from 'node:fs/promises';

const API = 'https://api.notion.com/v1';
const VERSION = '2026-03-11';
const MAX_RESULT_BYTES = 24_000;
const timeout = ms => AbortSignal.timeout(ms);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
function fail(code) { const error = new Error(code); error.code = code; return error; }
function notionTitle(item) {
  const property = Object.values(item?.properties ?? {}).find(value => value?.type === 'title' || Array.isArray(value?.title));
  const fragments = property?.title ?? item?.title ?? [];
  return Array.isArray(fragments) ? fragments.map(value => value.plain_text ?? value.text?.content ?? '').join('') : '';
}
function blockPreview(item) {
  const content = item[item.type] ?? {};
  const text = (content.rich_text ?? content.caption ?? []).map(value => value.plain_text ?? value.text?.content ?? '').join('');
  return { object: 'block', id: item.id, type: item.type, has_children: item.has_children === true,
    text: text.slice(0, 1000), textTruncated: text.length > 1000, textLength: text.length };
}
function publicSummary(object) {
  if (!object || typeof object !== 'object') return object;
  const { object: kind, id, url, workspace_id, workspace_name, bot_id, has_more, next_cursor } = object;
  if (Array.isArray(object.results)) {
    return { results: object.results.map(item => item.object === 'block'
      ? blockPreview(item)
      : { object: item.object, id: item.id, url: item.url, title: notionTitle(item) }),
      has_more, next_cursor };
  }
  return { object: kind, id, url, workspace_id, workspace_name, bot_id,
    parent: object.parent, last_edited_time: object.last_edited_time,
    title: notionTitle(object) };
}
function bounded(data) {
  const value = publicSummary(data);
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_RESULT_BYTES) throw fail('NOTION_RESPONSE_TOO_LARGE');
  return value;
}
async function processInput(command, args, input, { emptyExitOneIsNotFound = false } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    const kill = setTimeout(() => child.kill(), 8000).unref();
    child.stdout.on('data', chunk => { stdout += String(chunk); if (stdout.length > 300_000) child.kill(); });
    child.stderr.on('data', chunk => { stderr += String(chunk); if (stderr.length > 8000) child.kill(); });
    child.once('error', reject);
    child.once('close', code => { clearTimeout(kill); code === 0 || (emptyExitOneIsNotFound && code === 1 && !stdout.trim() && !stderr.trim()) ? resolve(stdout.trim()) : reject(fail('NOTION_VAULT_UNAVAILABLE')); });
    child.stdin.end(input);
  });
}
function dpapiScript(action) {
  return action === 'protect'
    ? '$ErrorActionPreference="Stop"; $text=[Console]::In.ReadToEnd(); $secure=ConvertTo-SecureString -String $text -AsPlainText -Force; [Console]::Out.Write((ConvertFrom-SecureString -SecureString $secure))'
    : '$ErrorActionPreference="Stop"; $text=[Console]::In.ReadToEnd(); $secure=ConvertTo-SecureString -String $text; [Console]::Out.Write(([pscredential]::new("Notion", $secure)).GetNetworkCredential().Password)';
}
// Tokens never travel through MCP tool arguments, stdout, repository files or audit records.
export function createNotionVault({ profile = 'default', directory = path.join(os.homedir(), '.config', 'ChatGPTRemoteCommander', 'notion') } = {}) {
  if (!safeId(profile)) throw fail('NOTION_PROFILE_INVALID');
  const location = path.join(directory, profile + '.dpapi');
  const platform = process.platform;
  const powershell = platform === 'win32'
    ? (spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { windowsHide: true }).status === 0 ? 'pwsh' : 'powershell.exe')
    : null;
  const available = platform === 'win32' || (platform === 'linux' && spawnSync('secret-tool', ['--version'], { windowsHide: true }).error === undefined);
  const run = (operation, input) => processInput(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(dpapiScript(operation), 'utf16le').toString('base64')], input);
  return {
    backend: platform === 'win32' ? 'windows-dpapi' : platform === 'linux' ? 'libsecret' : 'unsupported',
    available,
    async load() {
      if (!available) throw fail('NOTION_VAULT_UNAVAILABLE');
      let ciphertext;
      if (platform === 'win32') {
        try { ciphertext = await readFile(location, 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        return JSON.parse(await run('unprotect', ciphertext));
      }
      const value = await processInput('secret-tool', ['lookup', 'service', 'remote-commander-notion', 'profile', profile], '', { emptyExitOneIsNotFound: true });
      return value ? JSON.parse(value) : null;
    },
    async clear() {
      if (!available) throw fail('NOTION_VAULT_UNAVAILABLE');
      if (platform === 'win32') {
        let record;
        try { record = await lstat(location); }
        catch (error) { if (error.code === 'ENOENT') return false; throw fail('NOTION_VAULT_UNAVAILABLE'); }
        if (!record.isFile() || record.isSymbolicLink())
          throw fail('NOTION_VAULT_UNSAFE_PATH');
        try { await unlink(location); }
        catch { throw fail('NOTION_VAULT_UNAVAILABLE'); }
        return true;
      }
      if (platform === 'linux') {
        await processInput('secret-tool',
          ['clear', 'service', 'remote-commander-notion', 'profile', profile], '');
        return true;
      }
      throw fail('NOTION_VAULT_UNAVAILABLE');
    },
    async save(record) {
      if (!available) throw fail('NOTION_VAULT_UNAVAILABLE');
      const plaintext = JSON.stringify(record);
      if (platform === 'win32') {
        const cipher = await run('protect', plaintext);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const tmp = location + '.' + randomBytes(8).toString('hex') + '.tmp';
        await writeFile(tmp, cipher, { mode: 0o600, flag: 'wx' });
        await rename(tmp, location);
      } else {
        await processInput('secret-tool', ['store', '--label=Remote Commander Notion', 'service', 'remote-commander-notion', 'profile', profile], plaintext);
      }
    }
  };
}
async function readJson(response) {
  if (!response.ok) throw fail('NOTION_HTTP_' + response.status);
  const content = await response.json();
  if (!content || typeof content !== 'object') throw fail('NOTION_INVALID_RESPONSE');
  return content;
}
function validateCallbackUri(uri) {
  const target = new URL(uri);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !/^\d+$/.test(target.port)
      || target.pathname !== '/notion/callback' || target.search || target.hash
      || Number(target.port) < 1024 || Number(target.port) > 65535) throw fail('NOTION_CALLBACK_INVALID');
  return target;
}
export class NotionEngine {
  constructor({ config = {}, profile = 'default', fetchImpl = globalThis.fetch, vault } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.vault = vault ?? (config.enabled ? createNotionVault({ profile }) : { available: false, backend: 'disabled' });
    this.profile = profile;
    this.pending = null;
    this.listener = null;
    this.nextAt = 0;
    this.lastVerifiedAt = null;
    this.queue = Promise.resolve();
  }
  async status() {
    if (!this.config.enabled) return { enabled: false, connected: false };
    const account = this.vault.available ? await this.vault.load().catch(() => null) : null;
    return { enabled: true, oauthConfigured: Boolean(this.config.clientId && process.env.REMOTE_COMMANDER_NOTION_CLIENT_SECRET),
      vault: this.vault.backend, vaultAvailable: this.vault.available, connected: Boolean(account?.access_token),
      credentialType: account?.access_token ? (account.auth_type === 'personal_access_token' ? 'personal_access_token' : 'oauth') : null,
      workspaceId: account?.workspace_id ?? null, workspaceName: account?.workspace_name ?? null,
      loginPending: Boolean(this.pending && Date.now() < this.pending.expiresAt),
      lastVerifiedAt: this.lastVerifiedAt };
  }
  async disconnect({ confirmed = false } = {}) {
    if (!this.config.enabled) throw fail('NOTION_DISABLED');
    if (confirmed !== true) throw fail('NOTION_DISCONNECT_CONFIRMATION_REQUIRED');
    if (!this.vault.available) throw fail('NOTION_VAULT_UNAVAILABLE');
    if (typeof this.vault.clear !== 'function') throw fail('NOTION_VAULT_UNAVAILABLE');
    const cleared = await this.vault.clear();
    this.lastVerifiedAt = null;
    return { connected: false, removed: cleared === true };
  }
  async importPersonalAccessToken(token, { replaceExisting = false } = {}) {
    if (!this.config.enabled) throw fail('NOTION_DISABLED');
    // Reject malformed input before accessing OS keyring: this must work even
    // on headless Linux CI without a local credential vault.
    // PATs are only received by the stdin-only local onboarding CLI.
    if (typeof token !== 'string' || !/^[A-Za-z0-9._-]{24,512}$/.test(token))
      throw fail('NOTION_PAT_INVALID_FORMAT');
    if (!this.vault.available) throw fail('NOTION_VAULT_UNAVAILABLE');
    const previous = await this.vault.load();
    if (previous?.access_token && replaceExisting !== true) throw fail('NOTION_ALREADY_CONNECTED');
    let response;
    try {
      response = await this.fetch(API + '/users/me', {
        method: 'GET', redirect: 'error', headers: {
          Authorization: 'Bearer ' + token, 'Notion-Version': VERSION,
          'Content-Type': 'application/json'
        }, signal: timeout(15_000)
      });
    } catch { throw fail('NOTION_PAT_VERIFICATION_UNAVAILABLE'); }
    if (!response?.ok) throw fail(response?.status === 401 || response?.status === 403
      ? 'NOTION_PAT_UNAUTHORIZED' : 'NOTION_PAT_VERIFICATION_FAILED');
    let account;
    try { account = await response.json(); }
    catch { throw fail('NOTION_PAT_VERIFICATION_FAILED'); }
    if (account?.object !== 'user' || typeof account?.id !== 'string'
      || !/^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$/.test(account.id))
      throw fail('NOTION_PAT_VERIFICATION_FAILED');
    await this.vault.save({
      access_token: token, refresh_token: null, auth_type: 'personal_access_token',
      workspace_id: null, workspace_name: null
    });
    this.lastVerifiedAt = new Date().toISOString();
    return { connected: true, credentialType: 'personal_access_token', verified: true };
  }
  async connectStart() {
    if (!this.config.enabled) throw fail('NOTION_DISABLED');
    if (!this.vault.available) throw fail('NOTION_VAULT_UNAVAILABLE');
    if (!safeId(this.config.clientId) || !process.env.REMOTE_COMMANDER_NOTION_CLIENT_SECRET) throw fail('NOTION_OAUTH_NOT_CONFIGURED');
    if (this.pending && Date.now() < this.pending.expiresAt) {
      return { status: 'AWAITING_USER_LOGIN', authorizationUrl: this.pending.authorizationUrl, expiresInSeconds: Math.ceil((this.pending.expiresAt - Date.now()) / 1000) };
    }
    const redirect = validateCallbackUri(this.config.redirectUri);
    const state = randomBytes(32).toString('hex');
    const auth = new URL('https://api.notion.com/v1/oauth/authorize');
    Object.entries({ client_id: this.config.clientId, redirect_uri: redirect.href,
      response_type: 'code', owner: 'user', state }).forEach(([key, value]) => auth.searchParams.set(key, value));
    const listener = http.createServer((req, res) => { this.handleCallback(req, res).catch(() => {
      res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Authorization failed. Return to Commander.'); });
    });
    try {
      await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(Number(redirect.port), '127.0.0.1', resolve); });
    } catch { listener.close(); throw fail('NOTION_CALLBACK_PORT_UNAVAILABLE'); }
    this.listener = listener;
    this.pending = { state, redirectUri: redirect.href, authorizationUrl: auth.href, expiresAt: Date.now() + 10 * 60_000 };
    const timer = setTimeout(() => { this.pending = null; listener.close(); if (this.listener === listener) this.listener = null; }, 10 * 60_000);
    timer.unref();
    listener.once('close', () => clearTimeout(timer));
    return { status: 'AWAITING_USER_LOGIN', authorizationUrl: auth.href, expiresInSeconds: 600 };
  }
  async handleCallback(req, res) {
    if (req.method !== 'GET') throw fail('NOTION_CALLBACK_INVALID');
    const redirect = validateCallbackUri(this.config.redirectUri);
    const url = new URL(req.url, redirect.origin);
    if (url.pathname !== redirect.pathname) throw fail('NOTION_CALLBACK_INVALID');
    const pending = this.pending;
    if (!pending || Date.now() > pending.expiresAt || url.searchParams.get('state') !== pending.state) throw fail('NOTION_OAUTH_STATE_INVALID');
    this.pending = null; // Consume exactly once, including on failure.
    const code = url.searchParams.get('code');
    try {
      if (url.searchParams.has('error') || !code) throw fail('NOTION_OAUTH_DENIED');
      const credentials = Buffer.from(this.config.clientId + ':' + process.env.REMOTE_COMMANDER_NOTION_CLIENT_SECRET).toString('base64');
      const result = await readJson(await this.fetch(API + '/oauth/token', { method: 'POST', redirect: 'error', headers: {
        Authorization: 'Basic ' + credentials, 'Content-Type': 'application/json', 'Notion-Version': VERSION
      }, body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: pending.redirectUri }), signal: timeout(15_000) }));
      if (!result.access_token || !result.workspace_id) throw fail('NOTION_INVALID_TOKEN_RESPONSE');
      await this.vault.save({
        access_token: result.access_token, refresh_token: result.refresh_token ?? null,
        workspace_id: result.workspace_id, workspace_name: result.workspace_name ?? null
      });
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Notion connected. You may close this page.');
    } finally {
      this.listener?.close(); this.listener = null;
    }
  }
  async refreshSession() {
    const current = await this.vault.load();
    if (!current?.refresh_token || !this.config.clientId || !process.env.REMOTE_COMMANDER_NOTION_CLIENT_SECRET) {
      throw fail('NOTION_REAUTHORIZE_REQUIRED');
    }
    const credentials = Buffer.from(this.config.clientId + ':' + process.env.REMOTE_COMMANDER_NOTION_CLIENT_SECRET).toString('base64');
    let response;
    try {
      response = await this.fetch(API + '/oauth/token', { method: 'POST', redirect: 'error', headers: {
        Authorization: 'Basic ' + credentials, 'Content-Type': 'application/json', 'Notion-Version': VERSION
      }, body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: current.refresh_token }), signal: timeout(15_000) });
    } catch { throw fail('NOTION_REFRESH_FAILED'); }
    if (!response.ok) throw fail('NOTION_REAUTHORIZE_REQUIRED');
    const result = await response.json();
    if (!result?.access_token) throw fail('NOTION_REFRESH_FAILED');
    const rotated = { ...current, access_token: result.access_token,
      refresh_token: result.refresh_token ?? current.refresh_token };
    await this.vault.save(rotated);
    return rotated.access_token;
  }
  async bearer() {
    if (!this.config.enabled) throw fail('NOTION_DISABLED');
    if (!this.vault.available) throw fail('NOTION_VAULT_UNAVAILABLE');
    const record = await this.vault.load();
    if (!record?.access_token) throw fail('NOTION_NOT_CONNECTED');
    return record.access_token;
  }
  async invoke(method, endpoint, body = undefined, { safe = false } = {}) {
    const task = async () => {
      let key = await this.bearer();
      let refreshed = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        const now = Date.now();
        if (this.nextAt > now) await sleep(this.nextAt - now);
        this.nextAt = Date.now() + 350;
        let response;
        try {
          response = await this.fetch(API + endpoint, { method, redirect: 'error', headers: {
            Authorization: 'Bearer ' + key, 'Notion-Version': VERSION,
            'Content-Type': 'application/json'
          }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: timeout(15_000) });
        } catch (error) { throw fail(error.name === 'TimeoutError' ? 'NOTION_TIMEOUT' : 'NOTION_NETWORK_ERROR'); }
        if (safe && response.status === 401 && !refreshed) {
          key = await this.refreshSession();
          refreshed = true;
          attempt--; continue;
        }
        if (safe && (response.status === 429 || response.status === 529 || [500, 502, 503, 504].includes(response.status)) && attempt < 3) {
          const header = Number(response.headers?.get?.('retry-after'));
          if (Number.isFinite(header) && header > 30) throw fail('NOTION_RATE_LIMIT_RETRY_LATER');
          const delay = Number.isFinite(header) && header > 0 ? header * 1000 : Math.min(2 ** attempt * 1000, 8000);
          await sleep(delay + Math.round(Math.random() * 150)); continue;
        }
        return bounded(await readJson(response));
      }
    };
    const work = this.queue.then(task);
    this.queue = work.catch(() => {});
    return work;
  }
  async verify() {
    const user = await this.invoke('GET', '/users/me', undefined, { safe: true });
    this.lastVerifiedAt = new Date().toISOString();
    return user;
  }
  search(query, pageSize = 20) {
    if (typeof query !== 'string' || query.length > 160 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw fail('NOTION_QUERY_INVALID');
    return this.invoke('POST', '/search', { query, page_size: pageSize }, { safe: true });
  }
  getPage(pageId) {
    if (!/^[a-f0-9-]{32,36}$/i.test(String(pageId))) throw fail('NOTION_PAGE_ID_INVALID');
    return this.invoke('GET', '/pages/' + pageId, undefined, { safe: true });
  }
  listBlockChildren(blockId, pageSize = 10, startCursor = undefined) {
    if (!/^[a-f0-9-]{32,36}$/i.test(String(blockId)) || !Number.isInteger(pageSize)
      || pageSize < 1 || pageSize > 20
      || (startCursor !== undefined && !/^[a-zA-Z0-9_-]{1,200}$/.test(startCursor))) throw fail('NOTION_BLOCK_QUERY_INVALID');
    const query = new URLSearchParams({ page_size: String(pageSize) });
    if (startCursor) query.set('start_cursor', startCursor);
    return this.invoke('GET', '/blocks/' + blockId + '/children?' + query, undefined, { safe: true });
  }
  createPage(parentPageId, title) {
    if (!this.config.allowWrites) throw fail('NOTION_WRITES_DISABLED');
    if (!/^[a-f0-9-]{32,36}$/i.test(String(parentPageId)) || typeof title !== 'string' || title.length < 1 || title.length > 160) throw fail('NOTION_CREATE_INVALID');
    return this.invoke('POST', '/pages', { parent: { type: 'page_id', page_id: parentPageId },
      properties: { title: { type: 'title', title: [{ type: 'text', text: { content: title } }] } } });
  }
}
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
export function createNotionTools({ config = {}, profile = 'default', fetchImpl, vault } = {}) {
  const engine = new NotionEngine({ config, profile, fetchImpl, vault });
  return {
    engine,
    definitions: [
      { name: 'notion_status', description: 'Local Notion connection status, never exposes tokens.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: readOnly },
      { name: 'notion_connect_start', description: 'Start one official Notion OAuth login via loopback callback; returns the authorization URL for the owner to open. Requires configured OAuth client and secure OS vault.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: write },
      { name: 'notion_verify', description: 'Verify the active Notion bearer credential against the real /users/me endpoint.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: readOnly },
      { name: 'notion_search', description: 'Search pages available to the authorized Notion account.', inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 160 }, pageSize: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['query'], additionalProperties: false }, annotations: readOnly },
      { name: 'notion_get_page', description: 'Read one authorized Notion page by ID.', inputSchema: { type: 'object', properties: { pageId: { type: 'string', pattern: '^[a-fA-F0-9-]{32,36}$' } }, required: ['pageId'], additionalProperties: false }, annotations: readOnly },
      { name: 'notion_list_block_children', description: 'Read paginated block previews. Child blocks require additional calls.', inputSchema: { type: 'object', properties: { blockId: { type: 'string', pattern: '^[a-fA-F0-9-]{32,36}$' }, pageSize: { type: 'integer', minimum: 1, maximum: 20 }, startCursor: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,200}$' } }, required: ['blockId'], additionalProperties: false }, annotations: readOnly },
      { name: 'notion_create_page', description: 'Create a page under the explicitly selected parent. Disabled unless notion.allowWrites is true. No automatic retries.', inputSchema: { type: 'object', properties: { parentPageId: { type: 'string', pattern: '^[a-fA-F0-9-]{32,36}$' }, title: { type: 'string', minLength: 1, maxLength: 160 } }, required: ['parentPageId', 'title'], additionalProperties: false }, annotations: write }
    ],
    async execute(name, args = {}) {
      switch (name) {
        case 'notion_status': return engine.status();
        case 'notion_connect_start': return engine.connectStart();
        case 'notion_verify': return engine.verify();
        case 'notion_search': return engine.search(args.query, args.pageSize);
        case 'notion_get_page': return engine.getPage(args.pageId);
        case 'notion_list_block_children': return engine.listBlockChildren(args.blockId, args.pageSize, args.startCursor);
        case 'notion_create_page': return engine.createPage(args.parentPageId, args.title);
        default: throw fail('NOTION_UNKNOWN_TOOL');
      }
    }
  };
}
