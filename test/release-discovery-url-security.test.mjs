import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assertPinnedReleaseDiscovery, extractReleaseDiscoveryEndpoint, isPinnedReleaseEndpoint, PINNED_RELEASE_ENDPOINT } from './release-discovery-contract.mjs';

const fixture = {
  windows: fs.readFileSync('auto-update-windows.ps1','utf8'),
  linux: fs.readFileSync('auto-update-linux.sh','utf8'),
};

test('release discovery calls use one exact, canonical HTTPS GitHub repository endpoint',()=>{
  for (const [platform,source] of Object.entries(fixture)){
    assert.equal(extractReleaseDiscoveryEndpoint(source,platform),PINNED_RELEASE_ENDPOINT);
    assert.equal(assertPinnedReleaseDiscovery(source,platform),PINNED_RELEASE_ENDPOINT);
  }
});

test('release discovery rejects deceptive origin, path, URL decorations and credentials',()=>{
  const bad = [
    'http://github.com/GOD13emad/ChatGPTRemoteCommander/releases/latest',
    'https://github.com.evil.invalid/GOD13emad/ChatGPTRemoteCommander/releases/latest',
    'https://github.com@evil.invalid/GOD13emad/ChatGPTRemoteCommander/releases/latest',
    'https://evil.invalid/https://github.com/GOD13emad/ChatGPTRemoteCommander/releases/latest',
    'https://github.com:444/GOD13emad/ChatGPTRemoteCommander/releases/latest',
    'https://github.com/GOD13emad/ChatGPTRemoteCommander/releases/latest?redirect=https://evil.invalid',
    'https://github.com/GOD13emad/ChatGPTRemoteCommander/releases/latest#anything',
    'https://github.com/GOD13emad/ChatGPTRemoteCommander/releases/latest/extra',
    'https://github.com/GOD13emad/ChatGPTRemoteCommander/releases/latest/../latest',
    'https://github.com/GOD13emad/ChatGPTRemoteCommander/releases/LATEST',
    'https://github.com/god13emad/ChatGPTRemoteCommander/releases/latest',
    'https://GITHUB.COM/GOD13emad/ChatGPTRemoteCommander/releases/latest',
    'https://login:password@github.com/GOD13emad/ChatGPTRemoteCommander/releases/latest',
    'javascript:location.href',
    'not-a-url',
  ];
  assert.equal(isPinnedReleaseEndpoint(PINNED_RELEASE_ENDPOINT),true);
  for(const value of bad)assert.equal(isPinnedReleaseEndpoint(value),false,value);
});

test('release discovery contract rejects a forged or missing network call, even if trusted URL appears elsewhere',()=>{
  for (const [platform,source] of Object.entries(fixture)){
    const malicious='https://github.com.evil.invalid/GOD13emad/ChatGPTRemoteCommander/releases/latest';
    const replaced=source.replace(PINNED_RELEASE_ENDPOINT,malicious);
    assert.notEqual(replaced,source,'test must mutate actual source');
    assert.throws(()=>assertPinnedReleaseDiscovery(replaced,platform),/RELEASE_DISCOVERY_UNTRUSTED_ENDPOINT/);
    assert.throws(()=>assertPinnedReleaseDiscovery(source.replace(PINNED_RELEASE_ENDPOINT, 'https://evil.invalid/https://github.com/GOD13emad/ChatGPTRemoteCommander/releases/latest'),platform),/RELEASE_DISCOVERY_UNTRUSTED_ENDPOINT/);
    assert.throws(()=>assertPinnedReleaseDiscovery(source.replace(PINNED_RELEASE_ENDPOINT,''),platform),/RELEASE_DISCOVERY_CALL_CARDINALITY|RELEASE_DISCOVERY_UNTRUSTED_ENDPOINT/);
    assert.throws(()=>assertPinnedReleaseDiscovery(source+('\n'+(platform==='windows'
      ? "$latest=Invoke-WebRequest -Method Head -Uri '"+PINNED_RELEASE_ENDPOINT+"' -MaximumRedirection 5 -TimeoutSec 20"
      : PINNED_RELEASE_ENDPOINT+' 2>/dev/null || true)"')),platform),/RELEASE_DISCOVERY_CALL_CARDINALITY/);
  }
});

test('release redirects must remain anchored to the same HTTPS GitHub owner and repository',()=>{
  const windows=fixture.windows.replace("if($effective -cmatch '^https://github[.]com","if($effective -cmatch 'https://github[.]com");
  assert.notEqual(windows,fixture.windows);
  assert.throws(()=>assertPinnedReleaseDiscovery(windows,'windows'),/Windows redirect must be bound/);

  const linux=fixture.linux.replace("'s#^https://github[.]com","'s#https://github[.]com");
  assert.notEqual(linux,fixture.linux);
  assert.throws(()=>assertPinnedReleaseDiscovery(linux,'linux'),/Linux redirect must be bound/);
  assert.throws(()=>extractReleaseDiscoveryEndpoint(fixture.linux,'mac'),/RELEASE_DISCOVERY_PLATFORM_INVALID/);
});
