// V2-G1: one durable, default-deny Commander access registry for a host.
// Candidate-only; NOT exposed to legacy unauthenticated MCP tools.
// The owning system service must provision restrictive OS ACLs on the directory
// and supply authenticated administrator callbacks before any production activation.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { isProxy } from 'node:util/types';
import { normalizeV2Route } from './v2-routing-contract.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOOL = /^(?=.{1,80}$)[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const ALLOWED = new Set(['ENABLED', 'REVOKED']);
const WORKER_STATUSES = new Set(['ACTIVE', 'REVOKED']);
const WORKER_ID = /^cw_[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const BINDING = /^[a-f0-9]{32,64}$/;
const WORKER_CONTEXT_FIELDS = Object.freeze([
  'hostId','profileId','principalId','conversationId','bindingId','workerId',
  'keyId','ownerSidHash','deviceProvider','deviceIdHash','tunnelProvider',
  'tunnelIdHash','capabilityPolicyDigest'
]);
const MAX_WORKER_GRANT_TTL_MS = 86_400_000;
function exactRecord(value, fields, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) fail(code);
  const out = Object.create(null);
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) fail(code);
    out[key] = descriptor.value;
  }
  return out;
}
function workerContextOf(value) {
  const c = exactRecord(value, WORKER_CONTEXT_FIELDS, 'V2_WORKER_GRANT_IDENTITY_INVALID');
  for (const key of ['hostId','profileId','principalId','conversationId']) {
    if (typeof c[key] !== 'string' || !ID.test(c[key]) || c[key] === '.' || c[key] === '..')
      fail('V2_WORKER_GRANT_IDENTITY_INVALID');
  }
  if (typeof c.bindingId !== 'string' || !BINDING.test(c.bindingId)
    || typeof c.workerId !== 'string' || !WORKER_ID.test(c.workerId)
    || typeof c.keyId !== 'string' || !HASH.test(c.keyId)
    || typeof c.ownerSidHash !== 'string' || !HASH.test(c.ownerSidHash)
    || typeof c.deviceProvider !== 'string' || !['tailscale','native-key-store'].includes(c.deviceProvider)
    || typeof c.deviceIdHash !== 'string' || !HASH.test(c.deviceIdHash)
    || c.tunnelProvider !== 'openai-secure-mcp-tunnel'
    || typeof c.tunnelIdHash !== 'string' || !HASH.test(c.tunnelIdHash)
    || typeof c.capabilityPolicyDigest !== 'string' || !HASH.test(c.capabilityPolicyDigest))
    fail('V2_WORKER_GRANT_IDENTITY_INVALID');
  return Object.freeze(c);
}
function routeMatchesWorker(route, context) {
  if (route.hostId !== context.hostId || route.principalId !== context.principalId
    || route.profileId !== context.profileId || route.conversationId !== context.conversationId)
    fail('V2_WORKER_GRANT_ROUTE_MISMATCH');
}
function workerStableMatches(row, c) {
  return row.host === c.hostId && row.principal === c.principalId
    && row.profile === c.profileId && row.conversation === c.conversationId
    && row.worker_id === c.workerId && row.key_id === c.keyId
    && row.owner_sid_hash === c.ownerSidHash
    && row.device_provider === c.deviceProvider && row.device_id_hash === c.deviceIdHash;
}
function workerExactMatches(row, c) {
  return workerStableMatches(row, c) && row.binding_id === c.bindingId
    && row.tunnel_provider === c.tunnelProvider && row.tunnel_id_hash === c.tunnelIdHash
    && row.capability_policy_digest === c.capabilityPolicyDigest;
}
function workerToolScope(route,tool) {
  const r=normalizeV2Route(route);
  const base=scopeOf(r,tool);
  return [base[0],base[1],base[2],base[3],r.operationId,...base.slice(4)];
}
function workerColumns(c) {
  return [c.hostId,c.principalId,c.profileId,c.conversationId,c.workerId,c.keyId,
    c.ownerSidHash,c.deviceProvider,c.deviceIdHash,c.tunnelProvider,c.tunnelIdHash,
    c.capabilityPolicyDigest,c.bindingId];
}
function ownerGrantMatchesContext(g,c) {
  return !!g&&g.hostId===c.hostId&&g.profileId===c.profileId
    &&g.principalId===c.principalId&&g.conversationId===c.conversationId
    &&g.bindingId===c.bindingId&&g.workerId===c.workerId&&g.keyId===c.keyId
    &&g.ownerSidHash===c.ownerSidHash&&g.deviceProvider===c.deviceProvider
    &&g.deviceIdHash===c.deviceIdHash&&g.tunnelProvider===c.tunnelProvider
    &&g.tunnelIdHash===c.tunnelIdHash
    &&g.capabilityPolicyDigest===c.capabilityPolicyDigest;
}
function toWorkerGrant(row) {
  return row ? Object.freeze({
    source:'native-owner-attested',hostId:row.host,profileId:row.profile,
    principalId:row.principal,conversationId:row.conversation,bindingId:row.binding_id,
    workerId:row.worker_id,keyId:row.key_id,ownerSidHash:row.owner_sid_hash,
    deviceProvider:row.device_provider,deviceIdHash:row.device_id_hash,
    tunnelProvider:row.tunnel_provider,tunnelIdHash:row.tunnel_id_hash,
    capabilityPolicyDigest:row.capability_policy_digest,revision:Number(row.revision),
    issuedAtMs:Number(row.issued_at_ms),expiresAtMs:Number(row.expires_at_ms),status:row.status
  }) : null;
}
function toWorkerToolGrant(row) {
  return row ? Object.freeze({
    status:row.status,revision:Number(row.revision),bindingId:row.binding_id,
    expiresAtMs:Number(row.expires_at_ms),actor:row.actor,updatedAt:row.updated_at
  }) : null;
}
function fail(code) { throw Object.assign(new Error(code), { code }); }
function safeId(value) {
  if (typeof value !== 'string' || !ID.test(value) || value === '.' || value === '..') fail('V2_GRANT_IDENTIFIER_INVALID');
  return value;
}
function assertPrivatePath(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || /^(?:\\\\|\/\/)/.test(directory)) fail('V2_GRANT_ABSOLUTE_DIRECTORY_REQUIRED');
  const full = path.resolve(directory);
  let cursor = path.parse(full).root;
  for (const part of full.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor)) {
      const info = fs.lstatSync(cursor);
      if (info.isSymbolicLink()) fail('V2_GRANT_ALIAS_NOT_ALLOWED');
    }
  }
  fs.mkdirSync(full, { recursive: true, mode: 0o700 });
  return fs.realpathSync.native(full);
}
function scopeOf(route, tool) {
  const r = normalizeV2Route(route);
  if (typeof tool !== 'string' || !TOOL.test(tool)) fail('V2_GRANT_TOOL_INVALID');
  return [r.hostId, r.principalId, r.profileId, r.conversationId, r.target.kind, r.target.id, tool];
}
function toGrant(row) {
  return row ? Object.freeze({
    status: row.status, revision: Number(row.revision), actor: row.actor,
    updatedAt: row.updated_at
  }) : null;
}
export class V2GrantRegistry {
  constructor({ directory, authorizeAdministration, now = Date.now }) {
    if (typeof authorizeAdministration !== 'function' || typeof now !== 'function') fail('V2_GRANT_ADMIN_PROVIDER_REQUIRED');
    this.authorizeAdministration = authorizeAdministration;
    this.now = now;
    this.directory = assertPrivatePath(directory);
    this.location = path.join(this.directory, 'v2-access.sqlite');
    // SQLite may delete a transient rollback journal between an existence probe
    // and lstat while another process commits. A single no-entry-tolerant lstat
    // preserves fail-closed validation for entries that are actually present.
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const info = fs.lstatSync(this.location + suffix, { throwIfNoEntry: false });
      if (!info) continue;
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('V2_GRANT_ALIAS_NOT_ALLOWED');
    }
    this.db = new DatabaseSync(this.location, { allowExtension: false });
    try { fs.chmodSync(this.location, 0o600); } catch { /* Windows owner ACLs are a separate deployment gate */ }
    this.db.exec('PRAGMA busy_timeout=3000; PRAGMA trusted_schema=OFF; PRAGMA synchronous=EXTRA;');
    if (this.db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') fail('V2_GRANT_JOURNAL_MODE');
    const version=this.db.prepare('PRAGMA user_version').get().user_version;
    if(version===1){this.db.close();fail('V2_GRANT_SCHEMA_MIGRATION_REQUIRED');}
    if(version>3){this.db.close();fail('V2_GRANT_SCHEMA_TOO_NEW');}
    try { this.db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS v2_grants (
      host TEXT NOT NULL, principal TEXT NOT NULL, profile TEXT NOT NULL,
      conversation TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, tool TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ENABLED','REVOKED')),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      actor TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(host,principal,profile,conversation,kind,target,tool)
    );
    CREATE TABLE IF NOT EXISTS v2_grant_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,host TEXT NOT NULL,principal TEXT NOT NULL,profile TEXT NOT NULL,
      conversation TEXT NOT NULL,kind TEXT NOT NULL,target TEXT NOT NULL,tool TEXT NOT NULL,from_status TEXT,
      to_status TEXT NOT NULL,revision INTEGER NOT NULL,actor TEXT NOT NULL,reason TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS v2_worker_grants (
      host TEXT NOT NULL,principal TEXT NOT NULL,profile TEXT NOT NULL,conversation TEXT NOT NULL,
      worker_id TEXT NOT NULL,key_id TEXT NOT NULL,owner_sid_hash TEXT NOT NULL,
      device_provider TEXT NOT NULL,device_id_hash TEXT NOT NULL,tunnel_provider TEXT NOT NULL,
      tunnel_id_hash TEXT NOT NULL,capability_policy_digest TEXT NOT NULL,binding_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('ACTIVE','REVOKED')),
      revision INTEGER NOT NULL CHECK(revision >= 1),issued_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,actor TEXT NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY(host,principal,profile,conversation,worker_id)
    );
    CREATE TABLE IF NOT EXISTS v2_worker_grant_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,host TEXT NOT NULL,principal TEXT NOT NULL,
      profile TEXT NOT NULL,conversation TEXT NOT NULL,worker_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('ACTIVE','REVOKED')),
      revision INTEGER NOT NULL,issued_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,
      actor TEXT NOT NULL,reason TEXT NOT NULL,occurred_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS v2_worker_tool_grants (
      host TEXT NOT NULL,principal TEXT NOT NULL,profile TEXT NOT NULL,conversation TEXT NOT NULL,
      operation_id TEXT NOT NULL,kind TEXT NOT NULL,target TEXT NOT NULL,tool TEXT NOT NULL,worker_id TEXT NOT NULL,
      key_id TEXT NOT NULL,owner_sid_hash TEXT NOT NULL,device_provider TEXT NOT NULL,
      device_id_hash TEXT NOT NULL,tunnel_provider TEXT NOT NULL,tunnel_id_hash TEXT NOT NULL,
      capability_policy_digest TEXT NOT NULL,binding_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('ENABLED','REVOKED')),
      revision INTEGER NOT NULL CHECK(revision >= 1),issued_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,actor TEXT NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY(host,principal,profile,conversation,operation_id,kind,target,tool,worker_id)
    );
    CREATE TABLE IF NOT EXISTS v2_worker_tool_grant_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,host TEXT NOT NULL,principal TEXT NOT NULL,
      profile TEXT NOT NULL,conversation TEXT NOT NULL,operation_id TEXT NOT NULL,
      kind TEXT NOT NULL,target TEXT NOT NULL,tool TEXT NOT NULL,worker_id TEXT NOT NULL,binding_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('ENABLED','REVOKED')),
      revision INTEGER NOT NULL,issued_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,
      actor TEXT NOT NULL,reason TEXT NOT NULL,occurred_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS v2_worker_grant_events_no_update
      BEFORE UPDATE ON v2_worker_grant_events BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS v2_worker_grant_events_no_delete
      BEFORE DELETE ON v2_worker_grant_events BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS v2_worker_tool_grant_events_no_update
      BEFORE UPDATE ON v2_worker_tool_grant_events BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS v2_worker_tool_grant_events_no_delete
      BEFORE DELETE ON v2_worker_tool_grant_events BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;
    PRAGMA user_version=3;
    COMMIT;`); } catch(error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      try { this.db.close(); } catch {}
      throw error;
    }
  }
  read(route, tool) {
    const s = scopeOf(route, tool);
    const row = this.db.prepare(`SELECT status,revision,actor,updated_at FROM v2_grants
      WHERE host=? AND principal=? AND profile=? AND conversation=? AND kind=? AND target=? AND tool=?`).get(...s);
    return toGrant(row);
  }
  isAllowed(route, tool) { return this.read(route, tool)?.status === 'ENABLED'; }
  /**
   * Only a verified owner/admin worker may call this. Authority comes from an
   * injected trusted principal/session provider, not actor strings or OS admin
   * membership inferred from a Commander FULL_POWER profile.
   */
  async change({ route, tool, status, expectedRevision, actor, reason }) {
    const scope = scopeOf(route, tool);
    if (!ALLOWED.has(status)) fail('V2_GRANT_STATUS_INVALID');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('V2_GRANT_EXPECTED_REVISION_REQUIRED');
    safeId(actor);
    if (typeof reason !== 'string' || reason.trim().length < 5 || reason.length > 400) fail('V2_GRANT_REASON_REQUIRED');
    if (await this.authorizeAdministration({ actor, route, tool, status }) !== true) fail('V2_GRANT_ADMIN_AUTH_REQUIRED');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare(`SELECT status,revision FROM v2_grants WHERE host=? AND principal=?
        AND profile=? AND conversation=? AND kind=? AND target=? AND tool=?`).get(...scope);
      const revision = current ? Number(current.revision) : 0;
      if (revision !== expectedRevision) fail('V2_GRANT_REVISION_CONFLICT');
      if (!current && status === 'REVOKED') fail('V2_GRANT_NOT_FOUND');
      if (current?.status === status) { this.db.exec('COMMIT'); return this.read(route, tool); }
      const next = revision + 1;
      const stamp = new Date().toISOString();
      this.db.prepare(`INSERT INTO v2_grants(host,principal,profile,conversation,kind,target,tool,status,revision,actor,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(host,principal,profile,conversation,kind,target,tool)
        DO UPDATE SET status=excluded.status,revision=excluded.revision,actor=excluded.actor,updated_at=excluded.updated_at`)
        .run(...scope, status, next, actor, stamp);
      this.db.prepare(`INSERT INTO v2_grant_events
        (host,principal,profile,conversation,kind,target,tool,from_status,to_status,revision,actor,reason,occurred_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(...scope, current?.status ?? null, status, next, actor, reason.trim(), stamp);
      this.db.exec('COMMIT');
      return this.read(route, tool);
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
  readWorkerGrant(workerContext) {
    const c=workerContextOf(workerContext);
    const row=this.db.prepare('SELECT * FROM v2_worker_grants WHERE host=? AND principal=? AND profile=? AND conversation=? AND worker_id=?')
      .get(c.hostId,c.principalId,c.profileId,c.conversationId,c.workerId);
    return toWorkerGrant(row);
  }
  async changeWorkerGrant({workerContext,status,expectedRevision,actor,reason,expiresAtMs}) {
    const c=workerContextOf(workerContext);
    if(!WORKER_STATUSES.has(status))fail('V2_WORKER_GRANT_STATUS_INVALID');
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)
      fail('V2_WORKER_GRANT_EXPECTED_REVISION_REQUIRED');
    safeId(actor);
    if(typeof reason!=='string'||reason.trim().length<5||reason.length>400)
      fail('V2_WORKER_GRANT_REASON_REQUIRED');
    const now=this.now();
    if(!Number.isSafeInteger(now)||now<0)fail('V2_WORKER_GRANT_CLOCK_INVALID');
    if(status==='ACTIVE'&&(!Number.isSafeInteger(expiresAtMs)||expiresAtMs<=now
      ||expiresAtMs-now>MAX_WORKER_GRANT_TTL_MS))
      fail('V2_WORKER_GRANT_EXPIRY_INVALID');
    if(await this.authorizeAdministration({
      kind:'worker-enrollment-grant',action:status,status,actor,workerContext:c,
      reason:reason.trim(),expiresAtMs:status==='ACTIVE'?expiresAtMs:null
    })!==true)fail('V2_WORKER_GRANT_ADMIN_AUTH_REQUIRED');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current=this.db.prepare('SELECT * FROM v2_worker_grants WHERE host=? AND principal=? AND profile=? AND conversation=? AND worker_id=?')
        .get(c.hostId,c.principalId,c.profileId,c.conversationId,c.workerId);
      const revision=current?Number(current.revision):0;
      if(revision!==expectedRevision)fail('V2_WORKER_GRANT_REVISION_CONFLICT');
      if(!current&&status==='REVOKED')fail('V2_WORKER_GRANT_NOT_FOUND');
      if(current&&!workerStableMatches(current,c))
        fail('V2_WORKER_GRANT_WORKER_IDENTITY_CHANGED');
      if(current&&current.status===status&&workerExactMatches(current,c)
        &&(status==='REVOKED'||Number(current.expires_at_ms)===expiresAtMs)){
        this.db.exec('COMMIT');return this.readWorkerGrant(c);
      }
      if(status==='ACTIVE'&&current){
        const currentActive=current.status==='ACTIVE'&&Number(current.expires_at_ms)>now;
        if(currentActive)fail('V2_WORKER_GRANT_ACTIVE_EPOCH_CONFLICT');
        if(current.binding_id===c.bindingId)fail('V2_WORKER_GRANT_EPOCH_REUSE');
      }
      if(status==='REVOKED'&&(!current||current.status!=='ACTIVE'
        ||!workerExactMatches(current,c)))fail('V2_WORKER_GRANT_NOT_ACTIVE');
      const next=revision+1;
      const issued=status==='ACTIVE'?now:Number(current.issued_at_ms);
      const expiry=status==='ACTIVE'?expiresAtMs:Number(current.expires_at_ms);
      const stamp=new Date(now).toISOString();
      this.db.prepare('INSERT INTO v2_worker_grants '+
        '(host,principal,profile,conversation,worker_id,key_id,owner_sid_hash,device_provider,'+
        'device_id_hash,tunnel_provider,tunnel_id_hash,capability_policy_digest,binding_id,'+
        'status,revision,issued_at_ms,expires_at_ms,actor,updated_at) '+
        'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) '+
        'ON CONFLICT(host,principal,profile,conversation,worker_id) DO UPDATE SET '+
        'key_id=excluded.key_id,owner_sid_hash=excluded.owner_sid_hash,'+
        'device_provider=excluded.device_provider,device_id_hash=excluded.device_id_hash,'+
        'tunnel_provider=excluded.tunnel_provider,tunnel_id_hash=excluded.tunnel_id_hash,'+
        'capability_policy_digest=excluded.capability_policy_digest,binding_id=excluded.binding_id,'+
        'status=excluded.status,revision=excluded.revision,issued_at_ms=excluded.issued_at_ms,'+
        'expires_at_ms=excluded.expires_at_ms,actor=excluded.actor,updated_at=excluded.updated_at')
        .run(...workerColumns(c),status,next,issued,expiry,actor,stamp);
      this.db.prepare('INSERT INTO v2_worker_grant_events '+
        '(host,principal,profile,conversation,worker_id,binding_id,status,revision,'+
        'issued_at_ms,expires_at_ms,actor,reason,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(c.hostId,c.principalId,c.profileId,c.conversationId,c.workerId,c.bindingId,
          status,next,issued,expiry,actor,reason.trim(),stamp);
      this.db.exec('COMMIT');
      return this.readWorkerGrant(c);
    } catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
  }
  workerGrantEvents(workerContext) {
    const c=workerContextOf(workerContext);
    return this.db.prepare('SELECT seq,binding_id AS bindingId,status,revision,'+
      'issued_at_ms AS issuedAtMs,expires_at_ms AS expiresAtMs,actor,reason,'+
      'occurred_at AS occurredAt FROM v2_worker_grant_events '+
      'WHERE host=? AND principal=? AND profile=? AND conversation=? AND worker_id=? ORDER BY seq')
      .all(c.hostId,c.principalId,c.profileId,c.conversationId,c.workerId);
  }
  readWorkerToolGrant(route,workerContext,tool) {
    const c=workerContextOf(workerContext);
    const r=normalizeV2Route(route);routeMatchesWorker(r,c);
    const scope=workerToolScope(r,tool);
    const row=this.db.prepare('SELECT status,revision,binding_id,expires_at_ms,actor,updated_at '+
      'FROM v2_worker_tool_grants WHERE host=? AND principal=? AND profile=? AND conversation=? '+
      'AND operation_id=? AND kind=? AND target=? AND tool=? AND worker_id=?').get(...scope,c.workerId);
    return toWorkerToolGrant(row);
  }
  async changeWorkerToolGrant({route,workerContext,tool,status,expectedRevision,actor,reason,expiresAtMs}) {
    const c=workerContextOf(workerContext);
    const r=normalizeV2Route(route);routeMatchesWorker(r,c);
    const scope=workerToolScope(r,tool);
    if(!ALLOWED.has(status))fail('V2_WORKER_TOOL_GRANT_STATUS_INVALID');
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)
      fail('V2_WORKER_TOOL_GRANT_EXPECTED_REVISION_REQUIRED');
    safeId(actor);
    if(typeof reason!=='string'||reason.trim().length<5||reason.length>400)
      fail('V2_WORKER_TOOL_GRANT_REASON_REQUIRED');
    const now=this.now();
    if(!Number.isSafeInteger(now)||now<0)fail('V2_WORKER_GRANT_CLOCK_INVALID');
    const enrollment=this.readWorkerGrant(c);
    if(!enrollment||enrollment.status!=='ACTIVE'||!ownerGrantMatchesContext(enrollment,c)
      ||enrollment.expiresAtMs<=now)fail('V2_WORKER_GRANT_NOT_ACTIVE');
    if(status==='ENABLED'&&(!Number.isSafeInteger(expiresAtMs)||expiresAtMs<=now
      ||expiresAtMs>enrollment.expiresAtMs))
      fail('V2_WORKER_TOOL_GRANT_EXPIRY_INVALID');
    if(await this.authorizeAdministration({
      kind:'worker-tool-grant',action:status,status,actor,route:r,tool,
      workerContext:c,reason:reason.trim(),expiresAtMs:status==='ENABLED'?expiresAtMs:null
    })!==true)fail('V2_WORKER_TOOL_GRANT_ADMIN_AUTH_REQUIRED');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current=this.db.prepare('SELECT * FROM v2_worker_tool_grants '+
        'WHERE host=? AND principal=? AND profile=? AND conversation=? AND operation_id=? AND kind=? '+
        'AND target=? AND tool=? AND worker_id=?').get(...scope,c.workerId);
      const revision=current?Number(current.revision):0;
      if(revision!==expectedRevision)fail('V2_WORKER_TOOL_GRANT_REVISION_CONFLICT');
      if(!current&&status==='REVOKED')fail('V2_WORKER_TOOL_GRANT_NOT_FOUND');
      if(current&&!workerStableMatches(current,c))fail('V2_WORKER_TOOL_GRANT_IDENTITY_CHANGED');
      if(current&&current.status===status&&workerExactMatches(current,c)
        &&(status==='REVOKED'||Number(current.expires_at_ms)===expiresAtMs)){
        this.db.exec('COMMIT');return this.readWorkerToolGrant(r,c,tool);
      }
      if(status==='REVOKED'&&(!current||current.status!=='ENABLED'
        ||!workerExactMatches(current,c)))fail('V2_WORKER_TOOL_GRANT_NOT_ACTIVE');
      if(status==='ENABLED'&&current&&current.status==='ENABLED'
        &&current.binding_id!==c.bindingId&&Number(current.expires_at_ms)>now)
        fail('V2_WORKER_TOOL_GRANT_ACTIVE_EPOCH_CONFLICT');
      const next=revision+1,issued=status==='ENABLED'?now:Number(current?.issued_at_ms??now);
      const expiry=status==='ENABLED'?expiresAtMs:Number(current?.expires_at_ms??expiresAtMs??now);
      const stamp=new Date(now).toISOString();
      this.db.prepare('INSERT INTO v2_worker_tool_grants '+
        '(host,principal,profile,conversation,operation_id,kind,target,tool,worker_id,key_id,owner_sid_hash,'+
        'device_provider,device_id_hash,tunnel_provider,tunnel_id_hash,capability_policy_digest,'+
        'binding_id,status,revision,issued_at_ms,expires_at_ms,actor,updated_at) '+
        'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) '+
        'ON CONFLICT(host,principal,profile,conversation,operation_id,kind,target,tool,worker_id) DO UPDATE SET '+
        'key_id=excluded.key_id,owner_sid_hash=excluded.owner_sid_hash,'+
        'device_provider=excluded.device_provider,device_id_hash=excluded.device_id_hash,'+
        'tunnel_provider=excluded.tunnel_provider,tunnel_id_hash=excluded.tunnel_id_hash,'+
        'capability_policy_digest=excluded.capability_policy_digest,binding_id=excluded.binding_id,'+
        'status=excluded.status,revision=excluded.revision,issued_at_ms=excluded.issued_at_ms,'+
        'expires_at_ms=excluded.expires_at_ms,actor=excluded.actor,updated_at=excluded.updated_at')
        .run(...scope,c.workerId,c.keyId,c.ownerSidHash,c.deviceProvider,c.deviceIdHash,
          c.tunnelProvider,c.tunnelIdHash,c.capabilityPolicyDigest,c.bindingId,status,
          next,issued,expiry,actor,stamp);
      this.db.prepare('INSERT INTO v2_worker_tool_grant_events '+
        '(host,principal,profile,conversation,operation_id,kind,target,tool,worker_id,binding_id,status,'+
        'revision,issued_at_ms,expires_at_ms,actor,reason,occurred_at) '+
        'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(...scope,c.workerId,c.bindingId,status,next,issued,expiry,actor,reason.trim(),stamp);
      this.db.exec('COMMIT');
      return this.readWorkerToolGrant(r,c,tool);
    } catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
  }
  workerToolGrantEvents(route,workerContext,tool) {
    const c=workerContextOf(workerContext);
    const r=normalizeV2Route(route);routeMatchesWorker(r,c);
    const scope=workerToolScope(r,tool);
    return this.db.prepare('SELECT seq,binding_id AS bindingId,status,revision,'+
      'issued_at_ms AS issuedAtMs,expires_at_ms AS expiresAtMs,actor,reason,'+
      'occurred_at AS occurredAt FROM v2_worker_tool_grant_events '+
      'WHERE host=? AND principal=? AND profile=? AND conversation=? AND operation_id=? '+
      'AND kind=? AND target=? AND tool=? AND worker_id=? ORDER BY seq')
      .all(...scope,c.workerId);
  }
  isWorkerAllowed(route,workerContext,tool) {
    const c=workerContextOf(workerContext);
    const r=normalizeV2Route(route);
    if(r.hostId!==c.hostId||r.principalId!==c.principalId
      ||r.profileId!==c.profileId||r.conversationId!==c.conversationId)return false;
    const now=this.now();
    if(!Number.isSafeInteger(now)||now<0)fail('V2_WORKER_GRANT_CLOCK_INVALID');
    const enrollment=this.readWorkerGrant(c);
    if(!enrollment||enrollment.status!=='ACTIVE'||!ownerGrantMatchesContext(enrollment,c)
      ||enrollment.expiresAtMs<=now)return false;
    const grant=this.readWorkerToolGrant(r,c,tool);
    if(!grant||grant.status!=='ENABLED'||grant.bindingId!==c.bindingId
      ||grant.expiresAtMs<=now||grant.expiresAtMs>enrollment.expiresAtMs)return false;
    const scope=workerToolScope(r,tool);
    const row=this.db.prepare('SELECT * FROM v2_worker_tool_grants '+
      'WHERE host=? AND principal=? AND profile=? AND conversation=? AND operation_id=? AND kind=? '+
      'AND target=? AND tool=? AND worker_id=?').get(...scope,c.workerId);
    return !!row&&workerExactMatches(row,c);
  }
  events(route, tool) {
    const s = scopeOf(route, tool);
    return this.db.prepare(`SELECT seq,from_status AS fromStatus,to_status AS toStatus,revision,actor,reason,occurred_at AS occurredAt
      FROM v2_grant_events WHERE host=? AND principal=? AND profile=? AND conversation=? AND kind=? AND target=? AND tool=? ORDER BY seq`).all(...s);
  }
  close() { this.db.close(); }
}
