#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const catalogPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../installer/products.json');
export const catalog=JSON.parse(fs.readFileSync(catalogPath,'utf8'));
const knownStatuses=new Set(['bundled','bootstrap','conditional','postEnrollment','unavailable']);
const platforms=['windows','linux'];

export function validateCatalog(input=catalog){
  if(input.schema!==1||!Array.isArray(input.products)||input.products.length===0)throw Error('INVALID_PRODUCT_CATALOG');
  const ids=new Set();
  for(const p of input.products){
    if(!/^[a-z][a-z0-9-]{1,48}$/.test(p.id)||ids.has(p.id)||!Array.isArray(p.requires))throw Error('INVALID_PRODUCT_ID');
    ids.add(p.id);
    for(const plat of platforms){
      const state=p.platforms?.[plat];
      if(!state||!knownStatuses.has(state.status)||typeof state.method!=='string'&&state.status!=='unavailable')throw Error('INVALID_PLATFORM_STATE');
      if(state.status==='unavailable'&&!state.reason)throw Error('MISSING_UNAVAILABLE_REASON');
    }
  }
  for(const p of input.products){
    for(const dep of p.requires)if(!ids.has(dep)||dep===p.id)throw Error('INVALID_DEPENDENCY');
  }
  const visiting=new Set(),visited=new Set(),byId=new Map(input.products.map(p=>[p.id,p]));
  function visit(id){if(visiting.has(id))throw Error('CYCLIC_DEPENDENCY');if(visited.has(id))return;visiting.add(id);for(const dep of byId.get(id).requires)visit(dep);visiting.delete(id);visited.add(id);}
  for(const id of ids)visit(id);
  if(!ids.has('core'))throw Error('CORE_MISSING');
  const addons=input.controlCenterAddons;
  if(addons!==undefined){
    if(addons.schema!==1||addons.surface!=='control-center'||
       addons.defaultAutoInstall!==false||
       addons.capability!=='DISCOVERY_ONLY_UNTIL_SIGNED_ARTIFACT_AND_OWNER_GRANT'||
       !Array.isArray(addons.items)||addons.items.length>64)throw Error('OPTIONAL_CATALOG_INVALID');
    const seenAddons=new Set();
    for(const x of addons.items){
      if(!x||typeof x!=='object'||!/^[a-z][a-z0-9-]{1,48}$/.test(x.id)||
         ids.has(x.id)||seenAddons.has(x.id)||typeof x.name!=='string'||!x.name||
         typeof x.category!=='string'||!x.category||
         typeof x.source!=='string'||!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(x.source)||
         !Array.isArray(x.platforms)||!x.platforms.length||
         new Set(x.platforms).size!==x.platforms.length||
         x.platforms.some(p=>!platforms.includes(p))||
         x.admission!=='planned'||x.downloadDefault!==false)throw Error('OPTIONAL_CATALOG_ENTRY_INVALID');
      seenAddons.add(x.id);
    }
  }
  return input;
}

export function createPlan({platform,all=false,products=[],browserBundled=false}={}){
  validateCatalog();
  if(!platforms.includes(platform))throw Error('UNSUPPORTED_PLATFORM');
  if(all&&products.length)throw Error('ALL_AND_PRODUCT_CONFLICT');
  const byId=new Map(catalog.products.map(x=>[x.id,x]));
  const chosen=all
    ? catalog.products.filter(p=>{const s=p.platforms[platform].status;return s==='bundled'||s==='bootstrap'||s==='postEnrollment'||s==='conditional'&&browserBundled;}).map(p=>p.id)
    : (products.length?products:['core']);
  if(new Set(chosen).size!==chosen.length)throw Error('DUPLICATE_PRODUCT_SELECTION');
  const ordered=[],seen=new Set();
  function add(id){
    const p=byId.get(id);if(!p)throw Error('UNKNOWN_PRODUCT '+id);
    const state=p.platforms[platform];
    if(state.status==='unavailable')throw Error('PRODUCT_UNAVAILABLE '+id+': '+state.reason);
    if(state.status==='conditional'&&!browserBundled)throw Error('PRODUCT_NEEDS_QUALIFIED_PAYLOAD '+id);
    if(seen.has(id))return;
    for(const dep of p.requires)add(dep);
    seen.add(id);
    ordered.push({id,name:p.name,status:state.status,method:state.method,
      phase:state.status==='postEnrollment'?'pending-activation':'install'});
  }
  for(const id of chosen)add(id);
  return {schema:1,platform,requested:chosen,all,products:ordered,
    installNow:ordered.filter(p=>p.phase==='install').map(p=>p.id),
    pendingActivation:ordered.filter(p=>p.phase==='pending-activation').map(p=>p.id),
    unavailable:catalog.products.filter(p=>p.platforms[platform].status==='unavailable').map(p=>p.id),
    changesApplied:false};
}

// This is a read-only catalog query, not an executable install plan.
export function listControlCenterAddons({platform}={}){
  validateCatalog();
  if(!platforms.includes(platform))throw Error('UNSUPPORTED_PLATFORM');
  return {schema:1,platform,surface:'control-center',changesApplied:false,
    autoInstall:false,items:catalog.controlCenterAddons.items.map(x=>({
      id:x.id,name:x.name,category:x.category,source:x.source,
      admission:x.admission,eligiblePlatform:x.platforms.includes(platform),
      installable:false,reason:x.platforms.includes(platform)
        ? 'SIGNED_ARTIFACT_OWNER_GRANT_AND_HARDWARE_QUALIFICATION_REQUIRED'
        : 'UNSUPPORTED_PLATFORM'
    }))};
}

export function parseArgs(args){
  const result={platform:'',all:false,products:[],browserBundled:false,list:false,listAddons:false,json:false};
  for(let i=0;i<args.length;i++){
    const a=args[i];
    if(a==='--platform')result.platform=args[++i]??'';
    else if(a==='--product')result.products.push(args[++i]??'');
    else if(a==='--all')result.all=true;
    else if(a==='--browser-bundled')result.browserBundled=true;
    else if(a==='--list-products')result.list=true;
    else if(a==='--list-addons')result.listAddons=true;
    else if(a==='--json')result.json=true;
    else throw Error('UNKNOWN_OPTION '+a);
  }
  if(!platforms.includes(result.platform))throw Error('USE_--platform_windows_OR_linux');
  if(result.listAddons&&(result.list||result.all||result.products.length||result.browserBundled))throw Error('ADDON_LIST_READ_ONLY_ONLY');
  return result;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=parseArgs(process.argv.slice(2));
    if(args.listAddons){
      const listing=listControlCenterAddons(args);
      if(args.json)console.log(JSON.stringify(listing));
      else for(const a of listing.items)console.log(a.id+'\t'+a.admission+'\t'+a.name+' — '+a.reason);
    }else if(args.list){
      const products=catalog.products.map(x=>({id:x.id,name:x.name,
        status:x.platforms[args.platform].status,reason:x.platforms[args.platform].reason??null}));
      if(args.json)console.log(JSON.stringify({platform:args.platform,products}));
      else for(const p of products)console.log(p.id+'\t'+p.status+'\t'+p.name+(p.reason?' — '+p.reason:''));
    }else{
      const plan=createPlan(args);
      if(args.json)console.log(JSON.stringify(plan));
      else{
        for(const p of plan.products)console.log(p.id+'\t'+p.phase+'\t'+p.name);
        console.log('PLAN_ONLY changesApplied=false');
      }
    }
  }catch(e){console.error('PRODUCT_SELECTION_ERROR '+e.message);process.exitCode=2;}
}
