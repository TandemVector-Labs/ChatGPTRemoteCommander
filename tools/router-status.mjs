import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Router status is an internal updater control plane endpoint, not a generic URL client.
const ROUTER_STATUS_URL='http://127.0.0.1:47831/router/status';
export function assertRouterStatusUrl(value){
  if(value!==ROUTER_STATUS_URL)throw new Error('ROUTER_STATUS_URL_DENIED');
  return new URL(ROUTER_STATUS_URL);
}

export function parseRouterStatusArgs(argv){
  const o={timeoutMs:3000,json:false};
  for(let i=0;i<argv.length;i++){
    const a=argv[i];
    if(a==='--json'){o.json=true;continue;}
    const v=argv[++i];if(v===undefined)throw new Error('ROUTER_STATUS_ARGUMENT');
    if(a==='--url')o.url=v;
    else if(a==='--port')o.port=Number(v);
    else if(a==='--timeout-ms')o.timeoutMs=Number(v);
    else throw new Error('ROUTER_STATUS_ARGUMENT');
  }
  if(!o.url||!Number.isSafeInteger(o.port)||o.port<1||o.port>65535)throw new Error('ROUTER_STATUS_REQUIRED');
  if(!Number.isSafeInteger(o.timeoutMs)||o.timeoutMs<250||o.timeoutMs>30000)throw new Error('ROUTER_STATUS_TIMEOUT');
  return o;
}

export async function queryRouterStatus(argv,request=fetch){
  const o=parseRouterStatusArgs(argv);
  assertRouterStatusUrl(o.url); // validate caller input before any HTTP request
  const response=await request(ROUTER_STATUS_URL,{redirect:'error',signal:AbortSignal.timeout(o.timeoutMs)});
  if(!response.ok)throw new Error('ROUTER_STATUS_HTTP_'+response.status);
  const s=await response.json();
  if(!s?.ok||!s?.router)throw new Error('ROUTER_STATUS_INVALID');
  const n=Number(s.inflightByPort?.[String(o.port)]??0);
  if(!Number.isSafeInteger(n)||n<0)throw new Error('ROUTER_STATUS_COUNT');
  const details=Array.isArray(s.inflightDetailsByPort?.[String(o.port)])?s.inflightDetailsByPort[String(o.port)]:[];
  const validDetails=details.filter(x=>x&&typeof x==='object'&&typeof x.cancellable==='boolean');
  const cancellableOnly=n>0&&validDetails.length===n&&validDetails.every(x=>x.cancellable===true);
  return {count:n,cancellableOnly,details:validDetails,json:o.json};
}

const invoked=process.argv[1]?pathToFileURL(path.resolve(process.argv[1])).href:'';
if(invoked===import.meta.url){
  const result=await queryRouterStatus(process.argv.slice(2));
  if(result.json)console.log(JSON.stringify({count:result.count,cancellableOnly:result.cancellableOnly,details:result.details}));
  else console.log(result.count);
}
