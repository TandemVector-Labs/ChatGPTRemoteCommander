import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateWindowsRelease } from '../tools/verify-windows-release-policy.mjs';
const read=p=>readFileSync(p,'utf8');
const json=p=>JSON.parse(read(p));
const newVersion='0.10.26', previousVersion='0.10.24';
const previousTag='v0.10.24';

test('candidate source runtime and plugin identity agree without public release claims',()=>{
 const current=json('package.json').version;
 const train=json('docs/release-train-0.11.json');
 const server=read('src/server-v0.3.mjs');
 const cs=read('desktop/RemoteCommanderDashboard/RemoteCommanderDashboard.csproj');
 for(const p of ['plugin-template/plugin.json','plugin-template/.codex-plugin/plugin.json'])
   assert.equal(json(p).version,current,p);
 assert.ok(server.includes("const VERSION = '"+current+"';"));
 assert.ok(cs.includes('<Version>'+current+'</Version>'));
 if(current===newVersion){
   assert.ok(cs.includes('<FileVersion>0.10.26.0</FileVersion>'));
   assert.ok(cs.includes('<AssemblyVersion>0.10.26.0</AssemblyVersion>'));
 }else{
   assert.match(current,/^0\.11\.0-dev\.[1-9][0-9]*$/);
   assert.equal(train.sourceVersion,current);
   assert.equal(train.status,'INTEGRATION_CANDIDATE_NOT_FINAL');
   assert.equal(train.channel,'development');
   for(const gate of ['isStable','publishApproved','autoupdateApproved','installedPromotionApproved'])
     assert.equal(train[gate],false,gate);
   assert.equal(train.releaseTag,null);
   const fileVersion='0.11.0.'+current.split('.').at(-1);
   for(const tag of ['FileVersion','AssemblyVersion'])assert.ok(cs.includes('<'+tag+'>'+fileVersion+'</'+tag+'>'));
 }
 assert.match(read('docs/RELEASE_CANDIDATE_0.10.26.md'),/SOURCE CANDIDATE ONLY/);
});

test('both default qualification suites exercise exact post-tag identity guard',()=>{
  const scripts=json('package.json').scripts;
  for(const name of ['test','check']) {
    const script=scripts[name];
    const gate='node --test test/release-sync-posttag-guard.test.mjs';
    assert.equal(script.split(gate).length-1,1,`missing or duplicate ${name} release identity gate`);
    assert.ok(script.includes('node --test test/release-0.10.26-candidate-identity.test.mjs'),
      `release identity self-check absent in ${name}`);
  }
  assert.match(scripts['check:qualification'],/--script check/);
  assert.match(scripts['test:qualification'],/--script test/);
});

test('installer default remains at prior verified Preview rather than untagged candidate',()=>{
  for(const p of ['install.ps1','install.sh','server-install-windows.ps1','server-install-linux.sh'])
    assert.ok(read(p).includes(previousTag),p);
  assert.ok(read('server-install-windows.ps1').includes('ServerInstaller/0.10.24'));
  assert.match(read('test/release-assets-contract.test.mjs'),/0\.10\.26/);
});

test('historical scoped unsigned Preview policy refuses candidate v0.10.26',()=>{
  const policy=json('docs/UNSIGNED_WINDOWS_RELEASE_POLICY.json');
  assert.equal(policy.version,previousVersion);
  assert.equal(policy.tag,previousTag);
  assert.equal(policy.scope,'only-this-version');
  assert.equal(policy.stableAutoUpdateAllowed,false);
  assert.equal(policy.publishedInstallerSignature,'NotSigned');
  assert.match(policy.riskAcknowledgement,/SmartScreen/);
  const notes=read('docs/RELEASE_0.10.24.md');
  assert.throws(()=>evaluateWindowsRelease({
    signed:'false',version:newVersion,tag:'v'+newVersion,policy,releaseNotes:notes
  }),/WINDOWS_UNSIGNED_RELEASE_NOT_AUTHORIZED/);
  assert.match(read('docs/RELEASE_CANDIDATE_0.10.26.md'),/do NOT authorize unsigned v0\.10\.26/);
  assert.equal(json('docs/UNSIGNED_WINDOWS_RELEASE_POLICY_0.10.26.json').version,newVersion);
  assert.match(read('docs/RELEASE_0.10.26.md'),/Windows installer: UNSIGNED/);
  const policy25=json('docs/UNSIGNED_WINDOWS_RELEASE_POLICY_0.10.25.json');
  const notes25=read('docs/RELEASE_0.10.25.md');
  assert.throws(()=>evaluateWindowsRelease({
    signed:'false',version:newVersion,tag:'v'+newVersion,policy:policy25,releaseNotes:notes25
  }),/WINDOWS_UNSIGNED_RELEASE_NOT_AUTHORIZED/);

});

test('future tagged release workflow remains guarded and no automatic publisher promotion',()=>{
  const workflow=read('.github/workflows/release-sync.yml');
  for(const part of ['--verify-tag','--draft','--source-ref','--source-digest',
                     '--signer-workflow','refs/tags/$tag^{commit}'])
    assert.ok(workflow.includes(part),part);
  assert.ok(read('test/release-assets-contract.test.mjs').includes('RELEASE_0.10.24.md'));
  assert.ok(read('docs/RELEASE_0.10.21.md').includes('Core v0.10.21'));
});

test('candidate rollback failure uploads bounded sanitized diagnostics, never raw qualification log',()=>{
  const workflow=read('.github/workflows/candidate-rollback-v01025.yml');
  const helper=read('tools/diagnose-updater-gate-r470.ps1');
  for(const token of [
    'Diagnose failed candidate using sanitized source-only phase evidence',
    'if: ${{ failure() }}',
    'tools/diagnose-updater-gate-r470.ps1',
    'remote-commander-rollback-v025w/DIAGNOSTIC_R470.json'
  ])assert.ok(workflow.includes(token),token);
  assert.equal(workflow.split(String.fromCharCode(10)).some(line=>
    line.includes('${{ runner.temp }}') &&
    line.includes('qualification-output-') && line.includes('.log')
  ),false,'Do not upload raw qualification output');
  for(const marker of ['rawLogIncluded=$false','secretsIncluded=$false','absolutePathsIncluded=$false','NON_TAP_FAILURE_PHASE_IDENTIFIED'])
    assert.ok(helper.includes(marker),marker);
});

test('Windows native diagnostic chooses failed promotion or rollback commit, rejects forged receipt',async t=>{
  if(process.platform!=='win32')return t.skip('native PowerShell selection fixture');
  const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {spawnSync}=await import('node:child_process');
  // Git for Windows may check out the YAML with CRLF, while Ubuntu uses LF.
  // Only normalize the fixture reader; the production CI workflow is unchanged.
  const extractCommand=source=>{
    const text=source.replace(/\r\n/g,'\n');
    const start=text.indexOf('      - name: Diagnose failed candidate using sanitized source-only phase evidence');
    const finish=text.indexOf('      - name: Retain only scoped, short-lived CI evidence',start);
    assert.ok(start>=0 && finish>start,'diagnostic step must exist before upload');
    const excerpt=text.slice(start,finish);
    const delimiter='        run: |\n';
    const at=excerpt.indexOf(delimiter);
    assert.ok(at>=0,'native diagnostic PowerShell body missing');
    return excerpt.slice(at+delimiter.length).split('\n').filter(Boolean).map(line=>{
      assert.ok(line.startsWith('          '),'unexpected native workflow indentation');
      return line.slice(10);
    }).join('\n');
  };
  const raw=read('.github/workflows/candidate-rollback-v01025.yml');
  const command=extractCommand(raw);
  assert.equal(extractCommand(raw.replace(/\r?\n/g,'\r\n')),command,
    'CRLF checkout must yield identical native diagnostic PowerShell');
  const ref=String.fromCharCode(36)+'{{ github.event.pull_request.head.sha || github.sha }}';
  assert.ok(command.includes(ref),'exact candidate ref must be present');
  const candidate='b'.repeat(40);
  const baseline='890b637c5ff3c7dcc5df2c0b99031333d522c6e4';
  const scratch=mkdtempSync(join(tmpdir(),'rc-v025-stage-select-'));
  try{
    const root=join(scratch,'remote-commander-rollback-v025w');
    const helper=join(scratch,'tools');
    mkdirSync(root,{recursive:true});
    mkdirSync(helper,{recursive:true});
    writeFileSync(join(helper,'diagnose-updater-gate-r470.ps1'),
      "param([string]$Root,[string]$ExpectedCommit)\nWrite-Output ('SHA_SELECTED='+$ExpectedCommit)\n");
    const script=join(scratch,'diagnose.ps1');
    writeFileSync(script,command.split(ref).join(candidate)+'\n','utf8');
    const baseReceipt={
      schema:1,revision:'V025W',candidateHead:candidate,baselineHead:baseline,
      stages:[{name:'PROMOTE',exit:0,status:'PROMOTED'},{name:'ROLLBACK',exit:1,status:'FAILED'}]
    };
    for(const {name,receipt,selected} of [
      {name:'rollback failure',receipt:baseReceipt,selected:baseline},
      {name:'promotion failure',receipt:{...baseReceipt,stages:[{name:'PROMOTE',exit:1,status:'FAILED'}]},selected:candidate},
      {name:'forged candidate',receipt:{...baseReceipt,candidateHead:'c'.repeat(40)},selected:null},
      {name:'ambiguous two failures',receipt:{...baseReceipt,stages:[{name:'PROMOTE',exit:1,status:'FAILED'},{name:'ROLLBACK',exit:1,status:'FAILED'}]},selected:null},
    ]){
      writeFileSync(join(root,'RETURN_V025W.json'),JSON.stringify(receipt));
      const proc=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',script],{
        cwd:scratch,encoding:'utf8',timeout:12000,env:{...process.env,RUNNER_TEMP:scratch}
      });
      assert.equal(proc.error,undefined,'spawn error: '+name);
      assert.equal(proc.status,0,name+': '+proc.stderr);
      const output=proc.stdout+proc.stderr;
      if(selected){
        assert.ok(output.includes('SHA_SELECTED='+selected),name+': wrong diagnostic target');
        assert.doesNotMatch(output,/V025W_DIAG_UNAVAILABLE_FAIL_CLOSED/,name);
      }else{
        assert.ok(output.includes('V025W_DIAG_UNAVAILABLE_FAIL_CLOSED'),name);
        assert.doesNotMatch(output,/SHA_SELECTED=/,name);
      }
    }
  }finally{
    rmSync(scratch,{recursive:true,force:true});
  }
});
