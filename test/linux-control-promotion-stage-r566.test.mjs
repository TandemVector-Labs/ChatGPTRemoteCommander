import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const updater=fs.readFileSync(path.join(repo,'auto-update-linux.sh'),'utf8');
const start=updater.indexOf('promote_control(){');
const end=updater.indexOf('install_linux_gui_backend(){',start);
assert.ok(start!==-1&&end>start,'extract actual production updater function');
const promote=updater.slice(start,end);

const git=(args,options={})=>{
  const p=spawnSync('git',args,{encoding:'utf8',...options});
  assert.equal(p.status,0,'git '+args.join(' ')+' '+(p.stderr||''));
  return p.stdout.trim();
};
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-r566-control-'));
  const stage=(name,version)=>{
    const dir=path.join(root,name);
    fs.mkdirSync(dir);
    git(['init','-q',dir]);
    fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({version})+'\n');
    git(['-C',dir,'add','package.json']);
    git(['-C',dir,'-c','user.name=RC QA','-c','user.email=qa@example.invalid','commit','-qm','synthetic '+version]);
    return {dir,commit:git(['-C',dir,'rev-parse','HEAD'])};
  };
  const old=stage('old-stage','0.10.20');
  const newer=stage('new-stage','0.10.22');
  const control=path.join(root,'control');
  git(['clone','-q','--no-hardlinks',newer.dir,control]);
  const sentinel='USER_HISTORICAL_UNTRACKED_KEEP\n';
  fs.writeFileSync(path.join(control,'keep.txt'),sentinel);
  return {root,old,newer,control,sentinel};
}
function promoteInFixture(f,stage,commit,ref='refs/heads/rollback-r521'){
  const sh=[
    'set -Eeuo pipefail',
    'INSTALL_DIR="${QA_INSTALL_DIR:?}"',
    'STAGE_DIR="${QA_STAGE_DIR:?}"',
    'log(){ :; }',
    promote,
    'promote_control "$1" "$2"'
  ].join('\n');
  return spawnSync('bash',['-c',sh,'rc-r566',commit,ref],{
    encoding:'utf8',timeout:20000,
    env:{...process.env,QA_INSTALL_DIR:f.control,QA_STAGE_DIR:stage.dir,
      GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_ALLOW_PROTOCOL:'file'}
  });
}
function withFixture(fn){
  const f=fixture();
  try{return fn(f);}
  finally{fs.rmSync(f.root,{recursive:true,force:true});}
}
test('adversarial path names remain literal data, never Bash substitutions',
  {skip:process.platform!=='linux'?'Requires native Linux Bash fixture':false},
  ()=>withFixture(f=>{
    // Stage and installation directories can contain shell metacharacters as ordinary text.
    const oldLiteral=path.join(f.root,'stage-$(printf substituted)');
    const controlLiteral=path.join(f.root,'control-$(printf substituted)');
    fs.renameSync(f.old.dir,oldLiteral);
    fs.renameSync(f.control,controlLiteral);
    f.old={...f.old,dir:oldLiteral};
    f.control=controlLiteral;
    const p=promoteInFixture(f,f.old,f.old.commit);
    assert.equal(p.status,0,p.stdout+'\n'+p.stderr);
    assert.equal(git(['-C',f.control,'rev-parse','HEAD']),f.old.commit);
    assert.equal(fs.readFileSync(path.join(f.control,'keep.txt'),'utf8'),f.sentinel);
  }));
test('cross-platform updater contract validates exact staged commit and no origin lookup',()=>{
  assert.match(promote,/staged_head="\$\(git -C "\$STAGE_DIR" rev-parse HEAD/);
  assert.match(promote,/\[\[ "\$staged_head" == "\$commit" \]\]/);
  assert.match(promote,/git -C "\$INSTALL_DIR" fetch --update-shallow --no-tags "\$STAGE_DIR" "\$commit"/);
  assert.match(promote,/\[\[ "\$resolved" == "\$commit" \]\]/);
  assert.doesNotMatch(promote,/git -C "\$INSTALL_DIR" fetch --no-tags origin/);
});

test('verified local stage enables rollback without private origin branch', {skip:process.platform!=='linux'?'Requires native Linux Bash fixture':false},()=>withFixture(f=>{
  assert.equal(git(['-C',f.control,'remote','get-url','origin']),f.newer.dir);
  const missing=spawnSync('git',['-C',f.control,'ls-remote','--exit-code','origin','refs/heads/rollback-r521'],{encoding:'utf8'});
  assert.equal(missing.status,2);
  const p=promoteInFixture(f,f.old,f.old.commit);
  assert.equal(p.status,0,p.stdout+'\n'+p.stderr);
  assert.equal(git(['-C',f.control,'rev-parse','HEAD']),f.old.commit);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.control,'package.json'),'utf8')).version,'0.10.20');
  assert.equal(fs.readFileSync(path.join(f.control,'keep.txt'),'utf8'),f.sentinel);
}));
test('new and stable source roundtrip preserves user file across three cutovers', {skip:process.platform!=='linux'?'Requires native Linux Bash fixture':false},()=>withFixture(f=>{
  for(const stage of [f.old,f.newer,f.old]){
    const p=promoteInFixture(f,stage,stage.commit);
    assert.equal(p.status,0,p.stdout+'\n'+p.stderr);
    assert.equal(git(['-C',f.control,'rev-parse','HEAD']),stage.commit);
    assert.equal(fs.readFileSync(path.join(f.control,'keep.txt'),'utf8'),f.sentinel);
  }
}));
test('mismatched staged HEAD cannot promote different commit even if control contains it', {skip:process.platform!=='linux'?'Requires native Linux Bash fixture':false},()=>withFixture(f=>{
  const head=git(['-C',f.control,'rev-parse','HEAD']);
  const p=promoteInFixture(f,f.old,f.newer.commit);
  assert.notEqual(p.status,0);
  assert.equal(git(['-C',f.control,'rev-parse','HEAD']),head);
}));
test('substantive unstaged and staged tracked changes remain blocked', {skip:process.platform!=='linux'?'Requires native Linux Bash fixture':false},()=>withFixture(f=>{
  const head=git(['-C',f.control,'rev-parse','HEAD']);
  fs.writeFileSync(path.join(f.control,'package.json'),'{"version":"evil"}\n');
  for(const staged of [false,true]){
    if(staged)git(['-C',f.control,'add','package.json']);
    const p=promoteInFixture(f,f.old,f.old.commit);
    assert.notEqual(p.status,0);
    assert.equal(git(['-C',f.control,'rev-parse','HEAD']),head);
  }
}));
