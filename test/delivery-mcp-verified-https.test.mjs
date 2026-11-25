import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {publicWebhookAddress,createVerifiedWebhookHttpsTransport} from '../src/delivery-mcp-verified-https.mjs';

const headers={
  'content-type':'application/json',
  'webhook-id':'evt_'+'a'.repeat(64),
  'webhook-timestamp':'1793926801',
  'webhook-signature':'v1,'+'z'.repeat(44),
  'x-mcp-subscription-id':'sub_'+'a'.repeat(64)
};
const params={url:'https://webhooks.example.com/receive',
  headers,body:'{"ok":true}',noRedirects:true,timeoutMs:1000};
function fixture(rows=[{family:4,address:'8.8.8.8'}],status=204){
  let resolution=0,network=0,observed={};
  const resolveAddresses=async(host,opts)=>{
    resolution++;
    observed.host=host;
    observed.resolveOptions=opts;
    return rows;
  };
  const requestHttps=(url,options,onResponse)=>{
    network++;
    observed.url=url.href;
    observed.options=options;
    const req=new EventEmitter();
    req.end=body=>{
      observed.body=body;
      options.lookup(url.hostname,{},(error,address,family)=>{
        observed.dial={error,address,family};
      });
      queueMicrotask(()=>{
        const resp=new EventEmitter();resp.statusCode=status;
        onResponse(resp);
        resp.emit('data',Buffer.from('accepted'));resp.emit('end');
      });
    };
    req.destroy=e=>req.emit('error',e);
    return req;
  };
  const sender=createVerifiedWebhookHttpsTransport({resolveAddresses,requestHttps});
  return {sender,observed,count:()=>({resolution,network})};
}
test('public-address classification rejects private, metadata, benchmark and transition ranges',()=>{
  for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','172.20.0.1',
    '192.168.1.5','100.100.100.200','192.0.2.1','198.51.100.2',
    '203.0.113.5','198.19.1.2','224.0.0.1','0.0.0.0',
    '::1','fe80::1','fc00::2','::ffff:127.0.0.1',
    '2001:db8::1','2001:0:abcd::1','2001:0000:abcd::1',
    '2002:c000:0201::1','3fff::42']){
    assert.equal(publicWebhookAddress(ip),false,ip);
  }
  for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111',
    '2001:4860:4860::8888'])assert.equal(publicWebhookAddress(ip),true,ip);
});
test('verified transport pins the vetted address while preserving SNI and certificate checks',async()=>{
  const f=fixture();
  const result=await f.sender.postVerifiedHttps(params);
  assert.equal(result.status,204);
  assert.equal(result.body,'accepted');
  assert.deepEqual(f.count(),{resolution:1,network:1});
  assert.equal(f.observed.host,'webhooks.example.com');
  assert.equal(f.observed.dial.address,'8.8.8.8');
  assert.equal(f.observed.dial.family,4);
  assert.equal(f.observed.options.servername,'webhooks.example.com');
  assert.equal(f.observed.options.rejectUnauthorized,true);
  assert.equal(f.observed.options.family,4);
  assert.equal(f.observed.options.autoSelectFamily,false);
  assert.equal(f.observed.options.method,'POST');
  assert.equal(f.observed.options.agent,false);
  assert.equal(f.observed.options.headers['content-length'],params.body.length);
  assert.equal(f.observed.body,params.body);
});
test('mixed public+internal DNS answer is rejected before request creation',async()=>{
  const f=fixture([{family:4,address:'8.8.8.8'},
    {family:4,address:'169.254.169.254'}]);
  await assert.rejects(()=>f.sender.postVerifiedHttps(params),/DELIVERY_EGRESS_DNS_UNSAFE/);
  assert.deepEqual(f.count(),{resolution:1,network:0});
});
test('IPv6 public result is selected and pinned as IPv6',async()=>{
  const f=fixture([{family:6,address:'2001:4860:4860::8888'}]);
  const r=await f.sender.postVerifiedHttps(params);
  assert.equal(r.status,204);
  assert.deepEqual(f.observed.dial,{error:null,address:'2001:4860:4860::8888',family:6});
  assert.equal(f.observed.options.family,6);
  assert.equal(f.observed.options.autoSelectFamily,false);
});
test('invalid private destinations and credentials are rejected without DNS resolution',async()=>{
  for(const url of ['http://webhooks.example.com/receive',
    'https://localhost/cb','https://127.0.0.1/cb','https://[::1]/cb',
    'https://foo.internal/cb','https://foo.local/cb',
    'https://alice:secret@webhooks.example.com/cb',
    'https://webhooks.example.com/cb#fragment']){
    const f=fixture();
    await assert.rejects(()=>f.sender.postVerifiedHttps({...params,url}),/DELIVERY_EGRESS_URL_INVALID/,url);
    assert.deepEqual(f.count(),{resolution:0,network:0},url);
  }
});
test('rejects redirect-permissive policy and injected request headers',async()=>{
  for(const patch of [{noRedirects:false},{timeoutMs:12000},
    {headers:{...headers,Host:'internal.example.com'}},
    {headers:{...headers,'webhook-id':'abc\r\nHost:localhost'}},
    {body:'x'.repeat(262145)}]){
    const f=fixture();
    await assert.rejects(()=>f.sender.postVerifiedHttps({...params,...patch}),
      /DELIVERY_EGRESS_(POLICY|HEADERS|BODY)_INVALID/);
    assert.equal(f.count().network,0);
  }
});
test('each new send resolves public DNS again; never caches stale approved target',async()=>{
  let calls=0,network=0;
  const requestHttps=(_u,_o,callback)=>{
    network++;
    const req=new EventEmitter();
    req.end=()=>queueMicrotask(()=>{
      const resp=new EventEmitter();resp.statusCode=200;
      callback(resp);resp.emit('end');
    });
    req.destroy=e=>req.emit('error',e);
    return req;
  };
  const resolveAddresses=async()=>{
    calls++;
    return calls===1?[{family:4,address:'8.8.8.8'}]
      :[{family:4,address:'127.0.0.1'}];
  };
  const sender=createVerifiedWebhookHttpsTransport({resolveAddresses,requestHttps});
  await sender.postVerifiedHttps(params);
  await assert.rejects(()=>sender.postVerifiedHttps(params),/DELIVERY_EGRESS_DNS_UNSAFE/);
  assert.equal(network,1);
  assert.equal(calls,2);
});

test('absolute deadline rejects unresolved DNS and never creates a late outbound connection',async()=>{
  let connects=0;
  let resolveLate;
  const neverUntilReleased=new Promise(resolve=>{resolveLate=resolve;});
  const transport=createVerifiedWebhookHttpsTransport({
    resolveAddresses:()=>neverUntilReleased,
    requestHttps:()=>{connects++;throw Error('SHOULD_NOT_CONNECT');}
  });
  await assert.rejects(
    ()=>Promise.race([
      transport.postVerifiedHttps({...params,timeoutMs:100}),
      new Promise((_,reject)=>setTimeout(()=>reject(new Error('TEST_DEADLINE_MISSED')),400))
    ]),
    /DELIVERY_EGRESS_TIMEOUT/
  );
  resolveLate([{family:4,address:'8.8.8.8'}]);
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(connects,0);
});
test('absolute deadline destroys a silent TLS request even without socket timeout callback',async()=>{
  let destroyed=0;
  const fakeHttps=()=>{
    const req=new EventEmitter();
    req.end=()=>{};
    req.destroy=error=>{destroyed++;req.emit('error',error);};
    return req;
  };
  const transport=createVerifiedWebhookHttpsTransport({
    resolveAddresses:async()=>[{family:4,address:'8.8.8.8'}],
    requestHttps:fakeHttps
  });
  await assert.rejects(
    ()=>Promise.race([
      transport.postVerifiedHttps({...params,timeoutMs:100}),
      new Promise((_,reject)=>setTimeout(()=>reject(new Error('TEST_DEADLINE_MISSED')),400))
    ]),
    /DELIVERY_EGRESS_TIMEOUT/
  );
  assert.equal(destroyed,1);
});

test('response close without end is rejected instead of accepting partial content',async()=>{
  const transport=createVerifiedWebhookHttpsTransport({
    resolveAddresses:async()=>[{family:4,address:'8.8.8.8'}],
    requestHttps:(_url,_opts,onResponse)=>{
      const req=new EventEmitter();
      req.end=()=>{
        queueMicrotask(()=>{
          const res=new EventEmitter();res.statusCode=202;
          onResponse(res);
          res.emit('data',Buffer.from('partial'));
          res.emit('close');
        });
      };
      req.destroy=error=>req.emit('error',error);
      return req;
    }
  });
  await assert.rejects(()=>transport.postVerifiedHttps({...params,timeoutMs:200}),
    /DELIVERY_EGRESS_RESPONSE_INTERRUPTED/);
});
test('absolute deadline bounds a trickle-fed response that never completes',async()=>{
  let interval,destructions=0;
  const transport=createVerifiedWebhookHttpsTransport({
    resolveAddresses:async()=>[{family:4,address:'8.8.8.8'}],
    requestHttps:(_url,_opts,onResponse)=>{
      const req=new EventEmitter();
      req.end=()=>{
        const res=new EventEmitter();res.statusCode=202;
        onResponse(res);
        interval=setInterval(()=>res.emit('data',Buffer.from('.')),12);
      };
      req.destroy=error=>{
        destructions++;
        clearInterval(interval);
        req.emit('error',error);
      };
      return req;
    }
  });
  try{
    await assert.rejects(
      ()=>Promise.race([
        transport.postVerifiedHttps({...params,timeoutMs:100}),
        new Promise((_,reject)=>setTimeout(()=>reject(new Error('TEST_DEADLINE_MISSED')),400))
      ]),
      /DELIVERY_EGRESS_TIMEOUT/
    );
    assert.equal(destructions,1);
  }finally{clearInterval(interval);}
});
test('oversized webhook response fails without reporting a successful receipt',async()=>{
  const transport=createVerifiedWebhookHttpsTransport({
    resolveAddresses:async()=>[{family:4,address:'8.8.8.8'}],
    requestHttps:(_url,_opts,onResponse)=>{
      const req=new EventEmitter();
      req.end=()=>queueMicrotask(()=>{
        const res=new EventEmitter();res.statusCode=200;
        onResponse(res);
        res.emit('data',Buffer.alloc(8193,46));
      });
      req.destroy=error=>req.emit('error',error);
      return req;
    }
  });
  await assert.rejects(()=>transport.postVerifiedHttps({...params,timeoutMs:200}),
    /DELIVERY_EGRESS_RESPONSE_TOO_LARGE/);
});

test('preconnect grant runs only after DNS and prevents a revoked socket',async()=>{
  const f=fixture();
  let checks=0;
  await assert.rejects(()=>f.sender.postVerifiedHttps({
    ...params,authorizeBeforeRequest:()=> {
      checks++;
      assert.equal(f.count().resolution,1);
      assert.equal(f.count().network,0);
      return false;
    }
  }),/DELIVERY_EGRESS_AUTHORIZATION_DENIED/);
  assert.equal(checks,1);
  assert.deepEqual(f.count(),{resolution:1,network:0});
  const accepted=await f.sender.postVerifiedHttps({
    ...params,authorizeBeforeRequest:()=>{checks++;return true;}
  });
  assert.equal(accepted.status,204);
  assert.equal(checks,2);
  assert.deepEqual(f.count(),{resolution:2,network:1});
  await assert.rejects(()=>f.sender.postVerifiedHttps({
    ...params,authorizeBeforeRequest:'client-provided-yes'
  }),/DELIVERY_EGRESS_AUTHORIZATION_CALLBACK_INVALID/);
  assert.deepEqual(f.count(),{resolution:2,network:1});
});
test('late preconnect authorization after absolute deadline cannot open HTTPS',async()=>{
  let allow;
  let called=0;
  const grant=new Promise(resolve=>{allow=resolve;});
  const transport=createVerifiedWebhookHttpsTransport({
    resolveAddresses:async()=>[{family:4,address:'8.8.8.8'}],
    requestHttps:()=>{called++;throw Error('MUST_NOT_OPEN_SOCKET');}
  });
  await assert.rejects(()=>transport.postVerifiedHttps({
    ...params,timeoutMs:100,authorizeBeforeRequest:()=>grant
  }),/DELIVERY_EGRESS_TIMEOUT/);
  allow(true);
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(called,0);
});
