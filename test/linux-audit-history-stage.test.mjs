import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

const linuxOnly={skip:process.platform!=='linux'&&'Linux Git unshallow verification'};
const source=fs.readFileSync(new URL('../auto-update-linux.sh',import.meta.url),'utf8');
const installerSource=fs.readFileSync(new URL('../install.sh',import.meta.url),'utf8');
const installStart=installerSource.indexOf('ensure_install_audit_history(){');
const installEnd=installerSource.indexOf('\nvalidate_installation() {',installStart);
assert.ok(installStart>=0&&installEnd>installStart,'fresh installer must have a history verifier');
const installVerifier=installerSource.slice(installStart,installEnd);
const installCommand=['set -euo pipefail','INSTALL_DIR="$1"','EXPECTED_COMMIT="$2"',installVerifier,'ensure_install_audit_history'].join('\n');
const start=source.indexOf('ensure_complete_audit_history(){');
const end=source.indexOf('\nstage_release(){',start);
assert.ok(start>=0&&end>start,'fail-closed candidate history verifier must exist');
const func=source.slice(start,end);
const command=['set -euo pipefail',"log(){ printf '%s\\n' \"$*\"; }",func,'ensure_complete_audit_history "$1" "$2"'].join('\n');
function run(program,args,cwd,opts={}){
  const result=spawnSync(program,args,{cwd,encoding:'utf8',timeout:120000,windowsHide:true,...opts});
  assert.equal(result.error,undefined,result.error?.message);
  return result;
}
function git(dir,...args){
  const result=run('git',args,dir);
  assert.equal(result.status,0,result.stderr);
  return result.stdout.trim();
}
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-audit-history-stage-'));
  fs.chmodSync(root,0o700);
  t.after(()=>{
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
    assert.match(path.basename(root),/^rc-audit-history-stage-/);
    fs.rmSync(root,{recursive:true,force:true});
  });
  const upstream=path.join(root,'upstream');
  fs.mkdirSync(upstream);
  git(upstream,'init','-q','-b','main');
  git(upstream,'config','user.name','QA History Fixture');
  git(upstream,'config','user.email','qa@example.invalid');
  fs.writeFileSync(path.join(upstream,'history.txt'),'old\n');
  git(upstream,'add','history.txt');
  git(upstream,'commit','-q','-m','Original fixture');
  fs.appendFileSync(path.join(upstream,'history.txt'),'new\n');
  git(upstream,'add','history.txt');
  git(upstream,'commit','-q','-m','Second revision');
  const head=git(upstream,'rev-parse','HEAD');
  const stage=path.join(root,'stage');
  const url=pathToFileURL(upstream).href;
  const cloned=run('git',['clone','-q','--depth','1','--branch','main',url,stage],root);
  assert.equal(cloned.status,0,cloned.stderr);
  assert.equal(git(stage,'rev-parse','--is-shallow-repository'),'true');
  assert.equal(git(stage,'rev-parse','HEAD'),head);
  const invoke=(sha=head)=>run('bash',['-euo','pipefail','-c',command,'qa',stage,sha],root);
  return {root,stage,head,invoke};
}
test('Linux candidate audit expands exactly pinned shallow provenance before acceptance',linuxOnly,t=>{
  const f=fixture(t);
  const result=f.invoke();
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/AUDIT_HISTORY_FETCH_START/);
  assert.match(result.stdout,/AUDIT_HISTORY_FULL_PROVENANCE_PASS/);
  assert.equal(git(f.stage,'rev-parse','--is-shallow-repository'),'false');
  assert.equal(git(f.stage,'rev-parse','HEAD'),f.head);
  assert.equal(git(f.stage,'status','--porcelain','--untracked-files=no'),'');
});
test('Linux provenance guard fails closed before fetching with wrong SHA or dirty stage',linuxOnly,t=>{
  const f=fixture(t);
  const wrong=f.invoke('a'.repeat(40));
  assert.notEqual(wrong.status,0);
  assert.match(wrong.stdout,/AUDIT_HISTORY_STAGE_SHA_MISMATCH/);
  assert.equal(git(f.stage,'rev-parse','--is-shallow-repository'),'true');
  fs.appendFileSync(path.join(f.stage,'history.txt'),'dirty\n');
  const dirty=f.invoke();
  assert.notEqual(dirty.status,0);
  assert.match(dirty.stdout,/AUDIT_HISTORY_DIRTY_STAGE/);
  assert.equal(git(f.stage,'rev-parse','--is-shallow-repository'),'true');
});
test('Linux provenance guard rejects a missing origin without claiming audit success',linuxOnly,t=>{
  const f=fixture(t);
  git(f.stage,'remote','remove','origin');
  const result=f.invoke();
  assert.notEqual(result.status,0);
  assert.match(result.stdout,/AUDIT_HISTORY_FETCH_FAILED/);
  assert.doesNotMatch(result.stdout,/AUDIT_HISTORY_FULL_PROVENANCE_PASS/);
});
test('candidate history provenance gate precedes audit and all Core promotion',()=>{
  const stage=source.indexOf('run_gate "$STAGE_DIR" test npm run test:qualification');
  const history=source.indexOf('ensure_complete_audit_history "$STAGE_DIR" "$COMMIT"');
  const audit=source.indexOf('run_gate "$STAGE_DIR" audit npm run audit');
  const state=source.indexOf('STATE_DIR="$RUNTIME_ROOT/$COMMIT/default"');
  assert.ok(stage>=0&&history>stage&&audit>history&&state>audit);
  assert.match(func,/git -C "\$stage" fetch --quiet --no-tags --unshallow origin "\$expected"/);
  assert.match(func,/GIT_TERMINAL_PROMPT=0 timeout/);
});


test('fresh Linux Core install expands stage history before strict security audit',linuxOnly,t=>{
  const f=fixture(t);
  const result=run('bash',['-euo','pipefail','-c',installCommand,'qa',f.stage,f.head],f.root);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/INSTALL_AUDIT_HISTORY_FETCH_START/);
  assert.match(result.stdout,/INSTALL_AUDIT_HISTORY_FULL_PASS/);
  assert.equal(git(f.stage,'rev-parse','--is-shallow-repository'),'false');
  assert.equal(git(f.stage,'rev-parse','HEAD'),f.head);
  assert.equal(git(f.stage,'status','--porcelain','--untracked-files=no'),'');
});
test('fresh Linux installer rejects wrong commit, dirty source and unavailable ancestry',linuxOnly,t=>{
  const f=fixture(t);
  const invoke=(sha)=>run('bash',['-euo','pipefail','-c',installCommand,'qa',f.stage,sha],f.root);
  const wrong=invoke('a'.repeat(40));
  assert.notEqual(wrong.status,0);
  assert.match(wrong.stderr,/INSTALL_AUDIT_PIN_MISMATCH/);
  assert.equal(git(f.stage,'rev-parse','--is-shallow-repository'),'true');
  fs.appendFileSync(path.join(f.stage,'history.txt'),'dirty\n');
  const dirty=invoke(f.head);
  assert.notEqual(dirty.status,0);
  assert.match(dirty.stderr,/INSTALL_AUDIT_TRACKED_TREE_DIRTY/);
  assert.equal(git(f.stage,'rev-parse','--is-shallow-repository'),'true');
  fs.writeFileSync(path.join(f.stage,'history.txt'),'old\nnew\n');
  git(f.stage,'remote','remove','origin');
  const noRemote=invoke(f.head);
  assert.notEqual(noRemote.status,0);
  assert.match(noRemote.stderr,/INSTALL_AUDIT_HISTORY_FETCH_FAILED/);
  assert.doesNotMatch(noRemote.stdout,/INSTALL_AUDIT_HISTORY_FULL_PASS/);
});
test('Linux install history completion executes after qualification and before audit or start',()=>{
  const start=installerSource.indexOf('validate_installation() {');
  const check=installerSource.indexOf('npm run check:qualification',start);
  const tests=installerSource.indexOf('npm run test:qualification',check);
  const history=installerSource.indexOf('ensure_install_audit_history',tests);
  const audit=installerSource.indexOf('npm run audit',tests);
  const end=installerSource.indexOf('start_server() {',start);
  assert.ok(start>=0&&check>start&&tests>check&&history>tests&&audit>history&&end>audit);
  assert.match(installVerifier,/GIT_TERMINAL_PROMPT=0 timeout/);
  assert.match(installVerifier,/--unshallow origin "\$expected"/);
});
