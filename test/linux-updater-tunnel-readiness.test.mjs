import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=fs.readFileSync(path.join(root,'auto-update-linux.sh'),'utf8');

function bashPath(){
  if(process.platform!=='win32')return 'bash';
  for(const p of ['C:\\Program Files\\Git\\bin\\bash.exe','C:\\Program Files\\Git\\usr\\bin\\bash.exe'])if(fs.existsSync(p))return p;
  return null;
}

function readinessFunctions(){
  const start=source.indexOf('tunnel_control_plane_fresh(){');
  const end=source.indexOf('\nstop_owned_from_config(){',start);
  assert.ok(start>0&&end>start,'readiness function block must be extractable');
  return source.slice(start,end);
}

function runScenario({ready='not-ready',health='live',metric='fresh',age=10,profile='fixture',targetPort=47831,privateTargets=''}={}){
  const bash=bashPath();
  if(!bash)return {skip:true};
  const id='tmp-tunnel-ready-'+process.pid+'-'+Math.random().toString(16).slice(2);
  const dir=path.join(root,'test',id);
  const bin=path.join(dir,'bin');
  const profiles=path.join(dir,'profiles');
  fs.mkdirSync(bin,{recursive:true});
  fs.mkdirSync(profiles,{recursive:true});
  fs.writeFileSync(path.join(profiles,profile+'.yaml'),[
    'health:',
    '  listen_addr: 127.0.0.1:47991',
    'mcp:',
    '  server_urls:',
    '    - channel: main',
    '      url: http://127.0.0.1:'+targetPort+'/mcp'
  ].join('\n')+'\n');
  const fakeCurl=path.join(bin,'curl');
  fs.writeFileSync(fakeCurl,`#!/usr/bin/env bash
set -euo pipefail
url="\${!#}"
case "$url" in
  */readyz) printf '%s' "$FAKE_READY";;
  */healthz) printf '%s' "$FAKE_HEALTH";;
  */metrics)
    if [[ "$FAKE_METRIC" == fresh ]]; then
      printf 'commands_poll_last_successful_timestamp_seconds %s\\n' "$(( $(date +%s) - FAKE_AGE ))"
    elif [[ "$FAKE_METRIC" == zero ]]; then
      printf 'commands_poll_last_successful_timestamp_seconds 0\\n'
    else
      exit 22
    fi
    ;;
  *) exit 23;;
esac
`);
  fs.chmodSync(fakeCurl,0o755);
  const script=[
    'set -euo pipefail',
    'PATH="$PWD/test/'+id+'/bin:$PATH"',
    'PROFILE_DIR="$PWD/test/'+id+'/profiles"',
    'log(){ :; }',
    readinessFunctions(),
    'tunnels_ready'
  ].join('\n');
  const result=spawnSync(bash,['-lc',script],{
    cwd:root,encoding:'utf8',
    env:{...process.env,FAKE_READY:ready,FAKE_HEALTH:health,FAKE_METRIC:metric,FAKE_AGE:String(age),REMOTE_COMMANDER_TUNNEL_PRIVATE_TARGETS:privateTargets}
  });
  fs.rmSync(dir,{recursive:true,force:true});
  return result;
}

test('Linux updater tunnel gate accepts native readyz',t=>{
  if(!bashPath()){t.skip('bash unavailable');return;}
  const r=runScenario({ready:'ready',health:'dead',metric:'missing'});
  assert.equal(r.status,0,r.stderr||r.stdout);
});

test('Linux updater tunnel gate accepts live tunnel with fresh successful control-plane poll when readyz is stale',t=>{
  if(!bashPath()){t.skip('bash unavailable');return;}
  const r=runScenario({ready:'oauth discovery failed',health:'live',metric:'fresh',age:10});
  assert.equal(r.status,0,r.stderr||r.stdout);
});

test('Linux updater tunnel gate rejects stale control-plane fallback',t=>{
  if(!bashPath()){t.skip('bash unavailable');return;}
  const r=runScenario({ready:'oauth discovery failed',health:'live',metric:'fresh',age:180});
  assert.notEqual(r.status,0);
});

test('Linux updater tunnel gate rejects missing control-plane metric fallback',t=>{
  if(!bashPath()){t.skip('bash unavailable');return;}
  const r=runScenario({ready:'oauth discovery failed',health:'live',metric:'missing'});
  assert.notEqual(r.status,0);
});

test('Linux updater tunnel gate rejects non-live process even with fresh metric',t=>{
  if(!bashPath()){t.skip('bash unavailable');return;}
  const r=runScenario({ready:'oauth discovery failed',health:'dead',metric:'fresh',age:0});
  assert.notEqual(r.status,0);
});

test('Linux updater tunnel fallback is fail-closed and precedes cutover commit',()=>{
  assert.match(source,/tunnel_control_plane_fresh\(\)/);
  assert.match(source,/commands_poll_last_successful_timestamp_seconds/);
  assert.match(source,/TUNNEL_READINESS_FRESH_FALLBACK/);
  assert.match(source,/TUNNEL_READINESS_BLOCK/);
  assert.match(source,/\[\[ -n "\$metrics" \]\] \|\| return 1/);
  assert.match(source,/\[\[ "\$live" == live \]\]/);
  const cutover=source.lastIndexOf('CUTOVER_COMMITTED=1');
  assert.ok(source.indexOf('tunnels_ready',cutover)<cutover);
});

test('Linux updater accepts explicitly allowed private backend',t=>{
  if(!bashPath()){t.skip('bash unavailable');return;}
  const r=runScenario({ready:'ready',profile:'emad-mmz',targetPort:47921,
    privateTargets:'emad-mmz:47921,saeid-mmz:47922'});
  assert.equal(r.status,0,r.stderr||r.stdout);
});
test('Linux updater denies non-live allowlisted private tunnel',t=>{
  if(!bashPath()){t.skip('bash unavailable');return;}
  const r=runScenario({ready:'not-ready',health:'dead',profile:'saeid-mmz',targetPort:47922,
    privateTargets:'emad-mmz:47921,saeid-mmz:47922'});
  assert.notEqual(r.status,0);
});
test('Linux updater denies wrong private target despite readyz',t=>{
  if(!bashPath()){t.skip('bash unavailable');return;}
  const r=runScenario({ready:'ready',profile:'emad-mmz',targetPort:47922,
    privateTargets:'emad-mmz:47921,saeid-mmz:47922'});
  assert.notEqual(r.status,0);
});
