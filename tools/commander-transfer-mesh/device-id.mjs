// Syncthing device identity: SHA-256 of certificate DER, RFC 4648 base32,
// four Luhn32 check digits, and seven-character display groups.
// Protocol specification: https://docs.syncthing.net/dev/device-ids.html
import {createHash, X509Certificate} from 'node:crypto';
import path from 'node:path';

const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function syncthingDeviceIdFromPem(pem) {
  const cert=new X509Certificate(pem);
  const digest=createHash('sha256').update(cert.raw).digest();
  let value=0, bits=0, base32='';
  for (const byte of digest) {
    value=(value<<8)|byte;
    bits+=8;
    while (bits>=5) {
      bits-=5;
      base32+=alphabet[(value>>>bits)&31];
      value&=(1<<bits)-1;
    }
  }
  if(bits) base32+=alphabet[(value<<(5-bits))&31];
  if(base32.length!==52) throw new Error('Invalid certificate digest length');
  let checked='';
  for (let group=0;group<4;group++) {
    const chars=base32.slice(group*13,(group+1)*13);
    let sum=0,factor=1;
    for (const ch of chars) {
      const code=alphabet.indexOf(ch);
      if(code<0)throw new Error('Invalid device ID alphabet');
      const addend=factor*code;
      sum+=Math.floor(addend/32)+(addend%32);
      factor=factor===1?2:1;
    }
    checked+=chars+alphabet[(32-(sum%32))%32];
  }
  return checked.match(/.{7}/g).join('-');
}

export function assertSyncthingRuntimeIdentity(expectedId, certificateId, status, version) {
  if(certificateId !== expectedId) throw new Error('Certificate identity mismatch');
  if(status?.myID !== certificateId) throw new Error('Running device identity mismatch');
  if(typeof version?.version !== 'string' || !/^v[0-9]+\.[0-9]+\.[0-9]+(?:[+-][A-Za-z0-9.-]+)?$/.test(version.version))
    throw new Error('Syncthing version unavailable');
  return 'syncthing ' + version.version;
}


// SHA-256 of the public MMZ Syncthing certificate device ID. Never infer trust
// from a folder name alone; peer must also match this exact pinned fingerprint.
export const PINNED_MMZ_DEVICE_HASH='c51ff1c36a87da050b1f320e302cfd1a9bf69570efad6be68d2bf5a165724af8';

export function isPinnedOptionalMmzPair({alias,localDeviceId,root,folder,expectedPeerHash=PINNED_MMZ_DEVICE_HASH}) {
  if(alias!=='PC' && alias!=='Linux')return false;
  if(!folder || folder.paused || folder.type!=='sendreceive')return false;
  const pairId='ctmesh-v1-'+[alias,'MMZ'].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase())).join('-').toLowerCase();
  if(folder.id!==pairId || path.resolve(folder.path)!==path.resolve(root,'pairs','MMZ'))return false;
  if(!Array.isArray(folder.devices) || folder.devices.length!==2)return false;
  const members=folder.devices.map(x=>x?.deviceID);
  if(members.some(x=>typeof x!=='string') || new Set(members).size!==2 || !members.includes(localDeviceId))return false;
  const peer=members.find(x=>x!==localDeviceId);
  return createHash('sha256').update(peer).digest('hex')===expectedPeerHash;
}

// Updating this pin requires independent certificate-to-device-ID derivation and
// a read-only roster check on the authorized owner hosts; never trust a folder label.
