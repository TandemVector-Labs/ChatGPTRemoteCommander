#!/usr/bin/env node
// Dedicated local owner-session adapter; NOT a second Commander execution core.
// Exposes only workspace_* tools backed by exact-window Cua Driver actions.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {timingSafeEqual} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {workspaceToolDefinitions,executeWorkspaceTool} from '../src/workspace-tools.mjs';
import {validateJsonSchema} from '../src/schema-validator.mjs';
const fail=(msg)=>{throw Error('WORKSPACE_OWNER_BROKER_'+msg);};
const CONF=process.env.RC_WORKSPACE_OWNER_CONFIG;
if(process.platform!=='win32'||!CONF||!path.isAbsolute(CONF))fail('WINDOWS_INTERACTIVE_CONFIG_REQUIRED');
const json=JSON.parse(await fs.readFile(CONF,'utf8'));
if(json.schema!==1||!/^[-a-z0-9]{3,64}$/.test(json.profile??'')||
 json.host!=='127.0.0.1'||!Number.isSafeInteger(json.port)||
 json.port<1024||json.port>65535||
 typeof json.ownerName!=='string'||json.ownerName.length>128||
 typeof json.ownerSid!=='string'||!/^S-1-[0-9]+(?:-[0-9]+)+$/.test(json.ownerSid)||
 !/^[^\\/]+\\[^\\/]+$/.test(json.ownerName)||
 typeof json.authFile!=='string'||!path.isAbsolute(json.authFile)||
 path.resolve(path.dirname(json.authFile))!==path.resolve(path.dirname(CONF)))fail('CONFIG_INVALID');
const who=String(execFileSync('whoami.exe',[],{encoding:'utf8',timeout:3000})).trim().toLowerCase();
if(who!==json.ownerName.toLowerCase())fail('INTERACTIVE_OWNER_REQUIRED');
const whoUser=String(execFileSync('whoami.exe',['/user','/fo','csv','/nh'],{encoding:'utf8',timeout:3000}));
const actualSid=whoUser.match(/S-1-[0-9]+(?:-[0-9]+)+/i)?.[0];
if(!actualSid||actualSid.toLowerCase()!==json.ownerSid.toLowerCase())fail('OWNER_SID_MISMATCH');
if((process.env.SESSIONNAME||'').toLowerCase()==='services')fail('SESSION0_FORBIDDEN');
if(process.env.RC_WORKSPACE_CUA_OWNER_PIPE!=='1')fail('DEDICATED_CUA_PIPE_REQUIRED');
const cuaPipe=process.env.RC_WORKSPACE_CUA_PIPE;
const cuaPrefix='\\\\.\\pipe\\rc-workspace-cua-v038-';
if(typeof cuaPipe!=='string'||!cuaPipe.startsWith(cuaPrefix)||
 !['active','candidate'].includes(cuaPipe.slice(cuaPrefix.length)))fail('CUA_CHANNEL_PIPE_INVALID');
const keyText=(await fs.readFile(json.authFile,'utf8')).trim();
if(!/^[a-f0-9]{64}$/.test(keyText))fail('AUTH_INVALID');
const secret=Buffer.from(keyText,'utf8');
const allowed=new Map(workspaceToolDefinitions.map(d=>[d.name,d]));
const ctx={config:{powerMode:{enabled:true,
 guiControl:{enabled:true,allowMouse:false,allowKeyboard:false,allowWindowFocus:false},
 browserControl:{enabled:false,allowInput:false,allowForegroundFallback:false}}}};
const identical=(req)=>{const tok=req.headers['x-rc-owner-workspace-auth'];return typeof tok==='string'
 &&Buffer.byteLength(tok,'utf8')===secret.length
 &&timingSafeEqual(Buffer.from(tok,'utf8'),secret)};
const error=(id,code,message)=>({jsonrpc:'2.0',id,error:{code,message}});
function respond(res,status,payload){res.writeHead(status,{'content-type':'application/json; charset=utf-8',
 'cache-control':'no-store','x-content-type-options':'nosniff'});
 res.end(JSON.stringify(payload));}
let active=0,started=0;
const server=http.createServer(async(req,res)=>{
 if(req.socket.remoteAddress!=='127.0.0.1'&&req.socket.remoteAddress!=='::ffff:127.0.0.1'){
  req.socket.destroy();return;
 }
 if(req.method==='GET'&&req.url==='/health'){
  return respond(res,200,{ok:true,role:'OWNER_WORKSPACE_ADAPTER',ownerSession:true,profile:json.profile,
   active,started,sharedDesktopInput:false});
 }
 if(req.method!=='POST'||req.url!=='/mcp'||!identical(req)||
  req.headers.origin!==undefined||!String(req.headers['content-type']||'').startsWith('application/json')){
  return respond(res,403,error(null,-32003,'WORKSPACE_AUTH_DENIED'));
 }
 if(active>=3)return respond(res,429,error(null,-32029,'WORKSPACE_BUSY_TRY_OTHER_TARGET'));
 let raw='',bytes=0;
 try{
  for await(const chunk of req){
   bytes+=chunk.length;if(bytes>32768)throw Error('REQUEST_TOO_LARGE');raw+=chunk.toString('utf8');
  }
  const body=JSON.parse(raw);
  if(body?.jsonrpc!=='2.0'||body?.method!=='tools/call'||!Number.isSafeInteger(body?.id))
   return respond(res,400,error(body?.id??null,-32600,'INVALID_RPC'));
  const name=body?.params?.name,definition=allowed.get(name),args=body?.params?.arguments??{};
  if(!definition)return respond(res,200,error(body.id,-32601,'OWNER_TOOL_NOT_ALLOWED'));
  const violations=validateJsonSchema(args,definition.inputSchema);
  if(violations.length)return respond(res,200,error(body.id,-32602,'WORKSPACE_ARGUMENTS_INVALID'));
  active++;
  let result;
  try{result=await executeWorkspaceTool(ctx,name,args);started++;}
  finally{active--;}
  if(result?.__mcpContent)return respond(res,200,{jsonrpc:'2.0',id:body.id,
   result:{content:result.__mcpContent,structuredContent:result.__structuredContent}});
  return respond(res,200,{jsonrpc:'2.0',id:body.id,result:{structuredContent:result}});
 }catch(e){
  return respond(res,200,error(null,-32012,
   /^WORKSPACE_[A-Z_]+$/.test(e?.code??e?.message)?String(e?.code??e?.message):'OWNER_ACTION_FAILED'));
 }
});
server.on('clientError',(_err,socket)=>socket.destroy());
server.listen(json.port,json.host);
process.on('SIGTERM',()=>server.close());
