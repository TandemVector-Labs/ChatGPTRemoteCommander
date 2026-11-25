import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {resolveProfileIdentity} from '../src/profile-identity-registry.mjs';

function fail(message) {
  process.stderr.write(String(message) + '\n');
  process.exit(2);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) fail('unexpected argument: ' + key);
    const name = key.slice(2);
    if (name === 'help') out.help = true;
    else {
      const value = argv[++i];
      if (value == null || value.startsWith('--')) fail('missing value for --' + name);
      out[name] = value;
    }
  }
  return out;
}

function normalizeAppId(value) {
  let v = String(value ?? '').trim();
  const wrapped = v.match(/^plugin_((?:asdk_app_|connector_|templated_apps_)[A-Za-z0-9_-]+)$/u);
  if (wrapped) v = wrapped[1];
  if (!/^(?:asdk_app_|connector_|templated_apps_)[A-Za-z0-9_-]+$/u.test(v)) {
    fail('AppId must be asdk_app_/connector_/templated_apps_ or the matching plugin_ technical id.');
  }
  return v;
}

function cleanDisplay(value) {
  const v = String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!v) return 'Device';
  return [...v].slice(0, 42).join('');
}

function slugify(value) {
  const ascii = String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/gu, '');
  const slug = ascii.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 28);
  return slug || 'device';
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] :
    hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round((v + m) * 255))));
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const b of buffer) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function drawDevicePng(size, digest) {
  const hue = (digest[0] * 360) / 256;
  const bg = hslToRgb(hue, 0.72, 0.42);
  const bg2 = hslToRgb((hue + 32 + digest[1] / 4) % 360, 0.74, 0.52);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const set = (x, y, rgba) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = y * (size * 4 + 1) + 1 + x * 4;
    raw[i] = rgba[0]; raw[i + 1] = rgba[1]; raw[i + 2] = rgba[2]; raw[i + 3] = rgba[3] ?? 255;
  };
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const mix = ((x + y) / (2 * size));
      set(x, y, [
        Math.round(bg[0] * (1 - mix * 0.28) + bg2[0] * mix * 0.28),
        Math.round(bg[1] * (1 - mix * 0.28) + bg2[1] * mix * 0.28),
        Math.round(bg[2] * (1 - mix * 0.28) + bg2[2] * mix * 0.28),
        255
      ]);
    }
  }
  const rect = (x0, y0, w, h, c) => {
    for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) set(x, y, c);
  };
  const white = [255, 255, 255, 245];
  const dark = [10, 18, 35, 145];
  const unit = Math.max(1, Math.floor(size / 32));
  rect(5 * unit, 6 * unit, 22 * unit, 20 * unit, dark);
  rect(7 * unit, 8 * unit, 18 * unit, 16 * unit, [255, 255, 255, 24]);
  // Terminal-style chevron and cursor.
  for (let i = 0; i < 7 * unit; i += 1) {
    rect(10 * unit + i, 11 * unit + i, Math.max(1, unit), 2 * unit, white);
    rect(10 * unit + i, 19 * unit - i, Math.max(1, unit), 2 * unit, white);
  }
  rect(17 * unit, 20 * unit, 6 * unit, 2 * unit, white);
  // Four deterministic identity marks.
  const marks = [digest[2], digest[3], digest[4], digest[5]];
  const pos = [[2,2],[27,2],[2,27],[27,27]];
  for (let i = 0; i < 4; i += 1) {
    const m = 2 + (marks[i] % 3);
    rect(pos[i][0] * unit, pos[i][1] * unit, m * unit, m * unit, [255,255,255,180]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function copyTemplate(source, target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(source, target, { recursive: true, force: true });
}

function walkFiles(root) {
  const out = [];
  const visit = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) visit(full);
      else if (ent.isFile()) out.push(full);
    }
  };
  visit(root);
  return out.sort((a, b) => path.relative(root, a).localeCompare(path.relative(root, b), 'en'));
}

function zipStore(root, zipPath) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = 0x0021; // 1980-01-01
  for (const file of walkFiles(root)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const name = Buffer.from(rel, 'utf8');
    const data = fs.readFileSync(file);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(centrals);
  const count = centrals.length / 2;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(count, 8); eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localBytes.length, 16);
  eocd.writeUInt16LE(0, 20);
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(zipPath, Buffer.concat([localBytes, centralBytes, eocd]));
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('Usage: node tools/generate-device-plugin.mjs --template DIR --output DIR --zip FILE --app-id ID [--device-name NAME] [--profile NAME] [--identity-map FILE --host-id ID --account-id ID] [--fingerprint HEX] [--version VERSION]');
  process.exit(0);
}
for (const key of ['template','output','zip','app-id']) if (!args[key]) fail('missing --' + key);

const template = path.resolve(args.template);
const output = path.resolve(args.output);
const zipPath = path.resolve(args.zip);
if (!fs.existsSync(path.join(template, 'plugin.json'))) fail('template plugin.json not found');
const appId = normalizeAppId(args['app-id']);
const profile = cleanDisplay(args.profile || 'default');
const useIdentityMap = Boolean(args['identity-map']);
if (useIdentityMap !== Boolean(args['host-id']) ||
    useIdentityMap !== Boolean(args['account-id'])) {
  fail('identity-map, host-id and account-id must be supplied together');
}
let identity = null;
if (useIdentityMap) {
  try {
    const identityFile = path.resolve(args['identity-map']);
    const stat = fs.lstatSync(identityFile);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('identity-map must be a regular local file');
    identity = resolveProfileIdentity(JSON.parse(fs.readFileSync(identityFile,'utf8')), {
      hostId: args['host-id'], accountId: args['account-id'], profileName: profile
    });
  } catch (error) {
    fail('Profile identity map rejected: ' + (error?.message ?? 'invalid input'));
  }
}
const deviceName = cleanDisplay(args['device-name'] || identity?.hostLabel || os.hostname());
if (identity && deviceName !== identity.hostLabel) fail('identity-map device-name mismatch');
let fingerprint = String(args.fingerprint || '').toLowerCase();
if (fingerprint && !/^[a-f0-9]{8,24}$/u.test(fingerprint)) fail('fingerprint must be 8-24 lowercase hex characters');
if (!fingerprint) fingerprint = sha256Hex([deviceName, identity?.bindingHash ?? profile, process.platform, process.arch].join('\0')).slice(0, 10);
const digest = crypto.createHash('sha256').update(fingerprint).digest();
const slug = slugify(deviceName);
const pluginName = ('remote-commander-' + slug + '-' + fingerprint).slice(0, 63).replace(/-+$/u, '');
const displayName = identity?.displayName ?? (
  profile === 'default' || profile === 'chatgpt-remote-commander'
    ? 'Remote Commander · ' + deviceName
    : 'Remote Commander · ' + deviceName + ' · ' + profile);
const hue = (digest[0] * 360) / 256;
const brandRgb = hslToRgb(hue, 0.72, 0.42);
const brandColor = '#' + brandRgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
const version = String(args.version || JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);

copyTemplate(template, output);
fs.rmSync(path.join(output, '.app.json.example'), { force: true });

const rootManifestPath = path.join(output, 'plugin.json');
const rootManifest = JSON.parse(fs.readFileSync(rootManifestPath, 'utf8'));
rootManifest.name = pluginName;
rootManifest.version = version;
rootManifest.description = 'Operate the trusted computer ' + deviceName + ' through its private Remote Commander MCP app.';
rootManifest.extensions ??= {};
rootManifest.extensions['com.openai'] ??= {};
rootManifest.extensions['com.openai'].apps = './.app.json';
rootManifest.extensions['com.openai'].interface ??= {};
Object.assign(rootManifest.extensions['com.openai'].interface, {
  displayName,
  shortDescription: 'Control ' + deviceName + ' via private MCP',
  longDescription: 'Use the registered Remote Commander app for ' + deviceName + ' to inspect projects and perform authorized workflows on that specific computer.',
  brandColor
});
fs.writeFileSync(rootManifestPath, JSON.stringify(rootManifest, null, 2) + '\n');

const nativePath = path.join(output, '.codex-plugin', 'plugin.json');
const nativeManifest = JSON.parse(fs.readFileSync(nativePath, 'utf8'));
nativeManifest.name = pluginName;
nativeManifest.version = version;
nativeManifest.description = rootManifest.description;
nativeManifest.apps = './.app.json';
nativeManifest.interface ??= {};
Object.assign(nativeManifest.interface, {
  displayName,
  shortDescription: 'Control ' + deviceName + ' via private MCP',
  longDescription: 'Use the registered Remote Commander app for ' + deviceName + ' to operate that specific trusted computer.',
  brandColor
});
fs.writeFileSync(nativePath, JSON.stringify(nativeManifest, null, 2) + '\n');

const app = { apps: { 'remote-commander': { id: appId, required: true } } };
fs.writeFileSync(path.join(output, '.app.json'), JSON.stringify(app, null, 2) + '\n');

fs.mkdirSync(path.join(output, 'assets'), { recursive: true });
fs.writeFileSync(path.join(output, 'assets', 'icon.png'), drawDevicePng(512, digest));
fs.writeFileSync(path.join(output, 'assets', 'logo.png'), drawDevicePng(1024, digest));

const metadata = {
  schema: 1,
  product: 'ChatGPT Remote Commander',
  pluginName,
  displayName,
  deviceName,
  profile,
  ...(identity ? { identity: {
    profileId: identity.profileId, tunnelProfile: identity.tunnelProfile,
    bindingHash: identity.bindingHash, source: identity.source
  }} : {}),
  platform: process.platform,
  arch: process.arch,
  fingerprint,
  version,
  appBinding: 'present',
  secretMaterialIncluded: false
};
fs.writeFileSync(path.join(output, 'DEVICE_PLUGIN.json'), JSON.stringify(metadata, null, 2) + '\n');

for (const file of walkFiles(output)) {
  const textExt = /\.(?:json|md|txt|ps1|sh|toml)$/iu.test(file);
  if (!textExt) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const forbidden of [
    /sk-[A-Za-z0-9_-]{20,}/gu,
    /tunnel_[0-9a-f]{32}/gu,
    /CONTROL_PLANE_API_KEY\s*=/gu,
    /OPENAI_API_KEY\s*=/gu,
    /Bearer\s+[A-Za-z0-9._~-]{12,}/gu
  ]) {
    if (forbidden.test(text)) fail('secret-shaped material found in generated plugin: ' + path.relative(output, file));
  }
}

zipStore(output, zipPath);
const zipSha256 = sha256Hex(fs.readFileSync(zipPath));
const result = {
  ok: true,
  pluginName,
  displayName,
  deviceName,
  profile,
  fingerprint,
  brandColor,
  appId,
  output,
  zip: zipPath,
  zipSha256,
  zipBytes: fs.statSync(zipPath).size
};
process.stdout.write(JSON.stringify(result) + '\n');
