import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTransferMeshTools } from '../src/transfer-tools.mjs';
import { readTransferReceiptSidecar, writeTransferReceiptSidecar } from '../src/transfer-receipts.mjs';

const HASH='a'.repeat(64);
const ID='transfer-101';
const challenge=(peer='PC',id=ID)=>({
  schema:1,issuer:'commander-transfer',audience:'cross-host-artifact',
  senderAlias:peer,recipientAlias:'Linux',
  senderHostId:'host-pc-01',senderProfileId:'profile-pc-01',
  recipientHostId:'host-linux-01',recipientProfileId:'profile-linux-01',
  transferId:id,artifactBytes:11,senderConsentEpoch:'b'.repeat(64),
  nonce:'A'.repeat(43),issuedAtMs:1800000000000,expiresAtMs:1800003600000
});
const outgoingChallenge=(peer='PC',id=ID)=>({
  ...challenge('Linux',id),recipientAlias:peer,
  recipientHostId:'host-pc-01',recipientProfileId:'profile-pc-01'
});
const envelope=(id=ID)=>({
  schema:1,keyId:'linux-key-01',
  claims:{receiptId:(id==='transfer-101'?'c':'d').repeat(64),transferId:id,artifactBytes:11,artifactSha256:HASH},
  signature:'B'.repeat(86)
});

function writeScript(file,source){fs.writeFileSync(file,source,{mode:0o600});}
const transferScript=[
"import fs from 'node:fs';",
"import path from 'node:path';",
"const args=process.argv.slice(2);",
"const val=k=>args[args.indexOf(k)+1];",
"const root=process.env.COMMANDER_TRANSFER_HOME;",
"if(args[0]==='receive'){",
"  fs.writeFileSync(path.join(root,'receive-ran'),'yes');",
"  const id=val('--id'),peer=val('--peer');",
"  const manifest=JSON.parse(fs.readFileSync(path.join(root,'pairs',peer,'transfers',id,'manifest.json'),'utf8'));",
"  console.log(JSON.stringify({schema:'ctmesh-v1',status:'DELIVERED_HASH_VERIFIED',id,bytes:manifest.bytes,sha256:manifest.sha256}));",
"}else if(args[0]==='info') console.log(JSON.stringify({schema:'ctmesh-v1',status:'OK'}));",
"else console.log(JSON.stringify({schema:'ctmesh-v1',status:'QUEUED'}));"
].join('\n');
const durableScript=[
"import fs from 'node:fs';",
"import path from 'node:path';",
"const args=process.argv.slice(2);",
"const val=k=>args[args.indexOf(k)+1];",
"const root=process.env.COMMANDER_TRANSFER_HOME;",
"if(args[0]==='capabilities'){",
"  console.log(JSON.stringify({schema:'ctmesh-durable-v1',contractVersion:2,admissionQuotas:true,supports:['enqueue','job-status','resume','cancel']}));",
"}else if(args[0]==='enqueue'){",
"  const peer=val('--peer'),id=val('--id'),source=val('--path'),bytes=fs.statSync(source).size;",
"  const dir=path.join(root,'jobs',peer);fs.mkdirSync(dir,{recursive:true});",
"  fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify({schema:'ctmesh-durable-job-v1',id,peer,status:'QUEUED',path:source,bytes,sha256:null}));",
"  console.log(JSON.stringify({schema:'ctmesh-durable-v1',id,peer,status:'QUEUED',bytes}));",
"}else console.log(JSON.stringify({schema:'ctmesh-durable-v1',status:'OK'}));"
].join('\n');

function fixture({receiptsEnabled=true,durableEnabled=true,authority}={}){
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc-transfer-mesh-receipts-')));
  const source=path.join(root,'source');const dest=path.join(root,'dest');
  fs.mkdirSync(source);fs.mkdirSync(dest);
  const sourceFile=path.join(source,'payload.bin');fs.writeFileSync(sourceFile,'hello world');
  writeScript(path.join(root,'transfer.mjs'),transferScript);
  writeScript(path.join(root,'durable-send.mjs'),durableScript);
  const calls=[];
  const stub=authority??{
    async createChallenge(ctx){calls.push(['createChallenge',ctx]);return outgoingChallenge(ctx.peerAlias,ctx.transferId);},
    async validateIncomingChallenge(ctx){calls.push(['validateIncomingChallenge',ctx]);return {granted:true};},
    async getIssuedReceipt(ctx){calls.push(['getIssuedReceipt',ctx]);return null;},
    async issueReceipt(ctx){calls.push(['issueReceipt',ctx]);return envelope(ctx.transferId);},
    async verifyReceipt(ctx){calls.push(['verifyReceipt',ctx]);return {status:'ACK_VERIFIED',duplicate:false,receiptId:'c'.repeat(64),executionAuthorityGranted:false};}
  };
  const tools=createTransferMeshTools({
    config:{
      powerMode:{enabled:true},
      transferMesh:{
        enabled:true,root,sourceRoots:[source],destinationRoots:[dest],
        durableEnabled,receiptsEnabled,maxSourceBytes:1024,maxPendingBytes:4096,maxActiveJobs:2
      }
    },
    receiptAuthority:stub
  });
  const cleanup=()=>fs.rmSync(root,{recursive:true,force:true});
  return {root,source,dest,sourceFile,tools,authority:stub,calls,cleanup};
}

test('signed receipt mode requires durable staging and a trusted authority',t=>{
  const f=fixture({receiptsEnabled:false});t.after(f.cleanup);
  assert.throws(()=>createTransferMeshTools({config:{
    powerMode:{enabled:true},transferMesh:{enabled:true,root:f.root,sourceRoots:[f.source],destinationRoots:[f.dest],
      durableEnabled:false,receiptsEnabled:true}
  }}),/TRANSFER_RECEIPTS_REQUIRE_DURABLE/);
  assert.throws(()=>createTransferMeshTools({config:{
    powerMode:{enabled:true},transferMesh:{enabled:true,root:f.root,sourceRoots:[f.source],destinationRoots:[f.dest],
      durableEnabled:true,receiptsEnabled:true}
  }}),/TRANSFER_RECEIPT_AUTHORITY_REQUIRED/);
});

test('receipt mode removes unsigned send and exposes explicit ACK verification',t=>{
  const f=fixture();t.after(f.cleanup);
  const names=f.tools.definitions.map(x=>x.name);
  assert.equal(names.includes('transfer_mesh_send'),false);
  assert.equal(names.includes('transfer_mesh_enqueue'),true);
  assert.equal(names.includes('transfer_mesh_receive'),true);
  assert.equal(names.includes('transfer_mesh_receipt_verify'),true);
  const verify=f.tools.definitions.find(x=>x.name==='transfer_mesh_receipt_verify');
  assert.equal(verify.annotations.readOnlyHint,false);
  assert.equal(verify.annotations.destructiveHint,false);
  assert.equal(verify.annotations.openWorldHint,false);
});

test('durable enqueue writes immutable challenge sidecar and never returns its nonce',async t=>{
  const f=fixture();t.after(f.cleanup);
  const result=await f.tools.execute('transfer_mesh_enqueue',{peer:'PC',path:f.sourceFile,id:ID});
  assert.equal(result.status,'QUEUED');
  assert.equal(result.receiptRequired,true);
  assert.equal(result.receiptExpiresAtMs,1800003600000);
  assert.equal(result.nonce,undefined);
  assert.equal(f.calls.some(x=>x[0]==='createChallenge'),true);
  const saved=readTransferReceiptSidecar(f.root,'PC','challenges',ID);
  assert.equal(saved.transferId,ID);
  assert.equal(saved.senderAlias,'Linux');
  assert.equal(saved.recipientAlias,'PC');
});

test('receive refuses missing challenge before invoking the transfer CLI',async t=>{
  const f=fixture();t.after(f.cleanup);
  const dir=path.join(f.root,'pairs','PC','transfers',ID);
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({
    schema:'ctmesh-v1',id:ID,from:'PC',to:'Linux',bytes:11,sha256:HASH,name:'payload.bin'
  }));
  await assert.rejects(f.tools.execute('transfer_mesh_receive',{peer:'PC',id:ID,dest:f.dest}),
    /TRANSFER_RECEIPT_CHALLENGE_MISSING/);
  assert.equal(fs.existsSync(path.join(f.root,'receive-ran')),false);
});

test('recipient verifies hash, issues signed receipt sidecar, and does not grant execution',async t=>{
  const f=fixture();t.after(f.cleanup);
  const ch=challenge('PC',ID);
  writeTransferReceiptSidecar(f.root,'PC','challenges',ID,ch);
  const dir=path.join(f.root,'pairs','PC','transfers',ID);
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({
    schema:'ctmesh-v1',id:ID,from:'PC',to:'Linux',bytes:11,sha256:HASH,name:'payload.bin'
  }));
  const result=await f.tools.execute('transfer_mesh_receive',{peer:'PC',id:ID,dest:f.dest});
  assert.equal(result.status,'DELIVERED_HASH_VERIFIED');
  assert.equal(result.receiptStatus,'SIGNED_RECEIPT_ISSUED');
  assert.equal(result.receiptId,'c'.repeat(64));
  assert.equal(result.executionAuthorityGranted,false);
  assert.equal(f.calls.some(x=>x[0]==='validateIncomingChallenge'),true);
  assert.equal(f.calls.some(x=>x[0]==='issueReceipt'),true);
  assert.equal(readTransferReceiptSidecar(f.root,'PC','receipts',ID).claims.transferId,ID);
});

test('repeated receive republishes the existing signed receipt without copying again',async t=>{
  const f=fixture();t.after(f.cleanup);
  const ch=challenge('PC',ID);
  writeTransferReceiptSidecar(f.root,'PC','challenges',ID,ch);
  const dir=path.join(f.root,'pairs','PC','transfers',ID);
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({
    schema:'ctmesh-v1',id:ID,from:'PC',to:'Linux',bytes:11,sha256:HASH,name:'payload.bin'
  }));
  const existing=envelope(ID);
  f.authority.getIssuedReceipt=async()=>existing;
  const result=await f.tools.execute('transfer_mesh_receive',{peer:'PC',id:ID,dest:f.dest});
  assert.equal(result.status,'ALREADY_ACKED');
  assert.equal(result.receiptStatus,'SIGNED_RECEIPT_ISSUED');
  assert.equal(fs.existsSync(path.join(f.root,'receive-ran')),false);
  assert.deepEqual(readTransferReceiptSidecar(f.root,'PC','receipts',ID),existing);
});

test('sender reports PENDING until the durable source job is published and receipt sync completes',async t=>{
  const f=fixture();t.after(f.cleanup);
  const jobs=path.join(f.root,'jobs','PC');fs.mkdirSync(jobs,{recursive:true});
  const jobPath=path.join(jobs,ID+'.json');
  fs.writeFileSync(jobPath,JSON.stringify({id:ID,peer:'PC',status:'QUEUED',bytes:11,sha256:HASH}));
  const notPublished=await f.tools.execute('transfer_mesh_receipt_verify',{peer:'PC',id:ID});
  assert.equal(notPublished.status,'PENDING');
  assert.equal(notPublished.reason,'SOURCE_NOT_PUBLISHED');
  fs.writeFileSync(jobPath,JSON.stringify({id:ID,peer:'PC',status:'PUBLISHED',bytes:11,sha256:HASH}));
  writeTransferReceiptSidecar(f.root,'PC','challenges',ID,outgoingChallenge('PC',ID));
  const noReceipt=await f.tools.execute('transfer_mesh_receipt_verify',{peer:'PC',id:ID});
  assert.equal(noReceipt.status,'PENDING');
  assert.equal(noReceipt.reason,'SIGNED_RECEIPT_NOT_SYNCED');
  writeTransferReceiptSidecar(f.root,'PC','receipts',ID,envelope(ID));
  const accepted=await f.tools.execute('transfer_mesh_receipt_verify',{peer:'PC',id:ID});
  assert.equal(accepted.status,'ACK_VERIFIED');
  assert.equal(accepted.executionAuthorityGranted,false);
  assert.equal(f.calls.some(x=>x[0]==='verifyReceipt'),true);
});

test('receipt verification rejects a missing or mismatched local source job',async t=>{
  const f=fixture();t.after(f.cleanup);
  await assert.rejects(f.tools.execute('transfer_mesh_receipt_verify',{peer:'PC',id:ID}),
    /ENOENT|TRANSFER_RECEIPT_RECORD_UNTRUSTED/);
});

test('legacy mode keeps unsigned small-file send and does not expose receipt verification',t=>{
  const f=fixture({receiptsEnabled:false,durableEnabled:false});t.after(f.cleanup);
  const names=f.tools.definitions.map(x=>x.name);
  assert.equal(names.includes('transfer_mesh_send'),true);
  assert.equal(names.includes('transfer_mesh_receipt_verify'),false);
});
