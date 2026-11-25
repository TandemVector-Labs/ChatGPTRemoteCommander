// Resolve the exact native OS owner identity used to enroll the existing
// one-profile Tunnel PIN. Migration may switch a v1 namespace-bound PIN to
// stable host-UID v2; the read-only signed witness must support either, but
// must not silently accept an unrelated owner or shifted native seat.
const HASH=/^[a-f0-9]{64}$/;
const SNAPSHOT_FIELDS=['osSessionId','seatId','displayId','sessionType','leaderPid'];
const fail=code=>{throw Object.assign(new Error(code),{code});};

export function resolveLinuxNativeWitnessEnrollmentMode({
  pinnedOwnerSidHash,v1,v2
}={}){
  if(typeof pinnedOwnerSidHash!=='string'||!HASH.test(pinnedOwnerSidHash)
    ||![v1,v2].every(s=>s&&typeof s==='object'&&!Array.isArray(s)
      &&typeof s.ownerSidHash==='string'&&HASH.test(s.ownerSidHash)))
    fail('RC012_NATIVE_WITNESS_OWNER_SNAPSHOT_INVALID');
  for(const key of SNAPSHOT_FIELDS){
    if(v1[key]===undefined||v2[key]===undefined||v1[key]!==v2[key])
      fail('RC012_NATIVE_WITNESS_NATIVE_SEAT_CHANGED');
  }
  if(!Number.isSafeInteger(v1.leaderPid)||v1.leaderPid<=1
    ||!['x11','wayland'].includes(v1.sessionType)
    ||!/^linux-logind-[A-Za-z0-9_-]+$/.test(v1.osSessionId)
    ||typeof v1.seatId!=='string'||!v1.seatId
    ||typeof v1.displayId!=='string'||!v1.displayId)
    fail('RC012_NATIVE_WITNESS_NATIVE_SEAT_INVALID');
  const matchesV1=pinnedOwnerSidHash===v1.ownerSidHash;
  const matchesV2=pinnedOwnerSidHash===v2.ownerSidHash;
  if(matchesV1===matchesV2)fail('RC012_NATIVE_WITNESS_OWNER_PIN_NOT_UNIQUE');
  return Object.freeze({
    mode:matchesV2?'host-uid-v2':'namespace-v1',
    signedOwnerSidHash:v2.ownerSidHash,
    pinnedOwnerSidHash,
    osSessionId:v2.osSessionId
  });
}
