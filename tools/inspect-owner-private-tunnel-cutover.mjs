// Owner-local, no-write inspection of a proposed protected MCP main-channel
// cutover. Never logs or stores the existing API key, Tunnel ID or YAML.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {planOwnerPrivateTunnelCutover} from './plan-owner-private-tunnel-cutover.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
function regular(file){
  const s=fs.lstatSync(file);
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1
    ||s.size<1||s.size>16384)fail('RC012_OWNER_LOCAL_PROFILE_OR_CERT_NOT_REGULAR');
  if(process.platform==='linux'&&(s.mode&0o077)!==0)
    fail('RC012_OWNER_LOCAL_PROFILE_OR_CERT_NOT_PRIVATE');
}
async function main(){
  const raw=process.argv.slice(2);
  if(raw.length<1||raw.length>2
    ||!raw.some(v=>/^--target-port=[0-9]{4,5}$/.test(v))
    ||raw.some(v=>!/^--(?:target-port|profile-name)=/.test(v))
    ||new Set(raw.map(v=>v.split('=')[0])).size!==raw.length)
    fail('RC012_OWNER_CUTOVER_ARGUMENTS_INVALID');
  const port=Number(raw.find(v=>v.startsWith('--target-port='))
    .slice('--target-port='.length));
  const suppliedName=raw.find(v=>v.startsWith('--profile-name='))
    ?.slice('--profile-name='.length);
  const profileName=suppliedName??(process.platform==='win32'
    ?'chatgpt-remote-commander':null);
  if(typeof profileName!=='string'
    ||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profileName)
    ||profileName==='.'||profileName==='..')
    fail('RC012_OWNER_EXACT_PROFILE_REQUIRED');
  if(!Number.isSafeInteger(port)||port<1024||port>65535)
    fail('RC012_OWNER_CUTOVER_PORT_INVALID');
  // A different ChatGPT account/profile may NEVER inherit the primary
  // Tunnel's mTLS client identity just because "default" credentials exist.
  // Historical single-profile Emad is compatible with default only while
  // the new canonical profile does not also exist.
  const exactPairNamespace=profileDir=>{
    if(profileName==='chatgpt-remote-commander')return 'default';
    if(profileName==='Emad'&&!fs.existsSync(
      path.join(profileDir,'chatgpt-remote-commander.yaml')))return 'default';
    return profileName;
  };
  let profile,certDir;
  if(process.platform==='win32'){
    if(!path.isAbsolute(process.env.APPDATA??''))fail('RC012_OWNER_APPDATA_REQUIRED');
    profile=path.join(process.env.APPDATA,'tunnel-client',profileName+'.yaml');
    certDir=path.join(process.env.APPDATA,'ChatGPTRemoteCommander','private-pair',
      exactPairNamespace(path.dirname(profile)));
  }else if(process.platform==='linux'){
    const home=process.env.HOME;
    if(typeof home!=='string'||!path.isAbsolute(home))
      fail('RC012_OWNER_HOME_REQUIRED');
    profile=path.join(home,'.config','tunnel-client',profileName+'.yaml');
    certDir=path.join(home,'.config','chatgpt-remote-commander','private-pair',
      exactPairNamespace(path.dirname(profile)));
  }else fail('RC012_OWNER_CUTOVER_OS_UNSUPPORTED');
  regular(profile);
  const ownerUid=process.getuid?.();
  if(ownerUid!==undefined&&fs.lstatSync(profile).uid!==ownerUid)
    fail('RC012_OWNER_PROFILE_UID_MISMATCH');
  const parent=fs.lstatSync(path.dirname(profile));
  if(!parent.isDirectory()||parent.isSymbolicLink()
    ||(ownerUid!==undefined&&(parent.uid!==ownerUid||(parent.mode&0o077)!==0)))
    fail('RC012_OWNER_PROFILE_DIR_NOT_PRIVATE');
  if(!fs.existsSync(certDir))
    fail('RC012_OWNER_PAIR_PROFILE_ISOLATION_REQUIRED');
  const dir=fs.lstatSync(certDir);
  if(!dir.isDirectory()||dir.isSymbolicLink()
    ||(ownerUid!==undefined&&(dir.uid!==ownerUid||(dir.mode&0o077)!==0)))
    fail('RC012_OWNER_CERT_DIRECTORY_INVALID');
  const clientCertPath=path.join(certDir,'client.crt');
  const clientKeyPath=path.join(certDir,'client.key');
  const clientCaPath=path.join(certDir,'ca.crt');
  for(const file of [clientCertPath,clientKeyPath,clientCaPath])regular(file);
  const currentYaml=fs.readFileSync(profile,'utf8');
  const plan=planOwnerPrivateTunnelCutover({
    currentYaml,protectedPort:port,clientCertPath,clientKeyPath,clientCaPath
  });
  if(fs.readFileSync(profile,'utf8')!==currentYaml)
    fail('RC012_OWNER_TUNNEL_CHANGED_DURING_PLAN');
  const {candidateYaml,...evidence}=plan;
  process.stdout.write(JSON.stringify({
    ...evidence,profileName,
    candidateBytes:Buffer.byteLength(candidateYaml,'utf8'),
    originalTlsTarget:false,candidateTlsTarget:true,
    candidateYamlIncluded:false,
    ownerCredentialsInOutput:false
  })+'\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(error=>{console.error(error?.code??'RC012_OWNER_CUTOVER_PLAN_FAILED');process.exitCode=1;});
