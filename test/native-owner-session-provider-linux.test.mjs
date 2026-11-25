import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createLinuxNativeOwnerSessionProvider} from '../src/native-owner-session-provider-linux.mjs';
import {createNativeOwnerAdministrationAuthorizer} from '../src/native-owner-administration-authorizer.mjs';
import {createLinuxV101OwnerSecurityStack} from '../src/v101-linux-owner-security-bootstrap.mjs';

const LOGINCTL='/usr/bin/loginctl';
const ZENITY='/usr/bin/zenity';
const HASH='a'.repeat(64);
const BINDING='b'.repeat(64);
const route=()=>({
  hostId:'host-1',profileId:'profile-1',principalId:'owner-1',
  conversationId:'chat-1',operationId:'step-1',
  target:{kind:'workflow-root',id:'root-1'}
});
const env=()=>({
  PATH:'/usr/bin:/bin',HOME:'/home/owner',USER:'owner',LOGNAME:'owner',
  XDG_SESSION_ID:'4',XDG_SESSION_TYPE:'x11',XDG_CURRENT_DESKTOP:'KDE',
  DISPLAY:':0',DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/1000/bus',
  XDG_RUNTIME_DIR:'/run/user/1000'
});
function logind(overrides={}){
  const values={
    Id:'4',User:'1000',Seat:'seat0',Active:'yes',Remote:'no',
    Type:'x11',Class:'user',Display:':0',Leader:'3519',State:'active',
    ...overrides
  };
  return Object.entries(values).map(([k,v])=>k+'='+v).join('\n')+'\n';
}
function providerOptions({
  execFileImpl=(file,args,options,callback)=>callback(null,logind(), ''),
  envValue=env(),uid=()=>1000,readFileImpl=()=>'/user.slice/user-1000.slice/user@1000.service/app.slice/commander.service',
  readlinkImpl=()=> 'user:[4026531837]',verifyExecutable=()=>{}
}={}){
  return {
    platform:'linux',execFileImpl,env:envValue,getuid:uid,readFileImpl,
    readlinkImpl,verifyExecutable,commandTimeoutMs:1000,dialogTimeoutMs:10000
  };
}
function ownerContext(overrides={}){
  return Object.freeze({
    source:'native-owner-attested',hostId:'host-1',profileId:'profile-1',
    principalId:'owner-1',conversationId:'chat-1',bindingId:BINDING,
    ownerSidHash:HASH,expiresAtMs:Date.now()+60_000,...overrides
  });
}
function workerContext(overrides={}){
  return Object.freeze({
    hostId:'host-1',profileId:'profile-1',principalId:'owner-1',
    conversationId:'chat-1',bindingId:BINDING,workerId:'cw_'+'c'.repeat(64),
    keyId:'d'.repeat(64),ownerSidHash:HASH,deviceProvider:'native-key-store',
    deviceIdHash:'e'.repeat(64),tunnelProvider:'openai-secure-mcp-tunnel',
    tunnelIdHash:'f'.repeat(64),capabilityPolicyDigest:'1'.repeat(64),
    ...overrides
  });
}
function adminRequest(context=workerContext(),overrides={}){
  return {
    kind:'worker-enrollment-grant',action:'ACTIVE',status:'ACTIVE',actor:'owner-1',
    workerContext:context,reason:'owner approved this worker',
    expiresAtMs:Date.now()+30_000,...overrides
  };
}

test('Linux provider hashes the current OS UID and resolves an active local logind seat',async()=>{
  const calls=[];
  const provider=createLinuxNativeOwnerSessionProvider(providerOptions({
    execFileImpl:(file,args,options,callback)=>{
      calls.push({file,args,options});
      callback(null,logind(),'');
    },
    verifyExecutable:file=>assert.ok([LOGINCTL,ZENITY].includes(file))
  }));
  const expected=createHash('sha256')
    .update('commander.os-owner.sid.v1\0linux\0uid=1000\0userns=user:[4026531837]')
    .digest('hex');
  assert.equal(await provider.resolveOwnerSidHash(),expected);
  const snapshot=await provider.getOwnerSessionSnapshot();
  assert.deepEqual(snapshot,{
    source:'native-linux-owner-session',ownerSidHash:expected,
    osSessionId:'linux-logind-4',seatId:'seat0',displayId:':0',
    sessionType:'x11',leaderPid:3519
  });
  assert.equal(calls.length,1);
  assert.equal(calls[0].file,LOGINCTL);
  assert.ok(calls[0].args.includes('show-session'));
  assert.equal(calls[0].options.timeout,1000);
});

test('Linux systemd owner service without XDG_SESSION_ID resolves only an active local logind auto seat',async()=>{
  const calls=[];
  const environment=env();delete environment.XDG_SESSION_ID;
  const provider=createLinuxNativeOwnerSessionProvider(providerOptions({
    envValue:environment,
    execFileImpl:(file,args,opts,callback)=>{
      calls.push({file,args});callback(null,logind(),'');
    }
  }));
  const snapshot=await provider.getOwnerSessionSnapshot();
  assert.equal(snapshot.osSessionId,'linux-logind-4');
  assert.equal(snapshot.seatId,'seat0');
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].args.slice(0,3),['show-session','auto','--no-pager']);
  assert.match(snapshot.ownerSidHash,/^[0-9a-f]{64}$/);
});

test('Linux systemd logind auto fallback cannot select a foreign, remote or spoofed seat',async t=>{
  const invalid=[
    ['wrong-owner',{User:'1001'}],
    ['remote',{Remote:'yes'}],
    ['inactive',{Active:'no'}],
    ['greeter',{Class:'greeter'}],
    ['non-graphical',{Type:'tty'}],
    ['invalid-session-id',{Id:'evil'}],
    ['wrong-display',{Display:':7'}]
  ];
  for(const [label,overrides] of invalid){
    await t.test(label,async()=>{
      const environment=env();delete environment.XDG_SESSION_ID;
      const provider=createLinuxNativeOwnerSessionProvider(providerOptions({
        envValue:environment,
        execFileImpl:(file,args,options,callback)=>callback(null,logind(overrides),'')
      }));
      await assert.rejects(provider.getOwnerSessionSnapshot());
    });
  }
  for(const [label,mutate] of [
    ['missing-user-bus',e=>delete e.DBUS_SESSION_BUS_ADDRESS],
    ['foreign-user-bus',e=>e.DBUS_SESSION_BUS_ADDRESS='unix:path=/run/user/1001/bus'],
    ['wrong-runtime-directory',e=>e.XDG_RUNTIME_DIR='/run/user/1001'],    ['spoofed-session-id',e=>e.XDG_SESSION_ID='not-numeric']
  ]){
    await t.test(label,async()=>{
      const environment=env();delete environment.XDG_SESSION_ID;mutate(environment);
      let executed=0;
      const provider=createLinuxNativeOwnerSessionProvider(providerOptions({
        envValue:environment,
        execFileImpl:(file,args,options,callback)=>{executed++;callback(null,logind(),'');}
      }));
      await assert.rejects(provider.getOwnerSessionSnapshot());
      assert.equal(executed,0,'must deny before calling loginctl');
    });
  }
  await t.test('foreign cgroup user service cannot resolve another owner session',async()=>{
    const environment=env();delete environment.XDG_SESSION_ID;
    const provider=createLinuxNativeOwnerSessionProvider(providerOptions({
      envValue:environment,
      readFileImpl:()=>'/user.slice/user-1000.slice/session-4.scope'
    }));
    await assert.rejects(provider.getOwnerSessionSnapshot(),
      e=>e?.code==='NATIVE_OWNER_LOGIND_SESSION_REQUIRED');
  });
});

test('Linux provider rejects inactive, remote, foreign-user and mismatched-display sessions',async t=>{
  const cases=[
    ['inactive',{Active:'no'}],
    ['remote',{Remote:'yes'}],
    ['foreign user',{User:'1001'}],
    ['wrong display',{Display:':1'}],
    ['greeter session',{Class:'greeter'}],
    ['wrong session state',{State:'closing'}]
  ];
  for(const [name,overrides] of cases){
    await t.test(name,async()=>{
      const provider=createLinuxNativeOwnerSessionProvider(providerOptions({
        execFileImpl:(file,args,options,callback)=>callback(null,logind(overrides),'')
      }));
      await assert.rejects(provider.getOwnerSessionSnapshot());
    });
  }
});

test('Linux provider fails closed when the current process is outside its owner user slice or loginctl is untrusted',async()=>{
  const wrongCgroup=createLinuxNativeOwnerSessionProvider(providerOptions({
    readFileImpl:()=>'/system.slice/commander.service'
  }));
  await assert.rejects(wrongCgroup.getOwnerSessionSnapshot(),/NATIVE_OWNER_PROCESS_USER_SCOPE_MISMATCH/);
  const untrusted=createLinuxNativeOwnerSessionProvider(providerOptions({
    verifyExecutable:file=>{
      if(file===LOGINCTL)throw Object.assign(new Error('untrusted'),{code:'NATIVE_OWNER_EXECUTABLE_UNTRUSTED'});
    }
  }));
  await assert.rejects(untrusted.getOwnerSessionSnapshot(),
    error=>error?.code==='NATIVE_OWNER_EXECUTABLE_UNTRUSTED');
});

test('owner binding requires explicit Zenity approval and never displays the OAuth bearer digest',async()=>{
  const calls=[];
  const provider=createLinuxNativeOwnerSessionProvider(providerOptions({
    execFileImpl:(file,args,options,callback)=>{
      calls.push({file,args,options});
      if(file===LOGINCTL)return callback(null,logind(),'');
      callback(null,'','');
    }
  }));
  const ownerSidHash=await provider.resolveOwnerSidHash();
  const snapshot=await provider.getOwnerSessionSnapshot();
  const approved=await provider.authorizeBinding({
    sessionHandle:'chat-1',tokenSha256:'9'.repeat(64),route:route(),
    osSessionId:snapshot.osSessionId,ownerSidHash,bindingId:BINDING
  });
  assert.equal(approved,true);
  const beforeMismatch=calls.length;
  assert.equal(await provider.authorizeBinding({
    sessionHandle:'different-chat',tokenSha256:'9'.repeat(64),route:route(),
    osSessionId:snapshot.osSessionId,ownerSidHash,bindingId:BINDING
  }),false);
  assert.equal(calls.length,beforeMismatch);
  const dialog=calls.find(x=>x.file===ZENITY);
  assert.ok(dialog);
  assert.ok(dialog.args.includes('--default-cancel'));
  assert.ok(dialog.args.includes('--no-markup'));
  const text=dialog.args.at(dialog.args.indexOf('--text')+1);
  assert.match(text,/chat-1/);
  assert.doesNotMatch(text,/9{64}/);
  assert.equal(dialog.options.env.PATH,'/usr/bin:/bin');
});

test('KDE KDialog fallback requires an explicitly typed one-time code and retains native session checks',async()=>{
  const calls=[], KDIALOG='/usr/bin/kdialog';
  let challenge='';
  const provider=createLinuxNativeOwnerSessionProvider(providerOptions({
    verifyExecutable:file=>{
      if(file===ZENITY)throw Object.assign(new Error('missing'),{code:'NATIVE_OWNER_EXECUTABLE_UNAVAILABLE'});
      assert.ok([LOGINCTL,KDIALOG].includes(file));
    },
    execFileImpl:(file,args,options,callback)=>{
      calls.push({file,args,options});
      if(file===LOGINCTL)return callback(null,logind(),'');
      assert.equal(file,KDIALOG);
      assert.ok(args.includes('--inputbox'));
      assert.equal(args.at(-1),'','approval input must initially be blank');
      const display=args.at(-2);
      const match=/Type this one-time code to approve:\n(\d{8})$/.exec(display);
      assert.ok(match,'fresh confirmation code must be shown');
      challenge=match[1];
      callback(null,challenge+'\n','');
    }
  }));
  const before=await provider.getOwnerSessionSnapshot();
  const accepted=await provider.requestConsent({
    title:'Owner approval QA',message:'Consent for exact local UI QA; no access grant.',
    expectedOwnerSidHash:before.ownerSidHash,expectedOsSessionId:before.osSessionId
  });
  assert.equal(accepted,true);
  assert.match(challenge,/^\d{8}$/);
  assert.equal(calls.filter(x=>x.file===KDIALOG).length,1);
  assert.equal(calls.filter(x=>x.file===LOGINCTL).length,3);
  assert.equal(calls.find(x=>x.file===KDIALOG).options.env.PATH,'/usr/bin:/bin');
});

test('KDialog fallback never authorizes empty/wrong/cancelled input or an untrusted Zenity executable',async t=>{
  for(const [caseName,dialogResult] of [
    ['blank',{code:0,stdout:'\n'}],['incorrect',{code:0,stdout:'00000000\n'}],
    ['cancelled',{code:1,stdout:''}],['timed out',{code:null,stdout:''}]
  ]){
    await t.test(caseName,async()=>{
      let calls=0;
      const provider=createLinuxNativeOwnerSessionProvider(providerOptions({
        verifyExecutable:file=>{
          if(file===ZENITY)throw Object.assign(new Error('missing'),{code:'NATIVE_OWNER_EXECUTABLE_UNAVAILABLE'});
          assert.ok([LOGINCTL,'/usr/bin/kdialog'].includes(file));
        },
        execFileImpl:(file,args,options,callback)=>{
          if(file===LOGINCTL)return callback(null,logind(),'');
          calls++;
          const error=dialogResult.code===0?null:Object.assign(new Error('not approved'),{code:dialogResult.code});
          callback(error,dialogResult.stdout,'');
        }
      }));
      const before=await provider.getOwnerSessionSnapshot();
      const ok=await provider.requestConsent({title:'QA',message:'Exact QA only',
        expectedOwnerSidHash:before.ownerSidHash,expectedOsSessionId:before.osSessionId});
      assert.equal(ok,false);assert.equal(calls,1);
    });
  }
  await t.test('owner desktop seat changes after valid KDialog input',async()=>{
    let loginCalls=0;
    const provider=createLinuxNativeOwnerSessionProvider(providerOptions({
      verifyExecutable:file=>{
        if(file===ZENITY)throw Object.assign(new Error('missing'),{code:'NATIVE_OWNER_EXECUTABLE_UNAVAILABLE'});
      },
      execFileImpl:(file,args,options,callback)=>{
        if(file===LOGINCTL){
          loginCalls++;
          return callback(null,logind(loginCalls>=3?{Leader:'3520'}:{}),'');
        }
        const match=/Type this one-time code to approve:\n(\d{8})$/.exec(args.at(-2));
        assert.ok(match);
        callback(null,match[1]+'\n','');
      }
    }));
    const snap=await provider.getOwnerSessionSnapshot();
    assert.equal(await provider.requestConsent({title:'QA',message:'No owner grant',
      expectedOwnerSidHash:snap.ownerSidHash,expectedOsSessionId:snap.osSessionId}),false);
  });
  await t.test('untrusted Zenity cannot fall back to KDialog',async()=>{
    let dialogCalls=0;
    const provider=createLinuxNativeOwnerSessionProvider(providerOptions({
      verifyExecutable:file=>{
        if(file===ZENITY)throw Object.assign(new Error('untrusted'),{code:'NATIVE_OWNER_EXECUTABLE_UNTRUSTED'});
      },
      execFileImpl:(file,args,options,callback)=>{
        if(file!==LOGINCTL)dialogCalls++;
        callback(null,logind(),'');
      }
    }));
    const snap=await provider.getOwnerSessionSnapshot();
    assert.equal(await provider.requestConsent({title:'QA',message:'No owner grant',
      expectedOwnerSidHash:snap.ownerSidHash,expectedOsSessionId:snap.osSessionId}),false);
    assert.equal(dialogCalls,0);
  });
});

test('denial, display loss and session rotation never authorize owner binding',async t=>{
  await t.test('explicit deny',async()=>{
    const provider=createLinuxNativeOwnerSessionProvider(providerOptions({
      execFileImpl:(file,args,options,callback)=>{
        if(file===LOGINCTL)return callback(null,logind(),'');
        callback(Object.assign(new Error('denied'),{code:1}),'','');
      }
    }));
    const snapshot=await provider.getOwnerSessionSnapshot();
    assert.equal(await provider.authorizeBinding({
      sessionHandle:'chat-1',tokenSha256:'9'.repeat(64),route:route(),
      osSessionId:snapshot.osSessionId,ownerSidHash:snapshot.ownerSidHash,bindingId:BINDING
    }),false);
  });
  await t.test('seat changes while prompt is open',async()=>{
    let loginCalls=0;
    const provider=createLinuxNativeOwnerSessionProvider(providerOptions({
      execFileImpl:(file,args,options,callback)=>{
        if(file===LOGINCTL){
          loginCalls++;
          return callback(null,logind(loginCalls>=3?{Leader:'3520'}:{}),'');
        }
        callback(null,'','');
      }
    }));
    const snapshot=await provider.getOwnerSessionSnapshot();
    assert.equal(await provider.requestConsent({
      title:'Test owner approval',message:'Approve exact test action?',
      expectedOwnerSidHash:snapshot.ownerSidHash,
      expectedOsSessionId:snapshot.osSessionId
    }),false);
  });
});

test('native administration authorizer binds grant approval to the live owner epoch and exact worker tuple',async t=>{
  let owner=ownerContext();
  let prompt=null;
  const provider={
    getOwnerSessionSnapshot:async()=>({
      ownerSidHash:owner.ownerSidHash,osSessionId:'linux-logind-4',
      seatId:'seat0',displayId:':0',sessionType:'x11',leaderPid:3519
    }),
    requestConsent:async request=>{prompt=request;return true;}
  };
  const bindings={resolveNativeOwnerContext:async()=>owner};
  const authorize=createNativeOwnerAdministrationAuthorizer({
    ownerSessionProvider:provider,nativeSessionBindings:bindings
  });
  const context=workerContext();
  assert.equal(await authorize(adminRequest(context)),true);
  assert.match(prompt.message,/cw_c{64}/);
  assert.match(prompt.message,/owner approved this worker/);
  assert.match(prompt.message,/does not elevate OS privileges/);
  await t.test('rejects a different owner epoch',async()=>{
    owner=ownerContext({bindingId:'2'.repeat(64)});
    assert.equal(await authorize(adminRequest(context)),false);
  });
  await t.test('rejects a grant that outlives the owner binding',async()=>{
    owner=ownerContext({expiresAtMs:Date.now()+1000});
    assert.equal(await authorize(adminRequest(context,{
      expiresAtMs:Date.now()+5000
    })),false);
  });
  await t.test('rejects actor/principal mismatch',async()=>{
    owner=ownerContext();
    assert.equal(await authorize(adminRequest(context,{actor:'other-owner'})),false);
  });
});

test('Linux V1-01 bootstrap composes native session binding and async owner-admin grant approval',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v101-linux-owner-stack-'));
  let prompts=0;
  const stack=createLinuxV101OwnerSecurityStack({
    directory:path.join(root,'grants'),
    attestPlatformSession:async proof=>{
      assert.equal(proof,'trusted-mtls-proof');
      return {
        source:'native-platform-session',sessionHandle:'chat-1',
        tokenSha256:'9'.repeat(64)
      };
    },
    resolveOwnerRoute:async session=>{
      assert.equal(session,'chat-1');
      return route();
    },
    ownerSessionOptions:providerOptions({
      execFileImpl:(file,args,options,callback)=>{
        if(file===LOGINCTL)return callback(null,logind(),'');
        if(file===ZENITY){prompts++;return callback(null,'','');}
        callback(new Error('unexpected command'),'','');
      }
    })
  });
  try{
    const binding=await stack.nativeSessionBindings.bindTrusted('trusted-mtls-proof');
    assert.equal(binding.sessionHandle,'chat-1');
    assert.equal(binding.ownerSidHash,await stack.ownerSession.resolveOwnerSidHash());
    assert.equal(prompts,1);
    const context=workerContext({
      bindingId:binding.bindingId,ownerSidHash:binding.ownerSidHash
    });
    const grant=await stack.grantRegistry.changeWorkerGrant({
      workerContext:context,status:'ACTIVE',expectedRevision:0,
      actor:'owner-1',reason:'owner approved this worker',
      expiresAtMs:binding.expiresAtMs-1000
    });
    assert.equal(grant.status,'ACTIVE');
    assert.equal(grant.bindingId,binding.bindingId);
    assert.equal(stack.grantRegistry.readWorkerGrant(context).revision,1);
    assert.equal(prompts,2);
  }finally{
    stack.close();
    fs.rmSync(root,{recursive:true,force:true});
  }
});
