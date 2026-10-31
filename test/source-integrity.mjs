import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const read = (p) => fs.readFileSync(p, 'utf8');
const count = (text, needle) => text.split(needle).length - 1;
const exact = (text, needle, expected, label) => {
  const actual = count(text, needle);
  if (actual !== expected) throw new Error(`${label}: expected ${expected} occurrence(s) of ${needle}, found ${actual}`);
};

const install = read('install.ps1');
if (!install.startsWith('param(') || install.split(/\r?\n/).length > 650) throw new Error('install.ps1 structural envelope invalid');
for (const fn of ['function Install-Source {','function Install-TunnelClient {','function Configure-LocalPolicy {','function Start-LocalServer {']) exact(install, fn, 1, 'install.ps1');
exact(install, "Write-Host 'INSTALL_PASS'", 1, 'install.ps1');
exact(install, 'Require-Windows', 2, 'install.ps1'); // definition + invocation

const supervisor = read('autostart-windows.ps1');
if (!supervisor.startsWith('param(') || supervisor.split(/\r?\n/).length > 390) throw new Error('autostart-windows.ps1 structural envelope invalid');
for (const marker of ['function Find-TunnelExe {','function Start-TunnelProfile($Item) {','SUPERVISOR_STARTED','TUNNEL_READY']) {
  exact(supervisor, marker, 1, 'autostart-windows.ps1');
}

const enable = read('enable-autostart.ps1');
if (!enable.startsWith('param(') || enable.split(/\r?\n/).length > 320) throw new Error('enable-autostart.ps1 structural envelope invalid');
for (const marker of ['function Find-TunnelExe {','function Ensure-McpHealth {','AUTOSTART_ENROLL_PASS']) exact(enable, marker, 1, 'enable-autostart.ps1');

const disable = read('disable-autostart.ps1');
if (!disable.startsWith('param(') || disable.split(/\r?\n/).length > 180) throw new Error('disable-autostart.ps1 structural envelope invalid');
exact(disable, 'AUTOSTART_DISABLED', 1, 'disable-autostart.ps1');

const account = read('connect-chatgpt-account.ps1');
if (!account.startsWith('param(') || account.split(/\r?\n/).length > 80) throw new Error('connect-chatgpt-account.ps1 structural envelope invalid');
exact(account, 'CONNECT_ACCOUNT_PASS', 1, 'connect-chatgpt-account.ps1');

for (const [name, text] of [['install',install],['supervisor',supervisor],['enable',enable],['disable',disable],['account',account]]) {
  if (text.includes('\u0000')) throw new Error(name + ' contains NUL');
  if (!text.endsWith('\n')) throw new Error(name + ' must end with newline');
}


const trackedRuntimeFiles = [
  'auto-update-windows.ps1','auto-update-linux.sh',
  'supervisor-routing.ps1','supervisor-routing-linux.sh',
  'src/capability-profile.mjs','src/project-runner-config.mjs','src/stable-router.mjs','src/workflow-autonomy.mjs','src/delivery-store.mjs','src/delivery-tools.mjs',
  'src/browser-contract.mjs','src/browser-process.mjs','src/browser-tools.mjs','tools/browser-control.mjs','tools/browser-control-firefox.mjs','test/browser-helper-lifecycle-run.mjs','test/browser-firefox-native.test.mjs',
  'tools/merge-primary-policy.mjs','tools/build-candidate-config.mjs','tools/capability-migrate.mjs','tools/copy-workflow-store.mjs',
  'tools/finalize-workflow-schema.mjs','tools/find-free-port.mjs','tools/hardware-selftest.mjs',
  'tools/json-field.mjs','tools/retained-backends.mjs','tools/tunnel-log-runner.mjs','tools/gui-control-linux.py','tools/install-gnome-gui-extension.sh','tools/router-init.mjs','tools/router-state.mjs','tools/router-status.mjs','tools/router-switch.mjs','tools/router-retire.mjs','tools/stale-drain-policy.ps1'
];
for (const file of trackedRuntimeFiles) {
  if (!fs.existsSync(file)) throw new Error('required runtime file missing: ' + file);
  const r = spawnSync('git',['ls-files','--error-unmatch',file],{encoding:'utf8'});
  if (r.status !== 0) throw new Error('required runtime file is not Git-tracked: ' + file);
}


const linuxExecFiles = [
  'install.sh','auto-update-linux.sh','autostart-linux.sh','supervisor-routing-linux.sh',
  'enable-autostart-linux.sh','disable-autostart-linux.sh','connect-chatgpt-account.sh','run-server.sh',
  'tools/gui-control-linux.py','tools/install-gnome-gui-extension.sh'
];
for (const file of linuxExecFiles) {
  const r = spawnSync('git',['ls-files','--stage',file],{encoding:'utf8'});
  if (r.status !== 0 || !/^100755\s/.test(r.stdout)) {
    throw new Error('Linux runtime script must be Git-tracked executable (100755): ' + file);
  }
}

const linuxAutostart = read('autostart-linux.sh');
const linuxEnable = read('enable-autostart-linux.sh');
const linuxDisable = read('disable-autostart-linux.sh');
const linuxAccount = read('connect-chatgpt-account.sh');
const linuxInstall = read('install.sh');
for (const [name,text] of [
  ['autostart-linux.sh',linuxAutostart],['enable-autostart-linux.sh',linuxEnable],
  ['connect-chatgpt-account.sh',linuxAccount]
]) {
  if (!text.includes('.runtime/node-current/bin')) throw new Error(name + ' must bootstrap portable Node PATH');
}
if (!linuxAutostart.includes('RUNTIME_MISSING')) throw new Error('Linux supervisor must fail visibly when Node/npm runtime is unavailable');
if (!linuxEnable.includes('Environment="PATH=$RUNTIME_BIN:')) throw new Error('Linux systemd unit must carry the portable runtime PATH');
for (const marker of ['ROUTE="$STATE_ROOT/routing/default.json"','ROUTER_RUNTIME="$STATE_ROOT/routing/default.runtime.json"','stable-router.mjs','src/server-v0.3.mjs']) {
  if (!linuxDisable.includes(marker)) throw new Error('Linux disable lifecycle cleanup missing marker: ' + marker);
}
if (linuxInstall.includes('curl -fsSL "$base/$asset"')) throw new Error('tunnel-client download must use bounded curl_fetch');
if (!linuxInstall.includes('curl_fetch "$base/$asset" -o "$tmp/$asset"')) throw new Error('bounded tunnel-client asset download missing');


console.log('SOURCE_INTEGRITY_PASS');
