import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { migrateCapabilityConfig, normalizeCapabilityProfile } from '../src/capability-profile.mjs';
import { applyProjectRunnerConfig } from '../src/project-runner-config.mjs';
import { deliveryLocation, stableDeliveryScope } from '../src/delivery-store.mjs';

function parse(argv){
  const o={disableCapabilities:[],enableCapabilities:[],allowedRoots:[],allowedPrograms:[],mode:'preserve',requestGui:undefined};
  for(let i=0;i<argv.length;i++){
    const a=argv[i],v=argv[++i];if(v===undefined)throw new Error('CANDIDATE_CONFIG_ARGUMENT');
    if(a==='--default')o.defaultPath=v;
    else if(a==='--existing')o.existingPath=v;
    else if(a==='--output')o.outputPath=v;
    else if(a==='--profile-id')o.profileId=v;
    else if(a==='--port')o.port=Number(v);
    else if(a==='--state-dir')o.stateDirectory=v;
    else if(a==='--workflow-dir')o.workflowDirectory=v;
    else if(a==='--mode')o.mode=v;
    else if(a==='--gui')o.requestGui=v==='on'?true:v==='off'?false:undefined;
    else if(a==='--disable-capability')o.disableCapabilities.push(v);
    else if(a==='--enable-capability')o.enableCapabilities.push(v);
    else if(a==='--allowed-root')o.allowedRoots.push(v);
    else if(a==='--allowed-program')o.allowedPrograms.push(v);
    else if(a==='--device-name')o.deviceName=v;
    else if(a==='--backup-root')o.backupRoot=v;
    else if(a==='--provider-root')o.providerRoot=v;
    else if(a==='--browser-executable')o.browserExecutable=v;
    else if(a==='--browser-profile-root')o.browserProfileRoot=v;
    else if(a==='--delivery-root')o.deliveryRoot=v;
    else if(a==='--delivery-directory')o.deliveryDirectory=v;
    else if(a==='--delivery-scope')o.deliveryScope=v;
    else throw new Error('CANDIDATE_CONFIG_ARGUMENT');
  }
  for(const k of ['defaultPath','outputPath','profileId','port','stateDirectory'])if(!o[k])throw new Error('CANDIDATE_CONFIG_REQUIRED');
  if(!Number.isSafeInteger(o.port)||o.port<1024||o.port>65535)throw new Error('CANDIDATE_CONFIG_PORT');
  return o;
}
function atomic(file,text){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=file+'.tmp-'+process.pid+'-'+Date.now().toString(36);
  fs.writeFileSync(tmp,text,{encoding:'utf8',mode:0o600});fs.renameSync(tmp,file);
}
const a=parse(process.argv.slice(2));
const defaults=JSON.parse(fs.readFileSync(a.defaultPath,'utf8'));
const existing=a.existingPath ? JSON.parse(fs.readFileSync(a.existingPath,'utf8')) : null;
const workflowDirectory=a.workflowDirectory ?? existing?.durableWorkflows?.directory ?? path.join(a.stateDirectory,'workflows');
if(!['preserve','full','standard'].includes(a.mode))throw new Error('CANDIDATE_CONFIG_MODE');
const migrated=migrateCapabilityConfig({
  defaultConfig:defaults,existingConfig:existing,profileId:a.profileId,workflowDirectory,
  requestPower:a.mode==='full',requestStandard:a.mode==='standard',requestGui:a.requestGui,
  disableCapabilities:a.disableCapabilities,enableCapabilities:a.enableCapabilities
});
let config=migrated.config;
if(a.allowedRoots.length)config.allowedRoots=[...a.allowedRoots];
if(a.allowedPrograms.length)config.allowedPrograms=[...a.allowedPrograms];
if(a.deviceName)config.deviceName=a.deviceName;
config.host='127.0.0.1';
config.port=a.port;
config.runtimeState=path.join(a.stateDirectory,'mcp-runtime.json');
config.auditLog=path.join(a.stateDirectory,'audit.jsonl');
if(a.backupRoot){config.powerMode??={};config.powerMode.backupRoot=a.backupRoot;}
if(a.browserExecutable){config.powerMode??={};config.powerMode.browserControl??={};config.powerMode.browserControl.executable=path.resolve(a.browserExecutable);}
if(a.browserProfileRoot){config.powerMode??={};config.powerMode.browserControl??={};config.powerMode.browserControl.profileRoot=path.resolve(a.browserProfileRoot);}
config.durableWorkflows ??={};
if(config.durableWorkflows.enabled===true){
  config.durableWorkflows.directory=workflowDirectory;
  if(a.providerRoot) config.durableWorkflows.rootLeaseDirectory=path.join(path.resolve(a.providerRoot),'shared','root-leases');
}
const runner=applyProjectRunnerConfig(config);
config=runner.config;
config.capabilityProfile=normalizeCapabilityProfile(config.capabilityProfile,config,{id:a.profileId,legacyExplicit:!!existing});
if(a.profileId!=='default'){
  config.instance={profile:a.profileId,isolated:true};
}else{
  config.instance={profile:'default',isolated:false};
}
if ((a.deliveryDirectory && !a.deliveryScope) || (!a.deliveryDirectory && a.deliveryScope)) {
  throw new Error('CANDIDATE_CONFIG_DELIVERY_PAIR');
}
if (a.deliveryDirectory && a.deliveryScope) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(a.deliveryScope)) throw new Error('CANDIDATE_CONFIG_DELIVERY_SCOPE');
  config.durableDelivery={...(config.durableDelivery??{}),directory:path.resolve(a.deliveryDirectory),scope:a.deliveryScope};
} else if (existing && a.existingPath) {
  const prior=deliveryLocation(existing,a.existingPath);
  config.durableDelivery={...(config.durableDelivery??{}),directory:prior.directory,scope:prior.scope};
} else {
  const scope=stableDeliveryScope(config,a.profileId);
  config.durableDelivery={...(config.durableDelivery??{}),
    directory:path.join(a.deliveryRoot ? path.resolve(a.deliveryRoot) : path.join(os.homedir(),'.chatgpt-remote-commander','delivery'),'profiles',scope),
    scope};
}
const text=JSON.stringify(config,null,2)+'\n';
atomic(a.outputPath,text);
const sha256=createHash('sha256').update(text).digest('hex');
console.log(JSON.stringify({
  ok:true,profile:a.profileId,port:a.port,configSha256:sha256,
  capabilityProfile:config.capabilityProfile,powerMode:config.powerMode,durableWorkflows:config.durableWorkflows,
  autoUpdate:config.autoUpdate,projectRunner:{status:runner.status,provider:runner.provider}
}));
