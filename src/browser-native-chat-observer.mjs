// Built into the Commander-owned Chromium Browser Core. No Brave extension, Native Host or DOM bridge.
import { createHmac, randomBytes } from 'node:crypto';

const CHAT_PATH=/^\/(?:g\/[^/?#]{1,120}\/)?c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
const MAX_TARGETS=128, MAX_AGE_MS=120000;
const priority={OPEN:4,STALE:3,LEFT:2,CLOSED:1};
export function chatConversationFromUrl(url) {
  if(typeof url!=='string' || url.length>4096) return null;
  try {
    const parsed=new URL(url);
    if(parsed.protocol!=='https:' ||
       !['chatgpt.com','chat.openai.com'].includes(parsed.hostname) ||
       parsed.username || parsed.password || parsed.port) return null;
    const match=CHAT_PATH.exec(parsed.pathname);
    return match?match[1].toLowerCase():null;
  } catch {return null;}
}

export class BrowserChatTargetObserver {
  constructor({now=()=>Date.now(),secret=randomBytes(32)}={}) {
    if(!Buffer.isBuffer(secret)||secret.length<16)throw new TypeError('INVALID_EPHEMERAL_SECRET');
    this._secret=secret;
    this._now=now;
    this._tabs=new Map();
    this._ready=false;
    this._lastError=null;
  }
  setReady(ready,reason=null) {
    this._ready=ready===true;
    this._lastError=this._ready?null:(typeof reason==='string'?reason:'DISCOVERY_UNAVAILABLE');
  }
  _ref(id){return createHmac('sha256',this._secret).update(id).digest('hex');}
  _prune() {
    const now=this._now();
    for(const [target,t] of this._tabs) {
      if((t.state!=='OPEN'&&now-t.seen>MAX_AGE_MS)||now-t.seen>MAX_AGE_MS*3) this._tabs.delete(target);
    }
    while(this._tabs.size>MAX_TARGETS){
      const oldest=this._tabs.keys().next().value;
      this._tabs.delete(oldest);
    }
  }
  ingest(info) {
    if(!info||typeof info.targetId!=='string'||info.targetId.length<1||info.targetId.length>128)return;
    const id=info.targetId;
    const chat=(info.type==='page')?chatConversationFromUrl(info.url):null;
    const previous=this._tabs.get(id);
    if(!chat) {
      if(previous?.state==='OPEN')this._tabs.set(id,{...previous,state:'LEFT',seen:this._now()});
      this._prune();
      return;
    }
    const ref=this._ref(chat);
    // A navigation within the same browser target replaces the former chat without reading page contents.
    this._tabs.delete(id);
    this._tabs.set(id,{ref,state:'OPEN',seen:this._now()});
    this._prune();
  }
  reconcile(targetInfos) {
    if(!Array.isArray(targetInfos))throw new TypeError('INVALID_TARGET_LIST');
    const current=new Set();
    for(const info of targetInfos) {
      if(info?.type==='page'&&typeof info.targetId==='string')current.add(info.targetId);
      this.ingest(info);
    }
    for(const [id, tab] of this._tabs) {
      if(tab.state==='OPEN'&&!current.has(id))this.destroyed(id);
    }
  }
  destroyed(targetId) {
    if(typeof targetId!=='string')return;
    const old=this._tabs.get(targetId);
    if(old?.state==='OPEN')this._tabs.set(targetId,{...old,state:'CLOSED',seen:this._now()});
    this._prune();
  }
  snapshot() {
    this._prune();
    const now=this._now();
    const groups=new Map();
    let observedTabCount=0;
    for(const t of this._tabs.values()){
      const state=t.state==='OPEN'&&now-t.seen>MAX_AGE_MS?'STALE':t.state;
      if(!priority[state])continue;
      observedTabCount++;
      const old=groups.get(t.ref);
      if(!old||priority[state]>priority[old])groups.set(t.ref,state);
    }
    const counts={OPEN:0,STALE:0,LEFT:0,CLOSED:0};
    const conversations=[...groups.entries()].sort(([a],[b])=>a.localeCompare(b))
      .slice(0,MAX_TARGETS).map(([ref,state])=>{counts[state]++;return {localRef:ref,state};});
    return {ok:true,source:'COMMANDER_OWNED_BROWSER_CORE',scope:'OWNED_PROFILE_ONLY',
      schema:1,ready:this._ready,reason:this._lastError,
      chatAuthentication:'NOT_VERIFIED',actionAuthorization:false,
      urlContentsReturned:false,cookiesRead:false,domRead:false,
      observedTabs:observedTabCount,counts,conversations};
  }
}
