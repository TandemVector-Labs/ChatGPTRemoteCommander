'use strict';
const {app,BrowserWindow,ipcMain}=require('electron');
const {spawn}=require('node:child_process');
const {createServer}=require('node:net');
const http=require('node:http');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const fs=require('node:fs');
const {validateCore,preparePreviewCore,previewConfig}=require('./pilot-runtime.cjs');

let window=null, child=null, previewPort=null, starting=false, lastError=null;
const packagedCore=()=>path.join(app.isPackaged?process.resourcesPath:__dirname,
  app.isPackaged?'core':'.stage/core');

async function migrationPreflight(){
  // Fixed local module only, no user-supplied command, path, or privilege.
  const target=pathToFileURL(path.join(__dirname,'migration-preflight.mjs')).href;
  const {localReport}=await import(target);
  return localReport(process.platform);
}

function status(){
  let source='unavailable', error=null;
  try{source=validateCore(packagedCore()).head;}
  catch(e){error=String(e.message||e);}
  return {version:app.getVersion(),source,platform:process.platform,
    packaged:app.isPackaged,preview:child?'running':starting?'starting':'stopped',
    error,lastError};
}
function freePort(){
  return new Promise((resolve,reject)=>{
    const s=createServer();
    s.once('error',reject);
    s.listen(0,'127.0.0.1',()=>{
      const port=s.address().port;
      s.close(e=>e?reject(e):resolve(port));
    });
  });
}
async function healthCheck(port,timeout=10000){
  const started=Date.now();
  while(Date.now()-started<timeout){
    if(!child)throw Error('UNIFIED_PREVIEW_PROCESS_EXITED');
    const healthy=await new Promise(resolve=>{
      const req=http.get({hostname:'127.0.0.1',port,path:'/health',timeout:800},res=>{
        res.resume();resolve(res.statusCode===200);
      });
      req.on('error',()=>resolve(false));
      req.on('timeout',()=>{req.destroy();resolve(false);});
    });
    if(healthy)return true;
    await new Promise(r=>setTimeout(r,200));
  }
  throw Error('UNIFIED_PREVIEW_HEALTH_TIMEOUT');
}
function stopPreview(){
  const old=child;
  child=null;previewPort=null;
  if(old&&!old.killed){
    old.kill();
    const killer=setTimeout(()=>{try{if(old.exitCode===null)old.kill('SIGKILL');}catch{}},2000);
    killer.unref();
  }
  return {state:'stopped',liveCommanderUntouched:true};
}
async function startPreview(){
  if(starting)throw Error('UNIFIED_PREVIEW_STARTING');
  if(child)return {state:'already-running',port:previewPort};
  starting=true;lastError=null;
  try{
    const home=app.getPath('userData');
    const {target,head}=preparePreviewCore(packagedCore(),home);
    const port=await freePort();
    const {file}=previewConfig(target,home,port);
    const entry=path.join(target,'src','server-v0.3.mjs');
    child=spawn(process.execPath,[entry],{
      cwd:target,windowsHide:true,stdio:['ignore','pipe','pipe'],
      env:{...process.env,ELECTRON_RUN_AS_NODE:'1',
        REMOTE_COMMANDER_CONFIG:file,COMMANDER_ONE_REQUIRE_TRUSTED_INGRESS:'0'}
    });
    let captured='';
    for(const stream of [child.stdout,child.stderr]){
      stream.on('data',buf=>{
        captured=(captured+buf.toString('utf8')).slice(-4096);
      });
    }
    child.once('error',e=>{lastError=String(e.message||e);child=null;});
    child.once('exit',code=>{
      if(child){lastError='Preview exited: '+String(code)+'; '+captured.slice(-300);child=null;previewPort=null;}
    });
    await healthCheck(port);
    previewPort=port;
    return {state:'running',port,source:head,scope:'isolated STANDARD loopback',
      privilegedAccess:false,existingRuntimeUntouched:true};
  }catch(e){
    lastError=String(e.message||e);
    stopPreview();throw e;
  }finally{starting=false;}
}
function createWindow(){
  window=new BrowserWindow({
    width:850,height:680,minWidth:610,minHeight:540,
    show:false,backgroundColor:'#141923',
    webPreferences:{
      nodeIntegration:false,contextIsolation:true,sandbox:true,
      webSecurity:true,webviewTag:false,
      preload:path.join(__dirname,'preload.cjs')
    }
  });
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',e=>e.preventDefault());
  window.once('ready-to-show',()=>window?.show());
  window.on('closed',()=>{window=null;});
  void window.loadFile(path.join(__dirname,'index.html'));
}
const gotLock=app.requestSingleInstanceLock();
if(!gotLock){app.quit();}
else{
  app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.focus();}});
  app.whenReady().then(()=>{
    ipcMain.handle('commander:status',()=>status());
    ipcMain.handle('commander:migration:preflight',()=>migrationPreflight());
    ipcMain.handle('commander:preview:start',()=>startPreview());
    ipcMain.handle('commander:preview:stop',()=>stopPreview());
    createWindow();
  }).catch(e=>{console.error(e);app.quit();});
  app.on('before-quit',()=>stopPreview());
  app.on('window-all-closed',()=>app.quit());
}
