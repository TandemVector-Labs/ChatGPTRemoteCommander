import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function sortDeep(value){
  if(Array.isArray(value))return value.map(sortDeep);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,sortDeep(value[k])]));
  return value;
}
export function canonicalToolSchema(tools){
  if(!Array.isArray(tools))throw new Error('SCHEMA_TOOLS_INVALID');
  return tools.map(t=>({name:String(t?.name??''),inputSchema:sortDeep(t?.inputSchema??{})})).sort((a,b)=>a.name.localeCompare(b.name));
}
export function hashToolSchema(tools){
  return createHash('sha256').update(JSON.stringify(canonicalToolSchema(tools))).digest('hex');
}
// This updater gate inspects only Commander-owned loopback MCP/Router endpoints.
// Validate all endpoints before the first network request, even on no-op paths.
export function validateLocalEndpoint(value,pathname){
  if(typeof value!=='string'||value.length>256||value.includes('\\'))throw new Error('SCHEMA_LOCAL_ENDPOINT_DENIED');
  let url;
  try{url=new URL(value);}catch{throw new Error('SCHEMA_LOCAL_ENDPOINT_DENIED');}
  const port=Number(url.port);
  if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)
    ||!Number.isSafeInteger(port)||port<1024||port>65535
    ||url.username||url.password||url.search||url.hash
    ||url.pathname!==pathname||value!==url.href){
    throw new Error('SCHEMA_LOCAL_ENDPOINT_DENIED');
  }
  return url.href;
}
async function fetchJson(url,options){
  const r=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(5000)});
  if(!r.ok)throw new Error('SCHEMA_HTTP_'+r.status);
  return r.json();
}
export async function fetchToolSchema(url){
  url=validateLocalEndpoint(url,'/mcp');
  const body=await fetchJson(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})});
  if(!Array.isArray(body?.result?.tools))throw new Error('SCHEMA_TOOLS_LIST_INVALID');
  return body.result.tools;
}
export async function fetchToolSchemaHash(url){return hashToolSchema(await fetchToolSchema(url));}

const IGNORED_SCHEMA_KEYS=new Set(['description','title','default','examples','example','$comment','deprecated','readOnly','writeOnly']);
const LOWER_BOUNDS=['minimum','exclusiveMinimum','minLength','minItems','minProperties'];
const UPPER_BOUNDS=['maximum','exclusiveMaximum','maxLength','maxItems','maxProperties'];
function asTypes(value){
  if(value===undefined)return null;
  return new Set(Array.isArray(value)?value:[value]);
}
function setContainsAll(candidate,old){
  for(const value of old)if(!candidate.has(value))return false;
  return true;
}
function exact(a,b){return JSON.stringify(sortDeep(a))===JSON.stringify(sortDeep(b));}
function compareSchema(oldSchema,candidateSchema,path='$'){
  const reasons=[];
  const old=oldSchema&&typeof oldSchema==='object'?oldSchema:{};
  const cand=candidateSchema&&typeof candidateSchema==='object'?candidateSchema:{};
  const oldTypes=asTypes(old.type),candTypes=asTypes(cand.type);
  if(candTypes&&(!oldTypes||!setContainsAll(candTypes,oldTypes)))reasons.push(path+':type_narrowed');
  if(Object.hasOwn(cand,'const')&&(!Object.hasOwn(old,'const')||cand.const!==old.const))reasons.push(path+':const_narrowed');
  if(Array.isArray(cand.enum)){
    if(!Array.isArray(old.enum))reasons.push(path+':enum_added');
    else{
      const c=new Set(cand.enum.map(v=>JSON.stringify(sortDeep(v))));
      for(const v of old.enum)if(!c.has(JSON.stringify(sortDeep(v)))){reasons.push(path+':enum_narrowed');break;}
    }
  }
  for(const key of LOWER_BOUNDS){
    if(Object.hasOwn(cand,key)&&(!Object.hasOwn(old,key)||Number(cand[key])>Number(old[key])))reasons.push(path+':'+key+'_narrowed');
  }
  for(const key of UPPER_BOUNDS){
    if(Object.hasOwn(cand,key)&&(!Object.hasOwn(old,key)||Number(cand[key])<Number(old[key])))reasons.push(path+':'+key+'_narrowed');
  }
  for(const key of ['pattern','format','multipleOf']){
    if(Object.hasOwn(cand,key)&&(!Object.hasOwn(old,key)||!exact(cand[key],old[key])))reasons.push(path+':'+key+'_changed');
  }
  const oldReq=new Set(Array.isArray(old.required)?old.required:[]);
  for(const key of Array.isArray(cand.required)?cand.required:[])if(!oldReq.has(key))reasons.push(path+':required_added:'+key);

  const oldProps=old.properties&&typeof old.properties==='object'?old.properties:{};
  const candProps=cand.properties&&typeof cand.properties==='object'?cand.properties:{};
  const candAdditional=cand.additionalProperties;
  for(const [key,value] of Object.entries(oldProps)){
    if(Object.hasOwn(candProps,key))reasons.push(...compareSchema(value,candProps[key],path+'.properties.'+key));
    else if(candAdditional===false)reasons.push(path+':property_removed:'+key);
  }
  if(old.items!==undefined&&cand.items!==undefined)reasons.push(...compareSchema(old.items,cand.items,path+'.items'));
  else if(old.items===undefined&&cand.items!==undefined)reasons.push(path+':items_constraint_added');

  const oldAdditional=old.additionalProperties;
  if(candAdditional===false&&oldAdditional!==false)reasons.push(path+':additional_properties_narrowed');
  else if(oldAdditional&&typeof oldAdditional==='object'&&candAdditional&&typeof candAdditional==='object'){
    reasons.push(...compareSchema(oldAdditional,candAdditional,path+'.additionalProperties'));
  }else if(oldAdditional!==false&&oldAdditional!==undefined&&candAdditional&&typeof candAdditional==='object'){
    reasons.push(path+':additional_properties_schema_added');
  }

  const handled=new Set(['type','const','enum','required','properties','items','additionalProperties',...LOWER_BOUNDS,...UPPER_BOUNDS,'pattern','format','multipleOf',...IGNORED_SCHEMA_KEYS]);
  for(const [key,value] of Object.entries(cand)){
    if(handled.has(key))continue;
    if(!Object.hasOwn(old,key))reasons.push(path+':constraint_added:'+key);
    else if(!exact(old[key],value))reasons.push(path+':constraint_changed:'+key);
  }
  return reasons;
}
export function classifyToolSchemaCompatibility(oldTools,candidateTools){
  if(!Array.isArray(oldTools)||!Array.isArray(candidateTools))throw new Error('SCHEMA_TOOLS_INVALID');
  const next=new Map(candidateTools.map(t=>[String(t?.name??''),t]));
  const reasons=[];
  for(const oldTool of oldTools){
    const name=String(oldTool?.name??'');
    const candidate=next.get(name);
    if(!candidate){reasons.push('tool_removed:'+name);continue;}
    reasons.push(...compareSchema(oldTool?.inputSchema??{},candidate?.inputSchema??{},'tool.'+name+'.inputSchema'));
  }
  return {compatible:reasons.length===0,reasons:reasons.slice(0,64)};
}
export async function evaluateSchemaContinuity({oldUrl,candidateUrl,routerUrl}){
  oldUrl=validateLocalEndpoint(oldUrl,'/mcp');
  candidateUrl=validateLocalEndpoint(candidateUrl,'/mcp');
  routerUrl=validateLocalEndpoint(routerUrl,'/router/status');
  const [oldTools,candidateTools]=await Promise.all([fetchToolSchema(oldUrl),fetchToolSchema(candidateUrl)]);
  const oldHash=hashToolSchema(oldTools),candidateHash=hashToolSchema(candidateTools);
  if(oldHash===candidateHash)return {ok:true,changed:false,backwardCompatible:true,oldHash,candidateHash,decision:'UNCHANGED_SCHEMA'};
  const compatibility=classifyToolSchemaCompatibility(oldTools,candidateTools);
  if(compatibility.compatible)return {ok:true,changed:true,backwardCompatible:true,oldHash,candidateHash,decision:'BACKWARD_COMPATIBLE_SCHEMA'};
  let status;
  try{status=await fetchJson(routerUrl,{method:'GET'});}catch(error){
    return {ok:false,changed:true,backwardCompatible:false,compatibilityReasons:compatibility.reasons,oldHash,candidateHash,decision:'ROUTER_CONTINUITY_UNAVAILABLE',error:error.message};
  }
  const c=status?.schemaContinuity;
  if(!c||typeof c!=='object')return {ok:false,changed:true,backwardCompatible:false,compatibilityReasons:compatibility.reasons,oldHash,candidateHash,decision:'ROUTER_CONTINUITY_UNSUPPORTED'};
  if(c.legacyMcpSeen===true)return {ok:false,changed:true,backwardCompatible:false,compatibilityReasons:compatibility.reasons,oldHash,candidateHash,decision:'LEGACY_HOST_SEEN'};
  if(Number(c.toolsListSubscribers||0)<1)return {ok:false,changed:true,backwardCompatible:false,compatibilityReasons:compatibility.reasons,oldHash,candidateHash,decision:'TOOLS_LIST_REFRESH_UNNEGOTIATED'};
  return {ok:true,changed:true,backwardCompatible:false,compatibilityReasons:compatibility.reasons,oldHash,candidateHash,decision:'NEGOTIATED_REFRESH'};
}
function parse(argv){
  const o={};
  for(let i=0;i<argv.length;i+=2){const k=argv[i],v=argv[i+1];if(!v)throw new Error('SCHEMA_GATE_ARGUMENT');if(k==='--old-url')o.oldUrl=v;else if(k==='--candidate-url')o.candidateUrl=v;else if(k==='--router-url')o.routerUrl=v;else throw new Error('SCHEMA_GATE_ARGUMENT');}
  if(!o.oldUrl||!o.candidateUrl||!o.routerUrl)throw new Error('SCHEMA_GATE_ARGUMENT');
  return o;
}
const invoked=process.argv[1]?pathToFileURL(path.resolve(process.argv[1])).href:'';
if(invoked===import.meta.url){
  try{
    const result=await evaluateSchemaContinuity(parse(process.argv.slice(2)));
    console.log(JSON.stringify(result));
    if(!result.ok)process.exitCode=3;
  }catch(error){console.error(error.message);process.exitCode=2;}
}
