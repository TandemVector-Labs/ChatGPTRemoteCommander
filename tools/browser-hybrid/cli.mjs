#!/usr/bin/env node
// Owner-local V1-04 hybrid browser runner. Playwright is the primary Chromium
// automation engine; the existing Commander CDP/Firefox WebDriver adapters are
// the portable fallback. No personal browser profile is opened or copied.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';

const FLAGS=new Set(['--engine','--url','--steps','--screenshot','--profile','--ai-model','--allow-origin']);
const SAFE_ENGINE=new Set(['auto','playwright','chromium','firefox','stagehand']);
const MAX_STEPS=32, MAX_TEXT=4096, MAX_SELECTOR=512;
const parent=path.dirname(fileURLToPath(import.meta.url));
const shortError=e=>String(e?.browserCode||e?.code||e?.message||e||'BROWSER_HYBRID_FAILED').slice(0,350);
function parse(argv){
 const command=argv[0]||'doctor', options={engine:'auto'};
 if(!['doctor','smoke','run'].includes(command))throw Error('COMMAND_NOT_SUPPORTED');
 for(let i=1;i<argv.length;i++){
  let key=argv[i],value=null;
  if(key.includes('=')){const p=key.indexOf('=');value=key.slice(p+1);key=key.slice(0,p);}
  if(!FLAGS.has(key))throw Error('UNKNOWN_FLAG_'+key);
  if(value===null){value=argv[++i];if(value===undefined)throw Error('FLAG_VALUE_REQUIRED_'+key);}
  options[key.slice(2)]=value;
 }
 if(!SAFE_ENGINE.has(options.engine))throw Error('ENGINE_INVALID');
 if(command==='run'&&!options.url)throw Error('URL_REQUIRED');
 if(options.profile&&!/^[a-z][a-z0-9_-]{0,31}$/.test(options.profile))throw Error('PROFILE_INVALID');
 if(Boolean(options['ai-model'])!==Boolean(options['allow-origin']))throw Error('AI_MODEL_AND_ORIGIN_REQUIRED');
 if(options['ai-model']&&(command!=='run'||options.engine!=='stagehand'))throw Error('AI_REQUIRES_EXPLICIT_STAGEHAND_RUN');
 return {command,options};
}
function statFile(p){try{return fs.statSync(p).isFile()?p:null;}catch{return null;}}
function which(name){
 for(const p of String(process.env.PATH||'').split(path.delimiter).filter(Boolean)){
  const found=statFile(path.join(p,name));if(found)return found;
 }
 return null;
}
function installed(){
 const home=os.homedir(),win=process.platform==='win32';
 const winPaths=win?[
  path.join(process.env.ProgramFiles||'C:\\Program Files','Google','Chrome','Application','chrome.exe'),
  path.join(process.env['ProgramFiles(x86)']||'C:\\Program Files (x86)','Microsoft','Edge','Application','msedge.exe'),
  path.join(process.env.ProgramFiles||'C:\\Program Files','Microsoft','Edge','Application','msedge.exe'),
  path.join(process.env.LOCALAPPDATA||path.join(home,'AppData','Local'),'Google','Chrome','Application','chrome.exe'),
  path.join(process.env.ProgramFiles||'C:\\Program Files','Mozilla Firefox','firefox.exe'),
  path.join(process.env['ProgramFiles(x86)']||'C:\\Program Files (x86)','Mozilla Firefox','firefox.exe')
 ]:[];
 const chrome=[process.env.RC_BROWSER_EXECUTABLE,which('google-chrome'),which('chromium'),which('brave-browser'),which('msedge'),
  ...winPaths.filter(x=>/chrome.exe|msedge.exe$/i.test(x))].filter(Boolean).map(statFile).find(Boolean)||null;
 const firefox=[which(win?'firefox.exe':'firefox'),...winPaths.filter(x=>/firefox.exe$/i.test(x)),
  '/usr/bin/firefox','/snap/bin/firefox'].filter(Boolean).map(statFile).find(Boolean)||null;
 const gecko=[which(win?'geckodriver.exe':'geckodriver'),
  path.join(home,'.local','bin','geckodriver'),
  path.join(home,'.local','share','chatgpt-remote-commander','adapters','geckodriver','geckodriver'),
  path.join(process.env.LOCALAPPDATA||path.join(home,'AppData','Local'),'ChatGPTRemoteCommander','adapters','geckodriver','geckodriver.exe')
 ].filter(Boolean).map(statFile).find(Boolean)||null;
 return {chromium:chrome,firefox,geckodriver:gecko};
}
async function playwrightAvailable(){
 for(const name of ['playwright-core','playwright'])try{return await import(name);}catch{}
 for(const candidate of [process.env.RC_BROWSER_DEPS,path.resolve(parent,'..','v1')]){
  if(!candidate)continue;
  const manifest=path.join(path.resolve(candidate),'package.json');
  if(statFile(manifest))try{
   const require=createRequire(manifest);
   for(const name of ['playwright-core','playwright'])try{return require(name)}catch{}
  }catch{}
 }
 return null;
}
async function seleniumAvailable(){try{return await import('selenium-webdriver');}catch{return null;}}
async function stagehandAvailable(){try{return await import('@browserbasehq/stagehand');}catch{return null;}}
function route(requested,available){
 if(requested==='stagehand'){
  if(!available.stagehand||!available.chromium)throw Error('STAGEHAND_CHROMIUM_UNAVAILABLE');
  return 'stagehand-chromium';
 }
 if(requested==='firefox'){
  if(!available.firefox||!available.geckodriver)throw Error('FIREFOX_WEBDRIVER_UNAVAILABLE');
  return process.platform==='win32'&&available.selenium?'selenium-firefox':'firefox-webdriver';
 }
 if(requested==='playwright'){
  if(!available.playwright||!available.chromium)throw Error('PLAYWRIGHT_CHROMIUM_UNAVAILABLE');
  return 'playwright-chromium';
 }
 if(requested==='chromium'){
  if(!available.chromium)throw Error('CHROMIUM_BROWSER_UNAVAILABLE');
  return available.playwright?'playwright-chromium':'commander-cdp';
 }
 if(available.playwright&&available.chromium)return 'playwright-chromium';
 if(available.chromium)return 'commander-cdp';
 if(available.firefox&&available.geckodriver)return process.platform==='win32'&&available.selenium?'selenium-firefox':'firefox-webdriver';
 throw Error('NO_HYBRID_BROWSER_BACKEND');
}
function safeUrl(value){
 let u;try{u=new URL(value);}catch{throw Error('HTTP_URL_REQUIRED');}
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('HTTP_URL_REQUIRED');
 return u;
}
function scopedAiOrigin(input){
 const u=safeUrl(input);
 if(input!==u.origin&&input!==u.origin+'/')throw Error('AI_ORIGIN_MUST_BE_EXACT');
 if(u.protocol!=='https:' && !(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)))
  throw Error('AI_ORIGIN_REQUIRES_HTTPS_OR_LOOPBACK');
 return u.origin;
}
function reportUrl(raw){
 const u=safeUrl(raw);const query=!!u.search,fragment=!!u.hash;u.search='';u.hash='';
 return {url:u.href,queryRedacted:query,fragmentRedacted:fragment};
}
function stepsFrom(raw){
 if(!Array.isArray(raw)||raw.length>MAX_STEPS)throw Error('STEP_COUNT_INVALID');
 let observedSeen=false;
 return raw.map((s,i)=>{
  if(!s||typeof s!=='object'||Array.isArray(s))throw Error('STEP_INVALID_'+i);
  if(!['navigate','fill','click','wait','expectText','expectTitle','screenshot','observe'].includes(s.action))throw Error('ACTION_DENIED_'+i);
  if(s.selector!==undefined&&(typeof s.selector!=='string'||!s.selector||s.selector.length>MAX_SELECTOR))throw Error('SELECTOR_INVALID_'+i);
  if(s.text!==undefined&&(typeof s.text!=='string'||s.text.length>MAX_TEXT))throw Error('TEXT_INVALID_'+i);
  if(s.action==='navigate')safeUrl(s.url);
  if(s.action==='fill'&&(typeof s.selector!=='string'||typeof s.text!=='string'))throw Error('FILL_FIELDS_REQUIRED');
  if(['click','wait'].includes(s.action)&&typeof s.selector!=='string')throw Error('SELECTOR_REQUIRED');
  if(['expectText','expectTitle'].includes(s.action)&&typeof s.text!=='string')throw Error('EXPECTED_TEXT_REQUIRED');
  if(s.action==='observe'&&(typeof s.instruction!=='string'||s.instruction.length<8||s.instruction.length>320))throw Error('OBSERVE_INSTRUCTION_INVALID');
  if(s.action==='observe'&&s.selector!==undefined)throw Error('OBSERVE_SELECTOR_NOT_ACCEPTED');
  if(s.fallbackSelector!==undefined&&(s.action!=='observe'||typeof s.fallbackSelector!=='string'||!s.fallbackSelector||s.fallbackSelector.length>MAX_SELECTOR))throw Error('OBSERVE_FALLBACK_INVALID');
  if(s.selector==='@observed'&&!observedSeen)throw Error('OBSERVED_SELECTOR_NOT_READY_'+i);
  if(s.action==='observe')observedSeen=true;
  return s;
 });
}
function config(executable){
 const browserControl={
  enabled:true,allowNavigate:true,allowInput:true,allowScreenshot:true,
  executable,allowForegroundFallback:false,foregroundFallback:'explicit-current-request-only',
  requireExplicitOwnedMode:true,workflowBrowserAllowed:false,userBrowserProfileReuse:false
 };
 if(process.platform==='linux'&&/firefox/i.test(path.basename(executable||''))){
  const snapCommon=path.join(os.homedir(),'snap','firefox','common');
  if(fs.existsSync(snapCommon))browserControl.profileRoot=path.join(snapCommon,'chatgpt-remote-commander','browser-profiles');
 }
 return {config:{instance:{profile:'hybrid_cli'},powerMode:{enabled:true,browserControl}}};
}
async function driver(kind,engines,pw,selenium,stagehand,options){
 if(kind==='stagehand-chromium'){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'commander-v104-stagehand-'));
  let browser,sh;
  try{
   browser=await stagehand.localBrowser.launch({
    headless:true,userDataDir:path.join(root,'profile'),executablePath:engines.chromium});
   const config=options.modelGenerate?{browser,model:{generate:options.modelGenerate}}:{browser};
   sh=await stagehand.Stagehand.create(config);
   const [page]=await browser.context.pages();
   if(!page)throw Error('STAGEHAND_PAGE_UNAVAILABLE');
   const checkVisible=async selector=>{
    const start=Date.now();
    while(Date.now()-start<12000){
     if(await page.locator(selector).isVisible())return;
     await new Promise(resolve=>setTimeout(resolve,150));
    }
    throw Error('ELEMENT_WAIT_TIMEOUT');
   };
   return {
    kind,async navigate(url){await page.goto(safeUrl(url).href);return reportUrl(await page.url());},
    async observeSelector(instruction,fallbackSelector=null){
     if(!options.aiModel)throw Error('AI_MODEL_REQUIRED');
     let candidates=null,reason='AI_SELECTOR_NOT_UNIQUE_VISIBLE';
     try{
      const result=await sh.observe(instruction);
      const rows=result?.data;
      if(Array.isArray(rows)&&rows.length>0&&rows.length<=8)candidates=rows;
      else reason='AI_OBSERVATION_INVALID';
     }catch{reason='AI_OBSERVATION_FAILED';}
     for(const item of candidates||[]){
      const selector=item?.selector;
      if(typeof selector!=='string'||!selector||selector.length>512)continue;
      try{
       const locator=page.locator(selector);
       if(await locator.count()===1&&await locator.isVisible())
        return {selector,method:'model'};
      }catch{/* Model selectors are untrusted. Continue. */}
     }
     if(fallbackSelector){
      try{
       const locator=page.locator(fallbackSelector);
       if(await locator.count()===1&&await locator.isVisible())
        return {selector:fallbackSelector,method:'deterministic-fallback',reason};
      }catch{/* Fall through to safe failure. */}
     }
     throw Error(reason);
    },
    async canFillObserved(selector){
     try{return await page.locator(selector+':is(input:not([type=password]),textarea)').count()===1}
     catch{return false}
    },
    async fill(sel,text){await page.locator(sel).fill(text);},
    async click(sel){await page.locator(sel).click();},
    async wait(sel){await checkVisible(sel);},
    async expectText(t){if(!(await page.locator('body').innerText()).includes(t))throw Error('TEXT_NOT_FOUND');},
    async expectTitle(t){if(!(await page.title()).includes(t))throw Error('TITLE_NOT_FOUND');},
    async snapshot(){return {title:(await page.title()).slice(0,120),...reportUrl(await page.url()),engine:kind};},
    async screenshot(file){const bytes=Buffer.from(await page.screenshot({type:'png'}));
     if(bytes.length>4194304)throw Error('SCREENSHOT_TOO_LARGE');
     if(file)fs.writeFileSync(file,bytes,{flag:'wx'});return bytes.length;},
    async close(){try{await sh.close()}finally{try{await browser.close()}finally{fs.rmSync(root,{recursive:true,force:true});}}}
   };
  }catch(e){
   try{await sh?.close()}catch{}
   try{await browser?.close()}catch{}
   try{fs.rmSync(root,{recursive:true,force:true})}catch{}
   throw e;
  }
 }
 if(kind==='playwright-chromium'){
  const browser=await pw.chromium.launch({executablePath:engines.chromium,headless:true,timeout:18000,
   args:['--no-first-run','--no-default-browser-check','--disable-sync']});
  let context,page;
  try{context=await browser.newContext({acceptDownloads:false});
   page=await context.newPage();page.setDefaultTimeout(12000);}
  catch(e){try{await context?.close();}finally{await browser.close();}throw e}
  return {
   kind, async navigate(url){await page.goto(safeUrl(url).href,{waitUntil:'domcontentloaded',timeout:18000});return reportUrl(page.url());},
   async fill(sel,text){await page.locator(sel).fill(text);},
   async click(sel){await page.locator(sel).click();},
   async wait(sel){await page.locator(sel).waitFor({state:'visible'});},
   async expectText(t){if(!(await page.locator('body').innerText()).includes(t))throw Error('TEXT_NOT_FOUND');},
   async expectTitle(t){if(!(await page.title()).includes(t))throw Error('TITLE_NOT_FOUND');},
   async snapshot(){return {title:(await page.title()).slice(0,120),...reportUrl(page.url()),engine:kind};},
   async screenshot(file){const bytes=await page.screenshot({type:'png',fullPage:false,timeout:12000});
    if(bytes.length>4194304)throw Error('SCREENSHOT_TOO_LARGE');if(file)fs.writeFileSync(file,bytes,{flag:'wx'});return bytes.length;},
   async close(){try{await context.close()}finally{await browser.close()}}
  };
 }
 if(kind==='selenium-firefox'){
  const f=await import('selenium-webdriver/firefox.js');
  const opts=new f.Options().setBinary(engines.firefox).addArguments('-headless');
  const service=new f.ServiceBuilder(engines.geckodriver);
  if(process.platform==='linux'){
   const common=path.join(os.homedir(),'snap','firefox','common');
   if(fs.existsSync(common)){
    const profiles=path.join(common,'chatgpt-remote-commander','webdriver-profiles');
    fs.mkdirSync(profiles,{recursive:true,mode:0o700});
    service.addArguments('--profile-root',profiles);
   }
  }
  const web=await new selenium.Builder().forBrowser('firefox')
   .setFirefoxOptions(opts).setFirefoxService(service).build();
  try{await web.manage().setTimeouts({pageLoad:18000,script:10000,implicit:0})}
  catch(e){await web.quit().catch(()=>{});throw e}
  return {
   kind,async navigate(url){await web.get(safeUrl(url).href);return reportUrl(await web.getCurrentUrl());},
   async fill(sel,text){const el=await web.findElement(selenium.By.css(sel));await el.clear();await el.sendKeys(text);},
   async click(sel){await (await web.findElement(selenium.By.css(sel))).click();},
   async wait(sel){const el=await web.wait(selenium.until.elementLocated(selenium.By.css(sel)),12000);await web.wait(selenium.until.elementIsVisible(el),12000);},
   async expectText(t){const txt=await (await web.findElement(selenium.By.css('body'))).getText();if(!txt.includes(t))throw Error('TEXT_NOT_FOUND');},
   async expectTitle(t){if(!(await web.getTitle()).includes(t))throw Error('TITLE_NOT_FOUND');},
   async snapshot(){return {title:String(await web.getTitle()).slice(0,120),...reportUrl(await web.getCurrentUrl()),engine:kind};},
   async screenshot(file){const bytes=Buffer.from(await web.takeScreenshot(),'base64');
    if(bytes.length>4194304)throw Error('SCREENSHOT_TOO_LARGE');
    if(file)fs.writeFileSync(file,bytes,{flag:'wx'});return bytes.length;},
   async close(){await web.quit();}
  };
 }
 const executable=kind==='firefox-webdriver'?engines.firefox:engines.chromium;
 if(kind==='firefox-webdriver'&&engines.geckodriver){const gdir=path.dirname(engines.geckodriver);process.env.PATH=gdir+path.delimiter+(process.env.PATH||'');}
 const corePath=process.env.RC_BROWSER_CORE?pathToFileURL(path.resolve(process.env.RC_BROWSER_CORE)).href:new URL('../../src/browser-tools.mjs',import.meta.url).href;
 const {createBrowserController}=await import(corePath);
 const ctl=createBrowserController(),ctx=config(executable);
 let lease;
 try{
  const status=await ctl.execute(ctx,'browser_status',{});
  if(!status.available)throw Error('NATIVE_BACKEND_NOT_READY_'+(status.reason||'unknown'));
  const started=await ctl.execute(ctx,'browser_session_begin',{mode:'isolated',profile:options.profile||'hybrid',ttlSeconds:180});lease=started.lease;
 }catch(e){ctl.close();throw e}
 const doTool=(name,args)=>ctl.execute(ctx,name,{lease,...args});
 return {
  kind, async navigate(url){return doTool('browser_navigate',{url:safeUrl(url).href,timeoutMs:18000});},
  async fill(sel,text){await doTool('browser_fill',{selector:sel,text});},
  async click(sel){await doTool('browser_click',{selector:sel});},
  async wait(sel){await doTool('browser_wait',{selector:sel,timeoutMs:12000});},
  async expectText(t){const s=await doTool('browser_snapshot',{maxTextChars:20000,maxElements:80});
   if(!s.text.includes(t))throw Error('TEXT_NOT_FOUND');},
  async expectTitle(t){const s=await doTool('browser_snapshot',{maxTextChars:1000,maxElements:2});
   if(!String(s.title||'').includes(t))throw Error('TITLE_NOT_FOUND');},
  async snapshot(){const s=await doTool('browser_snapshot',{maxTextChars:3000,maxElements:20});
   return {title:String(s.title||'').slice(0,120),url:s.url,queryRedacted:s.urlQueryRedacted,
    fragmentRedacted:s.urlFragmentRedacted,engine:kind};},
  async screenshot(file){const r=await doTool('browser_screenshot',{format:'png',maxBytes:4194304});
   const i=r.__mcpContent?.find(x=>x.type==='image');if(!i)throw Error('SCREENSHOT_FAILED');
   const buf=Buffer.from(i.data,'base64');if(file)fs.writeFileSync(file,buf,{flag:'wx'});return buf.length;},
  async close(){try{if(lease)await doTool('browser_session_end',{});}finally{lease=null;ctl.close();}}
 };
}
async function runJob({engine,url,steps=[],screenshot=null,profile,aiModel=null,allowedOrigin=null}){
 safeUrl(url); // Deny invalid schemes and embedded credentials before any browser effect.
 const e=installed(),[pw,selenium,stagehand]=await Promise.all([playwrightAvailable(),seleniumAvailable(),stagehandAvailable()]);
 const capabilities={...e,playwright:!!pw,selenium:!!selenium,stagehand:!!stagehand};
 const kind=route(engine,capabilities),flow=stepsFrom(steps);
 const wantsObservation=flow.some(s=>s.action==='observe'||s.selector==='@observed');
 const hasAi=Boolean(aiModel);
 if(wantsObservation&&!hasAi)throw Error('AI_MODEL_REQUIRED');
 if(hasAi&&(kind!=='stagehand-chromium'||!allowedOrigin))throw Error('AI_STAGEHAND_AND_ORIGIN_REQUIRED');
 if(!hasAi&&allowedOrigin)throw Error('AI_MODEL_AND_ORIGIN_REQUIRED');
 const origin=hasAi?scopedAiOrigin(allowedOrigin):null;
 const requestedUrls=[url,...flow.filter(s=>s.action==='navigate').map(s=>s.url)].map(safeUrl);
 const requestedQuery=requestedUrls.some(u=>Boolean(u.search));
 const requestedFragment=requestedUrls.some(u=>Boolean(u.hash));
 if(origin&&requestedUrls.some(u=>u.origin!==origin))throw Error('AI_NAVIGATION_ORIGIN_DENIED');
 const modelGenerate=hasAi?(await import('./ollama-provider.mjs')).createOllamaGenerate({model:aiModel,timeoutMs:25000}):null;
 const run=await driver(kind,e,pw,selenium,stagehand,{profile,aiModel,modelGenerate});let pass=0,shot=null,selected=null;
 const observations=[];
 const verifyOrigin=async()=>{
  if(!origin)return;
  const current=await run.snapshot();
  if(safeUrl(current.url).origin!==origin)throw Error('AI_ACTIVE_ORIGIN_CHANGED');
 };
 try{
  await run.navigate(url);pass++;await verifyOrigin();
  for(const s of flow){
   await verifyOrigin();
   if(s.action==='navigate')await run.navigate(s.url);
   if(s.action==='observe'){
    const observed=await run.observeSelector(s.instruction,s.fallbackSelector);
    selected=observed.selector;
    observations.push({step:pass,selector:selected,method:observed.method,...(observed.reason?{fallbackReason:observed.reason}:{})});
   }
   const selector=s.selector==='@observed'?selected:s.selector;
   if(['fill','click','wait'].includes(s.action)&&!selector)throw Error('OBSERVED_SELECTOR_NOT_READY');
   if(s.action==='fill'){
    if(s.selector==='@observed'&&!(await run.canFillObserved(selected)))throw Error('AI_FILL_TARGET_NOT_ALLOWED');
    await run.fill(selector,s.text);
   }
   if(s.action==='click')await run.click(selector);
   if(s.action==='wait')await run.wait(selector);
   if(s.action==='expectText')await run.expectText(s.text);
   if(s.action==='expectTitle')await run.expectTitle(s.text);
   if(s.action==='screenshot')shot=await run.screenshot(screenshot);
   await verifyOrigin();pass++;
  }
  if(screenshot&&!shot)shot=await run.screenshot(screenshot);
  const summary=await run.snapshot();
  return {status:'PASS',engine:kind,operationsPassed:pass,screenshotBytes:shot,
   screenshotPath:screenshot||null,session:'COMMANDER_OWNED_ISOLATED',
   personalProfileAccess:false,credentialsExtracted:false,userDesktopTouched:false,...summary,
   queryRedacted:requestedQuery||summary.queryRedacted===true,
   fragmentRedacted:requestedFragment||summary.fragmentRedacted===true,
   ...(origin?{aiModel,aiOrigin:origin,observations}:{})};
 }finally{await run.close()}
}
async function smoke(engine){
 const html='<!doctype html><html><title>V104 Hybrid Ready</title><body><input id="message"><button id="apply" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#message\').value">Apply</button><p id="result"></p><input type="password" id="login"></body></html>';
 const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html)});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'commander-v104-smoke-'));
 const screenshot=path.join(folder,'hybrid-pass.png');
 try{
  const output=await runJob({engine,url:'http://127.0.0.1:'+server.address().port+'/?token=REDACT#fragment',
   steps:[{action:'fill',selector:'#message',text:'COMMANDER-HYBRID-VERIFIED'},
    {action:'click',selector:'#apply'},{action:'expectText',text:'COMMANDER-HYBRID-VERIFIED'}],
   screenshot});
  if(output.url.includes('REDACT')||output.fragmentRedacted!==true||output.queryRedacted!==true||!fs.statSync(screenshot).size)throw Error('SMOKE_REDACTION_OR_SCREENSHOT_FAILED_'+String(output.queryRedacted)+'_'+String(output.fragmentRedacted)+'_'+String(output.screenshotBytes));
  return {...output,screenshotPath:null,temporaryScreenshotRemoved:true};
 }finally{
  await new Promise(resolve=>server.close(resolve));
  fs.rmSync(folder,{recursive:true,force:true});
 }
}
async function main(){
 const {command,options}=parse(process.argv.slice(2));
 const engines=installed(),[pw,selenium,stagehand]=await Promise.all([playwrightAvailable(),seleniumAvailable(),stagehandAvailable()]);
 if(command==='doctor'){
  const capabilities={...engines,playwright:!!pw,selenium:!!selenium,stagehand:!!stagehand},available=[];
  for(const e of ['auto','chromium','firefox','playwright','stagehand']){try{available.push({requested:e,selected:route(e,capabilities)})}catch{}}
  return {status:'PASS',node:process.version,platform:process.platform,backends:available,
   nativeChromium:!!engines.chromium,nativeFirefox:!!engines.firefox,geckodriver:!!engines.geckodriver,playwrightInstalled:!!pw,seleniumInstalled:!!selenium,stagehandInstalled:!!stagehand,
   personalSessionAttach:false,ownerConsentRequired:true};
 }
 if(command==='smoke')return smoke(options.engine);
 if(command==='run'){
  const steps=options.steps?JSON.parse(fs.readFileSync(path.resolve(options.steps),'utf8')):[];
  return runJob({engine:options.engine,url:options.url,steps,
   screenshot:options.screenshot?path.resolve(options.screenshot):null,profile:options.profile,
   aiModel:options['ai-model']||null,allowedOrigin:options['allow-origin']||null});
 }
}
try{console.log(JSON.stringify(await main()))}
catch(e){console.error(JSON.stringify({status:'FAIL',reason:shortError(e),engine:process.argv.join(' ').match(/--engine(?:=|\s+)(\S+)/)?.[1]||'auto'}));process.exitCode=1}
