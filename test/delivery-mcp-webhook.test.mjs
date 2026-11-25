import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {signDeliveryMcpWebhook} from '../src/delivery-mcp-webhook.mjs';
import {DELIVERY_MCP_EVENT} from '../src/delivery-mcp-events.mjs';

const event=()=>({
  eventId:'evt_'+'a'.repeat(64),
  name:DELIVERY_MCP_EVENT,
  timestamp:'2026-11-06T01:00:00.000Z',
  data:{deliveryId:'12345678-1234-1234-1234-123456789abc',kind:'COMPLETED',status:'pending'},
  cursor:null
});
const subscriptionId='sub_'+'b'.repeat(64);
const key=Buffer.alloc(32,7);
const secret='whsec_'+key.toString('base64');
function sign(args={}){return signDeliveryMcpWebhook({
  event:event(),subscriptionId,secrets:[secret],now:()=>Date.UTC(2026,10,6,1,0,1),...args
});}
test('signs exact body bytes and metadata using Standard Webhooks v1 HMAC',()=>{
  const e=event(),r=sign();
  assert.deepEqual(JSON.parse(r.body),e);
  assert.equal(r.headers['Content-Type'],'application/json');
  assert.equal(r.headers['webhook-id'],e.eventId);
  assert.equal(r.headers['webhook-timestamp'],'1793926801');
  assert.equal(r.headers['X-MCP-Subscription-Id'],subscriptionId);
  const text=e.eventId+'.'+r.headers['webhook-timestamp']+'.'+r.body;
  assert.equal(r.headers['webhook-signature'],'v1,'+createHmac('sha256',key).update(text).digest('base64'));
  assert.equal(Object.isFrozen(r.headers),true);
  assert.equal(JSON.stringify(r).includes(secret),false);
});
test('retries preserve event ID and bytes but freshly timestamp the signature',()=>{
  const a=sign(),b=sign({now:()=>Date.UTC(2026,10,6,1,0,4)});
  assert.equal(a.headers['webhook-id'],b.headers['webhook-id']);
  assert.equal(a.body,b.body);
  assert.notEqual(a.headers['webhook-timestamp'],b.headers['webhook-timestamp']);
  assert.notEqual(a.headers['webhook-signature'],b.headers['webhook-signature']);
});
test('body modification invalidates original signature',()=>{
  const r=sign();
  const changed=r.body.replace('COMPLETED','FAILED');
  const forged=createHmac('sha256',key)
    .update(r.headers['webhook-id']+'.'+r.headers['webhook-timestamp']+'.'+changed)
    .digest('base64');
  assert.notEqual(r.headers['webhook-signature'],'v1,'+forged);
});
test('rotation sends bounded space-delimited v1 signatures without disclosing either key',()=>{
  const next=Buffer.alloc(32,8),nextSecret='whsec_'+next.toString('base64');
  const r=sign({secrets:[secret,nextSecret]});
  const entries=r.headers['webhook-signature'].split(' ');
  assert.equal(entries.length,2);
  const text=r.headers['webhook-id']+'.'+r.headers['webhook-timestamp']+'.'+r.body;
  assert.equal(entries[0],'v1,'+createHmac('sha256',key).update(text).digest('base64'));
  assert.equal(entries[1],'v1,'+createHmac('sha256',next).update(text).digest('base64'));
  assert.equal(JSON.stringify(r).includes(nextSecret),false);
});
test('rejects wrong subscription and malformed or oversized signing keys',()=>{
  assert.throws(()=>sign({subscriptionId:'self-reported'}),/DELIVERY_WEBHOOK_SUBSCRIPTION_INVALID/);
  assert.throws(()=>sign({secrets:[]}),/DELIVERY_WEBHOOK_SECRET_INVALID/);
  assert.throws(()=>sign({secrets:['whsec_bad']}),/DELIVERY_WEBHOOK_SECRET_INVALID/);
  assert.throws(()=>sign({secrets:['whsec_'+Buffer.alloc(65).toString('base64')]}),
    /DELIVERY_WEBHOOK_SECRET_INVALID/);
  assert.throws(()=>sign({secrets:[secret,secret,secret]}),/DELIVERY_WEBHOOK_SECRET_INVALID/);
});
test('only the schema-authorized minimal event fields can be signed',()=>{
  const e=event();e.data.text='private output';
  assert.throws(()=>sign({event:e}),/DELIVERY_WEBHOOK_PAYLOAD_INVALID/);
  const another=event();another.systemPrompt='injected';
  assert.throws(()=>sign({event:another}),/DELIVERY_WEBHOOK_PAYLOAD_INVALID/);
  const accessor=event();Object.defineProperty(accessor.data,'kind',{
    get(){throw Error('GETTER_WAS_EVALUATED');},enumerable:true
  });
  assert.throws(()=>sign({event:accessor}),/DELIVERY_WEBHOOK_PAYLOAD_INVALID/);
  assert.throws(()=>sign({event:{...event(),timestamp:'2026-11-06T01:00:00'}}),
    /DELIVERY_WEBHOOK_PAYLOAD_INVALID/);
});
test('rejects invalid event ID, status and clock before returning signatures',()=>{
  assert.throws(()=>sign({event:{...event(),eventId:'evt_wrong'}}),/DELIVERY_WEBHOOK_PAYLOAD_INVALID/);
  const pending=event();pending.data.status='DELIVERED';
  assert.throws(()=>sign({event:pending}),/DELIVERY_WEBHOOK_PAYLOAD_INVALID/);
  assert.throws(()=>sign({now:()=>NaN}),/DELIVERY_WEBHOOK_CLOCK_INVALID/);
});
