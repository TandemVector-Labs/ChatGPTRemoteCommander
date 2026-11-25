import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {planOwnerPrivateTunnelCutover} from '../tools/plan-owner-private-tunnel-cutover.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const script=path.join(project,'tools','inspect-owner-private-tunnel-cutover.mjs');
function fixture(check){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'rc012-exact-pair-'));
 try{
  const profileDir=path.join(home,'.config','tunnel-client');
  const pairs=path.join(home,'.config','chatgpt-remote-commander','private-pair');
  for(const d of [profileDir,pairs])fs.mkdirSync(d,{recursive:true,mode:0o700});
  const make=(name,port)=>{
   const f=path.join(profileDir,name+'.yaml');
   const data=['config_version: 1','control_plane:','  tunnel_id: synthetic-fixture-id',
   '  api_key: env:SYNTHETIC_FIXTURE_KEY','mcp:','  server_urls:',
   '    - channel: main','      url: http://127.0.0.1:'+port+'/mcp',''].join('\n');
   fs.writeFileSync(f,data,{mode:0o600});return {f,data};
  };
  const pair=name=>{
   const d=path.join(pairs,name);fs.mkdirSync(d,{mode:0o700});
   for(const key of ['client.crt','client.key','ca.crt'])
    fs.writeFileSync(path.join(d,key),'fixture-only-'+name+'-'+key,{mode:0o600});
   return d;
  };
  const run=name=>spawnSync(process.execPath,[script,'--target-port=55701',
    '--profile-name='+name],{encoding:'utf8',timeout:6000,cwd:project,
    env:{...process.env,HOME:home}});
  return check({make,pair,run});
 }finally{fs.rmSync(home,{recursive:true,force:true});}
}
test('MMZ client pair is exact and never silently taken from default',()=>fixture(({make,pair,run})=>{
 const original=make('mmz-linux',47831);pair('default');const exact=pair('mmz-linux');
 const r=run('mmz-linux');assert.equal(r.status,0,r.stderr);
 const out=JSON.parse(r.stdout);
 const expected=planOwnerPrivateTunnelCutover({currentYaml:original.data,protectedPort:55701,
   clientCertPath:path.join(exact,'client.crt'),clientKeyPath:path.join(exact,'client.key'),
   clientCaPath:path.join(exact,'ca.crt')});
 assert.equal(out.candidateSha256,expected.candidateSha256);
 assert.equal(out.profileName,'mmz-linux');assert.equal(out.activeTunnelChanged,false);
 assert.equal(out.ownerCredentialsInOutput,false);
 assert.doesNotMatch(r.stdout,/SYNTHETIC_FIXTURE_KEY|synthetic-fixture-id/);
 assert.equal(fs.readFileSync(original.f,'utf8'),original.data);
}));
test('missing exact MMZ credentials fail closed despite valid default',()=>fixture(({make,pair,run})=>{
 const original=make('mmz-linux',47831);pair('default');const r=run('mmz-linux');
 assert.notEqual(r.status,0);assert.match(r.stderr,/RC012_OWNER_PAIR_PROFILE_ISOLATION_REQUIRED/);
 assert.equal(fs.readFileSync(original.f,'utf8'),original.data);
}));
test('canonical sole legacy profile resolves default namespace',()=>fixture(({make,pair,run})=>{
 make('chatgpt-remote-commander',47831);pair('default');
 const r=run('chatgpt-remote-commander');assert.equal(r.status,0,r.stderr);
 assert.equal(JSON.parse(r.stdout).profileName,'chatgpt-remote-commander');
}));
test('invalid traversal profile is rejected',()=>fixture(({run})=>{
 const r=run('../another-account');assert.notEqual(r.status,0);
 assert.match(r.stderr,/RC012_OWNER_EXACT_PROFILE_REQUIRED/);
}));
