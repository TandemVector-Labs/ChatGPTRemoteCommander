// Read-only native OS owner-seat prerequisite for the existing private-pair J01.
// No dialogs, permissions, elevation, certificate or tunnel modifications.
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createWindowsNativeOwnerSessionProvider}
  from '../src/native-owner-session-provider-windows.mjs';
import {createLinuxNativeOwnerSessionProvider}
  from '../src/native-owner-session-provider-linux.mjs';
async function main(){
  const platform=process.platform;
  if(!['win32','linux'].includes(platform))throw Error('RC012_OWNER_SEAT_PLATFORM_UNSUPPORTED');
  const p=platform==='win32'
    ?createWindowsNativeOwnerSessionProvider()
    :createLinuxNativeOwnerSessionProvider();
  const snapshot=await p.getOwnerSessionSnapshot();
  if(!snapshot||typeof snapshot.ownerSidHash!=='string'
    ||!/^[a-f0-9]{64}$/.test(snapshot.ownerSidHash)
    ||typeof snapshot.osSessionId!=='string'
    ||snapshot.osSessionId.length>128)
    throw Error('RC012_OWNER_SEAT_NATIVE_SNAPSHOT_UNVERIFIED');
  process.stdout.write(JSON.stringify({
    result:'RC012_OWNER_SEAT_SNAPSHOT_PASS',platform,
    source:snapshot.source,seatId:snapshot.seatId,
    osSessionId:snapshot.osSessionId,
    ownerIdentityHashPrefix:snapshot.ownerSidHash.slice(0,12),
    consentRequested:false,fullAccessActive:false,
    nativeOwnerGrantIssued:false
  })+'\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(error=>{console.error(error?.code??'RC012_OWNER_SEAT_UNAVAILABLE');process.exitCode=1;});
}
