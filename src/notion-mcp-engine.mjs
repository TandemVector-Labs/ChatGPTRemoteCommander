// Opt-in Notion-hosted MCP OAuth 2.0/PKCE client. No provider secrets in code or MCP results.
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createNotionVault } from './notion-engine.mjs';

const RESOURCE = 'https://mcp.notion.com/mcp';
const codeError = code => Object.assign(new Error(code), { code });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const required = (value, code) => { if (!value) throw codeError(code); return value; };
function notionHttps(value, code = 'NOTION_MCP_DISCOVERY_UNTRUSTED') {
  let u;
  try { u = new URL(value); } catch { throw codeError(code); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash ||
      !(u.hostname === 'notion.com' || u.hostname.endsWith('.notion.com'))) throw codeError(code);
  return u.href;
}
function callbackTarget(value) {
  let u;
  try { u = new URL(value); } catch { throw codeError('NOTION_MCP_CALLBACK_INVALID'); }
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' ||
      !/^\d+$/.test(u.port) || Number(u.port) < 1024 || Number(u.port) > 65535 ||
      u.pathname !== '/notion/mcp/callback' || u.search || u.hash) throw codeError('NOTION_MCP_CALLBACK_INVALID');
  return u;
}
function safeOutput(json, maximum = 32000) {
  if (Buffer.byteLength(JSON.stringify(json)) > maximum) throw codeError('NOTION_MCP_RESPONSE_TOO_LARGE');
  return json;
}
async function fetchJson(fetchImpl, url, init = {}) {
  let res;
  try { res = await fetchImpl(notionHttps(url), { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
  catch { throw codeError('NOTION_MCP_NETWORK_FAILURE'); }
  if (!res.ok) throw codeError('NOTION_MCP_HTTP_' + res.status);
  const data = await res.json();
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw codeError('NOTION_MCP_INVALID_RESPONSE');
  return data;
}
// Bound transport responses while reading, rather than only after a potentially
// unbounded HTTP body has already been buffered in memory.
async function readBoundedBody(res, maximum = 32768) {
  if (!res.body?.getReader) {
    const text = await res.text();
    if (Buffer.byteLength(text) > maximum) throw codeError('NOTION_MCP_RESPONSE_TOO_LARGE');
    return text;
  }
  const reader = res.body.getReader();
  const parts = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) {
        await reader.cancel().catch(() => {});
        throw codeError('NOTION_MCP_RESPONSE_TOO_LARGE');
      }
      parts.push(value);
    }
    return Buffer.concat(parts).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}
export function generatePKCE() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}
export class NotionMcpEngine {
  constructor({ config = {}, profile = 'default', fetchImpl = globalThis.fetch, vault } = {}) {
    this.config = config;
    this.profile = profile;
    this.fetch = fetchImpl;
    this.vault = vault ?? (config.enabled === true
      ? createNotionVault({ profile: 'mcp-' + profile }) : { available: false, backend: 'disabled' });
    this.pending = null;
    this.server = null;
    this.verifiedAt = null;
    this.session = null;
  }
  async status() {
    if (this.config.enabled !== true) return { enabled: false, connected: false };
    const record = this.vault.available ? await this.vault.load().catch(() => null) : null;
    return { enabled: true, connected: Boolean(record?.access_token),
      vault: this.vault.backend, vaultAvailable: this.vault.available,
      workspaceId: record?.workspace_id ?? null,
      userId: record?.user_id ?? null,
      verifiedAt: this.verifiedAt,
      loginPending: Boolean(this.pending && Date.now() < this.pending.expiresAt) };
  }
  async metadata() {
    const resource = await fetchJson(this.fetch, 'https://mcp.notion.com/.well-known/oauth-protected-resource');
    const authorizationServer = required(resource.authorization_servers?.[0], 'NOTION_MCP_NO_AUTH_SERVER');
    const server = notionHttps(authorizationServer);
    const base = new URL(server);
    const metadata = await fetchJson(this.fetch, new URL('/.well-known/oauth-authorization-server', base).href);
    if (metadata.issuer) notionHttps(metadata.issuer);
    if (metadata.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes('S256'))
      throw codeError('NOTION_MCP_PKCE_UNSUPPORTED');
    return {
      authorization_endpoint: notionHttps(required(metadata.authorization_endpoint, 'NOTION_MCP_NO_AUTH_ENDPOINT')),
      token_endpoint: notionHttps(required(metadata.token_endpoint, 'NOTION_MCP_NO_TOKEN_ENDPOINT')),
      registration_endpoint: notionHttps(required(metadata.registration_endpoint, 'NOTION_MCP_NO_REGISTRATION_ENDPOINT'))
    };
  }
  async connectStart() {
    if (this.config.enabled !== true) throw codeError('NOTION_MCP_DISABLED');
    if (!this.vault.available) throw codeError('NOTION_MCP_VAULT_UNAVAILABLE');
    if (this.pending && Date.now() < this.pending.expiresAt) {
      return { status: 'AWAITING_USER_CONSENT', authorizationUrl: this.pending.authorizationUrl,
        expiresInSeconds: Math.ceil((this.pending.expiresAt - Date.now()) / 1000) };
    }
    const callback = callbackTarget(this.config.redirectUri);
    const metadata = await this.metadata();
    const registration = await fetchJson(this.fetch, metadata.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_name: 'ChatGPT Remote Commander',
        redirect_uris: [callback.href], grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'], token_endpoint_auth_method: 'none' })
    });
    if (!registration.client_id || typeof registration.client_id !== 'string' || registration.client_id.length > 500)
      throw codeError('NOTION_MCP_INVALID_CLIENT_REGISTRATION');
    const { verifier, challenge } = generatePKCE();
    const state = randomBytes(32).toString('hex');
    const auth = new URL(metadata.authorization_endpoint);
    Object.entries({ response_type: 'code', client_id: registration.client_id,
      redirect_uri: callback.href, state, code_challenge: challenge,
      code_challenge_method: 'S256', prompt: 'consent' })
      .forEach(([name, value]) => auth.searchParams.set(name, value));
    const server = http.createServer((req, res) => {
      this.callback(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('Notion authorization failed. Return to Commander.');
      });
    });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(Number(callback.port), '127.0.0.1', resolve);
      });
    } catch { server.close(); throw codeError('NOTION_MCP_CALLBACK_PORT_UNAVAILABLE'); }
    this.server = server;
    this.pending = {
      state, verifier, metadata, clientId: registration.client_id,
      redirectUri: callback.href, authorizationUrl: auth.href,
      expiresAt: Date.now() + 600000
    };
    const timer = setTimeout(() => {
      if (this.server === server) { this.pending = null; this.server = null; server.close(); }
    }, 600000);
    timer.unref();
    server.once('close', () => clearTimeout(timer));
    return { status: 'AWAITING_USER_CONSENT', authorizationUrl: auth.href, expiresInSeconds: 600 };
  }
  async callback(req, res) {
    const redirect = callbackTarget(this.config.redirectUri);
    if (req.method !== 'GET') throw codeError('NOTION_MCP_BAD_CALLBACK');
    const url = new URL(req.url, redirect.origin);
    const p = this.pending;
    if (url.pathname !== redirect.pathname || !p || Date.now() > p.expiresAt ||
      url.searchParams.get('state') !== p.state) throw codeError('NOTION_MCP_INVALID_STATE');
    this.pending = null;
    try {
      if (url.searchParams.has('error') || !url.searchParams.get('code')) throw codeError('NOTION_MCP_DENIED');
      const body = new URLSearchParams({
        grant_type: 'authorization_code', code: url.searchParams.get('code'),
        client_id: p.clientId, redirect_uri: p.redirectUri, code_verifier: p.verifier
      });
      const tokens = await fetchJson(this.fetch, p.metadata.token_endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json' }, body: String(body)
      });
      if (!tokens.access_token || typeof tokens.access_token !== 'string')
        throw codeError('NOTION_MCP_INVALID_TOKEN');
      await this.vault.save({
        access_token: tokens.access_token, refresh_token: tokens.refresh_token ?? null,
        workspace_id: tokens.workspace_id ?? null, user_id: tokens.user_id ?? null,
        client_id: p.clientId, token_endpoint: p.metadata.token_endpoint
      });
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Notion MCP connected. You may close this page.');
    } finally {
      if (this.server) { const active = this.server; this.server = null; active.close(); }
    }
  }
  async verify() {
    if (this.config.enabled !== true) throw codeError('NOTION_MCP_DISABLED');
    if (!this.vault.available) throw codeError('NOTION_MCP_VAULT_UNAVAILABLE');
    let creds = await this.vault.load();
    if (!creds?.access_token) throw codeError('NOTION_MCP_NOT_CONNECTED');
    // The first request uses the standard Streamable HTTP MCP initialize exchange.
    let response = await this.mcpPost(creds.access_token, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {},
        clientInfo: { name: 'chatgpt-remote-commander', version: '0.10.25' } }
    });
    if (response.httpStatus === 401 && creds.refresh_token) {
      const refreshed = await fetchJson(this.fetch, required(creds.token_endpoint,'NOTION_MCP_NO_REFRESH_ENDPOINT'), {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json' },
        body: String(new URLSearchParams({ grant_type:'refresh_token', refresh_token: creds.refresh_token, client_id: creds.client_id }))
      });
      if (!refreshed.access_token) throw codeError('NOTION_MCP_REAUTHORIZE_REQUIRED');
      creds = { ...creds, access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token ?? creds.refresh_token };
      await this.vault.save(creds);
      response = await this.mcpPost(creds.access_token, {
        jsonrpc:'2.0', id:1, method:'initialize', params:{
          protocolVersion:'2025-06-18', capabilities:{},
          clientInfo:{ name:'chatgpt-remote-commander', version:'0.10.25' }
        }
      });
    }
    if (response.httpStatus !== 200 || response.payload?.error || !response.payload?.result?.protocolVersion)
      throw codeError('NOTION_MCP_INITIALIZE_FAILED');
    const negotiated = response.payload.result.protocolVersion;
    if (negotiated !== '2025-06-18') throw codeError('NOTION_MCP_VERSION_UNSUPPORTED');
    this.session = { token: creds.access_token, id: response.sessionId ?? null, version: negotiated };
    try {
      await this.mcpPost(creds.access_token,
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { sessionId: this.session.id, protocolVersion: negotiated });
    } catch (error) { this.session = null; throw error; }
    this.verifiedAt = new Date().toISOString();
    return { connected: true, protocolVersion: response.payload.result.protocolVersion,
      serverName: String(response.payload.result.serverInfo?.name ?? '').slice(0,120),
      workspaceId: creds.workspace_id ?? null, verifiedAt: this.verifiedAt };
  }
  async listTools() {
    if (!this.session) await this.verify();
    const answer = await this.mcpPost(this.session.token,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { sessionId: this.session.id, protocolVersion: this.session.version });
    const items = answer.payload?.result?.tools;
    if (!Array.isArray(items) || items.length > 200 || answer.payload?.error) throw codeError('NOTION_MCP_TOOLS_INVALID');
    return { count: items.length, names: items.map(item => item.name)
      .filter(name => typeof name === 'string' && /^notion-[a-z0-9-]{1,70}$/.test(name)) };
  }
  async fetchSelf() {
    const listing = await this.listTools();
    if (!listing.names.includes('notion-fetch')) throw codeError('NOTION_MCP_FETCH_UNAVAILABLE');
    const answer = await this.mcpPost(this.session.token, { jsonrpc: '2.0', id: 3,
      method: 'tools/call', params: { name: 'notion-fetch', arguments: { id: 'self' } } },
      { sessionId: this.session.id, protocolVersion: this.session.version });
    if (answer.payload?.error || answer.payload?.result?.isError) throw codeError('NOTION_MCP_FETCH_FAILED');
    const result = answer.payload?.result;
    let content = result?.structuredContent;
    if (!content) {
      const text = result?.content?.find(item => item.type === 'text')?.text;
      if (!text || Buffer.byteLength(text) > 16000) throw codeError('NOTION_MCP_SELF_INVALID');
      try { content = JSON.parse(text); } catch { throw codeError('NOTION_MCP_SELF_INVALID'); }
    }
    const self = content?.self ?? content;
    if (!self || typeof self !== 'object') throw codeError('NOTION_MCP_SELF_INVALID');
    const access = self.current_tool_access?.ai_search?.status;
    return { workspaceId: String(self.workspace_id ?? self.workspace?.id ?? '').slice(0,100) || null,
      workspaceName: String(self.workspace_name ?? self.workspace?.name ?? '').slice(0,150) || null,
      userId: String(self.user_id ?? self.user?.id ?? '').slice(0,100) || null,
      aiSearchStatus: ['available','available_with_limit','upgrade_required','plan_required','not_enabled'].includes(access)
        ? access : 'unknown' };
  }
  async fetchPage({ pageId } = {}) {
    if (typeof pageId !== 'string' || !/^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$/.test(pageId))
      throw codeError('NOTION_MCP_PAGE_ID_INVALID');
    const normalized = pageId.replace(/-/g, '').toLowerCase();
    if (!this.session) await this.verify();
    const available = await this.listTools();
    if (!available.names.includes('notion-fetch')) throw codeError('NOTION_MCP_FETCH_UNAVAILABLE');
    const result = await this.mcpPost(this.session.token,
      { jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'notion-fetch', arguments: { id: normalized } } },
      { sessionId: this.session.id, protocolVersion: this.session.version });
    if (result.payload?.error || result.payload?.result?.isError) throw codeError('NOTION_MCP_PAGE_FETCH_FAILED');
    const value = result.payload?.result;
    const content = value?.content?.find(item => item.type === 'text' && typeof item.text === 'string')?.text
      ?? (typeof value?.structuredContent?.text === 'string' ? value.structuredContent.text : null);
    if (content === null) throw codeError('NOTION_MCP_PAGE_CONTENT_INVALID');
    const maxOutput = 6000;
    return { pageId: normalized, content: content.slice(0, maxOutput),
      textTruncated: content.length > maxOutput, contentBytes: Buffer.byteLength(content) };
  }
  async mcpPost(token, rpc, { sessionId = null, protocolVersion = '2025-06-18' } = {}) {
    // The official Notion MCP tools/list payload contains large JSON schemas.
    // Raise the in-memory bound ONLY for read-only discovery and fixed self fetch.
    // Public tool results remain sanitized and small.
    const fetchId = rpc.params?.arguments?.id;
    const isNotionPageFetch = typeof fetchId === 'string'
      && /^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$/.test(fetchId);
    const responseLimit = rpc.method === 'tools/list' ? 512 * 1024
      : rpc.method === 'tools/call' && rpc.params?.name === 'notion-fetch'
        && (fetchId === 'self' || isNotionPageFetch) ? 256 * 1024
        : 32768;
    if (sessionId && !/^[\x21-\x7e]{1,256}$/.test(sessionId)) throw codeError('NOTION_MCP_SESSION_INVALID');
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': protocolVersion };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    let res;
    try {
      res = await this.fetch(RESOURCE, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
        headers, body: JSON.stringify(rpc)
      });
    } catch { throw codeError('NOTION_MCP_NETWORK_FAILURE'); }
    if (res.status === 401) return { httpStatus:401 };
    if (!res.ok) throw codeError('NOTION_MCP_HTTP_' + res.status);
    if (!Object.hasOwn(rpc, 'id')) {
      if (res.status !== 202 && res.status !== 204) throw codeError('NOTION_MCP_NOTIFICATION_FAILED');
      return { httpStatus: res.status, payload: null };
    }
    const receivedSessionId = res.headers?.get?.('mcp-session-id') ?? null;
    if (receivedSessionId && !/^[\x21-\x7e]{1,256}$/.test(receivedSessionId))
      throw codeError('NOTION_MCP_SESSION_INVALID');
    const contentType = String(res.headers?.get?.('content-type') ?? '').toLowerCase();
    let payload;
    if (contentType.includes('application/json')) {
      try { payload = JSON.parse(await readBoundedBody(res, responseLimit)); }
      catch (error) {
        if (error.code === 'NOTION_MCP_RESPONSE_TOO_LARGE') throw error;
        throw codeError('NOTION_MCP_INVALID_RESPONSE');
      }
    } else if (contentType.includes('text/event-stream')) {
      const raw = await readBoundedBody(res, responseLimit);
      const events = raw.split(/\r?\n\r?\n/);
      const data = events.flatMap(event => event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()));
      const entry = data.find(text => { try { const parsed = JSON.parse(text); return parsed.id === rpc.id; } catch { return false; } });
      if (!entry) throw codeError('NOTION_MCP_NO_RESPONSE');
      payload = JSON.parse(entry);
    } else throw codeError('NOTION_MCP_UNSUPPORTED_RESPONSE');
    if (payload?.id !== rpc.id || (!payload.result && !payload.error)) throw codeError('NOTION_MCP_INVALID_RESPONSE');
    return { httpStatus:res.status, payload:safeOutput(payload, responseLimit), sessionId: receivedSessionId };
  }
}
export function createNotionMcpTools(args = {}) {
  const engine = new NotionMcpEngine(args);
  const readOnly = { readOnlyHint:true, destructiveHint:false, openWorldHint:false };
  const action = { readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:true };
  const schema = { type:'object', properties:{}, additionalProperties:false };
  const pageSchema = { type:'object', properties:{ pageId: { type:'string', minLength:32, maxLength:36,
    description:'Notion page UUID, with or without dashes.' } }, required:['pageId'], additionalProperties:false };
  return { engine, definitions:[
    { name:'notion_mcp_status', description:'Check independent Notion MCP account connection status without secrets.', inputSchema:schema, annotations:readOnly },
    { name:'notion_mcp_connect_start', description:'Start independent official Notion MCP OAuth/PKCE authorization; returns URL for owner consent.', inputSchema:schema, annotations:action },
    { name:'notion_mcp_verify', description:'Verify hosted MCP initialize and initialized lifecycle; never reveals credentials.', inputSchema:schema, annotations:readOnly },
    { name:'notion_mcp_list_tools', description:'Read bounded list of hosted Notion MCP tool names after authorization.', inputSchema:schema, annotations:readOnly },
    { name:'notion_mcp_fetch_self', description:'Read sanitized connected Notion workspace identity and AI-search availability.', inputSchema:schema, annotations:readOnly },
    { name:'notion_mcp_fetch_page', description:'Fetch a user-authorized Notion page by strict UUID; 6,000-character read-only preview with truncation metadata.', inputSchema:pageSchema, annotations:readOnly }
  ], execute: async (name, args = {}) => {
    switch (name) {
      case 'notion_mcp_status': return engine.status();
      case 'notion_mcp_connect_start': return engine.connectStart();
      case 'notion_mcp_verify': return engine.verify();
      case 'notion_mcp_list_tools': return engine.listTools();
      case 'notion_mcp_fetch_self': return engine.fetchSelf();
      case 'notion_mcp_fetch_page': return engine.fetchPage(args);
      default: throw codeError('NOTION_MCP_UNKNOWN_TOOL');
    }
  } };
}
