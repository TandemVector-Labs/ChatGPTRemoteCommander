import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {inspectRetirement} from '../tools/release-retirement-gate-r205.mjs';

function git(root,...a){return execFileSync('git',['-C',root,...a],{encoding:'utf8',timeout:10000}).trim()}
// CI candidate canaries may redirect the upstream Git *transport* to the
// organization fork via GIT_CONFIG_COUNT, but R205 fixture origins must test
// the canonical stored origin exactly. Neutralize only this precise,
// trusted CI-only rewrite while invoking synchronous fixture inspection.
function withCanonicalFixtureOrigin(fn) {
  const names = ['GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0'];
  const isCanaryRewrite =
    process.env.GIT_CONFIG_COUNT === '1' &&
    process.env.GIT_CONFIG_KEY_0 ===
      'url.https://github.com/TandemVector-Labs/ChatGPTRemoteCommander.git.insteadOf' &&
    process.env.GIT_CONFIG_VALUE_0 ===
      'https://github.com/GOD13emad/ChatGPTRemoteCommander.git';
  if (!isCanaryRewrite) return fn();
  const prior = names.map(key => process.env[key]);
  try {
    for (const key of names) delete process.env[key];
    return fn();
  } finally {
    names.forEach((key, i) => {
      if (prior[i] === undefined) delete process.env[key];
      else process.env[key] = prior[i];
    });
  }
}

function repo(dir,version){
  fs.mkdirSync(dir,{recursive:true});
  git(dir,'init','-q');
  git(dir,'-c','user.email=qa@example.invalid','-c','user.name=QA','remote','add','origin','https://github.com/GOD13emad/ChatGPTRemoteCommander.git');
  fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'fixture',version})+'\n');
  git(dir,'add','package.json');
  git(dir,'-c','user.email=qa@example.invalid','-c','user.name=QA','commit','-qm','R205 fixture');
  return git(dir,'rev-parse','HEAD');
}
function fixture(){
  const stateRoot=fs.mkdtempSync(path.join(os.tmpdir(),'rc-r205-retire-'));
  const releaseRoot=path.join(stateRoot,'releases'), routeRoot=path.join(stateRoot,'routing');
  fs.mkdirSync(releaseRoot);fs.mkdirSync(routeRoot);
  const installDir=path.join(stateRoot,'installed-core');
  const activeHead=repo(installDir,'0.10.20');
  const raw=path.join(releaseRoot,'candidate-under-test');
  const candidateHead=repo(raw,'0.10.19');
  const candidate=path.join(releaseRoot,'v0.10.19-'+candidateHead.slice(0,12));
  fs.renameSync(raw,candidate);
  const route={schema:1,profile:'default',generation:2,active:{port:48831,commit:activeHead,projectDir:installDir},previous:null};
  const routePath=path.join(routeRoot,'default.json');
  fs.writeFileSync(routePath,JSON.stringify(route));
  const approvalPath=path.join(stateRoot,'maintenance','release-retirement',path.basename(candidate)+'.json');
  fs.mkdirSync(path.dirname(approvalPath),{recursive:true});
  const time=new Date('2026-10-12T12:00:00Z');
  const approve={
    schema:1,kind:'CORE_RETIREMENT_ACCEPTED',candidateHead,activeHead,candidateName:path.basename(candidate),
    ownerUser:os.userInfo().username,rollbackVerified:true,browserLoginPreserved:true,soakAccepted:true,
    explicitRetirementAccepted:true,acceptedUtc:'2026-10-12T11:00:00Z',expiresUtc:'2026-10-12T14:00:00Z'
  };
  const read=(o={})=>withCanonicalFixtureOrigin(()=>inspectRetirement({stateRoot,releaseRoot,candidate,installDir,now:time,...o}));
  const cleanup=()=>{const prefix=path.join(os.tmpdir(),'rc-r205-retire-');assert.ok(stateRoot.startsWith(prefix));fs.rmSync(stateRoot,{recursive:true,force:true});};
  return {stateRoot,releaseRoot,candidate,installDir,activeHead,candidateHead,routePath,route,approve,approvalPath,read,cleanup};
}
function check(title,change,expected){
  test('R205 '+title,t=>{
    const f=fixture();t.after(f.cleanup);
    change(f);
    const result=f.read();
    assert.equal(result.status,'DEFER');
    assert.ok(result.reason.includes(expected),JSON.stringify(result));
    assert.ok(fs.existsSync(path.join(f.candidate,'package.json')),'read-only guard must not remove any release');
  });
}
check('refuses missing post-acceptance proof',()=>{},'POST_ACCEPTANCE_APPROVAL_MISSING');
test('R205 refuses active git SHA even if an approval exists',t=>{
 const f=fixture();t.after(f.cleanup);fs.writeFileSync(f.approvalPath,JSON.stringify(f.approve));
 const result=f.read({installDir:f.candidate});
 assert.equal(result.status,'DEFER');
 assert.ok(result.reason.includes('CANDIDATE_EQUALS_ACTIVE_HEAD'));
});
check('refuses active route references',f=>{f.route.active.projectDir=f.candidate;fs.writeFileSync(f.routePath,JSON.stringify(f.route));fs.writeFileSync(f.approvalPath,JSON.stringify(f.approve));},'REFERENCED_BY_CURRENT_OR_PREVIOUS_ROUTE');
check('refuses previous route references',f=>{f.route.previous={projectDir:f.candidate};fs.writeFileSync(f.routePath,JSON.stringify(f.route));fs.writeFileSync(f.approvalPath,JSON.stringify(f.approve));},'REFERENCED_BY_CURRENT_OR_PREVIOUS_ROUTE');
check('refuses corrupt route',f=>{fs.writeFileSync(f.routePath,'{corrupt');fs.writeFileSync(f.approvalPath,JSON.stringify(f.approve));},'ROUTE_OR_RETAINED_EVIDENCE_UNVERIFIED');
check('refuses protected retained backend',f=>{fs.writeFileSync(path.join(f.stateRoot,'retained-backends.json'),JSON.stringify({schema:1,items:[{projectDir:f.candidate}]}));fs.writeFileSync(f.approvalPath,JSON.stringify(f.approve));},'REFERENCED_BY_RETAINED_BACKEND');
check('refuses local modifications in candidate',f=>{fs.appendFileSync(path.join(f.candidate,'package.json'),' ');fs.writeFileSync(f.approvalPath,JSON.stringify(f.approve));},'RELEASE_TREE_HAS_LOCAL_DATA_OR_CHANGES');
check('refuses ignored runtime or personal files hidden by Git status',f=>{
 fs.appendFileSync(path.join(f.candidate,'.git','info','exclude'),'\nprivate-state\n');
 fs.writeFileSync(path.join(f.candidate,'private-state'),'DO_NOT_DELETE');
 fs.writeFileSync(f.approvalPath,JSON.stringify(f.approve));
},'RELEASE_HAS_IGNORED_OR_RUNTIME_DATA');
check('refuses invalid git origin',f=>{git(f.candidate,'remote','set-url','origin','https://example.invalid/other.git');fs.writeFileSync(f.approvalPath,JSON.stringify(f.approve));},'UNKNOWN_GIT_ORIGIN');
check('refuses stale approval',f=>{f.approve.expiresUtc='2026-10-10T00:00:00Z';fs.writeFileSync(f.approvalPath,JSON.stringify(f.approve));},'STALE_OR_INVALID_APPROVAL_WINDOW');
test('R226 refuses post-acceptance tickets valid longer than 24 hours',t=>{
 const f=fixture();t.after(f.cleanup);
 f.approve.acceptedUtc='2026-10-12T11:00:00Z';
 f.approve.expiresUtc='2026-10-13T11:00:01Z';
 fs.writeFileSync(f.approvalPath,JSON.stringify(f.approve));
 const result=f.read();
 assert.equal(result.status,'DEFER',JSON.stringify(result));
 assert.ok(result.reason.includes('STALE_OR_INVALID_APPROVAL_WINDOW'));
 assert.ok(fs.existsSync(f.candidate),'guard may never delete');
});
test('R226 accepts 24-hour-or-shorter owner approval when all other gates pass',t=>{
 const f=fixture();t.after(f.cleanup);
 f.approve.acceptedUtc='2026-10-12T11:00:00Z';
 f.approve.expiresUtc='2026-10-13T11:00:00Z';
 fs.writeFileSync(f.approvalPath,JSON.stringify(f.approve));
 const result=f.read();
 assert.equal(result.status,'ALLOW',JSON.stringify(result));
 assert.equal(result.retiredAfterAcceptance,true);
});
test('R226 refuses reversed acceptance time windows',t=>{
 const f=fixture();t.after(f.cleanup);
 f.approve.acceptedUtc='2026-10-12T12:00:00Z';
 f.approve.expiresUtc='2026-10-12T11:59:59Z';
 fs.writeFileSync(f.approvalPath,JSON.stringify(f.approve));
 const result=f.read();
 assert.equal(result.status,'DEFER',JSON.stringify(result));
 assert.ok(result.reason.includes('STALE_OR_INVALID_APPROVAL_WINDOW'));
});

check('refuses wrong owner approval',f=>{f.approve.ownerUser='other-user';fs.writeFileSync(f.approvalPath,JSON.stringify(f.approve));},'APPROVAL_CONTRACT_OR_COMMIT_MISMATCH');
check('refuses unaccepted Browser login',f=>{f.approve.browserLoginPreserved=false;fs.writeFileSync(f.approvalPath,JSON.stringify(f.approve));},'APPROVAL_CONTRACT_OR_COMMIT_MISMATCH');
test('R205 refuses unrecognized folder names even under release root',t=>{
 const f=fixture();t.after(f.cleanup);
 const unknown=path.join(f.releaseRoot,'unrecognized-personal-project');
 fs.mkdirSync(unknown);
 const result=f.read({candidate:unknown});
 assert.equal(result.status,'DEFER');
 assert.ok(result.reason.includes('UNKNOWN_FOLDER_NAME'),JSON.stringify(result));
 assert.ok(fs.existsSync(unknown));
});
test('R205 allows only exact clean retired git release after tested rollback, owner/login acceptance and soak',t=>{
 const f=fixture();t.after(f.cleanup);fs.writeFileSync(f.approvalPath,JSON.stringify(f.approve));
 const result=f.read();
 assert.equal(result.status,'ALLOW',JSON.stringify(result));
 assert.equal(result.candidateHead,f.candidateHead);
 assert.equal(result.activeHead,f.activeHead);
 assert.ok(fs.existsSync(path.join(f.candidate,'package.json')),'helper never deletes anything');
});
test('R205 prevents symlink release candidates on Linux',t=>{
 if(process.platform==='win32')return t.skip('Windows symlink creation requires developer privilege');
 const f=fixture();t.after(f.cleanup);fs.writeFileSync(f.approvalPath,JSON.stringify(f.approve));
 fs.symlinkSync(path.join(f.installDir,'package.json'),path.join(f.candidate,'user-data-link'));
 const result=f.read();
 assert.equal(result.status,'DEFER');
 assert.ok(result.reason.includes('LINK_OR_UNBOUNDED_RELEASE_CONTENT'),JSON.stringify(result));
});
