import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// This is a backend-neutral admission/lease library, NOT a live desktop tool.
// The caller must provide a separately trusted, kernel-inspecting backend.
const fail = c => Object.assign(new Error(c), { seatCode:c });
const word = s => typeof s === 'string' && /^[a-zA-Z0-9_.:-]{1,96}$/.test(s);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  [Object.prototype,null].includes(Object.getPrototypeOf(v));
const coord = n => Number.isSafeInteger(n) && n >= 0 && n <= 32767;
const operations = new Set(['screenshot','cursor','move','click','drag','key','text']);

function cleanOperation(op,data) {
  if (!operations.has(op) || !plain(data)) throw fail('SEAT_ACTION_DENIED');
  let allowed=[];
  if (op === 'move' || op === 'click') {
    allowed=['x','y'];
    if (!coord(data.x) || !coord(data.y)) throw fail('SEAT_COORDINATES_INVALID');
    if (op === 'click') {
      allowed.push('button');
      if (!['left','middle','right'].includes(data.button)) throw fail('SEAT_BUTTON_INVALID');
    }
  } else if (op === 'drag') {
    allowed=['from','to','durationMs'];
    const exactPoint=p=>plain(p) && Object.keys(p).length===2 && coord(p.x) && coord(p.y);
    if (!exactPoint(data.from) || !exactPoint(data.to) ||
        !Number.isSafeInteger(data.durationMs) || data.durationMs<50 || data.durationMs>3000)
      throw fail('SEAT_DRAG_INVALID');
  } else if (op === 'key') {
    allowed=['keys'];
    if (!Array.isArray(data.keys) || data.keys.length < 1 || data.keys.length > 6 ||
      data.keys.some(s => typeof s !== 'string' || !/^(?:[A-Z0-9]|ENTER|TAB|SPACE|BACKSPACE|LEFT|RIGHT|UP|DOWN|CTRL|ALT|SHIFT)$/.test(s)))
      throw fail('SEAT_KEYS_INVALID');
  } else if (op === 'text') {
    allowed=['text'];
    if (typeof data.text !== 'string' || data.text.length < 1 || data.text.length > 1024 ||
      !data.text.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(data.text))
      throw fail('SEAT_TEXT_INVALID');
  }
  if (Object.keys(data).some(key => !allowed.includes(key))) throw fail('SEAT_ACTION_DENIED');
  return structuredClone(data);
}

export function createIsolatedSeatCoordinator({
  backend, now=()=>performance.now(), token=()=>randomBytes(32).toString('hex'),
  hostUid=process.getuid?.(), platform=process.platform, capacity=4,
}={}) {
  if (platform !== 'linux' || !Number.isSafeInteger(hostUid)) throw fail('SEAT_OS_UNSUPPORTED');
  if (!backend || ['start','inspect','execute','stop'].some(k=>typeof backend[k]!=='function'))
    throw fail('SEAT_BACKEND_NOT_CONFIGURED');
  if (!Number.isSafeInteger(capacity) || capacity<1 || capacity>16) throw fail('SEAT_CAPACITY_INVALID');
  const active=new Map();
  const reservedIds=new Set();
  const pendingCompletions=new Set();
  let pending=0, closed=false, unresolvedStartupCleanup=false;

  function required(ownerId,seatId,lease) {
    if (!word(ownerId) || !word(seatId) || typeof lease!=='string') throw fail('SEAT_AUTH_INVALID');
    const s=active.get(seatId);
    if (!s || s.ownerId!==ownerId || s.lease!==lease) throw fail('SEAT_ACCESS_DENIED');
    return s;
  }

  async function stopSeat(s) {
    if (s.stopped) return;
    if (s.stopPromise) return s.stopPromise;
    s.revoked=true;
    if (s.timer) clearTimeout(s.timer);
    s.abort.abort();
    s.stopPromise=(async()=>{
      try {
        await backend.stop(s.handle);
        s.stopped=true;
        active.delete(s.id);
      } catch {
        s.quarantined=true; // retain seat & UID reservations
        throw fail('SEAT_CLEANUP_UNCERTAIN');
      } finally { s.stopPromise=null; }
    })();
    return s.stopPromise;
  }
  const timeout = s => {if (!s.stopped && now()>=s.deadline) void stopSeat(s).catch(()=>{});};

  async function begin({ownerId,profileId,ttlMs=60000}={}) {
    if (closed) throw fail('SEAT_COORDINATOR_CLOSED');
    if (!word(ownerId)||!word(profileId)) throw fail('SEAT_OWNER_INVALID');
    if (!Number.isSafeInteger(ttlMs)||ttlMs<10000||ttlMs>120000) throw fail('SEAT_TTL_INVALID');
    if (active.size+pending>=capacity) throw fail('SEAT_CAPACITY_BUSY');
    pending++;
    let completePending;
    const completion=new Promise(resolve=>{completePending=resolve;});
    pendingCompletions.add(completion);
    let handle,registered=false,reservedId;
    try {
      const id=token(),lease=token();
      if (typeof id!=='string'||typeof lease!=='string'||!/^[0-9a-f]{64}$/.test(id)||
        !/^[0-9a-f]{64}$/.test(lease)||id===lease||active.has(id)||reservedIds.has(id))
        throw fail('SEAT_TOKEN_INVALID');
      reservedIds.add(id); reservedId=id;
      handle=await backend.start({seatId:id,ownerId,profileId});
      // Inspect must read OS facts, never repeat untrusted caller assertions.
      const a=await backend.inspect(handle);
      if (!plain(a)||a.kernelIdentityVerified!==true||
        !Number.isSafeInteger(a.uid)||a.uid<0||a.uid===hostUid||
        !Number.isSafeInteger(a.pid)||a.pid<1||
        typeof a.display!=='string'||!/^:[1-9][0-9]{0,4}$/.test(a.display)||
        a.privateProfileVerified!==true||a.tcpDisabled!==true||
        a.ownerDesktopUntouched!==true) throw fail('SEAT_ISOLATION_UNVERIFIED');
      if (closed) throw fail('SEAT_COORDINATOR_CLOSED');
      if ([...active.values()].some(s=>s.uid===a.uid||s.pid===a.pid||s.display===a.display))
        throw fail('SEAT_ISOLATION_COLLISION');
      const s={id,lease,ownerId,profileId,uid:a.uid,pid:a.pid,display:a.display,
        handle,deadline:now()+ttlMs,revoked:false,stopped:false,
        quarantined:false,stopPromise:null,abort:new AbortController(),busy:false,timer:null};
      active.set(id,s);
      s.timer=setTimeout(()=>timeout(s),ttlMs);
      s.timer.unref?.();
      registered=true;
      return {seatId:id,lease,ttlMs,mode:'isolated-only',hostDesktopTouched:false};
    } catch(e) {
      if (handle!==undefined && !registered) {
        try {await backend.stop(handle);}
        catch {closed=true;unresolvedStartupCleanup=true;throw fail('SEAT_CLEANUP_UNCERTAIN');}
      }
      throw e;
    } finally {
      pending--;
      if (reservedId) reservedIds.delete(reservedId);
      pendingCompletions.delete(completion);
      completePending();
    }
  }
  async function run({ownerId,seatId,lease,action,data={}}={}) {
    const s=required(ownerId,seatId,lease);
    if (s.revoked||s.stopped||s.quarantined) throw fail('SEAT_CLOSED');
    if (now()>=s.deadline) {await stopSeat(s);throw fail('SEAT_EXPIRED');}
    if (s.busy) throw fail('SEAT_ACTION_BUSY');
    const payload=cleanOperation(action,data);
    s.busy=true;
    try {
      const result=await backend.execute(s.handle,{action,data:payload,signal:s.abort.signal});
      if (s.revoked||now()>=s.deadline) throw fail('SEAT_EXPIRED');
      if (!plain(result)||result.ok!==true) throw fail('SEAT_BACKEND_FAILED');
      return {ok:true,action,result:result.result??null};
    } finally {s.busy=false;}
  }
  async function end({ownerId,seatId,lease}={}) {
    const s=required(ownerId,seatId,lease);
    await stopSeat(s);
    return {ok:true,stopped:true};
  }
  async function sweep() {
    const list=[...active.values()].filter(s=>s.quarantined||now()>=s.deadline);
    const r=await Promise.allSettled(list.map(stopSeat));
    return {processed:list.length,failed:r.filter(x=>x.status==='rejected').length};
  }
  async function close() {
    closed=true;
    // Do not report a successful shutdown while startup is still in progress.
    await Promise.allSettled([...pendingCompletions]);
    const r=await Promise.allSettled([...active.values()].map(stopSeat));
    const cleanupFailed=r.filter(x=>x.status==='rejected').length+Number(unresolvedStartupCleanup);
    return {ok:cleanupFailed===0,cleanupFailed};
  }
  const status=()=>({closed,isolatedOnly:true,hostDesktopTouched:false,
    leases:[...active.values()].filter(s=>!s.revoked).length,
    quarantined:[...active.values()].filter(s=>s.quarantined).length,
    unresolvedStartupCleanup,pending});
  return {begin,run,end,sweep,close,status};
}
