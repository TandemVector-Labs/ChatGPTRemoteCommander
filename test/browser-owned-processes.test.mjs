import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
 browserProfileArgument,
 argvHasExactArgument,
 commandLineHasExactArgument,
 terminateProcessesUsingBrowserProfile,
 waitForBrowserDevToolsPort
} from '../src/browser-owned-processes.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
async function waitForAlive(pid,timeoutMs=3000){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){if(alive(pid))return true;await sleep(25);}return alive(pid);}

test('profile process matching requires the complete user-data-dir argument',()=>{
 const a=browserProfileArgument('/owned/default');
 assert.equal(argvHasExactArgument(['chrome',a],a),true);
 assert.equal(argvHasExactArgument(['chrome',a+'-other'],a),false);
 assert.equal(commandLineHasExactArgument('chrome '+a+' --flag',a),true);
 assert.equal(commandLineHasExactArgument('chrome '+a+'-other --flag',a),false);
 const win='--user-data-dir=C:\\Owned Profiles\\default';
 assert.equal(commandLineHasExactArgument('chrome.exe "'+win+'" --flag',win),true);
 assert.equal(commandLineHasExactArgument('chrome.exe "'+win+'-other" --flag',win),false);
});

test('terminating one owned profile never terminates a prefix-sibling process',async()=>{
 const root=path.join(os.tmpdir(),'rc-owned-profile-'+process.pid+'-'+Date.now().toString(36));
 const exact=path.join(root,'work'),sibling=path.join(root,'work-other');
 const spawnOwned=profile=>spawn(process.execPath,['-e','setInterval(()=>{},1000)','--',browserProfileArgument(profile)],{stdio:'ignore',windowsHide:true,shell:false});
 const a=spawnOwned(exact),b=spawnOwned(sibling);
 try{
  assert.equal(await waitForAlive(a.pid),true);assert.equal(await waitForAlive(b.pid),true);
  const killed=terminateProcessesUsingBrowserProfile(exact);
  assert.ok(killed.includes(a.pid));
  assert.equal(killed.includes(b.pid),false);
  for(let i=0;i<60&&alive(a.pid);i++)await sleep(25);
  assert.equal(alive(a.pid),false);
  assert.equal(alive(b.pid),true);
 }finally{
  for(const child of [a,b])if(alive(child.pid)){
   try{if(process.platform==='win32')child.kill();else child.kill('SIGKILL');}catch{}
   await Promise.race([once(child,'close'),sleep(500)]).catch(()=>{});
  }
 }
});

test('DevTools handoff tolerates early parent exit only if the owned port file becomes ready',async()=>{
 const { mkdtemp, writeFile, rm }=await import('node:fs/promises');
 const root=await mkdtemp(path.join(os.tmpdir(),'rc-browser-handoff-'));
 const file=path.join(root,'DevToolsActivePort');
 try{
  const parent={exitCode:0};
  const pending=waitForBrowserDevToolsPort(file,parent,{waitMs:1400,exitGraceMs:900,pollMs:10});
  await sleep(90);
  await writeFile(file,'2439\n/devtools/browser/test-owned\n','utf8');
  assert.equal(await pending,2439);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('DevTools handoff never accepts malformed port, and dead launcher fails within grace',async()=>{
 const { mkdtemp, writeFile, rm }=await import('node:fs/promises');
 const root=await mkdtemp(path.join(os.tmpdir(),'rc-browser-no-port-'));
 const file=path.join(root,'DevToolsActivePort');
 try{
  await writeFile(file,'bad-port\n','utf8');
  await assert.rejects(
   waitForBrowserDevToolsPort(file,{exitCode:0},{waitMs:300,exitGraceMs:70,pollMs:10}),
   /BROWSER_LAUNCH_FAILED/
  );
  await assert.rejects(
   waitForBrowserDevToolsPort(file,{exitCode:null},{waitMs:65,exitGraceMs:30,pollMs:10}),
   /BROWSER_DEVTOOLS_TIMEOUT/
  );
 }finally{await rm(root,{recursive:true,force:true});}
});
