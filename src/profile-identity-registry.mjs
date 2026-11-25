import { createHash } from 'node:crypto';

// Explicit owner-supplied identity map, never inferred from display strings,
// profile filenames, certificates, or unrelated machines.
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function reject(code) { throw new Error('PROFILE_IDENTITY_' + code); }
function onlyFields(value, keys) {
  return Object.keys(value).every(k => keys.includes(k));
}
function validId(value) {
  return typeof value === 'string' && ID.test(value) && !value.includes('..');
}
function validProfile(value) {
  return typeof value === 'string' && PROFILE.test(value) && !value.includes('..');
}
function validLabel(value, limit = 100) {
  return typeof value === 'string' && value === value.trim() &&
    value.length >= 2 && [...value].length <= limit &&
    !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value) &&
    !/\s{2,}/u.test(value);
}
const fold = value => value.toLowerCase(); // Windows' profile filenames are case-insensitive.

export function normalizeProfileIdentityRegistry(input) {
  if (!isRecord(input) || !onlyFields(input,['schema','hosts']) || input.schema !== 1 ||
      !Array.isArray(input.hosts) || input.hosts.length === 0 || input.hosts.length > 64) {
    reject('SCHEMA_INVALID');
  }
  const allHosts = new Set();
  const hosts = input.hosts.map(host => {
    if (!isRecord(host) || !onlyFields(host,['hostId','hostLabel','profiles']) || !validId(host.hostId) ||
        !validLabel(host.hostLabel, 80) ||
        !Array.isArray(host.profiles) || host.profiles.length < 1 ||
        host.profiles.length > 64) reject('HOST_INVALID');
    if (allHosts.has(fold(host.hostId))) reject('HOST_COLLISION');
    allHosts.add(fold(host.hostId));
    const accounts = new Set(), names = new Map(), labels = new Set();
    const profiles = host.profiles.map(profile => {
      if (!isRecord(profile) || !onlyFields(profile,['accountId','profileId','tunnelProfile','displayName','aliases']) || !validId(profile.accountId) ||
          !validProfile(profile.profileId) || !validProfile(profile.tunnelProfile) ||
          !validLabel(profile.displayName) ||
          (profile.aliases !== undefined &&
          (!Array.isArray(profile.aliases) || profile.aliases.length > 64 ||
           profile.aliases.some(alias => !validProfile(alias))))) reject('PROFILE_INVALID');
      if (accounts.has(fold(profile.accountId))) reject('ACCOUNT_COLLISION');
      accounts.add(fold(profile.accountId));
      if (labels.has(fold(profile.displayName))) reject('DISPLAY_COLLISION');
      labels.add(fold(profile.displayName));
      const members = [profile.profileId, profile.tunnelProfile, ...(profile.aliases ?? [])];
      for (const member of members) {
        const key = fold(member), prior = names.get(key);
        if (prior && prior !== profile.accountId) reject('ALIAS_COLLISION');
        names.set(key, profile.accountId);
      }
      return Object.freeze({
        accountId: profile.accountId,
        profileId: profile.profileId,
        tunnelProfile: profile.tunnelProfile,
        displayName: profile.displayName,
        aliases: Object.freeze([...(new Set(profile.aliases ?? []))])
      });
    });
    return Object.freeze({
      hostId: host.hostId, hostLabel: host.hostLabel,
      profiles: Object.freeze(profiles)
    });
  });
  return Object.freeze({schema: 1, hosts: Object.freeze(hosts)});
}

export function resolveProfileIdentity(registry, {hostId, accountId, profileName}) {
  const validated = normalizeProfileIdentityRegistry(registry);
  if (!validId(hostId) || !validId(accountId) || !validProfile(profileName)) {
    reject('LOOKUP_INVALID');
  }
  const host = validated.hosts.find(h => h.hostId === hostId);
  if (!host) reject('HOST_NOT_FOUND');
  const profile = host.profiles.find(p => p.accountId === accountId);
  if (!profile) reject('ACCOUNT_NOT_FOUND');
  const members = [profile.profileId, profile.tunnelProfile, ...profile.aliases];
  if (!members.includes(profileName)) reject('PROFILE_ACCOUNT_MISMATCH');
  // Never serialize unverified account identifiers or a raw client credential
  // into a public plugin. This digest is only an inventory correlation key.
  const bindingHash = createHash('sha256').update(JSON.stringify([
    host.hostId, profile.accountId, profile.profileId, profile.tunnelProfile
  ])).digest('hex').slice(0, 24);
  return Object.freeze({
    hostLabel: host.hostLabel, profileId: profile.profileId,
    tunnelProfile: profile.tunnelProfile, displayName: profile.displayName,
    bindingHash, source: 'explicit-local-identity-map-unattested'
  });
}
