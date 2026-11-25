import path from 'node:path';
import { WorkflowStore } from '../src/workflow-store.mjs';
import { createWorkflowStoreWorkerIdentityRegistry } from '../src/worker-identity-store.mjs';

let input='';
for await (const chunk of process.stdin) input+=chunk;
const payload=JSON.parse(input);
if(!payload || typeof payload.root!=='string' || typeof payload.profileId!=='string'
  || !payload.envelope || typeof payload.envelope!=='object') {
  throw new Error('WORKER_IDENTITY_CHILD_INPUT_INVALID');
}
const root=path.resolve(payload.root);
const profileId=payload.profileId;
const options={
  directory:path.join(root,'profile-'+profileId),
  rootLeaseDirectory:path.join(root,'shared','root-leases'),
  allowedRoots:[root],
  device:'worker-identity-test',
  configSha256:'1'.repeat(64),
  authority:{profileId}
};
const store=new WorkflowStore(options);
try{
  const registry=createWorkflowStoreWorkerIdentityRegistry(store);
  const registered=registry.register(payload.envelope,{
    expectedPreviousBindingId:null,expectedPreviousState:'EMPTY'
  });
  const status=store.workerIdentityJournalStatus();
  process.stdout.write(JSON.stringify({registered,status}));
}finally{store.close();}
