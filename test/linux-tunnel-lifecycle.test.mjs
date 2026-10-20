import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');

function bashPath(){
  if(process.platform!=='win32')return 'bash';
  const candidates=[
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe'
  ];
  return candidates.find(fs.existsSync) ?? null;
}

test('linux tunnel supervisor never self-stops its own service and scopes recycle to owned profile tunnels',()=>{
  const s=read('autostart-linux.sh');
  assert.doesNotMatch(s,/systemctl\s+--user\s+stop\s+chatgpt-remote-commander\.service/);
  assert.match(s,/candidate_tunnels\(\)/);
  assert.match(s,/sort -V/);
  assert.match(s,/owned_tunnel_exe\(\)/);
  assert.match(s,/stop_owned_profile_tunnels\s+"\$profile"/);
  assert.match(s,/--profile-dir\s+"\$PROFILE_DIR"/);
  assert.match(s,/TUNNEL_CANDIDATE_REJECTED/);
  assert.match(s,/TUNNEL_ROLLBACK_PASS/);
  assert.match(s,/rejected_tunnel_file/);
  assert.match(s,/control_plane_fresh\(\)/);
  assert.match(s,/commands_poll_last_successful_timestamp_seconds/);
  assert.match(s,/TUNNEL_CONTROL_PLANE_STALE/);
  assert.match(s,/REMOTE_COMMANDER_TUNNEL_STALE_SECONDS/);
  assert.match(s,/tools\/tunnel-log-runner[.]mjs/);
  assert.match(s,/--log[.]file stdout/);
  assert.match(s,/--max-bytes 8388608/);
  assert.match(s,/--max-files 3/);
  assert.match(s,/log[.]rotation[.]json/);
  const enroll=read('enable-autostart-linux.sh');
  assert.ok(enroll.includes('^tunnel_[0-9a-f]{32}$'),'Linux enrollment must enforce the official tunnel ID format');
});

test('linux tunnel selection never falls back to an executable from caller PATH',()=>{
  const script=read('autostart-linux.sh');
  const start=script.indexOf('find_tunnel() {');
  const end=script.indexOf('\nfallback_tunnel() {',start);
  assert.ok(start>=0&&end>start,'find_tunnel must remain a defined supervisor function');
  const source=script.slice(start,end);
  assert.match(source,/mapfile -t candidates < <\(candidate_tunnels\)/);
  assert.match(source,/return 1\s*\n}/,'missing managed clients must fail closed');
  assert.doesNotMatch(source,/command\s+-v\s+tunnel-client/,'PATH lookup is not a verified pinned install');
  assert.doesNotMatch(source,/\bwhich\s+tunnel-client/);
  assert.match(script,/function|find_tunnel\(\)/);
});

test('linux autostart enables user lingering when systemd user services are available',()=>{
  const s=read('enable-autostart-linux.sh');
  assert.match(s,/loginctl enable-linger "\$USER"/);
  assert.match(s,/loginctl show-user "\$USER" -p Linger --value/);
  assert.match(s,/linger=\$\{LINGER_STATUS:-n\/a\}/);
});

test('fresh linux installer delegates tunnel install to the single pinned helper',()=>{
  const s=read('install.sh');
  assert.doesNotMatch(s,/^TUNNEL_VERSION=/m);
  assert.match(s,/tools\/tunnel-client-pin\.json/);
  assert.match(s,/tools\/install-tunnel-client-linux\.sh/);
  assert.match(s,/\/bin\/bash "\$helper" --install-dir "\$INSTALL_DIR"/);
  assert.match(s,/chmod \+x[\s\S]*install-tunnel-client-linux\.sh/);
});

test('pinned tunnel release downloads use bounded transient retries without weakening hash gates',()=>{
  const s=read('tools/install-tunnel-client-linux.sh');
  assert.match(s,/curl_release_fetch\(\)/);
  assert.match(s,/--retry 4/);
  assert.match(s,/--retry-delay 2/);
  assert.match(s,/--retry-max-time 90/);
  assert.match(s,/--retry-connrefused/);
  assert.doesNotMatch(s,/--retry-all-errors/);
  assert.match(s,/curl_release_fetch "\$BASE\/SHA256SUMS[.]txt" "\$TMP\/SHA256SUMS[.]txt"/);
  assert.match(s,/curl_release_fetch "\$BASE\/\$ASSET" "\$TMP\/\$ASSET"/);
  assert.match(s,/ACTUAL_SUMS_SHA=.*sha256sum/);
  assert.match(s,/ACTUAL_ASSET_SHA=.*sha256sum/);
  assert.match(s,/Tunnel-client SHA256SUMS pin mismatch/);
  assert.match(s,/Tunnel-client asset SHA-256 mismatch/);
});

test('tunnel pin has exact qualified v0.0.15 provenance',()=>{
  const pin=JSON.parse(read('tools/tunnel-client-pin.json'));
  assert.equal(pin.version,'0.0.15');
  assert.equal(pin.releaseTag,'v0.0.15');
  assert.equal(pin.upstreamCommit,'a390c168ff1b2d14e73a95991c186c6aba3ff5a0');
  assert.equal(pin.sha256sumsSha256,'8a32bbcd724468f1874f12d5b0dedb6e6b07dfe5aa323cf5b4c070a5a81b0b4e');
});

test('linux lifecycle shell files parse and tunnel installer self-test resolves the pin',()=>{
  const bash=bashPath();
  if(!bash)return;
  for(const rel of ['autostart-linux.sh','enable-autostart-linux.sh','install.sh','tools/install-tunnel-client-linux.sh']){
    const p=path.join(root,rel);
    const r=spawnSync(bash,['-n',p],{encoding:'utf8'});
    assert.equal(r.status,0,rel+' bash -n failed: '+r.stderr);
  }
  const self=spawnSync(bash,[path.join(root,'tools/install-tunnel-client-linux.sh'),'--install-dir',root,'--self-test'],{
    cwd:root,encoding:'utf8',env:{...process.env,PATH:process.env.PATH}
  });
  assert.equal(self.status,0,self.stderr);
  const body=JSON.parse(self.stdout.trim());
  assert.equal(body.ok,true);
  assert.equal(body.version,'0.0.15');
  assert.equal(body.tag,'v0.0.15');
});
