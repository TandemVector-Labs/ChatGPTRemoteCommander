import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import path from 'node:path';

const fail = code => Object.assign(new Error(code), { code });

export function classifyLinuxOwnerApprovalResult(exitCode, elapsedMs, requiredMs = 60_000) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 ||
      !Number.isFinite(requiredMs) || requiredMs < 1) throw fail('GUI_OWNER_APPROVAL_UI_FAILED');
  if (exitCode === 0) return { explicitOwnerApproval:true, approvalDenied:false };
  if (exitCode === 1) return { explicitOwnerApproval:false, approvalDenied:true };
  if (exitCode === 5 && elapsedMs >= requiredMs) return {
    explicitOwnerApproval:false,
    approvalDenied:false,
    approvalPromptVisible:true,
    approvalPromptElapsedMs:Math.floor(elapsedMs),
    physicalActivityAfterPrompt:false
  };
  throw fail(exitCode === 5 ? 'GUI_OWNER_APPROVAL_TIMEOUT_NOT_ELAPSED' : 'GUI_OWNER_APPROVAL_UI_FAILED');
}


export function createLinuxGuiInputCaptureAdapter({
  projectRoot, python = 'python3', zenity = 'zenity', spawnImpl = spawn,
  requestTimeoutMs = 8_000, approvalTimeoutMs = 70_000, acquireTimeoutMs = 95_000
} = {}) {
  if (process.platform !== 'linux') throw fail('GUI_LINUX_ONLY');
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot))
    throw fail('GUI_NATIVE_PROJECT_ROOT_REQUIRED');
  const helperPath = path.join(projectRoot, 'tools', 'gui-input-capture-linux.py');
  let child = null, lines = null, startupPromise = null, closed = false;
  let stderr = '', pollTimer = null, polling = false, displayEnv = null;
  const pending = new Map(), subscribers = new Set();

  function rejectAll(error) {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  }
  function notify(event) {
    const mapped = ({
      PORTAL_DEACTIVATED:'PORTAL_DEACTIVATED', PORTAL_CLOSED:'PORTAL_CLOSED',
      PORTAL_DISABLED:'PORTAL_DEACTIVATED', PORTAL_ZONES_CHANGED:'PORTAL_DEACTIVATED',
      LEASE_EXPIRED:'LEASE_EXPIRED', LOCAL_STOP:'LOCAL_STOP',
      SESSION_LOCKED:'SESSION_LOCKED', SESSION_SWITCHED:'SESSION_SWITCHED',
      AGENT_PROCESS_EXITED:'AGENT_PROCESS_EXITED', AGENT_DISCONNECTED:'AGENT_DISCONNECTED'
    })[event];
    if (!mapped) return;
    for (const callback of subscribers) { try { callback(mapped); } catch {} }
  }
  function failChild(error) {
    if (closed) return;
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    rejectAll(error);
    notify('AGENT_DISCONNECTED');
  }
  async function ensureStarted() {
    if (closed) throw fail('GUI_NATIVE_PROVIDER_CLOSED');
    if (startupPromise) return startupPromise;
    startupPromise = new Promise((resolve, reject) => {
      const proc = spawnImpl(python, ['-u', helperPath], {
        cwd:projectRoot, shell:false, windowsHide:true,
        stdio:['pipe','pipe','pipe'], env:{...process.env}
      });
      child = proc;
      let firstLine = true;
      const timer = setTimeout(() => {
        if (firstLine) reject(fail('GUI_NATIVE_PROVIDER_START_TIMEOUT'));
      }, 10_000);
      lines = createInterface({input:proc.stdout,crlfDelay:Infinity});
      lines.on('line', line => {
        if (!line || line.length > 32768) {
          failChild(fail('GUI_NATIVE_PROVIDER_PROTOCOL_INVALID')); return;
        }
        let msg;
        try { msg = JSON.parse(line); }
        catch { failChild(fail('GUI_NATIVE_PROVIDER_PROTOCOL_INVALID')); return; }
        if (firstLine) {
          firstLine = false; clearTimeout(timer);
          if (msg.ready !== true || msg.protocol !== 1) {
            reject(fail(msg.error || 'GUI_NATIVE_PROVIDER_NOT_READY')); return;
          }
          resolve(); return;
        }
        if (msg.event) { notify(msg.event); return; }
        const item = pending.get(msg.id);
        if (!item) return;
        pending.delete(msg.id); clearTimeout(item.timer);
        if (msg.ok === true) item.resolve(msg.result);
        else item.reject(fail(msg.error || 'GUI_NATIVE_PROVIDER_REQUEST_FAILED'));
      });
      proc.stderr.on('data', chunk => { stderr=(stderr+chunk.toString('utf8')).slice(-4096); });
      proc.once('error', error => { clearTimeout(timer); reject(error); failChild(error); });
      proc.once('close', (code, signal) => {
        clearTimeout(timer);
        const error=fail('GUI_NATIVE_PROVIDER_EXITED');
        error.exitCode=code; error.signal=signal; error.stderr=stderr;
        if (firstLine) reject(error);
        failChild(error);
      });
    }).catch(error => { startupPromise=null; throw error; });
    return startupPromise;
  }
  async function call(action, args={}, timeoutMs=requestTimeoutMs) {
    await ensureStarted();
    if (closed || !child?.stdin?.writable) throw fail('GUI_NATIVE_PROVIDER_DISCONNECTED');
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(fail('GUI_NATIVE_PROVIDER_REQUEST_TIMEOUT'));},timeoutMs);
      pending.set(id,{resolve,reject,timer});
      child.stdin.write(JSON.stringify({id,action,...args})+'\n',error=>{
        if (!error) return;
        const item=pending.get(id);
        if (item) {pending.delete(id);clearTimeout(item.timer);reject(error);}
      });
    });
  }
  function startPolling() {
    if (pollTimer || subscribers.size===0) return;
    pollTimer=setInterval(async()=>{
      if (polling || closed || subscribers.size===0) return;
      polling=true;
      try {
        const result=await call('events',{},requestTimeoutMs);
        for (const event of result.events??[]) notify(event.event);
      } catch(error) {
        if (error?.code==='GUI_LOCAL_STOP') notify('LOCAL_STOP');
        else if (error?.code==='GUI_INCIDENT_REVIEW_REQUIRED') notify('PORTAL_DEACTIVATED');
        else if (error?.code==='GUI_EIS_RECEIVER_EXITED') notify('AGENT_PROCESS_EXITED');
        else if (!closed) notify('AGENT_DISCONNECTED');
      } finally { polling=false; }
    },250);
    pollTimer.unref?.();
  }
  async function describe() {
    const result=await call('describeSession');
    displayEnv=result.displayEnv;
    return result.descriptor;
  }
  async function requestOwnerApproval({timeoutMs=60000,requestedInput={}}={}) {
    if (!displayEnv) await describe();
    const promptMs=Math.min(60000,Math.max(1000,timeoutMs));
    if (!displayEnv?.WAYLAND_DISPLAY && !displayEnv?.DISPLAY)
      throw fail('GUI_OWNER_APPROVAL_DISPLAY_UNAVAILABLE');
    const env={...process.env,...displayEnv};
    const lines=[
      'Commander requests temporary capture of your physical desktop input.',
      'Pointer capture: '+(requestedInput.pointer===true?'enabled':'disabled'),
      'Keyboard capture: '+(requestedInput.keyboard===true?'enabled':'disabled'),
      'Input is released at lease end, local stop, portal revocation, or agent exit.',
      'Choose Allow, Deny, or leave this visible prompt unanswered for 60 seconds.'
    ];
    return new Promise((resolve,reject)=>{
      let done=false;
      const promptStartedAt=performance.now();
      const proc=spawnImpl(zenity,[
        '--question','--title','Commander V1 — Desktop input control',
        '--text',lines.join('\n'),'--ok-label','Allow for this task',
        '--cancel-label','Deny','--timeout',String(Math.ceil(promptMs/1000))
      ],{cwd:projectRoot,env,shell:false,windowsHide:false,stdio:'ignore'});
      const timer=setTimeout(()=>{
        if(done)return;done=true;try{proc.kill('SIGTERM');}catch{}
        reject(fail('GUI_OWNER_APPROVAL_PROMPT_TIMEOUT'));
      },Math.max(approvalTimeoutMs,promptMs+5000));
      proc.once('error',error=>{
        if(done)return;done=true;clearTimeout(timer);
        reject(fail(error?.code==='ENOENT'?'GUI_OWNER_APPROVAL_UI_MISSING':'GUI_OWNER_APPROVAL_UI_FAILED'));
      });
      proc.once('close',code=>{
        if(done)return;done=true;clearTimeout(timer);
        const elapsedMs=Math.max(0,performance.now()-promptStartedAt);
        try { resolve(classifyLinuxOwnerApprovalResult(code,elapsedMs,promptMs)); }
        catch (error) { reject(error); }
      });
    });
  }

  const adapter={
    async describeSession(){return describe();},
    async getPhysicalActivityEvidence(){return null;},
    async requestOwnerApproval(args){return requestOwnerApproval(args);},
    async acquireProtection(args={}) {
      const result=await call('acquireProtection',{
        requestedInput:args.requestedInput,ttlSeconds:args.ttlSeconds??60,
        approvalMode:args.approvalMode
      },acquireTimeoutMs);
      startPolling();
      return result;
    },
    async releaseProtection({leaseId,reason}={}) {
      if(!leaseId)return {ok:true,released:true,alreadyReleased:true};
      const result=await call('releaseProtection',{leaseId,reason},8000);
      if(pollTimer){clearInterval(pollTimer);pollTimer=null;}
      return result;
    },
    subscribeEmergency(callback) {
      if(typeof callback!=='function')throw fail('GUI_EMERGENCY_CALLBACK_REQUIRED');
      subscribers.add(callback);
      return ()=>{
        subscribers.delete(callback);
        if(subscribers.size===0&&pollTimer){clearInterval(pollTimer);pollTimer=null;}
      };
    },
    async status(){return call('status');},
    async close(){
      if(closed)return;
      try{await call('stop',{},requestTimeoutMs);}catch{}
      closed=true;if(pollTimer)clearInterval(pollTimer);pollTimer=null;
      try{lines?.close();}catch{}
      try{child?.stdin?.end();}catch{}
      try{child?.kill();}catch{}
      rejectAll(fail('GUI_NATIVE_PROVIDER_CLOSED'));
    }
  };
  return adapter;
}
