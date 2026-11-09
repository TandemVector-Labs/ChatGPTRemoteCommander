import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repository = process.cwd();
const linuxOnly = { skip: process.platform !== 'linux' && 'Linux installer execution gate' };
function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 30000, windowsHide: true, ...options });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${program} failed: ${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
function write(file, text, executable = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (executable) fs.chmodSync(file, 0o755);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-linux-install-isolation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), target = path.join(root, 'custom-install');
  fs.mkdirSync(source);
  for (const name of ['config.json', 'tools/build-candidate-config.mjs', 'tools/capability-migrate.mjs', 'tools/json-field.mjs', 'tools/tunnel-client-pin.json', 'src/capability-profile.mjs', 'src/project-runner-config.mjs', 'src/no-codex-policy.mjs', 'src/delivery-store.mjs', 'src/platform.mjs']) {
    write(path.join(source, name), fs.readFileSync(path.join(repository, name)));
  }
  write(path.join(source, 'tools/install-tunnel-client-linux.sh'), fs.readFileSync(path.join(repository, 'tools/install-tunnel-client-linux.sh')), true);
  write(path.join(source, 'package.json'), '{"type":"module"}\n');
  write(path.join(source, '.gitignore'), 'config.local.json\nvar/\ntools/tunnel-client-v*/\n');
  const requiredScripts = ['install.sh', 'connect-chatgpt-account.sh', 'run-server.sh', 'autostart-linux.sh',
    'supervisor-routing-linux.sh', 'enable-autostart-linux.sh', 'disable-autostart-linux.sh',
    'tools/gui-control-linux.py', 'tools/install-gnome-gui-extension.sh'];
  for (const name of requiredScripts) write(path.join(source, name), '#!/bin/sh\nprintf unexpected > "$RC_INSTALL_EFFECTS"\nexit 91\n', true);
  write(path.join(source, 'auto-update-linux.sh'), '#!/bin/sh\nprintf updater > "$RC_INSTALL_EFFECTS"\nexit 91\n', true);
  const git = (...args) => run('git', args, { cwd: source });
  git('init'); git('config', 'user.name', 'Installer Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.'); git('commit', '-m', 'fixture');
  run('git', ['clone', '--no-hardlinks', source, target]);
  write(path.join(source, 'updated.txt'), 'new source revision\n');
  git('add', 'updated.txt'); git('commit', '-m', 'fixture update');
  const commit = git('rev-parse', 'HEAD');
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  write(path.join(target, `tools/tunnel-client-v0.0.15-linux-${arch}/tunnel-client`), '#!/bin/sh\nprintf "0.0.15+a390c168ff1b2d14e73a95991c186c6aba3ff5a0 (git sha: a390c168ff1b2d14e73a95991c186c6aba3ff5a0)\\n"\n', true);
  const bin = path.join(root, 'bin'), effects = path.join(root, 'unexpected-effects'), npmCalls = path.join(root, 'npm-calls');
  write(path.join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RC_INSTALL_NPM_CALLS"\nexit 0\n', true);
  for (const name of ['curl', 'systemctl', 'nohup', 'gnome-extensions']) {
    write(path.join(bin, name), '#!/bin/sh\nprintf unexpected > "$RC_INSTALL_EFFECTS"\nexit 92\n', true);
  }
  const state = path.join(root, 'production-state');
  const route = path.join(state, 'chatgpt-remote-commander/routing/default.json');
  const activeConfig = path.join(root, 'production-config.json');
  write(route, JSON.stringify({ active: { configPath: activeConfig }, protected: 'production route' }) + '\n');
  write(activeConfig, '{"protected":"production config"}\n');
  const installedScript = path.join(root, 'installer-under-test.sh');
  write(installedScript, fs.readFileSync(path.join(repository, 'install.sh')), true);
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
    XDG_STATE_HOME: state, TMPDIR: root, REMOTE_COMMANDER_REPO_URL: source,
    RC_INSTALL_EFFECTS: effects, RC_INSTALL_NPM_CALLS: npmCalls };
  return { root, target, commit, route, activeConfig, installedScript, env, effects, npmCalls };
}

for (const mode of ['standard', 'power']) test(`Linux custom no-start ${mode} reuse leaves production routing/config/services/GUI untouched`, linuxOnly, t => {
  const f = fixture(t);
  const routeBefore = fs.readFileSync(f.route), configBefore = fs.readFileSync(f.activeConfig);
  const alias = path.join(f.root, 'custom-alias');
  fs.symlinkSync(f.target, alias, 'dir');
  const args = [f.installedScript, '--install-dir', alias, '--source-ref', 'HEAD', '--expected-commit', f.commit, `--${mode}-mode`];
  let saved;
  for (let repeat = 0; repeat < 2; repeat++) {
    const output = run('bash', repeat ? args.slice(0, -1) : args, { cwd: f.root, env: f.env });
    assert.match(output, /Updating isolated\/custom checkout in place without global routing mutation/);
    assert.match(output, /INSTALL_PASS/);
    assert.ok(output.includes(`Mode: ${mode === 'power' ? 'FULL_POWER' : 'STANDARD'}`));
    if (mode === 'power') assert.match(output, /Linux GUI registration deferred/);
    assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: f.target }), f.commit);
    assert.deepEqual(fs.readFileSync(f.route), routeBefore);
    assert.deepEqual(fs.readFileSync(f.activeConfig), configBefore);
    assert.equal(fs.existsSync(f.effects), false, 'no updater, network, service or GUI operation may run');
    const config = JSON.parse(fs.readFileSync(path.join(f.target, 'config.local.json')));
    const privateRoot = path.join(f.target, 'var/isolated') + path.sep;
    for (const location of repeat ? [] : [config.runtimeState, config.auditLog, config.powerMode.backupRoot,
      ...(config.durableWorkflows?.enabled ? [config.durableWorkflows.directory] : [])]) {
      assert.equal(typeof location, 'string');
      assert.ok(location.startsWith(privateRoot), `state must stay local to custom installation: ${location}`);
    }
    assert.equal(fs.existsSync(path.join(f.target, 'var/isolated/routing/default.json')), false);
    if (!repeat) {
      assert.deepEqual(config.allowedRoots, [path.join(f.target, 'workspace')]);
      config.allowedRoots = [path.join(f.root, 'user-selected-workspace')];
      config.allowedPrograms = ['node'];
      config.deviceName = 'custom-device-kept';
      config.port = 49531;
      config.instance = { profile: 'custom-profile', isolated: true };
      config.capabilityProfile.id = 'custom-profile';
      config.runtimeState = path.join(f.root, 'explicit-state/runtime.json');
      config.auditLog = path.join(f.root, 'explicit-state/audit.jsonl');
      config.powerMode.backupRoot = path.join(f.root, 'explicit-state/backups');
      config.durableWorkflows.directory = path.join(f.root, 'explicit-state/workflows');
      config.durableWorkflows.runner = { enabled: false, kind: 'codex', model: 'pinned-model', maxPlannerCalls: 7 };
      config.capabilityProfile.disabledCapabilities = ['shell.execute'];
      config.powerMode.allowShell = false;
      saved = config;
      write(path.join(f.target, 'config.local.json'), JSON.stringify(config));
      write(path.join(f.target, 'var/isolated/workflow-sentinel'), 'preserved');
      write(path.join(config.durableWorkflows.directory, 'workflows.sqlite'), 'must not be opened or migrated');
      write(config.runtimeState, 'must not be opened');
      write(config.auditLog, 'must not be appended');
    } else {
      assert.deepEqual(config.allowedRoots, saved.allowedRoots);
      assert.deepEqual(config.allowedPrograms, saved.allowedPrograms);
      assert.equal(config.deviceName, saved.deviceName);
      for (const key of ['host', 'port', 'instance', 'runtimeState', 'auditLog']) assert.deepEqual(config[key], saved[key]);
      assert.equal(config.capabilityProfile.id, saved.capabilityProfile.id);
      assert.equal(config.powerMode.backupRoot, saved.powerMode.backupRoot);
      assert.equal(config.durableWorkflows.directory, saved.durableWorkflows.directory);
      assert.equal(config.durableWorkflows.runner.enabled, false);
      assert.equal(config.durableWorkflows.runner.autoTick, false);
      assert.equal(config.durableWorkflows.runner.kind, 'disabled');
      assert.deepEqual(config.durableWorkflows.runner.provider, { kind: 'disabled', reason: 'NO_CODEX_VIA_COMMANDER' });
      assert.equal(config.durableWorkflows.runner.model, saved.durableWorkflows.runner.model);
      assert.equal(config.durableWorkflows.runner.maxPlannerCalls, saved.durableWorkflows.runner.maxPlannerCalls);
      assert.deepEqual(config.capabilityProfile.disabledCapabilities, saved.capabilityProfile.disabledCapabilities);
      assert.equal(config.powerMode.allowShell, false);
      assert.equal(fs.existsSync(config.allowedRoots[0]), false, 'preserving a configured root must not create it');
      assert.equal(fs.readFileSync(path.join(f.target, 'var/isolated/workflow-sentinel'), 'utf8'), 'preserved');
      assert.equal(fs.readFileSync(path.join(config.durableWorkflows.directory, 'workflows.sqlite'), 'utf8'), 'must not be opened or migrated');
      assert.equal(fs.readFileSync(config.runtimeState, 'utf8'), 'must not be opened');
      assert.equal(fs.readFileSync(config.auditLog, 'utf8'), 'must not be appended');
      assert.equal(fs.existsSync(config.powerMode.backupRoot), false);
    }
  }
  assert.deepEqual(fs.readFileSync(f.npmCalls, 'utf8').trim().split('\n'), ['run check:qualification', 'run test:qualification', 'run audit', 'run check:qualification', 'run test:qualification', 'run audit']);
});


test('Linux custom no-start skip-tunnel-client avoids network when no pinned client exists', linuxOnly, t => {
  const f = fixture(t);
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  fs.rmSync(path.join(f.target, `tools/tunnel-client-v0.0.15-linux-${arch}`), { recursive: true, force: true });
  const output = run('bash', [f.installedScript, '--install-dir', f.target, '--source-ref', 'HEAD',
    '--expected-commit', f.commit, '--standard-mode', '--skip-tunnel-client'], {
    cwd: f.root, env: f.env
  });
  assert.match(output, /Skipping tunnel-client installation as requested/);
  assert.match(output, /INSTALL_PASS/);
  assert.equal(fs.existsSync(f.effects), false, 'skip-tunnel-client must not invoke curl or mutate production services');
  assert.deepEqual(fs.readFileSync(f.route), fs.readFileSync(f.route));
  assert.deepEqual(fs.readFileSync(f.npmCalls, 'utf8').trim().split('\n'), ['run check:qualification', 'run test:qualification', 'run audit']);
});

test('Linux existing custom installation with explicit start retains candidate-first path', linuxOnly, t => {
  const f = fixture(t);
  const routeBefore = fs.readFileSync(f.route);
  const result = spawnSync('bash', [f.installedScript, '--install-dir', f.target, '--source-ref', 'HEAD',
    '--expected-commit', f.commit, '--standard-mode', '--start-server'], {
    cwd: f.root, env: f.env, encoding: 'utf8', timeout: 30000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 91, `fixture updater must be reached: ${result.stdout}\n${result.stderr}`);
  assert.equal(fs.readFileSync(f.effects, 'utf8'), 'updater');
  assert.deepEqual(fs.readFileSync(f.route), routeBefore);
  assert.equal(fs.existsSync(f.npmCalls), false, 'in-place gates must not replace explicit candidate-first update');
});

test('Linux canonical installation reached through an alias retains candidate-first no-start behavior', linuxOnly, t => {
  const f = fixture(t);
  const alias = path.join(f.root, 'canonical-alias');
  fs.symlinkSync(f.target, alias, 'dir');
  // Substitute only the canonical-home lookup; real readlink still resolves
  // the supplied alias. No files or environment under the real home change.
  const realReadlink = run('sh', ['-c', 'command -v readlink']);
  write(path.join(f.root, 'bin/readlink'), '#!/bin/sh\nfor item do last="$item"; done\nif [ "$last" = "$RC_CANONICAL_LOOKUP" ]; then\n  printf "%s\\n" "$RC_CANONICAL_FIXTURE"\nelse\n  exec "$RC_REAL_READLINK" "$@"\nfi\n', true);
  const routeBefore = fs.readFileSync(f.route);
  const result = spawnSync('bash', [f.installedScript, '--install-dir', alias, '--source-ref', 'HEAD',
    '--expected-commit', f.commit, '--standard-mode'], {
    cwd: f.root, env: { ...f.env, RC_REAL_READLINK: realReadlink, RC_CANONICAL_FIXTURE: f.target,
      RC_CANONICAL_LOOKUP: path.join(os.homedir(), '.local/share/ChatGPTRemoteCommander') },
    encoding: 'utf8', timeout: 30000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 91, `canonical updater must be reached: ${result.stdout}\n${result.stderr}`);
  assert.equal(fs.readFileSync(f.effects, 'utf8'), 'updater');
  assert.deepEqual(fs.readFileSync(f.route), routeBefore);
  assert.equal(fs.existsSync(f.npmCalls), false);
});


function installFailureFixture(t) {
  const f = fixture(t);
  const source = path.join(f.root, 'source');
  // This stub guarantees a post-checkout, pre-activation failure without any
  // network access or privileged operations.
  write(path.join(source, 'tools/install-tunnel-client-linux.sh'),
    "#!/bin/sh\nprintf 'FIXTURE_TUNNEL_FAILURE\\n' >&2\nexit 79\n", true);
  run('git', ['add', 'tools/install-tunnel-client-linux.sh'], { cwd: source });
  run('git', ['commit', '-m', 'test: simulate preactivation dependency failure'], { cwd: source });
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: source });
  return { ...f, source, commit };
}

test('new Linux installation quarantines only its own incomplete checkout after dependency failure', linuxOnly, t => {
  const f = installFailureFixture(t);
  // fixture() creates an older existing test installation; discard only this
  // fixture-owned directory to exercise true first installation semantics.
  fs.rmSync(f.target, { recursive: true, force: true });
  const route = fs.readFileSync(f.route), config = fs.readFileSync(f.activeConfig);
  const result = spawnSync('bash', [f.installedScript, '--install-dir', f.target, '--source-ref', 'HEAD',
    '--expected-commit', f.commit, '--standard-mode'], { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 79, result.stdout + '\n' + result.stderr);
  assert.match(result.stderr, /FIXTURE_TUNNEL_FAILURE/);
  assert.match(result.stderr, /FRESH_INSTALL_QUARANTINED/);
  assert.equal(fs.existsSync(f.target), false, 'failed new installation must not remain active at target');
  const quarantines = fs.readdirSync(f.root).filter(name => name.startsWith('custom-install.failed-install-'));
  assert.equal(quarantines.length, 1, 'preserve exactly one recoverable quarantine');
  const saved = path.join(f.root, quarantines[0]);
  assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: saved }), f.commit);
  assert.equal(fs.existsSync(path.join(saved, 'config.local.json')), false);
  assert.deepEqual(fs.readFileSync(f.route), route);
  assert.deepEqual(fs.readFileSync(f.activeConfig), config);
  assert.equal(fs.existsSync(f.effects), false, 'no production services or GUIs may be touched');
});

test('existing custom Linux install is preserved when a later dependency fails', linuxOnly, t => {
  const f = installFailureFixture(t);
  const sentinel = path.join(f.target, 'owner-sentinel');
  write(sentinel, 'user data must survive\n');
  const before = fs.readFileSync(sentinel);
  const result = spawnSync('bash', [f.installedScript, '--install-dir', f.target, '--source-ref', 'HEAD',
    '--expected-commit', f.commit, '--standard-mode'], { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 79, result.stdout + '\n' + result.stderr);
  assert.match(result.stderr, /FIXTURE_TUNNEL_FAILURE/);
  assert.doesNotMatch(result.stderr, /FRESH_INSTALL_QUARANTINED/);
  assert.equal(fs.existsSync(f.target), true);
  assert.deepEqual(fs.readFileSync(sentinel), before);
  assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: f.target }), f.commit);
  assert.equal(fs.readdirSync(f.root).filter(name => name.startsWith('custom-install.failed-install-')).length, 0);
  assert.equal(fs.existsSync(f.effects), false);
});
