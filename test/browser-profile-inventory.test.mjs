import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverBrowserProfileMetadata } from '../src/browser-profile-inventory.mjs';

const fixture = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-browser-inventory-'));
  try { return fn(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
};
const mkdir = (base, ...parts) => {
  const p = path.join(base, ...parts); fs.mkdirSync(p, { recursive: true }); return p;
};

test('Windows inventory finds browser families and multiple profile directories without reading credential files', () => {
  // Mock Windows filesystem semantics on every host, including Linux CI.
  const local='C:\\qa\\Local',roaming='C:\\qa\\Roaming';
  const dirs=new Map([
    [path.win32.join(local,'Google','Chrome','User Data'),['Default','Profile 5']],
    [path.win32.join(local,'BraveSoftware','Brave-Browser','User Data'),['Profile 3']],
    [path.win32.join(local,'Microsoft','Edge','User Data'),['Default']],
    [path.win32.join(roaming,'Mozilla','Firefox','Profiles'),['abc123.default-release']],
    [path.win32.join(roaming,'Opera Software','Opera Stable'),[]]
  ]);
  const files = {
    lstatSync: p => {
      if(!dirs.has(p))throw Object.assign(Error('missing'),{code:'ENOENT'});
      return {isDirectory:()=>true,isSymbolicLink:()=>false};
    },
    readdirSync: p => dirs.get(p).map(name=>({
      name,isDirectory:()=>true,isSymbolicLink:()=>false
    })),
    readFileSync: () => {throw Error('CREDENTIAL_FILE_READ_FORBIDDEN');}
  };
  const got=discoverBrowserProfileMetadata({
    platform:'win32',home:'C:\\qa',env:{LOCALAPPDATA:local,APPDATA:roaming},files
  });
  const byId=Object.fromEntries(got.browsers.map(b=>[b.browser,b]));
  assert.equal(byId.chrome.profileCount,2);
  assert.deepEqual(byId.chrome.profileIds,['Default','Profile 5']);
  assert.deepEqual(byId.brave.profileIds,['Profile 3']);
  assert.equal(byId.edge.profileCount,1);
  assert.equal(byId.firefox.profileCount,1);
  assert.equal(byId.opera.profileCount,1);
  assert.equal(byId.vivaldi,undefined);
  assert.equal(got.preferredBrowser,null);
  assert.equal(got.secretFilesRead,false);
  assert.equal(got.liveLoginVerified,false);
  assert.ok(got.browsers.every(b=>b.authenticationState==='UNVERIFIED'&&b.credentialState==='NOT_INSPECTED'));
});

test('Linux inventory accepts snap Firefox and Chromium-family directories without vendor default', () => {
  const root = '/owner';
  const dirs = new Map([
    ['/owner/.config/BraveSoftware/Brave-Browser', ['Default', 'Profile 3', 'Cache', 'SingletonLock']],
    ['/owner/.config/google-chrome', ['Profile 1']],
    ['/owner/snap/firefox/common/.mozilla/firefox', ['abc123.default-release', 'ignore.ini']],
    ['/owner/.config/opera', []]
  ]);
  const files = {
    lstatSync: p => {
      if (!dirs.has(p)) throw Object.assign(Error('missing'), { code: 'ENOENT' });
      return { isDirectory: () => true, isSymbolicLink: () => false };
    },
    readdirSync: p => dirs.get(p).map(name => ({
      name, isDirectory: () => name !== 'SingletonLock' && !name.endsWith('.ini'),
      isSymbolicLink: () => false
    }))
  };
  const got = discoverBrowserProfileMetadata({ platform: 'linux', home: root, files });
  const m = Object.fromEntries(got.browsers.map(b => [b.browser, b]));
  assert.deepEqual(m.brave.profileIds, ['Default', 'Profile 3']);
  assert.deepEqual(m.firefox.profileIds, ['abc123.default-release']);
  assert.deepEqual(m.chrome.profileIds, ['Profile 1']);
  assert.deepEqual(m.opera.profileIds, ['RootProfile']);
  assert.equal(got.preferredBrowser, null);
});

test('symlinked or unreadable profile roots are not followed or treated as verified login', () => {
  const files = {
    lstatSync: p => p.includes('Chrome') ?
      { isDirectory: () => false, isSymbolicLink: () => true } :
      { isDirectory: () => true, isSymbolicLink: () => false },
    readdirSync: () => { throw Object.assign(Error('denied'), { code: 'EACCES' }); }
  };
  const got = discoverBrowserProfileMetadata({
    platform: 'win32', home: 'C:\\owner', env: { LOCALAPPDATA: 'C:\\local', APPDATA: 'C:\\roaming' }, files
  });
  const chrome = got.browsers.find(x => x.browser === 'chrome');
  assert.equal(chrome.present, false);
  assert.equal(chrome.scanStatus, 'PARTIAL');
  assert.equal(chrome.authenticationState, 'UNVERIFIED');
  assert.ok(got.browsers.every(x => x.authenticationState === 'UNVERIFIED'));
});

test('inventory bounds profile identifiers and rejects invalid enumeration arguments', () => {
  const names = Array.from({ length: 45 }, (_, i) => ({ name: 'Profile ' + i,
    isDirectory: () => true, isSymbolicLink: () => false }));
  const files = {
    lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
    readdirSync: () => names
  };
  const got = discoverBrowserProfileMetadata({ platform: 'win32', home: 'C:\\owner', env: {
    LOCALAPPDATA: 'C:\\local'
  }, files, maxPerBrowser: 7 });
  const chrome = got.browsers.find(x => x.browser === 'chrome');
  assert.equal(chrome.profileCount, 45);
  assert.equal(chrome.profileIds.length, 7);
  assert.equal(chrome.truncated, true);
  assert.throws(() => discoverBrowserProfileMetadata({ platform: 'darwin' }),
    /BROWSER_PROFILE_DISCOVERY_INVALID_INPUT/);
  assert.throws(() => discoverBrowserProfileMetadata({ maxPerBrowser: 0 }),
    /BROWSER_PROFILE_DISCOVERY_INVALID_INPUT/);
});

test('live browser_status includes neutral browser candidates and never claims owner login', async () => {
  const { createBrowserController } = await import('../src/browser-tools.mjs');
  const controller = createBrowserController({
    invoke: async () => ({ ok: true, available: true, backend: 'chromium-cdp', active: false }),
    closeInvoke: () => {}
  });
  try {
    const status = await controller.execute({
      config: { powerMode: { enabled: true, browserControl: { enabled: true } } }
    }, 'browser_status', {});
    assert.ok(Array.isArray(status.ownerBrowserCandidates));
    assert.equal(status.ownerBrowserSelection.preferredBrowser, null);
    assert.equal(status.ownerBrowserSelection.existingSessionFirst, true);
    assert.equal(status.ownerBrowserSelection.profileConsentRequired, true);
    assert.equal(status.ownerBrowserSelection.secretsInspected, false);
    assert.equal(status.policy.userBrowserProfileReuse, false);
    assert.ok(status.ownerBrowserCandidates.every(x =>
      x.authenticationState === 'UNVERIFIED' && !Object.hasOwn(x, 'profileIds')));
  } finally { controller.close(); }
});
