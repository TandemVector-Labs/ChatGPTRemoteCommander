import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..');
const script=fs.readFileSync(path.join(root,'tools','build-native-linux-package.sh'),'utf8');
const begin="python3 - \"$ROOT\" <<'SOURCE_GUARD'\n";
const guard=script.split(begin)[1]?.split('\nSOURCE_GUARD')[0];
assert.ok(guard?.includes('NATIVE_GIT_ATTRIBUTES_EXACT_BLOB_PASS'));

function git(dir,...args){
 const r=spawnSync('git',args,{cwd:dir,encoding:'utf8',timeout:10000});
 assert.equal(r.status,0,`${args.join(' ')}: ${r.stderr}`);
 return r.stdout;
}
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rc-git-clean-guard-'));
 git(dir,'init','-q');
 git(dir,'config','user.name','QA Fixture');
 git(dir,'config','user.email','qa@example.test');
 fs.writeFileSync(path.join(dir,'fixture.txt'),'first\r\nsecond\r\n');
 git(dir,'-c','core.autocrlf=false','add','fixture.txt');
 git(dir,'commit','-qm','preserve historical CRLF blob');
 fs.writeFileSync(path.join(dir,'.gitattributes'),'fixture.txt text eol=lf\n');
 git(dir,'add','.gitattributes');
 git(dir,'commit','-qm','add newer LF worktree rule');
 return dir;
}
function run(dir){
 return spawnSync('python3',['-',dir],{input:guard,encoding:'utf8',timeout:10000});
}
const linuxOnly=process.platform==='linux'?test:test.skip;
linuxOnly('exact blob identity accepts historical CRLF under newer LF attribute without accepting real edits',()=>{
 const dir=fixture();
 try{
   const status=git(dir,'status','--porcelain=v1');
   assert.match(status,/ M fixture\.txt/);
   const good=run(dir);
   assert.equal(good.status,0,good.stderr);
   assert.match(good.stdout,/NATIVE_GIT_ATTRIBUTES_EXACT_BLOB_PASS/);
   fs.appendFileSync(path.join(dir,'fixture.txt'),'tampered\n');
   const bad=run(dir);
   assert.equal(bad.status,3,bad.stderr);
   assert.match(bad.stderr,/NATIVE_LINUX_PACKAGE_REQUIRES_CLEAN_SOURCE/);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
linuxOnly('clean-source guard rejects any untracked file even when tracked blobs match',()=>{
 const dir=fixture();
 try{
   fs.writeFileSync(path.join(dir,'extra.txt'),'unexpected');
   const r=run(dir);
   assert.equal(r.status,3,r.stderr);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
linuxOnly('clean-source guard rejects staged modifications rather than trusting their raw bytes',()=>{
 const dir=fixture();
 try{
   fs.appendFileSync(path.join(dir,'fixture.txt'),'tracked edit\n');
   git(dir,'add','fixture.txt');
   const r=run(dir);
   assert.equal(r.status,3,r.stderr);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
