// Real integrated CLI test: local Ollama selects an element; Commander
// performs only the explicitly listed deterministic actions on one loopback origin.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'v104-ai-cli-smoke-'));
const html='<!doctype html><html><title>AI Scoped Fixture</title><label for="v104-input">Test input</label><input id="v104-input" type="text" aria-label="Test input"><button id="save" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#v104-input\').value">Save</button><p id="result"></p></html>';
const server=http.createServer((_request,response)=>{
 response.writeHead(200,{'content-type':'text/html;charset=utf-8'});response.end(html);
});
server.listen(0,'127.0.0.1');await once(server,'listening');
let child,timeout;
try{
 const origin='http://127.0.0.1:'+server.address().port;
 const steps=[
  {action:'observe',instruction:'Find the unique visible single-line text input labeled Test input. Return its CSS selector only; do not click or type.'},
  {action:'fill',selector:'@observed',text:'V104_SCOPED_AI_PASS'},
  {action:'click',selector:'#save'},
  {action:'expectText',text:'V104_SCOPED_AI_PASS'}
 ];
 const workflow=path.join(temp,'workflow.json'),screenshot=path.join(temp,'proof.png');
 fs.writeFileSync(workflow,JSON.stringify(steps),{flag:'wx'});
 const args=['cli.mjs','run','--engine=stagehand','--ai-model='+(process.env.RC_OLLAMA_MODEL||'qwen3:4b-instruct'),
  '--allow-origin='+origin,'--url='+origin+'/','--steps='+workflow,'--screenshot='+screenshot];
 child=spawn(process.execPath,args,{cwd:dir,windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';
 child.stdout.on('data',b=>{stdout+=b.toString();if(stdout.length>12000)child.kill()});
 child.stderr.on('data',b=>{stderr+=b.toString();if(stderr.length>12000)child.kill()});
 const killedByTimer={value:false};
 timeout=setTimeout(()=>{killedByTimer.value=true;child.kill()},45000);
 const [exit]=await once(child,'close');
 if(exit!==0||killedByTimer.value){
  let reason='CLI_FAILED';
  try{reason=JSON.parse(stderr.trim().split(/\r?\n/).at(-1))?.reason||reason}catch{}
  throw Error(killedByTimer.value?'CLI_DEADLINE':reason);
 }
 const obj=JSON.parse(stdout.trim());
 if(obj.status!=='PASS'||obj.engine!=='stagehand-chromium'||obj.aiOrigin!==origin||
    obj.observations?.length!==1||obj.observations[0].method!=='model'||obj.operationsPassed!==5||
    obj.personalProfileAccess!==false||obj.userDesktopTouched!==false||
    fs.statSync(screenshot).size<100)throw Error('SCOPED_AI_RUNTIME_VERIFICATION_FAILED');
 console.log(JSON.stringify({status:'PASS',mode:'CLI_STAGEHAND_OLLAMA',model:obj.aiModel,
   observationsVerified:obj.observations.length,operationsPassed:obj.operationsPassed,
   isolatedProfile:true,restrictedOrigin:true,localhostModel:true,screenshotBytes:obj.screenshotBytes}));
}catch(e){console.error(JSON.stringify({status:'FAIL',code:String(e?.message||e).slice(0,200)}));process.exitCode=1}
finally{
 clearTimeout(timeout);
 try{if(child&&!child.killed&&child.exitCode===null)child.kill()}catch{}
 await new Promise(resolve=>server.close(resolve));
 try{fs.rmSync(temp,{recursive:true,force:true})}catch{}
}
