import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readTransferReceiptSidecar, writeTransferReceiptSidecar } from './transfer-receipts.mjs';

const execFileAsync = promisify(execFile);
const PEERS = Object.freeze(['PC', 'Linux', 'MMZ', 'EmadServer', 'Amirreza']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,90}$/;
const opts = { timeout: 14000, maxBuffer: 131072, windowsHide: true };
const immutable = (name, description, properties, required = [], readOnly = false, destructiveHint = !readOnly, openWorldHint = !readOnly) => ({
  name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: readOnly, destructiveHint, openWorldHint }
});
const peerProperty = { type: 'string', enum: PEERS };
const idProperty = { type: 'string', pattern: ID_PATTERN.source, minLength: 3, maxLength: 91 };

export const transferMeshToolDefinitions = Object.freeze([
  immutable('transfer_mesh_info', 'Read configured local transfer identity, pilot path and available peers. Does not transfer bytes.', {}, [], true),
  immutable('transfer_mesh_send', 'Queue an authorized local file for encrypted pair-specific delivery; never sends file content through chat. Caller must provide an explicit local source path and unique transfer ID. Returns QUEUED, not delivered.', {
    peer: peerProperty, path: {type:'string',minLength:1,maxLength:4096}, id: idProperty
  }, ['peer','path','id']),
  immutable('transfer_mesh_status', 'Check whether a transfer arrived intact at this local node without materializing it. Hash verification only; this is not a recipient-signed ACK.', {
    peer: peerProperty, id: idProperty
  }, ['peer','id'], true),
  immutable('transfer_mesh_receive', 'Hash-verify a received transfer before exclusively materializing its file in an authorized destination directory. Existing destination files are never overwritten.', {
    peer: peerProperty, id: idProperty, dest: {type:'string',minLength:1,maxLength:4096}
  }, ['peer','id','dest'])
]);
const durableNames = Object.freeze([
 immutable('transfer_mesh_enqueue', 'Durably queue a large file for background local staging. QUEUED is local admission only, not remote delivery or ACK. Use job_status for local progress.',{
   peer:peerProperty,path:{type:'string',minLength:1,maxLength:4096},id:idProperty
 },['peer','path','id']),
 immutable('transfer_mesh_job_status','Read local durable staging progress and terminal state (not remote Syncthing delivery).',{peer:peerProperty,id:idProperty},['peer','id'],true),
 immutable('transfer_mesh_job_resume','Resume a failed or interrupted local staging job after rechecking source identity and scope.',{peer:peerProperty,id:idProperty},['peer','id']),
 immutable('transfer_mesh_job_cancel','Request cancellation of unpublished local staging; original source remains unchanged.',{peer:peerProperty,id:idProperty},['peer','id'])
]);

function within(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
function canonicalExisting(p) { return fs.realpathSync.native(path.resolve(p)); }
function allowedPath(target, allow, kind) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('TRANSFER_ABSOLUTE_PATH_REQUIRED');
  if (!Array.isArray(allow) || allow.length === 0) throw new Error('TRANSFER_ALLOWED_ROOTS_MISSING');
  const real = canonicalExisting(target);
  if (!allow.some(root => within(real, canonicalExisting(root)))) throw new Error('TRANSFER_PATH_NOT_ALLOWED');
  const info = fs.lstatSync(target);
  if (info.isSymbolicLink()) throw new Error('TRANSFER_SYMLINK_DENIED');
  if (kind === 'file' && !info.isFile()) throw new Error('TRANSFER_SOURCE_NOT_FILE');
  if (kind === 'directory' && !info.isDirectory()) throw new Error('TRANSFER_DEST_NOT_DIRECTORY');
  return real;
}
function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
}
function receiptDigest(envelope) {
  return createHash('sha256').update(stableJson(envelope)).digest('hex');
}
function readBoundedJson(target, maxBytes = 65536) {
  const directory = path.dirname(target);
  const directoryInfo = fs.lstatSync(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() ||
    path.relative(path.resolve(directory), canonicalExisting(directory)) !== '')
    throw new Error('TRANSFER_RECEIPT_RECORD_PARENT_UNTRUSTED');
  const before = fs.lstatSync(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes)
    throw new Error('TRANSFER_RECEIPT_RECORD_UNTRUSTED');
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const after = fs.fstatSync(fd);
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino ||
      after.size !== before.size || after.nlink !== 1) throw new Error('TRANSFER_RECEIPT_RECORD_CHANGED');
    const bytes = Buffer.alloc(after.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (n <= 0) throw new Error('TRANSFER_RECEIPT_RECORD_TRUNCATED');
      offset += n;
    }
    return JSON.parse(bytes.toString('utf8'));
  } finally { fs.closeSync(fd); }
}

export function createTransferMeshTools({ config = {}, receiptAuthority = null } = {}) {
  const policy = config.transferMesh || {};
  if (policy.enabled !== true || config.powerMode?.enabled !== true) return { enabled: false, definitions: [], execute: async () => { throw new Error('TRANSFER_MESH_DISABLED'); } };
  if (!path.isAbsolute(String(policy.root || ''))) throw new Error('TRANSFER_MESH_ROOT_INVALID');
  const root = canonicalExisting(policy.root);
  const cli = canonicalExisting(path.join(root,'transfer.mjs'));
  const st = fs.lstatSync(cli);
  if (!st.isFile() || st.isSymbolicLink() || !within(cli,root)) throw new Error('TRANSFER_MESH_CLI_INVALID');
  const limits = {
    maxSourceBytes: policy.maxSourceBytes ?? 16 * 1024 ** 3,
    maxPendingBytes: policy.maxPendingBytes ?? 64 * 1024 ** 3,
    maxActiveJobs: policy.maxActiveJobs ?? 3
  };
  for (const [key,value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('TRANSFER_LIMIT_INVALID_' + key);
  }
  if (limits.maxSourceBytes > limits.maxPendingBytes) throw new Error('TRANSFER_LIMIT_INCONSISTENT');
  const durableEnabled = policy.durableEnabled === true;
  const receiptsEnabled = policy.receiptsEnabled === true;
  if (receiptsEnabled && !durableEnabled) throw new Error('TRANSFER_RECEIPTS_REQUIRE_DURABLE');
  if (receiptsEnabled && (!receiptAuthority ||
    !['createChallenge','validateIncomingChallenge','getIssuedReceipt','issueReceipt','verifyReceipt'].every(k => typeof receiptAuthority[k] === 'function')))
    throw new Error('TRANSFER_RECEIPT_AUTHORITY_REQUIRED');
  const durableCli = durableEnabled ? canonicalExisting(path.join(root,'durable-send.mjs')) : null;
  if(durableEnabled && (!within(durableCli,root) || !fs.lstatSync(durableCli).isFile() || fs.lstatSync(durableCli).isSymbolicLink())) throw new Error('TRANSFER_DURABLE_CLI_INVALID');
  if(durableEnabled) {
    // Fail closed on mixed Core / older Portable CLI. Retry transient cold-start process
    // failures once; an explicit unsupported contract is rejected immediately.
    let capabilityVerified = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      let capability;
      try {
        const result = execFileSync(process.execPath, [durableCli, 'capabilities'], {
          timeout: 5000, maxBuffer: 8192, windowsHide: true,
          env: { ...process.env, COMMANDER_TRANSFER_HOME: root }, encoding: 'utf8'
        });
        capability = JSON.parse(result.trim());
      } catch {
        if (attempt === 0) continue;
        throw new Error('TRANSFER_DURABLE_BACKEND_INCOMPATIBLE');
      }
      if (capability.schema !== 'ctmesh-durable-v1' || capability.contractVersion !== 2 ||
        capability.admissionQuotas !== true ||
        !['enqueue', 'job-status', 'resume', 'cancel'].every(n => capability.supports?.includes(n)))
        throw new Error('TRANSFER_DURABLE_BACKEND_INCOMPATIBLE');
      capabilityVerified = true;
      break;
    }
    if (!capabilityVerified) throw new Error('TRANSFER_DURABLE_BACKEND_INCOMPATIBLE');
  }
  const baseDefinitions = receiptsEnabled
    ? transferMeshToolDefinitions.filter(t => t.name !== 'transfer_mesh_send')
    : transferMeshToolDefinitions;
  const receiptNames = receiptsEnabled ? [immutable(
    'transfer_mesh_receipt_verify',
    'Verify the recipient-signed cross-host artifact receipt/ACK. Consumes the one-time nonce in the local receipt ledger; never grants worker or command execution authority.',
    { peer: peerProperty, id: idProperty }, ['peer','id'], false, false, false
  )] : [];
  const definitions = [...baseDefinitions, ...(durableEnabled?durableNames:[]), ...receiptNames];
  const spawnEnv = { ...process.env, COMMANDER_TRANSFER_HOME: root };
  async function execute(name, args = {}) {
    if (!definitions.some(t => t.name === name)) throw new Error('TRANSFER_UNKNOWN_TOOL');
    if (args.peer !== undefined && !PEERS.includes(args.peer)) throw new Error('TRANSFER_UNKNOWN_PEER');
    if (args.id !== undefined && !ID_PATTERN.test(args.id)) throw new Error('TRANSFER_ID_INVALID');
    let cmd;
    if (name === 'transfer_mesh_info') cmd = ['info'];
    if (name === 'transfer_mesh_send') {
      if (!PEERS.includes(args.peer) || !ID_PATTERN.test(args.id)) throw new Error('TRANSFER_ARGS_INVALID');
      const file = allowedPath(args.path, policy.sourceRoots, 'file');
      if (fs.statSync(file).size > limits.maxSourceBytes) throw new Error('TRANSFER_SOURCE_SIZE_QUOTA');
      cmd = ['send','--peer',args.peer,'--path',file,'--id',args.id];
    }
    if (name === 'transfer_mesh_status') {
      if (!PEERS.includes(args.peer) || !ID_PATTERN.test(args.id)) throw new Error('TRANSFER_ARGS_INVALID');
      cmd = ['status','--peer',args.peer,'--id',args.id];
    }
    if (name === 'transfer_mesh_receive') {
      if (!PEERS.includes(args.peer) || !ID_PATTERN.test(args.id)) throw new Error('TRANSFER_ARGS_INVALID');
      const dest = allowedPath(args.dest, policy.destinationRoots, 'directory');
      if (receiptsEnabled) {
        const challenge = readTransferReceiptSidecar(root, args.peer, 'challenges', args.id);
        if (!challenge) throw new Error('TRANSFER_RECEIPT_CHALLENGE_MISSING');
        const manifestPath = path.join(root,'pairs',args.peer,'transfers',args.id,'manifest.json');
        if (!within(manifestPath,root)) throw new Error('TRANSFER_RECEIPT_MANIFEST_PATH_INVALID');
        const manifest = readBoundedJson(manifestPath, 32768);
        if (manifest.schema !== 'ctmesh-v1' || manifest.id !== args.id || manifest.from !== args.peer ||
          manifest.to !== challenge.recipientAlias || !Number.isSafeInteger(manifest.bytes) ||
          typeof manifest.sha256 !== 'string') throw new Error('TRANSFER_RECEIPT_MANIFEST_INVALID');
        const artifact = { bytes: manifest.bytes, sha256: manifest.sha256 };
        const existingIssued = await receiptAuthority.getIssuedReceipt({
          peerAlias: args.peer, transferId: args.id, challenge, artifact
        });
        if (existingIssued) {
          const existingSidecar = readTransferReceiptSidecar(root,args.peer,'receipts',args.id);
          if (existingSidecar && receiptDigest(existingSidecar) !== receiptDigest(existingIssued))
            throw new Error('TRANSFER_RECEIPT_SIDECAR_CONFLICT');
          if (!existingSidecar) writeTransferReceiptSidecar(root,args.peer,'receipts',args.id,existingIssued);
          return {
            schema:'ctmesh-v1',status:'ALREADY_ACKED',id:args.id,bytes:manifest.bytes,sha256:manifest.sha256,
            receiptStatus:'SIGNED_RECEIPT_ISSUED',receiptId:existingIssued.claims.receiptId,
            receiptDigest:receiptDigest(existingIssued),executionAuthorityGranted:false
          };
        }
        await receiptAuthority.validateIncomingChallenge({
          peerAlias: args.peer, transferId: args.id, challenge, artifact
        });
      }
      cmd = ['receive','--peer',args.peer,'--id',args.id,'--dest',dest];
    }
    if (name === 'transfer_mesh_enqueue') {
      if (!PEERS.includes(args.peer) || !ID_PATTERN.test(args.id)) throw new Error('TRANSFER_ARGS_INVALID');
      const file=allowedPath(args.path,policy.sourceRoots,'file');
      const allowedRoot=policy.sourceRoots.map(canonicalExisting).find(rootPath=>within(file,rootPath));
      if(!allowedRoot)throw new Error('TRANSFER_PATH_NOT_ALLOWED');
      if (receiptsEnabled) {
        const challenge = await receiptAuthority.createChallenge({peerAlias:args.peer,transferId:args.id,bytes:fs.statSync(file).size});
        writeTransferReceiptSidecar(root,args.peer,'challenges',args.id,challenge);
      }
      cmd=['enqueue','--peer',args.peer,'--path',file,'--source-root',allowedRoot,'--id',args.id,
        '--max-source-bytes',String(limits.maxSourceBytes),'--max-pending-bytes',String(limits.maxPendingBytes),
        '--max-active-jobs',String(limits.maxActiveJobs)];
    }
    if (name === 'transfer_mesh_job_status') {
      if (!PEERS.includes(args.peer) || !ID_PATTERN.test(args.id)) throw new Error('TRANSFER_ARGS_INVALID');
      cmd=['job-status','--peer',args.peer,'--id',args.id];
    }
    if (name === 'transfer_mesh_job_resume') {
      if (!PEERS.includes(args.peer) || !ID_PATTERN.test(args.id)) throw new Error('TRANSFER_ARGS_INVALID');
      const jobPath=path.join(root,'jobs',args.peer,args.id+'.json');
      const jobStat=fs.lstatSync(jobPath);
      if(!jobStat.isFile() || jobStat.isSymbolicLink())throw new Error('TRANSFER_JOB_NOT_REGULAR');
      const job=JSON.parse(fs.readFileSync(jobPath,'utf8'));
      if(job.id!==args.id || job.peer!==args.peer)throw new Error('TRANSFER_JOB_IDENTITY_INVALID');
      allowedPath(job.path,policy.sourceRoots,'file');
      cmd=['resume','--peer',args.peer,'--id',args.id];
    }
    if (name === 'transfer_mesh_job_cancel') {
      if (!PEERS.includes(args.peer) || !ID_PATTERN.test(args.id)) throw new Error('TRANSFER_ARGS_INVALID');
      cmd=['cancel','--peer',args.peer,'--id',args.id];
    }
    if (name === 'transfer_mesh_receipt_verify') {
      if (!receiptsEnabled || !PEERS.includes(args.peer) || !ID_PATTERN.test(args.id)) throw new Error('TRANSFER_ARGS_INVALID');
      const jobPath=path.join(root,'jobs',args.peer,args.id+'.json');
      if (!within(jobPath,root)) throw new Error('TRANSFER_JOB_PATH_INVALID');
      const job=readBoundedJson(jobPath,65536);
      if (job.id!==args.id || job.peer!==args.peer) throw new Error('TRANSFER_JOB_IDENTITY_INVALID');
      if (job.status!=='PUBLISHED') return {schema:'ctmesh-receipt-v1',status:'PENDING',id:args.id,peer:args.peer,reason:'SOURCE_NOT_PUBLISHED',executionAuthorityGranted:false};
      if (!Number.isSafeInteger(job.bytes) || typeof job.sha256!=='string' || !/^[a-f0-9]{64}$/.test(job.sha256))
        throw new Error('TRANSFER_SOURCE_JOB_ARTIFACT_INVALID');
      const challenge=readTransferReceiptSidecar(root,args.peer,'challenges',args.id);
      if (!challenge) throw new Error('TRANSFER_RECEIPT_CHALLENGE_MISSING');
      const envelope=readTransferReceiptSidecar(root,args.peer,'receipts',args.id);
      if (!envelope) return {schema:'ctmesh-receipt-v1',status:'PENDING',id:args.id,peer:args.peer,reason:'SIGNED_RECEIPT_NOT_SYNCED',executionAuthorityGranted:false};
      return await receiptAuthority.verifyReceipt({peerAlias:args.peer,transferId:args.id,challenge,
        artifact:{bytes:job.bytes,sha256:job.sha256},envelope});
    }
    const targetCli=durableEnabled && durableNames.some(t=>t.name===name)?durableCli:cli;
    const { stdout } = await execFileAsync(process.execPath, [targetCli, ...cmd], { ...opts, env: spawnEnv });
    const lines = stdout.trim().split(/\r?\n/);
    let result = JSON.parse(lines.at(-1));
    if (result?.schema && !['ctmesh-v1','ctmesh-durable-v1'].includes(result.schema)) throw new Error('TRANSFER_SCHEMA_UNEXPECTED');
    if (name === 'transfer_mesh_receive' && receiptsEnabled) {
      if (result.status!=='DELIVERED_HASH_VERIFIED' || result.id!==args.id ||
        result.bytes===undefined || result.sha256===undefined) throw new Error('TRANSFER_RECEIPT_RECEIVE_NOT_VERIFIED');
      const manifest=readBoundedJson(path.join(root,'pairs',args.peer,'transfers',args.id,'manifest.json'),32768);
      if (result.bytes!==manifest.bytes || result.sha256!==manifest.sha256) throw new Error('TRANSFER_RECEIPT_ARTIFACT_MISMATCH');
      const challenge=readTransferReceiptSidecar(root,args.peer,'challenges',args.id);
      const envelope=await receiptAuthority.issueReceipt({peerAlias:args.peer,transferId:args.id,challenge,
        artifact:{bytes:manifest.bytes,sha256:manifest.sha256}});
      writeTransferReceiptSidecar(root,args.peer,'receipts',args.id,envelope);
      result={...result,receiptStatus:'SIGNED_RECEIPT_ISSUED',receiptId:envelope.claims.receiptId,
        receiptDigest:receiptDigest(envelope),executionAuthorityGranted:false};
    }
    if (name === 'transfer_mesh_enqueue' && receiptsEnabled) {
      const challenge=readTransferReceiptSidecar(root,args.peer,'challenges',args.id);
      result={...result,receiptRequired:true,receiptExpiresAtMs:challenge.expiresAtMs,executionAuthorityGranted:false};
    }
    if (name === 'transfer_mesh_info') result={...result,receiptsEnabled};
    return result;
  }
  const renderedDefinitions=definitions.map(x=>({
    ...x,
    description:receiptsEnabled&&x.name==='transfer_mesh_receive'
      ? x.description+' A recipient-signed receipt is issued only after the artifact hash is verified.'
      : receiptsEnabled&&x.name==='transfer_mesh_enqueue'
        ? x.description+' A one-time challenge is recorded; after the recipient issues its signed receipt, verify it with transfer_mesh_receipt_verify.'
        : x.description,
    inputSchema:{...x.inputSchema,properties:{...x.inputSchema.properties}}
  }));
  return { enabled:true, receiptsEnabled, definitions:renderedDefinitions, execute };
}
