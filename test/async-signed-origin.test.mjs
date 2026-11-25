import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,createHmac,createHash,timingSafeEqual} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile,writeFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {DeliveryStore,stableJson} from '../src/delivery-store.mjs';
import {createAuthenticatedDeliveryTools} from '../src/delivery-authenticated.mjs';
import {createTrustedDeliveryOriginPublisher} from '../src/delivery-origin-publisher.mjs';
import {createAsyncOperationTools} from '../src/async-operations.mjs';

const fixture=path.join(path.dirname(fileURLToPath(import.meta.url)),
  'async-operation-fixture.mjs');
const worker=fileURLToPath(new URL('../tools/operation-worker.mjs',import.meta.url));
const bindingId='a'.repeat(32);
const workerIdentity=Object.freeze({workerId:'cw_'+'c'.repeat(64),workerKeyId:'d'.repeat(64),workerGrantRevision:7});
const caller=Object.freeze({
  hostId:'host1',principalId:'principal1',profileId:'profile1',conversationId:'chat1'
});
const digest=obj=>createHash('sha256').update(stableJson(obj)).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const boundedTestWait=async(promise,code,ms=6000)=>{
  let timeout;
  try{
    return await Promise.race([promise,new Promise((_,reject)=>{
      timeout=setTimeout(()=>reject(new Error(code)),ms);
    })]);
  }finally{if(timeout)clearTimeout(timeout);}
};

async function setup(){
  const root=await mkdtemp(path.join(os.tmpdir(),'v106-signed-operation-'));
  const store=new DeliveryStore({directory:path.join(root,'delivery'),scope:'scope1'});
  const key=randomBytes(32),issued=new Map(),admissions=new Map(),
    nativeReceipts=new Map();
  const ctx={originAllowed:true,correlationId:'origin-route',bindingId,issueCount:0,admissionCount:0,
    received:[],captured:[],calls:0,nativeHandoff:null};
  const sign=obj=>createHmac('sha256',key).update(stableJson(obj)).digest('hex');
  const verifier=async({receiptId,eventDigest,sourceId})=>{
    ctx.calls++;
    const row=issued.get(receiptId);
    if(!row||row.value.eventDigest!==eventDigest||row.value.sourceId!==sourceId)
      return null;
    const expected=sign(row.value),actual=row.signature;
    if(expected.length!==actual.length
      ||!timingSafeEqual(Buffer.from(expected),Buffer.from(actual)))return null;
    return {verified:true,source:'HOST_SIGNED_ORIGINAL_EXECUTION',...row.value};
  };
  const publisher=createTrustedDeliveryOriginPublisher({
    store,verifyExecutionReceipt:verifier
  });
  const protectedDeliveryOrigin={
    publisher,
    dispatchHandoff:async (request,payload)=>{
      // Test-only native boundary: refuse final dispatch unless the original
      // owner grant is still active at the actual send operation.
      const admitted=admissions.get(request.originAdmissionId);
      if(!admitted || !ctx.originAllowed || admitted.bindingId!==ctx.bindingId
        || admitted.correlationId!==ctx.correlationId
        || admitted.operationId!==request.operationId)
        throw new Error('NATIVE_HANDOFF_OWNER_GRANT_REVOKED');
      ctx.captured.push({request,payload});
      const response=ctx.nativeHandoff
        ? await ctx.nativeHandoff(request,payload)
        : {handoffId:'native-trusted-handoff',state:'QUEUED',
            handoffKey:request.handoffKey,deliveryId:request.deliveryId,
            originAdmissionId:request.originAdmissionId};
      if(response && typeof response==='object'
        && typeof response.handoffId==='string'
        && response.handoffKey===request.handoffKey
        && response.deliveryId===request.deliveryId
        && response.originAdmissionId===request.originAdmissionId){
        const receipt=Object.freeze({
          handoffId:response.handoffId,state:response.state,
          handoffKey:response.handoffKey,deliveryId:response.deliveryId,
          originAdmissionId:response.originAdmissionId
        });
        nativeReceipts.set(request.handoffKey,{
          receipt,signature:sign(receipt)
        });
      }
      return response;
    },
    verifyHandoffReceipt:async (request,receipt)=>{
      // Synthetic Host source of truth, separate from user-writable operation
      // projections. The production Host must supply an equivalent independent
      // issuer/queue-backed verification, not trust the local ledger.
      const record=nativeReceipts.get(request.handoffKey);
      if(!record || record.receipt.handoffId!==receipt.handoffId
        || record.receipt.state!==receipt.state
        || record.receipt.deliveryId!==receipt.deliveryId
        || record.receipt.originAdmissionId!==receipt.originAdmissionId
        || record.receipt.handoffKey!==receipt.handoffKey) return false;
      const expected=sign(receipt);
      return expected.length===record.signature.length
        &&timingSafeEqual(Buffer.from(expected),Buffer.from(record.signature));
    },
    authorizeHandoff:async request=>{
      const old=admissions.get(request.originAdmissionId);
      if(!old||!ctx.originAllowed||old.operationId!==request.operationId
        ||old.requestId!==request.requestId||old.inputHash!==request.inputHash
        ||old.correlationId!==request.correlationId
        ||old.bindingId!==ctx.bindingId||old.correlationId!==ctx.correlationId
        ||typeof request.continuationHash!=='string'
        ||!/^[a-f0-9]{64}$/.test(request.continuationHash)) return false;
      const result=store.get(request.deliveryId,request.correlationId);
      return result.bindingEpochHash===createHash('sha256').update(old.bindingId).digest('hex')
        &&typeof result.originReceiptHash==='string';
    },
    authorizeAccess:async request=>{
      const old=admissions.get(request.originAdmissionId);
      return Boolean(old&&ctx.originAllowed
        &&['operation_status','operation_result','operation_cancel'].includes(request.name)
        &&old.operationId===request.operationId
        &&old.requestId===request.requestId
        &&old.inputHash===request.inputHash
        &&old.correlationId===request.correlationId
        &&old.correlationId===ctx.correlationId
        &&old.bindingId===ctx.bindingId);
    },
    authorizeReplay:async request=>{
      const old=admissions.get(request.originAdmissionId);
      return Boolean(old&&ctx.originAllowed
        &&old.operationId===request.operationId
        &&old.requestId===request.requestId
        &&old.inputHash===request.inputHash
        &&old.correlationId===request.correlationId
        &&old.correlationId===ctx.correlationId
        &&old.bindingId===ctx.bindingId);
    },
    admitOperation:async request=>{
      if(!ctx.originAllowed||request.correlationId!==ctx.correlationId)
        throw new Error('HOST_ORIGINAL_CHAT_ATTESTATION_REQUIRED');
      const admissionId='admit:'+request.operationId;
      // This test-only native signer persists the authenticated caller and
      // OWNER epoch before the worker can start; never derive it at terminal.
      admissions.set(admissionId,Object.freeze({
        ...request,...caller,bindingId:ctx.bindingId
      }));
      ctx.admissionCount++;
      return admissionId;
    },
    receiptForTerminal:async request=>{
      ctx.received.push(request);
      const admitted=admissions.get(request.originAdmissionId);
      if(!admitted||admitted.operationId!==request.operationId
        ||admitted.inputHash!==request.inputHash
        ||admitted.correlationId!==request.correlationId
        ||admitted.tool!==request.tool)
        throw new Error('HOST_ORIGINAL_ADMISSION_MISMATCH');
      const original={
        receiptId:'receipt:'+request.operationId,
        eventDigest:digest(request.event),sourceId:request.operationId,
        inputHash:admitted.inputHash,...caller,correlationId:admitted.correlationId,
        bindingId:admitted.bindingId,originAdmissionId:request.originAdmissionId,
        ...workerIdentity
      };
      issued.set(original.receiptId,{value:original,signature:sign(original)});
      ctx.issueCount++;
      return original.receiptId;
    }
  };
  const config={instance:{profile:'test'},
    asyncOperations:{enabled:true,stateDir:path.join(root,'operations'),maxOutputBytes:65536}};
  const prepare=async(_tool,args)=>({
    file:process.execPath,args:[fixture,...args.argv],cwd:root,
    timeoutMs:5000,outputLimit:65536
  });
  const makeManager=(protectedOrigin=protectedDeliveryOrigin,customPrepare=prepare,customValidator=null,onTerminal=null)=>createAsyncOperationTools({
    config,prepare:customPrepare,validateContinuation:customValidator,onTerminal,
    workerPath:worker,deliveryStore:store,protectedDeliveryOrigin:protectedOrigin
  });
  const protectedDelivery=createAuthenticatedDeliveryTools({
    store,observeCaller:async()=>caller,
    resolveBinding:async()=>({...caller,correlationId:ctx.correlationId,bindingId:ctx.bindingId}),
    authorizeDelivery:async()=>true,
    attestPresentation:async request=>({...request,verified:true,presentationId:'signed-host-present1'})
  });
  async function waitFor(manager,operationId,timeoutMs=12000){
    const end=Date.now()+timeoutMs;
    while(Date.now()<end){
      const state=await manager.execute('operation_status',{operationId});
      if(['SUCCEEDED','FAILED','CANCELLED','UNCERTAIN'].includes(state.status)
        &&(state.deliveryId||state.deliveryPending))return state;
      await sleep(45);
    }
    throw new Error('signed-origin-fixture-terminal-timeout');
  }
  const cleanup=async(...managers)=>{
    for(const manager of managers){try{await manager?.close();}catch{}}
    store.close();await rm(root,{recursive:true,force:true,maxRetries:15,retryDelay:50});
  };
  return {root,store,ctx,config,makeManager,protectedDelivery,protectedDeliveryOrigin,waitFor,cleanup,
    issued,sign};
}

test('protected async origin adapter requires two trusted callbacks and durable store',()=>{
  const config={asyncOperations:{enabled:true}};
  assert.throws(()=>createAsyncOperationTools({config,
    protectedDeliveryOrigin:{publisher:{publish(){}}}}),
    /ASYNC_DELIVERY_SIGNED_ORIGIN_HOST_REQUIRED/);
});

test('explicit original-chat signing requirement fails closed without trusted Host bootstrap',async()=>{
  const f=await setup();let native=null,legacy=null;
  try{
    const strictConfig={
      ...f.config,
      asyncOperations:{...f.config.asyncOperations,requireHostSignedOrigin:true}
    };
    assert.throws(()=>createAsyncOperationTools({
      config:strictConfig,deliveryStore:f.store,
      onTerminal:async()=>({handoffId:'legacy-callback'})
    }),/ASYNC_DELIVERY_SIGNED_ORIGIN_HOST_REQUIRED/);
    native=createAsyncOperationTools({
      config:strictConfig,deliveryStore:f.store,
      protectedDeliveryOrigin:f.protectedDeliveryOrigin
    });
    assert.deepEqual(native.status().originHostIntegration,{
      required:true,callbacksConfigured:true,
      trustBoundary:'HOST_CALLBACKS_NOT_PROOF_OF_CHAT_ACK',
      originatingChatAckVerified:false
    });
    legacy=f.makeManager(null);
    assert.deepEqual(legacy.status().originHostIntegration,{
      required:false,callbacksConfigured:false,
      trustBoundary:'LEGACY_PROFILE_NOT_AUTHENTICATED_CHAT',
      originatingChatAckVerified:false
    });
    assert.equal(f.ctx.admissionCount,0);
    assert.equal(f.store.health().pending,0);
  }finally{await f.cleanup(native,legacy);}
});

test('native-signed terminal result is durable, epoch bound and restart-idempotent',async()=>{
  const f=await setup();let manager=null;
  try{
    manager=f.makeManager();
    const effect=path.join(f.root,'effect.txt');
    const input={requestId:'signed-start-1',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['effect',effect,'80']}};
    const started=await manager.execute('operation_start',input);
    const result=await f.waitFor(manager,started.operationId);
    assert.equal(result.status,'SUCCEEDED');
    assert.equal(result.deliveryPending,undefined);
    assert.equal(f.ctx.received.length>=1,true);
    const rows=await f.protectedDelivery.execute('delivery_list',{limit:5});
    assert.equal(rows.items.length,1);
    const item=rows.items[0];
    assert.equal(item.deliveryId,result.deliveryId);
    assert.equal(item.bindingEpochHash,createHash('sha256').update(bindingId).digest('hex'));
    assert.equal(item.originReceiptHash?.length,64);
    assert.equal(await readFile(effect,'utf8'),'x');
    await manager.close();manager=null;
    manager=f.makeManager();
    const retried=await manager.execute('operation_start',input);
    assert.equal(retried.duplicate,true);
    assert.equal(retried.operationId,started.operationId);
    assert.equal(f.ctx.admissionCount,1);
    const backfill=await manager.reconcileDeliveries(10);
    assert.equal(backfill.pending>=0,true);
    const reloaded=(await f.protectedDelivery.execute('delivery_list',{limit:5})).items;
    assert.equal(reloaded.length,1);
    assert.equal(reloaded[0].deliveryId,item.deliveryId);
    assert.equal(await readFile(effect,'utf8'),'x');
    await f.protectedDelivery.execute('delivery_claim',{
      deliveryId:item.deliveryId,attemptId:'claim-native1'
    });
    const ack=await f.protectedDelivery.execute('delivery_ack',{
      deliveryId:item.deliveryId,attemptId:'claim-native1'
    });
    assert.equal(ack.state,'DELIVERED');
    const repeated=await f.protectedDelivery.execute('delivery_ack',{
      deliveryId:item.deliveryId,attemptId:'claim-native1'
    });
    assert.equal(repeated.receiptId,ack.receiptId);
  }finally{await f.cleanup(manager);}
});

test('wrong-chat operation cannot publish a protected result or fall back to legacy',async()=>{
  const f=await setup();let manager=null;
  try{
    manager=f.makeManager();
    await assert.rejects(()=>manager.execute('operation_start',{
      requestId:'wrong-chat-request',correlationId:'forged-route',
      tool:'run_project_command',arguments:{argv:['sleep','30','ok']}
    }),/HOST_ORIGINAL_CHAT_ATTESTATION_REQUIRED/);
    assert.equal(f.ctx.admissionCount,0);
    assert.equal(f.store.health().pending,0);
    assert.deepEqual((await f.protectedDelivery.execute('delivery_list',{})).items,[]);
  }finally{await f.cleanup(manager);}
});

test('missing original issuer authentication never promotes terminal to trusted delivery',async()=>{
  const f=await setup();let manager=null;
  try{
    f.ctx.originAllowed=false;
    manager=f.makeManager();
    await assert.rejects(()=>manager.execute('operation_start',{
      requestId:'no-origin-attestation',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','30','ok']}
    }),/HOST_ORIGINAL_CHAT_ATTESTATION_REQUIRED/);
    assert.equal(f.ctx.admissionCount,0);
    assert.equal(f.store.health().pending,0);
    assert.equal(f.ctx.issueCount,0);
  }finally{await f.cleanup(manager);}
});

test('caller-supplied owner binding has no effect on the host-signed epoch',async()=>{
  const f=await setup();let manager=null;
  try{
    manager=f.makeManager();
    const started=await manager.execute('operation_start',{
      requestId:'forged-consent-claim',correlationId:'origin-route',
      bindingId:'c'.repeat(32),principalId:'forged',
      tool:'run_project_command',arguments:{argv:['sleep','35','ok']}
    });
    const terminal=await f.waitFor(manager,started.operationId);
    assert.equal(terminal.status,'SUCCEEDED');
    const rows=(await f.protectedDelivery.execute('delivery_list',{})).items;
    assert.equal(rows.length,1);
    assert.equal(rows[0].bindingEpochHash,createHash('sha256').update(bindingId).digest('hex'));
    f.ctx.bindingId='c'.repeat(32);
    assert.deepEqual((await f.protectedDelivery.execute('delivery_list',{})).items,[]);
    assert.equal(f.store.get(terminal.deliveryId,'origin-route').receiptId,null);
  }finally{await f.cleanup(manager);}
});

test('owner revocation after admission cannot rebind old result to new consent epoch',async()=>{
  const f=await setup();let manager=null;
  try{
    manager=f.makeManager();
    const effect=path.join(f.root,'owner-change-effect.txt');
    const started=await manager.execute('operation_start',{
      requestId:'admit-before-regrant',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['effect',effect,'180']}
    });
    assert.equal(f.ctx.admissionCount,1);
    f.ctx.bindingId='c'.repeat(32);
    // The public status endpoint must now DENY this regranted caller;
    // only the host-internal reconciler may complete the original receipt.
    await assert.rejects(()=>manager.execute('operation_status',{
      operationId:started.operationId
    }),/ASYNC_DELIVERY_SIGNED_ORIGIN_ACCESS_DENIED/);
    let old=null;
    for(let i=0;i<100;i++){
      await manager.reconcileDeliveries(10);
      old=f.store.list({correlationId:'origin-route',includeDelivered:true}).items[0]??null;
      if(old)break;
      await sleep(50);
    }
    assert.ok(old,'internal host reconciliation must preserve original result');
    assert.equal(await readFile(effect,'utf8'),'x');
    assert.equal(old.bindingEpochHash,createHash('sha256').update(bindingId).digest('hex'));
    assert.deepEqual((await f.protectedDelivery.execute('delivery_list',{})).items,[]);
    assert.equal(old.receiptId,null);
  }finally{await f.cleanup(manager);}
});

test('reconstructed terminal state preserves original admission rather than promoting a legacy request',async()=>{
  const f=await setup();let manager=null;
  try{
    manager=f.makeManager();
    const started=await manager.execute('operation_start',{
      requestId:'admission-survives-restart',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','120','persist']}
    });
    const terminal=await f.waitFor(manager,started.operationId);
    assert.equal(terminal.status,'SUCCEEDED');
    const row=f.store.get(terminal.deliveryId,'origin-route');
    assert.equal(row.bindingEpochHash,createHash('sha256').update(bindingId).digest('hex'));
    assert.equal(f.ctx.admissionCount,1);
    await manager.close();manager=null;
    manager=f.makeManager();
    const recovered=await manager.execute('operation_status',{operationId:started.operationId});
    assert.equal(recovered.deliveryId,terminal.deliveryId);
    assert.equal(f.ctx.admissionCount,1);
    assert.equal(f.store.health().pending,1);
  }finally{await f.cleanup(manager);}
});

test('requestId replay after owner regrant is denied before result metadata is revealed',async()=>{
  const f=await setup();let manager=null;
  try{
    manager=f.makeManager();
    const effect=path.join(f.root,'replay-epoch-effect.txt');
    const input={requestId:'stale-signed-request',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['effect',effect,'30']}};
    const first=await manager.execute('operation_start',input);
    await f.waitFor(manager,first.operationId);
    assert.equal(await readFile(effect,'utf8'),'x');
    f.ctx.bindingId='c'.repeat(32);
    await assert.rejects(()=>manager.execute('operation_start',input),
      /ASYNC_DELIVERY_SIGNED_ORIGIN_REPLAY_DENIED/);
    assert.equal(f.ctx.admissionCount,1);
    assert.equal(await readFile(effect,'utf8'),'x');
  }finally{await f.cleanup(manager);}
});

test('source-only protected adapter refuses missing replay verifier',async()=>{
  const f=await setup();let manager=null;
  try{
    const missingReplay={...f.protectedDelivery,origin:'not-used'};
    assert.throws(()=>createAsyncOperationTools({
      config:{asyncOperations:{enabled:true}},
      protectedDeliveryOrigin:missingReplay
    }),/ASYNC_DELIVERY_SIGNED_ORIGIN_HOST_REQUIRED/);
  }finally{await f.cleanup(manager);}
});

test('corrupted worker state recovers original signed admission from durable request',async()=>{
  const f=await setup();let manager=null;
  try{
    manager=f.makeManager();
    const input={requestId:'recovery-original-admission',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','100','ok']}};
    const started=await manager.execute('operation_start',input);
    const original=await f.waitFor(manager,started.operationId);
    assert.equal(original.status,'SUCCEEDED');
    assert.equal(f.ctx.admissionCount,1);
    await manager.close();manager=null;
    const statePath=path.join(f.root,'operations','operations',started.operationId,'state.json');
    const previous=await readFile(statePath);
    await writeFile(statePath,Buffer.alloc(previous.length));
    manager=f.makeManager();
    const recovered=await manager.execute('operation_status',{operationId:started.operationId});
    assert.equal(recovered.status,'SUCCEEDED');
    assert.equal(recovered.recoveredFromCorruptProjection,true);
    assert.equal(recovered.deliveryId,original.deliveryId);
    assert.equal(f.ctx.admissionCount,1);
    assert.equal((await f.protectedDelivery.execute('delivery_list',{})).items.length,1);
  }finally{await f.cleanup(manager);}
});

test('invalid native admission identifier denies execution before external effects',async()=>{
  const f=await setup();let manager=null;
  try{
    const local={...f.protectedDeliveryOrigin,admitOperation:async()=> 'invalid space'};
    manager=f.makeManager(local);
    const effect=path.join(f.root,'invalid-admission-effect.txt');
    await assert.rejects(()=>manager.execute('operation_start',{
      requestId:'invalid-admission-ref',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['effect',effect,'30']}
    }),/ASYNC_DELIVERY_SIGNED_ORIGIN_ADMISSION_REQUIRED/);
    await assert.rejects(()=>readFile(effect,'utf8'),{code:'ENOENT'});
    assert.equal(f.store.health().pending,0);
  }finally{await f.cleanup(manager);}
});

test('public operation result and status require the original owner admission, not UUID knowledge',async()=>{
  const f=await setup();let manager=null;
  try{
    manager=f.makeManager();
    const start=await manager.execute('operation_start',{
      requestId:'private-result-access',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','70','private-output']}
    });
    await f.waitFor(manager,start.operationId);
    const result=await manager.execute('operation_result',{
      operationId:start.operationId,tailBytes:100
    });
    assert.match(result.stdoutTail,/private-output/);
    f.ctx.bindingId='c'.repeat(32);
    for(const name of ['operation_status','operation_result','operation_cancel']){
      await assert.rejects(()=>manager.execute(name,{
        operationId:start.operationId
      }),/ASYNC_DELIVERY_SIGNED_ORIGIN_ACCESS_DENIED/);
    }
    const records=f.store.list({correlationId:'origin-route',includeDelivered:true}).items;
    assert.equal(records.length,1);
    assert.equal(records[0].receiptId,null);
  }finally{await f.cleanup(manager);}
});

test('revocation during an awaited status read fails before returning the result',async()=>{
  const f=await setup();let manager=null;
  try{
    let calls=0;
    const original=f.protectedDeliveryOrigin.authorizeAccess;
    const scoped={...f.protectedDeliveryOrigin,
      authorizeAccess:async request=>{
        if(++calls===2)f.ctx.bindingId='c'.repeat(32);
        return original(request);
      }
    };
    manager=f.makeManager(scoped);
    const started=await manager.execute('operation_start',{
      requestId:'status-regrant-race',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','100','ok']}
    });
    await assert.rejects(()=>manager.execute('operation_status',{
      operationId:started.operationId,waitMs:500
    }),/ASYNC_DELIVERY_SIGNED_ORIGIN_ACCESS_DENIED/);
  }finally{await f.cleanup(manager);}
});

test('protected adapter refuses host without original admission access authorization',async()=>{
  const f=await setup();
  try{
    const missing={...f.protectedDeliveryOrigin};
    delete missing.authorizeAccess;
    assert.throws(()=>f.makeManager(missing),
      /ASYNC_DELIVERY_SIGNED_ORIGIN_HOST_REQUIRED/);
  }finally{await f.cleanup();}
});

test('terminal cancel response reattests after native status read',async()=>{
  const f=await setup();let manager=null;
  try{
    let calls=0;
    const authorize=f.protectedDeliveryOrigin.authorizeAccess;
    const origin={...f.protectedDeliveryOrigin,
      authorizeAccess:async req=>{
        if(++calls===2)f.ctx.bindingId='c'.repeat(32);
        return authorize(req);
      }
    };
    manager=f.makeManager(origin);
    const started=await manager.execute('operation_start',{
      requestId:'cancel-terminal-change',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','50','ok']}
    });
    let ready=false;
    for(let i=0;i<100;i++){
      await manager.reconcileDeliveries(10);
      ready=f.store.list({correlationId:'origin-route'}).items.length===1;
      if(ready)break;
      await sleep(50);
    }
    assert.equal(ready,true,'fixture must be terminal before cancel request');
    await assert.rejects(()=>manager.execute('operation_cancel',{
      operationId:started.operationId
    }),/ASYNC_DELIVERY_SIGNED_ORIGIN_ACCESS_DENIED/);
    assert.equal(calls,2);
  }finally{await f.cleanup(manager);}
});

test('revoked native admission just before spawn records FAILED without running worker',async()=>{
  const f=await setup();let manager=null;
  try{
    const original=f.protectedDeliveryOrigin.authorizeReplay;
    let checked=0;
    const origin={...f.protectedDeliveryOrigin,
      authorizeReplay:async request=>{
        checked++;
        const before=await original(request);
        if(checked===2)f.ctx.originAllowed=false;
        return before&&f.ctx.originAllowed;
      }
    };
    manager=f.makeManager(origin);
    const effect=path.join(f.root,'must-not-execute.txt');
    await assert.rejects(()=>manager.execute('operation_start',{
      requestId:'deny-before-worker',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['effect',effect,'40']}
    }),/ASYNC_DELIVERY_SIGNED_ORIGIN_ADMISSION_REVOKED/);
    assert.equal(checked,2);
    assert.equal(f.ctx.admissionCount,1);
    await assert.rejects(()=>readFile(effect,'utf8'),{code:'ENOENT'});
    const dirs=await readdir(path.join(f.root,'operations','operations'));
    assert.equal(dirs.length,1);
    const state=JSON.parse(await readFile(path.join(
      f.root,'operations','operations',dirs[0],'state.json'),'utf8'));
    assert.equal(state.status,'FAILED');
    assert.equal(state.failureCode,'OWNER_GRANT_REVOKED_BEFORE_EXECUTION');
    assert.equal(state.workerPid,null);
    assert.equal(state.originAdmissionId,'admit:'+state.operationId);
  }finally{await f.cleanup(manager);}
});

test('protected start never calls even preparatory host code before independent admission',async()=>{
  const f=await setup();let manager=null;
  try{
    f.ctx.originAllowed=false;
    let prepared=0;
    manager=f.makeManager(f.protectedDeliveryOrigin,async()=>{
      prepared++;
      return {file:process.execPath,args:['-e','process.exit(0)'],cwd:f.root};
    });
    await assert.rejects(()=>manager.execute('operation_start',{
      requestId:'no-prepare-before-consent',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','10','ok']}
    }),/HOST_ORIGINAL_CHAT_ATTESTATION_REQUIRED/);
    assert.equal(prepared,0,'no preparatory side effects before original owner authorization');
    assert.equal(f.ctx.admissionCount,0);
  }finally{await f.cleanup(manager);}
});

test('protected continuation validator never runs before original chat admission',async()=>{
  const f=await setup();let manager=null;
  try{
    f.ctx.originAllowed=false;
    let touched=0;
    manager=f.makeManager(f.protectedDeliveryOrigin,undefined,async()=>{
      touched++;
    });
    await assert.rejects(()=>manager.execute('operation_start',{
      requestId:'invalid-preauth-continuation',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','10','ok']},
      continuation:{projectId:'p1',eventKey:'op:preauth',root:f.root}
    }),/HOST_ORIGINAL_CHAT_ATTESTATION_REQUIRED/);
    assert.equal(touched,0,'validation callback is trusted Host code and cannot run without owner admission');
  }finally{await f.cleanup(manager);}
});

test('protected duplicate denies revoked chat before continuation callback can run',async()=>{
  const f=await setup();let manager=null;
  try{
    let touched=0;
    manager=f.makeManager(f.protectedDeliveryOrigin,undefined,async()=>{touched++;});
    const input={
      requestId:'continuation-duplicate-revoked',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','50','ok']},
      continuation:{projectId:'p1',eventKey:'op:duplicate',root:f.root}
    };
    const accepted=await manager.execute('operation_start',input);
    await f.waitFor(manager,accepted.operationId);
    assert.equal(touched,1);
    f.ctx.bindingId='c'.repeat(32);
    await assert.rejects(()=>manager.execute('operation_start',input),
      /ASYNC_DELIVERY_SIGNED_ORIGIN_REPLAY_DENIED/);
    assert.equal(touched,1,'revoked retry must not invoke continuation callback');
  }finally{await f.cleanup(manager);}
});

test('new protected operation never enters preparer if continuation validator revokes admission',async()=>{
  const f=await setup();let manager=null;
  try{
    let prepared=0;
    manager=f.makeManager(f.protectedDeliveryOrigin,async()=>{
      prepared++;
      return {file:process.execPath,args:['-e','process.exit(0)'],cwd:f.root};
    },async()=>{f.ctx.bindingId='c'.repeat(32);});
    await assert.rejects(()=>manager.execute('operation_start',{
      requestId:'consent-change-before-preparer',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','10','ok']},
      continuation:{projectId:'p1',eventKey:'op:consent-change',root:f.root}
    }),/ASYNC_DELIVERY_SIGNED_ORIGIN_ADMISSION_REVOKED/);
    assert.equal(prepared,0);
    assert.equal(f.ctx.admissionCount,1);
    assert.equal(f.store.health().pending,0);
  }finally{await f.cleanup(manager);}
});

test('protected duplicate must not disclose status after validator revokes the original grant',async()=>{
  const f=await setup();let manager=null;
  try{
    let checks=0;
    manager=f.makeManager(f.protectedDeliveryOrigin,undefined,async()=>{
      if(++checks===2)f.ctx.bindingId='c'.repeat(32);
    });
    const input={requestId:'replay-revoked-in-validator',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','30','ok']},
      continuation:{projectId:'p1',eventKey:'op:replay-check',root:f.root}};
    const started=await manager.execute('operation_start',input);
    await f.waitFor(manager,started.operationId);
    await assert.rejects(()=>manager.execute('operation_start',input),
      /ASYNC_DELIVERY_SIGNED_ORIGIN_REPLAY_DENIED/);
    assert.equal(checks,2);
    assert.equal(f.ctx.admissionCount,1);
  }finally{await f.cleanup(manager);}
});

test('protected duplicate reattests after status when the first native grant call races with revocation',async()=>{
  const f=await setup();let manager=null;
  try{
    manager=f.makeManager();
    const input={requestId:'retry-race-after-status',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','30','ok']}};
    const accepted=await manager.execute('operation_start',input);
    await f.waitFor(manager,accepted.operationId);
    await manager.close();manager=null;
    const original=f.protectedDeliveryOrigin.authorizeReplay;
    let calls=0;
    const racingOrigin={...f.protectedDeliveryOrigin,
      authorizeReplay:async request=>{
        const initiallyGranted=await original(request);
        if(++calls===1)f.ctx.bindingId='c'.repeat(32);
        return initiallyGranted;
      }
    };
    manager=f.makeManager(racingOrigin);
    await assert.rejects(()=>manager.execute('operation_start',input),
      /ASYNC_DELIVERY_SIGNED_ORIGIN_REPLAY_DENIED/);
    assert.ok(calls>=2,'final post-status native re-attestation must run');
    assert.equal(f.ctx.admissionCount,1);
  }finally{await f.cleanup(manager);}
});

test('native consent revoked during admission callback cannot reach preparer without continuation',async()=>{
  const f=await setup();let manager=null;
  try{
    let prepared=0;
    const admit=f.protectedDeliveryOrigin.admitOperation;
    const origin={...f.protectedDeliveryOrigin,
      admitOperation:async request=>{
        const id=await admit(request);
        f.ctx.bindingId='c'.repeat(32);
        return id;
      }
    };
    manager=f.makeManager(origin,async()=>{
      prepared++;
      return {file:process.execPath,args:['-e','process.exit(0)'],cwd:f.root};
    });
    await assert.rejects(()=>manager.execute('operation_start',{
      requestId:'revoked-within-admit',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','30','ok']}
    }),/ASYNC_DELIVERY_SIGNED_ORIGIN_ADMISSION_REVOKED/);
    assert.equal(prepared,0,'preparer cannot run after a revoked grant');
    assert.equal(f.ctx.admissionCount,1);
  }finally{await f.cleanup(manager);}
});

test('protected native continuation never signals when the signed terminal result was rejected',async()=>{
  const f=await setup();let manager=null;
  try{
    let handoffs=0;
    const origin={...f.protectedDeliveryOrigin,
      receiptForTerminal:async()=>{throw new Error('HOST_SIGNATURE_DENIED');}
    };
    manager=f.makeManager(origin,undefined,async()=>{},async()=>{handoffs++;return {handoffId:'unsafe'};});
    const started=await manager.execute('operation_start',{
      requestId:'no-handoff-without-signed-result',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','75','ok']},
      continuation:{projectId:'p1',eventKey:'op:unsigned',root:f.root}
    });
    let completed=false;
    for(let i=0;i<100;i++){
      await manager.reconcileDeliveries(10);
      const ops=await readdir(path.join(f.root,'operations','operations'));
      if(ops.length===1){
        const state=JSON.parse(await readFile(path.join(
          f.root,'operations','operations',started.operationId,'state.json'),'utf8'));
        if(state.status==='SUCCEEDED'){completed=true;break;}
      }
      await sleep(40);
    }
    assert.equal(completed,true);
    await manager.reconcileDeliveries(10);
    assert.equal(f.store.health().pending,0);
    assert.equal(handoffs,0,'onTerminal cannot bypass rejected signed delivery');
  }finally{await f.cleanup(manager);}
});

test('protected native continuation never signals after owner consent regrant',async()=>{
  const f=await setup();let manager=null;
  try{
    let handoffs=0;
    manager=f.makeManager(f.protectedDeliveryOrigin,undefined,async()=>{},
      async()=>{handoffs++;return {handoffId:'unsafe'};});
    const started=await manager.execute('operation_start',{
      requestId:'no-handoff-regrant',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','150','ok']},
      continuation:{projectId:'p1',eventKey:'op:regrant-block',root:f.root}
    });
    f.ctx.bindingId='c'.repeat(32);
    let found=false;
    for(let i=0;i<100;i++){
      await manager.reconcileDeliveries(10);
      const items=f.store.list({correlationId:'origin-route'}).items;
      if(items.length){found=true;break;}
      await sleep(40);
    }
    assert.equal(found,true,'signed original result still retained for audit');
    await manager.reconcileDeliveries(10);
    assert.equal(handoffs,0,'revoked consent must not allow unbound continuation signaling');
  }finally{await f.cleanup(manager);}
});

test('protected native continuation dispatches atomically through the Host and never calls legacy handler',async()=>{
  const f=await setup();let manager=null;
  try{
    const signals=[];
    let legacyCalls=0;
    f.ctx.nativeHandoff=async (proof,payload)=>{
      assert.ok(Object.isFrozen(proof));
      assert.ok(Object.isFrozen(payload));
      signals.push({status:payload.status,proof});
      return {handoffId:'trusted-handoff',state:'QUEUED',
        handoffKey:proof.handoffKey,deliveryId:proof.deliveryId,
        originAdmissionId:proof.originAdmissionId};
    };
    manager=f.makeManager(f.protectedDeliveryOrigin,undefined,async()=>{},
      async()=>{legacyCalls++;throw new Error('LEGACY_HANDLER_BYPASS');});
    const started=await manager.execute('operation_start',{
      requestId:'signed-continuation-ok',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','75','ok']},
      continuation:{projectId:'p1',eventKey:'op:trusted-positive',root:f.root}
    });
    let delivery=null;
    for(let i=0;i<100;i++){
      await manager.reconcileDeliveries(10);
      delivery=f.store.list({correlationId:'origin-route'}).items[0]??null;
      if(delivery&&signals.length) break;
      await sleep(35);
    }
    assert.ok(delivery);
    assert.ok(signals.length>0);
    assert.equal(legacyCalls,0,'protected path never uses legacy onTerminal');
    assert.equal(signals[0].status,'SUCCEEDED');
    assert.equal(signals[0].proof.deliveryId,delivery.deliveryId);
    assert.equal(signals[0].proof.originAdmissionId,'admit:'+started.operationId);
    assert.equal(signals[0].proof.correlationId,'origin-route');
    assert.equal(signals[0].proof.continuationHash.length,64);
  }finally{await f.cleanup(manager);}
});

test('protected continuation cannot signal if native grant changes during handoff authorization',async()=>{
  const f=await setup();let manager=null;
  try{
    let calls=0,handoffs=0;
    f.ctx.nativeHandoff=async()=>{handoffs++;return {handoffId:'must-not'};};
    const authorize=f.protectedDeliveryOrigin.authorizeHandoff;
    const origin={...f.protectedDeliveryOrigin,
      authorizeHandoff:async request=>{
        const previous=await authorize(request);
        if(++calls===1)f.ctx.bindingId='c'.repeat(32);
        return previous;
      }
    };
    manager=f.makeManager(origin,undefined,async()=>{},async()=>{
      handoffs++;return {handoffId:'must-not'};
    });
    await manager.execute('operation_start',{
      requestId:'revoked-in-handoff-auth',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','75','ok']},
      continuation:{projectId:'p1',eventKey:'op:revoke-on-authorize',root:f.root}
    });
    for(let i=0;i<100;i++){
      await manager.reconcileDeliveries(10);
      if(calls>=2)break;
      await sleep(35);
    }
    assert.ok(calls>=2,'second grant check is mandatory');
    assert.equal(handoffs,0);
    assert.equal(f.ctx.captured.length,0);
  }finally{await f.cleanup(manager);}
});

test('protected continuation refuses an unverified native handoff callback at construction',async()=>{
  const f=await setup();
  try{
    const incomplete={...f.protectedDeliveryOrigin};
    delete incomplete.authorizeHandoff;
    assert.throws(()=>f.makeManager(incomplete,undefined,async()=>{},async()=>{}),
      /ASYNC_DELIVERY_SIGNED_ORIGIN_HOST_REQUIRED/);
  }finally{await f.cleanup();}
});

test('protected Host fails closed without an atomic native handoff dispatcher',async()=>{
  const f=await setup();
  try{
    const incomplete={...f.protectedDeliveryOrigin};
    delete incomplete.dispatchHandoff;
    assert.throws(()=>f.makeManager(incomplete,undefined,async()=>{},async()=>{}),
      /ASYNC_DELIVERY_SIGNED_ORIGIN_HOST_REQUIRED/);
  }finally{await f.cleanup();}
});

test('native atomic dispatch rejects owner revocation after the final preflight check',async()=>{
  const f=await setup();let manager=null;
  try{
    let deliveryAttempts=0,legacyCalls=0;
    const authorize=f.protectedDeliveryOrigin.authorizeHandoff;
    const modified={...f.protectedDeliveryOrigin,
      authorizeHandoff:async request=>{
        const granted=await authorize(request);
        // Revoke in the last asynchronous authorization callback.
        if(granted && ++deliveryAttempts===2) f.ctx.bindingId='c'.repeat(32);
        return granted;
      }
    };
    manager=f.makeManager(modified,undefined,async()=>{},
      async()=>{legacyCalls++;throw new Error('LEGACY_SHOULD_NOT_SEND');});
    await manager.execute('operation_start',{
      requestId:'atomic-check-native-dispatch',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','70','ok']},
      continuation:{projectId:'p1',eventKey:'op:atomic',root:f.root}
    });
    for(let i=0;i<100;i++){
      await manager.reconcileDeliveries(10);
      if(deliveryAttempts>=2)break;
      await sleep(35);
    }
    assert.ok(deliveryAttempts>=2);
    assert.equal(legacyCalls,0);
    assert.equal(f.ctx.captured.length,0,'native dispatcher rejects revoked grant at send');
  }finally{await f.cleanup(manager);}
});

test('recovered signed continuation dispatches natively only under active original consent',async()=>{
  const f=await setup();let manager=null;
  try{
    manager=f.makeManager();
    const started=await manager.execute('operation_start',{
      requestId:'restart-signed-continuation',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','75','ok']},
      continuation:{projectId:'p1',eventKey:'op:restart-signed',root:f.root}
    });
    const terminal=await f.waitFor(manager,started.operationId);
    assert.ok(terminal.deliveryId);
    await manager.close();manager=null;
    let legacyCalls=0;
    manager=f.makeManager(f.protectedDeliveryOrigin,undefined,async()=>{},
      async()=>{legacyCalls++;throw new Error('UNTRUSTED_LEGACY_HANDLER');});
    for(let i=0;i<100;i++){
      if(f.ctx.captured.length)break;
      await manager.reconcileDeliveries(10);
      await sleep(30);
    }
    assert.ok(f.ctx.captured.length>0,'restart reconciles with original signed receipt');
    assert.equal(f.ctx.captured[0].request.deliveryId,terminal.deliveryId);
    assert.equal(f.ctx.captured[0].request.originAdmissionId,'admit:'+started.operationId);
    assert.equal(legacyCalls,0);
  }finally{await f.cleanup(manager);}
});

test('restart recovery never signals old continuation after consent rotation',async()=>{
  const f=await setup();let manager=null;
  try{
    manager=f.makeManager();
    const started=await manager.execute('operation_start',{
      requestId:'restart-revoked-continuation',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','75','ok']},
      continuation:{projectId:'p1',eventKey:'op:restart-revoked',root:f.root}
    });
    const terminal=await f.waitFor(manager,started.operationId);
    assert.ok(terminal.deliveryId);
    await manager.close();manager=null;
    // The native path is active before restart now; only post-regrant
    // dispatches are forbidden, not legitimate earlier native enqueues.
    f.ctx.captured.length=0;
    f.ctx.bindingId='c'.repeat(32);
    let legacyCalls=0;
    manager=f.makeManager(f.protectedDeliveryOrigin,undefined,async()=>{},
      async()=>{legacyCalls++;throw new Error('UNTRUSTED_LEGACY_HANDLER');});
    for(let i=0;i<12;i++){
      await manager.reconcileDeliveries(10);
      await sleep(35);
    }
    assert.equal(f.ctx.captured.length,0);
    assert.equal(legacyCalls,0);
    assert.equal(f.store.get(terminal.deliveryId,'origin-route').receiptId,null);
  }finally{await f.cleanup(manager);}
});

test('protected native handoff with no receipt stays pending instead of silently completing',async()=>{
  const f=await setup();let manager=null;
  try{
    f.ctx.nativeHandoff=async()=>null;
    manager=f.makeManager(f.protectedDeliveryOrigin,undefined,async()=>{},async()=>{});
    const started=await manager.execute('operation_start',{
      requestId:'handoff-missing-receipt',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','70','ok']},
      continuation:{projectId:'p1',eventKey:'op:missing-receipt',root:f.root}
    });
    const terminal=await f.waitFor(manager,started.operationId);
    assert.equal(terminal.status,'SUCCEEDED');
    assert.equal(terminal.conversationHandoffPending,true,
      'null native handoff receipt must be recoverable, not acknowledged');
    assert.ok(f.ctx.captured.length>=1);
  }finally{await f.cleanup(manager);}
});

test('protected native handoff rejects mismatched receipt and retains retryable state',async()=>{
  const f=await setup();let manager=null;
  try{
    f.ctx.nativeHandoff=async()=>({
      handoffId:'foreign-handoff',state:'QUEUED',originAdmissionId:'admit:other',
      deliveryId:'unrelated',handoffKey:'0'.repeat(64)
    });
    manager=f.makeManager(f.protectedDeliveryOrigin,undefined,async()=>{},async()=>{});
    const started=await manager.execute('operation_start',{
      requestId:'handoff-mismatched-receipt',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','75','ok']},
      continuation:{projectId:'p1',eventKey:'op:mismatched-receipt',root:f.root}
    });
    const terminal=await f.waitFor(manager,started.operationId);
    assert.equal(terminal.conversationHandoffPending,true,
      'unrelated handoff receipt must be rejected');
    assert.equal(terminal.conversationHandoffId,undefined);
  }finally{await f.cleanup(manager);}
});

test('recovered native handoff attempts retain a stable idempotency key',async()=>{
  const f=await setup();let manager=null;
  try{
    let attempts=0;
    f.ctx.nativeHandoff=async request=>{
      attempts++;
      if(attempts===1)return null;
      return {handoffId:'stable-handoff-1',state:'QUEUED',
        handoffKey:request.handoffKey,deliveryId:request.deliveryId,
        originAdmissionId:request.originAdmissionId};
    };
    manager=f.makeManager(f.protectedDeliveryOrigin,undefined,async()=>{},async()=>{});
    const started=await manager.execute('operation_start',{
      requestId:'handoff-stable-key',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','75','ok']},
      continuation:{projectId:'p1',eventKey:'op:stable-idempotency',root:f.root}
    });
    await f.waitFor(manager,started.operationId);
    let result=null;
    for(let i=0;i<60;i++){
      result=await manager.execute('operation_status',{operationId:started.operationId});
      if(result.conversationHandoffId)break;
      await sleep(30);
    }
    assert.equal(result?.conversationHandoffId,'stable-handoff-1');
    assert.ok(f.ctx.captured.length>=2);
    const keys=f.ctx.captured.map(x=>x.request.handoffKey);
    assert.match(keys[0],/^[a-f0-9]{64}$/);
    assert.ok(keys.every(x=>x===keys[0]));
  }finally{await f.cleanup(manager);}
});

test('lost native handoff acknowledgment recovers after restart without another enqueue',async()=>{
  const f=await setup();let manager=null;
  try{
    const nativeEvents=new Map();
    let nativeEnqueues=0;
    f.ctx.nativeHandoff=async request=>{
      if(!nativeEvents.has(request.handoffKey)){
        nativeEnqueues++;
        nativeEvents.set(request.handoffKey,{
          handoffId:'persisted-native-handoff',state:'QUEUED',
          handoffKey:request.handoffKey,deliveryId:request.deliveryId,
          originAdmissionId:request.originAdmissionId
        });
      }
      return null; // Native commit succeeded; its acknowledgment was lost.
    };
    manager=f.makeManager(f.protectedDeliveryOrigin,undefined,async()=>{},async()=>{});
    const started=await manager.execute('operation_start',{
      requestId:'native-handoff-lost-ack',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','80','ok']},
      continuation:{projectId:'p1',eventKey:'op:lost-ack',root:f.root}
    });
    const pending=await f.waitFor(manager,started.operationId);
    assert.equal(pending.conversationHandoffPending,true);
    assert.equal(nativeEnqueues,1);
    const firstKey=f.ctx.captured[0]?.request.handoffKey;
    assert.match(firstKey,/^[a-f0-9]{64}$/);
    await manager.close();manager=null;
    f.ctx.nativeHandoff=async request=>{
      // The Host's durable idempotency lookup returns the prior result.
      assert.equal(request.handoffKey,firstKey);
      return nativeEvents.get(request.handoffKey);
    };
    manager=f.makeManager(f.protectedDeliveryOrigin,undefined,async()=>{},async()=>{});
    let recovered=null;
    for(let i=0;i<100;i++){
      recovered=await manager.execute('operation_status',{operationId:started.operationId});
      if(recovered.conversationHandoffId)break;
      await sleep(30);
    }
    assert.equal(recovered?.conversationHandoffId,'persisted-native-handoff');
    assert.equal(nativeEnqueues,1);
    assert.ok(f.ctx.captured.every(x=>x.request.handoffKey===firstKey));
  }finally{await f.cleanup(manager);}
});

test('edited post-execution continuation cannot dispatch against original signed admission',async()=>{
  const f=await setup();let manager=null;
  try{
    manager=f.makeManager(); // No handoff callback before restart.
    const started=await manager.execute('operation_start',{
      requestId:'corrupt-continuation-replay',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','70','ok']},
      continuation:{projectId:'p1',eventKey:'op:original-event',root:f.root,
        summary:'original-validated-summary'}
    });
    const terminal=await f.waitFor(manager,started.operationId);
    assert.ok(terminal.deliveryId);
    await manager.close();manager=null;
    const statePath=path.join(f.root,'operations','operations',started.operationId,'state.json');
    const state=JSON.parse(await readFile(statePath,'utf8'));
    state.continuation={...state.continuation,eventKey:'op:changed-event',
      summary:'modified-after-execution'};
    await writeFile(statePath,JSON.stringify(state)+'\n');
    // Disregard only the already-authorized pre-edit enqueue.
    f.ctx.captured.length=0;
    manager=f.makeManager(f.protectedDeliveryOrigin,undefined,async()=>{},async()=>{});
    const exposed=await manager.execute('operation_status',{operationId:started.operationId});
    assert.equal(exposed.conversationHandoffPending,true);
    for(let i=0;i<6;i++){
      await manager.reconcileDeliveries(10);
      await sleep(20);
    }
    // An already-authorized pre-edit callback may finish asynchronously.
    // The security condition is that the modified event is never dispatched.
    assert.equal(f.ctx.captured.filter(x=>
      x.payload?.continuation?.eventKey==='op:changed-event').length,0,
      'a changed continuation must never reach the native dispatcher');
    assert.equal(f.store.get(terminal.deliveryId,'origin-route').receiptId,null);
  }finally{await f.cleanup(manager);}
});

test('protected native continuation dispatches with no legacy onTerminal adapter',async()=>{
  const f=await setup();let manager=null;
  try{
    manager=f.makeManager(); // onTerminal is intentionally absent.
    const started=await manager.execute('operation_start',{
      requestId:'native-no-legacy-handler',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','75','ok']},
      continuation:{projectId:'p1',eventKey:'op:native-no-legacy',root:f.root}
    });
    let visible=null;
    for(let i=0;i<90;i++){
      visible=await manager.execute('operation_status',{operationId:started.operationId});
      if(visible.conversationHandoffId)break;
      await sleep(30);
    }
    assert.equal(visible?.conversationHandoffId,'native-trusted-handoff');
    assert.equal(f.ctx.captured.length>=1,true);
    assert.match(f.ctx.captured[0].request.handoffKey,/^[a-f0-9]{64}$/);
  }finally{await f.cleanup(manager);}
});

test('protected native dispatcher discovers pending continuation on restart without legacy handler',async()=>{
  const f=await setup();let manager=null;
  try{
    f.ctx.nativeHandoff=async()=>null; // Lost callback ACK, not a failure of worker execution.
    manager=f.makeManager(); // No onTerminal in either instance.
    const started=await manager.execute('operation_start',{
      requestId:'restart-native-without-legacy',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','75','ok']},
      continuation:{projectId:'p1',eventKey:'op:restart-no-legacy',root:f.root}
    });
    const first=await f.waitFor(manager,started.operationId);
    assert.equal(first.conversationHandoffPending,true);
    await manager.close();manager=null;
    f.ctx.captured.length=0;
    f.ctx.nativeHandoff=null; // Trusted native Host can now reconcile its old idempotency key.
    manager=f.makeManager();
    let recovered=false;
    for(let i=0;i<100;i++){
      if(f.ctx.captured.length>0){recovered=true;break;}
      await sleep(40);
    }
    assert.equal(recovered,true,'restart discovery must not depend on legacy onTerminal');
    assert.equal(f.ctx.captured[0].request.operationId,started.operationId);
  }finally{await f.cleanup(manager);}
});

test('protected pending native handoff automatically retries without user polling',async()=>{
  const f=await setup();let manager=null;
  try{
    let attempts=0;
    f.ctx.nativeHandoff=async request=>{
      attempts++;
      if(attempts===1)return null; // Native enqueue ACK is transiently lost.
      return {handoffId:'auto-recovered-native',state:'QUEUED',
        handoffKey:request.handoffKey,deliveryId:request.deliveryId,
        originAdmissionId:request.originAdmissionId};
    };
    manager=f.makeManager(); // Neither legacy onTerminal nor public polling.
    await manager.execute('operation_start',{
      requestId:'native-auto-recover-no-poll',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','60','ok']},
      continuation:{projectId:'p1',eventKey:'op:auto-native',root:f.root}
    });
    for(let i=0;i<100 && attempts<2;i++)await sleep(35);
    assert.ok(attempts>=2,'worker exit must trigger bounded native retry');
    assert.ok(f.ctx.captured.every(x=>
      x.request.handoffKey===f.ctx.captured[0].request.handoffKey));
  }finally{await f.cleanup(manager);}
});

test('native-only protected mode requires verified dispatch callbacks without legacy onTerminal',async()=>{
  const f=await setup();
  try{
    const noDispatch={...f.protectedDeliveryOrigin};
    delete noDispatch.dispatchHandoff;
    assert.throws(()=>f.makeManager(noDispatch),
      /ASYNC_DELIVERY_SIGNED_ORIGIN_HOST_REQUIRED/);
    const noAuthorization={...f.protectedDeliveryOrigin};
    delete noAuthorization.authorizeHandoff;
    assert.throws(()=>f.makeManager(noAuthorization),
      /ASYNC_DELIVERY_SIGNED_ORIGIN_HOST_REQUIRED/);
  }finally{await f.cleanup();}
});

test('native-only autonomous recovery stops after the verified enqueue receipt',async()=>{
  const f=await setup();let manager=null;
  try{
    let attempts=0;
    f.ctx.nativeHandoff=async request=>{
      attempts++;
      if(attempts===1)return null;
      return {handoffId:'successful-on-retry',state:'QUEUED',
        handoffKey:request.handoffKey,deliveryId:request.deliveryId,
        originAdmissionId:request.originAdmissionId};
    };
    manager=f.makeManager();
    await manager.execute('operation_start',{
      requestId:'stop-native-retry-on-success',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','70','ok']},
      continuation:{projectId:'p1',eventKey:'op:stop-recovery',root:f.root}
    });
    for(let i=0;i<100&&attempts<2;i++)await sleep(35);
    assert.ok(attempts>=2);
    const settled=attempts;
    await sleep(700);
    assert.equal(attempts,settled,'verified native receipt stops the autonomous recovery timer');
  }finally{await f.cleanup(manager);}
});

test('revoked owner grant parks protected handoff rather than automatically retrying forever',async()=>{
  const f=await setup();let manager=null;
  try{
    let checks=0;
    const oldAuthorize=f.protectedDeliveryOrigin.authorizeHandoff;
    const origin={...f.protectedDeliveryOrigin,
      authorizeHandoff:async request=>{
        checks++;
        return oldAuthorize(request);
      }
    };
    manager=f.makeManager(origin);
    await manager.execute('operation_start',{
      requestId:'no-retry-revoked-native',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','150','ok']},
      continuation:{projectId:'p1',eventKey:'op:no-repeat-revoked',root:f.root}
    });
    f.ctx.bindingId='c'.repeat(32);
    for(let i=0;i<240&&checks<1;i++)await sleep(50);
    assert.ok(checks>=1,'the original consent epoch is checked');
    const first=checks;
    await sleep(1400);
    assert.equal(checks,first,'permanently revoked owner must not trigger an automatic retry loop');
    assert.equal(f.ctx.captured.length,0);
  }finally{await f.cleanup(manager);}
});

test('transient absent native receipt has a bounded retry budget and stays unacknowledged',async()=>{
  const f=await setup();let manager=null;
  try{
    f.config.asyncOperations.continuationRecoveryMaxAttempts=2;
    let dispatches=0;
    f.ctx.nativeHandoff=async()=>{dispatches++;return null;};
    manager=f.makeManager();
    await manager.execute('operation_start',{
      requestId:'bounded-receipt-unknown',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','70','ok']},
      continuation:{projectId:'p1',eventKey:'op:bounded-transient',root:f.root}
    });
    await sleep(1350);
    const initial=dispatches;
    assert.ok(initial>=2,'transient lost ACK gets a bounded recovery attempt');
    await sleep(1500);
    assert.equal(dispatches,initial,'autonomous retries must stop at the configured cap');
    const rows=await readdir(path.join(f.root,'operations','operations'));
    assert.equal(rows.length,1);
    const ledger=JSON.parse(await readFile(path.join(
      f.root,'operations','operations',rows[0],'native-handoff.json'),'utf8'));
    assert.equal(ledger.attempts,2,'the original durable attempt budget is exhausted');
    assert.equal(ledger.receipt,null,'no native queue receipt or ChatGPT ACK was fabricated');
    assert.equal(f.store.list({correlationId:'origin-route'}).items[0]?.receiptId,null);
  }finally{await f.cleanup(manager);}
});

test('long-running native worker does not exhaust handoff retry budget before terminal',async()=>{
  const f=await setup();let manager=null;
  try{
    f.config.asyncOperations.continuationRecoveryMaxAttempts=1;
    manager=f.makeManager();
    await manager.execute('operation_start',{
      requestId:'long-worker-does-not-use-retry-budget',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','950','ok']},
      continuation:{projectId:'p1',eventKey:'op:long-worker-recovery',root:f.root}
    });
    for(let i=0;i<95&&f.ctx.captured.length===0;i++)await sleep(30);
    assert.ok(f.ctx.captured.length>=1,
      'terminal native enqueue succeeds even if worker ran longer than first retry delay');
    assert.equal(manager.status().continuationRecovery.exhausted,0);
  }finally{await f.cleanup(manager);}
});

test('wrong native receipt is parked as a visible original-handoff block, not retried endlessly',async()=>{
  const f=await setup();let manager=null;
  try{
    f.config.asyncOperations.continuationRecoveryMaxAttempts=3;
    let attempts=0;
    f.ctx.nativeHandoff=async()=>{attempts++;return {
      handoffId:'unrelated-queue',state:'QUEUED',originAdmissionId:'admit:foreign',
      deliveryId:'foreign-delivery',handoffKey:'f'.repeat(64)
    };};
    manager=f.makeManager();
    const started=await manager.execute('operation_start',{
      requestId:'native-wrong-receipt-park',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','70','ok']},
      continuation:{projectId:'p1',eventKey:'op:wrong-receipt-park',root:f.root}
    });
    let status=null;
    for(let i=0;i<90;i++){
      status=await manager.execute('operation_status',{operationId:started.operationId});
      if(status.conversationHandoffBlockedReason)break;
      await sleep(25);
    }
    assert.equal(status?.conversationHandoffBlockedReason,
      'ASYNC_CONTINUATION_NATIVE_RECEIPT_MISMATCH');
    assert.equal(status.conversationHandoffPending,true);
    const earlier=attempts;
    await sleep(1000);
    assert.equal(attempts,earlier,'malformed receipt is not automatically retried');
    assert.equal(f.store.get(status.deliveryId,'origin-route').receiptId,null);
  }finally{await f.cleanup(manager);}
});

test('concurrent status and native recovery coalesce to one Host dispatch for a handoff key',async()=>{
  const f=await setup();let manager=null,release=null;
  try{
    const gate=new Promise(resolve=>{release=resolve;});
    let nativeCalls=0;
    f.ctx.nativeHandoff=async request=>{
      nativeCalls++;
      await gate;
      return {handoffId:'coalesced-native',state:'QUEUED',
        handoffKey:request.handoffKey,deliveryId:request.deliveryId,
        originAdmissionId:request.originAdmissionId};
    };
    manager=f.makeManager();
    const started=await manager.execute('operation_start',{
      requestId:'concurrent-native-dispatch-once',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','80','ok']},
      continuation:{projectId:'p1',eventKey:'op:concurrent-dispatch',root:f.root}
    });
    for(let i=0;i<100&&nativeCalls<1;i++)await sleep(25);
    assert.equal(nativeCalls,1,'a native handoff must have begun');
    const concurrent=Array.from({length:6},()=>manager.execute('operation_status',{
      operationId:started.operationId
    }));
    await sleep(130);
    assert.equal(nativeCalls,1,
      'simultaneous observers share one in-flight Host enqueue rather than dispatching six times');
    release();
    const states=await Promise.all(concurrent);
    assert.ok(states.every(x=>x.conversationHandoffId==='coalesced-native'));
    assert.equal(f.ctx.captured.length,1);
  }finally{release?.();await f.cleanup(manager);}
});

test('an in-flight failed native dispatch releases its slot for bounded idempotent retry',async()=>{
  const f=await setup();let manager=null;
  try{
    let calls=0;
    f.ctx.nativeHandoff=async request=>{
      calls++;
      if(calls===1)throw new Error('SIMULATED_TRANSIENT_NATIVE_FAILURE');
      return {handoffId:'recovered-after-error',state:'QUEUED',
        handoffKey:request.handoffKey,deliveryId:request.deliveryId,
        originAdmissionId:request.originAdmissionId};
    };
    manager=f.makeManager();
    const started=await manager.execute('operation_start',{
      requestId:'failed-dispatch-releases-singleflight',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','75','ok']},
      continuation:{projectId:'p1',eventKey:'op:retry-after-error',root:f.root}
    });
    let accepted=null;
    for(let i=0;i<100;i++){
      accepted=await manager.execute('operation_status',{operationId:started.operationId});
      if(accepted.conversationHandoffId)break;
      await sleep(30);
    }
    assert.equal(accepted?.conversationHandoffId,'recovered-after-error');
    assert.ok(calls>=2);
    const ids=new Set(f.ctx.captured.map(x=>x.request.handoffKey));
    assert.equal(ids.size,1,'retry uses the same original signed handoff identity');
  }finally{await f.cleanup(manager);}
});

test('polling an already-queued protected handoff does not cause native re-enqueue',async()=>{
  const f=await setup();let manager=null;
  try{
    let enqueues=0;
    f.ctx.nativeHandoff=async request=>{
      enqueues++;
      return {handoffId:'durable-native-queued',state:'QUEUED',
        handoffKey:request.handoffKey,deliveryId:request.deliveryId,
        originAdmissionId:request.originAdmissionId};
    };
    manager=f.makeManager();
    const started=await manager.execute('operation_start',{
      requestId:'already-queued-must-not-repeat',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','70','ok']},
      continuation:{projectId:'p1',eventKey:'op:already-enqueued',root:f.root}
    });
    let status=null;
    for(let i=0;i<100;i++){
      status=await manager.execute('operation_status',{operationId:started.operationId});
      if(status.conversationHandoffId)break;
      await sleep(25);
    }
    assert.equal(status?.conversationHandoffId,'durable-native-queued');
    const first=enqueues;
    await Promise.all(Array.from({length:7},()=>manager.execute('operation_status',{
      operationId:started.operationId
    })));
    assert.equal(enqueues,first,'a previously acknowledged enqueue is read from durable receipt');
    await manager.close();manager=null;
    manager=f.makeManager();
    await manager.execute('operation_status',{operationId:started.operationId});
    assert.equal(enqueues,first,'restart must not enqueue already-correlated handoff again');
  }finally{await f.cleanup(manager);}
});

test('protected native retry budget cannot reset through manager restart or status polling',async()=>{
  const f=await setup();let manager=null;
  try{
    f.config.asyncOperations.continuationRecoveryMaxAttempts=2;
    let calls=0;
    f.ctx.nativeHandoff=async()=>{calls++;return null;};
    manager=f.makeManager();
    const started=await manager.execute('operation_start',{
      requestId:'durable-native-attempt-budget',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','75','ok']},
      continuation:{projectId:'p1',eventKey:'op:durable-attempt-cap',root:f.root}
    });
    for(let i=0;i<100&&calls<2;i++){
      await manager.execute('operation_status',{operationId:started.operationId});
      await sleep(25);
    }
    assert.equal(calls,2);
    await manager.close();manager=null;
    manager=f.makeManager();
    const initial=calls;
    for(let i=0;i<7;i++)await manager.execute('operation_status',{
      operationId:started.operationId
    });
    await sleep(500);
    assert.equal(calls,initial,'durable budget survives restart and manual polling');
    assert.equal(f.store.list({correlationId:'origin-route'}).items[0].receiptId,null);
  }finally{await f.cleanup(manager);}
});

test('corrupt native durable handoff ledger fails closed with no new enqueue',async()=>{
  const f=await setup();let manager=null;
  try{
    manager=f.makeManager();
    const started=await manager.execute('operation_start',{
      requestId:'tamper-native-handoff-ledger',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','75','ok']},
      continuation:{projectId:'p1',eventKey:'op:tamper-ledger',root:f.root}
    });
    let first=null;
    for(let i=0;i<100;i++){
      first=await manager.execute('operation_status',{operationId:started.operationId});
      if(first.conversationHandoffId)break;
      await sleep(25);
    }
    assert.ok(first?.conversationHandoffId);
    const count=f.ctx.captured.length;
    const ledgerPath=path.join(f.root,'operations','operations',started.operationId,'native-handoff.json');
    const record=JSON.parse(await readFile(ledgerPath,'utf8'));
    record.handoffKey='f'.repeat(64);
    await writeFile(ledgerPath,JSON.stringify(record)+'\n');
    const second=await manager.execute('operation_status',{operationId:started.operationId});
    assert.equal(second.conversationHandoffPending,true);
    assert.equal(second.conversationHandoffBlockedReason,'ASYNC_CONTINUATION_NATIVE_LEDGER_MISMATCH');
    assert.equal(f.ctx.captured.length,count);
  }finally{await f.cleanup(manager);}
});

test('a forged native enqueue receipt with a matching key is rejected after restart',async()=>{
  const f=await setup();let manager=null;
  try{
    manager=f.makeManager();
    const started=await manager.execute('operation_start',{
      requestId:'native-forged-matching-key',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','75','ok']},
      continuation:{projectId:'p1',eventKey:'op:forge-receipt',root:f.root}
    });
    let result=null;
    for(let i=0;i<100;i++){
      result=await manager.execute('operation_status',{operationId:started.operationId});
      if(result.conversationHandoffId)break;
      await sleep(25);
    }
    assert.ok(result?.conversationHandoffId);
    const ledgerPath=path.join(f.root,'operations','operations',started.operationId,'native-handoff.json');
    const ledger=JSON.parse(await readFile(ledgerPath,'utf8'));
    ledger.receipt.handoffId='forged-native-receipt';
    await writeFile(ledgerPath,JSON.stringify(ledger)+'\n');
    await manager.close();manager=null;
    manager=f.makeManager();
    const response=await manager.execute('operation_status',{operationId:started.operationId});
    assert.equal(response.conversationHandoffPending,true);
    assert.equal(response.conversationHandoffBlockedReason,
      'ASYNC_CONTINUATION_NATIVE_RECEIPT_NOT_VERIFIED');
    assert.notEqual(response.conversationHandoffId,'forged-native-receipt');
  }finally{await f.cleanup(manager);}
});

test('protected native handoff requires an independent trusted receipt verifier',async()=>{
  const f=await setup();
  try{
    const missing={...f.protectedDeliveryOrigin};
    delete missing.verifyHandoffReceipt;
    assert.throws(()=>f.makeManager(missing),
      /ASYNC_DELIVERY_SIGNED_ORIGIN_HOST_REQUIRED/);
  }finally{await f.cleanup();}
});

test('a stalled native dispatch cannot hang protected operation_status indefinitely',async()=>{
  const f=await setup();let manager=null,release=null;
  try{
    f.config.asyncOperations.nativeHandoffHostTimeoutMs=120;
    f.config.asyncOperations.continuationRecoveryMaxAttempts=1;
    const gate=new Promise(resolve=>{release=resolve;});
    let calls=0;
    f.ctx.nativeHandoff=async()=>{calls++;await gate;return null;};
    manager=f.makeManager();
    const started=await manager.execute('operation_start',{
      requestId:'stalled-native-dispatch-guard',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','70','ok']},
      continuation:{projectId:'p1',eventKey:'op:host-dispatch-stalled',root:f.root}
    });
    const terminal=await f.waitFor(manager,started.operationId);
    assert.equal(terminal.status,'SUCCEEDED');
    const latest=await Promise.race([
      manager.execute('operation_status',{operationId:started.operationId}),
      sleep(550).then(()=>{throw new Error('NATIVE_DISPATCH_WAIT_UNBOUNDED');})
    ]);
    assert.equal(latest.status,'SUCCEEDED');
    assert.equal(latest.conversationHandoffPending,true);
    assert.equal(latest.conversationHandoffId,undefined);
    assert.ok(calls>=1);
    const ledger=JSON.parse(await readFile(path.join(f.root,'operations','operations',
      started.operationId,'native-handoff.json'),'utf8'));
    assert.equal(ledger.receipt,null);
    assert.equal(ledger.attempts,1);
  }finally{release?.();await f.cleanup(manager);}
});

test('a stalled independent native receipt verifier cannot hang cached status reads',async()=>{
  const f=await setup();let manager=null,release=null;
  try{
    manager=f.makeManager();
    const started=await manager.execute('operation_start',{
      requestId:'stalled-native-receipt-verify',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','75','ok']},
      continuation:{projectId:'p1',eventKey:'op:host-verifier-stalled',root:f.root}
    });
    let ready=false;
    for(let i=0;i<110;i++){
      const row=await manager.execute('operation_status',{operationId:started.operationId});
      if(row.conversationHandoffId){ready=true;break;}
      await sleep(25);
    }
    assert.equal(ready,true);
    await manager.close();manager=null;
    f.config.asyncOperations.nativeHandoffHostTimeoutMs=120;
    const gate=new Promise(resolve=>{release=resolve;});
    const verifier={...f.protectedDeliveryOrigin,verifyHandoffReceipt:async()=>{await gate;return true;}};
    manager=f.makeManager(verifier);
    const latest=await Promise.race([
      manager.execute('operation_status',{operationId:started.operationId}),
      sleep(550).then(()=>{throw new Error('NATIVE_VERIFIER_WAIT_UNBOUNDED');})
    ]);
    assert.equal(latest.status,'SUCCEEDED');
    assert.equal(latest.conversationHandoffPending,true);
    assert.equal(latest.conversationHandoffId,undefined);
  }finally{release?.();await f.cleanup(manager);}
});

test('a stalled native owner authorization cannot hang status or start a send',async()=>{
  const f=await setup();let manager=null,release=null;
  try{
    f.config.asyncOperations.nativeHandoffHostTimeoutMs=120;
    const gate=new Promise(resolve=>{release=resolve;});
    let authCalls=0;
    const origin={...f.protectedDeliveryOrigin,
      authorizeHandoff:async()=>{authCalls++;await gate;return true;}
    };
    manager=f.makeManager(origin);
    const started=await manager.execute('operation_start',{
      requestId:'stalled-native-owner-auth',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','70','ok']},
      continuation:{projectId:'p1',eventKey:'op:host-auth-stalled',root:f.root}
    });
    const terminal=await f.waitFor(manager,started.operationId);
    assert.equal(terminal.status,'SUCCEEDED');
    const latest=await Promise.race([
      manager.execute('operation_status',{operationId:started.operationId}),
      sleep(550).then(()=>{throw new Error('OWNER_AUTH_WAIT_UNBOUNDED');})
    ]);
    assert.equal(latest.status,'SUCCEEDED');
    assert.equal(latest.conversationHandoffPending,true);
    assert.equal(latest.conversationHandoffId,undefined);
    assert.ok(authCalls>=1);
    assert.equal(f.ctx.captured.length,0,'unverified consent cannot launch native dispatch');
    assert.equal(manager.status().continuationRecovery.nativeHostTimeoutMs,120);
  }finally{release?.();await f.cleanup(manager);}
});

test('stalled native admission refuses operation_start without preparing worker',async()=>{
  const f=await setup();let manager=null,release=null;
  try{
    f.config.asyncOperations.protectedOriginHostTimeoutMs=120;
    const gate=new Promise(resolve=>{release=resolve;});
    let prepared=0;
    const origin={...f.protectedDeliveryOrigin,
      admitOperation:async()=>{await gate;throw new Error('ADMISSION_ABORTED');}
    };
    manager=f.makeManager(origin,async()=>{prepared++;throw new Error('SHOULD_NOT_PREPARE');});
    const start=()=>manager.execute('operation_start',{
      requestId:'native-admit-never-responds',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','30','ok']}
    });
    await assert.rejects(
      ()=>Promise.race([start(),sleep(550).then(()=>{throw Error('ADMISSION_WAIT_UNBOUNDED');})]),
      /ASYNC_DELIVERY_SIGNED_ORIGIN_ADMISSION_TIMEOUT/);
    assert.equal(prepared,0);
    assert.equal(f.ctx.captured.length,0);
  }finally{release?.();await f.cleanup(manager);}
});

test('stalled native operation access cannot indefinitely block status',async()=>{
  const f=await setup();let manager=null,release=null;
  try{
    manager=f.makeManager();
    const started=await manager.execute('operation_start',{
      requestId:'native-access-never-responds',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','65','ok']}
    });
    await f.waitFor(manager,started.operationId);
    await manager.close();manager=null;
    f.config.asyncOperations.protectedOriginHostTimeoutMs=120;
    const gate=new Promise(resolve=>{release=resolve;});
    const origin={...f.protectedDeliveryOrigin,
      authorizeAccess:async()=>{await gate;return false;}
    };
    manager=f.makeManager(origin);
    await assert.rejects(
      ()=>Promise.race([
        manager.execute('operation_status',{operationId:started.operationId}),
        sleep(550).then(()=>{throw Error('ACCESS_WAIT_UNBOUNDED');})
      ]),
      /ASYNC_DELIVERY_SIGNED_ORIGIN_ACCESS_TIMEOUT/);
  }finally{release?.();await f.cleanup(manager);}
});

test('stalled original execution receipt issuer cannot publish unsigned terminal result',async()=>{
  const f=await setup();let manager=null,release=null;
  try{
    f.config.asyncOperations.protectedOriginHostTimeoutMs=120;
    const gate=new Promise(resolve=>{release=resolve;});
    const origin={...f.protectedDeliveryOrigin,
      receiptForTerminal:async()=>{await gate;throw Error('ISSUER_UNAVAILABLE');}
    };
    manager=f.makeManager(origin);
    const started=await manager.execute('operation_start',{
      requestId:'stalled-original-receipt-issuer',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','70','ok']}
    });
    // A detached worker may still be RUNNING after 550ms on a loaded host.
    // Check the Host timeout only once the worker actually becomes terminal.
    await boundedTestWait(
      f.waitFor(manager,started.operationId,12000),
      'ISSUER_TERMINAL_WAIT_UNBOUNDED',14500);
    const state=await Promise.race([
      manager.execute('operation_status',{operationId:started.operationId}),
      sleep(2200).then(()=>{throw Error('ISSUER_WAIT_UNBOUNDED');})
    ]);
    assert.equal(state.status,'SUCCEEDED');
    assert.equal(state.deliveryPending,true);
    assert.equal(state.deliveryId,undefined);
    assert.equal(f.store.health().pending,0,'unsigned terminal publication cannot be acknowledged');
  }finally{release?.();await f.cleanup(manager);}
});

test('stalled original grant replay verifier cannot run preauthorized preparation',async()=>{
  const f=await setup();let manager=null,release=null;
  try{
    f.config.asyncOperations.protectedOriginHostTimeoutMs=120;
    const gate=new Promise(resolve=>{release=resolve;});
    let prepared=0;
    const origin={...f.protectedDeliveryOrigin,
      authorizeReplay:async()=>{await gate;return false;}
    };
    manager=f.makeManager(origin,async()=>{prepared++;throw Error('PREPARATION_NOT_AUTHORIZED');});
    await assert.rejects(
      ()=>Promise.race([
        manager.execute('operation_start',{
          requestId:'stalled-original-grant-replay',correlationId:'origin-route',
          tool:'run_project_command',arguments:{argv:['sleep','30','ok']}
        }),
        sleep(550).then(()=>{throw Error('REPLAY_WAIT_UNBOUNDED');})
      ]),
      /ASYNC_DELIVERY_SIGNED_ORIGIN_REPLAY_TIMEOUT/);
    assert.equal(prepared,0);
    assert.equal(f.ctx.captured.length,0);
  }finally{release?.();await f.cleanup(manager);}
});

test('two protected managers sharing a state directory cannot dispatch the same original handoff concurrently',async()=>{
  const f=await setup();let a=null,b=null,release=null;
  try{
    const gate=new Promise(resolve=>{release=resolve;});
    let calls=0;
    f.ctx.nativeHandoff=async request=>{
      calls++;
      await gate;
      return {handoffId:'cross-manager-single-receipt',state:'QUEUED',
        handoffKey:request.handoffKey,deliveryId:request.deliveryId,
        originAdmissionId:request.originAdmissionId};
    };
    a=f.makeManager();
    const started=await a.execute('operation_start',{
      requestId:'two-manager-original-key',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','85','ok']},
      continuation:{projectId:'p1',eventKey:'op:two-managers',root:f.root}
    });
    for(let i=0;i<100&&calls===0;i++)await sleep(30);
    assert.equal(calls,1,'first manager has issued the original native handoff');
    b=f.makeManager();
    const second=b.execute('operation_status',{operationId:started.operationId});
    await sleep(220);
    assert.equal(calls,1,'second manager must not duplicate an in-flight native enqueue');
    release();
    const result=await second;
    assert.equal(result.status,'SUCCEEDED');
    let accepted=null;
    for(let i=0;i<70;i++){
      accepted=await b.execute('operation_status',{operationId:started.operationId});
      if(accepted.conversationHandoffId)break;
      await sleep(30);
    }
    assert.equal(accepted?.conversationHandoffId,'cross-manager-single-receipt');
    assert.equal(calls,1);
  }finally{release?.();await f.cleanup(a,b);}
});

test('native handoff timeout retains the exclusive claim and prevents an uncertain second send',async()=>{
  const f=await setup();let manager=null,release=null;
  try{
    f.config.asyncOperations.nativeHandoffHostTimeoutMs=110;
    const gate=new Promise(resolve=>{release=resolve;});
    let sends=0;
    f.ctx.nativeHandoff=async request=>{
      sends++;
      await gate; // Native effect may complete after commander's deadline.
      return {handoffId:'very-late-native-receipt',state:'QUEUED',
        handoffKey:request.handoffKey,deliveryId:request.deliveryId,
        originAdmissionId:request.originAdmissionId};
    };
    manager=f.makeManager();
    const started=await manager.execute('operation_start',{
      requestId:'timeout-retains-cross-manager-claim',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','85','ok']},
      continuation:{projectId:'p1',eventKey:'op:uncertain-original',root:f.root}
    });
    for(let i=0;i<90&&sends<1;i++)await sleep(25);
    assert.equal(sends,1);
    await sleep(180);
    const claimPath=path.join(f.root,'operations','operations',
      started.operationId,'native-handoff.claim');
    const claim=JSON.parse(await readFile(claimPath,'utf8'));
    assert.equal(claim.schema,1);
    assert.match(claim.handoffKey,/^[a-f0-9]{64}$/);
    const row=await manager.execute('operation_status',{operationId:started.operationId});
    assert.equal(row.status,'SUCCEEDED');
    assert.equal(row.conversationHandoffPending,true);
    assert.equal(row.conversationHandoffId,undefined);
    await manager.close();manager=null;
    manager=f.makeManager();
    for(let i=0;i<4;i++)await manager.execute('operation_status',{
      operationId:started.operationId
    });
    assert.equal(sends,1,'restart must not start a second uncertain native send');
    release();
    await sleep(50);
    const finalRow=await manager.execute('operation_status',{
      operationId:started.operationId
    });
    assert.equal(finalRow.conversationHandoffPending,true);
    assert.equal(finalRow.conversationHandoffId,undefined,
      'late Host completion cannot manufacture an accepted ChatGPT ACK');
    assert.equal(sends,1);
  }finally{release?.();await f.cleanup(manager);}
});

test('actual independent Node processes serialize V1-06 handoff and reuse a verified cached receipt',async()=>{
  const f=await setup();let manager=null,releaseGate=false;
  const children=[];
  const marker=path.join(f.root,'native-process-dispatches.log');
  const gate=path.join(f.root,'allow-native-response.gate');
  const childScript=fileURLToPath(new URL('./async-handoff-cross-process-child.mjs',import.meta.url));
  const launch=()=>{
    const cp=spawn(process.execPath,[childScript,f.root,operationId,marker,gate],{
      cwd:f.root,stdio:['ignore','pipe','pipe'],windowsHide:true
    });
    let stdout='',stderr='';
    const closed=new Promise((resolve,reject)=>{
      cp.stdout.on('data',chunk=>{stdout+=chunk;});
      cp.stderr.on('data',chunk=>{stderr+=chunk;});
      cp.once('error',reject);
      cp.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));
    });
    children.push(cp);
    return closed;
  };
  let operationId=null;
  try{
    manager=f.makeManager({...f.protectedDeliveryOrigin,authorizeHandoff:async()=>false});
    const started=await manager.execute('operation_start',{
      requestId:'cross-process-real-claim',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','75','ok']},
      continuation:{projectId:'p1',eventKey:'op:real-process-claim',root:f.root}
    });
    operationId=started.operationId;
    const done=await f.waitFor(manager,operationId);
    assert.equal(done.status,'SUCCEEDED');
    assert.ok(done.deliveryId);
    await manager.close();manager=null;
    // First process enters the real dispatch and remains in-flight.
    const first=launch();
    let entered=false;
    for(let i=0;i<150;i++){
      try{entered=(await readFile(marker,'utf8')).trim().length>0;}
      catch(error){if(error?.code!=='ENOENT')throw error;}
      if(entered)break;
      await sleep(25);
    }
    assert.equal(entered,true,'first independent process reached native dispatch');
    const second=launch();
    const secondResult=await boundedTestWait(second,'SECOND_PROCESS_STATUS_TIMEOUT');
    assert.equal(secondResult.code,0,secondResult.stderr);
    assert.equal(JSON.parse(secondResult.stdout.trim()).pending,true,
      'second process must not claim or dispatch while first owns claim');
    assert.equal((await readFile(marker,'utf8')).trim().split('\n').length,1,
      'two OS processes must produce exactly one native dispatch attempt');
    await writeFile(gate,'release\n');
    releaseGate=true;
    const firstResult=await boundedTestWait(first,'FIRST_PROCESS_STATUS_TIMEOUT');
    assert.equal(firstResult.code,0,firstResult.stderr);
    assert.equal(JSON.parse(firstResult.stdout.trim()).handoffId,'cross-process-verified-queue');
    const thirdResult=await boundedTestWait(launch(),'THIRD_PROCESS_STATUS_TIMEOUT');
    assert.equal(thirdResult.code,0,thirdResult.stderr);
    assert.equal(JSON.parse(thirdResult.stdout.trim()).handoffId,'cross-process-verified-queue',
      'next process reads the durable verified cached receipt');
    assert.equal((await readFile(marker,'utf8')).trim().split('\n').length,1,
      'restart may never send duplicate handoff');
  }finally{
    if(!releaseGate)await writeFile(gate,'cancel\n').catch(()=>{});
    for(const cp of children)if(cp.exitCode===null && !cp.killed)cp.kill();
    await f.cleanup(manager);
  }
});

test('process crash preserves the original native claim across a different Node process',async()=>{
  const f=await setup();let manager=null;
  const children=[];
  const marker=path.join(f.root,'crashed-process-dispatches.log');
  const gate=path.join(f.root,'crashed-process-gate');
  const childScript=fileURLToPath(new URL('./async-handoff-cross-process-child.mjs',import.meta.url));
  const launch=operationId=>{
    const cp=spawn(process.execPath,[childScript,f.root,operationId,marker,gate],{
      cwd:f.root,stdio:['ignore','pipe','pipe'],windowsHide:true
    });
    let stdout='',stderr='';
    const closed=new Promise((resolve,reject)=>{
      cp.stdout.on('data',chunk=>{stdout+=chunk;});
      cp.stderr.on('data',chunk=>{stderr+=chunk;});
      cp.once('error',reject);
      cp.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));
    });
    children.push(cp);
    return {cp,closed};
  };
  try{
    manager=f.makeManager({...f.protectedDeliveryOrigin,authorizeHandoff:async()=>false});
    const started=await manager.execute('operation_start',{
      requestId:'crashed-owner-real-process',correlationId:'origin-route',
      tool:'run_project_command',arguments:{argv:['sleep','75','ok']},
      continuation:{projectId:'p1',eventKey:'op:crashed-process',root:f.root}
    });
    const terminal=await f.waitFor(manager,started.operationId);
    assert.equal(terminal.status,'SUCCEEDED');
    await manager.close();manager=null;
    const first=launch(started.operationId);
    let entered=false;
    for(let i=0;i<140;i++){
      try{entered=(await readFile(marker,'utf8')).trim().length>0;}
      catch(e){if(e?.code!=='ENOENT')throw e;}
      if(entered)break;
      await sleep(25);
    }
    assert.equal(entered,true,'first process must have started native send');
    // Kill the owner while its native effect is unresolved. There can be no
    // ordinary JS finally/cleanup in the terminated process.
    first.cp.kill();
    await boundedTestWait(first.closed,'CRASHED_PROCESS_DID_NOT_EXIT');
    const claim=JSON.parse(await readFile(path.join(f.root,'operations','operations',
      started.operationId,'native-handoff.claim'),'utf8'));
    assert.equal(claim.schema,1);
    assert.match(claim.handoffKey,/^[a-f0-9]{64}$/);
    const second=launch(started.operationId);
    const row=await boundedTestWait(second.closed,'RECOVERY_PROCESS_WAIT_UNBOUNDED');
    assert.equal(row.code,0,row.stderr);
    const state=JSON.parse(row.stdout.trim());
    assert.equal(state.status,'SUCCEEDED');
    assert.equal(state.pending,true);
    assert.equal(state.handoffId,null);
    assert.equal((await readFile(marker,'utf8')).trim().split('\n').length,1,
      'restarted process must never send a second native handoff');
    const ledger=JSON.parse(await readFile(path.join(f.root,'operations','operations',
      started.operationId,'native-handoff.json'),'utf8'));
    assert.equal(ledger.attempts,1);
    assert.equal(ledger.receipt,null);
  }finally{
    await writeFile(gate,'abort\n').catch(()=>{});
    for(const cp of children)if(cp.exitCode===null&&!cp.killed)cp.kill();
    await f.cleanup(manager);
  }
});
