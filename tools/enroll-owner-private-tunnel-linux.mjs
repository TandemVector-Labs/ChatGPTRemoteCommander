// One-time Linux owner enrollment for the existing account+host Tunnel.
// No new Tunnel/Plugin, credentials, installation or Full Access. Requires a
// live pinned process AND a visible native logind/Zenity owner decision.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,X509Certificate} from 'node:crypto';
import {createLinuxNativeOwnerSessionProvider}
  from '../src/native-owner-session-provider-linux.mjs';
import {createLinuxTunnelClientObserver}
  from '../src/native-tunnel-client-observer-linux.mjs';
import {createNativeTunnelAttestor}
  from '../src/native-tunnel-attestor.mjs';
import {readLinuxOwnerTunnelPin,enrollLinuxOwnerTunnelPin}
  from '../src/linux-private-tunnel-owner-pin.mjs';
import {resolveLinuxNativeWitnessEnrollmentMode}
  from '../src/linux-native-witness-enrollment-mode.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hash=b=>createHash('sha256').update(b).digest('hex');
function ownerDirectory(dir,uid){
  const s=fs.lstatSync(dir);
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==uid
    ||(s.mode&0o077)!==0||fs.realpathSync.native(dir)!==dir)
    fail('RC012_OWNER_PAIR_DIRECTORY_NOT_PRIVATE');
}
function ownerFile(file,uid,size=65536){
  const s=fs.lstatSync(file);
  if(!s.isFile()||s.isSymbolicLink()||s.uid!==uid||s.nlink!==1
    ||(s.mode&0o077)!==0||s.size<1||s.size>size)
    fail('RC012_OWNER_PAIR_FILE_NOT_PRIVATE');
  return fs.readFileSync(file);
}
export function activeHealthPort(profile,uid,dir=path.join(os.homedir(),'.config','tunnel-client')){
  if(typeof profile!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile))
    fail('RC012_SELECTED_OWNER_TUNNEL_PROFILE_REQUIRED');
  ownerDirectory(dir,uid);
  const list=fs.readdirSync(dir).filter(n=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.yaml$/.test(n));
  // This host may serve multiple independent account profiles. Select only
  // the explicitly named existing YAML; never borrow another profile's key.
  if(!list.includes(profile+'.yaml'))
    fail('RC012_SELECTED_OWNER_TUNNEL_PROFILE_REQUIRED');
  const yaml=ownerFile(path.join(dir,profile+'.yaml'),uid,16384).toString('utf8');
  const healthSections=[...yaml.matchAll(/^health:\s*(?:#.*)?$/gm)];
  if(healthSections.length!==1)fail('RC012_OWNER_TUNNEL_HEALTH_BINDING_REQUIRED');
  const section=yaml.slice(healthSections[0].index+healthSections[0][0].length)
    .split(/(?=^[A-Za-z][\w.-]*:)/m,1)[0];
  const values=[...section.matchAll(/^  listen_addr:\s*(?:["']?)(127\.0\.0\.1:(\d{4,5}))(?:["']?)\s*$/gm)];
  if(values.length!==1)fail('RC012_OWNER_TUNNEL_HEALTH_BINDING_REQUIRED');
  const port=Number(values[0][2]);
  if(!Number.isSafeInteger(port)||port<1024||port>65535)
    fail('RC012_OWNER_TUNNEL_HEALTH_BINDING_REQUIRED');
  return Object.freeze({port,yamlSha256:hash(Buffer.from(yaml))});
}
function currentTunnelExecutable(profile,uid){
  const matches=[];
  for(const name of fs.readdirSync('/proc').filter(n=>/^[0-9]+$/.test(n))){
    try{
      const exe=fs.readlinkSync('/proc/'+name+'/exe');
      if(!exe.endsWith('/tunnel-client'))continue;
      const status=fs.readFileSync('/proc/'+name+'/status','utf8');
      const owner=status.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m);
      if(!owner||!owner.slice(1).every(v=>Number(v)===uid))continue;
      const args=fs.readFileSync('/proc/'+name+'/cmdline').toString('utf8').split('\0');
      const at=args.indexOf('--profile');
      if(!args.includes('run')||at<0||args[at+1]!==profile
        ||args.filter(x=>x==='--profile').length!==1)continue;
      matches.push(exe);
    }catch{}
  }
  if(matches.length!==1)fail('RC012_OWNER_TUNNEL_PROCESS_AMBIGUOUS');
  const exe=matches[0],s=fs.lstatSync(exe);
  if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o022)!==0
    ||(s.uid!==0&&s.uid!==uid)||s.size<10000||s.size>128*1024*1024)
    fail('RC012_OWNER_TUNNEL_EXECUTABLE_UNTRUSTED');
  return Object.freeze({exe,sha256:hash(fs.readFileSync(exe))});
}
async function main(){
  if(process.platform!=='linux'||process.argv.length!==4)
    fail('RC012_LINUX_TUNNEL_OWNER_ENROLL_ARGS_REQUIRED');
  const [profileId,hostId]=process.argv.slice(2);
  if(![profileId,hostId].every(s=>typeof s==='string'&&ID.test(s)
    &&s!=='.'&&s!=='..'))
    fail('RC012_LINUX_TUNNEL_OWNER_ENROLL_ARGS_REQUIRED');
  const uid=process.getuid();
  const directory=path.join(os.homedir(),
    '.config','chatgpt-remote-commander','private-pair',
    profileId==='chatgpt-remote-commander'?'default':profileId);
  ownerDirectory(directory,uid);
  const profile=activeHealthPort(profileId,uid);
  const executable=currentTunnelExecutable(profileId,uid);
  const clientPem=ownerFile(path.join(directory,'client.crt'),uid);
  const cert=new X509Certificate(clientPem);
  if(cert.ca!==false||!cert.keyUsage?.includes('1.3.6.1.5.5.7.3.2')
    ||Date.parse(cert.validTo)<=Date.now()
    ||Date.parse(cert.validFrom)>Date.now())
    fail('RC012_OWNER_TUNNEL_CLIENT_CERT_INVALID');
  const expectedClientLeafDerSha256=hash(cert.raw);
  // Reuse the precise identity scheme already authorized for this account
  // and host. An existing host-uid-v2 PIN must not be silently compared
  // against a new namespace-v1 witness, or rewritten to make it fit.
  const trustFile=path.join(directory,'owner-tunnel-trust.json');
  const enrolledPin=fs.existsSync(trustFile)
    ?readLinuxOwnerTunnelPin({directory}):null;
  const v1Owner=createLinuxNativeOwnerSessionProvider({
    ownerIdentityMode:'namespace-v1'
  });
  let owner=v1Owner;
  if(enrolledPin){
    const v2Owner=createLinuxNativeOwnerSessionProvider({
      ownerIdentityMode:'host-uid-v2'
    });
    const selection=resolveLinuxNativeWitnessEnrollmentMode({
      pinnedOwnerSidHash:enrolledPin.ownerSidHash,
      v1:await v1Owner.getOwnerSessionSnapshot(),
      v2:await v2Owner.getOwnerSessionSnapshot()
    });
    owner=selection.mode==='host-uid-v2'?v2Owner:v1Owner;
  }
  const ownerSidHash=await owner.resolveOwnerSidHash();
  const observer=createLinuxTunnelClientObserver({
    profileId,expectedExecutablePath:executable.exe,
    expectedExecutableSha256:executable.sha256,healthPort:profile.port,
    resolveOwnerSidHash:owner.resolveOwnerSidHash
  });
  const native=createNativeTunnelAttestor({
    hostId,profileId,expectedExecutablePath:executable.exe,
    expectedExecutableSha256:executable.sha256,
    resolveOwnerSidHash:owner.resolveOwnerSidHash,...observer
  });
  const transport=await native.resolveTransportIdentity();
  if(transport.ownerSidHash!==ownerSidHash||transport.authenticated!==true)
    fail('RC012_NATIVE_OWNER_TUNNEL_NOT_ATTESTED');
  const record={
    schema:1,kind:'linux-owner-private-one-tunnel',hostId,profileId,
    ownerSidHash,expectedExecutablePath:executable.exe,
    expectedExecutableSha256:executable.sha256,
    healthPort:profile.port,expectedClientLeafDerSha256,
    enrolledAtMs:Date.now()
  };
  let result;
  if(enrolledPin){
    const enrolled=enrolledPin;
    for(const key of Object.keys(record).filter(k=>k!=='enrolledAtMs')){
      if(enrolled[key]!==record[key])fail('RC012_OWNER_TUNNEL_ENROLLED_PIN_DRIFT');
    }
    result={record:enrolled,reused:true,ownerConsentRequested:false};
  }else{
    result=await enrollLinuxOwnerTunnelPin({
      directory,record,
      authorizeOwner:async()=>{
        const snapshot=await owner.getOwnerSessionSnapshot();
        if(snapshot.ownerSidHash!==ownerSidHash)return false;
        const message=[
          'Approve ONE private ChatGPT account+host Tunnel identity?',
          'This saves ONLY local non-secret hashes; it does not switch the',
          'Tunnel/Core, enable Full Access, issue Worker grants or modify API keys.',
          'Host: '+hostId,'Profile: '+profileId,
          'Runtime executable: '+executable.exe,
          'Executable SHA-256: '+executable.sha256,
          'Health loopback: 127.0.0.1:'+profile.port,
          'mTLS client leaf SHA-256: '+expectedClientLeafDerSha256,
          'OS owner: '+ownerSidHash.slice(0,12),
          '',
          'Reject unless this is exactly your existing native Tunnel.'
        ].join('\n');
        return owner.requestConsent({
          title:'Commander — Enroll existing owner Tunnel',
          message,expectedOwnerSidHash:ownerSidHash,
          expectedOsSessionId:snapshot.osSessionId
        });
      },
      verifyCurrent:async()=>{
        const after=await native.resolveTransportIdentity();
        if(after.tunnelIdHash!==transport.tunnelIdHash
          ||after.ownerSidHash!==ownerSidHash
          ||after.authenticated!==true)return false;
        if(activeHealthPort(profileId,uid).yamlSha256!==profile.yamlSha256)return false;
        return hash(ownerFile(path.join(directory,'client.crt'),uid))
          ===hash(clientPem);
      }
    });
  }
  const stored=readLinuxOwnerTunnelPin({directory});
  const final=await native.resolveTransportIdentity();
  if(stored.expectedExecutableSha256!==executable.sha256
    ||stored.ownerSidHash!==final.ownerSidHash
    ||stored.expectedClientLeafDerSha256!==expectedClientLeafDerSha256
    ||final.authenticated!==true)fail('RC012_OWNER_TUNNEL_PIN_READBACK_FAILED');
  console.log(JSON.stringify({
    result:'RC012_LINUX_OWNER_SINGLE_TUNNEL_PIN_ENROLLED_PASS',
    host:hostId,profile:profileId,
    source:'actual-native-process-and-owner-consent',
    ownerConsentRequested:result.ownerConsentRequested,
    privateRecord:true,ownedExecutableHash:true,clientLeafPinned:true,
    healthPortPinned:true,currentTransportAttested:true,
    noApiKeyRead:true,activeTunnelChanged:false,coreChanged:false,
    workerGrantIssued:false,fullAccessActive:false
  }));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(error=>{
    console.error(error?.code??'RC012_OWNER_TUNNEL_TRUST_ENROLL_FAILED');
    process.exitCode=2;
  });
