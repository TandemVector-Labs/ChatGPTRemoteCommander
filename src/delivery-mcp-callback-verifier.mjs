// MCP Events callback verification: signed, one-use challenge via the vetted
// HTTPS transport. Never bypass public-IP DNS pinning or TLS verification.
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
const fail=(code,extra={})=>{throw Object.assign(new Error(code),{code,...extra});};
const callbackFailure=(code,reason)=>fail(code,{
  jsonRpcError:Object.freeze({
    code:-32015,message:'Callback endpoint verification failed',
    data:Object.freeze({reason})
  })
});
const SUB=/^sub_[a-f0-9]{64}$/;
const NONCE=/^[A-Za-z0-9_-]{32}$/;
function secretBytes(value){
  if(typeof value!=='string'||!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(value))
    fail('DELIVERY_CALLBACK_SECRET_INVALID');
  const suffix=value.slice(6);
  const bytes=Buffer.from(suffix,'base64');
  if(bytes.length<24||bytes.length>64
    ||bytes.toString('base64').replace(/=+$/,'')!==suffix.replace(/=+$/,''))
    fail('DELIVERY_CALLBACK_SECRET_INVALID');
  return bytes;
}
export function createMcpEventsCallbackVerifier({
  postVerifiedHttps,now=Date.now,newMessageId=()=>randomBytes(16).toString('hex')
}={}){
  if(typeof postVerifiedHttps!=='function'||typeof now!=='function'
    ||typeof newMessageId!=='function')
    fail('DELIVERY_CALLBACK_TRUSTED_HOST_REQUIRED');
  return Object.freeze({
    async verifyCallback({url,secret,challenge,subscriptionId}={}){
      if(!SUB.test(subscriptionId)||typeof url!=='string'
        ||typeof challenge!=='string'||!NONCE.test(challenge))
        fail('DELIVERY_CALLBACK_INPUT_INVALID');
      const key=secretBytes(secret);
      const suffix=newMessageId();
      if(typeof suffix!=='string'||!/^[a-f0-9]{32}$/.test(suffix))
        fail('DELIVERY_CALLBACK_RANDOM_ID_INVALID');
      const eventId='msg_verification_'+suffix;
      const ms=now();
      if(!Number.isSafeInteger(ms)||ms<0)fail('DELIVERY_CALLBACK_CLOCK_INVALID');
      const timestamp=String(Math.floor(ms/1000));
      const body=JSON.stringify({type:'verification',challenge});
      const signature='v1,'+createHmac('sha256',key)
        .update(eventId+'.'+timestamp+'.'+body).digest('base64');
      let response;
      try{
        response=await postVerifiedHttps(Object.freeze({
          url,body,timeoutMs:5000,noRedirects:true,
          headers:{
            'Content-Type':'application/json','webhook-id':eventId,
            'webhook-timestamp':timestamp,'webhook-signature':signature,
            'X-MCP-Subscription-Id':subscriptionId
          }
        }));
      }catch(error){
        const reason=['DELIVERY_EGRESS_TIMEOUT','ETIMEDOUT','ESOCKETTIMEDOUT']
          .includes(error?.code)?'timeout':'unreachable';
        callbackFailure('DELIVERY_CALLBACK_NOT_REACHABLE',reason);
      }
      if(!response||!Number.isSafeInteger(response.status)
        ||response.status<200||response.status>299
        ||typeof response.body!=='string'||Buffer.byteLength(response.body,'utf8')>8192)
        callbackFailure('DELIVERY_CALLBACK_UNVERIFIED','challenge_failed');
      let payload;
      try{payload=JSON.parse(response.body);}catch{
        callbackFailure('DELIVERY_CALLBACK_UNVERIFIED','challenge_failed');
      }
      if(!payload||typeof payload!=='object'||Array.isArray(payload)
        ||typeof payload.challenge!=='string'
        ||payload.challenge.length!==challenge.length
        ||!timingSafeEqual(Buffer.from(payload.challenge),Buffer.from(challenge)))
        callbackFailure('DELIVERY_CALLBACK_UNVERIFIED','challenge_failed');
      return Object.freeze({verified:true,challenge});
    }
  });
}
