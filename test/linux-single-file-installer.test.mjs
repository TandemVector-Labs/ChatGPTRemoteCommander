import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('single-file Linux launcher is byte-reproducible, supports offline plan and rejects corrupt payload', {skip:process.platform==='win32'},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rc-linux-single-file-'));
 const out=path.join(dir,'Remote-Commander-Linux-Setup.run');
 try{
  const callEnv=(extra,...args)=>spawnSync('bash',args,{
    encoding:'utf8',timeout:15000,
    env:{...process.env,DISPLAY:'',WAYLAND_DISPLAY:'',...extra}
  });
  const call=(...args)=>callEnv({},...args);
  let result=call(path.join(root,'tools/build-linux-single-file.sh'),out);
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.match(result.stdout,/LINUX_SINGLE_FILE_BUILD_PASS/);
  assert.ok(fs.statSync(out).size>5000);
  // Two independent staging directories across distinct wall-clock seconds must produce identical bytes.
  await new Promise(resolve=>setTimeout(resolve,1200));
  const second=path.join(dir,'Remote-Commander-Linux-Setup-second.run');
  const secondBuild=call(path.join(root,'tools/build-linux-single-file.sh'),second);
  assert.equal(secondBuild.status,0,secondBuild.stderr||secondBuild.stdout);
  assert.deepEqual(fs.readFileSync(second),fs.readFileSync(out),'Linux .run must be byte-identical across build times');
  // Inspect the exact packaged launcher, not merely the source scripts.
  // A nominal newer .run must not install a stale Core default.
  const artifact=fs.readFileSync(out);
  const marker=Buffer.from('__RC_PRODUCT_PAYLOAD_BEGIN__\n');
  const cut=artifact.indexOf(marker);
  assert.ok(cut>0,'embedded payload marker must occur once');
  assert.equal(artifact.indexOf(marker,cut+marker.length),-1);
  const tarPath=path.join(dir,'embedded.tar.gz');
  fs.writeFileSync(tarPath,artifact.subarray(cut+marker.length));
  const extracted=spawnSync('tar',['-xOzf',tarPath,'./SETUP.sh'],{encoding:'utf8'});
  assert.equal(extracted.status,0,extracted.stderr);
  const expectedVersion=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
  const source=spawnSync('git',['-c',`safe.directory=${root}`,'-C',root,'rev-parse','HEAD'],{encoding:'utf8'});
  assert.equal(source.status,0,source.stderr);
  assert.match(expectedVersion,/^[0-9]+\.[0-9]+\.[0-9]+(?:-(?:dev|rc)\.[0-9]+)?$/);
  const qaDev=/^0\.12\.0-dev\.[1-9][0-9]*$/.test(expectedVersion);
  const expectedRef=qaDev?'integration/v012-unsigned-approval-20261110':'v'+expectedVersion;
  assert.ok(extracted.stdout.includes("export REMOTE_COMMANDER_SOURCE_REF='"+expectedRef+"'"),
    'source-ref pin missing from packaged launcher');
  if(qaDev)assert.ok(extracted.stdout.includes("if [[ '1' == 1 ]]"));
  assert.ok(extracted.stdout.includes("export REMOTE_COMMANDER_EXPECTED_COMMIT='"+source.stdout.trim()+"'"));

  result=call(out,'--list-products');
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.match(result.stdout,/core\s+available/);
  assert.match(result.stdout,/browser\s+conditional/);
  result=call(out,'--plan-only','--all');
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.match(result.stdout,/selected=core,work-plugin changesApplied=false/);
  result=call(out,'--plan-only','--product','browser');
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/selected=core,browser changesApplied=false/);
  assert.match(result.stdout,/BROWSER_REQUIRES_LINUX_X86_64_X11_INTERACTIVE_SUDO_ONLINE_367MB/);
  if(qaDev){
    // Product preview may not become a live owner install when NoPromote.
    result=call(out,'--all');
    assert.equal(result.status,3,result.stderr||result.stdout);
    assert.match(result.stderr,/V012_DEV_QA_INSTALL_NOT_APPROVED/);
    const bin=path.join(dir,'fake-bin');
    fs.mkdirSync(bin);
    const git=path.join(bin,'git');
    fs.writeFileSync(git,[
      '#!/bin/sh',
      'test "$1" = ls-remote && test "$2" = --exit-code && test "$3" = --heads || exit 8',
      'printf "%s\\trefs/heads/integration/v012-unsigned-approval-20261110\\n" "$RC_QA_TEST_SHA"',
      ''
    ].join('\n'));
    fs.chmodSync(git,0o755);
    const stubEnv={PATH:bin+path.delimiter+(process.env.PATH??''),RC_QA_TEST_SHA:source.stdout.trim()};
    result=callEnv(stubEnv,out,'--verify-source');
    assert.equal(result.status,0,result.stderr||result.stdout);
    assert.match(result.stdout,/V012_QA_EXACT_SOURCE_REACHABLE.*changesApplied=false/);
    result=callEnv({...stubEnv,RC_QA_TEST_SHA:'0'.repeat(40)},out,'--verify-source');
    assert.equal(result.status,4,result.stderr||result.stdout);
    assert.match(result.stderr,/V012_QA_SOURCE_REF_MOVED_OR_MISMATCH/);
  }
  fs.appendFileSync(out,Buffer.from('tampered'));
  result=call(out,'--plan-only','--all');
  assert.equal(result.status,3);
  assert.match(result.stderr,/LINUX_PAYLOAD_SHA256_MISMATCH/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
