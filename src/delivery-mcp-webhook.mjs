// V1-06: deterministic Standard Webhooks envelope for an authenticated event.
// Does NOT send network requests, authorize subscriptions or acknowledge delivery.
// The host must load secret(s) from its encrypted owner-only persistent store.
import {createHmac} from 'node:crypto';
import {DELIVERY_MCP_EVENT} from './delivery-mcp-events.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const EID=/^evt_[a-f0-9]{64}$/;
const SID=/^sub_[a-f0-9]{64}$/;
const UUID=/^[a-f0-9-]{36}$/;
const KINDS=new Set(['COMPLETED','FAILED','UNCERTAIN','WAITING_INPUT','BLOCKED','EXHAUSTED','CANCELLED','PAUSED']);
function pureObject(x,keys){
  if(!x||typeof x!=='object'||Array.isArray(x)
    ||Object.getPrototypeOf(x)!==Object.prototype
    ||Reflect.ownKeys(x).some(k=>typeof k!=='string'||!keys.includes(k)))fail('DELIVERY_WEBHOOK_PAYLOAD_INVALID');
  const result={};
  for(const k of keys){
    const d=Object.getOwnPropertyDescriptor(x,k);
    if(!d||!d.enumerable||!Object.hasOwn(d,'value'))fail('DELIVERY_WEBHOOK_PAYLOAD_INVALID');
    result[k]=d.value;
  }
  return result;
}
function secretBytes(value){
  if(typeof value!=='string'||!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(value))
    fail('DELIVERY_WEBHOOK_SECRET_INVALID');
  const raw=value.slice(6),decoded=Buffer.from(raw,'base64');
  if(decoded.length<24||decoded.length>64
    ||decoded.toString('base64').replace(/=+$/,'')!==raw.replace(/=+$/,''))
    fail('DELIVERY_WEBHOOK_SECRET_INVALID');
  return decoded;
}
function serializeEvent(event){
  const envelope=pureObject(event,['eventId','name','timestamp','data','cursor']);
  if(!EID.test(envelope.eventId)||envelope.name!==DELIVERY_MCP_EVENT
    ||envelope.cursor!==null||typeof envelope.timestamp!=='string'
    ||!Number.isFinite(Date.parse(envelope.timestamp))
    ||new Date(envelope.timestamp).toISOString()!==envelope.timestamp)
    fail('DELIVERY_WEBHOOK_PAYLOAD_INVALID');
  const data=pureObject(envelope.data,['deliveryId','kind','status']);
  if(!UUID.test(data.deliveryId)||!KINDS.has(data.kind)||data.status!=='pending')
    fail('DELIVERY_WEBHOOK_PAYLOAD_INVALID');
  const bytes=JSON.stringify({...envelope,data});
  if(Buffer.byteLength(bytes,'utf8')>262144)fail('DELIVERY_WEBHOOK_PAYLOAD_TOO_LARGE');
  return bytes;
}
export function signDeliveryMcpWebhook({event,subscriptionId,secrets,now=Date.now}={}){
  if(typeof subscriptionId!=='string'||!SID.test(subscriptionId))
    fail('DELIVERY_WEBHOOK_SUBSCRIPTION_INVALID');
  if(!Array.isArray(secrets)||secrets.length<1||secrets.length>2
    ||Object.getPrototypeOf(secrets)!==Array.prototype)
    fail('DELIVERY_WEBHOOK_SECRET_INVALID');
  const keys=secrets.map(secretBytes);
  const body=serializeEvent(event),ms=now();
  if(!Number.isSafeInteger(ms)||ms<0)fail('DELIVERY_WEBHOOK_CLOCK_INVALID');
  const timestamp=String(Math.floor(ms/1000));
  const content=event.eventId+'.'+timestamp+'.'+body;
  const signature=keys.map(key=>'v1,'+createHmac('sha256',key).update(content).digest('base64')).join(' ');
  return Object.freeze({
    body,
    headers:Object.freeze({
      'Content-Type':'application/json',
      'webhook-id':event.eventId,
      'webhook-timestamp':timestamp,
      'webhook-signature':signature,
      'X-MCP-Subscription-Id':subscriptionId
    })
  });
}
