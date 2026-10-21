import test from 'node:test';
import assert from 'node:assert/strict';
import { createIsolatedSeatCoordinator } from '../src/isolated-seat-coordinator.mjs';

function fixture(opts={}) {
  let clock=1000, seq=0, started=0,stopped=0,executed=0;
  const records=[];
  const backend={
    start:async req=>{started++;const handle={n:started,req};records.push(handle);return handle;},
    inspect:async h=>({
      kernelIdentityVerified:true,uid:41000+h.n,pid:71000+h.n,
      display:':'+(700+h.n),tcpDisabled:true,
      privateProfileVerified:true,ownerDesktopUntouched:true,
    }),
    execute:async(h,req)=>{executed++;return {ok:true,result:{seat:h.n,operation:req.action}};},
    stop:async()=>{stopped++},
    ...opts,
  };
  const c=createIsolatedSeatCoordinator({
    backend,now:()=>clock,hostUid:1000,platform:'linux',
    token:()=>String(++seq).padStart(64,'0'),
    capacity:2,
  });
  return {c,backend,records,setTime:t=>{clock=t},counters:()=>({started,stopped,executed})};
}
const begin=(c,ownerId='alice',profileId='profileA')=>c.begin({ownerId,profileId});

test('default lacks an operational backend; no physical GUI fallback',()=>{
  assert.throws(()=>createIsolatedSeatCoordinator({platform:'linux',hostUid:1000}),
    /SEAT_BACKEND_NOT_CONFIGURED/);
  assert.throws(()=>createIsolatedSeatCoordinator({backend:{},platform:'linux',hostUid:1000}),
    /SEAT_BACKEND_NOT_CONFIGURED/);
  assert.throws(()=>createIsolatedSeatCoordinator({backend:{},platform:'win32',hostUid:1000}),
    /SEAT_OS_UNSUPPORTED/);
});

test('two independently owned seats can run overlapping input; crossed tokens always rejected',async()=>{
  const f=fixture();
  const a=await begin(f.c,'alice','p1');
  const b=await begin(f.c,'bob','p2');
  assert.equal(a.mode,'isolated-only');
  assert.notEqual(a.seatId,b.seatId);
  assert.equal(f.c.status().leases,2);
  await assert.rejects(f.c.run({ownerId:'bob',seatId:a.seatId,lease:a.lease,action:'move',data:{x:4,y:5}}),
    /SEAT_ACCESS_DENIED/);
  await assert.rejects(f.c.end({ownerId:'alice',seatId:b.seatId,lease:b.lease}),/SEAT_ACCESS_DENIED/);
  const [ra,rb]=await Promise.all([
    f.c.run({...a,ownerId:'alice',action:'move',data:{x:110,y:151}}),
    f.c.run({...b,ownerId:'bob',action:'key',data:{keys:['Z']}}),
  ]);
  assert.deepEqual([ra.result.seat,rb.result.seat],[1,2]);
  assert.equal(f.c.status().leases,2);
  await assert.rejects(begin(f.c,'charlie','p3'),/SEAT_CAPACITY_BUSY/);
  await f.c.end({...a,ownerId:'alice'});
  await f.c.end({...b,ownerId:'bob'});
  assert.equal(f.c.status().leases,0);
  assert.deepEqual(f.counters(),{started:2,stopped:2,executed:2});
});

test('screenshot and keyboard/clipboard input reject arbitrary injection and extra fields',async()=>{
  const f=fixture(),a=await begin(f.c);
  for(const [action,data] of [
    ['spawn',{program:'/bin/sh'}],['move',{x:2,y:3,hostDisplay:':0'}],
    ['click',{x:2,y:3,button:'shell'}],['move',{x:2.3,y:4}],
    ['text',{text:'x',exec:true}],['text',{text:'\ud800'}],['text',{text:'\u0000'}],
    ['key',{keys:['ESC']}],['key',{keys:['WIN','R']}],['screenshot',{screenIndex:100}],
    ['drag',{from:{x:1,y:2},to:{x:3,y:4},durationMs:50000}],
    ['drag',{from:{x:1,y:2,exec:true},to:{x:3,y:4},durationMs:200}],
  ]) await assert.rejects(f.c.run({...a,ownerId:'alice',action,data}),/SEAT_/);
  assert.equal(f.counters().executed,0);
  const shot=await f.c.run({...a,ownerId:'alice',action:'screenshot'});
  assert.deepEqual(shot.result,{seat:1,operation:'screenshot'});
  const drag=await f.c.run({...a,ownerId:'alice',action:'drag',data:{from:{x:1,y:2},to:{x:3,y:4},durationMs:200}});
  assert.deepEqual(drag.result,{seat:1,operation:'drag'});
  await f.c.close();
});

test('lease expiration revokes input, destroys process reservation and allows later leases',async()=>{
  const f=fixture(),a=await f.c.begin({ownerId:'alice',profileId:'p1',ttlMs:10000});
  f.setTime(11001);
  await assert.rejects(f.c.run({...a,ownerId:'alice',action:'click',data:{x:3,y:3,button:'left'}}),/SEAT_EXPIRED/);
  assert.equal(f.c.status().leases,0);
  assert.equal(f.counters().stopped,1);
  await assert.rejects(f.c.run({...a,ownerId:'alice',action:'cursor'}),/SEAT_ACCESS_DENIED/);
  await f.c.close();
});

test('failed cleanup quarantines seat, denying reuse until cleanup succeeds',async()=>{
  let stopAttempt=0;
  const f=fixture({stop:async()=>{stopAttempt++;if(stopAttempt===1)throw Error('process still alive');}});
  const a=await begin(f.c);
  await assert.rejects(f.c.end({...a,ownerId:'alice'}),/SEAT_CLEANUP_UNCERTAIN/);
  assert.equal(f.c.status().quarantined,1);
  await assert.rejects(f.c.run({...a,ownerId:'alice',action:'cursor'}),/SEAT_CLOSED/);
  const result=await f.c.sweep();
  assert.equal(result.failed,0);
  assert.equal(f.c.status().quarantined,0);
  assert.equal(stopAttempt,2);
  await f.c.close();
});

test('backend cannot claim same-UID as physical owner, and must be cleaned on denial',async()=>{
  let stops=0;
  const f=fixture({
    inspect:async()=>({kernelIdentityVerified:true,uid:1000,pid:42,
      display:':42',tcpDisabled:true,privateProfileVerified:true,ownerDesktopUntouched:true}),
    stop:async()=>{stops++;},
  });
  await assert.rejects(begin(f.c),/SEAT_ISOLATION_UNVERIFIED/);
  assert.equal(stops,1);
  assert.equal(f.c.status().leases,0);
  await f.c.close();
});

test('unverifiable backend identity cannot be accepted simply from cookie Xauthority',async()=>{
  let stopped=0;
  const f=fixture({inspect:async()=>({uid:41000,pid:51,display:':52',
    tcpDisabled:true,privateProfileVerified:true,ownerDesktopUntouched:true}),
    stop:async()=>{stopped++;}});
  await assert.rejects(begin(f.c),/SEAT_ISOLATION_UNVERIFIED/);
  assert.equal(stopped,1);
  await f.c.close();
});

test('same backend UID/display collision rejected without destroying existing seat',async()=>{
  let stopped=0;
  const f=fixture({
    inspect:async()=>({kernelIdentityVerified:true,uid:41004,pid:51213,display:':99',
      tcpDisabled:true,privateProfileVerified:true,ownerDesktopUntouched:true}),
    stop:async()=>{stopped++;},
  });
  const a=await begin(f.c,'alice','p1');
  await assert.rejects(begin(f.c,'bob','p2'),/SEAT_ISOLATION_COLLISION/);
  assert.equal(f.c.status().leases,1);
  assert.equal(stopped,1);
  await f.c.end({...a,ownerId:'alice'});
  assert.equal(stopped,2);
});

test('concurrent begin calls reserve capacity, not just completed seats',async()=>{
  let finish;
  const gate=new Promise(resolve=>finish=resolve);
  const f=fixture({start:async()=>{await gate;return {n:1}}});
  const a=begin(f.c,'alice','p1');
  const b=begin(f.c,'bob','p2');
  await assert.rejects(begin(f.c,'charlie','p3'),/SEAT_CAPACITY_BUSY/);
  finish();
  const results=await Promise.allSettled([a,b]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  // Backend collision on second start is rejected; its handle is stopped.
  await f.c.close();
});

test('close waits for an in-flight startup, denies late admission and cleans its child',async()=>{
  let release;
  const gate=new Promise(resolve=>release=resolve);
  let stopCount=0;
  const f=fixture({
    start:async()=>{await gate;return {n:1}},
    stop:async()=>{stopCount++},
  });
  const beginPromise=begin(f.c,'alice','p1');
  let closed=false;
  const closing=f.c.close().then(r=>{closed=true;return r});
  await Promise.resolve();
  assert.equal(closed,false);
  release();
  await assert.rejects(beginPromise,/SEAT_COORDINATOR_CLOSED/);
  assert.deepEqual(await closing,{ok:true,cleanupFailed:0});
  assert.equal(stopCount,1);
  assert.equal(f.c.status().pending,0);
  assert.equal(f.c.status().leases,0);
});

test('duplicate in-flight seat identifiers cannot both start',async()=>{
  let release;
  const gate=new Promise(resolve=>release=resolve);
  let sequence=0,starts=0,stops=0;
  const backend={
    start:async()=>{starts++;await gate;return {n:starts}},
    inspect:async h=>({kernelIdentityVerified:true,uid:41000+h.n,pid:71000+h.n,
      display:':'+(700+h.n),tcpDisabled:true,privateProfileVerified:true,ownerDesktopUntouched:true}),
    execute:async()=>({ok:true}),
    stop:async()=>{stops++},
  };
  const c=createIsolatedSeatCoordinator({platform:'linux',hostUid:1000,backend,
    token:()=>++sequence%2 ? 'a'.repeat(64) : 'b'.repeat(64),capacity:2});
  const first=begin(c,'alice','p1');
  await assert.rejects(begin(c,'bob','p2'),/SEAT_TOKEN_INVALID/);
  assert.equal(starts,1);
  release();
  const a=await first;
  await c.end({...a,ownerId:'alice'});
  assert.equal(stops,1);
});

test('explicit end aborts a pending input operation and never reports stale success',async()=>{
  let aborted=false;
  const f=fixture({execute:async(_h,{signal})=>new Promise(resolve=>{
    signal.addEventListener('abort',()=>{aborted=true;resolve({ok:true});},{once:true});
  })});
  const a=await begin(f.c);
  const action=f.c.run({...a,ownerId:'alice',action:'key',data:{keys:['A']}});
  await f.c.end({...a,ownerId:'alice'});
  await assert.rejects(action,/SEAT_EXPIRED/);
  assert.equal(aborted,true);
  assert.equal(f.c.status().leases,0);
});

test('failed cleanup of a never-admitted child cannot report successful shutdown',async()=>{
  const f=fixture({
    inspect:async()=>({kernelIdentityVerified:false}),
    stop:async()=>{throw Error('orphaned worker');},
  });
  await assert.rejects(begin(f.c),/SEAT_CLEANUP_UNCERTAIN/);
  assert.equal(f.c.status().closed,true);
  assert.equal(f.c.status().unresolvedStartupCleanup,true);
  assert.deepEqual(await f.c.close(),{ok:false,cleanupFailed:1});
  await assert.rejects(begin(f.c),/SEAT_COORDINATOR_CLOSED/);
});

test('close returns failure when cleanup is unverified and never reopens admission',async()=>{
  const f=fixture({stop:async()=>{throw Error('cannot stop');}});
  await begin(f.c);
  const result=await f.c.close();
  assert.deepEqual(result,{ok:false,cleanupFailed:1});
  assert.equal(f.c.status().closed,true);
  assert.equal(f.c.status().quarantined,1);
  await assert.rejects(begin(f.c),/SEAT_COORDINATOR_CLOSED/);
});
