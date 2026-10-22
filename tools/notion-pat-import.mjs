#!/usr/bin/env node
// Local-only, stdin-only Notion personal access token enrollment.
// The token is never accepted as an argv or MCP tool argument.
import { NotionEngine } from '../src/notion-engine.mjs';

function options(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return { help: true };
  const parsed = { profile: 'default', stdin: false, status: false, verify: false, disconnect: false, confirmDisconnect: false, replaceExisting: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--profile' && args[i + 1]) { parsed.profile = args[++i]; continue; }
    if (args[i] === '--token-stdin' && !parsed.stdin) { parsed.stdin = true; continue; }
    if (args[i] === '--status' && !parsed.status) { parsed.status = true; continue; }
    if (args[i] === '--verify' && !parsed.verify) { parsed.verify = true; continue; }
    if (args[i] === '--disconnect' && !parsed.disconnect) { parsed.disconnect = true; continue; }
    if (args[i] === '--confirm-disconnect' && !parsed.confirmDisconnect) { parsed.confirmDisconnect = true; continue; }
    if (args[i] === '--replace-existing' && !parsed.replaceExisting) { parsed.replaceExisting = true; continue; }
    throw new Error('NOTION_PAT_CLI_ARGUMENT_INVALID');
  }
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(parsed.profile)) throw new Error('NOTION_PAT_PROFILE_INVALID');
  if ([parsed.status, parsed.stdin, parsed.verify, parsed.disconnect].filter(Boolean).length !== 1
      || (parsed.replaceExisting && !parsed.stdin)
      || (parsed.confirmDisconnect !== parsed.disconnect))
    throw new Error('NOTION_PAT_CLI_ARGUMENT_INVALID');
  return parsed;
}
async function readTokenStdin() {
  if (process.stdin.isTTY) throw new Error('NOTION_PAT_REQUIRES_PIPE');
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.byteLength;
    if (length > 1024) {
      for (const item of chunks) item.fill(0);
      throw new Error('NOTION_PAT_INPUT_TOO_LARGE');
    }
    chunks.push(Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  for (const item of chunks) item.fill(0);
  try { return buffer.toString('utf8').replace(/\r?\n$/, ''); }
  finally { buffer.fill(0); }
}
async function main() {
  const opts = options(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(
      'Usage: node tools/notion-pat-import.mjs (--token-stdin | --status | --verify | --disconnect --confirm-disconnect) [--profile default] [--replace-existing]\n' +
      'Token must arrive via stdin from a masked, owner-local terminal prompt.\n' +
      'Never place the token in command arguments, logs, Git or ChatGPT messages.\n'
    );
    return;
  }
  const engine = new NotionEngine({ config: { enabled: true }, profile: opts.profile });
  if (opts.status) {
    const state = await engine.status();
    const credential = state.connected ? (state.credentialType === 'personal_access_token' ? 'PAT' : 'OAUTH') : 'NONE';
    process.stdout.write(`NOTION_REST_STATUS ${state.connected ? 'CONNECTED' : 'DISCONNECTED'} ${credential} VAULT_${state.vaultAvailable ? 'READY' : 'UNAVAILABLE'}\n`);
    return;
  }
  if (opts.verify) {
    await engine.verify();
    process.stdout.write('NOTION_REST_VERIFIED\n');
    return;
  }
  if (opts.disconnect) {
    await engine.disconnect({ confirmed: opts.confirmDisconnect });
    process.stdout.write('NOTION_REST_DISCONNECTED\n');
    return;
  }
  const token = await readTokenStdin();
  await engine.importPersonalAccessToken(token, { replaceExisting: opts.replaceExisting });
  process.stdout.write('NOTION_REST_PAT_VERIFIED_AND_SAVED_IN_OS_VAULT\n');
}
main().catch(error => {
  const code = typeof error?.code === 'string' && /^NOTION_[A-Z0-9_]+$/.test(error.code)
    ? error.code : /^NOTION_[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message
      : 'NOTION_PAT_IMPORT_FAILED';
  process.stderr.write(code + '\n');
  process.exitCode = 1;
});
