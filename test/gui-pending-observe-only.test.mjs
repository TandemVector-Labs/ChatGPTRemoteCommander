import test from 'node:test';
import assert from 'node:assert/strict';
import {createGuiController} from '../src/gui-tools-windows.mjs';

const config=()=>({config:{powerMode:{enabled:true,guiControl:{
  enabled:true,allowScreenshot:true,allowMouse:true,allowKeyboard:true,
  allowWindowFocus:true,ownerAuthorizedTakeover:true
},capabilityProfile:{tier:'FULL_POWER',explicitlyAuthorized:true}}}});
const image=()=>({ok:true,
  data:Buffer.from('89504e470d0a1a0a00000000','hex').toString('base64'),
  mimeType:'image/png',width:800,height:600,
  snapshot:{screenIndex:0,bounds:{left:0,top:0,width:800,height:600},
    foreground:'test-window',processId:123}
});
function fixture({platform='win32',pending=true,unreadable=false,stop=false,nativeAvailable=true}={}){
  const calls=[];let resolved=0,beginCalled=0,activePending=pending,activeUnreadable=unreadable,activeStop=stop;
  const incident={id:'disposable-e27-incident-00001',
    tool:'gui_mouse_click',startedUtc:'2026-10-20T00:00:00.000Z'};
  const store={
    pending:async()=>{if(activeUnreadable)throw new Error('STORAGE_UNAVAILABLE');return activePending?incident:null;},
    begin:async()=>{beginCalled++;throw new Error('GUI_INCIDENT_UNRESOLVED');},
    resolve:async()=>{resolved++;throw new Error('UNAUTHORIZED_RESOLUTION');}
  };
  const invoke=async r=>{
    calls.push(r.action);
    if(r.action==='status')return {ok:true,available:nativeAvailable};
    if(r.action==='screenshot')return image();
    if(r.action==='cursorPosition')return {ok:true,x:12,y:20};
    if(r.action==='listWindows')return {ok:true,windows:[]};
    throw new Error('NATIVE_INPUT_WOULD_HAVE_BEEN_SENT');
  };
  const controller=createGuiController({
    platform,isStopped:async()=>activeStop,incidentStore:store,invoke,
    closeInvoke:()=>{},now:()=>1000,token:()=>('d'.repeat(48))
  });
  const run=(name,params={})=>controller.execute(config(),name,params);
  return{run,calls,incident,setPending:value=>{activePending=value;},setUnreadable:value=>{activeUnreadable=value;},setStop:value=>{activeStop=value;},
    counts:()=>({resolved,beginCalled})};
}

for(const platform of ['win32','linux']){
  test(platform+' permits observation only with an unresolved native incident',async()=>{
    const f=fixture({platform});
    const status=await f.run('gui_status');
    assert.equal(status.enabled,true);
    assert.equal(status.available,false);
    assert.equal(status.readOnlyAvailable,true);
    assert.equal(status.inputAvailable,false);
    assert.equal(status.incidentPending,true);
    assert.equal(status.uncertain,true);
    assert.equal(status.reason,'GUI_INCIDENT_REVIEW_REQUIRED');
    assert.deepEqual(status.incident,f.incident);
    await assert.rejects(f.run('gui_session_begin',{
      mode:'takeover',explicitUserAuthorization:'Not enough to clear pending incident'
    }),/GUI_INCIDENT_REVIEW_REQUIRED/);
    const lease=await f.run('gui_session_begin',{mode:'observe'});
    assert.equal(lease.mode,'observe');
    assert.equal(lease.interactiveTakeover,false);
    assert.equal(lease.authorization,'incident-observe-only');
    const snap=await f.run('gui_screenshot',{lease:lease.lease});
    assert.equal(snap.__structuredContent.mimeType,'image/png');
    await assert.rejects(f.run('gui_mouse_click',{
      lease:lease.lease,frame:snap.__structuredContent.frame,x:1,y:1
    }),/GUI_INCIDENT_REVIEW_REQUIRED/);
    await f.run('gui_session_renew',{lease:lease.lease,ttlSeconds:60});
    await f.run('gui_session_end',{lease:lease.lease});
    assert.deepEqual(f.counts(),{resolved:0,beginCalled:0});
    assert.deepEqual(f.calls,['status','status','screenshot']);
    assert.equal((await f.run('gui_status')).incidentPending,true);
  });
  test(platform+' demotes an existing takeover lease if an external incident appears',async()=>{
    const f=fixture({platform,pending:false});
    const auth=await f.run('gui_session_begin',{
      mode:'takeover',explicitUserAuthorization:'Disposable test-only takeover approval'
    });
    assert.equal(auth.mode,'takeover');
    f.setPending(true);
    const status=await f.run('gui_status');
    assert.equal(status.incidentPending,true);
    assert.equal(status.inputAvailable,false);
    await f.run('gui_session_renew',{lease:auth.lease});
    const observed=await f.run('gui_screenshot',{lease:auth.lease});
    f.setPending(false);
    await assert.rejects(f.run('gui_mouse_click',{
      lease:auth.lease,frame:observed.__structuredContent.frame,x:1,y:1
    }),/GUI_TAKEOVER_NOT_AUTHORIZED/);
    assert.deepEqual(f.counts(),{resolved:0,beginCalled:0});
    await f.run('gui_session_end',{lease:auth.lease});
  });
  for (const outage of ['store-unreadable','local-stop']) {
    test(platform+' revokes preexisting takeover rights after '+outage+' clears',async()=>{
      const f=fixture({platform,pending:false});
      const old=await f.run('gui_session_begin',{
        mode:'takeover',explicitUserAuthorization:'Disposable test-only approval'
      });
      assert.equal(old.mode,'takeover');
      if (outage==='store-unreadable')f.setUnreadable(true);
      else f.setStop(true);
      const status=await f.run('gui_status');
      assert.equal(status.available,false);
      if (outage==='store-unreadable')f.setUnreadable(false);
      else f.setStop(false);
      const shot=await f.run('gui_screenshot',{lease:old.lease});
      await assert.rejects(f.run('gui_key_press',{
        lease:old.lease,frame:shot.__structuredContent.frame,keys:['A']
      }),/GUI_TAKEOVER_NOT_AUTHORIZED/);
      assert.deepEqual(f.counts(),{resolved:0,beginCalled:0});
    });
  }
  test(platform+' fails closed when incident evidence cannot be read',async()=>{
    const f=fixture({platform,unreadable:true});
    const status=await f.run('gui_status');
    assert.equal(status.available,false);
    assert.equal(status.incidentStoreUnavailable,true);
    await assert.rejects(f.run('gui_session_begin',{mode:'observe'}),/GUI_INCIDENT_STORAGE_UNAVAILABLE/);
    assert.deepEqual(f.calls,[]);
    assert.deepEqual(f.counts(),{resolved:0,beginCalled:0});
  });
  test(platform+' respects local STOP even for incident observation',async()=>{
    const f=fixture({platform,stop:true});
    const status=await f.run('gui_status');
    assert.equal(status.available,false);
    assert.equal(status.reason,'LOCAL_GUI_STOP');
    await assert.rejects(f.run('gui_session_begin',{mode:'observe'}),/GUI_LOCAL_STOP/);
    assert.deepEqual(f.calls,[]);
  });
}
