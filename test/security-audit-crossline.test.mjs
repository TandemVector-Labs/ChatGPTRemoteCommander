import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const audit=fileURLToPath(new URL('./security-audit.mjs',import.meta.url));
const token='Q'.repeat(28);
const bearer='Bearer'+' ';
function git(cwd,...args) {
  const r=spawnSync('git',args,{cwd,encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,'git '+args.join(' ')+': '+r.stderr);
}
function fixture(createHistory) {
  const cwd=mkdtempSync(join(tmpdir(),'h04-history-regression-'));
  try {
    git(cwd,'init','-q');
    git(cwd,'config','user.name','Test');
    git(cwd,'config','user.email','test@local.invalid');
    writeFileSync(join(cwd,'.gitignore'),'config.local.json\n.env\nconnections.local.json\ncredentials/*\ndownloads/*\n');
    git(cwd,'add','.gitignore');
    git(cwd,'commit','-qm','baseline');
    createHistory(cwd);
    const r=spawnSync(process.execPath,[audit],{cwd,encoding:'utf8',timeout:10000});
    assert.equal(r.error,undefined,'audit launch failed: '+r.error);
    return r;
  } finally {
    rmSync(cwd,{recursive:true,force:true});
  }
}
test('historical added-only split Bearer must fail even when checked-out tree is clean',()=>{
  const r=fixture(cwd=>{
    git(cwd,'branch','clean');
    writeFileSync(join(cwd,'payload.txt'),bearer+'\n'+token+'\n');
    git(cwd,'add','payload.txt');git(cwd,'commit','-qm','historical synthetic add');
    git(cwd,'switch','-q','clean');
  });
  assert.equal(r.status,1);
  assert.match(r.stderr,/SECURITY_AUDIT_FAIL/);
  assert.match(r.stderr,/"scope":"HISTORY","type":"Bearer token literal"/);
});
test('added line and unchanged context line form a real token in new revision',()=>{
  const r=fixture(cwd=>{
    writeFileSync(join(cwd,'payload.txt'),token+'\n');
    git(cwd,'add','payload.txt');git(cwd,'commit','-qm','old bare string');
    git(cwd,'branch','clean');
    writeFileSync(join(cwd,'payload.txt'),bearer+'\n'+token+'\n');
    git(cwd,'add','payload.txt');git(cwd,'commit','-qm','prepend bearer');
    git(cwd,'switch','-q','clean');
  });
  assert.equal(r.status,1);
  assert.match(r.stderr,/"scope":"HISTORY","type":"Bearer token literal"/);
});
test('unrelated removed and added lines must not join into a token',()=>{
  const r=fixture(cwd=>{
    writeFileSync(join(cwd,'payload.txt'),token+'\n');
    git(cwd,'add','payload.txt');git(cwd,'commit','-qm','old no bearer');
    git(cwd,'branch','clean');
    writeFileSync(join(cwd,'payload.txt'),bearer+'\n');
    git(cwd,'add','payload.txt');git(cwd,'commit','-qm','new no token');
    git(cwd,'switch','-q','clean');
  });
  assert.equal(r.status,0,'audit unexpectedly failed: '+r.stderr);
  assert.match(r.stdout,/SECURITY_AUDIT_PASS/);
});
test('tokens from different file diffs must not combine',()=>{
  const r=fixture(cwd=>{
    git(cwd,'branch','clean');
    writeFileSync(join(cwd,'a.txt'),bearer+'\n');
    writeFileSync(join(cwd,'b.txt'),token+'\n');
    git(cwd,'add','a.txt','b.txt');git(cwd,'commit','-qm','separate files');
    git(cwd,'switch','-q','clean');
  });
  assert.equal(r.status,0,'audit unexpectedly failed: '+r.stderr);
  assert.match(r.stdout,/SECURITY_AUDIT_PASS/);
});

test('historical added-only newline split token without trailing space must fail',()=>{
  const r=fixture(cwd=>{
    git(cwd,'branch','clean');
    writeFileSync(join(cwd,'payload.txt'),'Bearer'+'\n'+token+'\n');
    git(cwd,'add','payload.txt');git(cwd,'commit','-qm','historical newline split');
    git(cwd,'switch','-q','clean');
  });
  assert.equal(r.status,1);
  assert.match(r.stderr,/"scope":"HISTORY","type":"Bearer token literal"/);
});
