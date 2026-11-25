import test from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyLinuxTunnelHealthPayload,parseBoundedLinuxTunnelHealthJson,
  createLinuxTunnelClientObserver
} from '../src/native-tunnel-client-observer-linux.mjs';

const startedAtMs=1_800_000_000_000;
const nowMs=startedAtMs+40_000;
const sample=()=>({
  startedAtMs,nowMs,
  runtimeHealth:{
    ready:true,live:true,runtime:{
      instance_id:'owner-tunnel-instance-0123456789',
      started_at:new Date(startedAtMs+150).toISOString()
    }
  },
  controlHealth:{
    component:'control-plane',status:'ok',state:'polling',limited:false,
    details:{consecutive_failures:0,
      last_success:new Date(nowMs-1_000).toISOString()}
  }
});
test('Linux native owner tunnel health requires current process start and fresh authenticated poll',()=>{
  const v=verifyLinuxTunnelHealthPayload(sample());
  assert.deepEqual(v,{clientInstanceId:'owner-tunnel-instance-0123456789',
    lastPollAtMs:nowMs-1_000});
  assert.ok(Object.isFrozen(v));
});

test('Linux native owner tunnel health rejects stale, wrong-owner-process and degraded polling',()=>{
  const mutations=[
    x=>{x.runtimeHealth.ready=false;},
    x=>{x.runtimeHealth.live=false;},
    x=>{x.runtimeHealth.runtime.started_at=new Date(startedAtMs+5_000).toISOString();},
    x=>{x.runtimeHealth.runtime.instance_id='short';},
    x=>{x.controlHealth.component='other-component';},
    x=>{x.controlHealth.status='degraded';},
    x=>{x.controlHealth.state='idle';},
    x=>{x.controlHealth.limited=true;},
    x=>{x.controlHealth.details.consecutive_failures=1;},
    x=>{x.controlHealth.details.last_success=new Date(nowMs-120_001).toISOString();},
    x=>{x.controlHealth.details.last_success=new Date(nowMs+1).toISOString();},
    x=>{x.controlHealth.details.last_success='invalid';}
  ];
  for(const corrupt of mutations){
    const x=sample();corrupt(x);
    assert.throws(()=>verifyLinuxTunnelHealthPayload(x),
      {code:'NATIVE_TUNNEL_HEALTH_UNVERIFIED'});
  }
});


test('Linux owner tunnel health JSON limits both announced and streamed body sizes',async()=>{
  assert.deepEqual(
    await parseBoundedLinuxTunnelHealthJson(new Response('{"ok":true}')),
    {ok:true}
  );
  const invalid=[
    new Response('{"ok":true}',{status:503}),
    new Response('{"ok":true}',{headers:{'content-length':'65537'}}),
    new Response('{"ok":true}',{headers:{'content-length':'-1'}}),
    new Response('{"ok":true}',{headers:{'content-length':'0.0'}}),
    new Response('x'.repeat(65537)),
    new Response('not-json')
  ];
  for(const [i,response] of invalid.entries()){
    await assert.rejects(parseBoundedLinuxTunnelHealthJson(response),
      {code:i===0?'NATIVE_TUNNEL_OBSERVER_HEALTH_DENIED'
        :i===5?'NATIVE_TUNNEL_OBSERVER_HEALTH_JSON_INVALID'
        :'NATIVE_TUNNEL_OBSERVER_HEALTH_BOUNDS'});
  }
  const data='{"filler":"'+ 'x'.repeat(65536) +'"}';
  const streams=new ReadableStream({start(c){
    for(let i=0;i<data.length;i+=1024)c.enqueue(new TextEncoder()
      .encode(data.slice(i,i+1024)));
    c.close();
  }});
  await assert.rejects(
    parseBoundedLinuxTunnelHealthJson(new Response(streams)),
    {code:'NATIVE_TUNNEL_OBSERVER_HEALTH_BOUNDS'}
  );
});

test('Linux native Tunnel observer rejects non-owner-provisioned startup without side effects',()=>{
  const root={profileId:'Emad',expectedExecutablePath:'/usr/bin/false',
    expectedExecutableSha256:'a'.repeat(64),healthPort:47832,
    resolveOwnerSidHash:async()=>('b'.repeat(64))};
  for(const bad of [
    {profileId:'../Emad'}, {expectedExecutableSha256:'unknown'},
    {healthPort:0},{healthPort:65536},{expectedExecutablePath:'./tunnel-client'},
    {resolveOwnerSidHash:null}
  ]){
    assert.throws(()=>createLinuxTunnelClientObserver({...root,...bad}),
      {code:'NATIVE_TUNNEL_OBSERVER_CONFIG_INVALID'});
  }
  if(process.platform!=='linux')
    assert.throws(()=>createLinuxTunnelClientObserver(root),
      {code:'NATIVE_TUNNEL_OBSERVER_CONFIG_INVALID'});
  // A syntactically valid but untrusted binary must not be accepted.
  else assert.throws(()=>createLinuxTunnelClientObserver(root),
    {code:'NATIVE_TUNNEL_OBSERVER_BINARY_UNTRUSTED'});
});
