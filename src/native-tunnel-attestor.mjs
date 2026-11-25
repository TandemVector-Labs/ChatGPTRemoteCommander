// Native tunnel attestor adapter for V1-07.
// This module never executes commands, reads tunnel credentials, or trusts HTTP/model input.
// The host must inject an authorized OS process inspector and exact-PID tunnel health probe.
import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { isAbsolute } from 'node:path';

const DOMAIN='commander.native-tunnel-attestor.v1';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX64=/^[a-f0-9]{64}$/;
const INSTANCE=/^[A-Za-z0-9][A-Za-z0-9._:-]{15,255}$/;
const PROCESS_FIELDS=Object.freeze([
  'source','pid','profileId','profileArgumentVerified','matchCount','running',
  'ownerSidHash','executablePath','executableSha256','startedAtMs'
]);
const HEALTH_FIELDS=Object.freeze([
  'source','pid','profileId','ownerSidHash','executablePath','executableSha256',
  'startedAtMs','clientInstanceId','authenticated','controlPlanePollOk',
  'healthzStatus','readyzStatus','lastPollAtMs'
]);
const fail=code=>{throw Object.assign(new Error(code),{code,nativeTunnelAttestorCode:code});};
const timestamp=value=>Number.isSafeInteger(value)&&value>=0;
const digest=value=>typeof value==='string'&&HEX64.test(value);
const safeId=value=>typeof value==='string'&&ID.test(value)&&value!=='.'&&value!=='..';
function isPlain(value){
  return value!==null&&typeof value==='object'&&!Array.isArray(value)
    &&!isProxy(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
}
function exactRecord(value,fields,code){
  if(!isPlain(value)||Reflect.ownKeys(value).length!==fields.length)fail(code);
  const out=Object.create(null);
  for(const field of fields){
    const d=Object.getOwnPropertyDescriptor(value,field);
    if(!d||!d.enumerable||!Object.hasOwn(d,'value'))fail(code);
    out[field]=d.value;
  }
  return Object.freeze(out);
}
function clock(now){
  const value=now();
  if(!timestamp(value))fail('NATIVE_TUNNEL_CLOCK_INVALID');
  return value;
}
function validateProcess(value,config,ownerSidHash){
  const p=exactRecord(value,PROCESS_FIELDS,'NATIVE_TUNNEL_PROCESS_UNVERIFIED');
  if(p.source!=='native-process-attestor'||!Number.isSafeInteger(p.pid)||p.pid<=1
    ||p.profileId!==config.profileId||p.profileArgumentVerified!==true
    ||p.matchCount!==1||p.running!==true||p.ownerSidHash!==ownerSidHash
    ||p.executablePath!==config.expectedExecutablePath
    ||p.executableSha256!==config.expectedExecutableSha256
    ||!timestamp(p.startedAtMs))
    fail('NATIVE_TUNNEL_PROCESS_UNVERIFIED');
  return p;
}
function validateHealth(value,process,ownerSidHash){
  const h=exactRecord(value,HEALTH_FIELDS,'NATIVE_TUNNEL_HEALTH_UNVERIFIED');
  if(h.source!=='native-tunnel-health-probe'||h.pid!==process.pid
    ||h.profileId!==process.profileId||h.ownerSidHash!==ownerSidHash
    ||h.executablePath!==process.executablePath
    ||h.executableSha256!==process.executableSha256
    ||h.startedAtMs!==process.startedAtMs
    ||typeof h.clientInstanceId!=='string'||!INSTANCE.test(h.clientInstanceId)
    ||h.authenticated!==true||h.controlPlanePollOk!==true
    ||h.healthzStatus!==200||h.readyzStatus!==200
    ||!timestamp(h.lastPollAtMs))
    fail('NATIVE_TUNNEL_HEALTH_UNVERIFIED');
  return h;
}
function sameProcess(a,b){
  return a.pid===b.pid&&a.profileId===b.profileId
    &&a.ownerSidHash===b.ownerSidHash&&a.executablePath===b.executablePath
    &&a.executableSha256===b.executableSha256&&a.startedAtMs===b.startedAtMs
    &&a.profileArgumentVerified===b.profileArgumentVerified
    &&a.matchCount===b.matchCount&&a.running===b.running;
}
function hashTunnelInstance({hostId,profileId,ownerSidHash,process,clientInstanceId}){
  const tuple=[
    DOMAIN,hostId,profileId,ownerSidHash,process.executableSha256,
    process.pid,process.startedAtMs,clientInstanceId
  ];
  return createHash('sha256').update(JSON.stringify(tuple),'utf8').digest('hex');
}

/**
 * Build the V1-07 resolveTransportIdentity callback from trusted native host probes.
 *
 * resolveOwnerSidHash() must hash the current OS owner identity without exposing it.
 * resolveOwnedTunnelProcess() must return exactly one live process whose executable,
 * OS owner, and parsed --profile argument match this host's pinned configuration.
 * probeTunnelHealth(process) must poll the exact PID/profile, prove authenticated
 * control-plane connectivity and health/readiness, and return only the fields below.
 *
 * clientInstanceId is deliberately used only as an ephemeral transport-instance input
 * to tunnelIdHash. It is never returned or used as workerId/device identity.
 */
export function createNativeTunnelAttestor({
  hostId,profileId,expectedExecutablePath,expectedExecutableSha256,
  resolveOwnerSidHash,resolveOwnedTunnelProcess,probeTunnelHealth,now=Date.now,
  maxAgeMs=120000,attestationTtlMs=60000
}={}){
  if(!safeId(hostId)||!safeId(profileId)||typeof expectedExecutablePath!=='string'
    ||!isAbsolute(expectedExecutablePath)||expectedExecutablePath.includes('\0')
    ||!digest(expectedExecutableSha256)||typeof resolveOwnerSidHash!=='function'
    ||typeof resolveOwnedTunnelProcess!=='function'||typeof probeTunnelHealth!=='function'
    ||typeof now!=='function'||!Number.isSafeInteger(maxAgeMs)||maxAgeMs<1000
    ||maxAgeMs>3600000||!Number.isSafeInteger(attestationTtlMs)
    ||attestationTtlMs<1000||attestationTtlMs>3600000)
    fail('NATIVE_TUNNEL_ATTESTOR_CONFIG_INVALID');

  const config=Object.freeze({
    hostId,profileId,expectedExecutablePath,expectedExecutableSha256
  });
  async function readOwner(){
    const value=await resolveOwnerSidHash();
    if(!digest(value))fail('NATIVE_TUNNEL_OWNER_UNVERIFIED');
    return value;
  }
  async function readProcess(ownerSidHash){
    return validateProcess(await resolveOwnedTunnelProcess(),config,ownerSidHash);
  }
  async function resolveTransportIdentity(){
    const ownerBefore=await readOwner();
    const processBefore=await readProcess(ownerBefore);
    // The host probe receives only the exact, already-validated process identity.
    const health=validateHealth(await probeTunnelHealth(processBefore),processBefore,ownerBefore);
    // Re-resolve owner and process after the asynchronous health poll to defeat PID reuse,
    // process replacement, profile switching, and owner-session changes during the probe.
    const processAfter=await readProcess(ownerBefore);
    const ownerAfter=await readOwner();
    if(ownerAfter!==ownerBefore)fail('NATIVE_TUNNEL_OWNER_CHANGED');
    if(!sameProcess(processBefore,processAfter))fail('NATIVE_TUNNEL_PROCESS_CHANGED');

    const observedAtMs=clock(now);
    if(health.lastPollAtMs>observedAtMs
      ||observedAtMs-health.lastPollAtMs>maxAgeMs)
      fail('NATIVE_TUNNEL_HEALTH_STALE');
    const expiresAtMs=Math.min(
      health.lastPollAtMs+maxAgeMs,observedAtMs+attestationTtlMs
    );
    if(!timestamp(expiresAtMs)||expiresAtMs<=observedAtMs)
      fail('NATIVE_TUNNEL_ATTESTATION_WINDOW_INVALID');

    return Object.freeze({
      source:'native-tunnel-attestor',
      provider:'openai-secure-mcp-tunnel',
      profileId,
      tunnelIdHash:hashTunnelInstance({
        hostId,profileId,ownerSidHash:ownerBefore,process:processBefore,
        clientInstanceId:health.clientInstanceId
      }),
      ownerSidHash:ownerBefore,
      authenticated:true,
      controlPlanePollOk:true,
      healthzStatus:health.healthzStatus,
      readyzStatus:health.readyzStatus,
      lastPollAtMs:health.lastPollAtMs,
      expiresAtMs
    });
  }
  return Object.freeze({resolveTransportIdentity});
}
