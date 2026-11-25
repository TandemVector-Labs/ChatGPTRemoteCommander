// V1-06 MCP Events webhook subscription coordinator (candidate-only).
// Embedding host supplies authenticated identity + independently verified HTTPS
// callback challenge + encrypted private persistent store. No network or listener.
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import {DELIVERY_MCP_EVENT} from './delivery-mcp-events.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EPOCH=/^[a-f0-9]{32,64}$/;
const FIELDS=['hostId','principalId','profileId','conversationId'];
const MAX_TTL=24*60*60*1000;
const DEFAULT_TTL=60*60*1000;
const CALLBACK_VERIFICATION_CACHE_MS=5*60*1000;
function record(value){
  return value!==null&&typeof value==='object'&&!Array.isArray(value)
    &&Object.getPrototypeOf(value)===Object.prototype;
}
function plain(value,allowed){
  if(!record(value))fail('DELIVERY_EVENTS_SUBSCRIPTION_INVALID');
  const copy={};
  for(const [key,d] of Object.entries(Object.getOwnPropertyDescriptors(value))){
    if(!allowed.includes(key)||!d.enumerable||!Object.hasOwn(d,'value'))
      fail('DELIVERY_EVENTS_SUBSCRIPTION_INVALID');
    copy[key]=d.value;
  }
  return copy;
}
function identity(value){
  const i=plain(value,[...FIELDS,'sessionId']);
  if(FIELDS.some(k=>typeof i[k]!=='string'||!ID.test(i[k]))
    ||(Object.hasOwn(i,'sessionId')&&(typeof i.sessionId!=='string'||!ID.test(i.sessionId))))
    fail('DELIVERY_EVENTS_CALLER_UNVERIFIED');
  return Object.freeze(i);
}
function same(a,b){return FIELDS.every(k=>a[k]===b[k]);}
function bound(value,caller){
  const b=plain(value,[...FIELDS,'correlationId','bindingId','sessionId']);
  const declared=Object.fromEntries(FIELDS.map(k=>[k,b[k]]));
  if(!same(identity(declared),caller)||typeof b.correlationId!=='string'||!ID.test(b.correlationId)
    ||typeof b.bindingId!=='string'||!EPOCH.test(b.bindingId))
    fail('DELIVERY_EVENTS_BINDING_MISMATCH');
  if (Object.hasOwn(b,'sessionId')
    && (typeof b.sessionId!=='string'||!ID.test(b.sessionId)))
    fail('DELIVERY_EVENTS_BINDING_SESSION_INVALID');
  return Object.freeze(b);
}
function normalizeUrl(input){
  if(typeof input!=='string'||input.length>2048||input.includes('\\')
    ||/[\x00-\x1F\x7F]/.test(input))fail('DELIVERY_EVENTS_CALLBACK_INVALID');
  let url;
  try{url=new URL(input);}catch{fail('DELIVERY_EVENTS_CALLBACK_INVALID');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||!url.hostname
    ||isIP(url.hostname.replace(/^\[|\]$/g,''))!==0
    ||url.hostname==='localhost'||url.hostname.endsWith('.localhost')
    ||url.hostname.endsWith('.local')||url.hostname.endsWith('.internal'))
    fail('DELIVERY_EVENTS_CALLBACK_INVALID');
  return url.href;
}
function normalizedSecret(input){
  if(typeof input!=='string'||!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(input))
    fail('DELIVERY_EVENTS_SECRET_INVALID');
  const raw=input.slice(6);
  const bytes=Buffer.from(raw,'base64');
  if(bytes.length<24||bytes.length>64
    ||bytes.toString('base64').replace(/=+$/,'')!==raw.replace(/=+$/,''))
    fail('DELIVERY_EVENTS_SECRET_INVALID');
  return input;
}
function parse(input,secretRequired){
  const p=plain(input,['name','arguments','delivery','cursor','ttlMs']);
  if(p.name!==DELIVERY_MCP_EVENT)fail('DELIVERY_EVENTS_NAME_INVALID');
  const filters=plain(p.arguments??{},[]);
  if(Object.keys(filters).length!==0)fail('DELIVERY_EVENTS_FILTER_INVALID');
  if(p.cursor!==undefined&&p.cursor!==null)fail('DELIVERY_EVENTS_CURSOR_UNSUPPORTED');
  // MCP Events permits null to request a non-expiring subscription; this
  // server declines that request by granting a finite default lifetime.
  if(p.ttlMs!==undefined&&p.ttlMs!==null&&(typeof p.ttlMs!=='number'||!Number.isSafeInteger(p.ttlMs)
    ||p.ttlMs<60000||p.ttlMs>MAX_TTL))fail('DELIVERY_EVENTS_TTL_INVALID');
  const delivery=plain(p.delivery,secretRequired?['mode','url','secret']:['mode','url']);
  if(delivery.mode!=='webhook')fail('DELIVERY_EVENTS_MODE_INVALID');
  const url=normalizeUrl(delivery.url);
  const secret=secretRequired?normalizedSecret(delivery.secret):null;
  return {url,secret,ttlMs:p.ttlMs??DEFAULT_TTL};
}
function digest(value){return createHash('sha256').update(value).digest('hex');}
const json=value=>JSON.stringify(value);

/**
 * IMPORTANT: This module never sends webhooks. The trusted host verifier must
 * perform public-address DNS pinning, TLS verification, signed single-use
 * challenge, bounded redirects (none), timeout and response comparison.
 * secureStore must be durable, transactional and owner-private; sealSecret must
 * encrypt secrets before storage. These callbacks are NOT MCP tool arguments.
 */
export function createAuthenticatedMcpEventSubscriptions({
  observeCaller,resolveBinding,authorizeSubscription,verifyCallback,
  sealSecret,secureStore,now=Date.now
}={}){
  if([observeCaller,resolveBinding,authorizeSubscription,verifyCallback,sealSecret,now]
    .some(fn=>typeof fn!=='function')
    ||!secureStore||typeof secureStore.upsert!=='function'
    ||typeof secureStore.remove!=='function')
    fail('DELIVERY_EVENTS_TRUSTED_HOST_REQUIRED');

  const reattest=async(expected,correlationId,bindingId,sessionId)=>{
    const c=identity(await observeCaller());
    if(!same(c,expected))fail('DELIVERY_EVENTS_SESSION_CHANGED');
    const b=bound(await resolveBinding(c),c);
    if(b.correlationId!==correlationId||b.bindingId!==bindingId)
      fail('DELIVERY_EVENTS_BINDING_CHANGED');
    if((b.sessionId??null)!==sessionId)
      fail('DELIVERY_EVENTS_SESSION_CHANGED');
  };
  const authorize=async(action,caller,correlationId,bindingId,url)=>{
    if(await authorizeSubscription(Object.freeze({action,caller,correlationId,bindingId,
      eventName:DELIVERY_MCP_EVENT,callbackUrl:url}))!==true)
      fail('DELIVERY_EVENTS_SUBSCRIPTION_DENIED');
  };
  const keyFor=(caller,correlationId,bindingId,url)=>'sub_'+digest(json([
    ...FIELDS.map(k=>caller[k]),correlationId,bindingId,DELIVERY_MCP_EVENT,url
  ]));
  // A callback challenge may await network I/O while the owner unsubscribes.
  // Cancel earlier pending registrations at once, and sequence private-store
  // writes for the same owner-bound subscription so unsubscribe wins even if
  // a registration was already inside an asynchronous upsert.
  const pending=new Map();
  const writes=new Map();
  const track=id=>{
    const ticket={active:true};
    let tickets=pending.get(id);
    if(!tickets){tickets=new Set();pending.set(id,tickets);}
    tickets.add(ticket);
    return ticket;
  };
  const untrack=(id,ticket)=>{
    const tickets=pending.get(id);
    tickets?.delete(ticket);
    if(tickets?.size===0)pending.delete(id);
  };
  const supersede=id=>{
    for(const ticket of pending.get(id)??[])ticket.active=false;
  };
  const serialized=async(id,action)=>{
    const prior=writes.get(id)??Promise.resolve();
    let release;
    const fence=new Promise(resolve=>{release=resolve;});
    writes.set(id,fence);
    await prior;
    try{return await action();}
    finally{
      release();
      if(writes.get(id)===fence)writes.delete(id);
    }
  };
  return Object.freeze({
    async subscribe(input){
      const req=parse(input,true);
      const caller=identity(await observeCaller());
      const binding=bound(await resolveBinding(caller),caller);
      await authorize('subscribe',caller,binding.correlationId,binding.bindingId,req.url);
      const id=keyFor(caller,binding.correlationId,binding.bindingId,req.url);
      const ticket=track(id);
      try{
      const scope=digest(json(FIELDS.map(k=>caller[k])));
      const bindingKey=digest(json([binding.correlationId,binding.bindingId]));
      // The production private store supplies a durable generation read:
      // a revoke in a different process must invalidate this registration
      // even if its remote callback verification finishes much later.
      const expectedGeneration=typeof secureStore.registrationGeneration==='function'
        ? await secureStore.registrationGeneration({id,scope,bindingKey})
        : undefined;
      if(expectedGeneration!==undefined
        &&(!Number.isSafeInteger(expectedGeneration)||expectedGeneration<0))
        fail('DELIVERY_EVENTS_REGISTRATION_FENCE_INVALID');
      const callbackHash=digest(req.url);
      const secretHash=digest(req.secret);
      const cacheAt=now();
      if(!Number.isSafeInteger(cacheAt)||cacheAt<0)
        fail('DELIVERY_EVENTS_CLOCK_INVALID');
      const cached=typeof secureStore.hasCallbackVerification==='function'
        && await secureStore.hasCallbackVerification({
          scope,callbackHash,secretHash,at:cacheAt
        })===true;
      if(!cached){
        const challenge=randomBytes(24).toString('base64url');
        const proof=await verifyCallback(Object.freeze({
          url:req.url,secret:req.secret,challenge,subscriptionId:id,
          caller,correlationId:binding.correlationId,bindingId:binding.bindingId
        }));
        if(!record(proof)||proof.verified!==true
          ||typeof proof.challenge!=='string'||proof.challenge.length!==challenge.length
          ||!timingSafeEqual(Buffer.from(proof.challenge),Buffer.from(challenge)))
          fail('DELIVERY_EVENTS_CALLBACK_UNVERIFIED');
      }
      await reattest(caller,binding.correlationId,binding.bindingId,binding.sessionId??null);
      await authorize('subscribe',caller,binding.correlationId,binding.bindingId,req.url);
      await reattest(caller,binding.correlationId,binding.bindingId,binding.sessionId??null);
      if(!cached&&typeof secureStore.rememberCallbackVerification==='function'){
        if(!ticket.active)fail('DELIVERY_EVENTS_SUBSCRIPTION_SUPERSEDED');
        const verifiedAt=now();
        if(!Number.isSafeInteger(verifiedAt)||verifiedAt<0
          ||verifiedAt>Number.MAX_SAFE_INTEGER-CALLBACK_VERIFICATION_CACHE_MS)
          fail('DELIVERY_EVENTS_CLOCK_INVALID');
        await secureStore.rememberCallbackVerification({
          id,scope,bindingKey,expectedGeneration,callbackHash,secretHash,
          verifiedAt:new Date(verifiedAt).toISOString(),
          expiresAt:new Date(verifiedAt+CALLBACK_VERIFICATION_CACHE_MS).toISOString()
        });
      }
      const sealed=await sealSecret(req.secret);
      if(typeof sealed!=='string'||sealed.length<1||sealed===req.secret)
        fail('DELIVERY_EVENTS_SECRET_NOT_SEALED');
      await reattest(caller,binding.correlationId,binding.bindingId,binding.sessionId??null);
      // An owner grant can be revoked while a platform secret store awaits I/O.
      // The production private store must also enforce grant/route at commit.
      await authorize('subscribe',caller,binding.correlationId,binding.bindingId,req.url);
      await reattest(caller,binding.correlationId,binding.bindingId,binding.sessionId??null);
      const ts=now();
      if(!Number.isSafeInteger(ts)||ts<0)fail('DELIVERY_EVENTS_CLOCK_INVALID');
      const refreshBefore=new Date(ts+req.ttlMs).toISOString();
      const row=Object.freeze({
        id,scope,bindingKey,name:DELIVERY_MCP_EVENT,
        callbackUrl:req.url,sealedSecret:sealed,refreshBefore,
        verifiedAt:new Date(ts).toISOString(),
        ...(expectedGeneration===undefined?{}:{expectedGeneration})
      });
      await serialized(id,async()=>{
        if(!ticket.active)fail('DELIVERY_EVENTS_SUBSCRIPTION_SUPERSEDED');
        await secureStore.upsert(row);
        if(!ticket.active)fail('DELIVERY_EVENTS_SUBSCRIPTION_SUPERSEDED');
      });
      return {id,refreshBefore,cursor:null,truncated:false};
      }finally{untrack(id,ticket);}
    },
    async unsubscribe(input){
      const req=parse(input,false);
      const caller=identity(await observeCaller());
      const binding=bound(await resolveBinding(caller),caller);
      await authorize('unsubscribe',caller,binding.correlationId,binding.bindingId,req.url);
      await reattest(caller,binding.correlationId,binding.bindingId,binding.sessionId??null);
      const id=keyFor(caller,binding.correlationId,binding.bindingId,req.url);
      supersede(id);
      const row=Object.freeze({
        id,scope:digest(json(FIELDS.map(k=>caller[k]))),
        bindingKey:digest(json([binding.correlationId,binding.bindingId]))
      });
      await serialized(id,()=>secureStore.remove(row));
      return {};
    }
  });
}
