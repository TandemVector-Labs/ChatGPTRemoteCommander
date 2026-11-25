import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';
import {createV2PrivatePairMcpIngress} from '../src/v2-private-pair-mcp-http-ingress.mjs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {validateCore,preparePreviewCore,previewConfig}=require('../packaging/unified/pilot-runtime.cjs');
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const resource=path.join(repo,'packaging/unified/.stage/core');
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');

test('the patched packager matcher preserves the callable legacy dir-compare dependency',()=>{
  const gui=JSON.parse(fs.readFileSync(path.join(repo,'packaging/unified/package.json'),'utf8'));
  const lock=JSON.parse(fs.readFileSync(path.join(repo,'packaging/unified/package-lock.json'),'utf8'));
  assert.deepEqual(gui.overrides,{'minimatch@>=7.0.0 <11.0.1':'11.0.9'});
  assert.equal(lock.packages['node_modules/minimatch'].version,'11.0.9');
  assert.match(lock.packages['node_modules/dir-compare/node_modules/minimatch'].version,/^3\./);
  assert.match(lock.packages['node_modules/glob/node_modules/minimatch'].version,/^3\./);
});

test('native Linux and Electron builder derive one exact prerelease version from Core, GUI, and release train',()=>{
 const core=JSON.parse(fs.readFileSync(path.join(repo,'package.json'),'utf8'));
 const gui=JSON.parse(fs.readFileSync(path.join(repo,'packaging/unified/package.json'),'utf8'));
 const train=JSON.parse(fs.readFileSync(path.join(repo,'docs/release-train-0.12.json'),'utf8'));
 assert.match(core.version,/^0\.12\.0-dev\.[1-9][0-9]*$/);
 assert.equal(core.version,gui.version);
 assert.equal(train.sourceVersion,core.version);
 assert.equal(train.status,'INTEGRATION_CANDIDATE_NOT_FINAL');
 assert.equal(train.publishApproved,false);
 assert.equal(train.installedPromotionApproved,false);
 const native=fs.readFileSync(path.join(repo,'tools/build-native-linux-package.sh'),'utf8');
 const prepare=fs.readFileSync(path.join(repo,'packaging/unified/prepare.mjs'),'utf8');
 const merged=fs.readFileSync(path.join(repo,'packaging/unified/merge-native-deb.sh'),'utf8');
 const upgrade=fs.readFileSync(path.join(repo,'test/unified-native-upgrade-smoke.sh'),'utf8');
 assert.match(native,/data\.sourceVersion!==process\.argv\[3\]/);
 assert.match(native,/VERSION.*=~.*0\\\.12\\\.0-dev/);
 assert.match(prepare,/pkg\.version!==guiPkg\.version/);
 assert.match(prepare,/train\.sourceVersion!==pkg\.version/);
 assert.match(prepare,/UNIFIED_VERSION_IDENTITY_UNCOMMITTED/);
 for(const script of [merged,upgrade]){
   assert.match(script,/Remote-Commander-Unified-\$\{VERSION\}-Linux-amd64\.deb/);
   assert.doesNotMatch(script,/Remote-Commander-Unified-0\.12\.0-dev\.1-Linux-amd64\.deb/);
 }
 assert.match(merged,/VERSION.*==.*CORE_VERSION/);
 assert.match(merged,/RC012_GUI_MAINTAINER_SCRIPT_OMITTED/);
 assert.match(merged,/RC012_MERGE_UNEXPECTED_GUI_CONTROL/);
 assert.match(merged,/RC012_MERGE_NATIVE_CONTROL_UNEXPECTED/);
 assert.match(merged,/RC012_MERGED_PACKAGE_UNEXPECTED_MAINTAINER/);
 assert.doesNotMatch(merged,/shutil\.copy2\(p,native\/'DEBIAN'\/p\.name\)/);
 assert.match(upgrade,/VERSION.*==.*GUI_VERSION/);
 for(const program of [native,prepare,merged,upgrade])
   assert.doesNotMatch(program,/[\x22\x27]0\.12\.0-dev\.1[\x22\x27]/,
     'native build and delivery must not pin one stale candidate revision');
});

test('Linux native package uses the shared positive runtime Core allowlist, never the entire repo',()=>{
 const native=fs.readFileSync(path.join(repo,'tools/build-native-linux-package.sh'),'utf8');
 const shared='src tools vendor assets config.json package.json';
 assert.ok(native.includes('git -C "$ROOT" archive --format=tar "$HEAD" -- '+shared+' | tar -xf - -C "$APP"'));
 assert.doesNotMatch(native,/git -C "\$ROOT" archive --format=tar "\$HEAD" \|/);
 const prepare=fs.readFileSync(path.join(repo,'packaging/unified/prepare.mjs'),'utf8');
 assert.ok(prepare.includes("'src','tools','vendor','assets','config.json','package.json'"));
 const hosted=fs.readFileSync(path.join(repo,'test/unified-native-upgrade-smoke.sh'),'utf8');
 assert.match(hosted,/RC012_PUBLIC_NATIVE_APP_PATH_DISALLOWED/);
 assert.match(hosted,/RC012_PUBLIC_NATIVE_APP_ALLOWLIST_PASS/);
 assert.ok(hosted.includes('python3 - "$OLD" "$NEW"'));
});

test('one installer definition uses Windows NSIS per user and Linux DEB, not old host repairs',()=>{
 const y=fs.readFileSync(path.join(repo,'packaging/unified/electron-builder.yml'),'utf8');
 assert.match(y,/target: nsis/);
 assert.match(y,/perMachine: false/);
 assert.match(y,/allowElevation: false/);
 assert.match(y,/target: deb/);
 assert.match(y,/packageName: chatgpt-remote-commander/);
 assert.match(y,/include: legacy-inno-guard[.]nsh/);
 const migration=fs.readFileSync(path.join(repo,'packaging/unified/owner-windows-legacy-migrate.ps1'),'utf8');
 assert.match(y,/owner-windows-legacy-migrate[.]ps1/);
 for(const marker of ['RC012_OWNER_LEGACY_GUI_MIGRATION_READY',
   'RC012_OWNER_GUI_TRANSACTIONAL_MIGRATION_INSTALL_PASS',
   'RC012_OWNER_LEGACY_GUI_ROLLBACK_PASS',
   'RC012_INSTALLER_SHA256_MISMATCH','RC012_LEGACY_GUI_RUNNING']){
   assert.ok(migration.includes(marker),marker);
 }
 assert.match(migration,/Remove-Item -LiteralPath \$legacyKey/);
 assert.match(migration,/Restore-Legacy \$r/);
 const nsis=fs.readFileSync(path.join(repo,'packaging/unified/legacy-inno-guard.nsh'),'utf8');
 assert.match(nsis,/!macro customInit/);
 assert.equal((nsis.match(/Uninstall\\RemoteCommander/g)||[]).length,3);
 assert.equal((nsis.match(/Abort "RC012_LEGACY_INNO_PRESENT/g)||[]).length,3);
 assert.match(y,/migration-preflight[.]mjs/);
 assert.match(y,/from: .stage\/core/);
});
test('hosted Ubuntu prefetches signed dependencies before expensive packaging; native upgrade consumes local cache',()=>{
 const y=fs.readFileSync(path.join(repo,'.github/workflows/unified-installer-pilot.yml'),'utf8');
 const script=fs.readFileSync(path.join(repo,'test/unified-native-upgrade-smoke.sh'),'utf8');
 assert.match(y,/Prefetch signed Ubuntu GUI dependencies/);
 assert.match(y,/Signed-By: \/usr\/share\/keyrings\/ubuntu-archive-keyring[.]gpg/);
 assert.match(y,/Acquire::Retries=3/);
 assert.match(y,/libnotify4 libsecret-1-0/);
 assert.match(script,/dpkg-query -W -f='[^']+\\n' libnotify4 libsecret-1-0/);
 assert.match(script,/sudo dpkg --install "\$OLD"/);
 assert.match(script,/sudo dpkg --install "\$NEW"/);
 assert.doesNotMatch(script,/apt-get --no-download install/);



 assert.doesNotMatch(script,/apt-get update/);
});

test('PRIVATE ingress source changes trigger both native package jobs at the exact PR head',()=>{
 const y=fs.readFileSync(path.join(repo,'.github/workflows/unified-installer-pilot.yml'),'utf8');
 for(const target of [
   'src/server-v0.3.mjs','src/v2-private-*.mjs',
   'src/v101-private-*.mjs','src/v101-g1-loopback-runtime.mjs',
   'src/v012-private-core-runtime.mjs',
   'src/v012-private-*.mjs','test/v012-private-*.test.mjs',
   'tools/provision-owner-worker-key-linux.mjs',
   'src/v2-native-owner-session-bindings.mjs',
   'src/worker-identity-authority.mjs',
   'test/v2-private-*.test.mjs'
 ])assert.ok(y.includes('"'+target+'"'),'missing source-triggered installer QA: '+target);
 assert.ok(y.includes('ref: ${{ github.event.pull_request.head.sha || github.sha }}'),
   'packaging must build the exact proposed source SHA, not the synthetic PR merge');
 assert.ok(y.includes('test "$(git rev-parse HEAD)" = "${{ github.event.pull_request.head.sha || github.sha }}"'));
 assert.ok(y.includes('os: [ubuntu-latest, windows-latest]'));
 assert.match(y,/Build package \(Linux\)/);
 assert.match(y,/Build package \(Windows\)/);
 assert.match(y,/upload-artifact@v4/);
});

test('immutable packaged source and restricted preview boot',async()=>{
 const manifest=validateCore(resource);
 assert.match(manifest.head,/^[0-9a-f]{40}$/);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rc-unified-'));
 try{
   const one=preparePreviewCore(resource,dir);
   assert.equal(one.existing,false);
   const again=preparePreviewCore(resource,dir);
   assert.equal(again.existing,true);
   assert.equal(again.head,manifest.head);
   assert.equal(sha(path.join(one.target,'src/server-v0.3.mjs')),manifest.files['src/server-v0.3.mjs']);
   const cfg=previewConfig(one.target,dir,59315);
   const obj=JSON.parse(fs.readFileSync(cfg.file,'utf8'));
   assert.equal(obj.host,'127.0.0.1');
   assert.equal(obj.capabilityProfile.tier,'STANDARD');
   assert.equal(obj.powerMode.enabled,false);
   assert.equal(obj.powerMode.fullFilesystem,false);
   assert.equal(obj.powerMode.allowShell,false);
   assert.equal(obj.autoUpdate.enabled,false);
   assert.deepEqual(obj.allowedPrograms,[]);
   assert.deepEqual(obj.allowedRoots,[cfg.root]);
   const entry=path.join(one.target,'src/server-v0.3.mjs');
   const child=spawn(process.execPath,[entry],{
      cwd:one.target,stdio:['ignore','pipe','pipe'],
      env:{...process.env,REMOTE_COMMANDER_CONFIG:cfg.file,
        COMMANDER_ONE_REQUIRE_TRUSTED_INGRESS:process.env.RC_TEST_PRIVILEGED_QUARANTINE==='1'?'1':'0'}
   });
   let log='';
   for(const s of [child.stdout,child.stderr])s.on('data',x=>{log=(log+x.toString()).slice(-2400);});
   try{
     const started=Date.now();let ok=false;
     while(Date.now()-started<9000){
       if(child.exitCode!==null)break;
       ok=await new Promise(resolve=>{
         const req=http.get('http://127.0.0.1:59315/health',res=>{res.resume();resolve(res.statusCode===200);});
         req.on('error',()=>resolve(false));req.setTimeout(700,()=>{req.destroy();resolve(false);});
       });
       if(ok)break;
       await new Promise(r=>setTimeout(r,150));
     }
     assert.ok(ok,'real isolated 0.12 core should expose /health; '+log);
     // The native owner-controlled PRIVATE catalog must represent the ACTUAL
     // installed Core definitions, not just a few manually selected stubs.
     // This is only discovery parity; no native owner or tool grant is issued.
     const real=await fetch('http://127.0.0.1:59315/mcp',{
       method:'POST',headers:{'content-type':'application/json'},
       body:JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/list',params:{}})
     });
     if(real.status===403){
       // An elevated GitHub Windows runner has an administrator token.
       // The legacy Core correctly quarantines ALL /mcp traffic in that
       // context. Never disable the quarantine just to make QA green.
       const healthResponse=await fetch('http://127.0.0.1:59315/health');
       assert.equal(healthResponse.status,200);
       const health=await healthResponse.json();
       assert.equal(health.privilegedLegacyHttpQuarantined,true);
       assert.equal(health.protectedIngress?.required,true);
       assert.equal(health.protectedIngress?.code,'V2_G1_INGRESS_NOT_WIRED');
       console.log('RC012_REAL_CORE_CATALOG_PARITY_QUARANTINED_NO_BYPASS');
     }else{
       assert.equal(real.status,200);
       const body=await real.json();
       const realCatalog=body.result?.tools;
       assert.ok(Array.isArray(realCatalog)&&realCatalog.length>40,
         'real Core catalog was not discoverable on isolated STANDARD preview');
       let attemptedEffects=0,nativeLookups=0;
       const ingress=createV2PrivatePairMcpIngress({
         resolveTrustedConversation:async()=>({
           source:'native-conversation-attested',sessionHandle:'chat1'
         }),
         attestTransport:async()=>({
           authenticated:true,peerType:'owner-pinned-private-tunnel-mtls',
           sessionSource:'native-owner-private-pair'
         }),
         ownerStack:{requestOwnerBinding:async()=>{attemptedEffects++;},
           nativeSessionBindings:{resolveNativeRoute:async()=>{
             nativeLookups++;
             throw Error('no real J01 binding in discovery-only QA');
           }}},
         operationGate:{execute:async()=>{attemptedEffects++;throw Error('not granted');}},
         trustedToolCatalog:realCatalog,
         // Even a misconfigured permissive callback must not admit bad
         // arguments that the real Core's immutable schema rejects.
         validateToolInput:async(name,args)=>{
           if(name==='read_text')args.path='forbidden-after-validation';
           return true;
         },
         resolveTrustedToolRoute:async()=>{throw Error('not admitted');}
       });
       const req=Readable.from([Buffer.from(JSON.stringify({
         jsonrpc:'2.0',id:4,method:'tools/list',params:{}
       }))]);
       req.socket={encrypted:true,authorized:true};req.url='/mcp';req.method='POST';
       req.rawHeaders=['Content-Type','application/json'];
       let responseStatus=null,responseBytes=null;
       const res={writeHead(status){responseStatus=status;},
         end(data){responseBytes=data;}};
       await ingress.handle(req,res);
       assert.equal(responseStatus,200,
         'private one-tunnel discovery cannot represent actual Core catalog');
       const privateCatalog=JSON.parse(String(responseBytes)).result.tools.slice(2);
       assert.deepEqual(privateCatalog,realCatalog,
         'private catalog must preserve every actual Core tool definition');
       const coreRead=realCatalog.find(t=>t.name==='read_text');
       assert.ok(coreRead?.inputSchema?.required?.includes('path'),
         'source Core must require a path for read_text');
       const invalid=Readable.from([Buffer.from(JSON.stringify({
         jsonrpc:'2.0',id:5,method:'tools/call',
         params:{name:'read_text',arguments:{},
           _meta:{'openai/session':'chat1'}}
       }))]);
       invalid.socket={encrypted:true,authorized:true};
       invalid.url='/mcp';invalid.method='POST';
       invalid.rawHeaders=['Content-Type','application/json'];
       let denialStatus=null,denialBytes=null;
       await ingress.handle(invalid,{
         writeHead(status){denialStatus=status;},
         end(data){denialBytes=data;}
       });
       assert.equal(denialStatus,200,
         'real Core schema invalid input must be rejected before J01 lookup');
       assert.equal(JSON.parse(String(denialBytes)).result.isError,true);
       const replay=Readable.from([Buffer.from(JSON.stringify({
         jsonrpc:'2.0',id:6,method:'tools/call',
         params:{name:'read_text',arguments:{path:'README.md'},
           _meta:{'openai/session':'chat1'}}
       }))]);
       replay.socket={encrypted:true,authorized:true};
       replay.url='/mcp';replay.method='POST';
       replay.rawHeaders=['Content-Type','application/json'];
       let replayStatus=null,replayBytes=null;
       await ingress.handle(replay,{
         writeHead(status){replayStatus=status;},end(data){replayBytes=data;}
       });
       assert.equal(replayStatus,200);
       assert.equal(JSON.parse(String(replayBytes)).result.isError,true,
         'misbehaving callback cannot mutate the real validated Core input');
       assert.equal(nativeLookups,0,
         'input mutation must be denied before native owner lookup');
       assert.equal(attemptedEffects,0,
         'discovery must not request native owner consent or execute a tool');
       console.log('RC012_REAL_CORE_CATALOG_PARITY_COUNT='+realCatalog.length);
     }
   }finally{
     child.kill();
     await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(resolve,1500).unref();});
   }
   // Runtime data in the isolated var dir must not invalidate the immutable source.
   fs.mkdirSync(path.join(one.target,'var'),{recursive:true});
   fs.writeFileSync(path.join(one.target,'var','runtime-state.json'),'{}');
   assert.equal(validateCore(one.target).count,manifest.count);
   // Unmanifested executable code and a changed helper module must both fail closed.
   const unexpected=path.join(one.target,'src','extra.mjs');
   fs.writeFileSync(unexpected,'export const injected=true;');
   assert.throws(()=>validateCore(one.target),/UNIFIED_CORE_UNEXPECTED_FILE/);
   fs.rmSync(unexpected);
   const helper=path.join(one.target,'src','tools-v0.3.mjs');
   fs.appendFileSync(helper,'\\n// deliberately tampered helper\\n');
   assert.throws(()=>preparePreviewCore(resource,dir),/UNIFIED_SOURCE_HASH_MISMATCH/);
   fs.copyFileSync(path.join(resource,'src','tools-v0.3.mjs'),helper);
   const bad=path.join(one.target,'src/server-v0.3.mjs');
   fs.appendFileSync(bad,'\n// tampered\n');
   assert.throws(()=>preparePreviewCore(resource,dir),/UNIFIED_SOURCE_HASH_MISMATCH/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('preview rejects paths outside controlled port range',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rc-unified-invalid-'));
 try{assert.throws(()=>previewConfig(resource,dir,0),/UNIFIED_PREVIEW_PORT/);}
 finally{fs.rmSync(dir,{recursive:true,force:true});}
});

function makeUpgradeFixture(from,to,head,tree){
  fs.cpSync(from,to,{recursive:true,force:false,errorOnExist:true});
  const cfg=path.join(to,'config.json');
  fs.appendFileSync(cfg,'\n');
  const marker=path.join(to,'source-manifest.json');
  const m=JSON.parse(fs.readFileSync(marker,'utf8'));
  m.head=head;m.tree=tree;m.files['config.json']=sha(cfg);
  fs.writeFileSync(marker,JSON.stringify(m,null,2)+'\n');
  assert.equal(validateCore(to).head,head);
}
test('preview upgrade is atomic, retains bounded runtime data and only one previous Core',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rc-unified-upgrade-'));
  try{
    const source2=path.join(dir,'source-2'),source3=path.join(dir,'source-3');
    const data=path.join(dir,'user');
    makeUpgradeFixture(resource,source2,'1'.repeat(40),'2'.repeat(40));
    makeUpgradeFixture(source2,source3,'3'.repeat(40),'4'.repeat(40));
    const first=preparePreviewCore(resource,data);
    const previous=validateCore(first.target);
    const varDir=path.join(first.target,'var');
    fs.mkdirSync(varDir,{recursive:true});
    fs.writeFileSync(path.join(varDir,'owner-preview-state.json'),JSON.stringify({preserved:true}));
    const second=preparePreviewCore(source2,data);
    assert.equal(second.upgraded,true);
    assert.equal(second.previousHead,previous.head);
    assert.equal(validateCore(second.target).head,'1'.repeat(40));
    assert.equal(validateCore(path.join(data,'runtime','core.rollback')).head,previous.head);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(second.target,'var','owner-preview-state.json'),'utf8')),{preserved:true});
    const third=preparePreviewCore(source3,data);
    assert.equal(third.upgraded,true);
    assert.equal(validateCore(third.target).head,'3'.repeat(40));
    assert.equal(validateCore(path.join(data,'runtime','core.rollback')).head,'1'.repeat(40));
    assert.ok(!fs.existsSync(path.join(data,'runtime','.core-rollback-retired')));
    assert.ok(!fs.existsSync(path.join(data,'runtime','.core-incoming')));
    assert.equal(preparePreviewCore(source3,data).existing,true);
    assert.equal(validateCore(resource).head,previous.head);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('preview upgrade refuses oversized runtime data without replacing current Core',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rc-unified-upgrade-limit-'));
  try{
    const source2=path.join(dir,'source-2'),data=path.join(dir,'user');
    makeUpgradeFixture(resource,source2,'5'.repeat(40),'6'.repeat(40));
    const first=preparePreviewCore(resource,data);
    const old=validateCore(first.target);
    const varDir=path.join(first.target,'var');
    fs.mkdirSync(varDir,{recursive:true});
    fs.writeFileSync(path.join(varDir,'too-large.bin'),Buffer.alloc(4*1024*1024+1));
    assert.throws(()=>preparePreviewCore(source2,data),/UNIFIED_RUNTIME_DATA_TOO_LARGE_FOR_AUTOMATIC_UPGRADE/);
    assert.equal(validateCore(first.target).head,old.head);
    assert.ok(!fs.existsSync(path.join(data,'runtime','core.rollback')));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
