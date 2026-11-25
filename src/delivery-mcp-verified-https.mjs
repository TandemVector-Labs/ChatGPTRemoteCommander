// Authenticated MCP Events egress. Does not use fetch, proxy env vars or
// automatic redirects. DNS is resolved and checked for each outbound request,
// then the validated IP is pinned to the TLS connection.
import {lookup} from 'node:dns/promises';
import {request as httpsRequest} from 'node:https';
import {isIP,BlockList} from 'node:net';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const ipv4Reserved=new BlockList();
for(const [base,prefix] of [
  ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],
  ['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],
  ['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],
  ['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],
  ['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]
]) ipv4Reserved.addSubnet(base,prefix,'ipv4');
const ipv6GlobalUnicast=new BlockList();
ipv6GlobalUnicast.addSubnet('2000::',3,'ipv6');
const ipv6Reserved=new BlockList();
for(const [base,prefix] of [
  ['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]
]) ipv6Reserved.addSubnet(base,prefix,'ipv6');
const HEADER_NAMES=new Set([
  'content-type','webhook-id','webhook-timestamp',
  'webhook-signature','x-mcp-subscription-id'
]);
export function publicWebhookAddress(addr){
  const family=isIP(addr);
  if(family===4){
    const first=Number(addr.split('.')[0]);
    return first>=1&&first<=223&&!ipv4Reserved.check(addr,'ipv4');
  }
  if(family===6){
    return ipv6GlobalUnicast.check(addr,'ipv6')
      &&!ipv6Reserved.check(addr,'ipv6');
  }
  return false;
}

function parseTarget(target){
  if(typeof target!=='string'||target.length>2048
    ||/[\x00-\x20\x7f\\]/.test(target))
    fail('DELIVERY_EGRESS_URL_INVALID');
  let url;
  try{url=new URL(target);}catch{fail('DELIVERY_EGRESS_URL_INVALID');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash
    ||!url.hostname||isIP(url.hostname.replace(/^\[|\]$/g,''))!==0
    ||url.hostname==='localhost'||url.hostname.endsWith('.localhost')
    ||url.hostname.endsWith('.local')||url.hostname.endsWith('.internal'))
    fail('DELIVERY_EGRESS_URL_INVALID');
  return url;
}
function sanitizeHeaders(input){
  if(!input||typeof input!=='object'||Array.isArray(input)
    ||Object.getPrototypeOf(input)!==Object.prototype)
    fail('DELIVERY_EGRESS_HEADERS_INVALID');
  const out=Object.create(null);
  for(const [name,d] of Object.entries(Object.getOwnPropertyDescriptors(input))){
    const normalized=name.toLowerCase();
    if(!d.enumerable||!Object.hasOwn(d,'value')
      ||!HEADER_NAMES.has(normalized)||Object.hasOwn(out,normalized)
      ||typeof d.value!=='string'||d.value.length<1||d.value.length>8192
      ||/[\r\n\x00-\x1f\x7f]/.test(d.value))
      fail('DELIVERY_EGRESS_HEADERS_INVALID');
    out[normalized]=d.value;
  }
  for(const required of HEADER_NAMES)if(!Object.hasOwn(out,required))
    fail('DELIVERY_EGRESS_HEADERS_INVALID');
  if(out['content-type']!=='application/json')fail('DELIVERY_EGRESS_HEADERS_INVALID');
  return Object.freeze(out);
}
export function createVerifiedWebhookHttpsTransport({
  resolveAddresses=lookup,requestHttps=httpsRequest
}={}){
  if(typeof resolveAddresses!=='function'||typeof requestHttps!=='function')
    fail('DELIVERY_EGRESS_HOST_REQUIRED');
  return Object.freeze({
    async postVerifiedHttps({url:target,body,headers,noRedirects=true,timeoutMs=5000,
      authorizeBeforeRequest}={}){
      const endpoint=parseTarget(target);
      if(noRedirects!==true||!Number.isSafeInteger(timeoutMs)
        ||timeoutMs<100||timeoutMs>10000)
        fail('DELIVERY_EGRESS_POLICY_INVALID');
      if(typeof body!=='string'||Buffer.byteLength(body,'utf8')>262144)
        fail('DELIVERY_EGRESS_BODY_INVALID');
      if(authorizeBeforeRequest!==undefined&&typeof authorizeBeforeRequest!=='function')
        fail('DELIVERY_EGRESS_AUTHORIZATION_CALLBACK_INVALID');
      const safeHeaders=sanitizeHeaders(headers);
      // One absolute deadline covers DNS, connection, TLS and full response.
      // Socket-idle timeout alone does not bound a stalled DNS lookup or
      // trickle-fed response. A late DNS answer must never start an HTTP call.
      return new Promise((resolve,reject)=>{
        let ended=false,req;
        const done=(error,result)=>{
          if(ended)return;
          ended=true;
          clearTimeout(deadline);
          if(error)reject(error);else resolve(result);
        };
        const timeoutError=()=>Object.assign(new Error('DELIVERY_EGRESS_TIMEOUT'),
          {code:'DELIVERY_EGRESS_TIMEOUT'});
        const deadline=setTimeout(()=>{
          const error=timeoutError();
          done(error);
          if(req)req.destroy(error);
        },timeoutMs);
        void (async()=>{
          const addresses=await resolveAddresses(endpoint.hostname,{all:true,verbatim:true});
          if(ended)return;
          if(!Array.isArray(addresses)||addresses.length<1||addresses.length>32
            ||addresses.some(row=>!row||typeof row.address!=='string'
              ||(row.family!==4&&row.family!==6)
              ||isIP(row.address)!==row.family||!publicWebhookAddress(row.address)))
            fail('DELIVERY_EGRESS_DNS_UNSAFE');
          const chosen=addresses[0];
          // DNS can take seconds. The original host grant may be revoked while
          // it resolves; require a fresh trusted check before creating a socket.
          // The sender supplies this internal callback, never the MCP client.
          if(authorizeBeforeRequest
            &&await authorizeBeforeRequest()!==true)
            fail('DELIVERY_EGRESS_AUTHORIZATION_DENIED');
          if(ended)return;
          req=requestHttps(endpoint,{
            method:'POST',agent:false,
            rejectUnauthorized:true,
            servername:endpoint.hostname,
            family:chosen.family,autoSelectFamily:false,
            lookup(_host,_opts,callback){
              callback(null,chosen.address,chosen.family);
            },
            headers:{...safeHeaders,'content-length':Buffer.byteLength(body,'utf8')},
            timeout:timeoutMs
          },res=>{
            let size=0,completed=false;
            const chunks=[];
            const interrupted=()=>done(Object.assign(
              new Error('DELIVERY_EGRESS_RESPONSE_INTERRUPTED'),
              {code:'DELIVERY_EGRESS_RESPONSE_INTERRUPTED'}
            ));
            res.on('data',chunk=>{
              size+=chunk.length;
              if(size>8192){
                const error=Object.assign(new Error('DELIVERY_EGRESS_RESPONSE_TOO_LARGE'),
                  {code:'DELIVERY_EGRESS_RESPONSE_TOO_LARGE'});
                done(error);
                req.destroy(error);
                return;
              }
              chunks.push(chunk);
            });
            res.on('end',()=>{
              completed=true;
              done(null,{status:res.statusCode,
                body:Buffer.concat(chunks).toString('utf8')});
            });
            res.on('aborted',interrupted);
            res.on('close',()=>{if(!completed)interrupted();});
            res.on('error',error=>done(error));
          });
          req.on('error',error=>done(error));
          req.on('timeout',()=>{
            const error=timeoutError();
            done(error);
            req.destroy(error);
          });
          if(ended){
            req.destroy();
            return;
          }
          req.end(body,'utf8');
        })().catch(error=>done(error));
      });
    }
  });
}
