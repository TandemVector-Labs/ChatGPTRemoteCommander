import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const file=resolve('auto-update-linux.sh');
const src=readFileSync(file,'utf8');
assert.ok(src.indexOf('AUTO_UPDATE_NEWER_PERSISTED_ROUTE_PRESTAGE')>src.indexOf('REF="$(latest_ref)"'));
assert.ok(src.indexOf('AUTO_UPDATE_NEWER_PERSISTED_ROUTE_PRESTAGE')<src.indexOf('stage_release "$REF"'));
test('native Linux newer Preview prevents old Stable checkout before Git fetch',{skip:process.platform!=='linux'},()=>{
 const tmp=mkdtempSync(join(tmpdir(),'rc-linux-prestage-'));
 try{
  const state=join(tmp,'xdg','chatgpt-remote-commander');
  const routeDir=join(state,'routing');
  const install=join(tmp,'installed');
  mkdirSync(routeDir,{recursive:true});mkdirSync(install,{recursive:true});
  writeFileSync(join(routeDir,'default.json'),JSON.stringify({schema:1,profile:'default',generation:1,active:{version:'0.10.26',commit:'a9ff80f65a7fdd09fb4bcbb4a24893bb81674ba2',port:48832},previous:null}));
  const run=spawnSync('bash',[file,'--install-dir',install,'--source-ref','v0.10.20'],{
   encoding:'utf8',timeout:10000,env:{...process.env,XDG_STATE_HOME:join(tmp,'xdg'),REMOTE_COMMANDER_AUTO_UPDATE_DETACHED:'1'}
  });
  assert.equal(run.error,undefined,String(run.error));
  assert.equal(run.status,0,run.stderr);
  assert.match(run.stdout,/AUTO_UPDATE_NEWER_PERSISTED_ROUTE_PRESTAGE current=0\.10\.26 target=0\.10\.20/);
  assert.equal(readdirSync(join(state,'releases')).length,0,'obsolete source checkout must not be created');
 }finally{rmSync(tmp,{recursive:true,force:true});}
});
test('invalid persisted route fails closed without cloning old checkout',{skip:process.platform!=='linux'},()=>{
 const tmp=mkdtempSync(join(tmpdir(),'rc-linux-prestage-'));
 try{
  const state=join(tmp,'xdg','chatgpt-remote-commander');
  mkdirSync(join(state,'routing'),{recursive:true});
  mkdirSync(join(tmp,'installed'),{recursive:true});
  writeFileSync(join(state,'routing','default.json'),JSON.stringify({schema:1,profile:'default',active:{version:'0.10.26',commit:'invalid'}}));
  const run=spawnSync('bash',[file,'--install-dir',join(tmp,'installed'),'--source-ref','v0.10.20'],{
   encoding:'utf8',timeout:10000,env:{...process.env,XDG_STATE_HOME:join(tmp,'xdg'),REMOTE_COMMANDER_AUTO_UPDATE_DETACHED:'1'}
  });
  assert.notEqual(run.status,0,'malformed route must not authorize any stage');
  assert.equal(readdirSync(join(state,'releases')).length,0);
 }finally{rmSync(tmp,{recursive:true,force:true});}
});