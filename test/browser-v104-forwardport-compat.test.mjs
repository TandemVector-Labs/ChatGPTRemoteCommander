import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserController, browserToolDefinitions } from '../src/browser-tools.mjs';

const ctx={config:{instance:{profile:'v104_qa'},powerMode:{enabled:true,browserControl:{
 enabled:true,allowNavigate:true,allowInput:true,allowScreenshot:false,
 foregroundFallback:'explicit-current-request-only',allowForegroundFallback:false
}}}};

test('0.12 forwardport retains native Chat-tab contract and adds fail-closed owner/transfer tools',async()=>{
 const names=new Set(browserToolDefinitions.map(x=>x.name));
 for(const name of ['browser_chat_tabs','browser_chat_tab_open','browser_chat_tab_close',
   'browser_owner_route_plan','browser_upload_file','browser_download_file'])
   assert.ok(names.has(name),name);
 const tool=browserToolDefinitions.find(x=>x.name==='browser_owner_route_plan');
 assert.equal(tool.annotations.readOnlyHint,true);
 const calls=[];
 const invoke=async req=>{
   calls.push(req.action);
   if(req.action==='start')return {ok:true,browserProduct:'synthetic owned Chrome'};
   if(req.action==='snapshot')return {ok:true,url:'https://example.test/a',elements:[]};
   if(req.action==='chat_tabs')return {ok:true,ready:true,managedTabs:[],counts:{OPEN:0}};
   if(req.action==='chat_tab_open')return {ok:true,owned:true,tabRef:'a'.repeat(32)};
   if(req.action==='chat_tab_close')return {ok:true,closed:true};
   if(req.action==='end')return {ok:true,closed:true};
   throw new Error('UNEXPECTED_EFFECT_'+req.action);
 };
 const ctl=createBrowserController({invoke,closeInvoke:()=>{},ownerWindowObserver:async()=>[
   {app_name:'Brave-browser',pid:999,window_id:12345,title:'PRIVATE TITLE'}]});
 try{
   const owner=await ctl.execute(ctx,'browser_owner_route_plan',
     {targetUrl:'https://example.test/private?secret=do-not-echo'});
   assert.equal(owner.status,'BLOCKED');
   assert.equal(owner.code,'EXISTING_OWNER_SESSION_NOT_ATTESTED');
   assert.equal(owner.noImplicitOwnedBrowserFallback,true);
   assert.equal(owner.windowCount,1);
   assert.equal(owner.credentialsRead,false);
   assert.equal(owner.userDesktopTouched,false);
   assert.equal(JSON.stringify(owner).includes('PRIVATE TITLE'),false);
   assert.equal(JSON.stringify(owner).includes('secret=do-not-echo'),false);
   assert.deepEqual(calls,[],'owner plan must not start browser');

   const {lease}=await ctl.execute(ctx,'browser_session_begin',{mode:'isolated',ttlSeconds:30});
   const open=await ctl.execute(ctx,'browser_chat_tab_open',{lease,url:'https://chatgpt.com/'});
   assert.equal(open.tabRef,'a'.repeat(32));
   const tabs=await ctl.execute(ctx,'browser_chat_tabs',{lease});
   assert.equal(tabs.ready,true);
   await ctl.execute(ctx,'browser_chat_tab_close',{lease,tabRef:open.tabRef});
   const grantRef='unverified';
   await assert.rejects(ctl.execute(ctx,'browser_upload_file',{
     lease,selector:'input[type=file]',filename:'sample.txt',expectedSha256:'a'.repeat(64),grantRef
   }),/BROWSER_TRANSFER_AUTH_CONTEXT_REQUIRED/);
   await assert.rejects(ctl.execute(ctx,'browser_download_file',{
     lease,selector:'a[download]',filename:'sample.txt',grantRef
   }),/BROWSER_TRANSFER_AUTH_CONTEXT_REQUIRED/);
   assert.equal(calls.includes('transfer_upload'),false);
   assert.equal(calls.includes('transfer_download'),false);
   assert.equal(calls.filter(x=>x==='chat_tab_open').length,1);
   assert.equal(calls.filter(x=>x==='chat_tab_close').length,1);
   const ended=await ctl.execute(ctx,'browser_session_end',{lease});
   assert.equal(ended.closed,true);
 }finally{ctl.close()}
});
