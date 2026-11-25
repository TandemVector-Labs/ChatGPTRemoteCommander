import test from 'node:test';
import assert from 'node:assert/strict';
import {legacyPrivilegedMcpQuarantine, rejectLegacyPrivilegedMcp} from '../src/full-access-http-quarantine.mjs';

const filtered={ok:true,isAdmin:false,isSystem:false,elevation:'standard',source:'local-process-token'};
const cases=[undefined,null,'','ADMIN','FULL_ACCESS ','full_power',{},['FULL_POWER'],99];
test('invalid or missing profile tiers cannot reopen anonymous legacy MCP on Windows or Linux',()=>{
  for(const configuredTier of cases){
    for(const options of [
      {platform:'win32',windowsAdminToken:filtered},
      {platform:'linux',effectiveUid:1000}
    ]){
      const decision=legacyPrivilegedMcpQuarantine({...options,configuredTier,requireTrustedIngress:false});
      assert.equal(decision.quarantine,true,JSON.stringify({configuredTier,platform:options.platform}));
      let status=0,body='';
      assert.equal(rejectLegacyPrivilegedMcp({},{
        writeHead(code){status=code;},
        end(bytes){body=bytes.toString('utf8');}
      },decision),true);
      assert.equal(status,403);
      assert.deepEqual(JSON.parse(body),{error:'trusted_transport_required'});
    }
  }
});
test('only exact STANDARD with a verified non-elevated owner token retains legacy availability',()=>{
  const standardWindows=legacyPrivilegedMcpQuarantine({
    platform:'win32',configuredTier:'STANDARD',windowsAdminToken:filtered,requireTrustedIngress:false
  });
  assert.equal(standardWindows.quarantine,false);
  assert.equal(standardWindows.code,'LEGACY_OWNER_TOKEN_ONLY');
  const standardLinux=legacyPrivilegedMcpQuarantine({
    platform:'linux',configuredTier:'STANDARD',effectiveUid:1000,requireTrustedIngress:false
  });
  assert.equal(standardLinux.quarantine,false);
  assert.equal(standardLinux.code,'LEGACY_OWNER_TOKEN_ONLY');
  for(const [platform,proof] of [
    ['win32',{windowsAdminToken:filtered}],
    ['linux',{effectiveUid:1000}]
  ]){
    for(const tier of ['FULL_POWER','FULL_ACCESS']){
      const denied=legacyPrivilegedMcpQuarantine({
        platform,configuredTier:tier,...proof,requireTrustedIngress:false
      });
      assert.equal(denied.quarantine,true,platform+' '+tier);
      assert.equal(denied.code,'TRUSTED_V2_INGRESS_REQUIRED');
    }
  }
});
test('Full Access still cannot use anonymous legacy MCP even if filtered',()=>{
  assert.equal(legacyPrivilegedMcpQuarantine({
    platform:'win32',configuredTier:'FULL_ACCESS',windowsAdminToken:filtered,requireTrustedIngress:false
  }).quarantine,true);
});
