// Native Windows owner/session evidence for V1-01/J01.
// Only owner-token process + active WTS seat + fresh typed challenge can consent.
// This is not ChatGPT identity proof, administrator elevation or a shell grant.
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {execFile as execFileDefault} from 'node:child_process';
import {createHash,randomInt} from 'node:crypto';
import {isProxy} from 'node:util/types';
import {normalizeV2Route} from './v2-routing-contract.mjs';
import {WINDOWS_SYSTEM_ROOT,WINDOWS_SYSTEM_POWERSHELL_EXE} from './platform.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const SCRIPT=path.join(HERE,'native-owner-session-windows.ps1');
const SID=/^(?:S-1-5-21-(?:[0-9]+-){3}[0-9]+|S-1-12-1-(?:[0-9]+-){4})$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH=/^[a-f0-9]{64}$/;
const BINDING=/^[a-f0-9]{32,64}$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const clean=(v,max=5000)=>typeof v==='string'&&v.length>0&&v.length<=max
  &&!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v);
function exact(value,fields,code){
  if(!value||typeof value!=='object'||Array.isArray(value)||isProxy(value)
    ||![Object.prototype,null].includes(Object.getPrototypeOf(value))
    ||Reflect.ownKeys(value).length!==fields.length)fail(code);
  const out=Object.create(null);
  for(const k of fields){
    const d=Object.getOwnPropertyDescriptor(value,k);
    if(!d||!Object.hasOwn(d,'value')||!d.enumerable)fail(code);
    out[k]=d.value;
  }
  return out;
}
function trustedFile(file){
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink())fail('NATIVE_OWNER_WINDOWS_FILE_UNTRUSTED');
}

function execute(impl,file,args,timeoutMs){
  return new Promise(resolve=>{
    try{
      impl(file,args,{encoding:'utf8',timeout:timeoutMs,maxBuffer:8192,
        windowsHide:true,env:{SystemRoot:WINDOWS_SYSTEM_ROOT,
          WINDIR:WINDOWS_SYSTEM_ROOT,
          PATH:[path.win32.join(WINDOWS_SYSTEM_ROOT,'System32'),
            WINDOWS_SYSTEM_ROOT,
            path.win32.join(WINDOWS_SYSTEM_ROOT,'System32','WindowsPowerShell','v1.0')].join(';'),
          TEMP:process.env.TEMP??'',TMP:process.env.TMP??''}},
      (error,stdout,stderr)=>resolve({
        ok:!error,stdout:typeof stdout==='string'?stdout:'',
        stderr:typeof stderr==='string'?stderr:''
      }));
    }catch{resolve({ok:false,stdout:'',stderr:''});}
  });
}
function parseSnapshot(result){
  if(!result.ok||result.stderr.trim()!==''||result.stdout.length>4096)
    fail('NATIVE_OWNER_WINDOWS_SNAPSHOT_FAILED');
  let raw;
  try{raw=JSON.parse(result.stdout);}catch{fail('NATIVE_OWNER_WINDOWS_SNAPSHOT_INVALID');}
  const o=exact(raw,['schema','ownerSid','sessionId','active','interactive'],
    'NATIVE_OWNER_WINDOWS_SNAPSHOT_INVALID');
  if(o.schema!==1||!SID.test(o.ownerSid)||!Number.isSafeInteger(o.sessionId)
    ||o.sessionId<1||o.active!==true||o.interactive!==true)
    fail('NATIVE_OWNER_WINDOWS_SESSION_NOT_ACTIVE');
  const ownerSidHash=createHash('sha256').update(
    'commander.os-owner.sid.v1\0win32\0sid='+o.ownerSid).digest('hex');
  return Object.freeze({
    source:'native-windows-owner-session',ownerSidHash,
    osSessionId:'windows-wts-'+o.sessionId,
    seatId:'wts-'+o.sessionId,displayId:'WinSta0/Default',
    sessionType:'windows'
  });
}
function same(a,b){
  return a.ownerSidHash===b.ownerSidHash&&a.osSessionId===b.osSessionId
    &&a.seatId===b.seatId&&a.displayId===b.displayId;
}
export function createWindowsNativeOwnerSessionProvider({
  platform=process.platform,execFileImpl=execFileDefault,
  powershell=WINDOWS_SYSTEM_POWERSHELL_EXE,script=SCRIPT,verifyFile=trustedFile,
  snapshotTimeoutMs=5000,dialogTimeoutMs=65000
}={}){
  if(platform!=='win32'||typeof execFileImpl!=='function'
    ||typeof powershell!=='string'||!path.win32.isAbsolute(powershell)
    ||typeof script!=='string'||!path.win32.isAbsolute(script)
    ||typeof verifyFile!=='function'
    ||!Number.isSafeInteger(snapshotTimeoutMs)||snapshotTimeoutMs<250
    ||snapshotTimeoutMs>10000
    ||!Number.isSafeInteger(dialogTimeoutMs)||dialogTimeoutMs<5000
    ||dialogTimeoutMs>120000)
    fail('NATIVE_OWNER_WINDOWS_BOOTSTRAP_REQUIRED');
  function inspectFiles(){
    verifyFile(powershell);verifyFile(script);
  }
  async function getOwnerSessionSnapshot(){
    inspectFiles();
    return parseSnapshot(await execute(execFileImpl,powershell,[
      '-NoLogo','-NoProfile','-NonInteractive','-File',script,
      '-Mode','Snapshot'
    ],snapshotTimeoutMs));
  }
  async function requestConsent(value){
    try{
      const r=exact(value,['title','message','expectedOwnerSidHash','expectedOsSessionId'],
        'NATIVE_OWNER_WINDOWS_CONSENT_REQUEST_INVALID');
      if(!clean(r.title,120)||!clean(r.message)
        ||!/^[a-f0-9]{64}$/.test(r.expectedOwnerSidHash)
        ||typeof r.expectedOsSessionId!=='string'
        ||!/^windows-wts-[1-9][0-9]*$/.test(r.expectedOsSessionId))return false;
      const before=await getOwnerSessionSnapshot();
      if(before.ownerSidHash!==r.expectedOwnerSidHash
        ||before.osSessionId!==r.expectedOsSessionId)return false;
      const challenge=String(randomInt(10_000_000,100_000_000));
      // Native helper compares the typed code and checks WTS+SID after consent.
      const args=['-NoLogo','-NoProfile','-NonInteractive','-File',script,
        '-Mode','Consent',
        '-ExpectedSession',before.osSessionId.slice('windows-wts-'.length),
        '-TitleBase64',Buffer.from(r.title).toString('base64'),
        '-MessageBase64',Buffer.from(r.message).toString('base64'),
        '-Challenge',challenge];
      // Do not pass the raw SID from a caller. The snapshot supplies only a
      // digest, so the native helper must confirm its own before/after token.

      const result=await execute(execFileImpl,powershell,args,dialogTimeoutMs);
      if(!result.ok||result.stderr.trim()!==''||result.stdout.length>1024)return false;
      let parsed;try{parsed=JSON.parse(result.stdout);}catch{return false;}
      if(!parsed||Object.keys(parsed).length!==1||parsed.approved!==true)return false;
      const after=await getOwnerSessionSnapshot();
      return same(before,after);
    }catch{return false;}
  }
  async function observedNativeSession(route){
    normalizeV2Route(route);
    return (await getOwnerSessionSnapshot()).osSessionId;
  }
  async function authorizeBinding(value){
    try{
      const r=exact(value,['sessionHandle','tokenSha256','route','osSessionId',
        'ownerSidHash','bindingId'],'NATIVE_OWNER_WINDOWS_BINDING_REQUEST_INVALID');
      if(typeof r.sessionHandle!=='string'||!ID.test(r.sessionHandle)
        ||!HASH.test(r.tokenSha256)||!HASH.test(r.ownerSidHash)
        ||!BINDING.test(r.bindingId))return false;
      const route=normalizeV2Route(r.route);
      if(route.conversationId!==r.sessionHandle)return false;
      const snapshot=await getOwnerSessionSnapshot();
      if(snapshot.osSessionId!==r.osSessionId
        ||snapshot.ownerSidHash!==r.ownerSidHash)return false;
      const pairScope=/^pair-[a-f0-9]{32}$/.test(route.conversationId);
      const message=[
        pairScope
          ? 'Bind this exclusive Commander account+host pair to the current Windows owner? This does NOT identify individual ChatGPT chats.'
          : 'Bind this exact ChatGPT conversation to the current Windows owner?',
        'Host: '+route.hostId,'Profile: '+route.profileId,
        'Principal: '+route.principalId,
        (pairScope?'Pair session: ':'Conversation: ')+route.conversationId,
        'Operation: '+route.operationId,
        'Target: '+route.target.kind+'/'+route.target.id,
        'OS session: '+snapshot.osSessionId+' / '+snapshot.seatId,
        'Owner identity: '+snapshot.ownerSidHash.slice(0,12),
        'Binding epoch: '+r.bindingId.slice(0,12),'',
        'This revocable owner binding does not authorize tool calls or elevate OS privileges.'
      ].join('\n');
      return requestConsent({title:'Commander - Bind Windows owner session',
        message,expectedOwnerSidHash:r.ownerSidHash,
        expectedOsSessionId:r.osSessionId});
    }catch{return false;}
  }
  async function authorizeRevocation(value){
    try{
      const r=exact(value,['sessionHandle','route','osSessionId','ownerSidHash',
        'bindingId','adminProof'],'NATIVE_OWNER_WINDOWS_REVOCATION_REQUEST_INVALID');
      if(typeof r.sessionHandle!=='string'||!ID.test(r.sessionHandle)
        ||!HASH.test(r.ownerSidHash)||!BINDING.test(r.bindingId))return false;
      const route=normalizeV2Route(r.route);
      if(route.conversationId!==r.sessionHandle)return false;
      const snapshot=await getOwnerSessionSnapshot();
      if(snapshot.osSessionId!==r.osSessionId
        ||snapshot.ownerSidHash!==r.ownerSidHash)return false;
      const message=[
        'Revoke this exact Windows owner/ChatGPT binding?',
        'Host: '+route.hostId,'Profile: '+route.profileId,
        'Conversation: '+route.conversationId,
        'OS session: '+snapshot.osSessionId,
        'Binding epoch: '+r.bindingId.slice(0,12),'',
        'Revocation takes effect in the owner-grant registry.'
      ].join('\n');
      return requestConsent({title:'Commander - Revoke Windows owner binding',
        message,expectedOwnerSidHash:r.ownerSidHash,
        expectedOsSessionId:r.osSessionId});
    }catch{return false;}
  }
  return Object.freeze({
    getOwnerSessionSnapshot,resolveOwnerSidHash:async()=>
      (await getOwnerSessionSnapshot()).ownerSidHash,
    observedNativeSession,requestConsent,authorizeBinding,authorizeRevocation
  });
}
