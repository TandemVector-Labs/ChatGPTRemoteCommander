import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {verifyLinuxPrivateProfileBackup} from '../packaging/unified/migration-preflight.mjs';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const script=path.join(root,'packaging/unified/owner-systemd-creds-profile-recovery.sh');
const names=Object.freeze(['ca.crt','client.crt','client.key','server.crt','server.key']);
function run(args,env={}){
  return spawnSync('bash',[script,...args],{
    encoding:'utf8',windowsHide:true,timeout:12000,maxBuffer:8000,
    env:{...process.env,...env}
  });
}
function makeFixture(){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'rc012-linux-creds-'));
  const config=path.join(home,'.config');
  const profileDir=path.join(config,'tunnel-client');
  const certDir=path.join(config,'chatgpt-remote-commander','private-pair','default');
  for(const dir of [profileDir,certDir,path.join(home,'.local','state','chatgpt-remote-commander')]){
    fs.mkdirSync(dir,{recursive:true,mode:0o700});
  }
  for(const dir of [
    config,profileDir,path.join(config,'chatgpt-remote-commander'),
    path.join(config,'chatgpt-remote-commander','private-pair'),certDir,
    path.join(home,'.local'),path.join(home,'.local','state'),
    path.join(home,'.local','state','chatgpt-remote-commander')
  ])fs.chmodSync(dir,0o700);
  const yaml=path.join(profileDir,'Emad.yaml');
  const marker='NONPRODUCTION_FIXTURE_REDACTED_VALUE_ONLY';
  const source='config_version: 1\ncontrol_plane:\n  api_key: '+marker+'\n';
  fs.writeFileSync(yaml,source,{mode:0o600});
  for(const name of names)
    fs.writeFileSync(path.join(certDir,name),'NONPRODUCTION_TEST_CERT_'+name+'\n',{mode:0o600});
  return {home,yaml,source,marker,recovery:path.join(home,
    '.local/state/chatgpt-remote-commander/owner-recovery/rc012-native-pair-systemd-creds')};
}

test('Linux native owner credential recovery stages idempotently, verifies isolated restore and rejects tampering',{
 skip:process.platform!=='linux',timeout:50000
},t=>{
  const syntax=spawnSync('bash',['-n',script],{encoding:'utf8'});
  assert.equal(syntax.status,0,syntax.stderr);
  const available=spawnSync('systemd-creds',['--version'],{encoding:'utf8',timeout:3000});
  if(available.status!==0)return t.skip('systemd-creds binary unavailable');
  const f=makeFixture();
  try{
    const input={HOME:f.home};
    const stage=run(['Stage'],input);
    if(stage.status!==0&&/RC012_USER_CREDS/.test(stage.stderr||'')
       &&!/SIZE_LIMIT|FILE_UNSAFE|OWNER_FILE_UNSAFE|OWNER_DIRECTORY_UNSAFE/.test(stage.stderr||'')) {
      return t.skip('user/host systemd credential key unavailable on this runner');
    }
    assert.equal(stage.status,0,(stage.stderr||'').slice(-500));
    assert.match(stage.stdout,/RC012_LINUX_OWNER_CREDS_STAGE_PASS_files_6/);
    assert.ok(!stage.stdout.includes(f.marker));
    const ciphertext=fs.readFileSync(path.join(f.recovery,'owner-pair.cred'));
    assert.ok(!ciphertext.includes(Buffer.from(f.marker)));
    assert.ok(!fs.readFileSync(path.join(f.recovery,'receipt'),'utf8').includes(f.marker));
    const verify=run(['Verify'],input);
    assert.equal(verify.status,0,verify.stderr);
    const restoration=run(['TestRestore'],input);
    assert.equal(restoration.status,0,restoration.stderr);
    assert.match(restoration.stdout,/RC012_LINUX_OWNER_CREDS_DRY_RESTORE_PASS_files_6/);
    assert.equal(verifyLinuxPrivateProfileBackup({home:f.home,
      ownerUid:process.getuid(),profileName:'Emad'}),true,
      'canonical preflight must consume the actual same-owner six-file capsule');
    assert.equal(fs.readdirSync(path.dirname(f.recovery)).filter(x=>x.startsWith('.dry-restore-')).length,0);
    const repeat=run(['Stage'],input);
    assert.equal(repeat.status,0,repeat.stderr);
    assert.match(repeat.stdout,/RC012_LINUX_OWNER_CREDS_REUSED_files_6/);
    assert.equal(fs.readFileSync(f.yaml,'utf8'),f.source);
    fs.appendFileSync(f.yaml,'# source changed\n');
    assert.equal(verifyLinuxPrivateProfileBackup({home:f.home,
      ownerUid:process.getuid(),profileName:'Emad'}),false,
      'a current profile changed after sealing must not inherit restore acceptance');
    const stale=run(['Stage'],input);
    assert.notEqual(stale.status,0);
    assert.match(stale.stderr,/RC012_USER_CREDS_EXISTING_BASELINE_CHANGED/);
    fs.writeFileSync(f.yaml,f.source);
    ciphertext[0]^=0x02;
    fs.writeFileSync(path.join(f.recovery,'owner-pair.cred'),ciphertext);
    assert.equal(verifyLinuxPrivateProfileBackup({home:f.home,
      ownerUid:process.getuid(),profileName:'Emad'}),false,
      'ciphertext tamper must fail canonical preflight as well as native restore');
    const tampered=run(['Verify'],input);
    assert.notEqual(tampered.status,0);
    assert.match(tampered.stderr,/RC012_USER_CREDS_CIPHERTEXT_TAMPERED/);
  }finally{
    fs.rmSync(f.home,{force:true,recursive:true});
  }
});


test('profile-specific owner recovery capsules never share a Tunnel or private TLS pair',{
 skip:process.platform!=='linux',timeout:60000
},t=>{
  const available=spawnSync('systemd-creds',['--version'],{encoding:'utf8',timeout:3000});
  if(available.status!==0)return t.skip('systemd-creds binary unavailable');
  const f=makeFixture();
  const profileA='chatgpt-remote-commander';
  const profileB='mmz-emad-laptop';
  const cfg=path.join(f.home,'.config');
  const fileA=path.join(cfg,'tunnel-client',profileA+'.yaml');
  const fileB=path.join(cfg,'tunnel-client',profileB+'.yaml');
  const pairB=path.join(cfg,'chatgpt-remote-commander','private-pair',profileB);
  const capBase=path.dirname(f.recovery);
  const capsule=profile=>path.join(capBase,'rc012-native-pair-systemd-creds-'+profile);
  const input={HOME:f.home};
  try{
    fs.writeFileSync(fileA,'config_version: 1\\ncontrol_plane: owner-a-nonsecret-fixture\\n',{mode:0o600});
    fs.writeFileSync(fileB,'config_version: 1\\ncontrol_plane: owner-b-nonsecret-fixture\\n',{mode:0o600});
    fs.mkdirSync(pairB,{mode:0o700});
    for(const name of names)
      fs.writeFileSync(path.join(pairB,name),'NONPRODUCTION_ACCOUNT_B_'+name+'\\n',{mode:0o600});
    for(const name of ['--profile-name=../../outside','--profile-name=..','--profile-name=bad/name']){
      const denied=run(['Stage',name],input);
      assert.notEqual(denied.status,0);
      assert.match(denied.stderr,/RC012_OWNER_PROFILE_ARGUMENT_INVALID/);
    }
    const a=run(['Stage','--profile-name='+profileA],input);
    if(a.status!==0 && /RC012_USER_CREDS/.test(a.stderr||''))
      return t.skip('user/host systemd credential key unavailable on this runner');
    assert.equal(a.status,0,a.stderr);
    assert.ok(fs.existsSync(path.join(capsule(profileA),'owner-pair.cred')));
    const foreignMissing=run(['Verify','--profile-name='+profileB],input);
    assert.notEqual(foreignMissing.status,0);
    const b=run(['Stage','--profile-name='+profileB],input);
    assert.equal(b.status,0,b.stderr);
    assert.notEqual(capsule(profileA),capsule(profileB));
    const wrongCredentialName=spawnSync('systemd-creds',[
      'decrypt','--user','--refuse-null','--name=rc012-native-pair-'+profileB,
      path.join(capsule(profileA),'owner-pair.cred'),'-'
    ],{stdio:['ignore','ignore','pipe'],timeout:6000});
    assert.notEqual(wrongCredentialName.status,0,
      'a profile-B credential name must never decrypt the profile-A capsule');
    for(const profile of [profileA,profileB]){
      assert.equal(run(['Verify','--profile-name='+profile],input).status,0);
      const restore=run(['TestRestore','--profile-name='+profile],input);
      assert.equal(restore.status,0,restore.stderr);
      assert.match(restore.stdout,/RC012_LINUX_OWNER_CREDS_DRY_RESTORE_PASS_files_6/);
      assert.match(run(['Stage','--profile-name='+profile],input).stdout,
        /RC012_LINUX_OWNER_CREDS_REUSED_files_6/);
    }
    const aReceipt=fs.readFileSync(path.join(capsule(profileA),'receipt'));
    const aCipher=fs.readFileSync(path.join(capsule(profileA),'owner-pair.cred'));
    try{
      fs.copyFileSync(path.join(capsule(profileB),'receipt'),path.join(capsule(profileA),'receipt'));
      fs.copyFileSync(path.join(capsule(profileB),'owner-pair.cred'),path.join(capsule(profileA),'owner-pair.cred'));
      const mismatched=run(['Verify','--profile-name='+profileA],input);
      assert.notEqual(mismatched.status,0,'cross-account backup must never verify');
    }finally{
      fs.writeFileSync(path.join(capsule(profileA),'receipt'),aReceipt,{mode:0o600});
      fs.writeFileSync(path.join(capsule(profileA),'owner-pair.cred'),aCipher,{mode:0o600});
    }
    assert.equal(run(['Verify','--profile-name='+profileA],input).status,0);
    assert.equal(fs.readFileSync(fileA,'utf8').includes('owner-a-nonsecret-fixture'),true);
    assert.equal(fs.readFileSync(fileB,'utf8').includes('owner-b-nonsecret-fixture'),true);
  }finally{fs.rmSync(f.home,{recursive:true,force:true});}
});
