import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { assertRouterStatusUrl, parseRouterStatusArgs, queryRouterStatus } from '../tools/router-status.mjs';

async function listen(handler){
  const server=http.createServer(handler);
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  return {server,port:server.address().port};
}
async function close(server){
  server.closeAllConnections();
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}
const url=port=>'http://127.0.0.1:'+port+'/router/status';

test('router status allows only canonical numeric-loopback HTTP status endpoints',()=>{
  assert.equal(assertRouterStatusUrl('http://127.0.0.1:47831/router/status').href,'http://127.0.0.1:47831/router/status');
  for(const bad of [
    'http://[::1]:47831/router/status',
    'http://127.0.0.1:47832/router/status',
    'http://localhost:47831/router/status',
    'http://evil.example:47831/router/status',
    'https://127.0.0.1:47831/router/status',
    'http://user:pass@127.0.0.1:47831/router/status',
    'http://127.0.0.1:47831/router/status?redirect=http://evil.example/',
    'http://127.0.0.1:47831/router/status#fragment',
    'http://127.0.0.1:47831/router/status/',
    'http://0x7f000001:47831/router/status',
    'http://127.0.0.1:47831/router/status\\evil',
    'http://127.0.0.1:47831/mcp',
    'http://127.0.0.1/router/status',
    'file:///etc/passwd'
  ]) assert.throws(()=>assertRouterStatusUrl(bad),/ROUTER_STATUS_URL_DENIED/,bad);
});

test('router status rejects malformed ports and timeout before any network calls',()=>{
  assert.throws(()=>parseRouterStatusArgs(['--url','http://127.0.0.1:47831/router/status','--port','-1']),/ROUTER_STATUS_REQUIRED/);
  assert.throws(()=>parseRouterStatusArgs(['--url','http://127.0.0.1:47831/router/status','--port','65536']),/ROUTER_STATUS_REQUIRED/);
  assert.throws(()=>parseRouterStatusArgs(['--url','http://127.0.0.1:47831/router/status','--port','50000','--timeout-ms','0']),/ROUTER_STATUS_TIMEOUT/);
  assert.throws(()=>parseRouterStatusArgs(['--url','http://127.0.0.1:47831/router/status','--port','50000','--timeout-ms','999999']),/ROUTER_STATUS_TIMEOUT/);
});

test('invalid status URL is rejected before the first HTTP request',async()=>{
  let hits=0;
  const {server,port}=await listen((_req,res)=>{hits++;res.writeHead(200);res.end('{}');});
  try{
    await assert.rejects(()=>queryRouterStatus(['--url',url(port)+'?bad=1','--port','52000']),/ROUTER_STATUS_URL_DENIED/);
    assert.equal(hits,0);
  }finally{await close(server);}
});

test('router status keeps valid numeric and cancellability semantics',async()=>{
  const canonical='http://127.0.0.1:47831/router/status';
  const request=async(endpoint,options)=>{
    assert.equal(endpoint,canonical,'network sink must receive the immutable trusted Router URL');
    assert.equal(options.redirect,'error');
    return {ok:true,json:async()=>({ok:true,router:true,inflightByPort:{'52000':2},inflightDetailsByPort:{'52000':[{cancellable:true},{cancellable:true}]}})};
  };
  const out=await queryRouterStatus(['--url',canonical,'--port','52000','--timeout-ms','2000','--json'],request);
  assert.deepEqual(out,{count:2,cancellableOnly:true,details:[{cancellable:true},{cancellable:true}],json:true});
});

test('router status refuses HTTP redirects rather than following their destination',async()=>{
  let destinationHits=0;
  const target=await listen((_req,res)=>{destinationHits++;res.writeHead(200);res.end('{}');});
  const source=await listen((_req,res)=>{res.writeHead(302,{location:url(target.port)});res.end();});
  try{
    await assert.rejects(()=>queryRouterStatus(['--url','http://127.0.0.1:47831/router/status','--port','52000','--timeout-ms','2000'], (_trusted,options)=>fetch(url(source.port),options)));
    assert.equal(destinationHits,0,'redirect destination must not receive traffic');
  }finally{await Promise.all([close(source.server),close(target.server)]);}
});
