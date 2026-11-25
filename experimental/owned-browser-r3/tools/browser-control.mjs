#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {closeOwnedBrowser} from '../src/graceful-browser-close.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const safeCode=e=>/^[A-Z][A-Z0-9_]{1,79}$/.test(e?.browserCode??e?.message??'')?(e.browserCode??e.message):'BROWSER_NATIVE_FAILED';
const fail=code=>Object.assign(new Error(code),{browserCode:code});
function serializePageValue(value){
  const literal=JSON.stringify(value);
  if(typeof literal!=='string')throw fail('BROWSER_INPUT_INVALID');
  // Escape script-breaking HTML delimiters and JS line separators AFTER JSON encoding.
  // Based on CodeQL js/bad-code-sanitization; preserve the original string's JS value.
  return literal.replace(/</g,'\\u003c')
    .replace(/>/g,'\\u003e')
    .replace(/\u2028/g,'\\u2028')
    .replace(/\u2029/g,'\\u2029');
}
const redactUrl=value=>{
 try{
  const u=new URL(String(value));
  if(!['http:','https:'].includes(u.protocol))return {url:null,queryRedacted:false,fragmentRedacted:false,schemeRedacted:true};
  u.username='';u.password='';
  const hadSearch=!!u.search,hadHash=!!u.hash;
  u.search='';u.hash='';
  return {url:u.href,queryRedacted:hadSearch,fragmentRedacted:hadHash,schemeRedacted:false};
 }catch{return {url:null,queryRedacted:false,fragmentRedacted:false,schemeRedacted:false};}
};
const exists=p=>{try{return fs.statSync(p).isFile();}catch{return false;}};
function which(name){
 const exts=process.platform==='win32'?['.exe','.cmd','']:[''];
 for(const dir of String(process.env.PATH??'').split(path.delimiter).filter(Boolean)){
  for(const ext of exts){const p=path.join(dir,name+ext);if(exists(p))return p;}
 }
 return null;
}
function detectBrowser(explicit){
 if(typeof explicit==='string'&&explicit&&exists(explicit))return path.resolve(explicit);
 const candidates=[];
 if(process.platform==='win32'){
  for(const base of [process.env.LOCALAPPDATA,process.env.PROGRAMFILES,process.env['PROGRAMFILES(X86)']].filter(Boolean)){
   candidates.push(path.join(base,'Google','Chrome','Application','chrome.exe'));
   candidates.push(path.join(base,'Microsoft','Edge','Application','msedge.exe'));
  }
 }else{
  for(const n of ['google-chrome','google-chrome-stable','chromium','chromium-browser','microsoft-edge','msedge']){
   const p=which(n);if(p)candidates.push(p);
  }
  candidates.push('/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/microsoft-edge');
 }
 return candidates.find(exists)??null;
}
class Cdp {
 constructor(url){this.url=url;this.ws=null;this.seq=0;this.pending=new Map();}
 async open(){
  const ws=new WebSocket(this.url);this.ws=ws;
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(fail('BROWSER_CDP_CONNECT_TIMEOUT')),10000);
   ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
   ws.addEventListener('error',()=>{clearTimeout(timer);reject(fail('BROWSER_CDP_CONNECT_FAILED'));},{once:true});
  });
  ws.addEventListener('message',ev=>{
   let m;try{m=JSON.parse(String(ev.data));}catch{return;}
   if(!m.id||!this.pending.has(m.id))return;
   const p=this.pending.get(m.id);this.pending.delete(m.id);clearTimeout(p.timer);
   if(m.error)p.reject(fail('BROWSER_CDP_COMMAND_FAILED'));else p.resolve(m.result??{});
  });
  ws.addEventListener('close',()=>{
   for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(fail('BROWSER_CDP_CLOSED'));}
   this.pending.clear();
  });
 }
 send(method,params={},sessionId=undefined,timeoutMs=30000){
  if(!this.ws||this.ws.readyState!==WebSocket.OPEN)return Promise.reject(fail('BROWSER_CDP_CLOSED'));
  return new Promise((resolve,reject)=>{
   const id=++this.seq;const timer=setTimeout(()=>{this.pending.delete(id);reject(fail('BROWSER_CDP_TIMEOUT'));},timeoutMs);
   this.pending.set(id,{resolve,reject,timer});
   const msg={id,method,params};if(sessionId)msg.sessionId=sessionId;
   try{this.ws.send(JSON.stringify(msg));}catch{clearTimeout(timer);this.pending.delete(id);reject(fail('BROWSER_CDP_CLOSED'));}
  });
 }
 close(){try{this.ws?.close();}catch{}this.ws=null;}
}
let browser=null;
async function portAlive(port){
 if(!Number.isInteger(port)||port<1||port>65535)return false;
 try{const c=new AbortController();const t=setTimeout(()=>c.abort(),350);const r=await fetch('http://127.0.0.1:'+port+'/json/version',{signal:c.signal});clearTimeout(t);return r.ok;}catch{return false;}
}
async function waitForPortFile(file,child){
 for(let i=0;i<240;i++){
  if(child.exitCode!==null)throw fail('BROWSER_LAUNCH_FAILED');
  if(fs.existsSync(file)){
   const lines=fs.readFileSync(file,'utf8').trim().split(/\r?\n/);const port=Number(lines[0]);
   if(Number.isInteger(port)&&port>0)return port;
  }
  await sleep(25);
 }
 throw fail('BROWSER_DEVTOOLS_TIMEOUT');
}
async function evaluate(expression,{returnByValue=true,timeoutMs=30000}={}){
 if(!browser?.cdp||!browser.sessionId)throw fail('BROWSER_SESSION_NOT_RUNNING');
 const r=await browser.cdp.send('Runtime.evaluate',{expression,returnByValue,awaitPromise:true,userGesture:true},browser.sessionId,timeoutMs);
 if(r.exceptionDetails)throw fail('BROWSER_PAGE_SCRIPT_FAILED');
 return r.result?.value;
}
async function ready(timeoutMs){
 const until=Date.now()+timeoutMs;
 while(Date.now()<until){
  try{const state=await evaluate('document.readyState');if(state==='complete'||state==='interactive')return;}catch{}
  await sleep(50);
 }
 throw fail('BROWSER_NAVIGATION_TIMEOUT');
}
function killOwnedProfileProcesses(){throw fail('BROWSER_DESTRUCTIVE_CLEANUP_NOT_ADMITTED');}
async function closeBrowser({preserveProfile=false}={}){
 const b=browser;if(!b)return;
 try{await closeOwnedBrowser(b);}finally{if(b.child?.exitCode!==null)browser=null;}
}
async function startBrowserForRelaunch(prior,headless){
 let lastError=null,cleaned=false;
 for(let attempt=0;attempt<4;attempt++){
  try{return await startBrowser({...prior,headless,preserveProfileOnFailure:true});}
  catch(error){
   lastError=error;
   if(!['BROWSER_LAUNCH_FAILED','BROWSER_PROFILE_IN_USE'].includes(error?.browserCode)||attempt===3)throw error;
   if(!cleaned){killOwnedProfileProcesses(prior.profileDir);cleaned=true;}
   await sleep(250*(attempt+1));
  }
 }
 throw lastError??fail('BROWSER_LAUNCH_FAILED');
}
async function startBrowser(req){
 if(browser)throw fail('BROWSER_SESSION_ALREADY_RUNNING');
 if(req.isolated!==true||req.headless!==true)throw fail('BROWSER_FIXTURE_ISOLATED_HEADLESS_ONLY');
 const executable=detectBrowser(req.executable);if(!executable)throw fail('BROWSER_EXECUTABLE_NOT_FOUND');
 const profileDir=path.resolve(req.profileDir);
 const expectedRoot=process.env.SBL_PROFILE_ROOT;
 if(!expectedRoot||path.dirname(profileDir)!==path.resolve(expectedRoot)||fs.realpathSync(expectedRoot)!==path.resolve(expectedRoot)||fs.lstatSync(expectedRoot).isSymbolicLink())throw fail('BROWSER_FIXTURE_ROOT');
 fs.mkdirSync(profileDir,{mode:0o700});
 const portFile=path.join(profileDir,'DevToolsActivePort');
 if(fs.existsSync(portFile))throw fail('BROWSER_FIXTURE_PROFILE_NOT_EMPTY');
 const headless=req.headless!==false;
 const args=['--remote-debugging-port=0','--user-data-dir='+profileDir,'--no-first-run','--no-default-browser-check','--disable-sync','--disable-background-networking','--disable-extensions','--disable-component-update','--disable-default-apps','--window-size=1280,900'];
 if(headless)args.unshift('--headless=new');
 args.push('about:blank');
 let child;try{child=spawn(executable,args,{stdio:['ignore','ignore','ignore'],windowsHide:headless,shell:false});}catch{throw fail('BROWSER_LAUNCH_FAILED');}
 browser={child,cdp:null,sessionId:null,targetId:null,profileDir,isolated:req.isolated===true,executable,product:null,port:null,headless,createdAtEpochMs:Date.now()};
 try{
  const port=await waitForPortFile(portFile,child);browser.port=port;
  let version;try{version=await (await fetch('http://127.0.0.1:'+port+'/json/version')).json();}catch{throw fail('BROWSER_DEVTOOLS_UNAVAILABLE');}
  if(typeof version.webSocketDebuggerUrl!=='string')throw fail('BROWSER_DEVTOOLS_UNAVAILABLE');
  browser.product=version.Browser??null;
  const cdp=new Cdp(version.webSocketDebuggerUrl);browser.cdp=cdp;await cdp.open();
  const target=await cdp.send('Target.createTarget',{url:'about:blank'});browser.targetId=target.targetId;
  const attached=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:true});browser.sessionId=attached.sessionId;
  await cdp.send('Page.enable',{},browser.sessionId);
  await cdp.send('Runtime.enable',{},browser.sessionId);
  await cdp.send('Network.enable',{},browser.sessionId);
  return {ok:true,background:headless,headless,foreground:!headless,userDesktopTouched:!headless,
    profileMode:browser.isolated?'isolated':'persistent',browserProduct:browser.product,executable};
 }catch(e){try{await closeBrowser({preserveProfile:true});}catch(cleanup){e.secondaryRecords=[...(e.secondaryRecords??[]),{phase:'START_CLEANUP',code:safeCode(cleanup)}];}throw e;}
}
async function snapshot(req){
 const maxText=Math.max(1000,Math.min(40000,req.maxTextChars??20000));
 const maxElements=Math.max(1,Math.min(300,req.maxElements??120));
 const expression=`(()=>{const clean=s=>String(s??'').replace(/\\s+/g,' ').trim();const text=(document.body?.innerText??'').slice(0,${maxText});const nodes=[...document.querySelectorAll('a,button,input,textarea,select,form')].slice(0,${maxElements}).map((el,i)=>{const tag=el.tagName.toLowerCase();const o={index:i,tag,id:el.id||null,name:el.getAttribute('name'),ariaLabel:el.getAttribute('aria-label'),placeholder:el.getAttribute('placeholder')};if(tag==='a'){o.text=clean(el.textContent).slice(0,200);o.href=el.href||null;}else if(tag==='button'){o.text=clean(el.textContent).slice(0,200);o.type=el.getAttribute('type')||null;}else if(tag==='input'){o.type=(el.getAttribute('type')||'text').toLowerCase();o.autocomplete=el.getAttribute('autocomplete');}else if(tag==='textarea'){o.autocomplete=el.getAttribute('autocomplete');}else if(tag==='select'){o.options=el.options?.length??0;}else if(tag==='form'){o.action=el.action||null;o.method=(el.method||'get').toLowerCase();}return o;});const inputs=[...document.querySelectorAll('input')];const passwordInputCount=inputs.filter(x=>(x.type||'').toLowerCase()==='password').length;const otpInputCount=inputs.filter(x=>(x.autocomplete||'').toLowerCase()==='one-time-code'||/otp|one.?time|verification.?code/i.test((x.name||'')+' '+(x.id||'')+' '+(x.placeholder||''))).length;const captchaDetected=!!document.querySelector('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],[class*="captcha" i],[id*="captcha" i]');return {url:location.href,title:document.title,text,elements:nodes,signals:{passwordInputCount,otpInputCount,captchaDetected}};})()`;
 const value=await evaluate(expression,{timeoutMs:10000});
 const signals=value?.signals??{};
 let suggestedForegroundReason=null;
 if(signals.captchaDetected)suggestedForegroundReason='captcha';
 else if((signals.otpInputCount??0)>0)suggestedForegroundReason='mfa';
 else if((signals.passwordInputCount??0)>0)suggestedForegroundReason='saved-browser-credential';
 const pageUrl=redactUrl(value?.url);
 const elements=Array.isArray(value?.elements)?value.elements.map(item=>{
  const next={...item};
  if(typeof next.href==='string'){const x=redactUrl(next.href);next.href=x.url;next.hrefQueryRedacted=x.queryRedacted;next.hrefFragmentRedacted=x.fragmentRedacted;next.hrefSchemeRedacted=x.schemeRedacted;}
  if(typeof next.action==='string'){const x=redactUrl(next.action);next.action=x.url;next.actionQueryRedacted=x.queryRedacted;next.actionFragmentRedacted=x.fragmentRedacted;next.actionSchemeRedacted=x.schemeRedacted;}
  return next;
 }):[];
 return {...value,url:pageUrl.url,urlQueryRedacted:pageUrl.queryRedacted,urlFragmentRedacted:pageUrl.fragmentRedacted,urlSchemeRedacted:pageUrl.schemeRedacted,elements,background:true,passwordValuesReturned:false,cookiesReturned:false,savedPasswordStoreAccess:false,foregroundFallbackSuggested:!!suggestedForegroundReason,suggestedForegroundReason};
}
async function handle(req){
 if(!req||!['status','start','end','navigate','snapshot'].includes(req.action))throw fail('BROWSER_FIXTURE_ACTION_NOT_ADMITTED');
 switch(req.action){
  case 'status':{
   const executable=detectBrowser(req.executable);
   return {ok:true,available:!!executable,backend:executable?'chromium-cdp':null,executable,active:!!browser,
    headless:browser?.headless??null,foreground:browser?browser.headless===false:false,
    backgroundOnly:browser?browser.headless===true:true,userDesktopTouched:browser?browser.headless===false:false,savedPasswordStoreAccess:false,
    ownedFixture:browser?{pid:browser.child.pid,profileId:path.basename(browser.profileDir),isolated:browser.isolated,createdAtEpochMs:browser.createdAtEpochMs}:null};
  }
  case 'start':return startBrowser(req);
  case 'end':await closeBrowser();return {ok:true,closed:true};
  case 'relaunch':{
   if(!browser)throw fail('BROWSER_SESSION_NOT_RUNNING');
   let resume=null;
   try{const current=await evaluate('location.href');const u=new URL(current);if(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password)resume=u.href;}catch{}
   const prior={profileDir:browser.profileDir,isolated:browser.isolated,executable:browser.executable};
   const targetHeadless=req.headless!==false;
   await closeBrowser({preserveProfile:true});
   let next;
   try{
    next=await startBrowserForRelaunch(prior,targetHeadless);
   }catch(error){
    if(!targetHeadless){
     try{await startBrowserForRelaunch(prior,true);}
     catch{try{await closeBrowser();}catch{}}
    }
    throw error;
   }
   let resumeNavigationFailed=false;
   if(resume){
    try{
     const nav=await browser.cdp.send('Page.navigate',{url:resume},browser.sessionId,8000);
     if(nav.errorText)throw fail('BROWSER_NAVIGATION_FAILED');
     await ready(8000);
    }catch(e){
     if(targetHeadless){
      resumeNavigationFailed=true;
     }else{
      try{
       await closeBrowser({preserveProfile:true});
       await startBrowserForRelaunch(prior,true);
      }catch{
       try{await closeBrowser();}catch{}
      }
      throw e;
     }
    }
   }
   const current=redactUrl(await evaluate('location.href'))??{url:null,queryRedacted:false,fragmentRedacted:false};
   return {...next,resumedUrl:current.url,urlQueryRedacted:current.queryRedacted,urlFragmentRedacted:current.fragmentRedacted,
    sameOwnedProfile:true,resumeNavigationFailed};
  }
  case 'navigate':{
   if(!browser)throw fail('BROWSER_SESSION_NOT_RUNNING');
   if(typeof process.env.SBL_FIXTURE_URL!=='string'||req.url!==process.env.SBL_FIXTURE_URL)throw fail('BROWSER_FIXTURE_URL_ONLY');
   const u=new URL(req.url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw fail('BROWSER_URL_NOT_ALLOWED');
   const r=await browser.cdp.send('Page.navigate',{url:u.href},browser.sessionId,req.timeoutMs??30000);
   if(r.errorText)throw fail('BROWSER_NAVIGATION_FAILED');await ready(req.timeoutMs??30000);
   const current=redactUrl(await evaluate('location.href'));
   return {ok:true,url:current.url,urlQueryRedacted:current.queryRedacted,urlFragmentRedacted:current.fragmentRedacted,title:await evaluate('document.title'),background:true};
  }
  case 'snapshot':return {ok:true,...await snapshot(req)};
  case 'screenshot':{
   if(!browser)throw fail('BROWSER_SESSION_NOT_RUNNING');
   const format=req.format??'jpeg';const params={format,fromSurface:true,captureBeyondViewport:false};
   if(format==='jpeg')params.quality=req.quality??70;
   const r=await browser.cdp.send('Page.captureScreenshot',params,browser.sessionId,30000);
   const data=r.data;if(typeof data!=='string'||!data)throw fail('BROWSER_SCREENSHOT_FAILED');
   const bytes=Buffer.from(data,'base64');if(bytes.length>(req.maxBytes??2097152))throw fail('BROWSER_SCREENSHOT_TOO_LARGE');
   const current=redactUrl(await evaluate('location.href'));
   return {ok:true,data,mimeType:format==='png'?'image/png':'image/jpeg',bytes:bytes.length,url:current.url,urlQueryRedacted:current.queryRedacted,urlFragmentRedacted:current.fragmentRedacted,title:await evaluate('document.title'),background:true};
  }
  case 'fill':{
   const sel=serializePageValue(req.selector),txt=serializePageValue(req.text);
   const expr=`(()=>{const el=document.querySelector(${sel});if(!el)return {ok:false,code:'BROWSER_SELECTOR_NOT_FOUND'};if(el.disabled||el.readOnly)return {ok:false,code:'BROWSER_ELEMENT_NOT_EDITABLE'};if(el.tagName==='INPUT'&&(el.type||'').toLowerCase()==='file')return {ok:false,code:'BROWSER_FILE_INPUT_NOT_ALLOWED'};const v=${txt};if(el.isContentEditable){el.textContent=v;}else if(el.tagName==='SELECT'){el.value=v;}else{const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const set=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(set)set.call(el,v);else el.value=v;}el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true,tag:el.tagName.toLowerCase(),type:(el.type||null)};})()`;
   const v=await evaluate(expr);if(!v?.ok)throw fail(v?.code??'BROWSER_FILL_FAILED');return {ok:true,filled:true,selector:req.selector,background:true,valueReturned:false};
  }
  case 'click':{
   const sel=serializePageValue(req.selector);
   const expr=`(()=>{const el=document.querySelector(${sel});if(!el)return {ok:false,code:'BROWSER_SELECTOR_NOT_FOUND'};if(el.disabled)return {ok:false,code:'BROWSER_ELEMENT_DISABLED'};el.scrollIntoView({block:'center',inline:'center'});el.click();return {ok:true,tag:el.tagName.toLowerCase()};})()`;
   const v=await evaluate(expr);if(!v?.ok)throw fail(v?.code??'BROWSER_CLICK_FAILED');await sleep(50);return {ok:true,clicked:true,selector:req.selector,background:true,verificationRequired:true};
  }
  case 'wait':{
   const timeout=Math.max(100,Math.min(30000,req.timeoutMs??5000)),until=Date.now()+timeout;
   while(Date.now()<until){
    let ok=false;
    if(req.selector!==undefined){const s=serializePageValue(req.selector);ok=await evaluate(`!!document.querySelector(${s})`);}
    else if(req.textIncludes!==undefined){const t=serializePageValue(req.textIncludes);ok=await evaluate(`(document.body?.innerText??'').includes(${t})`);}
    else if(req.urlIncludes!==undefined){const u=serializePageValue(req.urlIncludes);ok=await evaluate(`location.href.includes(${u})`);}
    if(ok)return {ok:true,matched:true,background:true};await sleep(75);
   }
   throw fail('BROWSER_WAIT_TIMEOUT');
  }
  default:throw fail('BROWSER_UNKNOWN_ACTION');
 }
}
async function respond(req){
 try{return await handle(req);}catch(e){return {ok:false,error:safeCode(e),secondaryRecords:e.secondaryRecords??[]};}
}
async function main(){
 if(process.argv.includes('--server')){
  process.stdout.write(JSON.stringify({ok:true,ready:true,protocol:1})+'\n');
  const rl=createInterface({input:process.stdin,crlfDelay:Infinity});
  try{for await(const line of rl){if(!line.trim())continue;let req;try{req=JSON.parse(line);}catch{process.stdout.write(JSON.stringify({ok:false,error:'BROWSER_HELPER_BAD_JSON'})+'\n');continue;}const out=await respond(req);process.stdout.write(JSON.stringify(out)+'\n');}}
  finally{await closeBrowser();}
  return;
 }
 let input='';for await(const chunk of process.stdin)input+=chunk;let req;try{req=JSON.parse(input);}catch{process.stdout.write(JSON.stringify({ok:false,error:'BROWSER_HELPER_BAD_JSON'}));process.exitCode=2;return;}const out=await respond(req);process.stdout.write(JSON.stringify(out));await closeBrowser();
}
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{closeBrowser().finally(()=>process.exit(0));});
await main();
