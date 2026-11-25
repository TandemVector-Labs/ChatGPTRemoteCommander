import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assessInstalledDenial} from '../tools/v1-01/installed-negative-admission-gate.mjs';

const SHA='a'.repeat(64);
const caseSpec=['standard','full'].flatMap(mode=>
 ['absent',false,true,null,'false'].map(flag=>[mode,flag]));
const variants=['anonymous','invalid-bearer-and-chat'];
function valid(){
  return {matrixVersion:2,observationsOnly:true,installerSha256:SHA,productionChanged:false,realOAuthProved:false,
    cases:caseSpec.map(([mode,flag])=>({mode,flag,passed:false,
      healthQuarantine:true,invocations:variants.map(variant=>({
        variant,status:403,match:false,denied:true
      }))}))};
}
const gate=v=>assessInstalledDenial(v,SHA);
test('all ten private installed denial cases are necessary but never G1 authorization',()=>{
  const out=gate(valid());
  assert.equal(out.status,'NEGATIVE_PREFLIGHT_PASS');
  assert.equal(out.code,'ALL_INSTALLED_DENIAL_CASES_PROVED');
  assert.equal(out.denialCasesProved,10);
  for(const f of ['authenticatedCallerProved','nativeOwnerGrantProved',
    'signedChatIdentityProved','rollbackProved','productionReleaseAuthorized'])
    assert.equal(out[f],false);
});
test('old behavior-matrix PASS is NOT security PASS when Full accepts anonymous calls',()=>{
  const sample=valid();
  for(const item of sample.cases){
    item.passed=true;
    if(item.mode==='full' && (item.flag==='absent'||item.flag===false)){
      item.healthQuarantine=false;
      item.invocations.forEach(x=>Object.assign(x,{status:200,match:true,denied:false}));
    }
  }
  const result=gate(sample);
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.code,'UNAUTHENTICATED_RPC_ACCEPTED');
  assert.deepEqual(result.unsafeCases,['full:absent','full:false']);
  assert.equal(result.denialCasesProved,8);
});
test('no trust from incomplete, duplicated, or reordered wrong-mode fixtures',()=>{
  const partial=valid();partial.cases.pop();
  assert.equal(gate(partial).code,'RECEIPT_SCOPE_OR_IDENTITY_UNVERIFIED');
  const duplicate=valid();duplicate.cases[4]=duplicate.cases[3];
  assert.equal(gate(duplicate).code,'RECEIPT_CASES_INVALID_OR_DUPLICATED');
  const unexpected=valid();unexpected.cases[5].flag='no';
  assert.equal(gate(unexpected).code,'RECEIPT_CASES_INVALID_OR_DUPLICATED');
  const reordered=valid();reordered.cases.reverse();
  assert.equal(gate(reordered).status,'NEGATIVE_PREFLIGHT_PASS');
});
test('receipt scope binds package SHA, exact no-production-change, and no OAuth proof',()=>{
  for(const key of ['installerSha256','productionChanged','realOAuthProved']){
    const q=valid();
    q[key]=key==='installerSha256'?'b'.repeat(64):true;
    assert.equal(gate(q).code,'RECEIPT_SCOPE_OR_IDENTITY_UNVERIFIED');
  }
  assert.equal(assessInstalledDenial(valid(),'invalid').status,'BLOCKED');
});
test('health quarantine and status 403 must be independently attested for each variant',()=>{
  for(const change of [
    v=>{v.cases[2].healthQuarantine=null;},
    v=>{v.cases[2].invocations[1].status=401;},
    v=>{v.cases[2].invocations[1].denied=false;},
    v=>{v.cases[2].invocations[1].match=true;},
    v=>{v.cases[2].invocations[1].variant='anonymous';}
  ]){
    const q=valid();change(q);
    assert.equal(gate(q).status,'BLOCKED');
  }
});
test('malformed samples never count as successful denial evidence',()=>{
  for(const bad of [null,{},'text',[],
    {...valid(),cases:[null,...valid().cases.slice(1)]}]){
    assert.equal(gate(bad).status,'BLOCKED');
  }
});
test('CLI returns 0 for negative-only, and 3 for insecure installed receipt',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v101-denial-gate-'));
  const exe=fileURLToPath(new URL('../tools/v1-01/installed-negative-admission-gate.mjs',import.meta.url));
  const file=path.join(dir,'receipt.json');
  try{
    fs.writeFileSync(file,JSON.stringify(valid()));
    const a=spawnSync(process.execPath,[exe,'--receipt='+file,'--sha256='+SHA],{encoding:'utf8'});
    assert.equal(a.status,0,a.stderr);
    assert.equal(JSON.parse(a.stdout).status,'NEGATIVE_PREFLIGHT_PASS');
    const b=valid();b.cases[1].healthQuarantine=false;
    b.cases[1].invocations.forEach(x=>Object.assign(x,{status:200,match:true,denied:false}));
    fs.writeFileSync(file,JSON.stringify(b));
    const c=spawnSync(process.execPath,[exe,'--receipt='+file,'--sha256='+SHA],{encoding:'utf8'});
    assert.equal(c.status,3,c.stderr);
    assert.equal(JSON.parse(c.stdout).code,'UNAUTHENTICATED_RPC_ACCEPTED');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('CLI fails closed for wrong args and mismatching hash',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v101-denial-gate-bad-'));
  const exe=fileURLToPath(new URL('../tools/v1-01/installed-negative-admission-gate.mjs',import.meta.url));
  const file=path.join(dir,'receipt.json');
  try{
    fs.writeFileSync(file,JSON.stringify(valid()));
    const wrongSha=spawnSync(process.execPath,[exe,'--receipt='+file,'--sha256='+'b'.repeat(64)],{encoding:'utf8'});
    assert.equal(wrongSha.status,3);
    assert.equal(JSON.parse(wrongSha.stdout).code,'RECEIPT_SCOPE_OR_IDENTITY_UNVERIFIED');
    const badArgs=spawnSync(process.execPath,[exe,'--receipt='+file],{encoding:'utf8'});
    assert.equal(badArgs.status,2);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});


import {createHash} from 'node:crypto';
import {
  parseArgs, privateHarnessEnvironment, validatePinnedRegularFile,
  evaluateHarnessResult, PINNED_HARNESS_SHA256
} from '../tools/v1-01/run-installed-denial-acceptance.mjs';

test('single-command negative QA accepts all ten denials but never claims G1',()=>{
  const out=evaluateHarnessResult({stdout:JSON.stringify(valid())+'\n',
    exitCode:0,packageSha256:SHA});
  assert.equal(out.status,'NEGATIVE_PREFLIGHT_PASS');
  assert.equal(out.denialCasesProved,10);
  assert.equal(out.harnessBehaviorExitCode,0);
  assert.equal(out.productionReleaseAuthorized,false);
  assert.equal(out.authenticatedCallerProved,false);
});
test('single-command negative QA blocks old behavior PASS with anonymous file RPC',()=>{
  const sample=valid();
  for(const item of sample.cases){
    item.passed=true;
    if(item.mode==='full' && (item.flag==='absent'||item.flag===false)){
      item.healthQuarantine=false;
      for(const x of item.invocations)Object.assign(x,{status:200,denied:false,match:true});
    }
  }
  const out=evaluateHarnessResult({stdout:JSON.stringify(sample)+'\n',
    exitCode:0,packageSha256:SHA});
  assert.equal(out.status,'BLOCKED');
  assert.equal(out.code,'UNAUTHENTICATED_RPC_ACCEPTED');
  assert.equal(out.denialCasesProved,8);
  assert.deepEqual(out.unsafeCases,['full:absent','full:false']);
});
test('single-command wrapper rejects abnormal child exit even with good JSON',()=>{
  for(const exitCode of [null,1,3,9]){
    const r=evaluateHarnessResult({stdout:JSON.stringify(valid())+'\n',exitCode,
      packageSha256:SHA});
    assert.equal(r.status,'BLOCKED');
    assert.equal(r.code,'HARNESS_EXECUTION_FAILED');
  }
});
test('single-command wrapper rejects ambiguous, huge, or malformed JSON receipt',()=>{
  for(const text of ['','garbage','{}','{"ok":1}\n{"ok":2}',
    JSON.stringify(valid())+'\n'+JSON.stringify(valid()),
    ' '.repeat(65537)]){
    const a=evaluateHarnessResult({stdout:text,exitCode:0,packageSha256:SHA});
    assert.equal(a.status,'BLOCKED');
  }
});
test('single-command CLI requires unique exact flags and pinned package',()=>{
  const options=parseArgs(['--installer=artifact.run','--sha256='+SHA]);
  assert.equal(options.expectedSha256,SHA);
  assert.equal(options.installer,path.resolve('artifact.run'));
  assert.ok(options.harness.endsWith('test-installed-ingress-10.py'));
  for(const bad of [
    [],['--sha256='+SHA],['--installer=/tmp/a'],
    ['--installer=/tmp/a','--sha256=bad'],
    ['--installer=/tmp/a','--sha256='+SHA,'--installer=/tmp/b'],
    ['--installer=/tmp/a','--sha256='+SHA,'--python=powershell'],
    ['--installer=/tmp/a','--sha256='+SHA,'--privileged=true']
  ])assert.throws(()=>parseArgs(bad));
});
test('single-command Python child gets no ambient service or provider secret',()=>{
  const env=privateHarnessEnvironment({
    PATH:'/usr/bin',HOME:'/home/test',
    OPENAI_API_KEY:'secret',GITHUB_TOKEN:'secret',AWS_SECRET_ACCESS_KEY:'secret',
    REMOTE_COMMANDER_CONFIG:'privileged',COMMANDER_ONE_ADMIN:'enabled',
    PYTHONPATH:'/secret/site',PYTHONUTF8:'0'
  });
  assert.equal(env.PATH,'/usr/bin');
  assert.equal(env.HOME,'/home/test');
  assert.equal(env.PYTHONUTF8,'1');
  for(const k of ['OPENAI_API_KEY','GITHUB_TOKEN','AWS_SECRET_ACCESS_KEY',
    'REMOTE_COMMANDER_CONFIG','COMMANDER_ONE_ADMIN','PYTHONPATH'])
    assert.equal(Object.hasOwn(env,k),false,k);
});
test('single-command pin verifier rejects wrong hashes and symlink files',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v101-denial-pin-'));
  const file=path.join(dir,'test-file.bin'),alias=path.join(dir,'alias.bin');
  try{
    fs.writeFileSync(file,Buffer.from('public-qa-only'));
    const sha=createHash('sha256').update('public-qa-only').digest('hex');
    assert.equal(await validatePinnedRegularFile(file,sha,128),true);
    await assert.rejects(()=>validatePinnedRegularFile(file,SHA,128),
      x=>x.code==='PINNED_FILE_HASH_MISMATCH');
    await assert.rejects(()=>validatePinnedRegularFile(file,sha,2),
      x=>x.code==='PINNED_FILE_TYPE_OR_SIZE_INVALID');
    try{
      fs.symlinkSync(file,alias);
      await assert.rejects(()=>validatePinnedRegularFile(alias,sha,128),
        x=>x.code==='PINNED_FILE_TYPE_OR_SIZE_INVALID');
    }catch(error){
      if(!['EPERM','EACCES','ENOTSUP'].includes(error.code))throw error;
    }
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('single-command CLI refuses unpinned package without executing it',()=>{
  const runner=fileURLToPath(new URL(
    '../tools/v1-01/run-installed-denial-acceptance.mjs',import.meta.url));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v101-denial-runner-'));
  const fake=path.join(dir,'fake-installer.run');
  try{
    fs.writeFileSync(fake,'not an executable; never launch this file');
    const a=spawnSync(process.execPath,[runner,'--installer='+fake,
      '--sha256='+SHA],{encoding:'utf8'});
    assert.equal(a.status,2,a.stderr);
    const verdict=JSON.parse(a.stdout);
    assert.equal(verdict.status,'BLOCKED');
    assert.equal(verdict.code,'PINNED_FILE_HASH_MISMATCH');
    assert.equal(verdict.productionReleaseAuthorized,false);
    assert.equal(typeof PINNED_HARNESS_SHA256,'string');
    assert.equal(PINNED_HARNESS_SHA256.length,64);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});


import {stagePinnedInstaller, runInstalledDenialPreflight} from '../tools/v1-01/run-installed-denial-acceptance.mjs';

test('direct denial preflight refuses an unapproved interpreter before accessing artifacts',async()=>{
  for(const python of ['unapproved-interpreter', '', null, undefined]){
    await assert.rejects(()=>runInstalledDenialPreflight({
      installer:path.resolve('missing-installer-fixture'),
      expectedSha256:SHA,
      harness:path.resolve('missing-harness-fixture'),
      python
    }), error=>error.code==='PYTHON_COMMAND_INVALID');
  }
  // Both supported interpreter names still reach the pinned-file gate.
  for(const python of ['python', 'python3']){
    await assert.rejects(()=>runInstalledDenialPreflight({
      installer:path.resolve('missing-installer-fixture'),
      expectedSha256:SHA,
      harness:path.resolve('missing-harness-fixture'),
      python
    }), error=>error.code==='PINNED_FILE_MISSING');
  }
});

test('single-command runner creates owner-only executable copy and preserves origin',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v101-install-source-'));
  const original=path.join(dir,'unsigned-qa.run');
  fs.writeFileSync(original,'harmless package fixture',{mode:0o600});
  const baseline=fs.readFileSync(original);
  const sha=createHash('sha256').update(baseline).digest('hex');
  let copied;
  try{
    copied=await stagePinnedInstaller(original,sha);
    assert.notEqual(copied.path,original);
    assert.equal(fs.readFileSync(copied.path).toString(),'harmless package fixture');
    if(process.platform!=='win32')
      assert.equal(fs.statSync(copied.path).mode & 0o777,0o700);
    assert.ok(fs.existsSync(original));
    assert.deepEqual(fs.readFileSync(original),baseline);
  }finally{
    copied?.cleanup();
    if(copied)assert.equal(fs.existsSync(copied.path),false);
    assert.deepEqual(fs.readFileSync(original),baseline);
    fs.rmSync(dir,{recursive:true,force:true});
  }
});


test('both Standard absent and false must deny even when file access is separately rejected',()=>{
  const q=valid();
  for(const row of q.cases) {
    if(['absent',false].includes(row.flag)){
      row.healthQuarantine=false;
      for(const call of row.invocations) Object.assign(call,{
        status:200,denied:false,match:row.mode==='full'
      });
    }
  }
  const result=gate(q);
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.code,'UNAUTHENTICATED_RPC_ACCEPTED');
  assert.equal(result.denialCasesProved,6);
  assert.deepEqual(result.unsafeCases,[
    'standard:absent','standard:false','full:absent','full:false'
  ]);
});
test('legacy six-case and unversioned receipts never produce negative release acceptance',()=>{
  const six=valid();
  six.cases=six.cases.filter(row=>row.mode==='full'||row.flag===true);
  assert.equal(six.cases.length,6);
  assert.equal(gate(six).status,'BLOCKED');
  assert.equal(gate(six).code,'RECEIPT_SCOPE_OR_IDENTITY_UNVERIFIED');
  for(const key of ['matrixVersion','observationsOnly']){
    const receipt=valid();
    delete receipt[key];
    assert.equal(gate(receipt).status,'BLOCKED');
  }
});


import http from 'node:http';
import {
  parsePortArgs, classifyInstalledIngress, observeLocalHttp, probeInstalledG1
} from '../tools/v1-01/installed-g1-readonly-probe.mjs';

const deniedG1=()=>({
  status:403,json:true,noStore:true,body:{error:'trusted_transport_required'}
});
const g1Metadata=()=>({
  status:200,json:true,noStore:true,
  body:{resource:'https://commander.example.test/mcp-v2',
    authorization_servers:['https://idp.example.test']}
});
const g1SourceReceipt=()=>({
  health:{status:200,json:true},
  legacyAnonymous:deniedG1(),legacyForged:deniedG1(),
  v2Anonymous:deniedG1(),v2Forged:deniedG1(),metadata:g1Metadata()
});

test('V101 G1 live port read-only admission: strict port-only CLI and no arbitrary network destinations',()=>{
  assert.equal(parsePortArgs(['--port=48834']),48834);
  for(const args of [
    [],['--port=48834','--host=0.0.0.0'],['--port=0'],['--port=80'],
    ['--port=65536'],['--port=48834/other'],['--port=48834','--token=x'],
    ['--host=attacker.example','--port=48834'],['--port=048834']
  ])assert.throws(()=>parsePortArgs(args));
  assert.throws(()=>observeLocalHttp({port:48834,pathname:'/filesystem'}));
  assert.throws(()=>observeLocalHttp({port:48834,pathname:'/mcp',method:'DELETE'}));
  assert.throws(()=>observeLocalHttp({port:48834,pathname:'/mcp',timeoutMs:10000}));
});

test('V101 G1 admission requires paired denial of Legacy and V2 with valid OAuth resource discovery',()=>{
  const full=g1SourceReceipt();
  const a=classifyInstalledIngress(full);
  assert.equal(a.status,'NEGATIVE_PREFLIGHT_PASS');
  assert.equal(a.legacyMode,'quarantined');
  for(const key of ['authenticatedCallerProved','signedChatIdentityProved',
    'nativeOwnerGrantProved','authorizedEffectProved','rollbackProved',
    'productionReleaseAuthorized','operationalFullAccessProved'])
    assert.equal(a[key],false,key);
  const retired=g1SourceReceipt();
  retired.legacyAnonymous={status:404};
  retired.legacyForged={status:404};
  assert.equal(classifyInstalledIngress(retired).legacyMode,'retired');
});

test('V101 G1 admission blocks anonymous enumeration even if protected file_info is denied',()=>{
  for(const name of ['legacyAnonymous','legacyForged']){
    const r=g1SourceReceipt();r[name]={status:200,json:true,body:{result:{tools:[]}}};
    const verdict=classifyInstalledIngress(r);
    assert.equal(verdict.status,'BLOCKED');
    assert.equal(verdict.code,'LEGACY_ANONYMOUS_DISCOVERY_EXPOSED');
  }
  const v2=g1SourceReceipt();
  v2.v2Anonymous={status:200,json:true,body:{result:{tools:[]}}};
  assert.equal(classifyInstalledIngress(v2).code,'V2_NEGATIVE_ADMISSION_UNPROVED');
});

test('V101 G1 admission blocks missing V2 route or OAuth metadata and unverified legacy state',()=>{
  for(const key of ['v2Anonymous','metadata']){
    const r=g1SourceReceipt();r[key]={status:404};
    assert.equal(classifyInstalledIngress(r).code,'V2_AUTHENTICATED_INGRESS_ABSENT');
  }
  for(const key of ['health','legacyAnonymous','metadata']){
    const r=g1SourceReceipt();delete r[key];
    assert.equal(classifyInstalledIngress(r).status,'BLOCKED');
  }
  const insecure=g1SourceReceipt();
  insecure.legacyAnonymous={status:403,json:true,noStore:false,
    body:{error:'trusted_transport_required'}};
  assert.equal(classifyInstalledIngress(insecure).code,'LEGACY_NEGATIVE_ADMISSION_UNPROVED');
});

test('V101 G1 admission rejects misleading metadata and incomplete denied responses',()=>{
  for(const bad of [
    {resource:'http://commander.example.test/mcp-v2',authorization_servers:['https://idp.example.test']},
    {resource:'https://commander.example.test/mcp',authorization_servers:['https://idp.example.test']},
    {resource:'https://user:pw@commander.example.test/mcp-v2',authorization_servers:['https://idp.example.test']},
    {resource:'https://commander.example.test/mcp-v2',authorization_servers:[]},
    {resource:'https://commander.example.test/mcp-v2',authorization_servers:['http://idp.example.test']},
    {resource:'https://commander.example.test/mcp-v2',authorization_servers:['not-a-url']}
  ]){
    const r=g1SourceReceipt();r.metadata.body=bad;
    assert.equal(classifyInstalledIngress(r).code,'V2_RESOURCE_METADATA_UNVERIFIED');
  }
  const forged=g1SourceReceipt();
  forged.v2Forged={status:403,json:true,noStore:true,body:{error:'unauthorized'}};
  assert.equal(classifyInstalledIngress(forged).code,'V2_NEGATIVE_ADMISSION_UNPROVED');
});

test('V101 G1 live port read-only admission: HTTP fixture is loopback-only, sends no tool effects and excludes raw response',async()=>{
  const seen=[];
  const server=http.createServer((req,res)=>{
    const chunks=[];
    req.on('data',c=>chunks.push(c));
    req.on('end',()=>{
      const body=Buffer.concat(chunks).toString('utf8');
      seen.push({method:req.method,url:req.url,
        action:body?JSON.parse(body).method:null,authorization:req.headers.authorization??null});
      res.setHeader('content-type','application/json; charset=utf-8');
      res.setHeader('cache-control','no-store');
      if(req.url==='/health')return res.end(JSON.stringify({healthy:true}));
      if(req.url==='/.well-known/oauth-protected-resource/mcp-v2')
        return res.end(JSON.stringify(g1Metadata().body));
      res.statusCode=403;res.end(JSON.stringify({error:'trusted_transport_required'}));
    });
  });
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const result=await probeInstalledG1(server.address().port);
    assert.equal(result.status,'NEGATIVE_PREFLIGHT_PASS');
    assert.equal(result.port,server.address().port);
    assert.equal(Object.keys(result.observations).length,6);
    assert.equal(JSON.stringify(result).includes('deliberately-invalid-g1-probe'),false);
    assert.equal(seen.length,6);
    assert.equal(seen.filter(x=>x.action==='tools/list').length,4);
    assert.equal(seen.filter(x=>x.authorization!==null).length,2);
    assert.equal(seen.some(x=>x.action==='tools/call'),false);
  }finally{
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});

test('V101 G1 live port read-only admission: missing listener remains BLOCKED and never claims release',async()=>{
  const result=await probeInstalledG1(65011,{
    request:async()=>({status:null,error:'CONNECTION_UNAVAILABLE'})
  });
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.code,'EXPECTED_HEALTH_UNAVAILABLE');
  assert.equal(result.productionReleaseAuthorized,false);
  assert.equal(result.operationalFullAccessProved,false);
});


test('oversized unauthenticated tools/list retains observed HTTP 200 while discarding its body',async()=>{
  const server=http.createServer((req,res)=>{
    req.resume();
    res.writeHead(200,{'content-type':'application/json'});
    res.end('x'.repeat(9001));
  });
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const observation=await observeLocalHttp({
      port:server.address().port,pathname:'/mcp',method:'POST'
    });
    assert.equal(observation.status,200);
    assert.equal(observation.error,'RESPONSE_TOO_LARGE');
    assert.equal(observation.body,undefined);
    const receipt=g1SourceReceipt();
    receipt.legacyAnonymous=observation;
    assert.equal(classifyInstalledIngress(receipt).code,'LEGACY_ANONYMOUS_DISCOVERY_EXPOSED');
  }finally{
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});
