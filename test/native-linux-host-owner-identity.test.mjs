import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveLinuxHostOwnerSidHash,readLinuxHostOwnerSidHash
} from '../src/native-linux-host-owner-identity.mjs';

const machine='1234567890abcdef1234567890abcdef';
const host='         0          0 4294967295\n';
const systemd='      1000       1000          1\n';
const owner=v=>({uid:1000,uidMap:v,machineId:machine});

test('systemd sandbox and native KDE session map to the same genuine host UID',()=>{
  const normal=deriveLinuxHostOwnerSidHash(owner(host));
  const sandbox=deriveLinuxHostOwnerSidHash(owner(systemd));
  assert.equal(normal,sandbox);
  assert.match(normal,/^[a-f0-9]{64}$/);
  assert.notEqual(normal,deriveLinuxHostOwnerSidHash({
    ...owner(host),machineId:'abcdef0123456789abcdef0123456789'
  }));
  assert.notEqual(normal,deriveLinuxHostOwnerSidHash({
    ...owner(host),uid:1001
  }));
});
test('host UID remapping, ambiguous, missing or spoofed uid_map fails closed',()=>{
  for(const uidMap of [
    '1000 2000 1\n', '0 0 999\n', '1000 1000 1\n1000 1000 1\n',
    '0 0 2000\n1000 1000 1\n', '1000 -1 1\n','1000 1000 0\n',
    '1000 1000 4294967297\n','1000 1000 abc\n', '', 'oops'
  ])assert.throws(()=>deriveLinuxHostOwnerSidHash(owner(uidMap)));
});
test('machine-id must be canonical and never become a credential',()=>{
  for(const m of ['0'.repeat(32),'abcdef','Z'.repeat(32),
    '1234567890abcdef1234567890abcdef\\nZ',
    '1234567890abcdef1234567890abcdef999']) {
    assert.throws(()=>deriveLinuxHostOwnerSidHash({
      ...owner(host),machineId:m
    }),{code:'RC012_STABLE_OWNER_MACHINE_ID_INVALID'});
  }
});
test('live Linux native host owner identity is independently reproducible',{skip:process.platform!=='linux'},()=>{
  const owner=readLinuxHostOwnerSidHash();
  assert.match(owner,/^[a-f0-9]{64}$/);
  assert.equal(owner,readLinuxHostOwnerSidHash());
});
