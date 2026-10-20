import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHeadlessStatus, parseUnit, parseListeners,
  classifyHeadlessSeat, assess, executeReadOnly,
} from '../tools/linux-headless-seat-readiness.mjs';

const headlessDisabled = [
  'Overall:',
  '\tUnit status: inactive',
  'RDP:',
  '\tStatus: disabled',
  '\tPort: 3389',
  '\tAuthentication methods: credentials',
  '\tTLS certificate: /private/path/to/cert.pem',
  '\tTLS key: /private/path/to/key.pem',
  '\tUsername: (empty)',
  '\tPassword: (empty)',
].join('\n');
const headlessConfigured = headlessDisabled
  .replace('Unit status: inactive', 'Unit status: active')
  .replace('Status: disabled', 'Status: enabled')
  .replace('Username: (empty)', 'Username: private-account')
  .replace('Password: (empty)', 'Password: (set)');
const inactive = 'ActiveState=inactive\nUnitFileState=disabled\n';
const active = 'ActiveState=active\nUnitFileState=enabled\n';

test('headless status is parsed into nonsecret booleans; paths and identity not reflected', () => {
  const actual = parseHeadlessStatus(headlessDisabled);
  assert.deepEqual(actual, {
    observed: true, unitState: 'inactive', rdp: 'disabled',
    port: 3389, credentialMode: 'credentials',
    credentialsPresent: false, tlsPathsConfigured: true,
  });
  const configured = parseHeadlessStatus(headlessConfigured);
  assert.equal(configured.credentialsPresent, true);
  assert.equal(configured.rdp, 'enabled');
  for (const secret of ['private-account','/private/path/to/key.pem','/private/path/to/cert.pem','Password:']) {
    assert.equal(JSON.stringify(configured).includes(secret), false);
  }
});

test('socket report identifies matching wildcard and loopback endpoints', () => {
  const sockets = parseListeners([
    'LISTEN 0 5 *:3389 *:*',
    'LISTEN 0 10 127.0.0.1:3390 0.0.0.0:*',
    'LISTEN 0 10 [::1]:3391 [::]:*',
    'ESTAB 0 10 192.0.2.3:3392 192.0.2.4:*',
  ].join('\n'));
  assert.deepEqual(sockets, [
    { port:3389, scope:'potentially_network_reachable' },
    { port:3390, scope:'loopback' },
    { port:3391, scope:'loopback' },
  ]);
});

test('realistic GNOME 50 disabled headless and existing shared desktop port is NOT_READY', () => {
  const report = classifyHeadlessSeat({
    headless: parseHeadlessStatus(headlessDisabled),
    headlessUnit: parseUnit(inactive),
    sharingUnit: parseUnit(active),
    listeners: parseListeners('LISTEN 0 5 *:3389 *:*'),
  });
  assert.equal(report.admission, 'NOT_READY');
  assert.equal(report.configuredPortAlreadyListening, true);
  assert.equal(report.configuredPortNetworkReachable, true);
  assert.equal(report.safeToAutoEnable, false);
  assert.equal(report.releaseGate, 'OPEN');
  assert.ok(report.blockers.includes('EXISTING_RDP_PORT_IN_USE'));
  assert.ok(report.blockers.includes('HEADLESS_CREDENTIALS_NOT_CONFIGURED'));
});

test('even configured headless listener never authorizes physical multi-seat by itself', () => {
  const report = classifyHeadlessSeat({
    headless: parseHeadlessStatus(headlessConfigured.replace('Port: 3389','Port: 3390')),
    headlessUnit: parseUnit(active),
    sharingUnit: parseUnit(inactive),
    listeners: parseListeners('LISTEN 0 5 127.0.0.1:3390 0.0.0.0:*'),
  });
  assert.equal(report.admission, 'CONFIGURED_BUT_UNVERIFIED');
  assert.equal(report.safeToAutoEnable, false);
  assert.deepEqual(report.blockers, ['INDEPENDENT_SEAT_INPUT_ACCEPTANCE_NOT_PROVEN']);
});

test('missing observations or malformed port fail closed', () => {
  const report = classifyHeadlessSeat({
    headless: parseHeadlessStatus('Overall:\n Unit status: active\nRDP:\n Status: enabled\n Port: 99999'),
    headlessUnit: parseUnit(''),
    sharingUnit: parseUnit(''),
    listeners: [],
  });
  assert.equal(report.admission, 'NOT_READY');
  assert.equal(report.headless.port, null);
  assert.ok(report.blockers.includes('INSUFFICIENT_OBSERVATION'));
});

test('probe may execute only four exact read-only calls and no shell', async () => {
  const seen = [];
  const samples = [headlessDisabled, inactive, active, 'LISTEN 0 5 *:3389 *:*'];
  const report = await assess({ platform:'linux', run:async (cmd,args) => {
    seen.push([cmd,args]);
    return samples[seen.length-1];
  } });
  assert.deepEqual(seen, [
    ['grdctl',['--headless','status']],
    ['systemctl',['--user','show','gnome-remote-desktop-headless.service','-p','ActiveState','-p','UnitFileState']],
    ['systemctl',['--user','show','gnome-remote-desktop.service','-p','ActiveState','-p','UnitFileState']],
    ['ss',['-H','-ltn']],
  ]);
  assert.equal(report.admission,'NOT_READY');
  assert.throws(() => executeReadOnly('systemctl',['--user','start','gnome-remote-desktop-headless.service']),
    /UNAPPROVED_PREFLIGHT_COMMAND/);
});

test('unsupported platform does not execute any host command', async () => {
  const report = await assess({platform:'win32',run:()=>{throw Error('must not run');}});
  assert.equal(report.admission,'UNSUPPORTED_PLATFORM');
  assert.equal(report.safeToAutoEnable,false);
});

test('unavailable inspection commands fail closed rather than guessing ready', async () => {
  const report = await assess({platform:'linux',run:async()=>{throw Error('tool unavailable');}});
  assert.equal(report.admission,'NOT_READY');
  assert.ok(report.blockers.includes('INSUFFICIENT_OBSERVATION'));
  assert.equal(report.safeToAutoEnable,false);
});
