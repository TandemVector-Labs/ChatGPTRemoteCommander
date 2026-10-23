import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PEERS = Object.freeze(['PC', 'Linux', 'EmadServer', 'Amirreza']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,90}$/;
const opts = { timeout: 14000, maxBuffer: 131072, windowsHide: true };
const immutable = (name, description, properties, required = [], readOnly = false) => ({
  name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: !readOnly }
});
const peerProperty = { type: 'string', enum: PEERS };
const idProperty = { type: 'string', pattern: ID_PATTERN.source, minLength: 3, maxLength: 91 };

export const transferMeshToolDefinitions = Object.freeze([
  immutable('transfer_mesh_info', 'Read configured local transfer identity, pilot path and available peers. Does not transfer bytes.', {}, [], true),
  immutable('transfer_mesh_send', 'Queue an authorized local file for encrypted pair-specific delivery; never sends file content through chat. Caller must provide an explicit local source path and unique transfer ID. Returns QUEUED, not delivered.', {
    peer: peerProperty, path: {type:'string',minLength:1,maxLength:4096}, id: idProperty
  }, ['peer','path','id']),
  immutable('transfer_mesh_status', 'Check if a previously queued transfer arrived intact at this local node, without accepting the file into the destination.', {
    peer: peerProperty, id: idProperty
  }, ['peer','id'], true),
  immutable('transfer_mesh_receive', 'Hash-verify a received transfer before exclusively materializing its file in an authorized destination directory. Existing destination files are never overwritten.', {
    peer: peerProperty, id: idProperty, dest: {type:'string',minLength:1,maxLength:4096}
  }, ['peer','id','dest'])
]);
const durableNames = Object.freeze([
 immutable('transfer_mesh_enqueue', 'Durably queue a large file for background local staging; returns QUEUED, not delivered or even published to the peer. Use job_status for local progress and transfer_mesh_status on the recipient for full SHA256 receipt.',{
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

export function createTransferMeshTools({ config = {} } = {}) {
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
  const definitions = [...transferMeshToolDefinitions, ...(durableEnabled?durableNames:[])];
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
      if(process.platform==='linux'){
        let capability;
        try{
          capability=JSON.parse(execFileSync(process.execPath,[cli,'source-admission-capabilities'],{
            timeout:5000,maxBuffer:8192,windowsHide:true,env:spawnEnv,encoding:'utf8'
          }).trim());
        }catch{throw new Error('TRANSFER_SOURCE_BACKEND_INCOMPATIBLE');}
        if(capability?.schema!=='ctmesh-source-admission-v1'||
           capability.linuxPinnedRoot!==true||capability.linuxPinnedSource!==true)
          throw new Error('TRANSFER_SOURCE_BACKEND_INCOMPATIBLE');
        const approvedRoot=policy.sourceRoots.map(canonicalExisting).find(p=>within(file,p));
        if(!approvedRoot)throw new Error('TRANSFER_PATH_NOT_ALLOWED');
        const rootStat=fs.lstatSync(approvedRoot,{bigint:true});
        const sourceStat=fs.lstatSync(file,{bigint:true});
        // Recheck the exact source inode admitted to the child; the earlier
        // pathname stat quota check can race with a same-name replacement.
        if(sourceStat.size>BigInt(limits.maxSourceBytes))
          throw new Error('TRANSFER_SOURCE_SIZE_QUOTA');
        if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||
           !sourceStat.isFile()||sourceStat.isSymbolicLink()||sourceStat.nlink!==1n||
           canonicalExisting(file)!==file)
          throw new Error('TRANSFER_SOURCE_IDENTITY_UNSTABLE');
        // Child must recheck the exact root and inode admitted here.
        // The caller's initial realpath check alone does not survive spawn.
        cmd.push('--source-root',approvedRoot,'--root-dev',String(rootStat.dev),
          '--root-ino',String(rootStat.ino),'--source-dev',String(sourceStat.dev),
          '--source-ino',String(sourceStat.ino),'--source-size',String(sourceStat.size),
          '--source-ctime-ns',String(sourceStat.ctimeNs));
      }
    }
    if (name === 'transfer_mesh_status') {
      if (!PEERS.includes(args.peer) || !ID_PATTERN.test(args.id)) throw new Error('TRANSFER_ARGS_INVALID');
      cmd = ['status','--peer',args.peer,'--id',args.id];
    }
    if (name === 'transfer_mesh_receive') {
      if (!PEERS.includes(args.peer) || !ID_PATTERN.test(args.id)) throw new Error('TRANSFER_ARGS_INVALID');
      const dest = allowedPath(args.dest, policy.destinationRoots, 'directory');
      // Bind the exact admitted directory identity across the Core/Pilot spawn.
      // Pilot also pins every ancestor during the write (Windows) or uses a
      // directory descriptor (Linux); this precondition is not the race guard.
      const destStat = fs.lstatSync(dest,{bigint:true});
      if(!destStat.isDirectory()||destStat.isSymbolicLink())
        throw new Error('TRANSFER_DEST_NOT_DIRECTORY');
      cmd = ['receive','--peer',args.peer,'--id',args.id,'--dest',dest,
        '--dest-dev',String(destStat.dev),'--dest-ino',String(destStat.ino)];
    }
    if (name === 'transfer_mesh_enqueue') {
      if (!PEERS.includes(args.peer) || !ID_PATTERN.test(args.id)) throw new Error('TRANSFER_ARGS_INVALID');
      const file=allowedPath(args.path,policy.sourceRoots,'file');
      const allowedRoot=policy.sourceRoots.map(canonicalExisting).find(rootPath=>within(file,rootPath));
      if(!allowedRoot)throw new Error('TRANSFER_PATH_NOT_ALLOWED');
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
    const targetCli=durableEnabled && durableNames.some(t=>t.name===name)?durableCli:cli;
    const { stdout } = await execFileAsync(process.execPath, [targetCli, ...cmd], { ...opts, env: spawnEnv });
    const lines = stdout.trim().split(/\r?\n/);
    const result = JSON.parse(lines.at(-1));
    if (result?.schema && !['ctmesh-v1','ctmesh-durable-v1'].includes(result.schema)) throw new Error('TRANSFER_SCHEMA_UNEXPECTED');
    return result;
  }
  return { enabled:true, definitions: definitions.map(x => ({...x, inputSchema:{...x.inputSchema, properties:{...x.inputSchema.properties}}})), execute };
}
