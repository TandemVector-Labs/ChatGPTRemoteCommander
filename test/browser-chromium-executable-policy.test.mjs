import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {selectTrustedChromium,POSIX_CHROMIUM_BINARIES,WINDOWS_CHROMIUM_BINARIES} from '../tools/browser-chromium-executable-policy.mjs';

const stat=(type,uid=0,mode=0o755)=>({
  uid,mode,isFile:()=>type==='file',isDirectory:()=>type==='dir',isSymbolicLink:()=>false
});
function posix({candidate='/usr/bin/chromium',target='/usr/bin/chromium',file=stat('file'),folder=stat('dir')}={}){
  return selectTrustedChromium(candidate,{
    platform:'linux',
    realpath:()=>target,
    lstat:()=>file,
    stat:p=>p===target?file:folder
  });
}
test('POSIX browser executable must be an absolute system allowlist entry',()=>{
  assert.equal(posix(),'/usr/bin/chromium');
  assert.equal(posix({candidate:'/usr/bin/google-chrome'}),'/usr/bin/google-chrome');
  assert.equal(posix({candidate:'/home/user/chrome'}),null);
  assert.equal(posix({candidate:'chrome'}),null);
  assert.equal(posix({candidate:'/tmp/chromium'}),null);
  assert.ok(POSIX_CHROMIUM_BINARIES.includes('/opt/google/chrome/chrome'));
});
test('reject wrong owner, writable executables and unsafe parents',()=>{
  assert.equal(posix({file:stat('file',1000)}),null);
  assert.equal(posix({file:stat('file',0,0o777)}),null);
  assert.equal(posix({file:stat('file',0,0o644)}),null);
  assert.equal(posix({file:stat('dir')}),null);
  assert.equal(posix({folder:stat('dir',1000)}),null);
  assert.equal(posix({folder:stat('dir',0,0o777)}),null);
  assert.equal(posix({folder:stat('file')}),null);
});
test('Windows requires a static Program Files Chrome or Edge binary without reparse redirects',()=>{
  const allowed=WINDOWS_CHROMIUM_BINARIES[0], st=stat('file');
  const find=(requested,real=allowed,symlink=false)=>selectTrustedChromium(requested,{
    platform:'win32',realpath:()=>real,stat:()=>st,
    lstat:()=>({...st,isSymbolicLink:()=>symlink})
  });
  assert.equal(find(allowed),allowed);
  assert.equal(find(WINDOWS_CHROMIUM_BINARIES[3],WINDOWS_CHROMIUM_BINARIES[3]),WINDOWS_CHROMIUM_BINARIES[3]);
  assert.equal(find(allowed,'C:\\Users\\Public\\chrome.exe'),null);
  assert.equal(find(allowed,allowed,true),null);
  assert.equal(find('C:\\Users\\Alice\\AppData\\Local\\chrome.exe'),null);
});
test('a dummy malicious executable earlier on PATH is never accepted',t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'rc-browser-binary-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const fake=path.join(folder,'chromium');
  fs.writeFileSync(fake,'#!/bin/sh\nexit 0\n',{mode:0o755});
  const old=process.env.PATH;
  try{
    process.env.PATH=folder+path.delimiter+String(old??'');
    assert.equal(selectTrustedChromium(fake,{platform:'linux'}),null);
  }finally{if(old===undefined)delete process.env.PATH;else process.env.PATH=old;}
});
