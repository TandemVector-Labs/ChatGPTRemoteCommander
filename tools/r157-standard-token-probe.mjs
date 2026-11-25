import { probeWindowsAdministrator } from '../src/windows-admin-token.mjs';

const result = await probeWindowsAdministrator();
const summary = {
  ok: result?.ok === true,
  isAdmin: result?.isAdmin === true,
  isSystem: result?.isSystem === true,
  elevation: typeof result?.elevation === 'string' ? result.elevation : null,
  source: typeof result?.source === 'string' ? result.source : null,
  code: typeof result?.code === 'string' ? result.code : null
};
console.log('R157_NODE_TOKEN_PROBE=' + JSON.stringify(summary));
if (!summary.ok || summary.isAdmin || summary.isSystem ||
    summary.elevation !== 'standard' || summary.source !== 'local-process-token') {
  process.exitCode = 1;
}
