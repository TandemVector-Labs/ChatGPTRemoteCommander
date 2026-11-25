import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  legacyPrivilegedMcpQuarantine, rejectLegacyPrivilegedMcp
} from '../src/full-access-http-quarantine.mjs';

const high = {ok:true,isAdmin:true,elevation:'high',source:'local-process-token'};
const filtered = {ok:true,isAdmin:false,isSystem:false,elevation:'standard',source:'local-process-token'};

test('the exact non-elevated Windows probe shape is admissible only in STANDARD legacy mode',()=>{
  // Same output contract as probeWindowsAdministrator('RC_NON_ELEVATED_USER_TOKEN').
  const token={ok:true,isAdmin:false,isSystem:false,elevation:'standard',source:'local-process-token'};
  const allowed=legacyPrivilegedMcpQuarantine({
    platform:'win32',configuredTier:'STANDARD',windowsAdminToken:token,requireTrustedIngress:false
  });
  assert.equal(allowed.quarantine,false,'real non-elevated token should keep only STANDARD compatibility');
  assert.equal(allowed.tokenUncertain,false);
  for(const configuredTier of ['FULL_POWER','FULL_ACCESS']){
    assert.equal(legacyPrivilegedMcpQuarantine({
      platform:'win32',configuredTier,windowsAdminToken:token,requireTrustedIngress:false
    }).quarantine,true,configuredTier);
  }
  for(const windowsAdminToken of [
    {...token,elevation:'filtered'},
    {...token,isSystem:true},
    {...token,source:'external-claim'},
    {...token,ok:false},
    {...token,isAdmin:true}
  ]){
    assert.equal(legacyPrivilegedMcpQuarantine({
      platform:'win32',configuredTier:'STANDARD',windowsAdminToken,requireTrustedIngress:false
    }).quarantine,true,JSON.stringify(windowsAdminToken));
  }
  assert.equal(legacyPrivilegedMcpQuarantine({
    platform:'win32',configuredTier:'STANDARD',windowsAdminToken:token,requireTrustedIngress:true
  }).quarantine,true);
});

test('strict V2 ingress mode quarantines non-elevated owner tokens for every tier',()=>{
  for (const [platform,proof] of [
    ['win32',{windowsAdminToken:filtered}],
    ['linux',{effectiveUid:1000}]
  ]){
    for(const configuredTier of ['STANDARD','FULL_POWER','FULL_ACCESS']){
      const decision=legacyPrivilegedMcpQuarantine({
        platform,configuredTier,...proof,requireTrustedIngress:true
      });
      assert.equal(decision.quarantine,true);
      assert.equal(decision.code,'TRUSTED_V2_INGRESS_REQUIRED');
      assert.equal(decision.tokenUncertain,false);
      const state={status:0,body:null};
      const res={writeHead(s){state.status=s;},end(b){state.body=JSON.parse(b.toString('utf8'));}};
      assert.equal(rejectLegacyPrivilegedMcp({},res,decision),true);
      assert.equal(state.status,403);
      assert.deepEqual(state.body,{error:'trusted_transport_required'});
    }
  }
});
test('invalid strict-mode configuration must fail closed rather than silently disable it',()=>{
  for(const requireTrustedIngress of [null,0,1,'false','true',{},[]]){
    const result=legacyPrivilegedMcpQuarantine({
      platform:'win32',configuredTier:'STANDARD',
      windowsAdminToken:filtered,requireTrustedIngress
    });
    assert.equal(result.quarantine,true);
  }
});
test('full access configuration is quarantined even with a filtered Windows token',()=>{
  const r=legacyPrivilegedMcpQuarantine({
    platform:'win32',configuredTier:'FULL_ACCESS',windowsAdminToken:filtered
  });
  assert.equal(r.quarantine,true);
  assert.equal(r.privilegedProcess,false);
  assert.equal(r.code,'TRUSTED_V2_INGRESS_REQUIRED');
});
test('elevated Windows token is quarantined regardless of configured tier',()=>{
  for(const configuredTier of ['STANDARD','FULL_POWER','FULL_ACCESS']){
    const r=legacyPrivilegedMcpQuarantine({
      platform:'win32',configuredTier,windowsAdminToken:high
    });
    assert.equal(r.quarantine,true);
    assert.equal(r.privilegedProcess,true);
  }
});
test('malformed filtered Windows token claims never reopen the unauthenticated MCP path',()=>{
  const invalid = [
    {ok:true,isAdmin:false},
    {ok:true,isAdmin:false,elevation:'filtered'},
    {ok:true,isAdmin:false,elevation:'high',source:'local-process-token'},
    {ok:true,isAdmin:false,elevation:'filtered',source:'remote-claim'},
    {ok:true,isAdmin:0,elevation:'filtered',source:'local-process-token'},
    {ok:true,isAdmin:'false',elevation:'filtered',source:'local-process-token'},
    {ok:true,isAdmin:true,elevation:'filtered',source:'local-process-token'},
    {ok:true,isAdmin:true,elevation:'high',source:'external-token'}
  ];
  for (const windowsAdminToken of invalid) {
    const decision=legacyPrivilegedMcpQuarantine({
      platform:'win32',configuredTier:'FULL_POWER',windowsAdminToken
    });
    assert.equal(decision.quarantine,true,JSON.stringify(windowsAdminToken));
    assert.equal(decision.tokenUncertain,true);
  }
});
test('failed or inconsistent Windows admin token proof cannot be a bypass',()=>{
  for(const windowsAdminToken of [null,{ok:false,code:'PROBE_FAILED'},
    {ok:true,isAdmin:true,elevation:'filtered',source:'local-process-token'}]){
    assert.equal(legacyPrivilegedMcpQuarantine({
      platform:'win32',configuredTier:'FULL_POWER',windowsAdminToken
    }).quarantine,true);
  }
});
test('FULL_POWER always quarantines legacy MCP even when strict flag is absent or false',()=>{
  for(const requireTrustedIngress of [undefined,false]){
    const input={platform:'win32',configuredTier:'FULL_POWER',windowsAdminToken:filtered};
    if(requireTrustedIngress!==undefined)input.requireTrustedIngress=requireTrustedIngress;
    const r=legacyPrivilegedMcpQuarantine(input);
    assert.equal(r.quarantine,true);
    assert.equal(r.code,'TRUSTED_V2_INGRESS_REQUIRED');
  }
});
test('verified non-elevated STANDARD owner token retains legacy availability',()=>{
  const r=legacyPrivilegedMcpQuarantine({
    platform:'win32',configuredTier:'STANDARD',windowsAdminToken:filtered
  });
  assert.equal(r.quarantine,false);
  assert.equal(r.code,'LEGACY_OWNER_TOKEN_ONLY');
});
test('actual Linux root token always quarantines legacy MCP even if tier is STANDARD',()=>{
  for(const configuredTier of ['STANDARD','FULL_POWER','FULL_ACCESS']){
    assert.equal(legacyPrivilegedMcpQuarantine({
      platform:'linux',configuredTier,effectiveUid:0
    }).quarantine,true);
  }
});
test('normal Linux STANDARD owner-token remains available; FULL_POWER and unknown UID block',()=>{
  assert.equal(legacyPrivilegedMcpQuarantine({
    platform:'linux',configuredTier:'STANDARD',effectiveUid:1000
  }).quarantine,false);
  assert.equal(legacyPrivilegedMcpQuarantine({
    platform:'linux',configuredTier:'FULL_POWER',effectiveUid:1000
  }).quarantine,true);
  assert.equal(legacyPrivilegedMcpQuarantine({
    platform:'linux',configuredTier:'FULL_ACCESS',effectiveUid:1000
  }).quarantine,true);
  assert.equal(legacyPrivilegedMcpQuarantine({
    platform:'linux',configuredTier:'FULL_POWER',effectiveUid:null
  }).quarantine,true);
});
test('unknown platform is never considered a safe legacy privileged listener',()=>{
  assert.equal(legacyPrivilegedMcpQuarantine({
    platform:'freebsd',configuredTier:'FULL_POWER'
  }).quarantine,true);
});
test('anonymous, forged Bearer and session headers cannot dispatch any RPC method',async()=>{
  const guarded=legacyPrivilegedMcpQuarantine({
    platform:'win32',configuredTier:'FULL_ACCESS',windowsAdminToken:high
  });
  let dispatches=0;
  const server=http.createServer((req,res)=>{
    if(rejectLegacyPrivilegedMcp(req,res,guarded))return;
    dispatches++;res.writeHead(200);res.end('unsafe');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const port=server.address().port;
    const requests=[
      {method:'tools/list'},
      {method:'tools/call',params:{name:'system_status',arguments:{}}},
      {method:'tools/call',params:{name:'read_text',arguments:{path:'C:\\fixture.txt',maxBytes:16}}},
      {method:'tools/call',params:{name:'write_text',arguments:{path:'C:\\fixture.txt',content:'blocked'}}},
      {method:'tools/call',params:{name:'run_shell',arguments:{command:'Write-Output blocked'}}}
    ];
    const identityHeaders=[
      {},
      {authorization:'Bearer forged'},
      {'mcp-session-id':'forged'},
      {'x-chat-id':'forged'}
    ];
    let id=0;
    for(const headers of identityHeaders){
      for(const request of requests){
        const res=await fetch('http://127.0.0.1:'+port+'/mcp',{
          method:'POST',headers:{'content-type':'application/json',...headers},
          body:JSON.stringify({jsonrpc:'2.0',id:++id,...request})
        });
        assert.equal(res.status,403);
        assert.equal(res.headers.get('cache-control'),'no-store');
        assert.deepEqual(await res.json(),{error:'trusted_transport_required'});
      }
    }
    assert.equal(dispatches,0);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});
test('missing or inconsistent guard decision fails closed without dispatch',()=>{
  const bad=[null,undefined,{},
    {quarantine:false},
    {quarantine:false,code:'TRUSTED_V2_INGRESS_REQUIRED'},
    {quarantine:false,code:'LEGACY_OWNER_TOKEN_ONLY',privilegedProcess:true,tokenUncertain:false},
    {quarantine:false,code:'LEGACY_OWNER_TOKEN_ONLY',privilegedProcess:false,tokenUncertain:true}
  ];
  for(const decision of bad){
    let status=null,ended=false,body='';
    const res={writeHead(code){status=code;},end(bytes){ended=true;body=bytes.toString('utf8');}};
    assert.equal(rejectLegacyPrivilegedMcp({},res,decision),true);
    assert.equal(status,403);
    assert.equal(ended,true);
    assert.deepEqual(JSON.parse(body),{error:'trusted_transport_required'});
  }
});
test('guard does not intercept a verified filtered STANDARD owner process',()=>{
  const safe=legacyPrivilegedMcpQuarantine({
    platform:'win32',configuredTier:'STANDARD',windowsAdminToken:filtered
  });
  assert.equal(rejectLegacyPrivilegedMcp({}, {}, safe),false);
});

test('legacy powerMode enabled rejects a misdeclared STANDARD tier even for non-elevated owner token',()=>{
  for(const [platform,proof] of [['linux',{effectiveUid:1000}],['win32',{windowsAdminToken:filtered}]]){
    for(const legacyPowerModeEnabled of [true,null,'true',1]){
      const r=legacyPrivilegedMcpQuarantine({platform,configuredTier:'STANDARD',...proof,
        requireTrustedIngress:false,legacyPowerModeEnabled});
      assert.equal(r.quarantine,true);
      assert.equal(r.code,'TRUSTED_V2_INGRESS_REQUIRED');
    }
    const safe=legacyPrivilegedMcpQuarantine({platform,configuredTier:'STANDARD',...proof,
      requireTrustedIngress:false,legacyPowerModeEnabled:false});
    assert.equal(safe.quarantine,false);
  }
});
