// V1-06: cross-host artifact receipt/ACK protocol.
// This module proves delivery only. It never grants worker, workflow, or command execution authority.
// Host identity, peer trust, signing, and owner consent are injected only by the trusted local Host.
import fs from 'node:fs';
import path from 'node:path';
import {
  KeyObject, createHash, randomBytes, randomUUID, sign, verify
} from 'node:crypto';

const DOMAIN='commander.transfer.receipt.v1';
const PEERS=new Set(['PC','Linux','MMZ','EmadServer','Amirreza']);
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TRANSFER_ID=/^[A-Za-z0-9][A-Za-z0-9._-]{2,90}$/;
const EPOCH=/^[a-f0-9]{32,64}$/;
const SHA=/^[a-f0-9]{64}$/;
const NONCE=/^[A-Za-z0-9_-]{43}$/;
const SIGNATURE=/^[A-Za-z0-9_-]{86}$/;
const MAX_ARTIFACT_BYTES=64*1024**3;
const CHALLENGE_FIELDS=Object.freeze([
  'schema','issuer','audience','senderAlias','recipientAlias',
  'senderHostId','senderProfileId','recipientHostId','recipientProfileId',
  'transferId','artifactBytes','senderConsentEpoch','nonce','issuedAtMs','expiresAtMs'
]);
const CLAIM_FIELDS=Object.freeze([
  'issuer','audience','senderHostId','senderProfileId',
  'recipientHostId','recipientProfileId','transferId','artifactBytes',
  'artifactSha256','nonce','challengeIssuedAtMs','challengeExpiresAtMs',
  'senderConsentEpoch','recipientConsentEpoch','issuedAtMs','expiresAtMs','receiptId'
]);
const ENVELOPE_FIELDS=Object.freeze(['schema','keyId','claims','signature']);
const fail=code=>{throw Object.assign(new Error(code),{code});};

function exact(value,fields,code){
  if(!value||typeof value!=='object'||Array.isArray(value)
    ||![Object.prototype,null].includes(Object.getPrototypeOf(value))
    ||Reflect.ownKeys(value).length!==fields.length)fail(code);
  const out={};
  for(const field of fields){
    const d=Object.getOwnPropertyDescriptor(value,field);
    if(!d||!d.enumerable||!Object.hasOwn(d,'value'))fail(code);
    out[field]=d.value;
  }
  return Object.freeze(out);
}
function safe(value){return typeof value==='string'&&ID.test(value)&&value!=='.'&&value!=='..';}
function validBytes(value){
  return Number.isSafeInteger(value)&&value>=0&&value<=MAX_ARTIFACT_BYTES;
}
function nonceBytes(value){
  if(typeof value!=='string'||!NONCE.test(value))fail('TRANSFER_RECEIPT_NONCE_INVALID');
  const bytes=Buffer.from(value,'base64url');
  if(bytes.length!==32||bytes.toString('base64url')!==value)
    fail('TRANSFER_RECEIPT_NONCE_INVALID');
  return bytes;
}
function signatureBytes(value){
  if(typeof value!=='string'||!SIGNATURE.test(value))
    fail('TRANSFER_RECEIPT_SIGNATURE_INVALID');
  const bytes=Buffer.from(value,'base64url');
  if(bytes.length!==64||bytes.toString('base64url')!==value)
    fail('TRANSFER_RECEIPT_SIGNATURE_INVALID');
  return bytes;
}
function stable(value){
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
  const keys=Object.keys(value).sort();
  return '{'+keys.map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';
}
const hash=value=>createHash('sha256').update(value).digest('hex');
const objectHash=value=>hash(stable(value));
function signedBytes(keyId,claims){
  return Buffer.from(JSON.stringify([DOMAIN,keyId,...CLAIM_FIELDS.map(k=>claims[k])]),'utf8');
}
function validateLocalIdentity(value){
  const v=exact(value,['alias','hostId','profileId','keyId','publicKey'],'TRANSFER_RECEIPT_LOCAL_IDENTITY_INVALID');
  const {alias,hostId,profileId,keyId,publicKey}=v;
  if(!PEERS.has(alias)||!safe(hostId)||!safe(profileId)||!safe(keyId)
    ||!(publicKey instanceof KeyObject)||publicKey.type!=='public'
    ||publicKey.asymmetricKeyType!=='ed25519')
    fail('TRANSFER_RECEIPT_LOCAL_IDENTITY_INVALID');
  return Object.freeze({alias,hostId,profileId,keyId,publicKey});
}
function validatePeerIdentity(value,alias){
  const v=exact(value,['alias','hostId','profileId','authenticated','publicKeys'],'TRANSFER_RECEIPT_PEER_UNTRUSTED');
  const {hostId,profileId,authenticated,publicKeys}=v;
  if(v.alias!==alias||!PEERS.has(alias)||!safe(hostId)||!safe(profileId)
    ||authenticated!==true||!(publicKeys instanceof Map)||publicKeys.size<1||publicKeys.size>32)
    fail('TRANSFER_RECEIPT_PEER_UNTRUSTED');
  const keys=new Map();
  for(const [keyId,key] of publicKeys){
    if(!safe(keyId)||!(key instanceof KeyObject)||key.type!=='public'
      ||key.asymmetricKeyType!=='ed25519')fail('TRANSFER_RECEIPT_PEER_UNTRUSTED');
    keys.set(keyId,key);
  }
  return Object.freeze({alias,hostId,profileId,authenticated:true,publicKeys:keys});
}
function validateChallenge(value,{issuer,audience}={}){
  const c=exact(value,CHALLENGE_FIELDS,'TRANSFER_RECEIPT_CHALLENGE_INVALID');
  if(c.schema!==1||c.issuer!==issuer||c.audience!==audience
    ||!PEERS.has(c.senderAlias)||!PEERS.has(c.recipientAlias)||c.senderAlias===c.recipientAlias
    ||![c.senderHostId,c.senderProfileId,c.recipientHostId,c.recipientProfileId].every(safe)
    ||typeof c.transferId!=='string'||!TRANSFER_ID.test(c.transferId)||!validBytes(c.artifactBytes)
    ||!EPOCH.test(c.senderConsentEpoch))
    fail('TRANSFER_RECEIPT_CHALLENGE_INVALID');
  nonceBytes(c.nonce);
  if(!Number.isSafeInteger(c.issuedAtMs)||c.issuedAtMs<0
    ||!Number.isSafeInteger(c.expiresAtMs)||c.expiresAtMs<=c.issuedAtMs)
    fail('TRANSFER_RECEIPT_CHALLENGE_INVALID');
  return c;
}
function validateArtifact(value){
  const a=exact(value,['bytes','sha256'],'TRANSFER_RECEIPT_ARTIFACT_INVALID');
  if(!validBytes(a.bytes)||typeof a.sha256!=='string'||!SHA.test(a.sha256))
    fail('TRANSFER_RECEIPT_ARTIFACT_INVALID');
  return a;
}
function ensureDirectory(directory){
  if(typeof directory!=='string'||!path.isAbsolute(directory))
    fail('TRANSFER_RECEIPT_LEDGER_PATH_INVALID');
  const resolved=path.resolve(directory);
  fs.mkdirSync(resolved,{recursive:true,mode:0o700});
  const st=fs.lstatSync(resolved);
  if(!st.isDirectory()||st.isSymbolicLink())fail('TRANSFER_RECEIPT_LEDGER_UNTRUSTED');
  const real=fs.realpathSync.native(resolved);
  if(path.relative(resolved,real)!=='')fail('TRANSFER_RECEIPT_LEDGER_UNTRUSTED');
  return real;
}
function verifyDirectoryExisting(directory){
  const resolved=path.resolve(directory);
  const st=fs.lstatSync(resolved);
  if(!st.isDirectory()||st.isSymbolicLink())fail('TRANSFER_RECEIPT_LEDGER_UNTRUSTED');
  const real=fs.realpathSync.native(resolved);
  if(path.relative(resolved,real)!=='')fail('TRANSFER_RECEIPT_LEDGER_UNTRUSTED');
  return real;
}
function readJson(file){
  verifyDirectoryExisting(path.dirname(file));
  const before=fs.lstatSync(file);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>65536)
    fail('TRANSFER_RECEIPT_RECORD_UNTRUSTED');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try{
    const after=fs.fstatSync(fd);
    if(!after.isFile()||after.dev!==before.dev||after.ino!==before.ino
      ||after.size!==before.size||after.nlink!==1)
      fail('TRANSFER_RECEIPT_RECORD_CHANGED');
    const bytes=Buffer.alloc(after.size);
    let offset=0;
    while(offset<bytes.length){
      const n=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);
      if(n<=0)fail('TRANSFER_RECEIPT_RECORD_TRUNCATED');
      offset+=n;
    }
    return JSON.parse(bytes.toString('utf8'));
  }finally{fs.closeSync(fd);}
}
function readOptional(file){
  try{return readJson(file);}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}
function syncDirectory(directory){
  let fd;
  try{fd=fs.openSync(directory,fs.constants.O_RDONLY);fs.fsyncSync(fd);}
  catch(error){
    if(!['EINVAL','EPERM','EISDIR','EBADF','ENOTSUP'].includes(error.code))throw error;
  }finally{if(fd!==undefined)fs.closeSync(fd);}
}
function writeImmutableJson(file,value){
  const directory=ensureDirectory(path.dirname(file));
  const target=path.join(directory,path.basename(file));
  const temp=path.join(directory,'.'+path.basename(file)+'.'+randomUUID()+'.tmp');
  const bytes=Buffer.from(stable(value)+'\n','utf8');
  const fd=fs.openSync(temp,'wx',0o600);
  try{
    let offset=0;
    while(offset<bytes.length){
      const n=fs.writeSync(fd,bytes,offset,bytes.length-offset,null);
      if(n<=0)fail('TRANSFER_RECEIPT_RECORD_WRITE_FAILED');
      offset+=n;
    }
    fs.fsyncSync(fd);
  }finally{fs.closeSync(fd);}
  let created=false;
  try{
    fs.linkSync(temp,target);
    created=true;
    syncDirectory(directory);
  }catch(error){
    if(error.code!=='EEXIST')throw error;
    const existing=readJson(target);
    if(stable(existing)!==stable(value))fail('TRANSFER_RECEIPT_IMMUTABLE_CONFLICT');
  }finally{
    try{fs.unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  return created;
}
function validateAuthorization(value){
  const a=exact(value,['granted','consentEpoch'],'TRANSFER_RECEIPT_OWNER_AUTH_INVALID');
  if(a.granted!==true||!EPOCH.test(a.consentEpoch))
    fail('TRANSFER_RECEIPT_OWNER_CONSENT_REQUIRED');
  return a;
}
function validateEnvelope(value,{issuer,audience}={}){
  const e=exact(value,ENVELOPE_FIELDS,'TRANSFER_RECEIPT_ENVELOPE_INVALID');
  if(e.schema!==1||!safe(e.keyId))fail('TRANSFER_RECEIPT_ENVELOPE_INVALID');
  const c=exact(e.claims,CLAIM_FIELDS,'TRANSFER_RECEIPT_CLAIMS_INVALID');
  if(c.issuer!==issuer||c.audience!==audience
    ||![c.senderHostId,c.senderProfileId,c.recipientHostId,c.recipientProfileId].every(safe)
    ||typeof c.transferId!=='string'||!TRANSFER_ID.test(c.transferId)||!validBytes(c.artifactBytes)
    ||typeof c.artifactSha256!=='string'||!SHA.test(c.artifactSha256)
    ||!EPOCH.test(c.senderConsentEpoch)||!EPOCH.test(c.recipientConsentEpoch)
    ||!Number.isSafeInteger(c.challengeIssuedAtMs)||c.challengeIssuedAtMs<0
    ||!Number.isSafeInteger(c.challengeExpiresAtMs)||c.challengeExpiresAtMs<=c.challengeIssuedAtMs
    ||!Number.isSafeInteger(c.issuedAtMs)||c.issuedAtMs<c.challengeIssuedAtMs
    ||!Number.isSafeInteger(c.expiresAtMs)||c.expiresAtMs<=c.issuedAtMs
    ||!SHA.test(c.receiptId))
    fail('TRANSFER_RECEIPT_CLAIMS_INVALID');
  nonceBytes(c.nonce);
  signatureBytes(e.signature);
  return Object.freeze({schema:1,keyId:e.keyId,claims:c,signature:e.signature});
}
function challengeMatchesIdentity(challenge,local,peer,peerAlias,side){
  if(side==='receiver'){
    if(challenge.senderAlias!==peerAlias||challenge.recipientAlias!==local.alias
      ||challenge.senderHostId!==peer.hostId||challenge.senderProfileId!==peer.profileId
      ||challenge.recipientHostId!==local.hostId||challenge.recipientProfileId!==local.profileId)
      fail('TRANSFER_RECEIPT_PEER_IDENTITY_MISMATCH');
  }else{
    if(challenge.senderAlias!==local.alias||challenge.recipientAlias!==peerAlias
      ||challenge.senderHostId!==local.hostId||challenge.senderProfileId!==local.profileId
      ||challenge.recipientHostId!==peer.hostId||challenge.recipientProfileId!==peer.profileId)
      fail('TRANSFER_RECEIPT_PEER_IDENTITY_MISMATCH');
  }
}

export function createTransferReceiptAuthority({
  issuer,audience,ledgerDirectory,localIdentity,resolvePeerIdentity,
  signReceipt,authorizeTransfer,now=Date.now,challengeTtlMs=24*60*60*1000
}={}){
  if(!safe(issuer)||!safe(audience)||typeof localIdentity!=='function'
    ||typeof resolvePeerIdentity!=='function'||typeof signReceipt!=='function'
    ||typeof authorizeTransfer!=='function'||typeof now!=='function'
    ||!Number.isSafeInteger(challengeTtlMs)||challengeTtlMs<60000
    ||challengeTtlMs>7*24*60*60*1000)
    fail('TRANSFER_RECEIPT_AUTHORITY_REQUIRED');
  const ledger=ensureDirectory(ledgerDirectory);
  const challengeFile=(peer,id)=>path.join(ledger,'challenges',peer,id+'.json');
  const issuedFile=(peer,id)=>path.join(ledger,'issued',peer,id+'.json');
  const acceptedFile=nonce=>path.join(ledger,'accepted',hash(nonceBytes(nonce))+'.json');
  const timestamp=()=>{
    const t=now();
    if(!Number.isSafeInteger(t))fail('TRANSFER_RECEIPT_CLOCK_INVALID');
    return t;
  };
  async function getLocal(){
    try{return validateLocalIdentity(await localIdentity());}
    catch(error){if(error.code)throw error;fail('TRANSFER_RECEIPT_LOCAL_IDENTITY_UNAVAILABLE');}
  }
  async function getPeer(alias){
    if(!PEERS.has(alias))fail('TRANSFER_RECEIPT_PEER_UNTRUSTED');
    try{return validatePeerIdentity(await resolvePeerIdentity(alias),alias);}
    catch(error){if(error.code)throw error;fail('TRANSFER_RECEIPT_PEER_UNTRUSTED');}
  }
  async function authorize(context){
    let result;
    try{result=await authorizeTransfer(Object.freeze(context));}
    catch{fail('TRANSFER_RECEIPT_OWNER_AUTH_UNAVAILABLE');}
    return validateAuthorization(result);
  }
  function loadChallenge(peer,id){
    const value=readJson(challengeFile(peer,id));
    return validateChallenge(value,{issuer,audience});
  }
  function checkChallengeTime(challenge,t){
    if(challenge.expiresAtMs-challenge.issuedAtMs>challengeTtlMs
      ||challenge.issuedAtMs>t||challenge.expiresAtMs<=t)
      fail('TRANSFER_RECEIPT_CHALLENGE_EXPIRED');
  }
  async function createChallenge({peerAlias,transferId,bytes}={}){
    if(!PEERS.has(peerAlias)||typeof transferId!=='string'||!TRANSFER_ID.test(transferId)||!validBytes(bytes))
      fail('TRANSFER_RECEIPT_CHALLENGE_REQUEST_INVALID');
    const local=await getLocal(),peer=await getPeer(peerAlias),t=timestamp();
    if(local.alias===peerAlias)fail('TRANSFER_RECEIPT_PEER_UNTRUSTED');
    const authorization=await authorize({
      action:'send',peerAlias,transferId,artifactBytes:bytes,artifactSha256:null,
      senderHostId:local.hostId,senderProfileId:local.profileId,
      recipientHostId:peer.hostId,recipientProfileId:peer.profileId
    });
    const file=challengeFile(peerAlias,transferId);
    const existing=readOptional(file);
    if(existing){
      const c=validateChallenge(existing,{issuer,audience});
      if(c.senderAlias!==local.alias||c.recipientAlias!==peerAlias
        ||c.senderHostId!==local.hostId||c.senderProfileId!==local.profileId
        ||c.recipientHostId!==peer.hostId||c.recipientProfileId!==peer.profileId
        ||c.artifactBytes!==bytes||c.senderConsentEpoch!==authorization.consentEpoch)
        fail('TRANSFER_RECEIPT_CHALLENGE_CONFLICT');
      checkChallengeTime(c,t);
      return c;
    }
    if(!Number.isSafeInteger(t+challengeTtlMs))fail('TRANSFER_RECEIPT_CLOCK_INVALID');
    const challenge=Object.freeze({
      schema:1,issuer,audience,senderAlias:local.alias,recipientAlias:peerAlias,
      senderHostId:local.hostId,senderProfileId:local.profileId,
      recipientHostId:peer.hostId,recipientProfileId:peer.profileId,
      transferId,artifactBytes:bytes,senderConsentEpoch:authorization.consentEpoch,
      nonce:randomBytes(32).toString('base64url'),issuedAtMs:t,expiresAtMs:t+challengeTtlMs
    });
    try{writeImmutableJson(file,challenge);return challenge;}
    catch(error){
      if(error.code!=='TRANSFER_RECEIPT_IMMUTABLE_CONFLICT')throw error;
      const raced=validateChallenge(readJson(file),{issuer,audience});
      if(raced.senderAlias===local.alias&&raced.recipientAlias===peerAlias
        &&raced.senderHostId===local.hostId&&raced.senderProfileId===local.profileId
        &&raced.recipientHostId===peer.hostId&&raced.recipientProfileId===peer.profileId
        &&raced.artifactBytes===bytes&&raced.senderConsentEpoch===authorization.consentEpoch){
        checkChallengeTime(raced,t);return raced;
      }
      fail('TRANSFER_RECEIPT_CHALLENGE_CONFLICT');
    }
  }
  async function validateIncomingChallenge({peerAlias,transferId,challenge:input,artifact}={}){
    if(!PEERS.has(peerAlias)||typeof transferId!=='string'||!TRANSFER_ID.test(transferId))
      fail('TRANSFER_RECEIPT_CHALLENGE_REQUEST_INVALID');
    const c=validateChallenge(input,{issuer,audience}),a=validateArtifact(artifact);
    const local=await getLocal(),peer=await getPeer(peerAlias),t=timestamp();
    challengeMatchesIdentity(c,local,peer,peerAlias,'receiver');
    if(c.transferId!==transferId||c.artifactBytes!==a.bytes)
      fail('TRANSFER_RECEIPT_ARTIFACT_MISMATCH');
    checkChallengeTime(c,t);
    const authorization=await authorize({
      action:'receive',peerAlias,transferId,artifactBytes:a.bytes,artifactSha256:a.sha256,
      senderHostId:peer.hostId,senderProfileId:peer.profileId,
      recipientHostId:local.hostId,recipientProfileId:local.profileId,
      senderConsentEpoch:c.senderConsentEpoch
    });
    return Object.freeze({challenge:c,artifact:a,local,peer,recipientConsentEpoch:authorization.consentEpoch});
  }
  async function getIssuedReceipt({peerAlias,transferId,challenge,artifact}={}){
    if(!PEERS.has(peerAlias)||typeof transferId!=='string'||!TRANSFER_ID.test(transferId))
      fail('TRANSFER_RECEIPT_ISSUE_REQUEST_INVALID');
    const c=validateChallenge(challenge,{issuer,audience}),a=validateArtifact(artifact);
    const local=await getLocal(),peer=await getPeer(peerAlias);
    challengeMatchesIdentity(c,local,peer,peerAlias,'receiver');
    if(c.transferId!==transferId||c.artifactBytes!==a.bytes)
      fail('TRANSFER_RECEIPT_ARTIFACT_MISMATCH');
    const previous=readOptional(issuedFile(peerAlias,transferId));
    if(!previous)return null;
    if(previous.schema!==1||typeof previous.receiptDigest!=='string'||!previous.envelope)
      fail('TRANSFER_RECEIPT_ISSUANCE_RECORD_INVALID');
    const existing=validateEnvelope(previous.envelope,{issuer,audience});
    const claims=existing.claims;
    const expectedReceiptId=hash(JSON.stringify([
      DOMAIN,c.senderHostId,c.recipientHostId,transferId,c.nonce,a.bytes,a.sha256
    ]));
    if(previous.receiptDigest!==objectHash(existing)
      ||claims.senderHostId!==c.senderHostId||claims.senderProfileId!==c.senderProfileId
      ||claims.recipientHostId!==c.recipientHostId||claims.recipientProfileId!==c.recipientProfileId
      ||claims.transferId!==transferId||claims.artifactBytes!==a.bytes
      ||claims.artifactSha256!==a.sha256||claims.nonce!==c.nonce
      ||claims.challengeIssuedAtMs!==c.issuedAtMs||claims.challengeExpiresAtMs!==c.expiresAtMs
      ||claims.senderConsentEpoch!==c.senderConsentEpoch||claims.expiresAtMs!==c.expiresAtMs
      ||claims.issuedAtMs<c.issuedAtMs||claims.issuedAtMs>=c.expiresAtMs
      ||claims.receiptId!==expectedReceiptId)
      fail('TRANSFER_RECEIPT_ISSUANCE_CONFLICT');
    return existing;
  }
  async function issueReceipt({peerAlias,transferId,challenge,artifact}={}){
    const existing=await getIssuedReceipt({peerAlias,transferId,challenge,artifact});
    if(existing)return existing;
    const context=await validateIncomingChallenge({peerAlias,transferId,challenge,artifact});
    const {challenge:c,artifact:a,local}=context;
    const t=timestamp();
    if(t>=c.expiresAtMs)fail('TRANSFER_RECEIPT_CHALLENGE_EXPIRED');
    const receiptId=hash(JSON.stringify([
      DOMAIN,c.senderHostId,c.recipientHostId,transferId,c.nonce,a.bytes,a.sha256
    ]));
    const claims=Object.freeze({
      issuer,audience,senderHostId:c.senderHostId,senderProfileId:c.senderProfileId,
      recipientHostId:c.recipientHostId,recipientProfileId:c.recipientProfileId,
      transferId,artifactBytes:a.bytes,artifactSha256:a.sha256,nonce:c.nonce,
      challengeIssuedAtMs:c.issuedAtMs,challengeExpiresAtMs:c.expiresAtMs,
      senderConsentEpoch:c.senderConsentEpoch,recipientConsentEpoch:context.recipientConsentEpoch,
      issuedAtMs:t,expiresAtMs:c.expiresAtMs,receiptId
    });
    const bytes=signedBytes(local.keyId,claims);
    let signature;
    try{signature=await signReceipt(local.keyId,bytes,claims);}
    catch{fail('TRANSFER_RECEIPT_SIGNER_UNAVAILABLE');}
    const sig=signatureBytes(signature);
    if(!verify(null,bytes,local.publicKey,sig))fail('TRANSFER_RECEIPT_LOCAL_SIGNATURE_INVALID');
    const envelope=Object.freeze({schema:1,keyId:local.keyId,claims,signature});
    const digest=objectHash(envelope);
    const file=issuedFile(peerAlias,transferId);
    const record=Object.freeze({schema:1,receiptDigest:digest,envelope});
    try{writeImmutableJson(file,record);return envelope;}
    catch(error){
      if(error.code!=='TRANSFER_RECEIPT_IMMUTABLE_CONFLICT')throw error;
      const raced=await getIssuedReceipt({peerAlias,transferId,challenge,artifact});
      if(raced)return raced;
      fail('TRANSFER_RECEIPT_ISSUANCE_CONFLICT');
    }
  }
  async function verifyReceipt({peerAlias,transferId,challenge:sidecarChallenge,artifact,envelope:input}={}){
    if(!PEERS.has(peerAlias)||typeof transferId!=='string'||!TRANSFER_ID.test(transferId))
      fail('TRANSFER_RECEIPT_VERIFY_REQUEST_INVALID');
    const c=loadChallenge(peerAlias,transferId),a=validateArtifact(artifact);
    if(sidecarChallenge&&stable(validateChallenge(sidecarChallenge,{issuer,audience}))!==stable(c))
      fail('TRANSFER_RECEIPT_CHALLENGE_MISMATCH');
    if(c.transferId!==transferId||c.artifactBytes!==a.bytes)
      fail('TRANSFER_RECEIPT_ARTIFACT_MISMATCH');
    const envelope=validateEnvelope(input,{issuer,audience}),claims=envelope.claims;
    const receiptDigest=objectHash(envelope),nonceHash=hash(nonceBytes(c.nonce));
    const acceptedPath=path.join(ledger,'accepted',nonceHash+'.json');
    const previous=readOptional(acceptedPath);
    if(previous){
      if(previous.schema===1&&previous.receiptDigest===receiptDigest
        &&previous.transferId===transferId&&previous.peerAlias===peerAlias)
        return Object.freeze({
          status:'ACK_VERIFIED',duplicate:true,receiptId:claims.receiptId,
          receiptDigest,acceptedAtMs:previous.acceptedAtMs,
          executionAuthorityGranted:false
        });
      fail('TRANSFER_RECEIPT_REPLAY_CONFLICT');
    }
    const local=await getLocal(),peer=await getPeer(peerAlias),t=timestamp();
    checkChallengeTime(c,t);
    challengeMatchesIdentity(c,local,peer,peerAlias,'sender');
    if(claims.issuer!==issuer||claims.audience!==audience
      ||claims.senderHostId!==c.senderHostId||claims.senderProfileId!==c.senderProfileId
      ||claims.recipientHostId!==c.recipientHostId||claims.recipientProfileId!==c.recipientProfileId
      ||claims.transferId!==transferId||claims.artifactBytes!==a.bytes
      ||claims.artifactSha256!==a.sha256||claims.nonce!==c.nonce
      ||claims.challengeIssuedAtMs!==c.issuedAtMs||claims.challengeExpiresAtMs!==c.expiresAtMs
      ||claims.senderConsentEpoch!==c.senderConsentEpoch
      ||claims.expiresAtMs!==c.expiresAtMs||claims.issuedAtMs<c.issuedAtMs
      ||claims.issuedAtMs>t||claims.expiresAtMs<=t
      ||claims.receiptId!==hash(JSON.stringify([
        DOMAIN,c.senderHostId,c.recipientHostId,transferId,c.nonce,a.bytes,a.sha256
      ])))
      fail('TRANSFER_RECEIPT_SCOPE_MISMATCH');
    const publicKey=peer.publicKeys.get(envelope.keyId);
    if(!publicKey)fail('TRANSFER_RECEIPT_KEY_UNTRUSTED_OR_REVOKED');
    if(!verify(null,signedBytes(envelope.keyId,claims),publicKey,signatureBytes(envelope.signature)))
      fail('TRANSFER_RECEIPT_SIGNATURE_INVALID');
    const authorization=await authorize({
      action:'accept',peerAlias,transferId,artifactBytes:a.bytes,artifactSha256:a.sha256,
      senderHostId:local.hostId,senderProfileId:local.profileId,
      recipientHostId:peer.hostId,recipientProfileId:peer.profileId,
      senderConsentEpoch:c.senderConsentEpoch,recipientConsentEpoch:claims.recipientConsentEpoch
    });
    if(authorization.consentEpoch!==c.senderConsentEpoch)
      fail('TRANSFER_RECEIPT_OWNER_CONSENT_REVOKED');
    const accepted=Object.freeze({
      schema:1,receiptDigest,transferId,peerAlias,nonceHash,
      acceptedAtMs:t,keyId:envelope.keyId,receiptId:claims.receiptId
    });
    let created;
    try{created=writeImmutableJson(acceptedPath,accepted);}
    catch(error){
      if(error.code!=='TRANSFER_RECEIPT_IMMUTABLE_CONFLICT')throw error;
      const raced=readJson(acceptedPath);
      if(raced?.schema!==1||raced.receiptDigest!==receiptDigest
        ||raced.transferId!==transferId||raced.peerAlias!==peerAlias)
        fail('TRANSFER_RECEIPT_REPLAY_CONFLICT');
      created=false;
    }
    if(!created){
      const raced=readJson(acceptedPath);
      if(raced?.schema!==1||raced.receiptDigest!==receiptDigest
        ||raced.transferId!==transferId||raced.peerAlias!==peerAlias)
        fail('TRANSFER_RECEIPT_REPLAY_CONFLICT');
      return Object.freeze({
        status:'ACK_VERIFIED',duplicate:true,receiptId:claims.receiptId,
        receiptDigest,acceptedAtMs:raced.acceptedAtMs,executionAuthorityGranted:false
      });
    }
    return Object.freeze({
      status:'ACK_VERIFIED',duplicate:false,receiptId:claims.receiptId,
      receiptDigest,acceptedAtMs:t,executionAuthorityGranted:false
    });
  }
  return Object.freeze({createChallenge,validateIncomingChallenge,getIssuedReceipt,issueReceipt,verifyReceipt});
}

function sidecarPath(root,peerAlias,kind,transferId){
  if(typeof root!=='string'||!path.isAbsolute(root)||!PEERS.has(peerAlias)
    ||!['challenges','receipts'].includes(kind)||typeof transferId!=='string'||!TRANSFER_ID.test(transferId))
    fail('TRANSFER_RECEIPT_SIDECAR_PATH_INVALID');
  const base=path.resolve(root),dir=path.join(base,'pairs',peerAlias,kind);
  if(!withinPath(dir,base))fail('TRANSFER_RECEIPT_SIDECAR_PATH_INVALID');
  return path.join(dir,transferId+'.json');
}
function withinPath(child,parent){
  const relative=path.relative(parent,child);
  return relative===''||(relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative));
}
export function writeTransferReceiptSidecar(root,peerAlias,kind,transferId,value){
  return writeImmutableJson(sidecarPath(root,peerAlias,kind,transferId),value);
}
export function readTransferReceiptSidecar(root,peerAlias,kind,transferId){
  const file=sidecarPath(root,peerAlias,kind,transferId);
  try{verifyDirectoryExisting(path.dirname(file));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
  return readOptional(file);
}
