import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkflowTools } from '../src/workflow-tools.mjs';
import { createConversationController } from '../src/conversation-continuation.mjs';

function fixture(){
  const base=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc-workflow-conversation-')));
  const project=path.join(base,'project');fs.mkdirSync(project,{recursive:true});
  const workflowState=path.join(base,'workflow-state');
  const conversationState=path.join(base,'conversation-state');
  const config={durableWorkflows:{enabled:true,directory:workflowState}};
  const common={config,roots:[project],device:'fixture',configSha256:'0'.repeat(64),
    lookup:name=>({name,inputSchema:{type:'object'}}),validateSchema:()=>[],dispatch:async()=>({ok:true})};
  return {base,project,workflowState,conversationState,common,dispose:()=>fs.rmSync(base,{recursive:true,force:true})};
}
const waitFor=async(fn,{timeout=2500,interval=20}={})=>{
  const end=Date.now()+timeout;
  while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,interval));}
  return null;
};

test('workflow NEEDS_CHAT atomically pauses, records evidence/Brain, queues once, and resume cancels stale pending delivery',async()=>{
  const f=fixture();
  const controller=createConversationController({
    directory:f.conversationState,scope:'test',platform:'win32',helperPath:'unused',
    invokeUia:async request=>request.action==='status'
      ? {state:'READY',code:'CHAT_TAB_FOUND',processId:1}
      : {state:'DEFERRED',code:'WAITING_FOR_CHAT_TAB'}
  });
  const tools=createWorkflowTools({...f.common,conversationController:controller});
  try{
    await controller.bind({projectId:'proj',root:f.project,tabTitle:'Project Chat'});
    const created=await tools.execute('workflow_create',{
      id:'proj',root:f.project,goal:'Complete project',acceptance:['Evidence proves completion'],
      steps:[{id:'solve',title:'Run solver'}]
    });
    fs.writeFileSync(path.join(f.project,'solver.log'),'converged=true\n');
    const handed=await tools.execute('workflow_needs_chat',{
      id:'proj',expectedRevision:created.state.revision,eventKey:'wf:proj:solve:needs-chat',
      reason:'Scientific interpretation required',summary:'Solver completed; validate convergence before next mutation.',
      files:['solver.log']
    });
    assert.equal(handed.state.lifecycleState,'WAITING');
    assert.equal(handed.state.control.intent,'PAUSED');
    assert.equal(handed.state.scheduler.lastFailureCode,'NEEDS_CHAT');
    assert.equal(handed.state.pendingChatHandoff.eventKey,'wf:proj:solve:needs-chat');
    assert.equal(handed.state.pendingChatHandoff.evidence[0].path,'solver.log');
    assert.equal(handed.handoffPending,false);

    const brain=path.join(f.project,'PROJECT_BRAIN.md');
    assert.equal(fs.existsSync(brain),true);
    assert.match(fs.readFileSync(brain,'utf8'),/Solver completed; validate convergence/i);

    // handoff() already scheduled this attempt; wait for its completion,
    // not for a host-load-sensitive wall-clock polling window.
    await controller.drain();
    const deferred=(await controller.status('proj')).pending.find(
      x=>x.eventKey==='wf:proj:solve:needs-chat'&&x.state==='DEFERRED');
    assert.ok(deferred);
    assert.equal(deferred.lastCode,'WAITING_FOR_CHAT_TAB');

    const resumed=await tools.execute('workflow_control',{
      id:'proj',expectedRevision:handed.state.revision,action:'resume',reason:'Reasoning turn completed'
    });
    assert.equal(resumed.state.lifecycleState,'RESUMING');
    assert.equal(resumed.state.pendingChatHandoff,null);
    assert.equal(resumed.state.lastChatHandoff.eventKey,'wf:proj:solve:needs-chat');
    const after=await controller.status('proj');
    assert.equal(after.pending.some(x=>x.eventKey==='wf:proj:solve:needs-chat'),false);
  }finally{await tools.close();await controller.close();f.dispose();}
});

test('resume fails closed while same-conversation handoff is actively claimed',async()=>{
  const f=fixture();
  let releaseSend;
  const sendGate=new Promise(resolve=>{releaseSend=resolve;});
  const controller=createConversationController({
    directory:f.conversationState,scope:'test',platform:'win32',helperPath:'unused',
    invokeUia:async request=>{
      if(request.action==='status')return {state:'READY',code:'CHAT_TAB_FOUND',processId:1};
      await sendGate;return {state:'SENT',code:'UI_ACKNOWLEDGED'};
    }
  });
  const tools=createWorkflowTools({...f.common,conversationController:controller});
  try{
    await controller.bind({projectId:'proj',root:f.project,tabTitle:'Project Chat'});
    const created=await tools.execute('workflow_create',{
      id:'proj',root:f.project,goal:'Complete project',acceptance:['Done'],steps:[{id:'a',title:'A'}]
    });
    const handed=await tools.execute('workflow_needs_chat',{
      id:'proj',expectedRevision:created.state.revision,eventKey:'wf:proj:claimed',
      reason:'Decision required',summary:'Need reasoning before continuation'
    });
    const claimed=await waitFor(async()=>{
      const status=await controller.status('proj');
      return status.pending.find(x=>x.eventKey==='wf:proj:claimed'&&x.state==='CLAIMED');
    });
    assert.ok(claimed);
    await assert.rejects(tools.execute('workflow_control',{
      id:'proj',expectedRevision:handed.state.revision,action:'resume',reason:'too early'
    }),/CONVERSATION_CLAIM_BUSY/);
    const still=await tools.execute('workflow_get',{id:'proj'});
    assert.equal(still.state.lifecycleState,'WAITING');
    assert.equal(still.state.pendingChatHandoff.eventKey,'wf:proj:claimed');

    releaseSend();
    await controller.drain();
    const sent=await controller.status('proj');
    assert.equal(sent.store.counts.SENT,1);
    assert.equal(sent.pending.some(x=>x.eventKey==='wf:proj:claimed'),false);
    const resumed=await tools.execute('workflow_control',{
      id:'proj',expectedRevision:still.state.revision,action:'resume',reason:'handoff already delivered'
    });
    assert.equal(resumed.state.lifecycleState,'RESUMING');
  }finally{releaseSend?.();await tools.close();await controller.close();f.dispose();}
});

test('pending workflow handoff is recovered after workflow adapter restart without duplicate conversation event',async()=>{
  const f=fixture();
  const realController=createConversationController({
    directory:f.conversationState,scope:'test',platform:'win32',helperPath:'unused',
    invokeUia:async request=>request.action==='status'
      ? {state:'READY',code:'CHAT_TAB_FOUND',processId:1}
      : {state:'DEFERRED',code:'WAITING_FOR_CHAT_TAB'}
  });
  await realController.bind({projectId:'proj',root:f.project,tabTitle:'Project Chat'});
  let failOnce=true;
  const flakyController={
    validateContinuation:value=>realController.validateContinuation(value),
    handoff:value=>{if(failOnce){failOnce=false;throw new Error('INJECTED_OUTBOX_FAILURE');}return realController.handoff(value);},
    cancelEvent:(...args)=>realController.cancelEvent(...args)
  };
  let first=createWorkflowTools({...f.common,conversationController:flakyController});
  try{
    const created=await first.execute('workflow_create',{
      id:'proj',root:f.project,goal:'Complete project',acceptance:['Done'],steps:[{id:'a',title:'A'}]
    });
    const handed=await first.execute('workflow_needs_chat',{
      id:'proj',expectedRevision:created.state.revision,eventKey:'wf:proj:restart',
      reason:'Restart recovery test',summary:'Persist before enqueue'
    });
    assert.equal(handed.handoffPending,true);
    assert.equal((await realController.status('proj')).pending.length,0);
    await first.close();first=null;

    const second=createWorkflowTools({...f.common,conversationController:realController});
    try{
      const recovered=await waitFor(async()=>{
        const status=await realController.status('proj');
        return status.pending.find(x=>x.eventKey==='wf:proj:restart');
      },{timeout:30000,interval:50});
      assert.ok(recovered,'workflow chat handoff was not recovered within 30000ms; status='+JSON.stringify(await realController.status('proj')));
      await second.execute('workflow_scheduler_tick',{});
      const status=await realController.status('proj');
      assert.equal(status.pending.filter(x=>x.eventKey==='wf:proj:restart').length,1);
    }finally{await second.close();}
  }finally{if(first)await first.close();await realController.close();f.dispose();}
});
