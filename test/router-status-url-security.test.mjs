import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(repoRoot, 'tools', 'router-status.mjs');

// R062: A URL may identify the router's canonical status route, but never
// an arbitrary local-service endpoint. This fixture opens only 127.0.0.1.
function invoke(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      tool, '--url', url, '--port', '48320', '--timeout-ms', '1000'
    ], { cwd: repoRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('R062_ROUTER_STATUS_CHILD_TIMEOUT'));
    }, 5000);
    child.once('close', code => {
      clearTimeout(killer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.once('error', error => {
      clearTimeout(killer);
      reject(error);
    });
  });
}

test('R062: router status URL rejects side-effect routes before making any request', async t => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      ok: true, router: true, inflightByPort: { '48320': 0 },
      inflightDetailsByPort: { '48320': [] }
    }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const prefix = 'http://127.0.0.1:' + port;
  try {
    const malicious = [
      ['non_router_path', prefix + '/private-action'],
      ['localhost_dns_lookup', 'http://localhost:' + port + '/router/status'],
      ['credentialed_origin', 'http://user@127.0.0.1:' + port + '/router/status'],
      ['query_string', prefix + '/router/status?unexpected=yes'],
      ['fragment', prefix + '/router/status#fragment'],
      ['non_http_scheme', 'https://127.0.0.1:' + port + '/router/status'],
      ['trailing_path_segment', prefix + '/router/status/'],
      ['untrusted_privileged_port', 'http://127.0.0.1:77/router/status'],
      ['private_route_with_query', prefix + '/private-action?redirect=/router/status']
    ];
    for (const [label, url] of malicious) {
      await t.test('fail-closed ' + label, async () => {
        const before = requests.length;
        const result = await invoke(url);
        assert.notEqual(result.code, 0, 'unsafe URL was accepted');
        assert.equal(requests.length, before, 'unsafe URL reached the local network');
      });
    }
    await t.test('canonical numeric-loopback status stays usable', async () => {
      const result = await invoke(prefix + '/router/status');
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, '0');
      assert.deepEqual(requests, ['/router/status']);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
