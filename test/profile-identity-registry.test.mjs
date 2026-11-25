import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeProfileIdentityRegistry,resolveProfileIdentity} from '../src/profile-identity-registry.mjs';

const example = () => ({
  schema: 1, hosts: [
    {hostId:'host-one',hostLabel:'Emad PC',profiles:[
      {accountId:'acct-emad',profileId:'default',
       tunnelProfile:'chatgpt-remote-commander',
       displayName:'Remote Commander · Emad · Emad PC',
       aliases:['old-default']},
      {accountId:'acct-mmz',profileId:'MMZ',tunnelProfile:'MMZ',
       displayName:'Remote Commander · MMZ · Emad PC',
       aliases:['historical-mmz']}
    ]},
    {hostId:'host-two',hostLabel:'Emad Server',profiles:[
      {accountId:'acct-emad',profileId:'default',
       tunnelProfile:'aliemad-Server',
       displayName:'Remote Commander · Emad · Emad Server',
       aliases:['legacy']}
    ]}
  ]
});

test('same account on separate hosts has distinct identity with preserved aliases',()=>{
  const registry=normalizeProfileIdentityRegistry(example());
  const pc=resolveProfileIdentity(registry,{
    hostId:'host-one',accountId:'acct-emad',profileName:'chatgpt-remote-commander'
  });
  const server=resolveProfileIdentity(registry,{
    hostId:'host-two',accountId:'acct-emad',profileName:'aliemad-Server'
  });
  assert.equal(pc.profileId,'default');
  assert.equal(server.profileId,'default');
  assert.equal(pc.hostLabel,'Emad PC');
  assert.notEqual(pc.bindingHash,server.bindingHash);
  assert.equal(pc.displayName,'Remote Commander · Emad · Emad PC');
  assert.equal(resolveProfileIdentity(registry,{
    hostId:'host-one',accountId:'acct-emad',profileName:'old-default'
  }).bindingHash,pc.bindingHash);
  assert.deepEqual(registry.hosts[0].profiles[0].aliases,['old-default']);
});

test('forged account or host cannot acquire a legitimate profile by filename',()=>{
  const registry=example();
  for(const query of [
    {hostId:'host-one',accountId:'acct-mmz',profileName:'default'},
    {hostId:'host-one',accountId:'acct-emad',profileName:'MMZ'},
    {hostId:'host-two',accountId:'acct-mmz',profileName:'MMZ'},
    {hostId:'other-host',accountId:'acct-emad',profileName:'default'},
    {hostId:'host-one',accountId:'ACCT-EMAD',profileName:'default'}
  ]) assert.throws(()=>resolveProfileIdentity(registry,query),/PROFILE_IDENTITY_/u);
});

test('alias collision cannot merge independent accounts, even by case on Windows',()=>{
  for(const variant of ['MMZ','mmz','historical-mmz']){
    const r=example();
    r.hosts[0].profiles[0].aliases.push(variant);
    assert.throws(()=>normalizeProfileIdentityRegistry(r),/PROFILE_IDENTITY_ALIAS_COLLISION/u);
  }
});

test('duplicate per-host account, display or host identity are rejected',()=>{
  for(const which of ['account','display','host']){
    const r=example();
    if(which==='account')r.hosts[0].profiles[1].accountId='acct-emad';
    if(which==='display')r.hosts[0].profiles[1].displayName='remote commander · emad · emad pc';
    if(which==='host')r.hosts[1].hostId='HOST-ONE';
    assert.throws(()=>normalizeProfileIdentityRegistry(r),/PROFILE_IDENTITY_(ACCOUNT|DISPLAY|HOST)_COLLISION/u);
  }
});

test('historical spelling differences never imply cross-account equality',()=>{
  const r=example();
  r.hosts[0].profiles[1].aliases=['saeid-secondary'];
  const validated=normalizeProfileIdentityRegistry(r);
  assert.throws(()=>resolveProfileIdentity(validated,{
    hostId:'host-one',accountId:'acct-emad',profileName:'saeid-secondary'
  }),/PROFILE_IDENTITY_PROFILE_ACCOUNT_MISMATCH/u);
});

test('malformed labels, names, and maps fail closed',()=>{
  const broken=[
    {schema:2,hosts:[]},
    {schema:1,hosts:[]},
    {schema:1,hosts:[{hostId:'host-one',hostLabel:'Host',profiles:[]}]}
  ];
  for(const x of broken) assert.throws(()=>normalizeProfileIdentityRegistry(x),/PROFILE_IDENTITY_/u);
  const a=example();a.hosts[0].profiles[1].displayName='bad\nlabel';
  assert.throws(()=>normalizeProfileIdentityRegistry(a),/PROFILE_IDENTITY_PROFILE_INVALID/u);
  const b=example();b.hosts[0].profiles[1].aliases=['../secret'];
  assert.throws(()=>normalizeProfileIdentityRegistry(b),/PROFILE_IDENTITY_PROFILE_INVALID/u);
  const c=example();c.hosts[0].profiles[1].displayName='MMZ\u202e.txe';
  assert.throws(()=>normalizeProfileIdentityRegistry(c),/PROFILE_IDENTITY_PROFILE_INVALID/u);
  const d=example();d.hosts[0].profiles[1].apiKey='must-not-put-secrets-in-map';
  assert.throws(()=>normalizeProfileIdentityRegistry(d),/PROFILE_IDENTITY_PROFILE_INVALID/u);
});
