import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../tools/router-status.mjs', import.meta.url));
async function fixture(fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, {'content-type': 'application/json', 'connection': 'close'});
    res.end(JSON.stringify({
      ok: true, router: true,
      inflightByPort: {'47831': 2},
      inflightDetailsByPort: {'47831': [{cancellable: true}, {cancellable: true}]}
    }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try { await fn({port: server.address().port, requests}); }
  finally {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
}
async function run(url, extra = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      cli, '--url', url, '--port', '47831', '--timeout-ms', '1500', ...extra
    ], {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({code, signal, stdout, stderr}));
  });
}

test('router status CLI refuses non-router local URL paths without any HTTP I/O', async () => {
  await fixture(async ({port, requests}) => {
    const x = await run('http://127.0.0.1:'+port+'/not-the-router');
    assert.notEqual(x.code, 0);
    assert.deepEqual(requests, []);
  });
});

test('router status CLI refuses query and userinfo on a loopback target before HTTP I/O', async () => {
  await fixture(async ({port, requests}) => {
    for (const url of [
      'http://127.0.0.1:'+port+'/router/status?leak=yes',
      'http://user:secret@127.0.0.1:'+port+'/router/status',
      'http://127.0.0.1:'+port+'/router/status#fragment'
    ]) {
      const x = await run(url);
      assert.notEqual(x.code, 0, url);
    }
    assert.deepEqual(requests, []);
  });
});

test('router status CLI preserves fixed local router/status and cancellable count contracts', async () => {
  await fixture(async ({port, requests}) => {
    const url = 'http://127.0.0.1:'+port+'/router/status';
    const standard = await run(url);
    assert.equal(standard.code, 0, standard.stderr);
    assert.equal(standard.stdout.trim(), '2');
    const json = await run(url, ['--json']);
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), {
      count: 2, cancellableOnly: true, details: [{cancellable: true}, {cancellable: true}]
    });
    assert.deepEqual(requests, ['/router/status', '/router/status']);
  });
});