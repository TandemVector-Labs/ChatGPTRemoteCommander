// V1-06 MCP Events send coordinator. Requires independently authenticated
// caller, owner-private subscription store and a host-verified HTTPS transport.
// A webhook 2xx is NOT a delivery_ack and never marks the result as DELIVERED.
import {createHash} from 'node:crypto';
import {signDeliveryMcpWebhook} from './delivery-mcp-webhook.mjs';
import {DELIVERY_MCP_EVENT} from './delivery-mcp-events.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const HASH=/^[a-f0-9]{64}$/;
const SID=/^sub_[a-f0-9]{64}$/;
const UUID=/^[a-f0-9-]{36}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EPOCH=/^[a-f0-9]{32,64}$/;
const epoch=b=>{
  const field=b&&Object.getOwnPropertyDescriptor(b,'bindingId');
  if(!field||!Object.hasOwn(field,'value')||typeof field.value!=='string'
    ||!EPOCH.test(field.value))fail('DELIVERY_SEND_BINDING_EPOCH_REQUIRED');
  return field.value;
};
const FIELDS=['hostId','principalId','profileId','conversationId'];
const trustedSessionId=b=>{
  const d=b&&Object.getOwnPropertyDescriptor(b,'sessionId');
  if(!d)return null;
  if(!Object.hasOwn(d,'value')||typeof d.value!=='string'||!ID.test(d.value))
    fail('DELIVERY_SEND_BINDING_SESSION_INVALID');
  return d.value;
};
// Only positively classified temporary network faults are eligible for retry.
// Unknown exceptions (including TLS/SSL protocol failures) are terminal.
const TRANSIENT_NETWORK_ERRORS=new Set([
  'ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','EPIPE',
  'ECONNABORTED','ENETUNREACH','EHOSTUNREACH'
]);
const digest=text=>createHash('sha256').update(text).digest('hex');
const exact=value=>{
  if(!value||typeof value!=='object'||Array.isArray(value)
    ||FIELDS.some(k=>typeof value[k]!=='string'||!ID.test(value[k])))
    fail('DELIVERY_SEND_CALLER_UNVERIFIED');
  const sessionId=trustedSessionId(value);
  return Object.freeze({
    ...Object.fromEntries(FIELDS.map(k=>[k,value[k]])),
    ...(sessionId===null?{}:{sessionId})
  });
};
const same=(a,b)=>FIELDS.every(k=>a[k]===b[k]);
export function createDeliveryWebhookSender({
  projection,subscriptions,observeCaller,resolveBinding,authorizeSend,
  unsealSecret,postVerifiedHttps,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))
}={}){
  if(!projection||typeof projection.project!=='function'
    ||!subscriptions||typeof subscriptions.getActive!=='function'
    ||[observeCaller,resolveBinding,authorizeSend,unsealSecret,postVerifiedHttps,now,sleep]
      .some(x=>typeof x!=='function'))
    fail('DELIVERY_SEND_TRUSTED_HOST_REQUIRED');
  const reattest=async(original,correlation,bindingId,sessionId)=>{
    const caller=exact(await observeCaller());
    if(!same(caller,original))fail('DELIVERY_SEND_SESSION_CHANGED');
    const b=await resolveBinding(caller);
    if(!b||!same(exact(b),caller)||b.correlationId!==correlation
      ||epoch(b)!==bindingId)
      fail('DELIVERY_SEND_BINDING_CHANGED');
    if(trustedSessionId(b)!==sessionId)
      fail('DELIVERY_SEND_SESSION_CHANGED');
  };
  return Object.freeze({
    async send({deliveryId,subscriptionId}={}){
      if(typeof deliveryId!=='string'||!UUID.test(deliveryId)
        ||typeof subscriptionId!=='string'||!SID.test(subscriptionId))
        fail('DELIVERY_SEND_ID_INVALID');
      const caller=exact(await observeCaller());
      const binding=await resolveBinding(caller);
      if(!binding||!same(exact(binding),caller)
        ||typeof binding.correlationId!=='string'||!ID.test(binding.correlationId))
        fail('DELIVERY_SEND_BINDING_MISMATCH');
      const bindingId=epoch(binding);
      const sessionId=trustedSessionId(binding);
      const scope=digest(JSON.stringify(FIELDS.map(k=>caller[k])));
      const bindingKey=digest(JSON.stringify([binding.correlationId,bindingId]));
      const event=await projection.project({deliveryId});
      if(event.name!==DELIVERY_MCP_EVENT)fail('DELIVERY_SEND_EVENT_INVALID');
      const assertPending=async()=>{
        const current=await projection.project({deliveryId});
        if(current.eventId!==event.eventId||current.name!==event.name)
          fail('DELIVERY_SEND_EVENT_STALE');
      };
      await reattest(caller,binding.correlationId,bindingId,sessionId);
      let attempts=0;
      for(let n=0;n<3;n++){
        // Another worker may have claimed or ACKed while the retry slept.
        await assertPending();
        await reattest(caller,binding.correlationId,bindingId,sessionId);
        const row=subscriptions.getActive({
          id:subscriptionId,scope,bindingKey,at:now()
        });
        if(!row)fail('DELIVERY_SEND_SUBSCRIPTION_INACTIVE');
        if(row.name!==DELIVERY_MCP_EVENT||!HASH.test(row.bindingKey)||row.bindingKey!==bindingKey)
          fail('DELIVERY_SEND_SUBSCRIPTION_MISMATCH');
        const decision=Object.freeze({
          caller,correlationId:binding.correlationId,bindingId,subscriptionId,
          deliveryId,eventId:event.eventId
        });
        if(await authorizeSend(decision)!==true)fail('DELIVERY_SEND_GRANT_REQUIRED');
        await reattest(caller,binding.correlationId,bindingId,sessionId);
        const secret=await unsealSecret(row.sealedSecret);
        const secrets=[secret];
        // During a bounded signing-key refresh window, sign once with each
        // owner-sealed key so the authenticated subscriber can transition.
        if(row.previousSealedSecret&&typeof row.previousUntil==='string'
          &&row.previousUntil>new Date(now()).toISOString()){
          const prior=await unsealSecret(row.previousSealedSecret);
          if(prior!==secret)secrets.push(prior);
        }
        await reattest(caller,binding.correlationId,bindingId,sessionId);
        // The subscription can be revoked, expired or re-keyed while the host
        // decrypts its secret. Never send with a stale URL or signing key.
        const currentSubscription=subscriptions.getActive({
          id:subscriptionId,scope,bindingKey,at:now()
        });
        if(!currentSubscription
          ||currentSubscription.callbackUrl!==row.callbackUrl
          ||currentSubscription.sealedSecret!==row.sealedSecret
          ||currentSubscription.previousSealedSecret!==row.previousSealedSecret
          ||currentSubscription.previousUntil!==row.previousUntil)
          fail('DELIVERY_SEND_SUBSCRIPTION_CHANGED');
        // Secret stores can await native I/O. Refresh the grant before any
        // network effect; final enforcement also belongs at the HTTPS boundary.
        if(await authorizeSend(decision)!==true)fail('DELIVERY_SEND_GRANT_REQUIRED');
        await reattest(caller,binding.correlationId,bindingId,sessionId);
        const request=signDeliveryMcpWebhook({
          event,subscriptionId,secrets,now
        });
        // Recheck after async secret unsealing and grants. An event already
        // acknowledged through another path must not be sent from stale state.
        await assertPending();
        await reattest(caller,binding.correlationId,bindingId,sessionId);
        // A binding callback may finish after the owner's grant was revoked;
        // renew the grant again before the last synchronous subscription read.
        if(await authorizeSend(decision)!==true)
          fail('DELIVERY_SEND_GRANT_REQUIRED');
        // The final grant check can itself allow a peer to ACK the result.
        // A completed result must not be announced as still pending.
        await assertPending();
        // Projection may still resolve the result after an asynchronous grant
        // switched the active chat while retaining a legacy correlation/epoch.
        // Re-pin the original caller after the last awaited authorization.
        await reattest(caller,binding.correlationId,bindingId,sessionId);
        // The last authorization and session checks can themselves await
        // native callbacks. Read the owner-bound subscription once more
        // synchronously, immediately before any outbound network effect.
        const finalSubscription=subscriptions.getActive({
          id:subscriptionId,scope,bindingKey,at:now()
        });
        if(!finalSubscription
          ||finalSubscription.callbackUrl!==row.callbackUrl
          ||finalSubscription.sealedSecret!==row.sealedSecret
          ||finalSubscription.previousSealedSecret!==row.previousSealedSecret
          ||finalSubscription.previousUntil!==row.previousUntil)
          fail('DELIVERY_SEND_SUBSCRIPTION_CHANGED');
        attempts++;
        let status;
        try{
          const reply=await postVerifiedHttps(Object.freeze({
            url:row.callbackUrl,body:request.body,headers:request.headers,
            noRedirects:true,timeoutMs:5000,
            // DNS resolution is asynchronous: the grant, chat or subscription
            // can be revoked before HTTPS creates its socket. The production
            // verified transport calls this after DNS and before requestHttps.
            authorizeBeforeRequest:async()=>{
              await reattest(caller,binding.correlationId,bindingId,sessionId);
              if(await authorizeSend(decision)!==true)
                fail('DELIVERY_SEND_GRANT_REQUIRED');
              await reattest(caller,binding.correlationId,bindingId,sessionId);
              await assertPending();
              await reattest(caller,binding.correlationId,bindingId,sessionId);
              const live=subscriptions.getActive({
                id:subscriptionId,scope,bindingKey,at:now()
              });
              if(!live||live.callbackUrl!==row.callbackUrl
                ||live.sealedSecret!==row.sealedSecret
                ||live.previousSealedSecret!==row.previousSealedSecret
                ||live.previousUntil!==row.previousUntil)
                fail('DELIVERY_SEND_SUBSCRIPTION_CHANGED');
              return true;
            }
          }));
          status=reply?.status;
        }catch(error){
          // Fail closed on unknown errors and security-sensitive TLS/SSL or
          // egress-policy failures. Do not reinterpret them as HTTP 503.
          if(!TRANSIENT_NETWORK_ERRORS.has(error?.code))throw error;
          status=503;
        }
        // Do not report a trusted receipt if the desktop/chat identity changed
        // while the verified transport awaited network I/O.
        await reattest(caller,binding.correlationId,bindingId,sessionId);
        if(!Number.isSafeInteger(status)||status<100||status>599)
          fail('DELIVERY_SEND_RESPONSE_INVALID');
        if(status>=200&&status<300)
          return {eventId:event.eventId,deliveryId,webhookAccepted:true,
            resultDeliveryAcknowledged:false,attempts,status};
        if(status===410||status===413)
          return {eventId:event.eventId,deliveryId,webhookAccepted:false,
            resultDeliveryAcknowledged:false,attempts,status,terminal:true};
        if(!(status===408||status===429||status>=500))
          return {eventId:event.eventId,deliveryId,webhookAccepted:false,
            resultDeliveryAcknowledged:false,attempts,status,terminal:true};
        if(n<2)await sleep(100*(2**n));
      }
      return {eventId:event.eventId,deliveryId,webhookAccepted:false,
        resultDeliveryAcknowledged:false,attempts,terminal:false,
        retryExhausted:true};
    }
  });
}
