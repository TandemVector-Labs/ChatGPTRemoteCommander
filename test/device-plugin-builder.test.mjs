import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const repo=path.resolve(import.meta.dirname,'..');
const generator=path.join(repo,'tools','generate-device-plugin.mjs');
const template=path.join(repo,'plugin-template');
const sha=(p)=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function run(name,fingerprint,appId='plugin_asdk_app_TESTDEVICE123'){
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rc-device-plugin-'));
  const out=path.join(tmp,'plugin');
  const zip=path.join(tmp,'plugin.zip');
  const r=spawnSync(process.execPath,[generator,'--template',template,'--output',out,'--zip',zip,'--app-id',appId,'--device-name',name,'--profile','default','--fingerprint',fingerprint],{encoding:'utf8'});
  if(r.status!==0) throw new Error('generator failed: '+r.stderr+'\n'+r.stdout);
  return {tmp,out,zip,result:JSON.parse(r.stdout.trim())};
}
function pngSize(p){
  const b=fs.readFileSync(p);
  assert.equal(b.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  return [b.readUInt32BE(16),b.readUInt32BE(20)];
}

test('device plugin is app-bound, device-unique and secret-free',()=>{
  const a=run('Lab Alpha','0123456789');
  const b=run('Lab Beta','abcdef0123');
  try{
    assert.notEqual(a.result.pluginName,b.result.pluginName);
    assert.notEqual(a.result.brandColor,b.result.brandColor);
    assert.match(a.result.pluginName,/^remote-commander-lab-alpha-0123456789$/);
    assert.equal(a.result.appId,'asdk_app_TESTDEVICE123');

    const rootManifest=JSON.parse(fs.readFileSync(path.join(a.out,'plugin.json'),'utf8'));
    const native=JSON.parse(fs.readFileSync(path.join(a.out,'.codex-plugin','plugin.json'),'utf8'));
    const app=JSON.parse(fs.readFileSync(path.join(a.out,'.app.json'),'utf8'));
    const meta=JSON.parse(fs.readFileSync(path.join(a.out,'DEVICE_PLUGIN.json'),'utf8'));
    assert.equal(rootManifest.extensions['com.openai'].apps,'./.app.json');
    assert.equal(native.apps,'./.app.json');
    assert.equal(app.apps['remote-commander'].id,'asdk_app_TESTDEVICE123');
    assert.equal(meta.secretMaterialIncluded,false);
    assert.equal(meta.deviceName,'Lab Alpha');
    assert.equal(meta.fingerprint,'0123456789');
    assert.equal(fs.existsSync(path.join(a.out,'.app.json.example')),false);

    assert.deepEqual(pngSize(path.join(a.out,'assets','icon.png')),[512,512]);
    assert.deepEqual(pngSize(path.join(a.out,'assets','logo.png')),[1024,1024]);
    assert.notEqual(sha(path.join(a.out,'assets','icon.png')),sha(path.join(b.out,'assets','icon.png')));

    const zipBytes=fs.readFileSync(a.zip);
    for(const required of ['plugin.json','.app.json','.codex-plugin/plugin.json','assets/icon.png','assets/logo.png','skills/remote-commander/SKILL.md','DEVICE_PLUGIN.json']){
      assert.equal(zipBytes.includes(Buffer.from(required)),true,'zip missing '+required);
    }
    const allText=fs.readdirSync(a.out,{recursive:true,withFileTypes:true})
      .filter((e)=>e.isFile())
      .map((e)=>fs.readFileSync(path.join(e.parentPath??e.path,e.name)))
      .filter((x)=>{try{x.toString('utf8');return true}catch{return false}})
      .map((x)=>x.toString('utf8')).join('\n');
    assert.doesNotMatch(allText,/tunnel_[0-9a-f]{32}/u);
    assert.doesNotMatch(allText,/CONTROL_PLANE_API_KEY\s*=/u);
    assert.doesNotMatch(allText,/OPENAI_API_KEY\s*=/u);
  }finally{
    fs.rmSync(a.tmp,{recursive:true,force:true});
    fs.rmSync(b.tmp,{recursive:true,force:true});
  }
});

test('same identity generates deterministic package bytes',()=>{
  const a=run('Deterministic Node','1122334455','asdk_app_DETERMINISTIC');
  const b=run('Deterministic Node','1122334455','asdk_app_DETERMINISTIC');
  try{
    assert.equal(a.result.pluginName,b.result.pluginName);
    assert.equal(a.result.zipSha256,b.result.zipSha256);
    assert.equal(sha(a.zip),sha(b.zip));
  }finally{
    fs.rmSync(a.tmp,{recursive:true,force:true});
    fs.rmSync(b.tmp,{recursive:true,force:true});
  }
});

test('invalid app identity fails before package generation',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rc-device-plugin-bad-'));
  try{
    const r=spawnSync(process.execPath,[generator,'--template',template,'--output',path.join(tmp,'plugin'),'--zip',path.join(tmp,'x.zip'),'--app-id','not_an_app','--fingerprint','12345678'],{encoding:'utf8'});
    assert.notEqual(r.status,0);
    assert.match(r.stderr,/AppId must be/u);
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('explicit owner-local identity map formats the Plugin name without renaming technical routes',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rc-device-plugin-identity-'));
  const identityFile=path.join(tmp,'identities.json');
  const out=path.join(tmp,'plugin');
  const zip=path.join(tmp,'plugin.zip');
  const accounts={schema:1,hosts:[{hostId:'device-1',hostLabel:'Owner Laptop',profiles:[
    {accountId:'acct-mmz',profileId:'MMZ',tunnelProfile:'mmz-owner-laptop',
     displayName:'Remote Commander · MMZ · Owner Laptop',aliases:['old-mmz']},
    {accountId:'acct-saeid',profileId:'saeid-secondary',tunnelProfile:'saeid-secondary',
     displayName:'Remote Commander · Saeid · Owner Laptop'}
  ]}]};
  fs.writeFileSync(identityFile,JSON.stringify(accounts));
  const base=[generator,'--template',template,'--output',out,'--zip',zip,
    '--app-id','asdk_app_TESTDEVICE123','--profile','old-mmz',
    '--device-name','Owner Laptop','--fingerprint','1234567890',
    '--identity-map',identityFile,'--host-id','device-1','--account-id','acct-mmz'];
  try{
    const result=spawnSync(process.execPath,base,{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const meta=JSON.parse(fs.readFileSync(path.join(out,'DEVICE_PLUGIN.json'),'utf8'));
    const plugin=JSON.parse(fs.readFileSync(path.join(out,'plugin.json'),'utf8'));
    assert.equal(meta.profile,'old-mmz');
    assert.equal(meta.identity.profileId,'MMZ');
    assert.equal(meta.identity.tunnelProfile,'mmz-owner-laptop');
    assert.equal(meta.identity.bindingHash.length,24);
    assert.equal(meta.displayName,'Remote Commander · MMZ · Owner Laptop');
    assert.equal(plugin.extensions['com.openai'].interface.displayName,meta.displayName);
    assert.doesNotMatch(JSON.stringify(meta),/acct-mmz|device-1/u);
    for(const [arg,value] of [['--account-id','acct-saeid'],['--host-id','wrong']]){
      const bad=base.slice();bad[bad.indexOf(arg)+1]=value;
      const denied=spawnSync(process.execPath,bad,{encoding:'utf8'});
      assert.notEqual(denied.status,0);
      assert.match(denied.stderr,/Profile identity map rejected/u);
    }
  } finally {fs.rmSync(tmp,{recursive:true,force:true});}
});

test('mapped technical aliases retain one stable per-account plugin identity',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rc-device-plugin-alias-'));
  const idFile=path.join(tmp,'map.json');
  const map={schema:1,hosts:[{hostId:'host-demo',hostLabel:'Example Device',profiles:[
    {accountId:'acct-demo',profileId:'default',
     tunnelProfile:'chatgpt-remote-commander',
     displayName:'Remote Commander · Example · Device',
     aliases:['older-technical-alias']}
  ]}]};
  fs.writeFileSync(idFile,JSON.stringify(map));
  const generate=(technical,suffix)=>{
    const out=path.join(tmp,suffix),zip=path.join(tmp,suffix+'.zip');
    const args=[generator,'--template',template,'--output',out,'--zip',zip,
      '--app-id','asdk_app_TESTDEVICE123','--identity-map',idFile,
      '--host-id','host-demo','--account-id','acct-demo','--profile',technical];
    const r=spawnSync(process.execPath,args,{encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);
    return JSON.parse(r.stdout);
  };
  try{
    const a=generate('default','a');
    const b=generate('chatgpt-remote-commander','b');
    const c=generate('older-technical-alias','c');
    assert.equal(a.pluginName,b.pluginName);
    assert.equal(b.pluginName,c.pluginName);
    assert.equal(a.fingerprint,b.fingerprint);
    assert.equal(b.fingerprint,c.fingerprint);
    assert.equal(a.displayName,c.displayName);
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
