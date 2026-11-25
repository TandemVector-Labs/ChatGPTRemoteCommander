// Isolated subprocess adapter for testing the REAL V1-06 filesystem claim.
// Synthetic callbacks are deliberately not production ChatGPT authentication.
import path from 'node:path';
import {appendFile,stat} from 'node:fs/promises';
import {createAsyncOperationTools} from '../src/async-operations.mjs';
import {DeliveryStore} from '../src/delivery-store.mjs';

const [root,operationId,marker,gate]=process.argv.slice(2);
if(!root||!/^[a-f0-9-]{36}$/.test(operationId)||!marker||!gate)
  throw new Error('INVALID_CROSS_PROCESS_TEST_ARGUMENTS');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const store=new DeliveryStore({
  directory:path.join(root,'cross-process-store-'+process.pid),scope:'scope1'
});
const protectedDeliveryOrigin={
  admitOperation:async()=>{throw Error('CROSS_PROCESS_TEST_CANNOT_ADMIT');},
  authorizeReplay:async()=>true,
  authorizeAccess:async()=>true,
  authorizeHandoff:async()=>true,
  receiptForTerminal:async()=> 'cross-process-test-receipt',
  publisher:{publish:async()=>({deliveryId:'cross-process-source-delivery'})},
  verifyHandoffReceipt:async()=>true,
  dispatchHandoff:async request=>{
    await appendFile(marker,JSON.stringify({pid:process.pid,key:request.handoffKey})+'\n');
    for(let i=0;i<300;i++){
      try{await stat(gate);break;}
      catch(e){if(e?.code!=='ENOENT')throw e;}
      if(i===299)throw Error('CROSS_PROCESS_GATE_TIMEOUT');
      await sleep(20);
    }
    return {
      handoffId:'cross-process-verified-queue',
      state:'QUEUED',
      handoffKey:request.handoffKey,
      deliveryId:request.deliveryId,
      originAdmissionId:request.originAdmissionId
    };
  }
};
let manager=null;
try{
  manager=createAsyncOperationTools({
    config:{instance:{profile:'test'},asyncOperations:{
      enabled:true,stateDir:path.join(root,'operations'),
      maxOutputBytes:65536,deliveryReconcileMs:60000
    }},
    prepare:async()=>{throw Error('CROSS_PROCESS_TEST_CANNOT_PREPARE');},
    deliveryStore:store,protectedDeliveryOrigin
  });
  const state=await manager.execute('operation_status',{operationId});
  process.stdout.write(JSON.stringify({
    status:state.status,handoffId:state.conversationHandoffId??null,
    pending:state.conversationHandoffPending??false
  })+'\n');
}finally{
  try{await manager?.close();}finally{store.close();}
}
