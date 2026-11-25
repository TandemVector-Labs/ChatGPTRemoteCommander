import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveWindowsOwnerEnrollmentArgs} from
  '../tools/enroll-owner-private-tunnel-windows.mjs';

test('read-only Windows owner Tunnel preflight derives exact native hostname, never COMPUTERNAME alias',()=>{
 const host='Emad-PC-Ultimate';
 assert.deepEqual(resolveWindowsOwnerEnrollmentArgs(
   ['chatgpt-remote-commander','--preflight'],host),{
   profile:'chatgpt-remote-commander',host,mode:'--preflight'
 });
 assert.deepEqual(resolveWindowsOwnerEnrollmentArgs(
   ['MMZ',host,'--preflight'],host),{profile:'MMZ',host,mode:'--preflight'});
 assert.throws(()=>resolveWindowsOwnerEnrollmentArgs(
   ['MMZ','EMAD-PC-ULTIMAT','--preflight'],host),
   {code:'RC012_WINDOWS_OWNER_TUNNEL_HOST_MISMATCH'});
});
test('native enrollment is never implicit and identity mismatch is rejected',()=>{
 const host='Emad-PC-Ultimate';
 assert.deepEqual(resolveWindowsOwnerEnrollmentArgs(
   ['saeed-emad',host],host),{profile:'saeed-emad',host,mode:null});
 for(const bad of [
   ['saeed-emad'],['saeed-emad','--preflight','--preflight'],
   ['..','--preflight'],['saeed-emad','other-host'],
   ['saeed-emad',host,'--approve-without-consent'],[]
 ]){
   assert.throws(()=>resolveWindowsOwnerEnrollmentArgs(bad,host));
 }
 assert.throws(()=>resolveWindowsOwnerEnrollmentArgs(
   ['saeed-emad','--preflight'],'bad host'));
});
