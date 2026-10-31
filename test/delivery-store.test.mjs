import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeliveryStore, digest, stableJson } from '../src/delivery-store.mjs';

function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-delivery-'));
  const directory=path.join(root,'state');
  const open=()=>new DeliveryStore({directory,scope:'profile-a'});
  return {root,directory,open,dispose(){fs.rmSync(root,{recursive:true,force:true});}};
}

test('delivery event publish is durable and idempotent across restart',()=>{
  const f=fixture();
  try{
    let store=f.open();
    const first=store.publish({eventKey:'project:run-one:complete',correlationId:'chat-a',source:'project',sourceId:'run-one',kind:'COMPLETED'});
    const again=store.publish({eventKey:'project:run-one:complete',correlationId:'chat-a',source:'project',sourceId:'run-one',kind:'COMPLETED'});
    assert.equal(again.deliveryId,first.deliveryId);
    store.close(); store=f.open();
    const after=store.get(first.deliveryId,'chat-a');
    assert.equal(after.kind,'COMPLETED');
    assert.equal(after.state,'COMPLETED_UNDELIVERED');
    assert.equal(store.health().pending,1);
    store.close();
  } finally { f.dispose(); }
});

test('completion beacon exposes only bounded pending metadata without artifact contents',()=>{
  const f=fixture(); const store=f.open();
  try{
    const artifact=store.writeArtifact({secretLike:'do-not-inline',summary:'done'});
    const first=store.publish({eventKey:'tool:job-beacon-1:final',correlationId:'req-beacon-1',source:'tool',sourceId:'job-beacon-1',kind:'COMPLETED',artifact});
    store.publish({eventKey:'project:run-beacon-2:end',correlationId:'run-beacon-2',source:'project',sourceId:'run-beacon-2',kind:'BLOCKED',code:'PROJECT_BLOCKED'});
    const beacon=store.beacon(1);
    assert.equal(beacon.pending,2);
    assert.equal(beacon.items.length,1);
    assert.equal(beacon.items[0].correlationId,'run-beacon-2');
    assert.equal(beacon.items[0].artifact,null);
    assert.equal(beacon.hostWakeAvailable,false);
    assert.equal(beacon.identityBoundary,'TRUSTED_PROFILE_NOT_AUTHENTICATED_CHAT');
    assert.equal(JSON.stringify(beacon).includes('do-not-inline'),false);
    const full=store.beacon(5);
    const item=full.items.find(x=>x.deliveryId===first.deliveryId);
    assert.equal(item.artifact.bytes,artifact.bytes);
    assert.equal(item.artifact.sha256,artifact.sha256);
  } finally { store.close(); f.dispose(); }
});

test('same event key with changed payload fails closed',()=>{
  const f=fixture(); const store=f.open();
  try{
    store.publish({eventKey:'project:run-one:end',correlationId:'chat-a',source:'project',sourceId:'run-one',kind:'BLOCKED',code:'PROJECT_BLOCKED'});
    assert.throws(()=>store.publish({eventKey:'project:run-one:end',correlationId:'chat-a',source:'project',sourceId:'run-one',kind:'COMPLETED'}),/DELIVERY_EVENT_CONFLICT/);
  } finally { store.close(); f.dispose(); }
});

test('claim and ack require exact correlation and are idempotent for same attempt',()=>{
  const f=fixture(); const store=f.open();
  try{
    const item=store.publish({eventKey:'project:run-two:wait',correlationId:'chat-a',source:'project',sourceId:'run-two',kind:'WAITING_INPUT'});
    assert.throws(()=>store.claim({deliveryId:item.deliveryId,correlationId:'chat-b',attemptId:'attempt-b'}),/DELIVERY_CORRELATION_MISMATCH/);
    const claimed=store.claim({deliveryId:item.deliveryId,correlationId:'chat-a',attemptId:'attempt-a'});
    assert.equal(claimed.state,'DELIVERY_PENDING');
    assert.equal(claimed.claimed,true);
    const duplicate=store.claim({deliveryId:item.deliveryId,correlationId:'chat-a',attemptId:'attempt-a'});
    assert.equal(duplicate.attempts,1);
    assert.throws(()=>store.claim({deliveryId:item.deliveryId,correlationId:'chat-a',attemptId:'attempt-other'}),/DELIVERY_CLAIM_BUSY/);
    const acked=store.ack({deliveryId:item.deliveryId,correlationId:'chat-a',attemptId:'attempt-a'});
    assert.equal(acked.state,'DELIVERED');
    const repeated=store.ack({deliveryId:item.deliveryId,correlationId:'chat-a',attemptId:'attempt-a'});
    assert.equal(repeated.receiptId,acked.receiptId);
    assert.throws(()=>store.ack({deliveryId:item.deliveryId,correlationId:'chat-b',attemptId:'attempt-a'}),/DELIVERY_CORRELATION_MISMATCH/);
  } finally { store.close(); f.dispose(); }
});

test('artifact storage is content-addressed bounded and chunk-readable through correlation',()=>{
  const f=fixture(); const store=f.open();
  try{
    const result={text:'x'.repeat(40000),nested:{ok:true}};
    const a=store.writeArtifact(result),b=store.writeArtifact(result);
    assert.deepEqual(a,b);
    assert.equal(a.id,digest(Buffer.from(JSON.stringify(result))));
    const item=store.publish({eventKey:'tool:job-one:final',correlationId:'chat-a',source:'tool',sourceId:'job-one',kind:'COMPLETED',artifact:a});
    let offset=0,total=0;
    while(offset!==null){
      const chunk=store.readArtifact({deliveryId:item.deliveryId,correlationId:'chat-a',offset,maxBytes:4096});
      total+=Buffer.from(chunk.data,'base64').length;
      offset=chunk.nextOffset;
    }
    assert.equal(total,a.bytes);
    assert.throws(()=>store.readArtifact({deliveryId:item.deliveryId,correlationId:'chat-b'}),/DELIVERY_CORRELATION_MISMATCH/);
  } finally { store.close(); f.dispose(); }
});

test('request reservation deduplicates exact lost acknowledgement and conflicts changed input',()=>{
  const f=fixture(); const store=f.open();
  try{
    const inputHash=digest(stableJson({tool:'write_text',path:'a.txt'}));
    const first=store.reserve({requestId:'request-1',correlationId:'chat-a',tool:'write_text',inputHash,durationMs:1000});
    const duplicate=store.reserve({requestId:'request-1',correlationId:'chat-a',tool:'write_text',inputHash,durationMs:1000});
    assert.equal(duplicate.jobId,first.jobId);
    assert.equal(duplicate.duplicate,true);
    assert.throws(()=>store.reserve({requestId:'request-1',correlationId:'chat-a',tool:'write_text',inputHash:digest('changed'),durationMs:1000}),/REQUEST_ID_CONFLICT/);
  } finally { store.close(); f.dispose(); }
});

test('completed request produces stable artifact delivery when finish acknowledgement is lost',()=>{
  const f=fixture(); const store=f.open();
  try{
    const inputHash=digest('input');
    store.reserve({requestId:'request-2',correlationId:'chat-a',tool:'read_text',inputHash,durationMs:1000});
    const first=store.finish('request-2',{ok:true,data:'result'});
    const duplicate=store.finish('request-2',{ok:true,data:'result'});
    assert.equal(duplicate.deliveryId,first.deliveryId);
    assert.equal(store.list({correlationId:'chat-a'}).items.length,1);
  } finally { store.close(); f.dispose(); }
});

test('expired unfinished request becomes durable UNCERTAIN rather than replay authority',async()=>{
  const f=fixture();
  try{
    let store=f.open();
    store.reserve({requestId:'request-3',correlationId:'chat-a',tool:'write_text',inputHash:digest('input'),durationMs:1000});
    store.close();
    await new Promise(resolve=>setTimeout(resolve,1050));
    store=f.open();
    assert.equal(store.recover().recovered,1);
    const request=store.request('request-3');
    assert.equal(request.status,'UNCERTAIN');
    const event=store.get(request.deliveryId,'chat-a');
    assert.equal(event.kind,'UNCERTAIN');
    assert.equal(event.code,'RECONCILE_BEFORE_NEW_REQUEST');
    store.close();
  } finally { f.dispose(); }
});


test('default delivery location does not inherit workflow or async project state directories', async () => {
  const { deliveryLocation } = await import('../src/delivery-store.mjs');
  const project = path.join(os.tmpdir(), 'rc-project-owned-state');
  const configPath = path.join(project, 'config.json');
  const location = deliveryLocation({
    instance: { profile: 'profile-a' },
    allowedRoots: [project],
    asyncOperations: { stateDir: path.join(project, 'ops') },
    durableWorkflows: { directory: path.join(project, 'workflow') }
  }, configPath);
  assert.equal(location.directory.startsWith(project + path.sep), false);
  assert.equal(location.scope.length, 64);
});


test('explicit delivery scope survives versioned config-path rotation', async () => {
  const { deliveryLocation, stableDeliveryScope } = await import('../src/delivery-store.mjs');
  const scope=stableDeliveryScope({deviceName:'linux-host-a',instance:{profile:'default'}});
  const directory=path.join(os.tmpdir(),'rc-delivery-stable-profile',scope);
  const config={deviceName:'linux-host-a',instance:{profile:'default'},durableDelivery:{directory,scope}};
  const first=deliveryLocation(config,path.join(os.tmpdir(),'runtime-a','config.json'));
  const second=deliveryLocation(config,path.join(os.tmpdir(),'runtime-b','config.json'));
  assert.equal(first.scope,scope);
  assert.equal(second.scope,scope);
  assert.equal(first.directory,path.resolve(directory));
  assert.equal(second.directory,path.resolve(directory));
  assert.notEqual(first.legacyScope,second.legacyScope);
});

test('identity-safe compaction preserves unread state and exact artifact bytes across restart',()=>{
  const f=fixture();
  try{
    let store=f.open();
    const result={text:'compressible-'.repeat(12000),nested:{ok:true}};
    const artifact=store.writeArtifact(result);
    const item=store.publish({eventKey:'tool:compact-one:final',correlationId:'chat-compact',source:'tool',sourceId:'compact-one',kind:'COMPLETED',artifact});
    const before=store.get(item.deliveryId,'chat-compact');
    const beforeRow=store.db.prepare('SELECT * FROM deliveries WHERE scope=? AND id=?').get(store.scope,item.deliveryId);
    const outcome=store.compact({minAgeMs:0,limit:10});
    assert.equal(outcome.archived,1);
    assert.equal(outcome.logicalStateChanged,false);
    assert.equal(outcome.acknowledgementSynthesized,false);
    assert.ok(outcome.reclaimedBytes>0);
    const after=store.get(item.deliveryId,'chat-compact');
    const afterRow=store.db.prepare('SELECT * FROM deliveries WHERE scope=? AND id=?').get(store.scope,item.deliveryId);
    assert.deepEqual(afterRow,beforeRow,'compaction must not mutate any delivery database column');
    assert.equal(after.state,'COMPLETED_UNDELIVERED');
    assert.equal(after.attemptId,before.attemptId);
    assert.equal(after.receiptId,before.receiptId);
    assert.equal(after.correlationId,'chat-compact');
    const paths=store.artifactPaths(artifact.id);
    assert.equal(fs.existsSync(paths.plain),false);
    assert.equal(fs.existsSync(paths.archive),true);
    store.close();

    store=f.open();
    let offset=0; const chunks=[];
    while(offset!==null){
      const chunk=store.readArtifact({deliveryId:item.deliveryId,correlationId:'chat-compact',offset,maxBytes:4096});
      chunks.push(Buffer.from(chunk.data,'base64')); offset=chunk.nextOffset;
      assert.equal(chunk.archived,true);
    }
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')),result);
    assert.equal(store.get(item.deliveryId,'chat-compact').state,'COMPLETED_UNDELIVERED');
    assert.equal(store.compact({minAgeMs:0,limit:10}).alreadyArchived,1);
    store.close();
  } finally { f.dispose(); }
});

test('repeated bounded compaction advances past already archived artifacts',()=>{
  const f=fixture(); const store=f.open();
  try{
    const artifacts=[];
    for(let i=0;i<3;i++){
      const artifact=store.writeArtifact({index:i,text:String(i).repeat(20000)});
      artifacts.push(artifact);
      store.publish({eventKey:'tool:progress-'+i+':final',correlationId:'chat-progress',source:'tool',sourceId:'progress-'+i,kind:'COMPLETED',artifact});
    }
    const first=store.compact({minAgeMs:0,limit:1});
    const second=store.compact({minAgeMs:0,limit:1});
    const third=store.compact({minAgeMs:0,limit:1});
    assert.equal(first.archived,1);
    assert.equal(second.archived,1);
    assert.equal(third.archived,1);
    assert.equal(store.health().storage.plainArtifacts,0);
    assert.equal(store.health().storage.archivedArtifacts,3);
    assert.equal(store.health().pending,3);
  } finally { store.close(); f.dispose(); }
});

test('compaction excludes pending, unresolved and dead-letter deliveries without synthesizing ack',()=>{
  const f=fixture(); const store=f.open();
  try{
    const completedArtifact=store.writeArtifact({kind:'eligible',text:'x'.repeat(20000)});
    const eligible=store.publish({eventKey:'tool:eligible:final',correlationId:'chat-a',source:'tool',sourceId:'eligible',kind:'COMPLETED',artifact:completedArtifact});

    const waitingArtifact=store.writeArtifact({kind:'waiting',text:'w'.repeat(20000)});
    const waiting=store.publish({eventKey:'tool:waiting:final',correlationId:'chat-a',source:'tool',sourceId:'waiting',kind:'WAITING_INPUT',artifact:waitingArtifact});

    const pendingArtifact=store.writeArtifact({kind:'pending',text:'p'.repeat(20000)});
    const pending=store.publish({eventKey:'tool:pending:final',correlationId:'chat-a',source:'tool',sourceId:'pending',kind:'COMPLETED',artifact:pendingArtifact});
    store.claim({deliveryId:pending.deliveryId,correlationId:'chat-a',attemptId:'attempt-live',leaseMs:60000});

    const deadArtifact=store.writeArtifact({kind:'dead',text:'d'.repeat(20000)});
    const dead=store.publish({eventKey:'tool:dead:final',correlationId:'chat-a',source:'tool',sourceId:'dead',kind:'COMPLETED',artifact:deadArtifact});
    store.db.prepare("UPDATE deliveries SET state='DEAD_LETTER' WHERE scope=? AND id=?").run(store.scope,dead.deliveryId);

    const result=store.compact({minAgeMs:0,limit:20});
    assert.equal(result.archived,1);
    assert.equal(store.get(eligible.deliveryId,'chat-a').state,'COMPLETED_UNDELIVERED');
    assert.equal(store.get(waiting.deliveryId,'chat-a').state,'COMPLETED_UNDELIVERED');
    assert.equal(store.get(pending.deliveryId,'chat-a').state,'DELIVERY_PENDING');
    assert.equal(store.get(dead.deliveryId,'chat-a').state,'DEAD_LETTER');
    assert.equal(fs.existsSync(store.artifactPaths(completedArtifact.id).archive),true);
    assert.equal(fs.existsSync(store.artifactPaths(waitingArtifact.id).plain),true);
    assert.equal(fs.existsSync(store.artifactPaths(pendingArtifact.id).plain),true);
    assert.equal(fs.existsSync(store.artifactPaths(deadArtifact.id).plain),true);
    assert.equal(store.health().storage.oldestPendingCreatedAt!==null,true);
  } finally { store.close(); f.dispose(); }
});

test('archived artifact is deduplicated by content hash and remains profile scoped',()=>{
  const f=fixture();
  try{
    let store=f.open();
    const payload={same:'z'.repeat(50000)};
    const artifact=store.writeArtifact(payload);
    const first=store.publish({eventKey:'tool:shared-one:final',correlationId:'chat-a',source:'tool',sourceId:'shared-one',kind:'COMPLETED',artifact});
    const second=store.publish({eventKey:'tool:shared-two:final',correlationId:'chat-b',source:'tool',sourceId:'shared-two',kind:'COMPLETED',artifact});
    const result=store.compact({minAgeMs:0,limit:20});
    assert.equal(result.archived,1);
    assert.equal(result.scanned,1);
    assert.throws(()=>store.readArtifact({deliveryId:first.deliveryId,correlationId:'chat-b'}),/DELIVERY_CORRELATION_MISMATCH/);
    assert.equal(store.get(second.deliveryId,'chat-b').artifact.sha256,artifact.sha256);
    store.close();

    const other=new DeliveryStore({directory:f.directory,scope:'profile-b'});
    assert.equal(other.health().pending,0);
    assert.equal(other.health().storage.archivedArtifacts,0);
    other.close();
  } finally { f.dispose(); }
});


test('delivery compaction tool is additive and explicitly non-acknowledging',async()=>{
  const {deliveryToolDefinitions}=await import('../src/delivery-tools.mjs');
  const tool=deliveryToolDefinitions.find(x=>x.name==='delivery_compact');
  assert.ok(tool);
  assert.equal(tool.annotations.idempotentHint,true);
  assert.equal(tool.annotations.destructiveHint,false);
  assert.equal(tool.inputSchema.additionalProperties,false);
  assert.match(tool.description,/without acknowledging/i);
});


test('internal transport receipts are reclassified without deleting artifacts or acknowledging user delivery',()=>{
  const f=fixture(); const store=f.open();
  try{
    const transport='transport-'+'a'.repeat(64);
    const transportArtifact=store.writeArtifact({tool:'copy_path',status:'SUCCEEDED',marker:'transport'});
    const internal=store.publish({
      eventKey:'operation:11111111-1111-4111-8111-111111111111:SUCCEEDED',
      correlationId:transport,source:'operation',sourceId:'11111111-1111-4111-8111-111111111111',
      kind:'COMPLETED',artifact:transportArtifact
    });
    const explicitArtifact=store.writeArtifact({tool:'copy_path',status:'SUCCEEDED',marker:'explicit'});
    const explicit=store.publish({
      eventKey:'operation:22222222-2222-4222-8222-222222222222:SUCCEEDED',
      correlationId:'chat-explicit',source:'operation',sourceId:'22222222-2222-4222-8222-222222222222',
      kind:'COMPLETED',artifact:explicitArtifact
    });
    const claimedArtifact=store.writeArtifact({tool:'delete_path',status:'SUCCEEDED',marker:'claimed'});
    const claimed=store.publish({
      eventKey:'operation:33333333-3333-4333-8333-333333333333:SUCCEEDED',
      correlationId:'transport-'+'b'.repeat(64),source:'operation',sourceId:'33333333-3333-4333-8333-333333333333',
      kind:'COMPLETED',artifact:claimedArtifact
    });
    store.claim({deliveryId:claimed.deliveryId,correlationId:'transport-'+'b'.repeat(64),attemptId:'attempt-live',leaseMs:60000});

    const before=store.health();
    assert.equal(before.pending,3);
    const result=store.reclassifyTransportReceipts({limit:100});
    assert.equal(result.reclassified,1);
    assert.equal(result.acknowledgementSynthesized,false);
    assert.equal(result.artifactsDeleted,0);
    assert.equal(result.pendingAfter,2);

    const after=store.health();
    assert.equal(after.pending,2);
    assert.equal(after.transportReceipts,1);
    assert.equal(store.get(internal.deliveryId,transport).state,'TRANSPORT_RECEIPT');
    assert.equal(store.get(explicit.deliveryId,'chat-explicit').state,'COMPLETED_UNDELIVERED');
    assert.equal(store.get(claimed.deliveryId,'transport-'+'b'.repeat(64)).state,'DELIVERY_PENDING');
    assert.equal(store.list({correlationId:transport}).items.length,0);
    assert.equal(store.list({correlationId:transport,includeDelivered:true}).items[0].state,'TRANSPORT_RECEIPT');
    assert.equal(store.claim({deliveryId:internal.deliveryId,correlationId:transport,attemptId:'attempt-after'}).transportReceipt,true);
    const chunk=store.readArtifact({deliveryId:internal.deliveryId,correlationId:transport,maxBytes:16384});
    assert.equal(JSON.parse(Buffer.from(chunk.data,'base64').toString('utf8')).marker,'transport');
    assert.equal(store.beacon(10).items.some(x=>x.deliveryId===internal.deliveryId),false);

    const repeat=store.reclassifyTransportReceipts({limit:100});
    assert.equal(repeat.reclassified,0);
    assert.equal(repeat.pendingAfter,2);
  } finally { store.close(); f.dispose(); }
});

test('transport-receipt repair tool is bounded and explicitly non-acknowledging',async()=>{
  const {deliveryToolDefinitions}=await import('../src/delivery-tools.mjs');
  const tool=deliveryToolDefinitions.find(x=>x.name==='delivery_reclassify_transport_receipts');
  assert.ok(tool);
  assert.equal(tool.annotations.idempotentHint,true);
  assert.equal(tool.annotations.destructiveHint,false);
  assert.equal(tool.inputSchema.properties.limit.maximum,10000);
  assert.equal(tool.inputSchema.additionalProperties,false);
  assert.match(tool.description,/Does not delete artifacts or synthesize user acknowledgement/i);
});


test('delivery health breakdown is read-only and separates unattempted results by kind/source',()=>{
  const f=fixture();const store=f.open();
  try{
    const completed=store.publish({eventKey:'operation:classify-ok',correlationId:'chat-qa',
      source:'operation',sourceId:'qa1',kind:'COMPLETED'});
    const failed=store.publish({eventKey:'operation:classify-failed',correlationId:'chat-qa',
      source:'operation',sourceId:'qa2',kind:'FAILED'});
    store.publish({eventKey:'project:classify-blocked',correlationId:'project-qa',
      source:'project',sourceId:'qa3',kind:'BLOCKED'});
    const first=store.health();
    assert.equal(first.pending,3);
    assert.deepEqual(first.pendingBreakdown, {
      byKind:{BLOCKED:1,COMPLETED:1,FAILED:1},
      bySource:{operation:2,project:1},
      attempted:0
    });
    assert.equal(store.get(completed.deliveryId,'chat-qa').state,'COMPLETED_UNDELIVERED');
    assert.equal(store.get(failed.deliveryId,'chat-qa').state,'COMPLETED_UNDELIVERED');
    const claim=store.claim({deliveryId:completed.deliveryId,correlationId:'chat-qa',
      attemptId:'qa-read-one',leaseMs:1000});
    assert.equal(claim.claimed,true);
    const second=store.health();
    assert.equal(second.pending,3);
    assert.equal(second.pendingBreakdown.attempted,1);
    assert.equal(second.pendingBreakdown.byKind.COMPLETED,1);
    assert.equal(store.get(completed.deliveryId,'chat-qa').state,'DELIVERY_PENDING');
  } finally {store.close();f.dispose();}
});
