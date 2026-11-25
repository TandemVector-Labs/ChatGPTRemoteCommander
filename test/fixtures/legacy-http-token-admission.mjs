// Isolated test-only admission check for a legacy STANDARD loopback MCP fixture.
// Never weaken the production G1/HTTP quarantine to make hosted Windows CI green.
import assert from 'node:assert/strict';
import { probeWindowsAdministrator } from '../../src/windows-admin-token.mjs';

export async function requireNonElevatedLegacyHttp(t,port) {
  if (process.platform !== 'win32') return true;
  const token=await probeWindowsAdministrator();
  if (token?.ok===true && token.isAdmin===false &&
      token.isSystem===false && token.elevation==='standard') return true;

  const healthResponse=await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(healthResponse.status,200);
  const health=await healthResponse.json();
  assert.equal(health.privilegedLegacyHttpQuarantined,true);
  const response=await fetch(`http://127.0.0.1:${port}/mcp`,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:999,method:'tools/list',params:{}})
  });
  assert.equal(response.status,403);
  assert.deepEqual(await response.json(),{error:'trusted_transport_required'});
  t.skip('elevated or unverified Windows token: 403 quarantine verified; positive STANDARD requires non-admin host');
  return false;
}
