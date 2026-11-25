import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  createTransferReceiptAuthority, readTransferReceiptSidecar, writeTransferReceiptSidecar
} from '../src/transfer-receipts.mjs';

const ISSUER='commander-transfer';
const AUDIENCE='cross-host-artifact';
const SENDER_EPOCH='a'.repeat(64);
const RECEIVER_EPOCH='b'.repeat(64);
const sha=value=>createHash('sha256').update(value).digest('hex');
const errorCode=code=>error=>error?.code===code;

function fixture({now=1_800_000_000_000}={}){
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc-transfer-receipts-')));
  const pcPair=generateKeyPairSync('ed25519');
  const linuxPair=generateKeyPairSync('ed25519');
  const pc={alias:'PC',hostId:'host-pc-01',profileId:'profile-pc-01',keyId:'pc-key-01',
    publicKey:pcPair.publicKey,privateKey:pcPair.privateKey};
  const linux={alias:'Linux',hostId:'host-linux-01',profileId:'profile-linux-01',keyId:'linux-key-01',
    publicKey:linuxPair.publicKey,privateKey:linuxPair.privateKey};
  const trustPC=new Map([['Linux',{...linux,authenticated:true,publicKeys:new Map([[linux.keyId,linux.publicKey]])}]]);
  const trustLinux=new Map([['PC',{...pc,authenticated:true,publicKeys:new Map([[pc.keyId,pc.publicKey]])}]]);
  const state={now,denyPC:new Set(),denyLinux:new Set(),senderEpoch:SENDER_EPOCH,receiverEpoch:RECEIVER_EPOCH};
  function make(local,privateKey,trust,role){
    return createTransferReceiptAuthority({
      issuer:ISSUER,audience:AUDIENCE,
      ledgerDirectory:path.join(root,local.alias,'receipt-ledger'),
      localIdentity:()=>({alias:local.alias,hostId:local.hostId,profileId:local.profileId,
        keyId:local.keyId,publicKey:local.publicKey}),
      resolvePeerIdentity:alias=>{
        const peer=trust.get(alias);
        if(!peer)throw new Error('PEER_NOT_FOUND');
        return {alias:peer.alias,hostId:peer.hostId,profileId:peer.profileId,
          authenticated:peer.authenticated,publicKeys:new Map(peer.publicKeys)};
      },
      signReceipt:(keyId,bytes)=>sign(null,bytes,privateKey).toString('base64url'),
      authorizeTransfer:context=>{
        const denied=role==='sender'?state.denyPC:state.denyLinux;
        const consentEpoch=role==='sender'?state.senderEpoch:state.receiverEpoch;
        return {granted:!denied.has(context.action),consentEpoch};
      },
      now:()=>state.now
    });
  }
  const sender=make(pc,pcPair.privateKey,trustPC,'sender');
  const receiver=make(linux,linuxPair.privateKey,trustLinux,'receiver');
  const artifact={bytes:11,sha256:sha('hello world')};
  const cleanup=()=>fs.rmSync(root,{recursive:true,force:true});
  return {root,pc,linux,trustPC,trustLinux,state,sender,receiver,artifact,cleanup};
}
async function roundTrip(f){
  const challenge=await f.sender.createChallenge({peerAlias:'Linux',transferId:'transfer-001',bytes:f.artifact.bytes});
  const envelope=await f.receiver.issueReceipt({
    peerAlias:'PC',transferId:'transfer-001',challenge,artifact:f.artifact
  });
  return {challenge,envelope};
}

test('signed cross-host receipt binds both hosts, profiles, artifact, challenge nonce and consent epochs',async t=>{
  const f=fixture();t.after(f.cleanup);
  const {challenge,envelope}=await roundTrip(f);
  assert.equal(envelope.schema,1);
  assert.equal(envelope.claims.senderHostId,f.pc.hostId);
  assert.equal(envelope.claims.recipientHostId,f.linux.hostId);
  assert.equal(envelope.claims.artifactSha256,f.artifact.sha256);
  assert.equal(envelope.claims.artifactBytes,f.artifact.bytes);
  assert.equal(envelope.claims.nonce,challenge.nonce);
  assert.equal(envelope.claims.senderConsentEpoch,SENDER_EPOCH);
  assert.equal(envelope.claims.recipientConsentEpoch,RECEIVER_EPOCH);
  const accepted=await f.sender.verifyReceipt({
    peerAlias:'Linux',transferId:'transfer-001',challenge,artifact:f.artifact,envelope
  });
  assert.equal(accepted.status,'ACK_VERIFIED');
  assert.equal(accepted.duplicate,false);
  assert.equal(accepted.executionAuthorityGranted,false);
  assert.equal('execute' in f.sender,false);
});

test('challenge creation and receipt issuance are idempotent for the same transfer',async t=>{
  const f=fixture();t.after(f.cleanup);
  const challenge=await f.sender.createChallenge({peerAlias:'Linux',transferId:'transfer-002',bytes:11});
  const sameChallenge=await f.sender.createChallenge({peerAlias:'Linux',transferId:'transfer-002',bytes:11});
  assert.deepEqual(sameChallenge,challenge);
  const first=await f.receiver.issueReceipt({peerAlias:'PC',transferId:'transfer-002',challenge,artifact:f.artifact});
  const second=await f.receiver.issueReceipt({peerAlias:'PC',transferId:'transfer-002',challenge,artifact:f.artifact});
  assert.deepEqual(second,first);
  await assert.rejects(
    f.sender.createChallenge({peerAlias:'Linux',transferId:'transfer-002',bytes:12}),
    errorCode('TRANSFER_RECEIPT_CHALLENGE_CONFLICT')
  );
});

test('accepted nonce survives authority restart and exact receipt replay is idempotent',async t=>{
  const f=fixture();t.after(f.cleanup);
  const {challenge,envelope}=await roundTrip(f);
  const first=await f.sender.verifyReceipt({peerAlias:'Linux',transferId:'transfer-001',challenge,artifact:f.artifact,envelope});
  assert.equal(first.duplicate,false);
  const restarted=createTransferReceiptAuthority({
    issuer:ISSUER,audience:AUDIENCE,
    ledgerDirectory:path.join(f.root,'PC','receipt-ledger'),
    localIdentity:()=>({alias:'PC',hostId:f.pc.hostId,profileId:f.pc.profileId,keyId:f.pc.keyId,publicKey:f.pc.publicKey}),
    resolvePeerIdentity:alias=>{
      const peer=f.trustPC.get(alias);
      return {alias:peer.alias,hostId:peer.hostId,profileId:peer.profileId,authenticated:true,publicKeys:new Map(peer.publicKeys)};
    },
    signReceipt:(keyId,bytes)=>sign(null,bytes,f.pc.privateKey).toString('base64url'),
    authorizeTransfer:()=>({granted:false,consentEpoch:SENDER_EPOCH}),
    now:()=>f.state.now
  });
  const replay=await restarted.verifyReceipt({peerAlias:'Linux',transferId:'transfer-001',challenge,artifact:f.artifact,envelope});
  assert.equal(replay.status,'ACK_VERIFIED');
  assert.equal(replay.duplicate,true);
  assert.equal(replay.executionAuthorityGranted,false);
});

test('conflicting receipt for an already consumed nonce is rejected as replay',async t=>{
  const f=fixture();t.after(f.cleanup);
  const first=await roundTrip(f);
  await f.sender.verifyReceipt({peerAlias:'Linux',transferId:'transfer-001',challenge:first.challenge,artifact:f.artifact,envelope:first.envelope});
  const secondChallenge=await f.sender.createChallenge({peerAlias:'Linux',transferId:'transfer-002',bytes:11});
  const reused=Object.freeze({...secondChallenge,nonce:first.challenge.nonce});
  const challengeFile=path.join(f.root,'PC','receipt-ledger','challenges','Linux','transfer-002.json');
  fs.writeFileSync(challengeFile,JSON.stringify(reused));
  const secondEnvelope=await f.receiver.issueReceipt({peerAlias:'PC',transferId:'transfer-002',challenge:reused,artifact:f.artifact});
  await assert.rejects(
    f.sender.verifyReceipt({peerAlias:'Linux',transferId:'transfer-002',challenge:reused,artifact:f.artifact,envelope:secondEnvelope}),
    errorCode('TRANSFER_RECEIPT_REPLAY_CONFLICT')
  );
});

test('concurrent verification consumes one nonce exactly once',async t=>{
  const f=fixture();t.after(f.cleanup);
  const {challenge,envelope}=await roundTrip(f);
  const results=await Promise.all([
    f.sender.verifyReceipt({peerAlias:'Linux',transferId:'transfer-001',challenge,artifact:f.artifact,envelope}),
    f.sender.verifyReceipt({peerAlias:'Linux',transferId:'transfer-001',challenge,artifact:f.artifact,envelope})
  ]);
  assert.deepEqual(results.map(x=>x.status),['ACK_VERIFIED','ACK_VERIFIED']);
  assert.deepEqual(results.map(x=>x.duplicate).sort(),[false,true]);
});

test('tampered signature and artifact digest are rejected',async t=>{
  const f=fixture();t.after(f.cleanup);
  const {challenge,envelope}=await roundTrip(f);
  const signature=envelope.signature[0]==='A'?'B':'A';
  await assert.rejects(
    f.sender.verifyReceipt({peerAlias:'Linux',transferId:'transfer-001',challenge,artifact:f.artifact,
      envelope:{...envelope,signature:signature+envelope.signature.slice(1)}}),
    errorCode('TRANSFER_RECEIPT_SIGNATURE_INVALID')
  );
  await assert.rejects(
    f.sender.verifyReceipt({peerAlias:'Linux',transferId:'transfer-001',challenge,
      artifact:{bytes:11,sha256:sha('different')},envelope}),
    errorCode('TRANSFER_RECEIPT_SCOPE_MISMATCH')
  );
});

test('revoked recipient signing key is not accepted',async t=>{
  const f=fixture();t.after(f.cleanup);
  const {challenge,envelope}=await roundTrip(f);
  const rotated=generateKeyPairSync('ed25519');
  f.trustPC.get('Linux').publicKeys=new Map([['linux-key-02',rotated.publicKey]]);
  await assert.rejects(
    f.sender.verifyReceipt({peerAlias:'Linux',transferId:'transfer-001',challenge,artifact:f.artifact,envelope}),
    errorCode('TRANSFER_RECEIPT_KEY_UNTRUSTED_OR_REVOKED')
  );
});

test('sender consent revocation before first ACK verification fails closed',async t=>{
  const f=fixture();t.after(f.cleanup);
  const {challenge,envelope}=await roundTrip(f);
  f.state.denyPC.add('accept');
  await assert.rejects(
    f.sender.verifyReceipt({peerAlias:'Linux',transferId:'transfer-001',challenge,artifact:f.artifact,envelope}),
    errorCode('TRANSFER_RECEIPT_OWNER_CONSENT_REQUIRED')
  );
});

test('receiver consent revocation prevents receipt issuance',async t=>{
  const f=fixture();t.after(f.cleanup);
  const challenge=await f.sender.createChallenge({peerAlias:'Linux',transferId:'transfer-003',bytes:11});
  f.state.denyLinux.add('receive');
  await assert.rejects(
    f.receiver.issueReceipt({peerAlias:'PC',transferId:'transfer-003',challenge,artifact:f.artifact}),
    errorCode('TRANSFER_RECEIPT_OWNER_CONSENT_REQUIRED')
  );
});

test('changed sender consent epoch invalidates an unaccepted receipt',async t=>{
  const f=fixture();t.after(f.cleanup);
  const {challenge,envelope}=await roundTrip(f);
  f.state.senderEpoch='c'.repeat(64);
  await assert.rejects(
    f.sender.verifyReceipt({peerAlias:'Linux',transferId:'transfer-001',challenge,artifact:f.artifact,envelope}),
    errorCode('TRANSFER_RECEIPT_OWNER_CONSENT_REVOKED')
  );
});

test('expired challenge cannot issue or accept a new receipt',async t=>{
  const f=fixture();t.after(f.cleanup);
  const challenge=await f.sender.createChallenge({peerAlias:'Linux',transferId:'transfer-004',bytes:11});
  f.state.now=challenge.expiresAtMs;
  await assert.rejects(
    f.receiver.issueReceipt({peerAlias:'PC',transferId:'transfer-004',challenge,artifact:f.artifact}),
    errorCode('TRANSFER_RECEIPT_CHALLENGE_EXPIRED')
  );
});

test('same accepted receipt remains a historical idempotent ACK after expiry and revocation',async t=>{
  const f=fixture();t.after(f.cleanup);
  const {challenge,envelope}=await roundTrip(f);
  await f.sender.verifyReceipt({peerAlias:'Linux',transferId:'transfer-001',challenge,artifact:f.artifact,envelope});
  f.state.now=challenge.expiresAtMs+1;
  f.state.denyPC.add('accept');
  const duplicate=await f.sender.verifyReceipt({peerAlias:'Linux',transferId:'transfer-001',challenge,artifact:f.artifact,envelope});
  assert.equal(duplicate.duplicate,true);
  assert.equal(duplicate.status,'ACK_VERIFIED');
});

test('shared challenge and receipt sidecars are immutable and bounded',async t=>{
  const f=fixture();t.after(f.cleanup);
  const {challenge,envelope}=await roundTrip(f);
  assert.equal(writeTransferReceiptSidecar(f.root,'PC','challenges','transfer-001',challenge),true);
  assert.equal(writeTransferReceiptSidecar(f.root,'PC','challenges','transfer-001',challenge),false);
  assert.deepEqual(readTransferReceiptSidecar(f.root,'PC','challenges','transfer-001'),challenge);
  assert.equal(writeTransferReceiptSidecar(f.root,'PC','receipts','transfer-001',envelope),true);
  assert.deepEqual(readTransferReceiptSidecar(f.root,'PC','receipts','transfer-001'),envelope);
  await assert.rejects(
    Promise.resolve().then(()=>writeTransferReceiptSidecar(f.root,'PC','receipts','transfer-001',{schema:1})),
    errorCode('TRANSFER_RECEIPT_IMMUTABLE_CONFLICT')
  );
  assert.equal(readTransferReceiptSidecar(f.root,'PC','receipts','missing-001'),null);
});

test('receipt authority requires trusted identity, signer, owner authorization and a private ledger path',t=>{
  const f=fixture();t.after(f.cleanup);
  assert.throws(()=>createTransferReceiptAuthority({issuer:ISSUER,audience:AUDIENCE}),errorCode('TRANSFER_RECEIPT_AUTHORITY_REQUIRED'));
  const symlink=path.join(f.root,'ledger-link');
  fs.symlinkSync(path.join(f.root,'PC','receipt-ledger'),symlink,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>createTransferReceiptAuthority({
    issuer:ISSUER,audience:AUDIENCE,ledgerDirectory:symlink,
    localIdentity:()=>({}),resolvePeerIdentity:()=>({}),signReceipt:()=>'',authorizeTransfer:()=>({granted:true,consentEpoch:SENDER_EPOCH})
  }),errorCode('TRANSFER_RECEIPT_LEDGER_UNTRUSTED'));
});

test('receipt protocol exposes no worker execution capability',async t=>{
  const f=fixture();t.after(f.cleanup);
  assert.deepEqual(Object.keys(f.sender).sort(),
    ['createChallenge','getIssuedReceipt','issueReceipt','validateIncomingChallenge','verifyReceipt'].sort());
  assert.equal(f.sender.execute,undefined);
  assert.equal(f.sender.run,undefined);
});
