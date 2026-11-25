import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {createBrowserProcessClient} from '../src/browser-process.mjs';
import {createBrowserController} from '../src/browser-tools.mjs';

test('Chromium native transfer: scoped grant, atomic download and no blind retry',async t=>{
const sha=x=>createHash('sha256').update(x).digest('hex');
const payload=Buffer.from('V104_CONTROLLER_GRANT_QA\n');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'v104-controller-gate-'));
const html='<!doctype html><title>Controller Browser QA</title><input type="file" id="upload"><a id="download" download="asset.txt" href="/asset.txt">Download</a>';
const server=http.createServer((req,res)=>{if(req.url==='/asset.txt'){res.writeHead(200,{'content-type':'text/plain'});res.end(payload)}else{res.writeHead(200,{'content-type':'text/html'});res.end(html)}});
server.listen(0,'127.0.0.1');await once(server,'listening');
const origin='http://127.0.0.1:'+server.address().port;
const helper=path.join(import.meta.dirname,'..','tools','browser-control.mjs');
const client=createBrowserProcessClient({file:process.execPath,args:[helper,'--server']});
let workingProfile=null;
const invoke=async req=>{if(req.action==='start'){workingProfile=req.profileDir;fs.mkdirSync(path.join(workingProfile,'uploads'),{recursive:true});fs.writeFileSync(path.join(workingProfile,'uploads','sample.txt'),payload)}return client.invoke(req)};
const ctx={config:{instance:{profile:'qa-principal'},powerMode:{enabled:true,browserControl:{enabled:true,profileRoot:path.join(home,'owned'),allowNavigate:true,allowInput:true,allowScreenshot:false,allowForegroundFallback:false}}}};
const upload=lease=>({lease,selector:'#upload',filename:'sample.txt',expectedSha256:sha(payload),grantRef:'qa-permit'});
const download=lease=>({lease,selector:'#download',filename:'asset.txt',maxBytes:1024,grantRef:'qa-permit'});
let accepted=0;
const trustedTransferContext=async(_ctx,requirement)=>({principal:'uid:1000',profile:'qa-principal',verifyGrant:async input=>{accepted++;return input.capability==='browser.file-transfer'&&input.origin===origin&&input.operation===requirement.operation&&input.filename===requirement.filename&&input.grant==='qa-permit'}});
const ctl=createBrowserController({invoke,closeInvoke:()=>client.close(),trustedTransferContext});
let lease=null;
try{
 const status=await client.invoke({action:'status'});
 if(!status.available){t.skip('Chromium executable unavailable');return;}
 let b=await ctl.execute(ctx,'browser_session_begin',{mode:'isolated',ttlSeconds:120,profile:'test'});
 lease=b.lease;assert.equal(b.userDesktopTouched,false);
 const navigation=await ctl.execute(ctx,'browser_navigate',{lease,url:origin});assert.equal(navigation.title,'Controller Browser QA');
 let err=null;
 const denyCtl=createBrowserController({invoke:async req=>req.action==='start'?{browserProduct:'fake'}:req.action==='snapshot'?{url:origin}:req.action==='end'?{closed:true}:(()=>{throw Error('UNEXPECTED_SIDE_EFFECT')})(),closeInvoke:()=>{}});
 try{const fake=await denyCtl.execute(ctx,'browser_session_begin',{mode:'isolated'});await denyCtl.execute(ctx,'browser_upload_file',upload(fake.lease));}catch(e){err=e.browserCode??e.message;}
 assert.equal(err,'BROWSER_TRANSFER_AUTH_CONTEXT_REQUIRED');
 err=null;
 try{await ctl.execute(ctx,'browser_upload_file',{...upload(lease),grantRef:'forged'});}catch(e){err=e.browserCode??e.message;}
 assert.equal(err,'BROWSER_TRANSFER_GRANT_REQUIRED');
 const u=await ctl.execute(ctx,'browser_upload_file',upload(lease));
 assert.equal(u.ok,true);assert.equal(u.sha256,sha(payload));assert.equal(u.background,true);
 const d=await ctl.execute(ctx,'browser_download_file',download(lease));
 assert.equal(d.downloaded,true);assert.equal(d.sha256,sha(payload));
 assert.deepEqual(fs.readFileSync(path.join(workingProfile,'downloads','asset.txt')),payload);
 err=null;
 try{await ctl.execute(ctx,'browser_download_file',download(lease));}catch(e){err=e.browserCode??e.message;}
 assert.equal(err,'BROWSER_TRANSFER_DEST_EXISTS');
 err=null;try{await ctl.execute(ctx,'browser_download_file',download(lease))}catch(e){err=e.browserCode??e.message;}
 assert.equal(err,'BROWSER_OUTCOME_UNCERTAIN_SNAPSHOT_REQUIRED');
 const snapshot=await ctl.execute(ctx,'browser_snapshot',{lease,maxTextChars:1000,maxElements:5});
 assert.equal(snapshot.passwordValuesReturned,false);assert.equal(snapshot.cookiesReturned,false);
 const ended=await ctl.execute(ctx,'browser_session_end',{lease});lease=null;assert.equal(ended.closed,true);
 console.log(JSON.stringify({status:'V104_CHROMIUM_TRANSFER_ATOMIC_E2E_PASS',verifiedGrants:accepted,upload:'PASS',download:'PASS',forgedDenied:true,uncertainRetryDenied:true,noCredentialExport:true,background:true}));
}catch(e){console.error(JSON.stringify({status:'V104_CHROMIUM_TRANSFER_ATOMIC_E2E_FAIL',message:e.message,code:e.browserCode??null}));throw e;}
finally{
 if(lease)try{await ctl.execute(ctx,'browser_session_end',{lease})}catch{}
 ctl.close();client.close();await new Promise(r=>server.close(r));if(fs.existsSync(home))fs.rmSync(home,{recursive:true,force:true});
}
});
