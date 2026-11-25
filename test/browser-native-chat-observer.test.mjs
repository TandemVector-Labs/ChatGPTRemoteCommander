import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserChatTargetObserver, chatConversationFromUrl } from '../src/browser-native-chat-observer.mjs';

const A='11111111-1111-4111-8111-111111111111';
const B='22222222-2222-4222-8222-222222222222';
const url=(id)=>'https://chatgpt.com/c/'+id;
const target=(id,uri,type='page')=>({targetId:id,type,url:uri});
test('Only exact ChatGPT origins and canonical conversation paths are accepted',()=>{
 assert.equal(chatConversationFromUrl(url(A)),A);
 assert.equal(chatConversationFromUrl('https://chatgpt.com/g/proj/c/'+B),B);
 assert.equal(chatConversationFromUrl('https://chat.openai.com/c/'+B),B);
 for(const bad of [
  'https://chatgpt.com.evil.test/c/'+A,'http://chatgpt.com/c/'+A,
  'https://chatgpt.com:9999/c/'+A,'https://user@chatgpt.com/c/'+A,
  'https://chatgpt.com/c/not-a-uuid','data:text/plain,hello',
  'https://chatgpt.com/c/'+A+'/injected',
  'https://chatgpt.com\u005c.evil.test/c/'+A
 ]) assert.equal(chatConversationFromUrl(bad),null);
});
test('Browser-owned Target navigation and close are observed without leaking chat ID',()=>{
 let time=1000;
 const observer=new BrowserChatTargetObserver({now:()=>time,secret:Buffer.alloc(32,1)});
 observer.setReady(true);
 observer.ingest(target('tab-1',url(A)));
 observer.ingest(target('tab-2',url(B)));
 let s=observer.snapshot();
 assert.equal(s.counts.OPEN,2);
 assert.equal(s.conversations.length,2);
 assert.equal(s.chatAuthentication,'NOT_VERIFIED');
 assert.equal(s.scope,'OWNED_PROFILE_ONLY');
 assert.equal(JSON.stringify(s).includes(A),false);
 observer.ingest(target('tab-2','https://chatgpt.com/'));
 s=observer.snapshot();assert.equal(s.counts.LEFT,1);assert.equal(s.counts.OPEN,1);
 observer.destroyed('tab-1');
 s=observer.snapshot();assert.equal(s.counts.CLOSED,1);assert.equal(s.counts.LEFT,1);
 time+=121000;
 s=observer.snapshot();assert.equal(s.conversations.length,0);
});
test('One conversation in two tabs stays OPEN when one tab closes',()=>{
 const tr=new BrowserChatTargetObserver({secret:Buffer.alloc(32,2)});
 tr.setReady(true);
 tr.ingest(target('1',url(A)));tr.ingest(target('2',url(A)));
 tr.destroyed('1');
 let s=tr.snapshot();assert.equal(s.counts.OPEN,1);assert.equal(s.counts.CLOSED,0);
 tr.destroyed('2');s=tr.snapshot();assert.equal(s.counts.CLOSED,1);
});
test('Reject worker/iframe/nonpage targets and recover gracefully from discovery failure',()=>{
 const tr=new BrowserChatTargetObserver();
 tr.setReady(false,'TARGET_DISCOVERY_UNAVAILABLE');
 tr.ingest(target('worker',url(A),'service_worker'));
 tr.ingest(target('frame',url(B),'iframe'));
 const s=tr.snapshot();
 assert.equal(s.ready,false);
 assert.equal(s.reason,'TARGET_DISCOVERY_UNAVAILABLE');
 assert.equal(s.observedTabs,0);
 assert.deepEqual(s.conversations,[]);
});
test('Bounded and ephemeral tracker never stores raw identifiers in snapshots',()=>{
 const tr=new BrowserChatTargetObserver({secret:Buffer.alloc(32,3)});
 for(let k=0;k<160;k++){
  const id=String(k).padStart(12,'0');
  tr.ingest(target('target-'+k,'https://chatgpt.com/c/00000000-0000-4000-8000-'+id));
 }
 const snap=tr.snapshot();
 assert.ok(snap.observedTabs<=128);
 assert.equal(snap.actionAuthorization,false);
 assert.equal(snap.cookiesRead,false);
 assert.equal(snap.domRead,false);
 assert.equal(JSON.stringify(snap).includes('00000000-0000-4000-8000-'),false);
});

test('core target reconciliation refreshes active pages and closes a tab whose destroy event was lost',()=>{
 let now=5000;
 const q=new BrowserChatTargetObserver({now:()=>now,secret:Buffer.alloc(32,5)});
 q.reconcile([target('1',url(A)),target('2',url(B))]);
 assert.equal(q.snapshot().counts.OPEN,2);
 now+=130000; // A still exists; periodic CDP getTargets prevents false STALE
 q.reconcile([target('1',url(A))]);
 const s=q.snapshot();
 assert.equal(s.counts.OPEN,1);
 assert.equal(s.counts.CLOSED,1);
 assert.equal(s.counts.STALE,0);
});
test('invalid Target.getTargets reconciliation data rejects without clearing existing state',()=>{
 const q=new BrowserChatTargetObserver({secret:Buffer.alloc(32,8)});
 q.ingest(target('1',url(A)));
 assert.throws(()=>q.reconcile({targetInfos:[]}),/INVALID_TARGET_LIST/);
 assert.equal(q.snapshot().counts.OPEN,1);
});
