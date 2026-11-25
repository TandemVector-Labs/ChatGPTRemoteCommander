import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readLinuxOwnerTunnelBinding,isLinuxMigrationUnit} from '../packaging/unified/migration-preflight.mjs';

test('exact Linux profile selected within multiple owner-private tunnels',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'rc012-selected-tunnel-'));
 try{
  const d=path.join(home,'.config','tunnel-client');fs.mkdirSync(d,{recursive:true,mode:0o700});
  const make=(name,port)=>{
   const yaml=['config_version: 1','control_plane:','  tunnel_id: fixture-only',
   '  api_key: env:TEST_ONLY','mcp:','  server_urls:',
   '    - channel: main','      url: http://127.0.0.1:'+port+'/mcp',''].join('\n');
   fs.writeFileSync(path.join(d,name+'.yaml'),yaml,{mode:0o600});
  };
  make('mmz-linux',47831);make('emad-mmz',47921);
  const facts=(profileName)=>readLinuxOwnerTunnelBinding({home,ownerUid:process.getuid(),profileName});
  assert.equal(facts('mmz-linux').valid,true);
  assert.equal(facts('mmz-linux').port,47831);
  assert.equal(facts('emad-mmz').port,47921);
  assert.equal(readLinuxOwnerTunnelBinding({home,ownerUid:process.getuid()}).valid,false);
  for(const invalid of ['../escape','','.','..'])assert.equal(facts(invalid).valid,false);
  assert.equal(isLinuxMigrationUnit('mmz-linux-tunnel.service','mmz-linux'),true);
  assert.equal(isLinuxMigrationUnit('emad-mmz-tunnel.service','mmz-linux'),false);
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});
