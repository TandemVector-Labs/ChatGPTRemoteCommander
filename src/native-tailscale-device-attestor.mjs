// V1-07 Tailscale-backed device attestor.
// This module does not execute a CLI, open sockets, or trust model/HTTP input.
// The host must inject a native process probe pinned to the exact Tailscale binary.
import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { isAbsolute } from 'node:path';

const DOMAIN='commander.native-tailscale-device-attestor.v1';
const HEX64=/^[a-f0-9]{64}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROBE_FIELDS=Object.freeze([
  'source','pid','ownerSidHash','executablePath','executableSha256',
  'startedAtMs','finishedAtMs','exitCode','stdout'
]);
const fail=code=>{throw Object.assign(new Error(code),{code,nativeTailscaleAttestorCode:code});};
const timestamp=value=>Number.isSafeInteger(value)&&value>=0;
const digest=value=>typeof value==='string'&&HEX64.test(value);
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
function dataField(value,key,code){
  if(!isPlain(value))fail(code);
  const d=Object.getOwnPropertyDescriptor(value,key);
  if(!d||!d.enumerable||!Object.hasOwn(d,'value'))fail(code);
  return d.value;
}
function clock(now){
  const value=now();
  if(!timestamp(value))fail('NATIVE_TAILSCALE_CLOCK_INVALID');
  return value;
}
function stableNodeId(value){
  return typeof value==='string'&&ID.test(value)&&value!=='.'&&value!=='..';
}
function nodePublicKey(value){
  return typeof value==='string'&&value.length>=8&&value.length<=256
    &&!/[\u0000-\u0020\u007f]/.test(value);
}
function validateProbe(value,config,ownerSidHash,observedAtMs){
  const p=exactRecord(value,PROBE_FIELDS,'NATIVE_TAILSCALE_PROBE_UNVERIFIED');
  if(p.source!=='native-tailscale-cli-probe'
    ||!Number.isSafeInteger(p.pid)||p.pid<=1
    ||p.ownerSidHash!==ownerSidHash
    ||p.executablePath!==config.expectedExecutablePath
    ||p.executableSha256!==config.expectedExecutableSha256
    ||!timestamp(p.startedAtMs)||!timestamp(p.finishedAtMs)
    ||p.startedAtMs>p.finishedAtMs||p.finishedAtMs>observedAtMs
    ||p.finishedAtMs-p.startedAtMs>config.maxCommandDurationMs
    ||p.exitCode!==0||typeof p.stdout!=='string'
    ||Buffer.byteLength(p.stdout,'utf8')>config.maxStatusBytes)
    fail('NATIVE_TAILSCALE_PROBE_UNVERIFIED');
  return p;
}
function parseLocalStatus(stdout){
  let status;
  try{status=JSON.parse(stdout);}
  catch{fail('NATIVE_TAILSCALE_STATUS_INVALID_JSON');}
  if(!isPlain(status)
    ||dataField(status,'BackendState','NATIVE_TAILSCALE_STATUS_INVALID')!=='Running'
    ||dataField(status,'HaveNodeKey','NATIVE_TAILSCALE_STATUS_INVALID')!==true)
    fail('NATIVE_TAILSCALE_BACKEND_NOT_READY');
  const health=dataField(status,'Health','NATIVE_TAILSCALE_STATUS_INVALID');
  if(health!==null&&(!Array.isArray(health)||health.length!==0))
    fail('NATIVE_TAILSCALE_HEALTH_NOT_CLEAN');
  const self=dataField(status,'Self','NATIVE_TAILSCALE_STATUS_INVALID');
  const stableId=dataField(self,'ID','NATIVE_TAILSCALE_SELF_INVALID');
  const publicKey=dataField(self,'PublicKey','NATIVE_TAILSCALE_SELF_INVALID');
  if(!stableNodeId(stableId)||!nodePublicKey(publicKey)
    ||dataField(self,'Online','NATIVE_TAILSCALE_SELF_INVALID')!==true)
    fail('NATIVE_TAILSCALE_SELF_NOT_ONLINE');
  const expired=Object.getOwnPropertyDescriptor(self,'Expired');
  if(expired&&(!Object.hasOwn(expired,'value')||expired.value!==false))
    fail('NATIVE_TAILSCALE_SELF_EXPIRED');
  return stableId;
}
function hashDevice(hostId,stableId){
  return createHash('sha256')
    .update(JSON.stringify([DOMAIN,hostId,stableId]),'utf8').digest('hex');
}

/**
 * Build the V1-07 resolveDeviceIdentity callback.
 *
 * resolveOwnerSidHash() must read/hash the current native OS owner identity.
 * readTailscaleStatus() must execute exactly "tailscale status --json" without
 * a shell, as that owner, using the pinned executable; it returns only the
 * bounded process receipt below. Do not log or return stdout outside this
 * adapter: Tailscale status JSON includes tailnet peer metadata.
 *
 * Tailscale documents --json as subject to change. This adapter validates the
 * minimal required schema and fails closed on drift, offline state or errors.
 */
export function createNativeTailscaleDeviceAttestor({
  hostId,expectedExecutablePath,expectedExecutableSha256,
  resolveOwnerSidHash,readTailscaleStatus,now=Date.now,
  maxAgeMs=120000,attestationTtlMs=60000,maxCommandDurationMs=15000,
  maxStatusBytes=1048576
}={}){
  if(typeof hostId!=='string'||!ID.test(hostId)||hostId==='.'||hostId==='..'
    ||typeof expectedExecutablePath!=='string'||!isAbsolute(expectedExecutablePath)
    ||expectedExecutablePath.includes('\0')||!digest(expectedExecutableSha256)
    ||typeof resolveOwnerSidHash!=='function'||typeof readTailscaleStatus!=='function'
    ||typeof now!=='function'||!Number.isSafeInteger(maxAgeMs)||maxAgeMs<1000||maxAgeMs>3600000
    ||!Number.isSafeInteger(attestationTtlMs)||attestationTtlMs<1000||attestationTtlMs>3600000
    ||!Number.isSafeInteger(maxCommandDurationMs)||maxCommandDurationMs<100
    ||maxCommandDurationMs>120000||!Number.isSafeInteger(maxStatusBytes)
    ||maxStatusBytes<1024||maxStatusBytes>4194304)
    fail('NATIVE_TAILSCALE_ATTESTOR_CONFIG_INVALID');
  const config=Object.freeze({
    expectedExecutablePath,expectedExecutableSha256,maxCommandDurationMs,maxStatusBytes
  });
  async function readOwner(){
    const value=await resolveOwnerSidHash();
    if(!digest(value))fail('NATIVE_TAILSCALE_OWNER_UNVERIFIED');
    return value;
  }
  async function resolveDeviceIdentity(){
    const ownerBefore=await readOwner();
    // The process probe necessarily finishes after it starts. Observe the
    // clock after the awaited native command, then reject future-dated receipts.
    const probeValue=await readTailscaleStatus();
    const observedAfterProbe=clock(now);
    const probe=validateProbe(probeValue,config,ownerBefore,observedAfterProbe);
    const stableId=parseLocalStatus(probe.stdout);
    const ownerAfter=await readOwner();
    if(ownerAfter!==ownerBefore)fail('NATIVE_TAILSCALE_OWNER_CHANGED');
    const observedAtMs=clock(now);
    if(probe.finishedAtMs>observedAtMs
      ||observedAtMs-probe.finishedAtMs>maxAgeMs)
      fail('NATIVE_TAILSCALE_STATUS_STALE');
    const expiresAtMs=Math.min(
      probe.finishedAtMs+maxAgeMs,observedAtMs+attestationTtlMs
    );
    if(!timestamp(expiresAtMs)||expiresAtMs<=observedAtMs)
      fail('NATIVE_TAILSCALE_ATTESTATION_WINDOW_INVALID');
    return Object.freeze({
      source:'native-device-attestor',
      provider:'tailscale',
      deviceIdHash:hashDevice(hostId,stableId),
      ownerSidHash:ownerBefore,
      verified:true,
      attestedAtMs:probe.finishedAtMs,
      expiresAtMs
    });
  }
  return Object.freeze({resolveDeviceIdentity});
}
