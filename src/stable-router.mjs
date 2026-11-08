import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_BODY = 16 * 1024 * 1024;
const LOOPBACK = '127.0.0.1';
const MODERN_VERSION = '2026-07-28';
const SUBSCRIPTION_ID_META_KEY = 'io.modelcontextprotocol/subscriptionId';
function parseMcpBody(body) {
  try { return JSON.parse(body.toString('utf8')); } catch { return null; }
}
function isModernMcp(req,message) {
  const headerVersion=String(req.headers['mcp-protocol-version']||'');
  const metaVersion=message?.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  return headerVersion===MODERN_VERSION || metaVersion===MODERN_VERSION;
}
function sseFrame(message) { return 'event: message\ndata: '+JSON.stringify(message)+'\n\n'; }
function subscriptionMeta(id) { return { [SUBSCRIPTION_ID_META_KEY]: id }; }
function advertiseToolListChanged(payload) {
  if (!payload || typeof payload!=='object' || !payload.result || typeof payload.result!=='object') return payload;
  const caps=(payload.result.capabilities && typeof payload.result.capabilities==='object') ? payload.result.capabilities : (payload.result.capabilities={});
  const tools=(caps.tools && typeof caps.tools==='object') ? caps.tools : (caps.tools={});
  tools.listChanged=true;
  return payload;
}
const ROUTER_SOURCE_FILE = fileURLToPath(import.meta.url);
const ROUTER_SOURCE_SHA256 = createHash('sha256').update(fs.readFileSync(ROUTER_SOURCE_FILE)).digest('hex');

function fail(code) { throw new Error(code); }
function validPort(value) {
  const n=Number(value);
  if(!Number.isSafeInteger(n)||n<1024||n>65535) fail('ROUTER_INVALID_PORT');
  return n;
}
function localFile(file) {
  if(typeof file!=='string'||!path.isAbsolute(file)||/^(?:\\\\|\/\/)/.test(file)) fail('ROUTER_LOCAL_FILE_REQUIRED');
  const resolved=path.resolve(file);
  let cursor=path.parse(resolved).root;
  for(const bit of resolved.slice(cursor.length).split(path.sep).filter(Boolean)){
    cursor=path.join(cursor,bit);
    if(fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) fail('ROUTER_LINK_NOT_ALLOWED');
  }
  return resolved;
}
export function validateRouterState(value) {
  if(!value||value.schema!==1||typeof value.profile!=='string'||!value.profile) fail('ROUTER_STATE_INVALID');
  if(!Number.isSafeInteger(value.generation)||value.generation<1) fail('ROUTER_STATE_INVALID');
  const active=value.active;
  if(!active||typeof active!=='object') fail('ROUTER_STATE_INVALID');
  validPort(active.port);
  for(const key of ['version','commit','configSha256']){
    if(typeof active[key]!=='string'||!active[key]) fail('ROUTER_STATE_INVALID');
  }
  if(!/^[0-9a-f]{40}$/.test(active.commit)) fail('ROUTER_STATE_INVALID');
  if(!/^[0-9a-f]{64}$/.test(active.configSha256)) fail('ROUTER_STATE_INVALID');
  return value;
}
export function readRouterState(file) {
  file=localFile(file);
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.nlink>1) fail('ROUTER_STATE_ALIAS');
  return validateRouterState(JSON.parse(fs.readFileSync(file,'utf8')));
}
// Pin both Router state and runtime metadata writes to exclusive 0600 descriptors.
function writeAtomicPrivateJson(file,value) {
  const tmp=file+'.tmp-'+process.pid+'-'+randomBytes(12).toString('hex');
  let fd,created=false;
  try {
    fd=fs.openSync(tmp,'wx',0o600);
    created=true;
    fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n',{encoding:'utf8'});
    fs.fsyncSync(fd);
    fs.closeSync(fd);fd=undefined;
    fs.renameSync(tmp,file);
  }catch(error){
    if(fd!==undefined){try{fs.closeSync(fd);}catch{}}
    if(created){try{fs.unlinkSync(tmp);}catch{}}
    throw error;
  }
}
// A local-filesystem, cooperative-writer mutex. Never auto-reclaim an orphan:
// an uncertain prior writer must be reconciled before a new state transition.
function withRouterStateWriteLock(file,action) {
  const dir=path.dirname(file), parent=fs.lstatSync(dir);
  if(!parent.isDirectory()||parent.isSymbolicLink()) fail('ROUTER_STATE_UNTRUSTED_PARENT');
  if(process.platform!=='win32' && (parent.uid!==process.getuid()||(parent.mode&0o022)!==0)) fail('ROUTER_STATE_UNTRUSTED_PARENT');
  const lock=file+'.write-lock';
  let fd;
  try { fd=fs.openSync(lock,'wx',0o600); }
  catch(error){ if(error?.code==='EEXIST') fail('ROUTER_STATE_WRITE_LOCKED'); throw error; }
  try {
    const owner=fs.fstatSync(fd);
    if(!owner.isFile()||owner.nlink!==1) fail('ROUTER_STATE_LOCK_TAMPERED');
    return action();
  }finally{
    const owner=fs.fstatSync(fd);
    let candidate;
    try { candidate=fs.lstatSync(lock); } catch {}
    const same=candidate?.isFile()&&candidate.nlink===1&&candidate.dev===owner.dev&&candidate.ino===owner.ino;
    fs.closeSync(fd);
    if(!same) fail('ROUTER_STATE_LOCK_TAMPERED');
    fs.unlinkSync(lock);
  }
}
export function writeRouterStateAtomic(file,state,expectedGeneration=null) {
  file=localFile(file);
  const next=validateRouterState(state);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  file=localFile(file);
  return withRouterStateWriteLock(file,()=>{
    if(expectedGeneration!==null){
      if(!fs.existsSync(file)) fail('ROUTER_GENERATION_CONFLICT');
      const current=readRouterState(file);
      if(current.generation!==expectedGeneration) fail('ROUTER_GENERATION_CONFLICT');
    }
    writeAtomicPrivateJson(file,next);
    return next;
  });
}
function collect(req) {
  return new Promise((resolve,reject)=>{
    const chunks=[];let bytes=0;
    req.on('data',chunk=>{bytes+=chunk.length;if(bytes>MAX_BODY){reject(new Error('ROUTER_BODY_TOO_LARGE'));req.destroy();return;}chunks.push(chunk);});
    req.on('end',()=>resolve(Buffer.concat(chunks)));
    req.on('error',reject);
  });
}
function proxyHeaders(headers) {
  const out={};
  for(const [k,v] of Object.entries(headers)){
    const low=k.toLowerCase();
    if(['host','connection','transfer-encoding','content-length'].includes(low)) continue;
    if(v!==undefined)out[k]=v;
  }
  return out;
}
function boundedText(value,max=160) {
  return typeof value==='string' && value.length>0 && value.length<=max ? value : '';
}
function requestMetadata(req,body) {
  let rpcMethod=boundedText(req.headers['mcp-method'],96),rpcName=boundedText(req.headers['mcp-name'],128);
  if(!rpcMethod || !rpcName){
    try{
      const value=JSON.parse(body.toString('utf8'));
      if(!rpcMethod)rpcMethod=boundedText(value?.method,96);
      if(!rpcName)rpcName=boundedText(value?.params?.name,128);
    }catch{}
  }
  let pathname='/';
  try{pathname=new URL(req.url||'/','http://127.0.0.1').pathname.slice(0,256)||'/';}catch{}
  const method=boundedText((req.method||'').toUpperCase(),16);
  const cancellable=rpcMethod==='subscriptions/listen' || (method==='GET' && (pathname==='/mcp' || pathname==='/sse'));
  return {method,path:pathname,rpcMethod,rpcName,cancellable,startedAt:new Date().toISOString()};
}
export async function startRouter({listenPort,stateFile,runtimeFile=null,host=LOOPBACK}) {
  listenPort=validPort(listenPort);stateFile=localFile(stateFile);
  if(host!==LOOPBACK) fail('ROUTER_LOOPBACK_ONLY');
  const inflight=new Map();
  const inflightDetails=new Map();
  const subscriptions=new Map();
  let subscriptionSequence=0;
  let requestSequence=0;
  let observedState=readRouterState(stateFile);
  let observedGeneration=observedState.generation;
  let legacyMcpSeen=false,modernMcpSeen=false,lastGenerationChangeAt=null;
  const publishToolsChanged=()=>{
    for(const sub of subscriptions.values()){
      if(!sub.toolsListChanged || sub.res.destroyed) continue;
      try{sub.res.write(sseFrame({jsonrpc:'2.0',method:'notifications/tools/list_changed',params:{_meta:subscriptionMeta(sub.id)}}));}
      catch{}
    }
  };
  const routeTimer=setInterval(()=>{
    try{
      const next=readRouterState(stateFile);
      if(next.generation!==observedGeneration){
        observedGeneration=next.generation;observedState=next;lastGenerationChangeAt=new Date().toISOString();
        publishToolsChanged();
      }
    }catch{}
  },100);
  routeTimer.unref?.();
  const bump=(port,delta)=>{const n=Math.max(0,(inflight.get(port)||0)+delta);if(n)inflight.set(port,n);else inflight.delete(port);};
  const begin=(port,meta)=>{
    const id=++requestSequence;
    if(!inflightDetails.has(port))inflightDetails.set(port,new Map());
    inflightDetails.get(port).set(id,{id,...meta});
    bump(port,1);
    return id;
  };
  const finish=(port,id)=>{
    const group=inflightDetails.get(port);
    if(!group || !group.delete(id))return;
    if(group.size===0)inflightDetails.delete(port);
    bump(port,-1);
  };
  const detailObject=()=>Object.fromEntries([...inflightDetails].map(([port,group])=>[port,[...group.values()]]));
  const server=http.createServer(async(req,res)=>{
    if(req.url==='/router/status' && req.method==='GET'){
      try{
        const state=readRouterState(stateFile);
        res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
        res.end(JSON.stringify({ok:true,router:true,listenPort,sourceSha256:ROUTER_SOURCE_SHA256,state,inflightByPort:Object.fromEntries(inflight),inflightDetailsByPort:detailObject(),schemaContinuity:{toolsListSubscribers:[...subscriptions.values()].filter(x=>x.toolsListChanged).length,totalSubscriptions:subscriptions.size,legacyMcpSeen,modernMcpSeen,observedGeneration,lastGenerationChangeAt}}));
      }catch(error){
        res.writeHead(503,{'content-type':'application/json','cache-control':'no-store'});
        res.end(JSON.stringify({ok:false,router:true,error:error.message}));
      }
      return;
    }
    let state,body;
    try{state=readRouterState(stateFile);body=await collect(req);}
    catch(error){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:error.message}));return;}
    const message=parseMcpBody(body);
    const meta=requestMetadata(req,body);
    const modern=meta.path==='/mcp' && meta.method==='POST' && isModernMcp(req,message);
    if(meta.path==='/mcp' && meta.method==='POST' && meta.rpcMethod){
      if(modern)modernMcpSeen=true;else legacyMcpSeen=true;
    }
    if(modern && meta.rpcMethod==='subscriptions/listen'){
      if(req.headers['mcp-method']!=='subscriptions/listen'){
        res.writeHead(400,{'content-type':'application/json','cache-control':'no-store'});
        res.end(JSON.stringify({jsonrpc:'2.0',id:message?.id??null,error:{code:-32020,message:'Mcp-Method header does not match request body'}}));
        return;
      }
      if(message?.id===undefined || message?.id===null){
        res.writeHead(400,{'content-type':'application/json','cache-control':'no-store'});
        res.end(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32600,message:'subscriptions/listen requires a request id'}}));
        return;
      }
      const requested=message?.params?.notifications;
      const toolsListChanged=requested?.toolsListChanged===true;
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache, no-store','connection':'keep-alive'});
      res.flushHeaders?.();
      const key=++subscriptionSequence;
      const sub={key,id:message.id,res,toolsListChanged};
      subscriptions.set(key,sub);
      const cleanup=()=>subscriptions.delete(key);
      req.once('aborted',cleanup);req.once('close',cleanup);res.once('close',cleanup);res.once('error',cleanup);
      res.write(sseFrame({jsonrpc:'2.0',method:'notifications/subscriptions/acknowledged',params:{notifications:toolsListChanged?{toolsListChanged:true}:{},_meta:subscriptionMeta(message.id)}}));
      return;
    }
    const port=state.active.port;
    const requestId=begin(port,meta);
    let accounted=false;
    const done=()=>{if(accounted)return;accounted=true;finish(port,requestId);};
    const headers=proxyHeaders(req.headers);headers['content-length']=String(body.length);
    let downstreamClosed=false,upstreamResponse=null;
    const drainAfterDownstreamClose=()=>{
      downstreamClosed=true;
      // Never cancel a potentially mutating upstream request merely because the
      // MCP client disconnected. Continue consuming the backend response so its
      // real completion/close event can retire inflight accounting safely.
      if(upstreamResponse && !upstreamResponse.complete && !upstreamResponse.destroyed){upstreamResponse.unpipe(res);upstreamResponse.resume();}
    };
    res.once('close',drainAfterDownstreamClose);
    const upstream=http.request({host:LOOPBACK,port,path:req.url||'/',method:req.method,headers},up=>{
      upstreamResponse=up;
      up.once('end',done);up.once('close',done);up.once('error',done);
      if(downstreamClosed || res.destroyed){up.resume();return;}
      if(modern && meta.rpcMethod==='server/discover'){
        const chunks=[];let bytes=0,overflow=false;
        up.on('data',chunk=>{bytes+=chunk.length;if(bytes>MAX_BODY){overflow=true;}else chunks.push(Buffer.from(chunk));});
        up.once('end',()=>{
          if(downstreamClosed || res.destroyed)return;
          const h=proxyHeaders(up.headers);
          if(overflow){
            const data=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:message?.id??null,error:{code:-32603,message:'ROUTER_DISCOVER_RESPONSE_TOO_LARGE'}}));
            h['content-type']='application/json';h['content-length']=String(data.length);res.writeHead(502,h);res.end(data);return;
          }
          let data=Buffer.concat(chunks);
          try{
            const payload=advertiseToolListChanged(JSON.parse(data.toString('utf8')));
            data=Buffer.from(JSON.stringify(payload));
          }catch{}
          h['content-length']=String(data.length);
          res.writeHead(up.statusCode||502,h);res.end(data);
        });
        return;
      }
      const h=proxyHeaders(up.headers);
      res.writeHead(up.statusCode||502,h);
      up.pipe(res);
    });
    upstream.once('error',error=>{done();if(!res.destroyed){if(!res.headersSent)res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:'ROUTER_UPSTREAM_UNAVAILABLE',detail:error.code||'ERROR'}));}});
    upstream.end(body);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(listenPort,host,resolve);});
  try {
    if(runtimeFile){
      runtimeFile=localFile(runtimeFile);fs.mkdirSync(path.dirname(runtimeFile),{recursive:true});
      const state={schema:1,pid:process.pid,host,port:listenPort,stateFile,sourceSha256:ROUTER_SOURCE_SHA256,startedAt:new Date().toISOString()};
      withRouterStateWriteLock(runtimeFile,()=>writeAtomicPrivateJson(runtimeFile,state));
    }
  }catch(error){
    clearInterval(routeTimer);
    await new Promise(resolve=>server.close(resolve));
    throw error;
  }
  return {
    server,
    close:()=>{
      clearInterval(routeTimer);
      for(const sub of subscriptions.values()){
        try{sub.res.write(sseFrame({jsonrpc:'2.0',id:sub.id,result:{_meta:subscriptionMeta(sub.id)}}));sub.res.end();}catch{}
      }
      subscriptions.clear();
      return new Promise(resolve=>server.close(resolve));
    },
    status:()=>({listenPort,sourceSha256:ROUTER_SOURCE_SHA256,state:readRouterState(stateFile),inflightByPort:Object.fromEntries(inflight),inflightDetailsByPort:detailObject(),schemaContinuity:{toolsListSubscribers:[...subscriptions.values()].filter(x=>x.toolsListChanged).length,totalSubscriptions:subscriptions.size,legacyMcpSeen,modernMcpSeen,observedGeneration,lastGenerationChangeAt}})
  };
}
function parse(argv){
  const o={};
  for(let i=0;i<argv.length;i++){
    const a=argv[i],v=argv[++i];if(v===undefined)fail('ROUTER_ARGUMENT');
    if(a==='--listen-port')o.listenPort=Number(v);
    else if(a==='--state-file')o.stateFile=v;
    else if(a==='--runtime-file')o.runtimeFile=v;
    else fail('ROUTER_ARGUMENT');
  }
  if(!o.listenPort||!o.stateFile)fail('ROUTER_ARGUMENT');
  return o;
}
const invoked=process.argv[1]?pathToFileURL(path.resolve(process.argv[1])).href:'';
if(invoked===import.meta.url){
  try{const args=parse(process.argv.slice(2));await startRouter(args);console.log('ROUTER_READY');}
  catch(error){console.error(error.message);process.exit(1);}
}
