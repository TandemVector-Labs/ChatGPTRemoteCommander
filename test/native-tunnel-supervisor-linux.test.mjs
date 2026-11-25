import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseNativeHealthPort,parseNativeLastPoll,parseNativeControlPlaneOrigin,chooseNativeRecovery}
  from '../src/native-tunnel-supervisor-linux.mjs';

const now=1_800_000_000_000;
const ownLast=now-420_000;
const startedAt=now-600_000;
const stale=id=>({profile:id,last:now-410_000});
const fresh=id=>({profile:id,last:now-10_000});
const baseline=()=>({now,startedAt,ownLast,
  peers:[stale('emad-mmz'),stale('saeid-mmz')],
  marker:null,previous:null});

test('native supervisor accepts only pinned IPv4 loopback health ports',()=>{
  assert.equal(parseNativeHealthPort('health:\n  listen_addr: 127.0.0.1:47832\n'),47832);
  assert.equal(parseNativeHealthPort('listen_addr: "127.0.0.1:47834"'),47834);
  for(const s of ['listen_addr: 0.0.0.0:47832','listen_addr: 127.0.0.1:80',
    'listen_addr: 127.0.0.1:99999','listen_addr: example.com:47832',
    'listen_addr: 127.0.0.1:47832extra','not-a-port'])assert.equal(parseNativeHealthPort(s),null,s);
});

test('native supervisor accepts only actual positive Control Plane Poll time',()=>{
  const stamp='2026-11-21T13:15:42.904338049Z';
  const payload={component:'control-plane',status:'degraded',
    details:{last_success:stamp}};
  assert.equal(parseNativeLastPoll(payload),Date.parse(stamp));
  for(const x of [null,{}, {component:'other',details:{last_success:stamp}},
    {component:'control-plane',details:{}},
    {component:'control-plane',details:{last_success:'yesterday'}},
    {component:'control-plane',details:{last_success:9}}])
    assert.equal(parseNativeLastPoll(x),null);
});

test('native VPN route recovery accepts three minutes, but never a younger or weak shared stall',()=>{
  const base={now,startedAt:now-180_000,ownLast:now-180_000,
    peers:[{profile:'emad-mmz',last:now-180_000},
      {profile:'saeid-mmz',last:now-180_000}],
    marker:null,previous:null};
  assert.equal(chooseNativeRecovery(base),true);
  assert.equal(chooseNativeRecovery({...base,startedAt:now-179_999}),false);
  assert.equal(chooseNativeRecovery({...base,ownLast:now-179_999}),false);
  assert.equal(chooseNativeRecovery({...base,
    peers:[{profile:'emad-mmz',last:now-179_999},
      {profile:'saeid-mmz',last:now-180_000}]}),false);
  assert.equal(chooseNativeRecovery({...base,previous:now-899_999}),false);
  assert.equal(chooseNativeRecovery({...base,
    marker:{profile:'emad-mmz',at:now-119_999}}),false);
  assert.equal(chooseNativeRecovery({...base,
    peers:[{profile:'emad-mmz',last:now-10_000},
      {profile:'saeid-mmz',last:now-10_000}]}),true);
});

test('native shared outage elects only a single recovery candidate',()=>{
  assert.equal(chooseNativeRecovery(baseline()),true);
  // Losing connectivity or a marker from a failed restart never triggers a cascade.
  assert.equal(chooseNativeRecovery({...baseline(),
    marker:{profile:'emad-mmz',at:now-180_000}}),false);
  assert.equal(chooseNativeRecovery({
    ...baseline(),startedAt:now-1_500_000,ownLast:now-1_000_000,
    peers:[{profile:'emad-mmz',last:now-1_000_000},
      {profile:'saeid-mmz',last:now-1_000_000}],
    marker:{profile:'emad-mmz',at:now-960_000}}),false);
  // A *new* later incident may be retried after a true new successful Poll.
  const later=now+1_200_000;
  assert.equal(chooseNativeRecovery({
    now:later,startedAt,ownLast:now+700_000,
    peers:[{profile:'emad-mmz',last:now+700_000},{profile:'saeid-mmz',last:now+700_000}],
    marker:{profile:'emad-mmz',at:now},previous:now-960_000}),true);
});

test('native shared recovery advances only after last selected owner Poll succeeds',()=>{
  const marker={profile:'emad-mmz',at:now-180_000};
  const stage={
    ...baseline(),marker,
    peers:[fresh('emad-mmz'),stale('saeid-mmz')]
  };
  assert.equal(chooseNativeRecovery(stage),true);
  assert.equal(chooseNativeRecovery({...stage,
    peers:[{profile:'emad-mmz',last:marker.at-10},stale('saeid-mmz')]}),false);
  assert.equal(chooseNativeRecovery({...stage,
    marker:{profile:'saeid-mmz',at:now-180_000}}),false);
  assert.equal(chooseNativeRecovery({...stage,
    marker:{profile:'emad-mmz',at:now-20_000}}),false);
});

test('native watchdog denies restarts on weak observations and cooldown',()=>{
  const original=baseline();
  for(const variant of [
    {...original,ownLast:now-100_000}, // not stale
    {...original,startedAt:now-100_000}, // startup grace
    {...original,ownLast:null},
    {...original,ownLast:now+1000},
    {...original,previous:now-30_000},
    {...original,peers:[fresh('emad-mmz'),stale('saeid-mmz')]}, // one fresh w/o marker
    {...original,peers:[stale('emad-mmz'),{profile:'saeid-mmz',last:now-150_000}]},
    {...original,peers:[stale('emad-mmz'),{profile:'saeid-mmz',last:null}]},
    {...original,peers:[stale('emad-mmz'),stale('emad-mmz')]},
    {...original,marker:{profile:'emad-mmz',at:now+10_000}}
  ])assert.equal(chooseNativeRecovery(variant),false,JSON.stringify(variant));
  assert.equal(chooseNativeRecovery({...original,
    peers:[fresh('emad-mmz'),fresh('saeid-mmz')]}),true);
  assert.equal(chooseNativeRecovery({...original,peers:[]}),true);
});

test('native package wires owner-pinned watchdog without side-channel secrets',()=>{
  const root=path.resolve(import.meta.dirname,'..');
  const builder=fs.readFileSync(path.join(root,'tools/build-native-linux-package.sh'),'utf8');
  const src=fs.readFileSync(path.join(root,'src/native-tunnel-supervisor-linux.mjs'),'utf8');
  assert.match(builder,/native-tunnel-supervisor-linux\.mjs/);
  assert.match(builder,/ExecStart=\/usr\/lib\/chatgpt-remote-commander\/tunnel\/native-tunnel-launch\.sh %i/);
  assert.match(builder,/LoadCredential=api-key:/);
  assert.match(builder,/Restart=on-failure/);
  assert.match(builder,/exec \/usr\/lib\/chatgpt-remote-commander\/runtime\/node/);
  assert.doesNotMatch(builder,/export CONTROL_PLANE_API_KEY/);
  assert.match(src,/delete env\.OPENAI_API_KEY/);
  assert.match(src,/if\(!last\)return false/);
  assert.match(src,/verifiedNetwork\(parseNativeControlPlaneOrigin\(config\)\)/);
  assert.match(src,/child\.kill\('SIGTERM'\)/);
  assert.match(src,/return stopping\?0:75/);
});


test('native recovery validates the enrolled HTTPS Control Plane origin',()=>{
  assert.equal(parseNativeControlPlaneOrigin('control_plane:\n  base_url: https://api.openai.com\n'),
    'https://api.openai.com');
  for(const input of [
    'control_plane:\n  base_url: http://api.openai.com',
    'control_plane:\n  base_url: https://localhost',
    'control_plane:\n  base_url: https://127.0.0.1',
    'control_plane:\n  base_url: https://user:pass@api.openai.com',
    'control_plane:\n  base_url: https://api.openai.com/?token=secret',
    'control_plane:\n  base_url: javascript:alert(1)',
    'bad'
  ])assert.equal(parseNativeControlPlaneOrigin(input),null,input);
});
