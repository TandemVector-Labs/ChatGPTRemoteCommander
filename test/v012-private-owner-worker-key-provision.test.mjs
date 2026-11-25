import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {
  keyIdForSeed,inspectOwnerWorkerKeyCapsule,
  rebindOwnerWorkerKeyCapsule
} from '../tools/provision-owner-worker-key-linux.mjs';

const dir=path.dirname(fileURLToPath(import.meta.url));
const script=path.resolve(dir,'../tools/provision-owner-worker-key-linux.mjs');
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
const OWNER='a'.repeat(64),TUNNEL='b'.repeat(64);
const id={
  hostId:'synthetic-host',profileId:'synthetic-profile',
  expectedOwnerSidHash:OWNER,expectedTunnelIdHash:TUNNEL
};
const make=()=>fs.mkdtempSync(path.join(os.tmpdir(),'rc012-sealed-worker-'));
function capsule(root){
  const folder=path.join(root,'worker-identity');
  fs.mkdirSync(folder,{mode:0o700});
  const seed=randomBytes(32);
  const cipher=Buffer.from('SYNTHETIC_NOT_REAL_ENCRYPTED_WORKER_SEED_FOR_QA');
  const keyId=keyIdForSeed(seed);
  fs.writeFileSync(path.join(folder,'worker-ed25519-seed.cred'),cipher,{mode:0o600});
  const manifest={schema:1,hostId:id.hostId,profileId:id.profileId,
    ownerSidHash:OWNER,tunnelIdHash:TUNNEL,keyId,cipherSha256:hash(cipher)};
  fs.writeFileSync(path.join(folder,'worker-key-id.json'),
    JSON.stringify(manifest)+'\n',{mode:0o600});
  function inspect(patch={}) {
    return inspectOwnerWorkerKeyCapsule({
      directory:folder,profile:id.profileId,
      identity:{...id,...patch},ownerUid:process.getuid?.(),
      // Never a production decryption. The synthetic fixture verifies only
      // manifest/ACL checks, Ed25519 key derivation and replay rejection.
      unseal:()=>Buffer.from(seed)
    });
  }
  return {folder,seed,cipher,manifest,keyId,inspect};
}

test('one owner/pair sealed Worker capsule validates exact hash, Ed25519 key and strict file owner ACL without showing seed',{
  skip:process.platform!=='linux'
},()=>{
  const root=make();
  try{
    const f=capsule(root);
    const proof=f.inspect();
    assert.equal(proof.verified,true);
    assert.equal(proof.keyId,f.keyId);
    assert.equal(proof.profileId,id.profileId);
    assert.equal(fs.readdirSync(f.folder).length,2);
    assert.deepEqual(fs.readFileSync(path.join(f.folder,'worker-key-id.json'),'utf8'),
      JSON.stringify(f.manifest)+'\n');
    assert.throws(()=>f.inspect({expectedTunnelIdHash:'c'.repeat(64)}),
      {code:'RC012_WORKER_KEY_RECEIPT_INVALID'});
    assert.throws(()=>f.inspect({expectedOwnerSidHash:'c'.repeat(64)}),
      {code:'RC012_WORKER_KEY_RECEIPT_INVALID'});
    const pathCred=path.join(f.folder,'worker-ed25519-seed.cred');
    fs.chmodSync(pathCred,0o644);
    assert.throws(()=>f.inspect(),{code:'RC012_WORKER_KEY_FILE_NOT_PRIVATE'});
    fs.chmodSync(pathCred,0o600);
    fs.appendFileSync(pathCred,'tampered');
    assert.throws(()=>f.inspect(),{code:'RC012_WORKER_KEY_RECEIPT_INVALID'});
    assert.notEqual(f.keyId,'0'.repeat(64));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('sealed Worker capsule refuses unexpected files, aliases and an unrelated key even when ciphertext matches',{
  skip:process.platform!=='linux'
},()=>{
  const root=make();
  try{
    const f=capsule(root);
    const extra=path.join(f.folder,'extra.json');
    fs.writeFileSync(extra,'synthetic',{mode:0o600});
    assert.throws(()=>f.inspect(),{code:'RC012_WORKER_KEY_CAPSULE_UNEXPECTED_FILES'});
    fs.unlinkSync(extra);
    const keyfile=path.join(f.folder,'worker-ed25519-seed.cred');
    const other=path.join(root,'copied.cred');
    fs.copyFileSync(keyfile,other);
    fs.unlinkSync(keyfile);fs.symlinkSync(other,keyfile);
    assert.throws(()=>f.inspect(),{code:'RC012_WORKER_KEY_FILE_NOT_PRIVATE'});
    fs.unlinkSync(keyfile);fs.copyFileSync(other,keyfile);fs.chmodSync(keyfile,0o600);
    const manifest=path.join(f.folder,'worker-key-id.json');
    const changed={...f.manifest,keyId:'f'.repeat(64)};
    fs.writeFileSync(manifest,JSON.stringify(changed)+'\n',{mode:0o600});
    assert.throws(()=>f.inspect(),{code:'RC012_WORKER_KEY_IDENTITY_MISMATCH'});
    assert.throws(()=>keyIdForSeed(Buffer.alloc(31)),
      {code:'RC012_WORKER_KEY_SEED_INVALID'});
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('owner-native worker key CLI cannot be used to stage with invalid modes or profile traversal',()=>{
  for(const args of [
    [],['--enroll'],['--stage','synthetic-profile'],
    ['--enroll','../another-owner'],['--preflight','../another-owner'],
    ['--enroll','a/b'],['--rebind','../another-owner']
  ]){
    const result=spawnSync(process.execPath,[script,...args],{
      encoding:'utf8',timeout:4500,maxBuffer:2048
    });
    assert.equal(result.status,2,JSON.stringify(args));
    assert.equal(result.stdout.trim(),'');
    assert.match(result.stderr,/RC012_WORKER_KEY_OWNER_ARGS_REQUIRED/);
  }
  const source=fs.readFileSync(script,'utf8');
  for(const token of [
    'createPinnedLinuxPrivateTunnelIdentity',
    'createLinuxNativeOwnerSessionProvider',
    "ownerIdentityMode:'host-uid-v2'",
    'native.requestConsent',
    'systemd-creds','--with-key=host','--refuse-null',
    'O_EXCL','O_NOFOLLOW','privateDir','fs.renameSync(stage,directory)',
    'workerGrantIssued:false','fullAccessActive:false'
  ])assert.ok(source.includes(token),'missing fail-closed native owner gate: '+token);
});


const CERT='d'.repeat(64);
const nextIdentity={...id,
  expectedTunnelIdHash:'c'.repeat(64),
  expectedClientLeafDerSha256:CERT
};
test('realistic Tunnel restart leaves old signed worker receipt invalid until native owner approves one-time stable rebind',{skip:process.platform!=='linux'},async()=>{
  const root=make();
  try{
    const f=capsule(root), oldFile=path.join(f.folder,'worker-key-id.json');
    const cipherFile=path.join(f.folder,'worker-ed25519-seed.cred');
    const oldBytes=fs.readFileSync(oldFile),oldCipher=fs.readFileSync(cipherFile);
    const oldHash=hash(oldBytes);
    const args={directory:f.folder,profile:id.profileId,identity:nextIdentity,
      ownerUid:process.getuid(),unseal:()=>Buffer.from(f.seed)};
    assert.throws(()=>inspectOwnerWorkerKeyCapsule(args),
      {code:'RC012_WORKER_KEY_RECEIPT_INVALID'});
    await assert.rejects(rebindOwnerWorkerKeyCapsule({
      ...args,authorizeOwner:async()=>false,verifyCurrent:async()=>true
    }),{code:'RC012_WORKER_KEY_REBIND_OWNER_CONSENT_REQUIRED'});
    assert.deepEqual(fs.readFileSync(oldFile),oldBytes);
    assert.deepEqual(fs.readFileSync(cipherFile),oldCipher);
    const ready=await rebindOwnerWorkerKeyCapsule({
      ...args,authorizeOwner:async()=>true,verifyCurrent:async()=>true
    });
    assert.deepEqual(ready,{rebound:true,receiptSchema:2});
    const actual=inspectOwnerWorkerKeyCapsule(args);
    assert.equal(actual.receiptSchema,2);
    assert.equal(actual.keyId,f.keyId);
    const record=JSON.parse(fs.readFileSync(oldFile,'utf8'));
    assert.equal(record.schema,2);
    assert.equal(record.clientLeafDerSha256,CERT);
    assert.equal(Object.hasOwn(record,'tunnelIdHash'),false);
    assert.deepEqual(fs.readFileSync(cipherFile),oldCipher);
    const preserved=path.join(root,'worker-identity-receipt-history',
      'v1-'+oldHash+'.json');
    assert.deepEqual(fs.readFileSync(preserved),oldBytes);
    const anotherLive={...nextIdentity,expectedTunnelIdHash:'e'.repeat(64)};
    assert.equal(inspectOwnerWorkerKeyCapsule({...args,identity:anotherLive}).verified,true);
    let asked=false;
    assert.deepEqual(await rebindOwnerWorkerKeyCapsule({
      ...args,identity:anotherLive,
      authorizeOwner:async()=>{asked=true;return true;},
      verifyCurrent:async()=>true
    }),{rebound:false,receiptSchema:2});
    assert.equal(asked,false);
    assert.equal(fs.existsSync(path.join(root,'.worker-key-rebind.lock')),false);
    assert.throws(()=>inspectOwnerWorkerKeyCapsule({
      ...args,identity:{...anotherLive,expectedClientLeafDerSha256:'a'.repeat(64)}
    }),{code:'RC012_WORKER_KEY_RECEIPT_INVALID'});
    assert.throws(()=>inspectOwnerWorkerKeyCapsule({
      ...args,identity:{...anotherLive,expectedOwnerSidHash:'f'.repeat(64)}
    }),{code:'RC012_WORKER_KEY_RECEIPT_INVALID'});
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('worker rebind rejects stale owner, corrupted ciphertext and mid-approval Tunnel replacement',{skip:process.platform!=='linux'},async()=>{
  const root=make();
  try{
    const f=capsule(root), meta=path.join(f.folder,'worker-key-id.json');
    const baseline=fs.readFileSync(meta);
    const args={directory:f.folder,profile:id.profileId,identity:nextIdentity,
      ownerUid:process.getuid(),unseal:()=>Buffer.from(f.seed)};
    await assert.rejects(rebindOwnerWorkerKeyCapsule({
      ...args,authorizeOwner:async()=>true,verifyCurrent:async()=>false
    }),{code:'RC012_WORKER_KEY_REBIND_TUNNEL_CHANGED'});
    assert.deepEqual(fs.readFileSync(meta),baseline);
    await assert.rejects(rebindOwnerWorkerKeyCapsule({
      ...args,identity:{...nextIdentity,expectedOwnerSidHash:'f'.repeat(64)},
      authorizeOwner:async()=>true,verifyCurrent:async()=>true
    }),{code:'RC012_WORKER_KEY_RECEIPT_INVALID'});
    assert.deepEqual(fs.readFileSync(meta),baseline);
    const bad=path.join(f.folder,'worker-ed25519-seed.cred');
    fs.appendFileSync(bad,Buffer.from('BAD'));
    await assert.rejects(rebindOwnerWorkerKeyCapsule({
      ...args,authorizeOwner:async()=>true,verifyCurrent:async()=>true
    }),{code:'RC012_WORKER_KEY_RECEIPT_INVALID'});
    assert.deepEqual(fs.readFileSync(meta),baseline);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('owner rebind refuses a Tunnel change between consent and atomic commit',{skip:process.platform!=='linux'},async()=>{
  const root=make();
  try{
    const f=capsule(root),meta=path.join(f.folder,'worker-key-id.json');
    const previous=fs.readFileSync(meta);
    let checks=0;
    await assert.rejects(rebindOwnerWorkerKeyCapsule({
      directory:f.folder,profile:id.profileId,identity:nextIdentity,
      ownerUid:process.getuid(),unseal:()=>Buffer.from(f.seed),
      authorizeOwner:async()=>true,
      verifyCurrent:async()=>{checks++;return checks===1;}
    }),{code:'RC012_WORKER_KEY_REBIND_TUNNEL_CHANGED'});
    assert.equal(checks,2);
    assert.deepEqual(fs.readFileSync(meta),previous);
    assert.equal(fs.existsSync(path.join(root,'.worker-key-rebind.lock')),false);
    assert.throws(()=>inspectOwnerWorkerKeyCapsule({
      directory:f.folder,profile:id.profileId,identity:nextIdentity,
      ownerUid:process.getuid(),unseal:()=>Buffer.from(f.seed)
    }),{code:'RC012_WORKER_KEY_RECEIPT_INVALID'});
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
