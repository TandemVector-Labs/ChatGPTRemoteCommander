// V1-06 owner-only runtime replacement barrier for trusted Host key rotation.
// All public calls are leased against one runtime generation. Rotation blocks new
// calls, drains the old generation, then swaps verifiers without replacing either
// durable store. The stores remain owned and closed by the embedding Host.
import {createProtectedDeliveryMcpEventsRuntimeWithSignedPresentation,
  createProtectedDeliveryMcpEventsRuntimeWithSignedChatIdentity}
  from './delivery-mcp-host-runtime.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const METHODS=Object.freeze(['events/list','events/subscribe','events/unsubscribe']);
const compose=options=>Object.hasOwn(options,'chatContext')
  ? createProtectedDeliveryMcpEventsRuntimeWithSignedChatIdentity(options)
  : createProtectedDeliveryMcpEventsRuntimeWithSignedPresentation(options);

export function createRotatingProtectedDeliveryMcpEventsRuntime(initialOptions={}){
  if(!initialOptions||typeof initialOptions!=='object'||Array.isArray(initialOptions))
    fail('DELIVERY_EVENTS_RUNTIME_CONFIG_INVALID');
  const deliveryStore=initialOptions.deliveryStore;
  const subscriptionStore=initialOptions.subscriptionStore;
  if(!deliveryStore||!subscriptionStore)
    fail('DELIVERY_EVENTS_RUNTIME_STORE_REQUIRED');

  let runtime=compose(initialOptions);
  let protectedChatMode=Object.hasOwn(initialOptions,'chatContext');
  let generation=1;
  let activeCalls=0;
  let pendingWriters=0;
  let writerActive=false;
  let closed=false;
  let closePromise=null;
  let writerTail=Promise.resolve();
  const readerWaiters=[];
  const drainWaiters=[];

  const wakeReaders=()=>{
    if(pendingWriters!==0||writerActive)return;
    for(const resolve of readerWaiters.splice(0))resolve();
  };
  const release=()=>{
    activeCalls--;
    if(activeCalls===0)
      for(const resolve of drainWaiters.splice(0))resolve();
  };
  const enter=async()=>{
    while(pendingWriters!==0||writerActive)
      await new Promise(resolve=>readerWaiters.push(resolve));
    if(closed||!runtime)fail('DELIVERY_EVENTS_RUNTIME_CLOSED');
    activeCalls++;
    return runtime;
  };
  const invoke=(callback,...args)=>(async()=>{
    const selected=await enter();
    try{return await callback(selected,...args);}
    finally{release();}
  })();

  // FIFO writer queue: once rotation is requested, new readers wait. Existing
  // calls finish on the old verifier; the swap is not reported complete until
  // every old-generation call has released its lease. The Host must revoke the
  // retired issuer key only after rotate() resolves; this is graceful cutover.
  const exclusive=(action,{allowClosed=false}={})=>{
    pendingWriters++;
    const task=writerTail.then(async()=>{
      let acquired=false;
      try{
        if(closed&&!allowClosed)fail('DELIVERY_EVENTS_RUNTIME_CLOSED');
        const drainedCalls=activeCalls;
        if(drainedCalls>0)
          await new Promise(resolve=>drainWaiters.push(resolve));
        if(closed&&!allowClosed)fail('DELIVERY_EVENTS_RUNTIME_CLOSED');
        writerActive=true;
        acquired=true;
        return await action({drainedCalls});
      }finally{
        if(acquired)writerActive=false;
        pendingWriters--;
        wakeReaders();
      }
    });
    writerTail=task.catch(()=>{});
    return task;
  };

  const rotate=nextOptions=>{
    if(closed)fail('DELIVERY_EVENTS_RUNTIME_CLOSED');
    if(!nextOptions||typeof nextOptions!=='object'||Array.isArray(nextOptions))
      fail('DELIVERY_EVENTS_RUNTIME_CONFIG_INVALID');
    // Durable delivery and subscription state must survive verifier replacement
    // in the exact same open SQLite store instances.
    if(nextOptions.deliveryStore!==deliveryStore
      ||nextOptions.subscriptionStore!==subscriptionStore)
      fail('DELIVERY_EVENTS_RUNTIME_STORE_REPLACEMENT_FORBIDDEN');
    // Construct before taking the write barrier: invalid trust material leaves
    // the currently serving runtime untouched.
    const nextUsesSignedChat=Object.hasOwn(nextOptions,'chatContext');
    if(protectedChatMode&&!nextUsesSignedChat)
      fail('DELIVERY_EVENTS_RUNTIME_TRUST_DOWNGRADE_FORBIDDEN');
    const nextRuntime=compose(nextOptions);
    return exclusive(({drainedCalls})=>{
      if(closed)fail('DELIVERY_EVENTS_RUNTIME_CLOSED');
      // An earlier queued upgrade can finish after this rotation was queued.
      // Enforce monotonic trust at the actual writer boundary too.
      if(protectedChatMode&&!nextUsesSignedChat)
        fail('DELIVERY_EVENTS_RUNTIME_TRUST_DOWNGRADE_FORBIDDEN');
      const previousGeneration=generation;
      runtime=nextRuntime;
      protectedChatMode=protectedChatMode||nextUsesSignedChat;
      generation++;
      return Object.freeze({previousGeneration,generation,drainedCalls});
    });
  };

  const close=()=>{
    if(closePromise)return closePromise;
    closePromise=exclusive(()=>{
      closed=true;
      runtime=null;
      return Object.freeze({closed:true,generation});
    },{allowClosed:true});
    return closePromise;
  };

  const methods=Object.freeze(Object.fromEntries(METHODS.map(name=>[
    name,input=>invoke((selected,value)=>selected.methods[name](value),input)
  ])));
  const protectedDelivery=Object.freeze({
    execute:(name,input)=>invoke((selected,method,args)=>selected.protectedDelivery.execute(method,args),name,input)
  });
  const dispatchHostEvent=input=>invoke((selected,value)=>selected.dispatchHostEvent(value),input);
  const status=()=>Object.freeze({
    generation,activeCalls,pendingRotations:pendingWriters,
    rotationInProgress:pendingWriters>0||writerActive,closed
  });

  return Object.freeze({methods,protectedDelivery,dispatchHostEvent,rotate,close,status});
}
