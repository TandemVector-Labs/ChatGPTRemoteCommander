import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLinuxGuiInputCaptureAdapter, classifyLinuxOwnerApprovalResult } from '../src/gui-linux-input-capture-provider.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const session={ownerPrincipal:'uid:1000',sessionId:'test-session',seatId:'seat0',
  displayId:'wayland:wayland-0',interactive:true,ownerAuthenticated:true};
const descriptor={providerId:'linux-xdg-input-capture-v1',platform:'linux',
  transport:'xdg-input-capture-v1+libei',session,
  activityEvidenceSource:'physical',activityEvidenceIncludesSynthetic:false,
  capabilities:{observe:true,screenshot:true,activityDetection:true,
    physicalInputProtection:true,emergencyRelease:true,pointer:true,keyboard:true,
    semanticInvoke:true,isolatedDesktop:false}};
function fakeSpawn({approvalCode=0,eventOnce=false}={}) {
  const calls=[];
  const spawnImpl=(command,args,options)=>{
    calls.push({command,args,options});
    if(command==='zenity'){
      const proc=new EventEmitter(); proc.kill=()=>{};
      setImmediate(()=>proc.emit('close',approvalCode,null)); return proc;
    }
    const proc=new EventEmitter();
    proc.stdout=new PassThrough(); proc.stderr=new PassThrough();
    let buffer='',eventPending=eventOnce;
    proc.stdin=new Writable({
      write(chunk,_encoding,callback){
        buffer+=chunk.toString('utf8');
        for(;;){
          const index=buffer.indexOf('\n'); if(index<0)break;
          const req=JSON.parse(buffer.slice(0,index)); buffer=buffer.slice(index+1);
          let result={};
          if(req.action==='describeSession') result={descriptor,displayEnv:{
            XDG_RUNTIME_DIR:'/run/user/1000',WAYLAND_DISPLAY:'wayland-0',
            DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/1000/bus'
          }};
          else if(req.action==='acquireProtection') result={
            ok:true,receipt:{active:true,kind:'NATIVE_PHYSICAL_INPUT_PROTECTION',
              providerId:descriptor.providerId,sessionId:session.sessionId,leaseId:'lease-fixture',
              releaseOnAgentExit:true,releaseOnEmergency:true,expiresAtMs:Date.now()+60000},
            activityEvidence:{source:'physical',reliable:true,excludesSyntheticInput:true,
              observedAtMs:Date.now(),idleMs:0}
          };
          else if(req.action==='releaseProtection') result={ok:true,released:true};
          else if(req.action==='events') {
            result={events:eventPending?[{event:'PORTAL_DEACTIVATED'}]:[],active:!eventPending};
            eventPending=false;
          } else if(req.action==='stop') result={stopped:true};
          setImmediate(()=>proc.stdout.write(JSON.stringify({id:req.id,ok:true,result})+'\n'));
        }
        callback();
      }
    });
    proc.kill=()=>setImmediate(()=>proc.emit('close',0,null));
    setImmediate(()=>proc.stdout.write(JSON.stringify({ready:true,protocol:1})+'\n'));
    return proc;
  };
  return {spawnImpl,calls};
}

test('Zenity only admits an unrejected prompt after the measured 60-second monotonic deadline',()=>{
  assert.deepEqual(classifyLinuxOwnerApprovalResult(0,10),{explicitOwnerApproval:true,approvalDenied:false});
  assert.deepEqual(classifyLinuxOwnerApprovalResult(1,60000),{explicitOwnerApproval:false,approvalDenied:true});
  assert.throws(()=>classifyLinuxOwnerApprovalResult(5,59999),/GUI_OWNER_APPROVAL_TIMEOUT_NOT_ELAPSED/);
  const elapsed=classifyLinuxOwnerApprovalResult(5,60000);
  assert.equal(elapsed.approvalPromptVisible,true);
  assert.equal(elapsed.approvalPromptElapsedMs,60000);
  assert.throws(()=>classifyLinuxOwnerApprovalResult(2,60000),/GUI_OWNER_APPROVAL_UI_FAILED/);
  assert.throws(()=>classifyLinuxOwnerApprovalResult(5,NaN),/GUI_OWNER_APPROVAL_UI_FAILED/);
});

test('Linux InputCapture adapter validates Linux and absolute project root',()=>{
  if(process.platform==='linux'){
    assert.throws(()=>createLinuxGuiInputCaptureAdapter({projectRoot:'relative'}),/GUI_NATIVE_PROJECT_ROOT_REQUIRED/);
    assert.equal(typeof createLinuxGuiInputCaptureAdapter({projectRoot:root}).describeSession,'function');
  } else {
    assert.throws(()=>createLinuxGuiInputCaptureAdapter({projectRoot:root}),/GUI_LINUX_ONLY/);
  }
});

test('Linux adapter discovers owner descriptor and never claims pre-capture physical idle', {skip:process.platform!=='linux'}, async()=>{
  const fake=fakeSpawn();
  const adapter=createLinuxGuiInputCaptureAdapter({projectRoot:root,spawnImpl:fake.spawnImpl});
  const found=await adapter.describeSession();
  assert.equal(found.providerId,descriptor.providerId);
  assert.deepEqual(found.session,session);
  assert.equal(await adapter.getPhysicalActivityEvidence(),null);
  await adapter.close();
});

test('early Zenity timeout-like exit cannot auto-approve; explicit denial remains denial', {skip:process.platform!=='linux'}, async()=>{
  const timed=fakeSpawn({approvalCode:5});
  const a=createLinuxGuiInputCaptureAdapter({projectRoot:root,spawnImpl:timed.spawnImpl});
  await a.describeSession();
  await assert.rejects(a.requestOwnerApproval({timeoutMs:60000,requestedInput:{pointer:true,keyboard:true}}),
    /GUI_OWNER_APPROVAL_TIMEOUT_NOT_ELAPSED/);
  assert.equal(timed.calls.some(c=>c.command==='zenity'&&c.args.includes('--timeout')),true);
  await a.close();

  const denied=fakeSpawn({approvalCode:1});
  const b=createLinuxGuiInputCaptureAdapter({projectRoot:root,spawnImpl:denied.spawnImpl});
  await b.describeSession();
  const no=await b.requestOwnerApproval({timeoutMs:60000,requestedInput:{pointer:true,keyboard:true}});
  assert.equal(no.approvalDenied,true);
  await b.close();
});

test('Linux adapter grants and revokes on Portal Deactivated', {skip:process.platform!=='linux'}, async()=>{
  const fake=fakeSpawn({eventOnce:true});
  const adapter=createLinuxGuiInputCaptureAdapter({projectRoot:root,spawnImpl:fake.spawnImpl});
  let emergency=null;
  adapter.subscribeEmergency(event=>{emergency=event;});
  await adapter.describeSession();
  const grant=await adapter.acquireProtection({requestedInput:{pointer:true,keyboard:true},ttlSeconds:60});
  assert.equal(grant.ok,true);
  assert.equal(grant.receipt.kind,'NATIVE_PHYSICAL_INPUT_PROTECTION');
  assert.equal(grant.activityEvidence.source,'physical');
  await new Promise(resolve=>setTimeout(resolve,350));
  assert.equal(emergency,'PORTAL_DEACTIVATED');
  const released=await adapter.releaseProtection({leaseId:grant.receipt.leaseId,reason:'PORTAL_DEACTIVATED'});
  assert.equal(released.ok,true);
  await adapter.close();
});

test('Linux Portal and EIS capability scopes exactly match requested pointer/keyboard access', {skip:process.platform!=='linux'}, ()=>{
  const python = "import importlib.machinery,importlib.util,sys\n" +
    "loader=importlib.machinery.SourceFileLoader('rc_capture',sys.argv[1]);spec=importlib.util.spec_from_loader(loader.name,loader);m=importlib.util.module_from_spec(spec);loader.exec_module(m)\n" +
    "assert m.resolve_capture_scope({'pointer':True,'keyboard':False},3)==(2,35)\n" +
    "assert m.resolve_capture_scope({'pointer':False,'keyboard':True},3)==(1,4)\n" +
    "assert m.resolve_capture_scope({'pointer':True,'keyboard':True},3)==(3,39)\n" +
    "assert m.EIS_DEVICE_TYPE_VIRTUAL==1 and m.EIS_DEVICE_TYPE_PHYSICAL==2\n" +
    "assert m.is_physical_device_type(2) and not m.is_physical_device_type(1)\n" +
    "assert m.requested_physical_activity_seen({'pointer':True,'keyboard':False},1)\n" +
    "assert m.requested_physical_activity_seen({'pointer':False,'keyboard':True},4)\n" +
    "assert m.requested_physical_activity_seen({'pointer':True,'keyboard':True},1)\n" +
    "assert m.requested_physical_activity_seen({'pointer':True,'keyboard':True},4)\n" +
    "assert not m.requested_physical_activity_seen({'pointer':True,'keyboard':False},4)\n" +
    "for q,c in [({'pointer':False,'keyboard':False},3),({'pointer':False,'keyboard':True},2),({'pointer':True,'keyboard':False},1)]:\n" +
    " try:m.resolve_capture_scope(q,c)\n" +
    " except m.CaptureError:pass\n" +
    " else:raise AssertionError((q,c))\n" +
    "print('EXACT_SCOPE_PASS')\n";
  const result=spawnSync('python3',['-c',python,path.join(root,'tools','gui-input-capture-linux.py')],
    {encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.match(result.stdout,/EXACT_SCOPE_PASS/);
});

test('Linux Portal barrier dictionaries marshal exact D-Bus a{sv} variant types', {skip:process.platform!=='linux'}, ()=>{
  const python = "import importlib.machinery,importlib.util,sys\n" +
    "from gi.repository import GLib\n" +
    "loader=importlib.machinery.SourceFileLoader('rc_capture',sys.argv[1]);spec=importlib.util.spec_from_loader(loader.name,loader);m=importlib.util.module_from_spec(spec);loader.exec_module(m)\n" +
    "barriers=m.InputCapture._segments([(1920,1080,0,0),(1920,1080,1920,0)])\n" +
    "assert all(isinstance(v,GLib.Variant) for b in barriers for v in b.values())\n" +
    "packet=GLib.Variant('(oa{sv}aa{sv}u)',('/org/freedesktop/portal/desktop/session/1/test',{},barriers,7))\n" +
    "assert packet.get_type_string()=='(oa{sv}aa{sv}u)'\n" +
    "print('PORTAL_DBUS_MARSHAL_PASS')\n";
  const result=spawnSync('python3',['-c',python,path.join(root,'tools','gui-input-capture-linux.py')],
    {encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.match(result.stdout,/PORTAL_DBUS_MARSHAL_PASS/);
});

test('Linux barrier geometry excludes monitor seams and rejects malformed zones', {skip:process.platform!=='linux'}, ()=>{
  const python = "import importlib.machinery, importlib.util, sys\n" +
    "p=sys.argv[1]\n" +
    "loader=importlib.machinery.SourceFileLoader('rc_capture',p)\n" +
    "spec=importlib.util.spec_from_loader(loader.name,loader)\n" +
    "m=importlib.util.module_from_spec(spec);loader.exec_module(m)\n" +
    "cases=[('single',[(100,100,0,0)],4),('side',[(1920,1080,0,0),(1920,1080,1920,0)],6),('stacked',[(100,100,0,0),(100,100,0,100)],6)]\n" +
    "for name,zones,n in cases:\n" +
    " b=m.InputCapture._segments(zones);assert len(b)==n,(name,len(b),n)\n" +
    " if name=='side':\n" +
    "  pts=[tuple(v.unpack()) for q in b for v in [q['position']]]\n" +
    "  assert not any(x1==1920 and x2==1920 for x1,y1,x2,y2 in pts)\n" +
    "for z in ([],[(0,100,0,0)]):\n" +
    " try:m.InputCapture._segments(z)\n" +
    " except m.CaptureError:pass\n" +
    " else:raise AssertionError('invalid zones accepted')\n" +
    "print('BARRIER_GEOMETRY_PASS')\n";
  const result=spawnSync('python3',['-c',python,path.join(root,'tools','gui-input-capture-linux.py')],
    {encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.match(result.stdout,/BARRIER_GEOMETRY_PASS/);
});
