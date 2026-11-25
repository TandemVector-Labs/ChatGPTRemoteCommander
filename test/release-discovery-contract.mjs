import assert from 'node:assert/strict';

export const PINNED_RELEASE_ENDPOINT = 'https://github.com/GOD13emad/ChatGPTRemoteCommander/releases/latest';

// A substring occurrence is not an origin check. Require exact endpoint identity.
export function isPinnedReleaseEndpoint(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return value === PINNED_RELEASE_ENDPOINT &&
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.origin === 'https://github.com' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/GOD13emad/ChatGPTRemoteCommander/releases/latest' &&
      url.search === '' &&
      url.hash === '';
  } catch {
    return false;
  }
}

export function extractReleaseDiscoveryEndpoint(source, platform) {
  assert.equal(typeof source, 'string', 'RELEASE_DISCOVERY_SOURCE_INVALID');
  let matches;
  if (platform === 'windows') {
    matches = [...source.matchAll(/^\s*\$latest=Invoke-WebRequest -Method Head -Uri '([^'\r\n]+)' -MaximumRedirection 5[^\r\n]*$/gm)];
  } else if (platform === 'linux') {
    matches = [...source.matchAll(/^\s*(https:\/\/[^\s"'\\]+)\s+2>\/dev\/null \|\| true\)"\s*$/gm)];
  } else {
    throw new Error('RELEASE_DISCOVERY_PLATFORM_INVALID');
  }
  assert.equal(matches.length, 1, 'RELEASE_DISCOVERY_CALL_CARDINALITY');
  return matches[0][1];
}

export function assertPinnedReleaseDiscovery(source, platform) {
  const endpoint = extractReleaseDiscoveryEndpoint(source, platform);
  assert.equal(isPinnedReleaseEndpoint(endpoint), true, 'RELEASE_DISCOVERY_UNTRUSTED_ENDPOINT');
  if (platform === 'windows') {
    assert.match(source, /if\(\$effective -cmatch '\^https:\/\/github\[\.\]com\/GOD13emad\/ChatGPTRemoteCommander\/releases\/tag\//,
      'Windows redirect must be bound to the pinned HTTPS GitHub repository');
    assert.match(source, /\(v\\d\+\\\.\\d\+\\\.\\d\+\)\$'\)/,
      'Windows release redirect version matching must be anchored');
  } else {
    assert.match(source, /--write-out '%\{url_effective\}'/,
      'Linux updater must validate the effective redirect URL');
    assert.match(source, /sed -nE 's#\^https:\/\/github\[\.\]com\/GOD13emad\/ChatGPTRemoteCommander\/releases\/tag\//,
      'Linux redirect must be bound to the pinned HTTPS GitHub repository');
    assert.match(source, /\(v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\)\$#/,
      'Linux release redirect version matching must be anchored');
  }
  return endpoint;
}
