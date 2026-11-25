import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolveNativePackageOutput, verifyNativePackageOutput } from '../tools/native-package-output-guard.mjs';

const root=path.resolve(import.meta.dirname,'..');
const builderPath=path.join(root,'tools/build-native-linux-package.sh');
const source=fs.readFileSync(builderPath,'utf8');
const match=source.match(/cat > "\$DEB\$PACKAGE_DIR\/native-config-preflight\.mjs" <<'PREFLIGHT'\n([\s\S]*?)\nPREFLIGHT/);

function runPreflight(config,{trusted='1',mode=0o600,profile='default',pathOverride=null}={}) {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rc-native-installer-fixture-'));
  try {
    const dir=path.join(tmp,'.local','state','chatgpt-remote-commander','profiles',profile);
    fs.mkdirSync(dir,{recursive:true,mode:0o700});
    fs.chmodSync(dir,0o700);
    const file=pathOverride??path.join(dir,'config.json');
    fs.writeFileSync(file,JSON.stringify(config),{mode});
    fs.chmodSync(file,mode);
    return spawnSync(process.execPath,['--input-type=module','-'],{
      input:match[1]+'\n',encoding:'utf8',timeout:3000,
      env:{...process.env,HOME:tmp,REMOTE_COMMANDER_CONFIG:file,
        COMMANDER_ONE_REQUIRE_TRUSTED_INGRESS:trusted},cwd:tmp
    });
  } finally {
    fs.rmSync(tmp,{recursive:true,force:true});
  }
}

const valid=(profile='default')=>({
  host:'127.0.0.1',port:47831,instance:{profile},
  runtimeState:'/home/test/.local/state/chatgpt-remote-commander/profiles/default/mcp-runtime.json',
  auditLog:'/home/test/.local/state/chatgpt-remote-commander/profiles/default/audit.jsonl'
});

test('root Linux installer never runs synthetic MCP qualification with an elevated token',()=>{
  const installer=fs.readFileSync(path.join(root,'install.sh'),'utf8');
  const block=installer.slice(installer.indexOf('validate_installation() {'),installer.indexOf('start_server() {'));
  assert.ok(block.startsWith('validate_installation() {'));
  assert.match(block,/if \[\[ "\$\(id -u\)" == 0 \]\]/);
  assert.match(block,/command -v runuser/);
  assert.match(block,/id -u nobody/);
  assert.match(block,/runuser -u nobody -- env HOME=/);
  assert.match(block,/check:qualification test:qualification audit/);
  assert.ok(block.indexOf('runuser -u nobody -- env')<block.indexOf('npm run check:qualification'));
  assert.doesNotMatch(block,/COMMANDER_ONE_REQUIRE_TRUSTED_INGRESS=0/);
  if(process.platform==='linux'){
    const parse=spawnSync('bash',['-n',path.join(root,'install.sh')],{encoding:'utf8'});
    assert.equal(parse.status,0,parse.stderr);
  }
});

const linuxOnlyTest = process.platform === 'linux' ? test : test.skip;

linuxOnlyTest('one native Linux package installs one dpkg-owned code root shared by all owner profiles',()=>{
  assert.equal(spawnSync('bash',['-n',builderPath]).status,0);
  assert.match(source,/dpkg-deb --root-owner-group --build/);
  assert.match(source,/git -C "\$ROOT" archive --format=tar "\$HEAD"/);
  assert.match(source,/PACKAGE_DIR=\/usr\/lib\/chatgpt-remote-commander/);
  assert.match(source,/native-package-output-guard\.mjs" absent/);
  assert.match(source,/EXPECTED_PACKAGE_SHA256/);
  assert.match(source,/native-package-output-guard\.mjs" verify/);
  assert.match(source,/usr\/lib\/systemd\/user\/chatgpt-remote-commander@\.service/);
  assert.match(source,/%h\/\.local\/state\/chatgpt-remote-commander\/profiles\/%i\/config\.json/);
  assert.match(source,/Environment=COMMANDER_ONE_REQUIRE_TRUSTED_INGRESS=1/);
  assert.match(source,/ProtectSystem=full/);
  assert.match(source,/serviceAutoStart=false/);
  assert.doesNotMatch(source,/usr\/lib\/systemd\/system\/chatgpt-remote-commander\.service/);
  assert.doesNotMatch(source,/systemctl enable/);
  assert.doesNotMatch(source,/systemctl start/);
  assert.doesNotMatch(source,/DEBIAN\/postinst/);
  assert.ok(match,'native preflight must be installed in the package');
});

linuxOnlyTest('native package output guard rejects symlinked dist and installer parents',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rc-package-output-symlink-'));
  try{
    const outside=path.join(tmp,'outside');
    fs.mkdirSync(outside);
    const rootA=path.join(tmp,'root-a');fs.mkdirSync(rootA);
    fs.symlinkSync(outside,path.join(rootA,'dist'),'dir');
    assert.throws(()=>resolveNativePackageOutput(rootA),{code:'NATIVE_PACKAGE_OUTPUT_PARENT_UNSAFE'});
    const rootB=path.join(tmp,'root-b');fs.mkdirSync(path.join(rootB,'dist'),{recursive:true});
    fs.symlinkSync(outside,path.join(rootB,'dist','installer'),'dir');
    assert.throws(()=>resolveNativePackageOutput(rootB),{code:'NATIVE_PACKAGE_OUTPUT_PARENT_UNSAFE'});
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

linuxOnlyTest('native package output guard rejects paths outside the canonical package directory',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rc-package-output-path-'));
  try{
    assert.throws(()=>resolveNativePackageOutput(tmp,'../outside.deb'),{code:'NATIVE_PACKAGE_OUTPUT_OUTSIDE_ROOT'});
    assert.throws(()=>resolveNativePackageOutput(tmp,path.join(tmp,'other','package.deb')),{code:'NATIVE_PACKAGE_OUTPUT_OUTSIDE_ROOT'});
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

linuxOnlyTest('native package output guard enforces no-clobber and staged-to-final SHA parity',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rc-package-output-sha-'));
  try{
    const dir=path.join(tmp,'dist','installer');fs.mkdirSync(dir,{recursive:true});
    const output=path.join(dir,'Remote-Commander-Linux-amd64.deb');
    const bytes=Buffer.from('native-package-fixture');
    const sha=createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(output,bytes);
    assert.throws(()=>resolveNativePackageOutput(tmp),{code:'NATIVE_PACKAGE_OUTPUT_ALREADY_EXISTS'});
    assert.equal(verifyNativePackageOutput(tmp,output,sha),sha);
    assert.throws(()=>verifyNativePackageOutput(tmp,output,'0'.repeat(64)),{code:'NATIVE_PACKAGE_OUTPUT_SHA256_MISMATCH'});
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

linuxOnlyTest('native package output guard rejects a symlink at the final artifact path',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rc-package-output-target-'));
  try{
    const dir=path.join(tmp,'dist','installer');fs.mkdirSync(dir,{recursive:true});
    const target=path.join(tmp,'outside.deb');fs.writeFileSync(target,'not the package');
    const output=path.join(dir,'Remote-Commander-Linux-amd64.deb');fs.symlinkSync(target,output);
    assert.throws(()=>verifyNativePackageOutput(tmp,output,createHash('sha256').update('not the package').digest('hex')),
      {code:'NATIVE_PACKAGE_OUTPUT_TARGET_UNSAFE'});
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

linuxOnlyTest('native instance preflight accepts a private config bound to its owner profile',()=>{
  const result=runPreflight(valid());
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/NATIVE_PROFILE_CONFIG_PREFLIGHT_PASS/);
});

linuxOnlyTest('native instance preflight rejects missing trusted ingress and non-loopback endpoints',()=>{
  for(const patch of [
    {host:'0.0.0.0'},
    {port:80},
    {port:65536},
    {instance:{profile:'other'}}
  ]){
    const result=runPreflight({...valid(),...patch});
    assert.notEqual(result.status,0,JSON.stringify(patch));
  }
  assert.notEqual(runPreflight(valid(),{trusted:'0'}).status,0);
});

linuxOnlyTest('native instance preflight refuses unprivate config and mutable state in managed code',()=>{
  assert.notEqual(runPreflight(valid(),{mode:0o644}).status,0);
  const inCode='/usr/lib/chatgpt-remote-commander/var/audit.jsonl';
  assert.notEqual(runPreflight({...valid(),auditLog:inCode}).status,0);
  assert.notEqual(runPreflight({...valid(),runtimeState:'var/runtime.json'}).status,0);
});

test('native Linux package embeds the previously pinned tunnel client with license and provenance',()=>{
  assert.match(source,/install-tunnel-client-linux\.sh" --install-dir "\$STAGE\/tunnel-download"/);
  assert.match(source,/tunnel-client-pin\.json/);
  assert.match(source,/NATIVE_TUNNEL_UNAPPROVED_PIN/);
  assert.match(source,/NATIVE_TUNNEL_BINARY_PROVENANCE_MISMATCH/);
  assert.match(source,/tunnel-client-provenance\.json/);
  assert.match(source,/for name in tunnel-client cloudflared LICENSE NOTICE/);
  assert.match(source,/cp -a -- "\$TUNNEL_SRC\/\." "\$TUNNEL\/"/);
  assert.match(source,/tunnelAutoStart=false/);
  assert.doesNotMatch(source,/systemctl\s+--user\s+(start|enable|restart)\s+chatgpt-remote-commander-tunnel@/);
});

test('native per-owner tunnel unit loads existing credentials and never autostarts',()=>{
  const unit=source.match(/cat > "\$DEB\/usr\/lib\/systemd\/user\/chatgpt-remote-commander-tunnel@\.service" <<'TUNNELUNIT'\n([\s\S]*?)\nTUNNELUNIT/)?.[1];
  assert.ok(unit,'tunnel unit must be included in the package');
  assert.match(unit,/LoadCredential=api-key:%h\/\.config\/chatgpt-remote-commander\/credentials\/%i\.key/);
  assert.match(unit,/ConditionPathExists=%h\/\.config\/tunnel-client\/%i\.yaml/);
  assert.match(unit,/NoNewPrivileges=yes/);
  assert.match(unit,/ProtectSystem=full/);
  assert.doesNotMatch(unit,/ExecStart=.*(curl|install|enroll|sudo|pkexec)/);
  const launcher=source.match(/cat > "\$DEB\$PACKAGE_DIR\/tunnel\/native-tunnel-launch\.sh" <<'TUNNELLAUNCH'\n([\s\S]*?)\nTUNNELLAUNCH/)?.[1];
  assert.ok(launcher,'standalone tunnel launcher must be packaged');
  assert.match(launcher,/CREDENTIALS_DIRECTORY/);
  assert.doesNotMatch(launcher,/export CONTROL_PLANE_API_KEY/);
  assert.match(launcher,/native-tunnel-supervisor-linux\.mjs/);
  assert.match(source,/install -m 0644 "\$APP\/src\/native-tunnel-supervisor-linux\.mjs"/);
  assert.doesNotMatch(launcher,/echo "\$CONTROL_PLANE_API_KEY"|printf.*CONTROL_PLANE_API_KEY/);
  if(process.platform==='linux'){
    for(const profile of ['../escape','', 'profile with spaces']){
      const out=spawnSync('sh',['-s','--',profile],{
        input:launcher,encoding:'utf8',timeout:3000,
        env:{...process.env,CREDENTIALS_DIRECTORY:''}
      });
      assert.notEqual(out.status,0);
      assert.doesNotMatch(out.stdout+out.stderr,/token|secret-value/i);
    }
  }
});


test('native Linux QA package pins Node 22 October 2026 security release',()=>{
  assert.match(source,/^NODE_VERSION=22\.23\.4$/m);
  assert.match(source,/^NODE_SHA256=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce$/m);
  assert.match(source,/^NODE_ASSET="node-v\$NODE_VERSION-linux-x64\.tar\.xz"$/m);
  assert.match(source,/actual_manifest_line/);
  assert.match(source,/sha256sum -c --status/);
  assert.doesNotMatch(source,/^NODE_VERSION=22\.23\.3$/m);
});
