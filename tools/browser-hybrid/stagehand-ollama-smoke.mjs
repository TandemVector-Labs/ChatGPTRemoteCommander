import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {localBrowser,Stagehand} from '@browserbasehq/stagehand';
import {createOllamaGenerate} from './ollama-provider.mjs';

// Only a synthetic loopback document is allowed. This is a bounded local-model
// integration proof, not a general autonomous browsing authorization.
const html='<!DOCTYPE html><title>Commander Stagehand AI Test</title><main><label for="v104-email">Test input</label><input id="v104-email" aria-label="Test input"><button id="v104-save" onclick="document.querySelector(\'#v104-result\').textContent=document.querySelector(\'#v104-email\').value">Save</button><p id="v104-result"></p></main>';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'v104-stagehand-ollama-'));
const server=http.createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end(html)});
server.listen(0,'127.0.0.1');await once(server,'listening');
let browser=null,agent=null;
try{
 browser=await localBrowser.launch({headless:true,userDataDir:path.join(tmp,'profile')});
 agent=await Stagehand.create({browser,model:{generate:createOllamaGenerate({
  model:process.env.RC_OLLAMA_MODEL||'qwen3:4b-instruct',timeoutMs:23000})}});
 const [page]=await browser.context.pages();
 const url='http://127.0.0.1:'+server.address().port+'/';
 await page.goto(url);
 const found=await agent.observe('Find the visible single-line text input labeled Test input. Return its exact CSS selector. Do not click or type.');
 const rows=found?.data;
 if(!Array.isArray(rows)||!rows.length||typeof rows[0].selector!=='string')throw Error('OBSERVE_EMPTY_SELECTOR');
 const selector=rows[0].selector;
 if(selector.length>300)throw Error('OBSERVE_SELECTOR_TOO_LONG');
 const matches=await page.locator(selector).count();
 if(matches!==1)throw Error('OBSERVE_NOT_UNIQUE');
 await page.locator(selector).fill('V104_AI_LOCAL_PASS');
 await page.locator('#v104-save').click();
 const check=await page.locator('#v104-result').innerText();
 if(check!=='V104_AI_LOCAL_PASS')throw Error('AI_OBSERVE_DOM_NOT_VERIFIED');
 console.log(JSON.stringify({status:'PASS',engine:'stagehand-ollama-observe',model:process.env.RC_OLLAMA_MODEL||'qwen3:4b-instruct',
  selectedSelectorVerified:true,domVerified:true,loopbackOnly:true,externalModelUsed:false,personalProfileAccess:false}));
}catch(e){console.error(JSON.stringify({status:'FAIL',code:String(e?.message||e).slice(0,260)}));process.exitCode=1}
finally{try{await agent?.close()}catch{}try{await browser?.close()}catch{}await new Promise(resolve=>server.close(resolve));try{fs.rmSync(tmp,{recursive:true,force:true})}catch{}}
