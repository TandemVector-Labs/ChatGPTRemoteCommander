import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {uploadStagedFileCdp} from '../tools/browser-transfer-native.mjs';
import {createBrowserController} from '../src/browser-tools.mjs';
import {browserToolDefinitions,validateBrowserInput} from '../src/browser-contract.mjs';
const origin='https://example.test';
const baseCtx={config:{instance:{profile:'owner'},powerMode:{enabled:true,browserControl:{enabled:true,allowNavigate:true,allowInput:true,allowScreenshot:true}}}};
const upload=lease=>({lease,selector:'#up',filename:'sample.txt',expectedSha256:'a'.repeat(64),grantRef:'attested'});
const download=lease=>({lease,selector:'#download',filename:'asset.txt',grantRef:'attested',maxBytes:100});
function fixture({trustedTransferContext,config=baseCtx,transferError=null}={}){
 const calls=[];
 const invoke=async req=>{calls.push(req);
  if(req.action==='start')return {browserProduct:'Candidate'};
  if(req.action==='snapshot')return {ok:true,url:origin,title:'Fixture'};
  if(req.action==='transfer_upload'||req.action==='transfer_download'){
   if(transferError)throw new Error(transferError);
   return {ok:true,filename:req.filename,background:true};
  }
  if(req.action==='end')return {ok:true,closed:true};
  return {ok:true};
 };
 const ctl=createBrowserController({invoke,closeInvoke:()=>{},...(trustedTransferContext?{trustedTransferContext}:{})});
 return {ctl,ctx:config,calls};
}
test('transfer tools are declared with immutable required inputs and no path argument',()=>{
 for(const name of ['browser_upload_file','browser_download_file']){
  const def=browserToolDefinitions.find(x=>x.name===name);
  assert.ok(def,name);
  assert.equal(def.inputSchema.additionalProperties,false);
  assert.ok(def.inputSchema.required.includes('grantRef'));
  assert.ok(!Object.hasOwn(def.inputSchema.properties,'path'));
  assert.ok(!Object.hasOwn(def.inputSchema.properties,'absolutePath'));
 }
 assert.throws(()=>validateBrowserInput('browser_upload_file',{lease:'l',selector:'#x',filename:'f.txt',expectedSha256:'x'.repeat(64),grantRef:'r'}),/BROWSER_INVALID_ARGUMENTS/);
});
test('default controller never performs native transfer without trust injection',async()=>{
 const f=fixture();let lease;
 try{
  ({lease}=await f.ctl.execute(f.ctx,'browser_session_begin',{mode:'isolated'}));
  await assert.rejects(f.ctl.execute(f.ctx,'browser_upload_file',upload(lease)),/BROWSER_TRANSFER_AUTH_CONTEXT_REQUIRED/);
  assert.equal(f.calls.filter(x=>x.action==='transfer_upload').length,0);
 }finally{f.ctl.close()}
});
test('identity scope and forged grant are rejected before native transfer',async()=>{
 const f=fixture({trustedTransferContext:async()=>({principal:'uid:1000',profile:'owner',verifyGrant:async()=>false})});let lease;
 try{
  ({lease}=await f.ctl.execute(f.ctx,'browser_session_begin',{mode:'isolated'}));
  await assert.rejects(f.ctl.execute(f.ctx,'browser_upload_file',upload(lease)),/BROWSER_TRANSFER_GRANT_REQUIRED/);
  assert.equal(f.calls.filter(x=>x.action==='transfer_upload').length,0);
 }finally{f.ctl.close()}
});
test('wrong profile is denied even if verifier reports approved',async()=>{
 const f=fixture({trustedTransferContext:async()=>({principal:'uid:1000',profile:'different',verifyGrant:async()=>true})});let lease;
 try{
  ({lease}=await f.ctl.execute(f.ctx,'browser_session_begin',{mode:'isolated'}));
  await assert.rejects(f.ctl.execute(f.ctx,'browser_download_file',download(lease)),/BROWSER_TRANSFER_AUTH_CONTEXT_REQUIRED/);
  assert.equal(f.calls.filter(x=>x.action==='transfer_download').length,0);
 }finally{f.ctl.close()}
});
test('trusted verifier is bound to operation origin filename principal and profile',async()=>{
 const grants=[];
 const f=fixture({trustedTransferContext:async()=>({principal:'uid:1000',profile:'owner',verifyGrant:async v=>{grants.push(v);return v.operation==='upload'&&v.origin===origin&&v.filename==='sample.txt'&&v.principal==='uid:1000'&&v.profile==='owner'&&v.grant==='attested'}})});let lease;
 try{
  ({lease}=await f.ctl.execute(f.ctx,'browser_session_begin',{mode:'isolated'}));
  const result=await f.ctl.execute(f.ctx,'browser_upload_file',upload(lease));
  assert.equal(result.ok,true);assert.equal(grants.length,1);
  const sent=f.calls.find(x=>x.action==='transfer_upload');
  assert.deepEqual(Object.keys(sent).sort(),['action','filename','origin','selector','sha256']);
  assert.equal(sent.origin,origin);
 }finally{f.ctl.close()}
});
test('failed native transfer is not blindly retried until snapshot',async()=>{
 const f=fixture({trustedTransferContext:async()=>({principal:'uid:1000',profile:'owner',verifyGrant:async()=>true}),transferError:'BROWSER_UPLOAD_NATIVE_FAILED'});let lease;
 try{
  ({lease}=await f.ctl.execute(f.ctx,'browser_session_begin',{mode:'isolated'}));
  await assert.rejects(f.ctl.execute(f.ctx,'browser_upload_file',upload(lease)),/BROWSER_UPLOAD_NATIVE_FAILED/);
  await assert.rejects(f.ctl.execute(f.ctx,'browser_upload_file',upload(lease)),/BROWSER_OUTCOME_UNCERTAIN_SNAPSHOT_REQUIRED/);
  const snap=await f.ctl.execute(f.ctx,'browser_snapshot',{lease});
  assert.equal(snap.cookiesReturned,false);assert.equal(snap.savedPasswordStoreAccess,false);
  await assert.rejects(f.ctl.execute(f.ctx,'browser_upload_file',upload(lease)),/BROWSER_UPLOAD_NATIVE_FAILED/);
  assert.equal(f.calls.filter(x=>x.action==='transfer_upload').length,2);
 }finally{f.ctl.close()}
});
test('STANDARD browser policy rejects transfer before native effect',async()=>{
 const f=fixture({config:{config:{instance:{profile:'owner'},powerMode:{enabled:false,browserControl:{enabled:false}}}}});
 await assert.rejects(f.ctl.execute(f.ctx,'browser_upload_file',upload('fakelease')),/BROWSER_DISABLED/);
 assert.equal(f.calls.length,0);f.ctl.close();
});

test('CDP upload takes CSS selectors as protocol data, never as JavaScript source',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-browser-cdp-selector-'));
  try {
    fs.mkdirSync(path.join(root,'uploads'));
    const bytes=Buffer.from('trusted staged document');
    fs.writeFileSync(path.join(root,'uploads','fixture.txt'),bytes);
    const digest=createHash('sha256').update(bytes).digest('hex');
    const selector='#upload"][onclick=alert(1)]'; // no interpolation into JS
    const evaluated=[], calls=[];
    let checks=0;
    const send=async(method,params)=>{
      calls.push({method,params});
      if(method==='DOM.getDocument')return {root:{nodeId:1}};
      if(method==='DOM.querySelector')return {nodeId:9};
      if(method==='DOM.resolveNode')return {object:{objectId:'bound-input'}};
      if(method==='Runtime.callFunctionOn')
        return ++checks===1?{result:{value:true}}:
          {result:{value:{name:'fixture.txt',size:bytes.length,length:1}}};
      if(method==='DOM.setFileInputFiles'||method==='Runtime.releaseObject')return {};
      throw Error('unexpected command');
    };
    const result=await uploadStagedFileCdp({
      req:{selector,filename:'fixture.txt',sha256:digest,origin:'https://example.test'},
      profileDir:root,evaluate:async expression=>{
        evaluated.push(expression);
        if(expression==='location.origin')return 'https://example.test';
        throw Error('untrusted JavaScript generated');
      },send
    });
    assert.equal(result.attached,true);
    assert.deepEqual(evaluated,['location.origin','location.origin']);
    assert.equal(calls.find(x=>x.method==='DOM.querySelector').params.selector,selector);
    assert.equal(calls.filter(x=>x.method==='Runtime.callFunctionOn').length,2);
    assert.equal(calls.filter(x=>x.method==='DOM.setFileInputFiles').length,1);
    assert.equal(calls.filter(x=>x.method==='Runtime.releaseObject').length,1);
    for(const {method,params} of calls){
      if(method==='Runtime.callFunctionOn'){
        assert.equal(params.objectId,'bound-input');
        assert.ok(!params.functionDeclaration.includes(selector));
      }
    }
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('CDP upload refuses a disabled or non-file input before any file attachment',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-browser-cdp-deny-'));
  try{
    fs.mkdirSync(path.join(root,'uploads'));
    const bytes=Buffer.from('fixture');
    fs.writeFileSync(path.join(root,'uploads','fixture.txt'),bytes);
    const digest=createHash('sha256').update(bytes).digest('hex');
    const calls=[];
    await assert.rejects(uploadStagedFileCdp({
      req:{selector:'#disabled',filename:'fixture.txt',sha256:digest,origin:'https://example.test'},
      profileDir:root,evaluate:async()=> 'https://example.test',
      send:async(method)=>{
        calls.push(method);
        if(method==='DOM.getDocument')return {root:{nodeId:1}};
        if(method==='DOM.querySelector')return {nodeId:9};
        if(method==='DOM.resolveNode')return {object:{objectId:'disabled-input'}};
        if(method==='Runtime.callFunctionOn')return {result:{value:false}};
        if(method==='Runtime.releaseObject')return {};
        throw Error('Unexpected transfer command');
      }
    }),{browserCode:'BROWSER_TRANSFER_FILE_INPUT_REQUIRED'});
    assert.equal(calls.includes('DOM.setFileInputFiles'),false);
    assert.equal(calls.includes('Runtime.releaseObject'),true);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
