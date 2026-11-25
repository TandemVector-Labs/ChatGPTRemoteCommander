import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'src', 'gui-libei-receiver.c');
const buildPath = path.join(root, 'tools', 'build-gui-libei-receiver.sh');
const source = fs.readFileSync(sourcePath, 'utf8');
const build = fs.readFileSync(buildPath, 'utf8');

test('libei receiver is passive, owner-session fd-bound and portal-sequence-aware', () => {
  for (const marker of [
    'ei_new_receiver(NULL)',
    'ei_setup_backend_fd(ctx, fd)',
    'ei_dispatch(ctx)',
    'ei_get_event(ctx)',
    'EI_EVENT_DEVICE_START_EMULATING',
    'ei_event_emulating_get_sequence(event)',
    'EI_DEVICE_TYPE_PHYSICAL',
    'eis_non_physical_device_ignored',
    'eis_physical_activity',
    'EIS_ACTIVATION_SEQUENCE_MISMATCH',
    'EI_EVENT_DEVICE_STOP_EMULATING'
  ]) assert.ok(source.includes(marker), marker);
  assert.match(source, /sequence != expected_sequence/);
  assert.match(source, /POLLERR \| POLLHUP \| POLLNVAL/);
});

test('libei receiver does not serialize raw keyboard, text, button or pointer data', () => {
  for (const forbidden of [
    'ei_event_keyboard_get_key',
    'ei_event_pointer_get',
    'ei_event_button_get',
    'ei_event_touch_get',
    'NotifyKeyboard',
    'NotifyPointer',
    'printf("%s", key',
    'fwrite('
  ]) assert.equal(source.includes(forbidden), false, forbidden);
  assert.ok(source.includes('Deliberately ignore all raw input data'));
  assert.ok(source.includes('capabilities'));
});

test('libei receiver has parent-death and bounded-lease release guards', () => {
  assert.match(source, /PR_SET_PDEATHSIG, SIGTERM/);
  assert.match(source, /getppid\(\) != parent_pid/);
  assert.match(source, /EIS_RECEIVER_TIMEOUT/);
  assert.match(source, /EIS_RECEIVER_LEASE_EXPIRED/);
  assert.match(source, /lease_ms < 10000 \|\| lease_ms > 120000/);
  assert.match(source, /ei_unref\(ctx\)/);
});

test('user-local builder uses strict flags and refuses unsafe output targets', () => {
  for (const required of [
    'libei-1.0', '-std=c11', '-Wall', '-Wextra', '-Werror',
    '-Wconversion', '-Wshadow', 'PR_SET_PDEATHSIG',
    '$HOME/.local/libexec/chatgpt-remote-commander',
    'GUI_LIBEI_OUTPUT_NOT_OWNER_CONTROLLED',
    'GUI_LIBEI_EXISTING_OUTPUT_INVALID',
    'mv -f -- "$TMP" "$OUTPUT"'
  ]) if (required !== 'PR_SET_PDEATHSIG') assert.ok(build.includes(required), required);
  assert.equal(build.includes("sudo "), false); assert.equal(build.includes("apt-get install"), false); assert.equal(build.includes("OUTPUT=\"/usr/local"), false);
});

test('native build and command-line negative checks pass when libei development headers are available', t => {
  const compiler = spawnSync('cc', ['--version'], { encoding:'utf8' });
  const pkg = spawnSync('pkg-config', ['--exists', 'libei-1.0']);
  if (compiler.error || compiler.status !== 0 || pkg.error || pkg.status !== 0) {
    t.skip('libei development toolchain unavailable on this host');
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-libei-build-'));
  try {
    const output = path.join(tmp, 'bin', 'gui-libei-receiver');
    const built = spawnSync('bash', [buildPath, '--output', output], { encoding:'utf8', timeout:30000 });
    assert.equal(built.status, 0, built.stderr || built.stdout);
    assert.match(built.stdout, /GUI_LIBEI_RECEIVER_BUILD_PASS/);
    assert.equal(fs.statSync(output).mode & 0o777, 0o700);

    const help = spawnSync(output, ['--help'], { encoding:'utf8', timeout:3000 });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--activation-id/);

    const invalidFd = spawnSync(output, ['--fd','invalid','--activation-id','0'], { encoding:'utf8', timeout:3000 });
    assert.equal(invalidFd.status, 64);
    assert.match(invalidFd.stdout, /INVALID_FD_ARGUMENT/);

    const invalidSocket = spawnSync(output, ['--fd','999','--activation-id','0'], { encoding:'utf8', timeout:3000 });
    assert.equal(invalidSocket.status, 65);
    assert.match(invalidSocket.stdout, /EIS_FD_INVALID/);
  } finally {
    fs.rmSync(tmp, { recursive:true, force:true });
  }
});
