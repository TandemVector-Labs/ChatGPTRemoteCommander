import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=fs.readFileSync(path.join(root,'autostart-linux.sh'),'utf8');
function block(name) {
  if(typeof name!=='string'||!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name))
    throw Error('INVALID_BASH_FUNCTION_NAME');
  const escaped=name;
  const match=source.match(new RegExp('^'+escaped+'\\(\\) \\{[\\s\\S]*?^\\}', 'm'));
  assert.ok(match, 'missing function '+name);
  return match[0];
}
test('stale-poll restart budget applies independently to every owner profile before termination',()=>{
  assert.match(source,/stale_owned=1/);
  assert.ok(!source.includes('if [[ "$profile" == "mmz-linux" ]];'),
            'every owner profile must use its own cooldown');
  assert.match(source,/stale_restart_budget "\\$profile" \\|\\| return 0/);
  assert.ok(source.indexOf('stale_restart_budget "$profile" || return 0') <
            source.indexOf('stop_owned_profile_tunnels "$profile"'));
  assert.match(source,/TUNNEL_SHARED_CONTROL_PLANE_STALE_PRESERVED/);
  assert.match(source,/TUNNEL_ISOLATED_CONTROL_PLANE_STALE_RECYCLE/);
  assert.match(source,/fresh_owner_peer_tunnels/);
  assert.match(source,/REMOTE_COMMANDER_TUNNEL_ISOLATED_STALE_SECONDS/);
  assert.match(source,/REMOTE_COMMANDER_TUNNEL_STALE_RESTART_MIN_INTERVAL/);
});
test('stale recycle budget allows first attempt, defers bursts, resets after 15m, isolates profiles',{skip:process.platform!=='linux'},()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rc-stale-cooldown-'));
  try {
    const bash=block('safe_profile')+'\n'+block('stale_restart_budget')+
      `\nset -euo pipefail
VAR_DIR="$1"
date(){ if [[ "$1" == "+%s" ]];then printf '%s\\n' "$NOW";else command date "$@";fi; }
NOW=1700000000
if stale_restart_budget mmz-linux;then echo FIRST_ALLOWED;else echo FIRST_DENIED;fi
NOW=1700000001
if stale_restart_budget mmz-linux;then echo BURST_ALLOWED;else echo BURST_DENIED;fi
NOW=1700000200
if stale_restart_budget emad-mmz;then echo OTHER_PROFILE_ALLOWED;else echo OTHER_PROFILE_DENIED;fi
NOW=1700000899
if stale_restart_budget mmz-linux;then echo BEFORE_LIMIT_ALLOWED;else echo BEFORE_LIMIT_DENIED;fi
NOW=1700000900
if stale_restart_budget mmz-linux;then echo AFTER_LIMIT_ALLOWED;else echo AFTER_LIMIT_DENIED;fi
REMOTE_COMMANDER_TUNNEL_STALE_RESTART_MIN_INTERVAL=invalid
NOW=1700000901
if stale_restart_budget mmz-linux;then echo INVALID_OVERRIDE_ALLOWED;else echo INVALID_OVERRIDE_DENIED;fi
cat "$VAR_DIR/tunnel-stale-restart-mmz-linux.epoch"
stat -c 'STAMP_MODE=%a' "$VAR_DIR/tunnel-stale-restart-mmz-linux.epoch"
`;
    const r=spawnSync('bash',['-s','--',temp],{input:bash,encoding:'utf8',timeout:4000,env:{PATH:process.env.PATH,HOME:process.env.HOME}});
    assert.equal(r.status,0,r.stderr);
    const lines=r.stdout.trim().split('\n');
    assert.deepEqual(lines,[
      'FIRST_ALLOWED','BURST_DENIED','OTHER_PROFILE_ALLOWED',
      'BEFORE_LIMIT_DENIED','AFTER_LIMIT_ALLOWED','INVALID_OVERRIDE_DENIED',
      '1700000900','STAMP_MODE=600'
    ]);
  }finally{fs.rmSync(temp,{force:true,recursive:true});}
});

test('shared cellular outage never kills ready owner-private tunnels; isolated stale recycles only after two fresh peers',{skip:process.platform!=='linux'},()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rc-lte-shared-peer-'));
  try {
    const script=[
      block('safe_profile'),
      block('stale_restart_budget'),
      block('fresh_owner_peer_tunnels'),
      block('start_tunnel'),
      String.raw`
set -euo pipefail
VAR_DIR="$1"
PROFILE_DIR="$VAR_DIR/profiles"
mkdir -p "$PROFILE_DIR"
for p in mmz-linux emad-mmz saeid-mmz;do : > "$PROFILE_DIR/$p.yaml";done
: > "$VAR_DIR/stop-record"
: > "$VAR_DIR/events.log"
CRED="$VAR_DIR/credential"
: > "$CRED"
NOW=1700000000
date(){ if [[ "$1" == "+%s" ]];then printf '%s\n' "$NOW";else command date "$@";fi; }
sleep(){ :; }
profile_health_port(){
 case "$(basename "$1")" in
  mmz-linux.yaml) echo 47832 ;;
  saeid-mmz.yaml) echo 47833 ;;
  emad-mmz.yaml) echo 47834 ;;
  *) return 1 ;;
 esac
}
profile_matches(){ return 0; }
find_tunnel(){ echo /bin/true; }
rejected_tunnel_file(){ echo "$VAR_DIR/rejected.$1"; }
profile_tunnel_rows(){
 [[ "$NO_CHILD" == 1 ]] && return 0
 printf '4242\t/bin/true\n'
}
owned_tunnel_exe(){ return 0; }
tunnel_ready(){ return 0; }
control_plane_fresh(){
 if [[ "$#" -ge 2 && "$2" == 180 ]];then return 1;fi
 case "$SCENARIO:$1" in
  isolated:47833|isolated:47834|onepeer:47833) return 0 ;;
  *) return 1 ;;
 esac
}
control_plane_recent_success(){ control_plane_fresh "$1"; }
network_route_present(){ return 0; }
stop_owned_profile_tunnels(){ echo "$1" >> "$VAR_DIR/stop-record"; }
launch_tunnel_with_exe(){ STARTED_TUNNEL_PID=777;return 0; }
wait_tunnel_ready(){ return 0; }
log(){ echo "$*" >> "$VAR_DIR/events.log"; }
NO_CHILD=0
SCENARIO=shared
start_tunnel mmz-linux "$CRED" "$PROFILE_DIR/mmz-linux.yaml"
start_tunnel emad-mmz "$CRED" "$PROFILE_DIR/emad-mmz.yaml"
start_tunnel saeid-mmz "$CRED" "$PROFILE_DIR/saeid-mmz.yaml"
echo SHARED_OUTAGE_STOPS="$(wc -l < "$VAR_DIR/stop-record")"
test -f "$VAR_DIR/tunnel-stale-preserved-mmz-linux.epoch"
test -f "$VAR_DIR/tunnel-stale-preserved-emad-mmz.epoch"
test -f "$VAR_DIR/tunnel-stale-preserved-saeid-mmz.epoch"
test ! -e "$VAR_DIR/tunnel-stale-restart-mmz-linux.epoch"
SCENARIO=onepeer
start_tunnel mmz-linux "$CRED" "$PROFILE_DIR/mmz-linux.yaml"
echo ONE_FRESH_PEER_STOPS="$(wc -l < "$VAR_DIR/stop-record")"
SCENARIO=isolated
start_tunnel mmz-linux "$CRED" "$PROFILE_DIR/mmz-linux.yaml"
echo ISOLATED_TWO_PEERS_STOPS="$(wc -l < "$VAR_DIR/stop-record")"
NOW=1700000001
start_tunnel mmz-linux "$CRED" "$PROFILE_DIR/mmz-linux.yaml"
echo REPEATED_ISOLATED_STOPS="$(wc -l < "$VAR_DIR/stop-record")"
NOW=1700000899
start_tunnel mmz-linux "$CRED" "$PROFILE_DIR/mmz-linux.yaml"
echo BEFORE_RESTART_BUDGET_STOPS="$(wc -l < "$VAR_DIR/stop-record")"
NOW=1700000900
start_tunnel mmz-linux "$CRED" "$PROFILE_DIR/mmz-linux.yaml"
echo AFTER_RESTART_BUDGET_STOPS="$(wc -l < "$VAR_DIR/stop-record")"
NO_CHILD=1
SCENARIO=shared
start_tunnel saeid-mmz "$CRED" "$PROFILE_DIR/saeid-mmz.yaml"
echo MISSING_PROCESS_RECOVERY_STOPS="$(wc -l < "$VAR_DIR/stop-record")"
echo PRESERVED_LOGS="$(grep -c TUNNEL_SHARED_CONTROL_PLANE_STALE_PRESERVED "$VAR_DIR/events.log")"
echo ISOLATED_RECYCLES="$(grep -c TUNNEL_ISOLATED_CONTROL_PLANE_STALE_RECYCLE "$VAR_DIR/events.log")"
`
    ].join('\n');
    const result=spawnSync('bash',['-s','--',temp],{input:script,
      encoding:'utf8',timeout:6000,env:{PATH:process.env.PATH,HOME:process.env.HOME}
    });
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'),[
      'SHARED_OUTAGE_STOPS=0',
      'ONE_FRESH_PEER_STOPS=0',
      'ISOLATED_TWO_PEERS_STOPS=1',
      'REPEATED_ISOLATED_STOPS=1',
      'BEFORE_RESTART_BUDGET_STOPS=1',
      'AFTER_RESTART_BUDGET_STOPS=2',
      'MISSING_PROCESS_RECOVERY_STOPS=3',
      'PRESERVED_LOGS=3',
      'ISOLATED_RECYCLES=2'
    ]);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});

test('a recent 100–400 second poll is not considered stuck under LTE-specific 600-second grace',{skip:process.platform!=='linux'},()=>{
  const script=[
    block('control_plane_fresh'),
    String.raw`
set -euo pipefail
NOW=1700001000
METRIC_LAST=1700000800
date(){ if [[ "$1" == "+%s" ]];then printf '%s\n' "$NOW";else command date "$@";fi; }
curl(){ printf 'commands_poll_last_successful_timestamp_seconds{otel_scope_name="controlplane"} %s\nprocess_start_time_seconds 1700000000\n' "$METRIC_LAST"; }
if control_plane_fresh 47832;then echo DEFAULT_READY;else echo DEFAULT_STALE;fi
if control_plane_fresh 47832 600;then echo LTE_GRACE_READY;else echo LTE_GRACE_STALE;fi
METRIC_LAST=1700000400
if control_plane_fresh 47832 600;then echo BORDER_READY;else echo BORDER_STALE;fi
METRIC_LAST=1700000399
if control_plane_fresh 47832 600;then echo BEYOND_READY;else echo BEYOND_STALE;fi
`
  ].join('\n');
  const r=spawnSync('bash',['-s'],{input:script,encoding:'utf8',timeout:4000,env:{PATH:process.env.PATH,HOME:process.env.HOME}});
  assert.equal(r.status,0,r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'),[
    'DEFAULT_STALE','LTE_GRACE_READY','BORDER_READY','BEYOND_STALE'
  ]);
});

test('independent peer requires an actual recent successful poll; missing and startup-only metrics fail closed',()=>{
  const script=[
    block('control_plane_recent_success'),
    'set -euo pipefail',
    'NOW=1700001000; LAST=1700000950; MODE=normal',
    'date(){ if [[ "$1" == "+%s" ]];then echo "$NOW"; else command date "$@"; fi; }',
    'curl(){ if [[ "$MODE" == down ]];then return 7;fi; if [[ "$MODE" == boot ]];then echo "process_start_time_seconds 1700000990";return;fi; if [[ "$MODE" == corrupt ]];then echo "commands_poll_last_successful_timestamp_seconds invalid";return;fi; printf "commands_poll_last_successful_timestamp_seconds{scope=controlplane} %s\\n" "$LAST"; }',
    'if control_plane_recent_success 47833;then echo FRESH;else echo BAD_FRESH;fi',
    'LAST=1700000800',
    'if control_plane_recent_success 47833;then echo BAD_STALE;else echo STALE;fi',
    'MODE=boot',
    'if control_plane_recent_success 47833;then echo BAD_BOOT;else echo BOOT_ONLY;fi',
    'MODE=corrupt',
    'if control_plane_recent_success 47833;then echo BAD_MALFORMED;else echo MALFORMED;fi',
    'MODE=down',
    'if control_plane_recent_success 47833;then echo BAD_DOWN;else echo UNAVAILABLE;fi',
    'MODE=normal;LAST=1700001100',
    'if control_plane_recent_success 47833;then echo BAD_FUTURE;else echo FUTURE;fi'
  ].join('\n');
  const r=spawnSync('bash',['-s'],{input:script,encoding:'utf8',timeout:4000,
    env:{PATH:process.env.PATH,HOME:process.env.HOME}});
  assert.equal(r.status,0,r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'),[
    'FRESH','STALE','BOOT_ONLY','MALFORMED','UNAVAILABLE','FUTURE'
  ]);
});