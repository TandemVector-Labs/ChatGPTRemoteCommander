import { validateJsonSchema } from './schema-validator.mjs';

const str = (maxLength=128, extra={}) => ({type:'string',minLength:1,maxLength,...extra});
const int = (minimum,maximum) => ({type:'integer',minimum,maximum});
const choice = (...values) => ({type:'string',enum:values});
const object = (properties={},required=[]) => ({type:'object',properties,required,additionalProperties:false});
const lease={lease:str(128)};
const ro={readOnlyHint:true,destructiveHint:false,openWorldHint:true};
const coordination={readOnlyHint:false,destructiveHint:false,openWorldHint:false};
const open={readOnlyHint:false,destructiveHint:false,openWorldHint:true};
const mutation={readOnlyHint:false,destructiveHint:true,openWorldHint:true,idempotentHint:false};
const profile=str(32,{pattern:'^[a-z][a-z0-9_-]{0,31}$'});
const selector=str(512);
const defs=[
 ['browser_chat_tabs','Read privacy-minimized ChatGPT tab presence from the Commander-owned Chromium browser core. No extension, Native Messaging, DOM text, account attestation or user-browser profile is involved.',object(lease,['lease']),ro],
 ['browser_chat_tab_open','Open a lease-scoped ChatGPT tab in the Commander-owned browser only, maximum 16.',object({...lease,url:str(2048)},['lease','url']),open],
 ['browser_chat_tab_close','Close a Commander-owned tab by opaque handle.',object({...lease,tabRef:str(32,{pattern:'^[a-f0-9]{32}$'})},['lease','tabRef']),mutation],
 ['browser_status','Report zero-interference background-browser readiness. This never opens a page, touches the user desktop, reads cookies, or accesses the browser password store.',object(),ro],
 ['browser_session_begin','Start one owned headless browser session using a Commander-only profile. Persistent mode preserves that owned profile cookies/local storage between sessions; it never reuses or unlocks the user browser profile/password store.',object({ttlSeconds:int(30,1800),profile,mode:choice('persistent','isolated')},[]),coordination],
 ['browser_session_renew','Renew the owned background-browser lease.',object({...lease,ttlSeconds:int(30,1800)},['lease']),coordination],
 ['browser_session_end','Close the owned background browser and release the lease. Persistent Commander profile state remains on disk.',object(lease,['lease']),coordination],
 ['browser_navigate','Navigate the owned background page to one HTTP(S) URL without moving the user mouse, changing foreground focus, or controlling an existing user-browser window.',object({...lease,url:str(2048),timeoutMs:int(1000,30000)},['lease','url']),open],
 ['browser_snapshot','Read a bounded DOM summary from the owned background page. Password/input values, cookies and storage are never returned. Authentication/CAPTCHA signals may recommend an explicit foreground approval fallback.',object({...lease,maxTextChars:int(1000,40000),maxElements:int(1,300)},['lease']),ro],
 ['browser_screenshot','Capture the owned background page as an MCP image. This does not capture the user desktop.',object({...lease,format:choice('jpeg','png'),quality:int(25,90),maxBytes:int(262144,4194304)},['lease']),ro],
 ['browser_fill','Fill one CSS-selected input/textarea/select in the owned background page and dispatch input/change events. The submitted value is never echoed in the tool result.',object({...lease,selector,text:{type:'string',minLength:0,maxLength:4096}},['lease','selector','text']),mutation],
 ['browser_click','Click one CSS-selected element in the owned background page. A click can submit forms or trigger external side effects; verify afterward with browser_snapshot.',object({...lease,selector},['lease','selector']),mutation],
 ['browser_wait','Wait for a bounded condition in the owned background page.',object({...lease,selector,textIncludes:str(1024),urlIncludes:str(1024),timeoutMs:int(100,30000)},['lease']),ro],
 ['browser_foreground_requirement','Record that background automation reached a step requiring explicit current-task foreground approval, such as saved user-browser credentials, MFA, WebAuthn, CAPTCHA or a site that blocks headless/background operation. This tool does NOT take over the desktop.',object({...lease,reason:choice('saved-browser-credential','mfa','webauthn','captcha','site-blocked-background','other'),targetHost:str(253),detail:str(500)},['lease','reason']),coordination],
 ['browser_foreground_begin','After explicit current-task approval, relaunch the SAME Commander-owned browser profile as a visible browser so the minimum required foreground step can be completed. This may steal focus and therefore always requires explicitUserAuthorization.',object({...lease,explicitUserAuthorization:str(500)},['lease','explicitUserAuthorization']),coordination],
 ['browser_foreground_end','Return an explicitly approved visible Commander-owned browser session to headless background mode while preserving that same owned profile cookies/storage.',object(lease,['lease']),coordination]
];
export const BROWSER_RULES=new Map(defs.map(([name,description,inputSchema,annotations])=>[name,{name,description,inputSchema,annotations}]));
export const browserToolDefinitions=[...BROWSER_RULES.values()];

export function browserError(code){
 const e=new Error(code);e.rpcCode=-32602;e.browserCode=code;return e;
}
function validUrl(value){
 try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password;}
 catch{return false;}
}
export function validateBrowserInput(name,input){
 const rule=BROWSER_RULES.get(name);
 if(!rule)throw browserError('BROWSER_UNKNOWN_TOOL');
 const errors=validateJsonSchema(input,rule.inputSchema);
 if(errors.length)throw browserError('BROWSER_INVALID_ARGUMENTS');
 if(name==='browser_navigate'&&!validUrl(input.url))throw browserError('BROWSER_URL_NOT_ALLOWED');
 if(name==='browser_chat_tab_open'){
   let u;try{u=new URL(input.url);}catch{throw browserError('BROWSER_CHAT_URL_NOT_ALLOWED');}
   if(u.protocol!=='https:'||!['chatgpt.com','chat.openai.com'].includes(u.hostname)||
      u.username||u.password||u.port||u.search||u.hash||
      !(u.pathname==='/'||/^\/(?:g\/[^/?#]{1,120}\/)?c\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i.test(u.pathname)))
     throw browserError('BROWSER_CHAT_URL_NOT_ALLOWED');
 }
 if(name==='browser_wait'){
   const count=Number(input.selector!==undefined)+Number(input.textIncludes!==undefined)+Number(input.urlIncludes!==undefined);
   if(count!==1)throw browserError('BROWSER_WAIT_EXACTLY_ONE_CONDITION');
 }
 if(name==='browser_foreground_requirement'&&input.targetHost!==undefined){
   if(!/^[A-Za-z0-9.-]+$/.test(input.targetHost)||input.targetHost.startsWith('.')||input.targetHost.endsWith('.'))throw browserError('BROWSER_INVALID_HOST');
 }
 if(name==='browser_foreground_begin'){
   const authorization=input.explicitUserAuthorization?.trim();
   if(!authorization||authorization.length<8)throw browserError('BROWSER_EXPLICIT_FOREGROUND_AUTHORIZATION_REQUIRED');
 }
 return {...input};
}
