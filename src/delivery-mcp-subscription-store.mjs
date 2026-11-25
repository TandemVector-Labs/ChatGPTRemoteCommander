// Private per-profile MCP Events subscription metadata. No HTTP or public tools.
// Callers MUST supply owner-verified profile scope and sealed (encrypted) secrets.
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const SHA=/^[a-f0-9]{64}$/;
const SID=/^sub_[a-f0-9]{64}$/;
function noAliases(target){
  let cursor=path.parse(target).root;
  for(const part of path.resolve(target).slice(cursor.length).split(path.sep).filter(Boolean)){
    cursor=path.join(cursor,part);
    try{if(fs.lstatSync(cursor).isSymbolicLink())fail('DELIVERY_SUBSCRIPTIONS_ALIAS');}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
}
function regular(target){
  noAliases(target);
  const info=fs.lstatSync(target);
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)
    fail('DELIVERY_SUBSCRIPTIONS_ALIAS');
  return info;
}
const ROTATION_WINDOW_MS=5*60*1000;
const CALLBACK_VERIFICATION_CACHE_MS=5*60*1000;
function matchRecord(row,cutoff){
  if(!row)return null;
  const rotating=typeof row.previous_until==='string'
    && row.previous_until>cutoff
    && typeof row.previous_sealed_secret==='string';
  return Object.freeze({
    id:row.id,scope:row.owner_scope,bindingKey:row.binding_key,
    name:row.name,callbackUrl:row.callback_url,sealedSecret:row.sealed_secret,
    previousSealedSecret:rotating?row.previous_sealed_secret:null,
    previousUntil:rotating?row.previous_until:null,
    refreshBefore:row.refresh_before,verifiedAt:row.verified_at
  });
}
function key(value,type='hash'){
  if(typeof value!=='string'||!(type==='id'?SID:SHA).test(value))
    fail('DELIVERY_SUBSCRIPTIONS_KEY_INVALID');
  return value;
}
export class DeliveryEventSubscriptionStore {
  constructor({directory,profileScope}={}){
    key(profileScope);
    if(typeof directory!=='string'||!path.isAbsolute(directory)
      ||/^(?:\\\\|\/\/)/.test(directory))fail('DELIVERY_SUBSCRIPTIONS_PRIVATE_DIRECTORY_REQUIRED');
    noAliases(directory);
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    this.directory=fs.realpathSync.native(directory);
    this.profileScope=profileScope;
    const dbPath=path.join(this.directory,'event-subscriptions.sqlite');
    for(const suffix of ['','-journal','-wal','-shm']){
      if(fs.existsSync(dbPath+suffix))regular(dbPath+suffix);
    }
    this.db=new DatabaseSync(dbPath,{allowExtension:false});
    fs.chmodSync(dbPath,0o600);
    this.db.exec('PRAGMA busy_timeout=3000; PRAGMA trusted_schema=OFF; PRAGMA synchronous=EXTRA;');
    if(this.db.prepare('PRAGMA journal_mode').get().journal_mode!=='delete'){
      this.db.close();
      fail('DELIVERY_SUBSCRIPTIONS_JOURNAL_MODE');
    }
    const version=this.db.prepare('PRAGMA user_version').get().user_version;
    if(version>4){this.db.close();fail('DELIVERY_SUBSCRIPTIONS_SCHEMA_TOO_NEW');}
    // Transactionally upgrade v0/v1 stores in-place: preserve owners, expiry,
    // and encrypted current secrets; never reset or duplicate subscriptions.
    try{
      this.db.exec('BEGIN IMMEDIATE;');
      this.db.exec(`CREATE TABLE IF NOT EXISTS subscriptions(
        profile_scope TEXT NOT NULL,
        id TEXT NOT NULL,
        owner_scope TEXT NOT NULL,
        binding_key TEXT NOT NULL,
        name TEXT NOT NULL,
        callback_url TEXT NOT NULL,
        sealed_secret TEXT NOT NULL,
        refresh_before TEXT NOT NULL,
        verified_at TEXT NOT NULL,
        PRIMARY KEY(profile_scope,id));
        CREATE INDEX IF NOT EXISTS subscription_owner ON subscriptions
          (profile_scope,owner_scope,binding_key,refresh_before);`);
      const columns=new Set(this.db.prepare('PRAGMA table_info(subscriptions)')
        .all().map(row=>row.name));
      if(!columns.has('previous_sealed_secret'))
        this.db.exec('ALTER TABLE subscriptions ADD COLUMN previous_sealed_secret TEXT;');
      if(!columns.has('previous_until'))
        this.db.exec('ALTER TABLE subscriptions ADD COLUMN previous_until TEXT;');
      // Durable cancellation generations fence async callback registrations
      // across independent workers/processes sharing this private SQLite DB.
      this.db.exec(`CREATE TABLE IF NOT EXISTS subscription_revocations(
        profile_scope TEXT NOT NULL,
        id TEXT NOT NULL,
        owner_scope TEXT NOT NULL,
        binding_key TEXT NOT NULL,
        generation INTEGER NOT NULL,
        PRIMARY KEY(profile_scope,id)
      );`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS callback_verifications(
        profile_scope TEXT NOT NULL,
        owner_scope TEXT NOT NULL,
        callback_hash TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY(profile_scope,owner_scope,callback_hash,secret_hash)
      );`);
      this.db.exec('PRAGMA user_version=4; COMMIT;');
    }catch(error){
      try{this.db.exec('ROLLBACK;');}catch{}
      this.db.close();
      throw error;
    }
    this.closed=false;
  }
  close(){if(this.closed)return;this.closed=true;this.db.close();}
  upsert(record){
    if(!record||typeof record!=='object')fail('DELIVERY_SUBSCRIPTIONS_RECORD_INVALID');
    key(record.id,'id');key(record.scope);key(record.bindingKey);
    if(record.name!=='commander.delivery.ready'
      ||typeof record.callbackUrl!=='string'||!/^https:\/\//.test(record.callbackUrl)
      ||typeof record.sealedSecret!=='string'||record.sealedSecret.length<1
      ||record.sealedSecret.startsWith('whsec_')
      ||typeof record.refreshBefore!=='string'||!Number.isFinite(Date.parse(record.refreshBefore))
      ||typeof record.verifiedAt!=='string'||!Number.isFinite(Date.parse(record.verifiedAt)))
      fail('DELIVERY_SUBSCRIPTIONS_RECORD_INVALID');
    if(record.expectedGeneration!==undefined
      &&(!Number.isSafeInteger(record.expectedGeneration)
        ||record.expectedGeneration<0))
      fail('DELIVERY_SUBSCRIPTIONS_RECORD_INVALID');
    this.db.exec('BEGIN IMMEDIATE;');
    try{
    const fence=this.db.prepare(`SELECT owner_scope,binding_key,generation
      FROM subscription_revocations WHERE profile_scope=? AND id=?`)
      .get(this.profileScope,record.id);
    if(fence&&(fence.owner_scope!==record.scope||fence.binding_key!==record.bindingKey))
      fail('DELIVERY_SUBSCRIPTIONS_ID_CONFLICT');
    if(record.expectedGeneration!==undefined
      &&record.expectedGeneration!==(fence?.generation??0))
      fail('DELIVERY_SUBSCRIPTIONS_STALE_REGISTRATION');
    const existing=this.db.prepare('SELECT * FROM subscriptions WHERE profile_scope=? AND id=?')
      .get(this.profileScope,record.id);
    if(existing&&(existing.owner_scope!==record.scope
      ||existing.binding_key!==record.bindingKey||existing.callback_url!==record.callbackUrl
      ||existing.name!==record.name))fail('DELIVERY_SUBSCRIPTIONS_ID_CONFLICT');
    if(existing&&Date.parse(record.verifiedAt)<Date.parse(existing.verified_at))
      fail('DELIVERY_SUBSCRIPTIONS_STALE_REFRESH');
    let previousSecret=null,previousUntil=null;
    if(existing&&existing.sealed_secret!==record.sealedSecret){
      const until=Math.min(Date.parse(record.verifiedAt)+ROTATION_WINDOW_MS,
        Date.parse(record.refreshBefore));
      if(until>Date.parse(record.verifiedAt)){
        previousSecret=existing.sealed_secret;
        previousUntil=new Date(until).toISOString();
      }
    }else if(existing&&existing.previous_sealed_secret
      &&existing.previous_until>record.verifiedAt){
      previousSecret=existing.previous_sealed_secret;
      previousUntil=existing.previous_until;
    }
    this.db.prepare(`INSERT INTO subscriptions(
      profile_scope,id,owner_scope,binding_key,name,callback_url,sealed_secret,
      previous_sealed_secret,previous_until,refresh_before,verified_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(profile_scope,id) DO UPDATE SET
        sealed_secret=excluded.sealed_secret,
        previous_sealed_secret=excluded.previous_sealed_secret,
        previous_until=excluded.previous_until,
        refresh_before=excluded.refresh_before,verified_at=excluded.verified_at`)
      .run(this.profileScope,record.id,record.scope,record.bindingKey,record.name,
        record.callbackUrl,record.sealedSecret,previousSecret,previousUntil,
        record.refreshBefore,record.verifiedAt);
    this.db.exec('COMMIT;');
    return {id:record.id,stored:true};
    }catch(error){
      try{this.db.exec('ROLLBACK;');}catch{}
      throw error;
    }
  }
  registrationGeneration({id,scope,bindingKey}={}){
    key(id,'id');key(scope);key(bindingKey);
    const fence=this.db.prepare(`SELECT owner_scope,binding_key,generation
      FROM subscription_revocations WHERE profile_scope=? AND id=?`)
      .get(this.profileScope,id);
    const existing=this.db.prepare(`SELECT owner_scope,binding_key
      FROM subscriptions WHERE profile_scope=? AND id=?`)
      .get(this.profileScope,id);
    if((fence&&(fence.owner_scope!==scope||fence.binding_key!==bindingKey))
      ||(existing&&(existing.owner_scope!==scope||existing.binding_key!==bindingKey)))
      fail('DELIVERY_SUBSCRIPTIONS_ID_CONFLICT');
    return fence?.generation??0;
  }
  hasCallbackVerification({scope,callbackHash,secretHash,at=Date.now()}={}){
    key(scope);key(callbackHash);key(secretHash);
    if(!Number.isSafeInteger(at)||at<0)
      fail('DELIVERY_SUBSCRIPTIONS_QUERY_INVALID');
    const cutoff=new Date(at).toISOString();
    const row=this.db.prepare(`SELECT expires_at FROM callback_verifications
      WHERE profile_scope=? AND owner_scope=? AND callback_hash=? AND secret_hash=?`)
      .get(this.profileScope,scope,callbackHash,secretHash);
    if(!row)return false;
    if(row.expires_at<=cutoff){
      this.db.prepare(`DELETE FROM callback_verifications
        WHERE profile_scope=? AND owner_scope=? AND callback_hash=? AND secret_hash=?
          AND expires_at<=?`)
        .run(this.profileScope,scope,callbackHash,secretHash,cutoff);
      return false;
    }
    return true;
  }
  rememberCallbackVerification({id,scope,bindingKey,expectedGeneration,callbackHash,secretHash,verifiedAt,expiresAt}={}){
    key(id,'id');key(scope);key(bindingKey);key(callbackHash);key(secretHash);
    if(expectedGeneration!==undefined
      &&(!Number.isSafeInteger(expectedGeneration)||expectedGeneration<0))
      fail('DELIVERY_SUBSCRIPTIONS_CACHE_RECORD_INVALID');
    const verified=Date.parse(verifiedAt),expires=Date.parse(expiresAt);
    if(!Number.isFinite(verified)||!Number.isFinite(expires)
      ||new Date(verified).toISOString()!==verifiedAt
      ||new Date(expires).toISOString()!==expiresAt
      ||expires<=verified||expires-verified>CALLBACK_VERIFICATION_CACHE_MS)
      fail('DELIVERY_SUBSCRIPTIONS_CACHE_RECORD_INVALID');
    this.db.exec('BEGIN IMMEDIATE;');
    try{
      const fence=this.db.prepare(`SELECT owner_scope,binding_key,generation
        FROM subscription_revocations WHERE profile_scope=? AND id=?`)
        .get(this.profileScope,id);
      const existing=this.db.prepare(`SELECT owner_scope,binding_key
        FROM subscriptions WHERE profile_scope=? AND id=?`)
        .get(this.profileScope,id);
      if((fence&&(fence.owner_scope!==scope||fence.binding_key!==bindingKey))
        ||(existing&&(existing.owner_scope!==scope||existing.binding_key!==bindingKey)))
        fail('DELIVERY_SUBSCRIPTIONS_ID_CONFLICT');
      if(expectedGeneration!==undefined
        &&expectedGeneration!==(fence?.generation??0))
        fail('DELIVERY_SUBSCRIPTIONS_STALE_REGISTRATION');
      this.db.prepare(`DELETE FROM callback_verifications
        WHERE profile_scope=? AND expires_at<=?`)
        .run(this.profileScope,verifiedAt);
      this.db.prepare(`INSERT INTO callback_verifications(
        profile_scope,owner_scope,callback_hash,secret_hash,expires_at)
        VALUES(?,?,?,?,?)
        ON CONFLICT(profile_scope,owner_scope,callback_hash,secret_hash)
        DO UPDATE SET expires_at=excluded.expires_at`)
        .run(this.profileScope,scope,callbackHash,secretHash,expiresAt);
      this.db.exec('COMMIT;');
      return {stored:true,expiresAt};
    }catch(error){
      try{this.db.exec('ROLLBACK;');}catch{}
      throw error;
    }
  }
  remove({id,scope,bindingKey}={}){
    key(id,'id');key(scope);key(bindingKey);
    this.db.exec('BEGIN IMMEDIATE;');
    try{
      const fence=this.db.prepare(`SELECT owner_scope,binding_key,generation
        FROM subscription_revocations WHERE profile_scope=? AND id=?`)
        .get(this.profileScope,id);
      const current=this.db.prepare(`SELECT owner_scope,binding_key
        FROM subscriptions WHERE profile_scope=? AND id=?`)
        .get(this.profileScope,id);
      // A foreign owner's guessed ID cannot create a tombstone or block its
      // real owner. Authorized idempotent unsubscribe still fences missing rows.
      if((fence&&(fence.owner_scope!==scope||fence.binding_key!==bindingKey))
        ||(current&&(current.owner_scope!==scope||current.binding_key!==bindingKey))){
        this.db.exec('COMMIT;');
        return {deleted:false};
      }
      const generation=(fence?.generation??0)+1;
      if(!Number.isSafeInteger(generation))
        fail('DELIVERY_SUBSCRIPTIONS_GENERATION_EXHAUSTED');
      this.db.prepare(`INSERT INTO subscription_revocations(
        profile_scope,id,owner_scope,binding_key,generation) VALUES(?,?,?,?,?)
        ON CONFLICT(profile_scope,id) DO UPDATE SET generation=excluded.generation`)
        .run(this.profileScope,id,scope,bindingKey,generation);
      const removed=this.db.prepare(`DELETE FROM subscriptions
        WHERE profile_scope=? AND id=? AND owner_scope=? AND binding_key=?`)
        .run(this.profileScope,id,scope,bindingKey);
      this.db.exec('COMMIT;');
      return {deleted:removed.changes===1};
    }catch(error){
      try{this.db.exec('ROLLBACK;');}catch{}
      throw error;
    }
  }
  getActive({id,scope,bindingKey,at=Date.now()}={}){
    key(id,'id');key(scope);key(bindingKey);
    if(!Number.isSafeInteger(at)||at<0)
      fail('DELIVERY_SUBSCRIPTIONS_QUERY_INVALID');
    const cutoff=new Date(at).toISOString();
    const row=this.db.prepare(`SELECT * FROM subscriptions
      WHERE profile_scope=? AND id=? AND owner_scope=? AND binding_key=?
        AND refresh_before>?`)
      .get(this.profileScope,id,scope,bindingKey,cutoff);
    return matchRecord(row,cutoff);
  }
  listActive({scope,bindingKey,at=Date.now(),limit=50}={}){
    key(scope);key(bindingKey);
    if(!Number.isSafeInteger(at)||at<0||!Number.isSafeInteger(limit)||limit<1||limit>100)
      fail('DELIVERY_SUBSCRIPTIONS_QUERY_INVALID');
    const cutoff=new Date(at).toISOString();
    return this.db.prepare(`SELECT * FROM subscriptions
      WHERE profile_scope=? AND owner_scope=? AND binding_key=? AND refresh_before>?
      ORDER BY id LIMIT ?`).all(this.profileScope,scope,bindingKey,cutoff,limit)
      .map(row=>matchRecord(row,cutoff));
  }
  status(){
    return Object.freeze({
      durable:true,profileScope:this.profileScope,
      total:this.db.prepare('SELECT count(*) AS n FROM subscriptions WHERE profile_scope=?')
        .get(this.profileScope).n
    });
  }
}
