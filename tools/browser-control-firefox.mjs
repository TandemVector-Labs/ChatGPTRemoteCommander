#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

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
 for(const dir of String(process.env.PATH??'').split(path.delimiter).filter(Boolean)){
  const p=path.join(dir,name);if(exists(p))return p;
 }
 return null;
}
function detectFirefox(explicit){
 if(typeof explicit==='string'&&explicit&&exists(explicit)&&/firefox/i.test(path.basename(explicit)))return path.resolve(explicit);
 for(const p of [which('firefox'),'/usr/bin/firefox','/snap/bin/firefox'])if(p&&exists(p))return path.resolve(p);
 return null;
}
function detectGecko(){
 for(const p of [which('geckodriver'),'/snap/bin/geckodriver','/usr/bin/geckodriver'])if(p&&exists(p))return path.resolve(p);
 return null;
}
async function freePort(){
 const s=net.createServer();
 await new Promise((res,rej)=>{s.once('error',rej);s.listen(0,'127.0.0.1',res);});
 const p=s.address().port;await new Promise(r=>s.close(r));return p;
}
let browser=null;
async function http(method,pathname,body,timeoutMs=30000){
 if(!browser?.port)throw fail('BROWSER_SESSION_NOT_RUNNING');
 let response;
 try{
  response=await fetch('http://127.0.0.1:'+browser.port+pathname,{
   method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),
   signal:AbortSignal.timeout(Math.max(1000,Math.min(30000,timeoutMs)))
  });
 }catch{throw fail('BROWSER_WEBDRIVER_UNAVAILABLE');}
 let data;try{data=await response.json();}catch{throw fail('BROWSER_WEBDRIVER_BAD_RESPONSE');}
 if(!response.ok||data?.value?.error)throw fail('BROWSER_WEBDRIVER_COMMAND_FAILED');
 return data?.value;
}
async function waitDriver(child,port){
 const until=Date.now()+10000;
 while(Date.now()<until){
  if(child.exitCode!==null)throw fail('BROWSER_LAUNCH_FAILED');
  try{const r=await fetch('http://127.0.0.1:'+port+'/status',{signal:AbortSignal.timeout(500)});if(r.ok)return;}catch{}
  await sleep(100);
 }
 throw fail('BROWSER_DEVTOOLS_TIMEOUT');
}
async function stopDriver(child){
 if(!child||child.exitCode!==null)return;
 try{child.kill('SIGTERM');}catch{}
 for(let i=0;i<30;i++){if(child.exitCode!==null)return;await sleep(50);}
 try{child.kill('SIGKILL');}catch{}
}
async function closeBrowser({preserveProfile=false}={}){
 const b=browser;browser=null;if(!b)return;
 try{if(b.sessionId)await fetch('http://127.0.0.1:'+b.port+'/session/'+b.sessionId,{method:'DELETE',signal:AbortSignal.timeout(5000)});}catch{}
 await stopDriver(b.driver);
 if(b.isolated&&!preserveProfile){try{fs.rmSync(b.profileDir,{recursive:true,force:true});}catch{throw fail('BROWSER_PROFILE_CLEANUP_FAILED');}}
}
async function startBrowser(req){
 if(browser)throw fail('BROWSER_SESSION_ALREADY_RUNNING');
 const executable=detectFirefox(req.executable),driverExecutable=detectGecko();
 if(!executable||!driverExecutable)throw fail('BROWSER_EXECUTABLE_NOT_FOUND');
 const profileDir=path.resolve(req.profileDir);fs.mkdirSync(profileDir,{recursive:true,mode:0o700});
 const port=await freePort();
 let driver;try{driver=spawn(driverExecutable,['--host','127.0.0.1','--port',String(port)],{stdio:'ignore',windowsHide:true,shell:false});}catch{throw fail('BROWSER_HELPER_START_FAILED');}
 browser={driver,port,sessionId:null,profileDir,isolated:req.isolated===true,executable,driverExecutable,product:null,headless:req.headless!==false};
 try{
  await waitDriver(driver,port);
  const args=['-profile',profileDir];
  if(req.headless!==false)args.unshift('-headless');
  const created=await http('POST','/session',{capabilities:{alwaysMatch:{browserName:'firefox','moz:firefoxOptions':{args}}}},15000);
  if(!created?.sessionId)throw fail('BROWSER_DEVTOOLS_UNAVAILABLE');
  browser.sessionId=created.sessionId;browser.product='Firefox '+String(created.capabilities?.browserVersion??'').trim();
  return {ok:true,background:browser.headless,headless:browser.headless,foreground:!browser.headless,userDesktopTouched:!browser.headless,
    profileMode:browser.isolated?'isolated':'persistent',browserProduct:browser.product,executable,backend:'firefox-webdriver'};
 }catch(e){await closeBrowser({preserveProfile:req.preserveProfileOnFailure===true});throw e;}
}
async function evaluate(expression,{timeoutMs=10000}={}){
 if(!browser?.sessionId)throw fail('BROWSER_SESSION_NOT_RUNNING');
 const value=await http('POST','/session/'+browser.sessionId+'/execute/sync',{script:'return ('+expression+');',args:[]},timeoutMs);
 return value;
}
async function snapshot(req){
 const maxText=Math.max(1000,Math.min(40000,req.maxTextChars??20000));
 const maxElements=Math.max(1,Math.min(300,req.maxElements??120));
 const expression=`(()=>{const clean=s=>String(s??'').replace(/\\s+/g,' ').trim();const text=(document.body?.innerText??'').slice(0,${maxText});const nodes=[...document.querySelectorAll('a,button,input,textarea,select,form')].slice(0,${maxElements}).map((el,i)=>{const tag=el.tagName.toLowerCase();const o={index:i,tag,id:el.id||null,name:el.getAttribute('name'),ariaLabel:el.getAttribute('aria-label'),placeholder:el.getAttribute('placeholder')};if(tag==='a'){o.text=clean(el.textContent).slice(0,200);o.href=el.href||null;}else if(tag==='button'){o.text=clean(el.textContent).slice(0,200);o.type=el.getAttribute('type')||null;}else if(tag==='input'){o.type=(el.getAttribute('type')||'text').toLowerCase();o.autocomplete=el.getAttribute('autocomplete');}else if(tag==='textarea'){o.autocomplete=el.getAttribute('autocomplete');}else if(tag==='select'){o.options=el.options?.length??0;}else if(tag==='form'){o.action=el.action||null;o.method=(el.method||'get').toLowerCase();}return o;});const inputs=[...document.querySelectorAll('input')];const passwordInputCount=inputs.filter(x=>(x.type||'').toLowerCase()==='password').length;const otpInputCount=inputs.filter(x=>(x.autocomplete||'').toLowerCase()==='one-time-code'||/otp|one.?time|verification.?code/i.test((x.name||'')+' '+(x.id||'')+' '+(x.placeholder||''))).length;const captchaDetected=!!document.querySelector('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],[class*="captcha" i],[id*="captcha" i]');return {url:location.href,title:document.title,text,elements:nodes,signals:{passwordInputCount,otpInputCount,captchaDetected}};})()`;
 const value=await evaluate(expression,{timeoutMs:10000});
 const signals=value?.signals??{};let suggestedForegroundReason=null;
 if(signals.captchaDetected)suggestedForegroundReason='captcha';else if((signals.otpInputCount??0)>0)suggestedForegroundReason='mfa';else if((signals.passwordInputCount??0)>0)suggestedForegroundReason='saved-browser-credential';
 const pageUrl=redactUrl(value?.url);
 const elements=Array.isArray(value?.elements)?value.elements.map(item=>{const next={...item};if(typeof next.href==='string'){const x=redactUrl(next.href);next.href=x.url;next.hrefQueryRedacted=x.queryRedacted;next.hrefFragmentRedacted=x.fragmentRedacted;next.hrefSchemeRedacted=x.schemeRedacted;}if(typeof next.action==='string'){const x=redactUrl(next.action);next.action=x.url;next.actionQueryRedacted=x.queryRedacted;next.actionFragmentRedacted=x.fragmentRedacted;next.actionSchemeRedacted=x.schemeRedacted;}return next;}):[];
 return {...value,url:pageUrl.url,urlQueryRedacted:pageUrl.queryRedacted,urlFragmentRedacted:pageUrl.fragmentRedacted,urlSchemeRedacted:pageUrl.schemeRedacted,elements,background:true,passwordValuesReturned:false,cookiesReturned:false,savedPasswordStoreAccess:false,foregroundFallbackSuggested:!!suggestedForegroundReason,suggestedForegroundReason};
}
async function relaunch(req){
 if(!browser)throw fail('BROWSER_SESSION_NOT_RUNNING');
 let resume=null;try{const u=new URL(await evaluate('location.href'));if(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password)resume=u.href;}catch{}
 const prior={profileDir:browser.profileDir,isolated:browser.isolated,executable:browser.executable};
 const headless=req.headless!==false;await closeBrowser({preserveProfile:true});
 let next;try{next=await startBrowser({...prior,headless});}catch(e){if(!headless)try{await startBrowser({...prior,headless:true});}catch{}throw e;}
 let resumeNavigationFailed=false;
 if(resume)try{await http('POST','/session/'+browser.sessionId+'/url',{url:resume},8000);}catch(e){if(headless)resumeNavigationFailed=true;else{try{await closeBrowser({preserveProfile:true});await startBrowser({...prior,headless:true});}catch{}throw e;}}
 const current=redactUrl(await evaluate('location.href'));
 return {...next,resumedUrl:current.url,urlQueryRedacted:current.queryRedacted,urlFragmentRedacted:current.fragmentRedacted,sameOwnedProfile:true,resumeNavigationFailed};
}
async function handle(req){
 switch(req.action){
  case 'status':{const executable=detectFirefox(req.executable),driverExecutable=detectGecko();return {ok:true,available:!!executable&&!!driverExecutable,backend:executable&&driverExecutable?'firefox-webdriver':null,executable,driverExecutable,active:!!browser,headless:browser?.headless??null,foreground:browser?browser.headless===false:false,backgroundOnly:browser?browser.headless===true:true,userDesktopTouched:browser?browser.headless===false:false,savedPasswordStoreAccess:false};}
  case 'start':return startBrowser(req);
  case 'end':await closeBrowser();return {ok:true,closed:true};
  case 'relaunch':return relaunch(req);
  case 'navigate':{if(!browser)throw fail('BROWSER_SESSION_NOT_RUNNING');const u=new URL(req.url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw fail('BROWSER_URL_NOT_ALLOWED');await http('POST','/session/'+browser.sessionId+'/url',{url:u.href},req.timeoutMs??30000);const current=redactUrl(await evaluate('location.href'));return {ok:true,url:current.url,urlQueryRedacted:current.queryRedacted,urlFragmentRedacted:current.fragmentRedacted,title:await evaluate('document.title'),background:true};}
  case 'snapshot':return {ok:true,...await snapshot(req)};
  case 'screenshot':{if(!browser)throw fail('BROWSER_SESSION_NOT_RUNNING');const data=await http('GET','/session/'+browser.sessionId+'/screenshot',undefined,30000);if(typeof data!=='string'||!data)throw fail('BROWSER_SCREENSHOT_FAILED');const bytes=Buffer.from(data,'base64');if(bytes.length>(req.maxBytes??2097152))throw fail('BROWSER_SCREENSHOT_TOO_LARGE');const current=redactUrl(await evaluate('location.href'));return {ok:true,data,mimeType:'image/png',bytes:bytes.length,url:current.url,urlQueryRedacted:current.queryRedacted,urlFragmentRedacted:current.fragmentRedacted,title:await evaluate('document.title'),background:true};}
  case 'fill':{const sel=serializePageValue(req.selector),txt=serializePageValue(req.text);const expr=`(()=>{const el=document.querySelector(${sel});if(!el)return {ok:false,code:'BROWSER_SELECTOR_NOT_FOUND'};if(el.disabled||el.readOnly)return {ok:false,code:'BROWSER_ELEMENT_NOT_EDITABLE'};if(el.tagName==='INPUT'&&(el.type||'').toLowerCase()==='file')return {ok:false,code:'BROWSER_FILE_INPUT_NOT_ALLOWED'};const v=${txt};if(el.isContentEditable){el.textContent=v;}else if(el.tagName==='SELECT'){el.value=v;}else{const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const set=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(set)set.call(el,v);else el.value=v;}el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true,tag:el.tagName.toLowerCase(),type:(el.type||null)};})()`;const v=await evaluate(expr);if(!v?.ok)throw fail(v?.code??'BROWSER_FILL_FAILED');return {ok:true,filled:true,selector:req.selector,background:true,valueReturned:false};}
  case 'click':{const sel=serializePageValue(req.selector);const expr=`(()=>{const el=document.querySelector(${sel});if(!el)return {ok:false,code:'BROWSER_SELECTOR_NOT_FOUND'};if(el.disabled)return {ok:false,code:'BROWSER_ELEMENT_DISABLED'};el.scrollIntoView({block:'center',inline:'center'});el.click();return {ok:true,tag:el.tagName.toLowerCase()};})()`;const v=await evaluate(expr);if(!v?.ok)throw fail(v?.code??'BROWSER_CLICK_FAILED');await sleep(50);return {ok:true,clicked:true,selector:req.selector,background:true,verificationRequired:true};}
  case 'wait':{const timeout=Math.max(100,Math.min(30000,req.timeoutMs??5000)),until=Date.now()+timeout;while(Date.now()<until){let ok=false;if(req.selector!==undefined){const s=serializePageValue(req.selector);ok=await evaluate(`!!document.querySelector(${s})`);}else if(req.textIncludes!==undefined){const t=serializePageValue(req.textIncludes);ok=await evaluate(`(document.body?.innerText??'').includes(${t})`);}else if(req.urlIncludes!==undefined){const u=serializePageValue(req.urlIncludes);ok=await evaluate(`location.href.includes(${u})`);}if(ok)return {ok:true,matched:true,background:true};await sleep(75);}throw fail('BROWSER_WAIT_TIMEOUT');}
  default:throw fail('BROWSER_UNKNOWN_ACTION');
 }
}
async function respond(req){try{return await handle(req);}catch(e){return {ok:false,error:safeCode(e)};}}
async function main(){
 if(process.argv.includes('--server')){process.stdout.write(JSON.stringify({ok:true,ready:true,protocol:1})+'\n');const rl=createInterface({input:process.stdin,crlfDelay:Infinity});try{for await(const line of rl){if(!line.trim())continue;let req;try{req=JSON.parse(line);}catch{process.stdout.write(JSON.stringify({ok:false,error:'BROWSER_HELPER_BAD_JSON'})+'\n');continue;}const out=await respond(req);process.stdout.write(JSON.stringify(out)+'\n');}}finally{await closeBrowser();}return;}
 let input='';for await(const chunk of process.stdin)input+=chunk;let req;try{req=JSON.parse(input);}catch{process.stdout.write(JSON.stringify({ok:false,error:'BROWSER_HELPER_BAD_JSON'}));process.exitCode=2;return;}const out=await respond(req);process.stdout.write(JSON.stringify(out));await closeBrowser();
}
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{closeBrowser().finally(()=>process.exit(0));});
await main();
