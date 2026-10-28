import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const TOOL_NAMES = new Set([
  'gui_status', 'gui_session_begin', 'gui_session_end', 'gui_screenshot',
  'gui_list_windows', 'gui_cursor_position'
]);
const PROFILE = 'owner-gui-v1';
const AUTH_PATTERN = /^[a-f0-9]{64}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function createOwnerGuiReadOnlyProxy({
  config, primaryStatus, fetchImpl = globalThis.fetch, readFileImpl = readFile
}) {
  const policy = config?.ownerGuiDelegation;
  if (policy?.enabled !== true) return null;
  if (config?.powerMode?.guiControl?.enabled !== true) throw Error('OWNER_GUI_CORE_GUI_DISABLED');
  const port = policy.port;
  const authFile = policy.authFile;
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw Error('OWNER_GUI_PORT_INVALID');
  if (typeof authFile !== 'string' || !path.isAbsolute(authFile)) throw Error('OWNER_GUI_AUTH_PATH_INVALID');
  if (typeof primaryStatus !== 'function' || typeof fetchImpl !== 'function') throw Error('OWNER_GUI_DEPENDENCIES_MISSING');
  const base = `http://127.0.0.1:${port}`;
  const timeoutMs = 4000;
  async function rpc(tool, args) {
    const secret = (await readFileImpl(authFile, 'utf8')).trim();
    if (!AUTH_PATTERN.test(secret)) throw Error('OWNER_GUI_CREDENTIAL_INVALID');
    const response = await fetchImpl(`${base}/mcp`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-rc-owner-gui-auth': secret },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args }
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (response.status !== 200) throw Error('OWNER_GUI_TRANSPORT_UNAVAILABLE');
    const text = await response.text();
    if (text.length > 8_000_000) throw Error('OWNER_GUI_RESPONSE_TOO_LARGE');
    let body;
    try { body = JSON.parse(text); } catch { throw Error('OWNER_GUI_INVALID_RESPONSE'); }
    if (body?.jsonrpc !== '2.0' || body?.id !== 1 || !body.result || body.error || body.result.isError === true)
      throw Error('OWNER_GUI_RPC_REJECTED');
    const result = body.result;
    if (Array.isArray(result.content) && result.content.some(c => c?.type === 'image')) {
      if (!result.structuredContent || typeof result.structuredContent !== 'object')
        throw Error('OWNER_GUI_IMAGE_METADATA_REQUIRED');
      return { __mcpContent: result.content, __structuredContent: result.structuredContent };
    }
    if (!result.structuredContent || typeof result.structuredContent !== 'object')
      throw Error('OWNER_GUI_STRUCTURE_REQUIRED');
    return result.structuredContent;
  }
  return {
    async execute(name, args = {}, context = {}) {
      if (!TOOL_NAMES.has(name)) return { handled: false };
      const primary = await primaryStatus();
      if (!primary || primary.enabled !== true || primary.available !== false ||
          primary.uncertain === true || primary.incidentPending === true ||
          primary.incidentStoreUnavailable === true || primary.blocked === true ||
          primary.reason === 'NATIVE_OUTCOME_UNCERTAIN_RESTART_REQUIRED') {
        // Never bypass a pending native effect or an unavailable incident store.
        return { handled: false };
      }
      if (primary.available === true) return { handled: false };
      if (name === 'gui_session_begin' && args.mode !== 'observe')
        throw Error('OWNER_GUI_OBSERVE_ONLY');
      if (name === 'gui_status') {
        const value = await rpc(name, args);
        if (value.available !== true || value.enabled !== true) return { handled: false };
        return { handled: true, value: { ...value, delegated: true, delegatedMode: 'observe' } };
      }
      let forwardedArgs = args;
      if (name === 'gui_session_begin' || name === 'gui_session_end') {
        const upstreamId = context.requestId;
        if (typeof upstreamId !== 'string' || !REQUEST_ID_PATTERN.test(upstreamId))
          throw Error('OWNER_GUI_REQUEST_ID_REQUIRED');
        const hash = createHash('sha256').update(PROFILE + ':' + name + ':' + upstreamId).digest('hex');
        forwardedArgs = { ...args, requestId: 'ogui-' + hash.slice(0, 48) };
      }
      const value = await rpc(name, forwardedArgs);
      return { handled: true, value };
    }
  };
}
