import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const auditScript=fileURLToPath(new URL('./security-audit.mjs',import.meta.url));
function run(command,args,cwd){
  const p=spawnSync(command,args,{cwd,encoding:'utf8',timeout:45000});
  if(p.error||p.status!==0)throw Error('synthetic Git fixture operation failed: '+command);
}
function audit(cwd){
  const p=spawnSync(process.execPath,[auditScript],{cwd,encoding:'utf8',timeout:45000});
  if(p.error)throw p.error;
  const printed=(p.stdout||'')+'\n'+(p.stderr||'');
  const history=printed.split(/\r?\n/).filter(s=>s.startsWith('{"scope":"HISTORY"')).map(s=>JSON.parse(s));
  return {status:p.status,printed,history};
}
function commit(cwd,message){
  run('git',['add','-A'],cwd);
  run('git',['-c','user.name=Test Fixture','-c','user.email=fixture@example.invalid',
    'commit','-qm',message],cwd);
}
test('history audit counts distinct synthetic matches but never waives another bearer', {timeout:120000},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-audit-multihit-'));
  const make=(value)=>['Bearer',' ',value].join('');
  const oldA=make('fixtureOneNotCredential_abcdefghijklmnopqrst12345');
  const oldB=make('fixtureTwoNotCredential_abcdefghijklmnopqrst12345');
  const unexpected=make('unrecognizedFutureToken_abcdefghijklmnopqrst12345');
  try{
    run('git',['init','-q'],root);
    fs.writeFileSync(path.join(root,'.gitignore'),[
      'config.local.json','.env','connections.local.json',
      'credentials/example.dpapi','downloads/example.zip',''
    ].join('\n'));
    fs.writeFileSync(path.join(root,'placeholder.txt'),oldA+'\n');
    commit(root,'introduce synthetic A');
    fs.writeFileSync(path.join(root,'placeholder.txt'),oldB+'\n');
    commit(root,'change to synthetic B');
    fs.unlinkSync(path.join(root,'placeholder.txt'));
    commit(root,'remove mock file');
    const first=audit(root);
    assert.equal(first.status,1,'historical mock still fails closed');
    assert.match(first.printed,/SECURITY_AUDIT_FAIL/);
    const h04=first.history.find(x=>x.ruleId==='H04');
    assert.ok(h04);
    assert.equal(h04.matchCount,4);
    assert.equal(h04.moreThanLimit,false);
    assert.equal(h04.otherProvenance.length,3);
    for(const value of [oldA,oldB,unexpected])assert.ok(!first.printed.includes(value),
      'never print matching bytes');

    // The same rule must also detect a *new*, different token in a new commit,
    // without whitelisting a whole file, regex, branch, or mock-token pattern.
    fs.writeFileSync(path.join(root,'unexpected.txt'),unexpected+'\n');
    commit(root,'introduce a different unexpected token');
    const second=audit(root);
    assert.equal(second.status,1);
    assert.match(second.printed,/SECURITY_AUDIT_FAIL/);
    const h042=second.history.find(x=>x.ruleId==='H04');
    assert.ok(h042);
    assert.equal(h042.matchCount,5);
    assert.equal(h042.moreThanLimit,false);
    assert.ok(second.printed.includes('"scope":"CURRENT"'));
    assert.ok(!second.printed.includes(unexpected),'never print new token bytes');
  }finally{
    fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
});
