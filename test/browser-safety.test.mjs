import './browser-script-literal-security.test.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserController } from '../src/browser-tools.mjs';

const config=()=>({instance:{profile:'default'},powerMode:{enabled:true,browserControl:{
 enabled:true,allowNavigate:true,allowInput:true,allowScreenshot:true,allowForegroundFallback:true,
 backgroundFirst:true,foregroundFallback:'explicit-current-request-only',workflowBrowserAllowed:false,
 userBrowserProfileReuse:false,savedPasswordExtraction:false
}}});
function fixture(overrides={}){
 let t=0,calls=[],closed=0,failClick=false;
 const invoke=async req=>{
  calls.push(req);
  if(req.action==='status')return {ok:true,available:true,backend:'chromium-cdp-headless',active:false};
  if(req.action==='start')return {ok:true,browserProduct:'Chrome/154',background:true};
  if(req.action==='end'){closed++;return {ok:true,closed:true};}
  if(req.action==='relaunch')return {ok:true,headless:req.headless!==false,foreground:req.headless===false,browserProduct:'Chrome/154',sameOwnedProfile:true};
  if(req.action==='navigate')return {ok:true,url:req.url,title:'Page'};
  if(req.action==='snapshot')return {ok:true,url:'https://example.test/login',title:'Login',text:'Sign in',elements:[],signals:{passwordInputCount:1,otpInputCount:0,captchaDetected:false},foregroundFallbackSuggested:true,suggestedForegroundReason:'saved-browser-credential'};
  if(req.action==='screenshot')return {ok:true,data:Buffer.from('89504e470d0a1a0a','hex').toString('base64'),mimeType:'image/png',bytes:8,url:'https://example.test',title:'x'};
  if(req.action==='fill')return {ok:true,filled:true};
  if(req.action==='click'){if(failClick)throw Object.assign(new Error('BROWSER_CDP_CLOSED'),{browserCode:'BROWSER_CDP_CLOSED'});return {ok:true,clicked:true};}
  if(req.action==='wait')return {ok:true,matched:true};
  throw new Error('unexpected '+req.action);
 };
 const ctl=createBrowserController({invoke,closeInvoke:()=>{closed++;},now:()=>t,token:(()=>{let n=0;return()=>String(++n).padStart(48,'a');})(),...overrides});
 return {ctl,ctx:{config:config()},calls,get closed(){return closed;},failClick:()=>{failClick=true;},time:v=>{t=v;}};
}
test('background browser status advertises zero-interference and no password-store extraction',async()=>{
 const f=fixture();const s=await f.ctl.execute(f.ctx,'browser_status',{});
 assert.equal(s.available,true);assert.equal(s.policy.backgroundFirst,true);
 assert.equal(s.policy.userDesktopTouchedByDefault,false);
 assert.equal(s.policy.savedPasswordExtraction,false);
 assert.equal(s.policy.userBrowserProfileReuse,false);
});
test('owned background session navigates, snapshots auth signals and never asks for takeover by default',async()=>{
 const f=fixture();const b=await f.ctl.execute(f.ctx,'browser_session_begin',{profile:'uni',mode:'persistent'});
 assert.equal(b.background,true);assert.equal(b.userDesktopTouched,false);assert.equal(b.savedPasswordStoreAccess,false);
 const n=await f.ctl.execute(f.ctx,'browser_navigate',{lease:b.lease,url:'https://example.test/login'});
 assert.equal(n.userDesktopTouched,false);
 const s=await f.ctl.execute(f.ctx,'browser_snapshot',{lease:b.lease});
 assert.equal(s.foregroundFallbackSuggested,true);assert.equal(s.suggestedForegroundReason,'saved-browser-credential');
 assert.equal(s.passwordValuesReturned,false);assert.equal(s.cookiesReturned,false);
 await f.ctl.execute(f.ctx,'browser_session_end',{lease:b.lease});assert.equal(f.closed,1);
});
test('valid mixed-case, dotted and numeric instance names map to distinct browser profile namespaces',async()=>{
 const f=fixture();const dirs=[];
 for(const instance of ['default','Work','Research.1','123']){
  f.ctx.config.instance.profile=instance;
  const b=await f.ctl.execute(f.ctx,'browser_session_begin',{profile:'uni',mode:'persistent'});
  const start=[...f.calls].reverse().find(x=>x.action==='start');
  dirs.push(start.profileDir);
  await f.ctl.execute(f.ctx,'browser_session_end',{lease:b.lease});
 }
 assert.equal(new Set(dirs.map(x=>x.toLowerCase())).size,4);
 assert.ok(dirs[0].includes('default'));
 assert.ok(dirs.slice(1).every(x=>/instance-[0-9a-f]+/i.test(x)));
});

test('foreground requirement returns approval workflow but never takes over the desktop itself',async()=>{
 const f=fixture();const b=await f.ctl.execute(f.ctx,'browser_session_begin',{});
 const a=await f.ctl.execute(f.ctx,'browser_foreground_requirement',{lease:b.lease,reason:'mfa',targetHost:'example.test'});
 assert.equal(a.approvalRequired,true);assert.equal(a.desktopTakenOver,false);
 assert.equal(a.authorizationPolicy,'explicit-current-request-only');
 assert.match(a.nextStep,/gui_session_begin\(mode="takeover"/);
});
test('foreground fallback requires explicit current-task approval and relaunches the same owned profile back to headless',async()=>{
 const f=fixture();const b=await f.ctl.execute(f.ctx,'browser_session_begin',{profile:'uni',mode:'persistent'});
 await assert.rejects(f.ctl.execute(f.ctx,'browser_foreground_begin',{lease:b.lease,explicitUserAuthorization:'   '}),/BROWSER_EXPLICIT_FOREGROUND_AUTHORIZATION_REQUIRED/);
 const visible=await f.ctl.execute(f.ctx,'browser_foreground_begin',{lease:b.lease,explicitUserAuthorization:'User explicitly asked to use mouse and keyboard for this task.'});
 assert.equal(visible.foreground,true);assert.equal(visible.sameOwnedProfile,true);assert.equal(visible.userDesktopTouched,true);
 const relaunchVisible=f.calls.find(x=>x.action==='relaunch'&&x.headless===false);
 assert.ok(relaunchVisible);assert.equal(Object.hasOwn(relaunchVisible,'explicitUserAuthorization'),false);
 const nav=await f.ctl.execute(f.ctx,'browser_navigate',{lease:b.lease,url:'https://example.test/visible'});
 assert.equal(nav.background,false);assert.equal(nav.userDesktopTouched,true);
 const shot=await f.ctl.execute(f.ctx,'browser_screenshot',{lease:b.lease,format:'png'});
 assert.equal(shot.__structuredContent.background,false);assert.equal(shot.__structuredContent.userDesktopTouched,true);
 const resumed=await f.ctl.execute(f.ctx,'browser_foreground_end',{lease:b.lease});
 assert.equal(resumed.backgroundResumed,true);assert.equal(resumed.headless,true);assert.equal(resumed.sameOwnedProfile,true);
 assert.ok(f.calls.find(x=>x.action==='relaunch'&&x.headless===true));
 await assert.rejects(f.ctl.execute(f.ctx,'browser_foreground_end',{lease:b.lease}),/BROWSER_FOREGROUND_NOT_ACTIVE/);
});

test('failed foreground begin keeps controller mode background and does not misreport later work',async()=>{
 const calls=[];
 const invoke=async req=>{
  calls.push(req);
  if(req.action==='start')return {ok:true,browserProduct:'Chrome/test'};
  if(req.action==='relaunch'&&req.headless===false)throw Object.assign(new Error('BROWSER_NAVIGATION_FAILED'),{browserCode:'BROWSER_NAVIGATION_FAILED'});
  if(req.action==='navigate')return {ok:true,url:req.url,title:'background'};
  if(req.action==='end')return {ok:true,closed:true};
  throw new Error('unexpected '+req.action);
 };
 const ctl=createBrowserController({invoke,token:()=> 'c'.repeat(48)});
 const ctx={config:config()};
 const b=await ctl.execute(ctx,'browser_session_begin',{});
 await assert.rejects(ctl.execute(ctx,'browser_foreground_begin',{lease:b.lease,explicitUserAuthorization:'Use the browser visibly for this task.'}),/BROWSER_NAVIGATION_FAILED/);
 const nav=await ctl.execute(ctx,'browser_navigate',{lease:b.lease,url:'https://example.test/after-failed-begin'});
 assert.equal(nav.background,true);assert.equal(nav.userDesktopTouched,false);
 await ctl.execute(ctx,'browser_session_end',{lease:b.lease});
});

test('failed foreground end clears visible-mode state and fail-closes mutations',async()=>{
 const calls=[];let visible=false;
 const invoke=async req=>{
  calls.push(req);
  if(req.action==='start')return {ok:true,browserProduct:'Chrome/test'};
  if(req.action==='relaunch'&&req.headless===false){visible=true;return {ok:true,foreground:true,browserProduct:'Chrome/test',sameOwnedProfile:true};}
  if(req.action==='relaunch'&&req.headless===true){visible=false;throw Object.assign(new Error('BROWSER_LAUNCH_FAILED'),{browserCode:'BROWSER_LAUNCH_FAILED'});}
  if(req.action==='snapshot')return {ok:true,url:'https://example.test/',title:'x',text:'x',elements:[]};
  if(req.action==='end')return {ok:true,closed:true};
  throw new Error('unexpected '+req.action);
 };
 const ctl=createBrowserController({invoke,token:()=> 'd'.repeat(48)});
 const ctx={config:config()};
 const b=await ctl.execute(ctx,'browser_session_begin',{});
 await ctl.execute(ctx,'browser_foreground_begin',{lease:b.lease,explicitUserAuthorization:'Use the browser visibly for this task.'});
 await assert.rejects(ctl.execute(ctx,'browser_foreground_end',{lease:b.lease}),/BROWSER_LAUNCH_FAILED/);
 assert.equal(visible,false);
 await assert.rejects(ctl.execute(ctx,'browser_navigate',{lease:b.lease,url:'https://example.test/blocked'}),/BROWSER_OUTCOME_UNCERTAIN_SNAPSHOT_REQUIRED/);
 const snap=await ctl.execute(ctx,'browser_snapshot',{lease:b.lease});
 assert.equal(snap.background,true);assert.equal(snap.userDesktopTouched,false);
 await ctl.execute(ctx,'browser_session_end',{lease:b.lease});
});

test('uncertain browser mutation cannot blind-retry until a fresh DOM snapshot reconciles state',async()=>{
 const f=fixture();const b=await f.ctl.execute(f.ctx,'browser_session_begin',{});
 f.failClick();
 await assert.rejects(f.ctl.execute(f.ctx,'browser_click',{lease:b.lease,selector:'#submit'}),/BROWSER_CDP_CLOSED/);
 await assert.rejects(f.ctl.execute(f.ctx,'browser_click',{lease:b.lease,selector:'#submit'}),/BROWSER_OUTCOME_UNCERTAIN_SNAPSHOT_REQUIRED/);
 await f.ctl.execute(f.ctx,'browser_snapshot',{lease:b.lease});
 f.failClick=()=>{};
});
test('browser permissions remain individually enforceable',async()=>{
 const f=fixture();f.ctx.config.powerMode.browserControl.allowInput=false;
 const b=await f.ctl.execute(f.ctx,'browser_session_begin',{});
 await assert.rejects(f.ctl.execute(f.ctx,'browser_fill',{lease:b.lease,selector:'#x',text:'x'}),/BROWSER_INPUT_DISABLED/);
 f.ctx.config.powerMode.browserControl.allowInput=true;f.ctx.config.powerMode.browserControl.allowNavigate=false;
 await assert.rejects(f.ctl.execute(f.ctx,'browser_navigate',{lease:b.lease,url:'https://example.test'}),/BROWSER_NAVIGATION_DISABLED/);
});
test('session input validation rejects non-http URLs, path-like profiles and ambiguous waits',async()=>{
 const f=fixture();
 await assert.rejects(f.ctl.execute(f.ctx,'browser_session_begin',{profile:'../user'}),/BROWSER_INVALID_ARGUMENTS/);
 const b=await f.ctl.execute(f.ctx,'browser_session_begin',{});
 await assert.rejects(f.ctl.execute(f.ctx,'browser_navigate',{lease:b.lease,url:'file:///etc/passwd'}),/BROWSER_URL_NOT_ALLOWED/);
 await assert.rejects(f.ctl.execute(f.ctx,'browser_wait',{lease:b.lease,selector:'#x',textIncludes:'x'}),/BROWSER_WAIT_EXACTLY_ONE_CONDITION/);
});
test('standard/disabled browser policy fails before native session start',async()=>{
 const f=fixture();f.ctx.config.powerMode.browserControl.enabled=false;
 await assert.rejects(f.ctl.execute(f.ctx,'browser_session_begin',{}),/BROWSER_DISABLED/);
 assert.equal(f.calls.length,0);
});

test('TTL expiry during an in-flight mutation closes the helper after that one effect and leaves no lease', async()=>{
  let timerCallback=null,clickResolve,endCalls=0,clickCalls=0;
  const invoke=async req=>{
    if(req.action==='start')return {ok:true,browserProduct:'Chrome/test'};
    if(req.action==='click'){
      clickCalls++;
      return await new Promise(resolve=>{clickResolve=()=>resolve({ok:true,clicked:true});});
    }
    if(req.action==='end'){endCalls++;return {ok:true,closed:true};}
    if(req.action==='status')return {ok:true,available:true,backend:'chromium-cdp-headless',active:false};
    throw new Error('unexpected '+req.action);
  };
  const ctl=createBrowserController({
    invoke,
    scheduleTimeout:fn=>{timerCallback=fn;return {unref(){}};},
    cancelTimeout:()=>{},
    token:(()=>{let n=0;return()=>String(++n).padStart(48,'b');})()
  });
  const ctx={config:config()};
  const begun=await ctl.execute(ctx,'browser_session_begin',{ttlSeconds:30,mode:'isolated'});
  const pending=ctl.execute(ctx,'browser_click',{lease:begun.lease,selector:'#submit'});
  await new Promise(r=>setImmediate(r));
  assert.equal(clickCalls,1);
  timerCallback();
  clickResolve();
  const result=await pending;
  assert.equal(result.clicked,true);
  assert.equal(clickCalls,1);
  assert.equal(endCalls,1);
  const status=await ctl.execute(ctx,'browser_status',{});
  assert.equal(status.leased,false);
  assert.equal(status.active,false);
  await assert.rejects(ctl.execute(ctx,'browser_click',{lease:begun.lease,selector:'#submit'}),/BROWSER_LEASE_REQUIRED_OR_EXPIRED/);
});
