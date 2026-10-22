import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'tools/windows-owner-gui-ipc/Program.cs'), 'utf8');
const project = path.join(root, 'tools/windows-owner-gui-ipc/OwnerSessionBridge.csproj');

test('Windows owner GUI IPC Phase 1 is status-only and keeps user desktop isolated', () => {
  for (const required of [
    'NamedPipeServerStreamAcl.Create', 'BuildAcl(owner)', 'WellKnownSidType.LocalSystemSid',
    'CryptographicOperations.FixedTimeEquals', 'HMACSHA256.HashData',
    'RESPONSE_UNAUTHENTICATED', 'REQUEST_UNAUTHENTICATED',
    'OWNER_SESSION_INVALID', 'CORE_SERVICE_SESSION_INVALID',
    'KEY_ACL_TOO_BROAD', 'MESSAGE_TOO_LARGE',
    'OWNER_READONLY_STATUS_SENT', 'operations = new[] { "status" }',
    'screenshot = false, mouse = false, keyboard = false, focus = false'
  ]) assert.ok(source.includes(required), 'required security invariant: ' + required);

  for (const forbidden of [
    'SendInput(', 'mouse_event(', 'keybd_event(', 'SetForegroundWindow(',
    'BitBlt(', 'PrintWindow(', 'GetWindowText(', 'Process.Start("explorer")'
  ]) assert.equal(source.includes(forbidden), false, 'forbidden Phase 1 GUI feature: ' + forbidden);
});

test('Windows native owner GUI IPC HMAC / schema self-test builds and rejects unauthorized CLI', { skip: process.platform !== 'win32' }, () => {
  const build = spawnSync('dotnet', ['build', project, '-c', 'Release', '--nologo', '-v', 'quiet', '-p:NuGetAudit=false'], {
    cwd: root, encoding: 'utf8', timeout: 60_000, windowsHide: true
  });
  assert.equal(build.status, 0, 'Native build failed: ' + (build.stderr || build.stdout).slice(-1200));
  const dll = path.join(root, 'tools/windows-owner-gui-ipc/bin/Release/net10.0-windows/OwnerSessionBridge.dll');
  const self = spawnSync('dotnet', [dll, 'self-test'], { cwd: root, encoding: 'utf8', timeout: 8_000, windowsHide: true });
  assert.equal(self.status, 0, 'Crypto self-test failed: ' + (self.stderr || self.stdout).slice(-450));
  assert.match(self.stdout, /OWNER_GUI_BRIDGE_CRYPTO_SCHEMA_SELFTEST_PASS/);
  const denied = spawnSync('dotnet', [dll, 'probe', '--action', 'screenshot'], {
    cwd: root, encoding: 'utf8', timeout: 8_000, windowsHide: true
  });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /ARGUMENT_SCHEMA/);
});
