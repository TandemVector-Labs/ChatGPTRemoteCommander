#!/usr/bin/env node
/**
 * Read-only GNOME 50 headless seat admission preflight.
 * Deliberately does not create sessions, credentials, sockets or input events.
 * Output contains fixed booleans and enums only: no usernames, cert paths or secrets.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const readOnlyCalls = Object.freeze([
  ['grdctl', ['--headless', 'status']],
  ['systemctl', ['--user', 'show', 'gnome-remote-desktop-headless.service', '-p', 'ActiveState', '-p', 'UnitFileState']],
  ['systemctl', ['--user', 'show', 'gnome-remote-desktop.service', '-p', 'ActiveState', '-p', 'UnitFileState']],
  ['systemctl', ['--user', 'show', 'gnome-remote-desktop-headless.service', '-p', 'Conflicts']],
  ['ss', ['-H', '-ltn']],
]);

export function parseHeadlessStatus(output) {
  const text = typeof output === 'string' ? output : '';
  const overall = text.split(/^RDP:\s*$/m)[0] ?? '';
  const rdp = text.split(/^RDP:\s*$/m)[1] ?? '';
  const field = (body, name) => body.match(new RegExp('^\\s*' + name + ':\\s*(.*?)\\s*$', 'mi'))?.[1] ?? null;
  const state = field(overall, 'Unit status');
  const rdpStatus = field(rdp, 'Status');
  const portRaw = field(rdp, 'Port');
  const port = portRaw && /^\d{1,5}$/.test(portRaw) ? Number(portRaw) : null;
  const auth = field(rdp, 'Authentication methods');
  const user = field(rdp, 'Username');
  const password = field(rdp, 'Password');
  const cert = field(rdp, 'TLS certificate');
  const key = field(rdp, 'TLS key');
  return {
    observed: state !== null && rdpStatus !== null,
    unitState: state === 'active' || state === 'inactive' ? state : 'unknown',
    rdp: rdpStatus === 'enabled' ? 'enabled' : rdpStatus === 'disabled' ? 'disabled' : 'unknown',
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : null,
    credentialMode: auth?.includes('credentials') === true ? 'credentials' : auth ? 'other_or_unknown' : 'unknown',
    credentialsPresent: user !== null && password !== null && user !== '(empty)' && password !== '(empty)',
    tlsPathsConfigured: Boolean(cert && key && cert !== '(empty)' && key !== '(empty)'),
  };
}

export function parseUnit(output) {
  const text = typeof output === 'string' ? output : '';
  const matchState = text.match(/^ActiveState=(.+)$/m)?.[1];
  const matchEnable = text.match(/^UnitFileState=(.+)$/m)?.[1];
  return {
    observed: Boolean(matchState && matchEnable),
    active: matchState === 'active',
    enabled: matchEnable === 'enabled',
  };
}

export function parseUnitConflicts(output) {
  if (typeof output !== 'string') return { observed: false, sharesConflict: false };
  const match = output.match(/^Conflicts=(.*)$/m);
  if (!match) return { observed: false, sharesConflict: false };
  const exactServices = match[1].trim().split(/\s+/);
  return {
    observed: true,
    sharesConflict: exactServices.includes('gnome-remote-desktop.service'),
  };
}

export function parseListeners(output) {
  if (typeof output !== 'string') return [];
  return output.split(/\r?\n/).flatMap(line => {
    const fields = line.trim().split(/\s+/);
    // ss -H -ltn lists State Recv-Q Send-Q Local-Address:Port Peer-Address:Port
    if (fields.length < 5 || fields[0] !== 'LISTEN') return [];
    const local = fields[3] ?? '';
    const index = local.lastIndexOf(':');
    if (index < 0 || !/^\d+$/.test(local.slice(index + 1))) return [];
    const port = Number(local.slice(index + 1));
    if (port < 1 || port > 65535) return [];
    const host = local.slice(0, index).replace(/^\[|\]$/g, '');
    const loopback = host === '127.0.0.1' || host === '::1' || host === '[::1]';
    return [{ port, scope: loopback ? 'loopback' : 'potentially_network_reachable' }];
  });
}

export function classifyHeadlessSeat({
  headless, headlessUnit, sharingUnit, headlessUnitConflicts =
    { observed: false, sharesConflict: false }, listeners,
}) {
  const portBound = headless.port !== null && listeners.some(entry => entry.port === headless.port);
  const networkListener = headless.port !== null && listeners.some(entry => entry.port === headless.port && entry.scope !== 'loopback');
  const sharingActive = sharingUnit.active;
  const destructiveDesktopConflict = sharingActive && headlessUnitConflicts.sharesConflict;
  const readyToStart = headless.observed && headlessUnit.observed && sharingUnit.observed &&
    headlessUnitConflicts.observed && !destructiveDesktopConflict &&
    headless.rdp === 'enabled' && headlessUnit.active && headless.credentialsPresent &&
    headless.tlsPathsConfigured && !networkListener;
  const blockers = [];
  if (!headless.observed || !headlessUnit.observed || !sharingUnit.observed ||
      !headlessUnitConflicts.observed) blockers.push('INSUFFICIENT_OBSERVATION');
  if (destructiveDesktopConflict) blockers.push('HEADLESS_CONFLICTS_ACTIVE_DESKTOP_SHARING');
  if (headless.rdp !== 'enabled') blockers.push('HEADLESS_RDP_NOT_ENABLED');
  if (!headless.credentialsPresent) blockers.push('HEADLESS_CREDENTIALS_NOT_CONFIGURED');
  if (!headless.tlsPathsConfigured) blockers.push('HEADLESS_TLS_PATHS_NOT_CONFIGURED');
  if (!headlessUnit.active) blockers.push('HEADLESS_SERVICE_NOT_ACTIVE');
  if (sharingActive && portBound) blockers.push('EXISTING_RDP_PORT_IN_USE');
  if (networkListener) blockers.push('NETWORK_BIND_PRESENT_REQUIRES_OWNER_REVIEW');
  // A healthy RDP daemon alone never proves input and profile isolation.
  blockers.push('INDEPENDENT_SEAT_INPUT_ACCEPTANCE_NOT_PROVEN');
  return {
    schema: 1,
    admission: readyToStart ? 'CONFIGURED_BUT_UNVERIFIED' : 'NOT_READY',
    safeToAutoEnable: false,
    headless: {
      daemon: headlessUnit.active ? 'active' : 'inactive_or_unknown',
      serviceEnabled: headlessUnit.enabled,
      rdp: headless.rdp,
      port: headless.port,
      credentialsConfigured: headless.credentialsPresent,
      tlsPathsConfigured: headless.tlsPathsConfigured,
      conflictsWithDesktopSharing: headlessUnitConflicts.sharesConflict,
      conflictPropertyObserved: headlessUnitConflicts.observed,
    },
    desktopSharingActive: sharingActive,
    configuredPortAlreadyListening: portBound,
    configuredPortNetworkReachable: networkListener,
    blockers,
    releaseGate: 'OPEN',
    intent: 'READ_ONLY_PREFLIGHT_NO_SESSION_OR_INPUT_MUTATION',
  };
}

export async function assess({ run = executeReadOnly, platform = process.platform } = {}) {
  if (platform !== 'linux') return {
    schema: 1, admission: 'UNSUPPORTED_PLATFORM', safeToAutoEnable: false,
    blockers: ['LINUX_ONLY'], releaseGate: 'OPEN', intent: 'READ_ONLY_PREFLIGHT_NO_SESSION_OR_INPUT_MUTATION',
  };
  const values = [];
  for (const [program, args] of readOnlyCalls) {
    try { values.push(await run(program, [...args])); }
    catch { values.push(null); }
  }
  return classifyHeadlessSeat({
    headless: parseHeadlessStatus(values[0]),
    headlessUnit: parseUnit(values[1]),
    sharingUnit: parseUnit(values[2]),
    headlessUnitConflicts: parseUnitConflicts(values[3]),
    listeners: parseListeners(values[4]),
  });
}

export function executeReadOnly(program, args) {
  // This enumeration is an input validation boundary, not a caller-controlled shell.
  if (!readOnlyCalls.some(([allowed, expected]) =>
    allowed === program && JSON.stringify(expected) === JSON.stringify(args))) {
    throw new Error('UNAPPROVED_PREFLIGHT_COMMAND');
  }
  return execFileSync(program, args, {
    encoding: 'utf8', timeout: 3000, maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2 && !(process.argv.length === 3 && process.argv[2] === '--json')) {
    process.stderr.write('Usage: node tools/linux-headless-seat-readiness.mjs [--json]\n');
    process.exitCode = 64;
  } else {
    const report = await assess();
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  }
}
