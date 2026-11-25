// AgentOS capability router. No model/driver can confer OS privileges.
// Execution stays under Commander policy; this module only chooses a provider.
const TARGETS=new Set(['existing-browser','new-browser','existing-app','new-app','project']);
const OS=new Set(['win32','linux']);
const b=v=>v===true;
const denied=(code,next)=>Object.freeze({status:'BLOCKED',code,next,autoElevate:false,credentials:'NEVER_COPY',foreground:'PRESERVE'});
const selected=(provider,mode,description)=>Object.freeze({
 status:'READY',provider,mode,description,execution:'COMMANDER_POLICY_ENFORCED',
 autoElevate:false,credentials:'NEVER_COPY',foreground:'PRESERVE'
});
export const agentosProviders=Object.freeze({
 'ufo2-app-native':{platform:'win32',transport:'local MCP / UFO2 AppAgent',kind:'GUI_AND_NATIVE_API'},
 'windows-uia-native':{platform:'win32',transport:'native UIAutomation pattern',kind:'SEMANTIC_UI'},
 'linux-atspi-native':{platform:'linux',transport:'AT-SPI (owning session)',kind:'SEMANTIC_UI'},
 'playwright-mcp':{platform:'cross',transport:'Playwright DOM accessibility',kind:'BROWSER'},
 'chrome-devtools-mcp':{platform:'cross',transport:'Chrome DevTools protocol',kind:'BROWSER'},
 'browser-extension-owner':{platform:'cross',transport:'verified same-owner browser extension/native messaging',kind:'BROWSER'},
 'webdriver-bidi-native':{platform:'cross',transport:'verified owner-browser WebDriver BiDi',kind:'BROWSER'},
 'commander-owned-browser':{platform:'cross',transport:'existing Browser Commander lease',kind:'BROWSER'},
 'cua-last-resort':{platform:'cross',transport:'verified owner-target visual fallback',kind:'VISUAL'},
 'codex-app-server':{platform:'cross',transport:'app-server JSON-RPC',kind:'AGENT_PLANNER'}
});
export function chooseAgentOSProvider(input={}){
 const {target,platform,ownerSession,capabilities={},grants={},application={}}=input;
 if(!TARGETS.has(target)||!OS.has(platform))throw Error('AGENTOS_INPUT_INVALID');
 if(typeof capabilities!=='object'||!capabilities||Array.isArray(capabilities)
    ||typeof grants!=='object'||!grants||Array.isArray(grants))throw Error('AGENTOS_INPUT_INVALID');
 const planner=b(capabilities.codexAuthenticated)&&b(capabilities.codexAppServer)
   ? 'codex-app-server' : 'commander-workflow';
 const family=application.browserFamily??'unknown';
 if(!['unknown','firefox','brave','chrome','edge','chromium','vivaldi','opera','safari','other'].includes(family))
  throw Error('AGENTOS_BROWSER_FAMILY_INVALID');
 const dedicatedChatGPT=application.purpose==='chatgpt-connection';
 const chromiumFamily=['chrome','edge','brave','chromium','vivaldi','opera'].includes(family);
 const nativeBrowser=()=>b(ownerSession)&&b(grants.nativeBrowserUI)
  ?(platform==='win32'&&b(capabilities.windowsUIA)?'windows-uia-native'
   :platform==='linux'&&b(capabilities.linuxATSPI)?'linux-atspi-native':null):null;
 const directCdp=chromiumFamily&&application.profileKind!=='default'
  &&b(grants.browserProfileAttach)&&b(capabilities.chromeDevtoolsExistingAuthorized);
 // Alternative provider names are planning candidates, never authorization to replay an effect.
 // Every transition requires a fresh observation and normal Commander policy re-admission.
 const fallbackFor=route=>{
  if(route.status!=='READY')return Object.freeze([]);
  const candidates=[];
  const add=(provider,valid)=>{if(valid&&provider&&provider!==route.provider)candidates.push(provider);};
  if(target==='existing-browser'){
   add('browser-extension-owner',b(grants.browserExtensionAttach)&&b(capabilities.browserExtensionExistingAuthorized));
   add('webdriver-bidi-native',b(grants.browserProfileAttach)&&b(capabilities.webdriverBiDiExistingAuthorized));
   add('playwright-mcp',b(grants.browserProfileAttach)&&b(capabilities.playwrightExistingAuthorized));
   add('chrome-devtools-mcp',directCdp);
   add(nativeBrowser(),!!nativeBrowser());
   add('cua-last-resort',b(grants.visualFallback)&&b(capabilities.cuaVerifiedOwnerTarget));
  }else if(target==='new-browser'){
   add('chrome-devtools-mcp',b(capabilities.chromeDevtoolsOwned));
   add('commander-owned-browser',dedicatedChatGPT&&b(capabilities.commanderOwnedBrowser));
  }else if(target==='new-app'||target==='existing-app'){
   if(platform==='win32')add('windows-uia-native',b(capabilities.windowsUIA)&&b(ownerSession));
   add('cua-last-resort',b(capabilities.cuaVerifiedOwnerTarget)&&b(grants.visualFallback));
  }
  return Object.freeze([...new Set(candidates)]);
 };
 const withPlanner=route=>{
   const fallbackProviders=fallbackFor(route);
   return Object.freeze({...route,planner,fallbackAllowed:fallbackProviders.length>0,
     fallbackProviders,fallbackMode:'REPLAN_ONLY_AFTER_FRESH_OBSERVATION',
     uncertainEffectsNeverAutoRetried:true});
 };
 if(target==='project')return withPlanner(b(capabilities.commanderWorkflow)
   ?selected('commander-workflow','STRUCTURED_TASKS','Use the existing project engine and approved host tools')
   :denied('PROJECT_ENGINE_UNAVAILABLE','Restore Commander workflow engine; no new competing orchestrator'));
 if(target.startsWith('existing-')&&!b(ownerSession))return withPlanner(denied(
   'OWNER_SESSION_REQUIRED','Run native provider under verified owning OS principal and login session'));
 const browser=target.endsWith('browser');
 if(browser){
  if(target==='existing-browser'){
   // No global browser default: route the exact verified owner browser, not a guessed Chrome.
   if(b(grants.browserExtensionAttach)&&b(capabilities.browserExtensionExistingAuthorized))
    return withPlanner(selected('browser-extension-owner','OWNER_EXTENSION','Verified owner extension/native bridge'));
   if(b(grants.browserProfileAttach)&&b(capabilities.webdriverBiDiExistingAuthorized))
    return withPlanner(selected('webdriver-bidi-native','BIDI','Verified same-owner BiDi endpoint'));
   if(b(grants.browserProfileAttach)&&b(capabilities.playwrightExistingAuthorized))
    return withPlanner(selected('playwright-mcp','DOM','Verified owner Playwright browser transport'));
   if(directCdp)return withPlanner(selected('chrome-devtools-mcp','CDP','Verified non-default Chromium endpoint'));
   const native=nativeBrowser();
   if(native)return withPlanner(selected(native,'SEMANTIC_UI','Exact same-owner browser accessibility UI'));
   if(b(grants.visualFallback)&&b(capabilities.cuaVerifiedOwnerTarget))
    return withPlanner(selected('cua-last-resort','EXACT_TARGET_VISUAL','Verified visual target only'));
   if(!b(grants.browserProfileAttach)&&!b(grants.browserExtensionAttach)&&!b(grants.nativeBrowserUI)&&!b(grants.visualFallback))
    return withPlanner(denied('BROWSER_OWNER_CONSENT_REQUIRED','Owner native permission for the exact browser required'));
   return withPlanner(denied('BROWSER_EXISTING_PROFILE_ROUTE_UNAVAILABLE',
    'No verified route: never copy cookies, profile or credentials, and do not pretend browser consent'));
  }
  if(b(capabilities.playwrightOwned))return withPlanner(selected('playwright-mcp','OWNED_ISOLATED_DOM','Isolated browser DOM'));
  if(b(capabilities.chromeDevtoolsOwned))return withPlanner(selected('chrome-devtools-mcp','OWNED_ISOLATED_CDP','Isolated Chromium CDP'));
  if(dedicatedChatGPT&&b(capabilities.commanderOwnedBrowser))
   return withPlanner(selected('commander-owned-browser','CHATGPT_CONNECTION_ONLY','Dedicated ChatGPT-only Commander browser'));
  return withPlanner(denied('OWNED_BROWSER_UNAVAILABLE','Use a verified isolated route; Commander browser only for ChatGPT connection'));
 }
 if(platform==='win32'){
  if(b(application.nativeAPI)&&b(capabilities.ufo2AppAgent)&&b(grants.nativeApplication))
   return withPlanner(selected('ufo2-app-native','NATIVE_API','UFO2 AppAgent: WinCOM / native app API before GUI'));
  if(b(capabilities.windowsUIA)&&b(ownerSession))
   return withPlanner(selected('windows-uia-native','SEMANTIC_UI','Native UI Automation Invoke/Value patterns, exact target'));
 }else if(b(capabilities.linuxATSPI)&&b(ownerSession)){
  return withPlanner(selected('linux-atspi-native','SEMANTIC_UI','AT-SPI semantic UI on the owning X11/Wayland session'));
 }
 if(b(capabilities.cuaVerifiedOwnerTarget)&&b(grants.visualFallback))
  return withPlanner(selected('cua-last-resort','EXACT_TARGET_VISUAL','Fallback only after verified owner target; never global input'));
 if(target==='new-app')
  return withPlanner(denied('APPLICATION_EXECUTOR_REQUIRED','Install platform-native app executor or create a private application session'));
 return withPlanner(denied('SEMANTIC_PROVIDER_UNAVAILABLE','Prepare UFO2/UIA (Windows) or AT-SPI (Linux); CUA is never the only path'));
}
