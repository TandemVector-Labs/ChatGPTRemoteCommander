import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {selectSystemGeckoDriver,SYSTEM_GECKODRIVERS,WINDOWS_SYSTEM_GECKODRIVERS} from '../tools/browser-geckodriver-policy.mjs';

const mockStat=(type,uid=0,mode=0o755)=>({
  uid,mode,isFile:()=>type==='file',isDirectory:()=>type==='dir'
});
function fake({driver='/usr/bin/geckodriver',target='/usr/bin/geckodriver',file=mockStat('file'),dir=mockStat('dir')}={}){
  return selectSystemGeckoDriver({
    candidates:[driver],
    platform:'linux',
    lstat:()=>file,
    realpath:()=>target,
    stat:p=>p===target?file:dir
  });
}
test('only known absolute system launcher paths are candidates; PATH is irrelevant',()=>{
  assert.equal(fake(),'/usr/bin/geckodriver');
  assert.equal(fake({driver:'/tmp/geckodriver'}),null);
  assert.equal(fake({driver:'geckodriver'}),null);
  assert.equal(fake({driver:'/home/user/bin/geckodriver'}),null);
  assert.equal(fake({driver:'/snap/bin/geckodriver',target:'/usr/bin/snap'}),'/snap/bin/geckodriver');
  assert.equal(SYSTEM_GECKODRIVERS.includes('/usr/local/bin/geckodriver'),true);
});
test('reject untrusted or writable driver binaries and parents',()=>{
  assert.equal(fake({file:mockStat('file',1000)}),null);
  assert.equal(fake({file:mockStat('file',0,0o777)}),null);
  assert.equal(fake({file:mockStat('file',0,0o644)}),null);
  assert.equal(fake({file:mockStat('dir')}),null);
  assert.equal(fake({dir:mockStat('dir',1000)}),null);
  assert.equal(fake({dir:mockStat('dir',0,0o777)}),null);
  assert.equal(fake({dir:mockStat('file')}),null);
});
test('real temporary attacker-provided PATH driver is never selected',t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'rc-gecko-path-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const driver=path.join(folder,'geckodriver');
  fs.writeFileSync(driver,'#!/bin/sh\nexit 0\n',{mode:0o755});
  const prev=process.env.PATH;
  try{
    process.env.PATH=folder+path.delimiter+String(prev??'');
    assert.equal(selectSystemGeckoDriver({platform:'linux',candidates:[driver]}),null);
    assert.equal(selectSystemGeckoDriver({platform:'linux',candidates:[driver],realpath:()=>'/usr/bin/geckodriver'}),null);
  }finally{if(prev===undefined)delete process.env.PATH;else process.env.PATH=prev;}
});

test('Windows only accepts fixed Program Files binaries without symlink redirects',()=>{
  const trusted=WINDOWS_SYSTEM_GECKODRIVERS[0];
  const st={isFile:()=>true,isSymbolicLink:()=>false};
  const make=(candidate,real=trusted,symlink=false)=>selectSystemGeckoDriver({
    platform:'win32',candidates:[candidate],realpath:()=>real,
    stat:()=>st,lstat:()=>({...st,isSymbolicLink:()=>symlink})
  });
  assert.equal(make(trusted),trusted);
  assert.equal(make(trusted,'C:\\Users\\Public\\geckodriver.exe'),null);
  assert.equal(make(trusted,trusted,true),null);
  assert.equal(make('C:\\Users\\Alice\\geckodriver.exe'),null);
});
