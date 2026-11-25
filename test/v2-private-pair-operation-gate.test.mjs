import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MutationIdempotencyStore} from '../src/mutation-idempotency.mjs';
import {readText} from '../src/tools-v0.3.mjs';

import assert from 'node:assert/strict';
import {createV2PrivatePairOperationGate} from '../src/v2-private-pair-operation-gate.mjs';

const SID='a'.repeat(64),TUNNEL='b'.repeat(64),BINDING='c'.repeat(64);
const NOW=1794475200000;
const route=()=>({
  hostId:'pc1',principalId:'accountA',profileId:'profileA',
  conversationId:'chat1',operationId:'step1',
  target:{kind:'workflow-root',id:'project1'}
});
const context=()=>({
  source:'native-owner-attested',
  hostId:'pc1',profileId:'profileA',principalId:'accountA',
  conversationId:'chat1',bindingId:BINDING,ownerSidHash:SID,
  tunnelIdHash:TUNNEL,expiresAtMs:NOW+60000
});
const peer=()=>({
  authenticated:true,peerType:'owner-pinned-private-tunnel-mtls',
  sessionSource:'native-owner-private-pair'
});
function setup(patch={}){
  const state={effects:0,grants:0,attestations:0,ownerChecks:0,leases:0,receipts:0};
  const trusted={
    hostId:'pc1',profileId:'profileA',principalId:'accountA',
    expectedTunnelIdHash:TUNNEL,expectedOwnerSidHash:SID,
    now:()=>NOW,
    attestTransport:async()=>{state.attestations++;return peer();},
    readCurrentOwnerSidHash:async()=>{state.ownerChecks++;return SID;},
    resolveOwnerContext:async()=>context(),
    verifyExactNativeGrant:async({route:r,tool,ownerContext:c})=>{
      state.grants++;
      assert.equal(r.hostId,'pc1');
      assert.equal(tool,'run_shell');
      assert.equal(c.bindingId,BINDING);
      return true;
    },
    withLease:async(key,work)=>{state.leases++;assert.match(key,/project1/);return work();},
    receiptStore:{execute:async(details,work)=>{
      state.receipts++;
      assert.equal(details.tool,'run_shell');
      assert.match(details.requestId,/^[a-f0-9]{64}$/);
      return work();
    }},
    execute:async r=>{state.effects++;return {completed:r.operationId};},
    ...patch
  };
  return {state,gate:createV2PrivatePairOperationGate(trusted)};
}
const call=({request=Object.freeze({}),r=route(),tool='run_shell'}={})=>({
  request,route:r,tool
});

test('owner-pinned private pair checks transport, native context and signed grant at each stage',async()=>{
  const {gate,state}=setup();
  assert.deepEqual(await gate.execute(call()),{completed:'step1'});
  assert.equal(state.effects,1);
  assert.equal(state.receipts,1);
  assert.equal(state.leases,1);
  assert.equal(state.grants,3);
  assert.ok(state.attestations>=7);
  assert.equal(state.ownerChecks,state.attestations*2);
});

test('other account/host/profile cannot borrow same tunnel or invoke verifier',async t=>{
  for(const [name,change] of [
    ['other account',{principalId:'accountB'}],
    ['other host',{hostId:'pc2'}],
    ['other profile',{profileId:'profileB'}]
  ])await t.test(name,async()=>{
    const {gate,state}=setup();
    await assert.rejects(gate.execute(call({r:{...route(),...change}})),
      {code:'V2_PRIVATE_OPERATION_PAIR_MISMATCH'});
    assert.equal(state.attestations,0);
    assert.equal(state.effects,0);
  });
});

test('wrong tunnel transport or stale native owner binding cannot get a lease',async t=>{
  for(const [name,patch,code] of [
    ['plain transport',{attestTransport:async()=>({authenticated:false})},
      'V2_PRIVATE_OPERATION_TRANSPORT_REQUIRED'],
    ['unrelated peer',{attestTransport:async()=>({
      authenticated:true,peerType:'openai-tunnel-client-mtls',
      sessionSource:'openai/session'
    })},'V2_PRIVATE_OPERATION_TRANSPORT_REQUIRED'],
    ['wrong tunnel',{resolveOwnerContext:async()=>({
      ...context(),tunnelIdHash:'d'.repeat(64)
    })},'V2_PRIVATE_OPERATION_BINDING_REQUIRED'],
    ['different owner',{resolveOwnerContext:async()=>({
      ...context(),ownerSidHash:'e'.repeat(64)
    })},'V2_PRIVATE_OPERATION_BINDING_REQUIRED'],
    ['expired binding',{resolveOwnerContext:async()=>({
      ...context(),expiresAtMs:NOW
    })},'V2_PRIVATE_OPERATION_BINDING_REQUIRED'],
    ['wrong conversation',{resolveOwnerContext:async()=>({
      ...context(),conversationId:'chat2'
    })},'V2_PRIVATE_OPERATION_BINDING_REQUIRED']
  ])await t.test(name,async()=>{
    const {gate,state}=setup(patch);
    await assert.rejects(gate.execute(call()),{code});
    assert.equal(state.effects,0);
    assert.equal(state.leases,0);
  });
});

test('native grant revocation before durable receipt denies without effect',async()=>{
  let reads=0;
  const {gate,state}=setup({
    verifyExactNativeGrant:async()=>++reads<2
  });
  await assert.rejects(gate.execute(call()),{code:'V2_GRANT_REQUIRED'});
  assert.equal(state.effects,0);
  assert.equal(state.receipts,0);
  assert.equal(state.leases,1);
});

test('OS owner switches while acquiring global lease: no tool execution',async()=>{
  let changed=false;
  const {gate,state}=setup({
    withLease:async(key,work)=>{changed=true;return work();},
    readCurrentOwnerSidHash:async()=>changed?'e'.repeat(64):SID
  });
  await assert.rejects(gate.execute(call()),{code:'V2_PRIVATE_OPERATION_OWNER_CHANGED'});
  assert.equal(state.effects,0);
});

test('native owner changes during an awaited verification: no side effects',async()=>{
  let sampled=0;
  const {gate,state}=setup({
    readCurrentOwnerSidHash:async()=>++sampled===1?SID:'e'.repeat(64)
  });
  await assert.rejects(gate.execute(call()),{code:'V2_PRIVATE_OPERATION_OWNER_CHANGED'});
  assert.equal(state.effects,0);
  assert.equal(state.leases,0);
});

test('malicious getter/proxy owner context is not evaluated',async()=>{
  let touched=0;
  for(const bad of [
    Object.defineProperty(context(),'tunnelIdHash',{get(){touched++;throw Error('read');}}),
    new Proxy(context(),{get(_target,key){if(key==='then')return undefined;touched++;throw Error('trap');}})
  ]){
    const {gate,state}=setup({resolveOwnerContext:async()=>bad});
    await assert.rejects(gate.execute(call()),
      {code:'V2_PRIVATE_OPERATION_OWNER_CONTEXT_REQUIRED'});
    assert.equal(state.effects,0);
  }
  assert.equal(touched,0);
});

test('untrusted route accessor and Proxy are rejected before transport',async()=>{
  let touched=0;
  for(const r of [
    Object.defineProperty(route(),'principalId',{get(){touched++;throw Error('read');}}),
    new Proxy(route(),{get(){touched++;throw Error('trap');}})
  ]){
    const {gate,state}=setup();
    await assert.rejects(gate.execute(call({r})),{code:'V2_PRIVATE_ROUTE_REQUIRED'});
    assert.equal(state.attestations,0);
  }
  assert.equal(touched,0);
});

test('bootstrap fails closed without trusted native grant verifier',()=>{
  const {gate}=setup();
  assert.equal(typeof gate.execute,'function');
  for(const patch of [
    {verifyExactNativeGrant:undefined},
    {readCurrentOwnerSidHash:undefined},
    {attestTransport:undefined},
    {expectedTunnelIdHash:'wrong'},
    {receiptStore:null}
  ])assert.throws(()=>setup(patch),{code:'V2_PRIVATE_OPERATION_BOOTSTRAP_REQUIRED'});
});

test('grant and effect receive the same immutable exact arguments even across awaits',async()=>{
  let original={command:'echo safe',nested:{flag:'initial'}};
  let grantView, effectView,reads=0;
  const {gate,state}=setup({
    verifyExactNativeGrant:async decision=>{
      grantView=decision.arguments;
      assert.equal(Object.isFrozen(grantView.nested),true);
      return true;
    },
    withLease:async(_key,work)=>{
      original.nested.flag='changed-after-admission';
      original.command='other';
      return work();
    },
    execute:async(_route,args)=>{
      reads++;
      effectView=args;
      return {completed:'step1'};
    }
  });
  assert.deepEqual(await gate.execute({...call(),arguments:original}),{completed:'step1'});
  assert.equal(state.receipts,1);
  assert.equal(reads,1);
  assert.equal(grantView,effectView);
  assert.equal(effectView.command,'echo safe');
  assert.equal(effectView.nested.flag,'initial');
  assert.equal(original.nested.flag,'changed-after-admission');
});

test('untrusted getter, Proxy, cycles, and non-JSON action arguments reject before transport',async()=>{
  let touched=0;
  const invalid=[
    Object.defineProperty({command:'x'},'danger',{enumerable:true,get(){touched++;throw Error('getter');}}),
    new Proxy({command:'x'},{get(){touched++;throw Error('proxy');}}),
    {a:Infinity},
    {a:undefined},
    {a:new Date()},
    {a:{__proto__:null,constructor:'forged'}}
  ];
  const cyclic={};cyclic.self=cyclic;invalid.push(cyclic);
  for(const args of invalid){
    const {gate,state}=setup();
    await assert.rejects(gate.execute({...call(),arguments:args}),
      {code:'V2_PRIVATE_OPERATION_ARGS_INVALID'});
    assert.equal(state.attestations,0);
    assert.equal(state.effects,0);
  }
  assert.equal(touched,0);
});

test('at-most-once receipt detects changed native action arguments on identical operationId',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v012-private-receipts-'));
  const receipts=new MutationIdempotencyStore({directory:dir,scope:'private-pair-qa'});
  let effects=0;
  try{
    const {gate}=setup({
      receiptStore:receipts,
      execute:async(_route,args)=>{
        effects++;
        return {completed:'step1',value:args.command};
      }
    });
    const same=()=>({...call(),arguments:{command:'echo safe'}});
    assert.deepEqual(await gate.execute(same()),{
      completed:'step1',value:'echo safe'
    });
    assert.deepEqual(await gate.execute(same()),{
      completed:'step1',value:'echo safe'
    });
    assert.equal(effects,1,'replay must return durable receipt, not repeat effect');
    await assert.rejects(gate.execute({
      ...call(),arguments:{command:'echo unsafe'}
    }),e=>e?.mutationIdempotencyCode==='MUTATION_REQUEST_ID_CONFLICT');
    assert.equal(effects,1,'changed arguments may never reuse previous receipt');
    assert.equal(receipts.status().states.SUCCEEDED,1);
  }finally{
    receipts.close();
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('two PRIVATE conversations on one pair resolve independent live owner bindings without a global current chat',async()=>{
  const visited=[],grants=[];
  const {gate,state}=setup({
    resolveOwnerContext:async selected=>{
      assert.equal(selected.hostId,'pc1');
      assert.equal(selected.profileId,'profileA');
      const chat=selected.conversationId;
      assert.ok(chat==='chat1'||chat==='chat2');
      visited.push(chat);
      return {...context(),conversationId:chat,
        bindingId:(chat==='chat1'?'c':'d').repeat(64)};
    },
    verifyExactNativeGrant:async ({route:selection,ownerContext:owner})=>{
      grants.push([selection.conversationId,owner.conversationId]);
      return selection.conversationId===owner.conversationId&&
        owner.bindingId===(selection.conversationId==='chat1'?'c':'d').repeat(64);
    },
    withLease:async(_key,work)=>work(),
    execute:async r=>({chat:r.conversationId})
  });
  const first=route();
  const second={...route(),conversationId:'chat2'};
  assert.deepEqual(await Promise.all([
    gate.execute(call({r:first})),
    gate.execute(call({r:second}))
  ]),[{chat:'chat1'},{chat:'chat2'}]);
  assert.ok(visited.includes('chat1')&&visited.includes('chat2'));
  assert.ok(grants.every(([requested,native])=>requested===native));
  assert.equal(state.ownerChecks,state.attestations*2);
});

test('a stale native owner resolver cannot grant a second chat on the same PRIVATE tunnel',async()=>{
  const {gate,state}=setup({
    resolveOwnerContext:async selected=>{
      assert.equal(selected.conversationId,'chat2');
      return context();
    }
  });
  await assert.rejects(gate.execute(call({
    r:{...route(),conversationId:'chat2'}
  })),{code:'V2_PRIVATE_OPERATION_BINDING_REQUIRED'});
  assert.equal(state.effects,0);
});

test('actual read-only Core readText executes only with the exact signed-gate tool identity',async()=>{
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc012-private-real-core-')));
  const file=path.join(root,'approved.txt');
  fs.writeFileSync(file,'source-bridge-evidence\n');
  const receipts=new MutationIdempotencyStore({
    directory:path.join(root,'receipt-store'),scope:'rc012-private-real-core'
  });
  const ctx={roots:[root],auditLog:path.join(root,'audit.jsonl'),
    config:{allowedRoots:[root],maxReadBytes:524288,
      powerMode:{enabled:false,fullFilesystem:false}}};
  let effects=0;
  try{
    const {gate}=setup({
      receiptStore:receipts,
      verifyExactNativeGrant:async({tool,arguments:validated,ownerContext})=>{
        assert.equal(ownerContext.bindingId,BINDING);
        assert.equal(Object.isFrozen(validated),true);
        return tool==='read_text'&&validated.path===file;
      },
      execute:async (_route,args,tool)=>{
        assert.equal(tool,'read_text',
          'real Core effect must receive the SAME tool verified by the grant');
        assert.equal(Object.isFrozen(args),true);
        effects++;
        return readText(ctx,args);
      }
    });
    const action={...call({tool:'read_text'}),arguments:{path:file}};
    const first=await gate.execute(action);
    assert.equal(first.text,'source-bridge-evidence\n');
    assert.equal(first.path,file);
    assert.equal(effects,1);
    const replay=await gate.execute(action);
    assert.deepEqual(replay,first);
    assert.equal(effects,1,'durable replay must not re-run real readText');
    await assert.rejects(gate.execute({...action,tool:'write_text'}),
      {code:'V2_GRANT_REQUIRED'});
    assert.equal(effects,1,'the grant-denied tool cannot call real Core');
    assert.equal(receipts.status().states.SUCCEEDED,1);
  }finally{
    receipts.close();
    fs.rmSync(root,{recursive:true,force:true});
  }
});
