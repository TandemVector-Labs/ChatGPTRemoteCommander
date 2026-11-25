import fs from 'node:fs';
import {V2GrantRegistry} from '../src/v2-grant-registry.mjs';
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const registry=new V2GrantRegistry({
  directory:input.directory,now:()=>input.now,authorizeAdministration:()=>true
});
async function main(){
  try{
    const grant=await registry.changeWorkerGrant({
      workerContext:input.workerContext,status:'ACTIVE',expectedRevision:0,
      actor:'owner-1',reason:'owner approved worker',expiresAtMs:input.expiresAtMs
    });
    process.stdout.write(JSON.stringify({status:'won',revision:grant.revision}));
  }catch(error){
    if(error?.code==='V2_WORKER_GRANT_REVISION_CONFLICT')
      process.stdout.write(JSON.stringify({status:'conflict',code:error.code}));
    else{
      process.stderr.write(String(error?.stack??error));
      process.exitCode=1;
    }
  }finally{registry.close();}
}
await main();
