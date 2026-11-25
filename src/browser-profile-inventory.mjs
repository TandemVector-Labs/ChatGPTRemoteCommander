// Read-only browser-profile metadata discovery for the owning OS user.
// Never open Local State, Login Data, Cookies, logins.json, key stores or session files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const make = (browser, family, roots, layout) => ({ browser, family, roots, layout });
const rootSpec = (platform, home, env, p) => {
  if (platform === 'win32') {
    const local = typeof env.LOCALAPPDATA === 'string' ? env.LOCALAPPDATA : null;
    const roaming = typeof env.APPDATA === 'string' ? env.APPDATA : null;
    const l = (...parts) => local ? p.join(local, ...parts) : null;
    const r = (...parts) => roaming ? p.join(roaming, ...parts) : null;
    return [
      make('chrome', 'chromium', [l('Google', 'Chrome', 'User Data')], 'chromium'),
      make('brave', 'chromium', [l('BraveSoftware', 'Brave-Browser', 'User Data')], 'chromium'),
      make('edge', 'chromium', [l('Microsoft', 'Edge', 'User Data')], 'chromium'),
      make('vivaldi', 'chromium', [l('Vivaldi', 'User Data')], 'chromium'),
      make('opera', 'chromium', [r('Opera Software', 'Opera Stable')], 'root'),
      make('opera-gx', 'chromium', [r('Opera Software', 'Opera GX Stable')], 'root'),
      make('firefox', 'firefox', [r('Mozilla', 'Firefox', 'Profiles')], 'firefox'),
      make('librewolf', 'firefox', [r('librewolf', 'Profiles')], 'firefox')
    ];
  }
  return [
    make('chrome', 'chromium', [p.join(home, '.config/google-chrome')], 'chromium'),
    make('chromium', 'chromium', [p.join(home, '.config/chromium')], 'chromium'),
    make('brave', 'chromium', [p.join(home, '.config/BraveSoftware/Brave-Browser')], 'chromium'),
    make('edge', 'chromium', [p.join(home, '.config/microsoft-edge')], 'chromium'),
    make('vivaldi', 'chromium', [p.join(home, '.config/vivaldi')], 'chromium'),
    make('opera', 'chromium', [p.join(home, '.config/opera')], 'root'),
    make('opera-gx', 'chromium', [p.join(home, '.config/opera-gx')], 'root'),
    make('firefox', 'firefox', [
      p.join(home, '.mozilla/firefox'),
      p.join(home, 'snap/firefox/common/.mozilla/firefox'),
      p.join(home, '.var/app/org.mozilla.firefox/.mozilla/firefox')
    ], 'firefox'),
    make('librewolf', 'firefox', [
      p.join(home, '.librewolf'),
      p.join(home, '.var/app/io.gitlab.librewolf-community/.librewolf')
    ], 'firefox')
  ];
};
const isProfileName = (name, layout) => {
  if (layout === 'chromium') return name === 'Default' || /^Profile [0-9]{1,5}$/.test(name);
  if (layout === 'firefox') return /^[a-zA-Z0-9_-]{1,80}\.[a-zA-Z0-9._-]{1,80}$/.test(name);
  return false;
};
function directoryStatus(file, files) {
  try {
    const s = files.lstatSync(file);
    return s.isSymbolicLink() ? 'SYMLINK_NOT_SCANNED' : s.isDirectory() ? 'DIRECTORY' : 'NOT_DIRECTORY';
  } catch (e) {
    return e?.code === 'ENOENT' ? 'ABSENT' : 'UNREADABLE';
  }
}
/** Returns only owner-local directory names; never reads any profile file or infers a login. */
export function discoverBrowserProfileMetadata({
  platform = process.platform, home = os.homedir(), env = process.env, files = fs,
  maxPerBrowser = 32
} = {}) {
  if (!['win32', 'linux'].includes(platform) || typeof home !== 'string' || !home ||
      !Number.isSafeInteger(maxPerBrowser) || maxPerBrowser < 1 || maxPerBrowser > 64)
    throw new TypeError('BROWSER_PROFILE_DISCOVERY_INVALID_INPUT');
  const p = platform === 'win32' ? path.win32 : path.posix;
  const entries = [];
  for (const spec of rootSpec(platform, home, env, p)) {
    let present = false, uncertain = false, count = 0;
    const ids = [];
    for (const root of spec.roots.filter(Boolean)) {
      const status = directoryStatus(root, files);
      if (status === 'ABSENT') continue;
      if (status !== 'DIRECTORY') { uncertain = true; continue; }
      present = true;
      if (spec.layout === 'root') { count++; if (ids.length < maxPerBrowser) ids.push('RootProfile'); continue; }
      let items;
      try { items = files.readdirSync(root, { withFileTypes: true }); }
      catch { uncertain = true; continue; }
      for (const item of items) {
        if (!item.isDirectory() || item.isSymbolicLink?.() || !isProfileName(item.name, spec.layout))
          continue;
        count++;
        if (ids.length < maxPerBrowser) ids.push(item.name);
      }
    }
    if (present || uncertain) entries.push({
      browser: spec.browser, family: spec.family, present, scanStatus: uncertain ? 'PARTIAL' : 'COMPLETE',
      profileCount: count, profileIds: ids.sort(), truncated: count > ids.length,
      credentialState: 'NOT_INSPECTED', authenticationState: 'UNVERIFIED',
      ownerConsentRequiredForSessionUse: true
    });
  }
  return { schema: 1, platform, browsers: entries,
    preferredBrowser: null, selectionPolicy: 'NO_DEFAULT_USE_EXACT_OWNER_SESSION',
    secretFilesRead: false, liveLoginVerified: false };
}
