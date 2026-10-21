import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const source = fs.readFileSync(new URL('../auto-update-linux.sh', import.meta.url), 'utf8');
const marker = 'upgrade_optional_linux_control_center(){';
const begin = source.indexOf(marker);
const end = source.indexOf('\n}\n\nsync_work_plugin_projection(){', begin);
assert.ok(begin >= 0 && end > begin, 'the independent GUI upgrade helper must exist');
const helper = source.slice(begin, end + 2);

test('Core NoPromote can never install or replace the Linux Control Center', () => {
  assert.match(helper, /\[\[ "\$NO_PROMOTE" != 1 \]\] \|\|/);
  assert.match(helper, /LINUX_CONTROL_CENTER_UPGRADE_SKIP_NOPROMOTE/);
  assert.match(helper, /-f "\$launcher" && -d "\$data_root\/remote-commander-control-center"/);
  assert.match(helper, /python3 -B "\$installer" --install/);
  assert.match(source, /upgrade_optional_linux_control_center "\$STAGE_DIR"/);
  const final = source.lastIndexOf('upgrade_optional_linux_control_center "$STAGE_DIR"');
  assert.ok(final > source.lastIndexOf('promote_control "$COMMIT" "$REF"'));
  assert.match(source, /LINUX_CONTROL_CENTER_UPGRADE_DEFER_INSTALL_FAILED/);
});

test('isolated native Bash guard and installed-only admission', {
  skip: process.platform !== 'linux' && 'native Linux shell test'
}, t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-cc-updater-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const run = (noPromote, sourceRoot = tmp) => spawnSync('bash', ['-euo', 'pipefail', '-c',
    'log(){ printf "%s\\n" "$1"; }; ' + helper + '\nupgrade_optional_linux_control_center "$1"', 'bash', sourceRoot], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, NO_PROMOTE: String(noPromote),
      XDG_DATA_HOME: tmp }, windowsHide: true
  });
  let r = run(1);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /LINUX_CONTROL_CENTER_UPGRADE_SKIP_NOPROMOTE/);
  r = run(0);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /LINUX_CONTROL_CENTER_UPGRADE_SKIP_NOT_INSTALLED/);
  const app = path.join(tmp, 'remote-commander-control-center');
  const desktop = path.join(tmp, 'applications/io.github.god13emad.RemoteCommander.ControlCenter.desktop');
  fs.mkdirSync(app);
  fs.mkdirSync(path.dirname(desktop));
  fs.writeFileSync(desktop, '[Desktop Entry]\\n');
  r = run(0);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /LINUX_CONTROL_CENTER_UPGRADE_DEFER_PACKAGE_MISSING/);
  const installer = path.join(tmp, 'desktop/linux-control-center/install_user.py');
  fs.mkdirSync(path.dirname(installer), { recursive: true });
  fs.writeFileSync(installer, 'print("LINUX_CONTROL_CENTER_INSTALL_PASS")\n');
  r = run(0);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /LINUX_CONTROL_CENTER_UPGRADE_PASS/);
});
