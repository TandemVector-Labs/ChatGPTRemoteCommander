import { assertRouterStatusUrl } from './router-source-bootstrap.mjs';

function parse(argv){
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
  if(!o.url||!Number.isSafeInteger(o.port))throw new Error('ROUTER_STATUS_REQUIRED');
  return o;
}
const o=parse(process.argv.slice(2));
const u=new URL(o.url);
const safeUrl=assertRouterStatusUrl(o.url,Number(u.port));
const r=await fetch(safeUrl,{redirect:'error',signal:AbortSignal.timeout(o.timeoutMs)});
if(!r.ok)throw new Error('ROUTER_STATUS_HTTP_'+r.status);
const s=await r.json();
if(!s?.ok||!s?.router)throw new Error('ROUTER_STATUS_INVALID');
const n=Number(s.inflightByPort?.[String(o.port)]??0);
if(!Number.isSafeInteger(n)||n<0)throw new Error('ROUTER_STATUS_COUNT');
const details=Array.isArray(s.inflightDetailsByPort?.[String(o.port)])?s.inflightDetailsByPort[String(o.port)]:[];
const validDetails=details.filter(x=>x&&typeof x==='object'&&typeof x.cancellable==='boolean');
const cancellableOnly=n>0&&validDetails.length===n&&validDetails.every(x=>x.cancellable===true);
if(o.json)console.log(JSON.stringify({count:n,cancellableOnly,details:validDetails}));
else console.log(n);
