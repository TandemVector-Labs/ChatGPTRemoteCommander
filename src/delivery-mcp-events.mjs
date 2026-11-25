// V1-06: strictly bounded MCP Events projection; no listener or webhook sender.
// All records must be retrieved through createAuthenticatedDeliveryTools(), which
// verifies the owner-bound principal, profile, conversation and grant.
// Webhook 2xx is NOT evidence that a ChatGPT conversation displayed the result.
import { createHash } from 'node:crypto';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const ID=/^[a-f0-9-]{36}$/;
const HASH=/^[a-f0-9]{64}$/;
const READY=new Set(['COMPLETED_UNDELIVERED']);
const KIND=new Set(['COMPLETED','FAILED','UNCERTAIN','WAITING_INPUT','BLOCKED','EXHAUSTED','CANCELLED','PAUSED']);
export const DELIVERY_MCP_EVENT='commander.delivery.ready';
const freezeDeep=value=>{
  if(value && typeof value==='object') {
    for(const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
};
const definition=freezeDeep({
  name:DELIVERY_MCP_EVENT,
  description:'A durable Commander result awaits retrieval for the authenticated conversation.',
  delivery:['webhook'],
  inputSchema:{type:'object',properties:{},additionalProperties:false},
  payloadSchema:{
    type:'object',
    properties:{
      deliveryId:{type:'string',pattern:'^[a-f0-9-]{36}$'},
      kind:{type:'string',enum:[...KIND]},
      status:{type:'string',enum:['pending']}
    },
    required:['deliveryId','kind','status'],
    additionalProperties:false
  }
});
const canonicalDate=value=>{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    ||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)
    fail('DELIVERY_EVENTS_TIMESTAMP_INVALID');
  return value;
};

/**
 * A payload builder for the V1-00 integrator's authenticated MCP Events endpoint.
 * Does not authenticate subscribers, store subscriptions, resolve callback hosts,
 * send webhooks, or acknowledge a delivery. Those are separate acceptance gates.
 * The authenticated adapter must be constructed from V1-01/V1-07 trusted hooks.
 */
export function createDeliveryMcpEventProjection({authenticatedDelivery}={}){
  if(!authenticatedDelivery||typeof authenticatedDelivery.execute!=='function')
    fail('DELIVERY_EVENTS_TRUSTED_ADAPTER_REQUIRED');
  return Object.freeze({
    list(){return {events:[definition]};},
    async project({deliveryId}={}){
      if(typeof deliveryId!=='string'||!ID.test(deliveryId))
        fail('DELIVERY_EVENTS_ID_INVALID');
      const item=await authenticatedDelivery.execute('delivery_get',{deliveryId});
      if(!item||item.deliveryId!==deliveryId||!HASH.test(item.resultHash)
        ||!READY.has(item.state)||!KIND.has(item.kind))
        fail('DELIVERY_EVENTS_NOT_PENDING');
      const timestamp=canonicalDate(item.createdAt);
      // No arbitrary result, command, profile, correlation, owner name or chat text.
      const data={deliveryId,kind:item.kind,status:'pending'};
      const eventId='evt_'+createHash('sha256')
        .update(item.deliveryId+':'+item.resultHash).digest('hex');
      return {eventId,name:DELIVERY_MCP_EVENT,timestamp,data,cursor:null};
    }
  });
}
