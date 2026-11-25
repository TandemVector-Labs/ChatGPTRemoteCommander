import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helper = path.join(repo, 'tools', 'offline-shallow-source.ps1');
function exec(program,args,{cwd=repo,allowFailure=false}={}){
  const r=spawnSync(program,args,{cwd,encoding:'utf8',windowsHide:true,
    timeout:30000,maxBuffer:4*1024*1024});
  if(!allowFailure)assert.equal(r.status,0,
    program+' '+args.join(' ')+'\n'+(r.stderr||r.error||''));
  return r;
}
function git(args,opts){return exec('git.exe',args,opts).stdout.trim();}
function helperCall(args,{allowFailure=false}={}){
  const r=exec('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',helper,...args],
    {allowFailure});
  if(allowFailure)return r;
  const last=r.stdout.trim().split(/\r?\n/).at(-1);
  return JSON.parse(last);
}

test('actual Windows Shallow Git ZIP preserves pinned offline commit but excludes deleted Git history',
  {skip:process.platform!=='win32'},()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'rc-s7-shallow-qa-'));
    try{
      const src=path.join(root,'source');
      git(['init','-q',src]);
      git(['-C',src,'config','user.name','Synthetic CI']);
      git(['-C',src,'config','user.email','synthetic@example.invalid']);
      git(['-C',src,'branch','-M','main']);
      const old=path.join(src,'extensions','coucou-bridge','agent.json');
      fs.mkdirSync(path.dirname(old),{recursive:true});
      fs.writeFileSync(old,'S7_OLD_ONLY_PRIVATE_TEST_FIXTURE');
      git(['-C',src,'add','.']);
      git(['-C',src,'commit','-qm','old specialist fixture']);
      const oldSha=git(['-C',src,'rev-parse','HEAD']);
      git(['-C',src,'rm','-qr','extensions']);
      fs.writeFileSync(path.join(src,'README.md'),'PUBLIC_FIXTURE_ONLY');
      git(['-C',src,'add','.']);
      git(['-C',src,'commit','-qm','delete old fixture']);
      const sha=git(['-C',src,'rev-parse','HEAD']);
      assert.notEqual(oldSha,sha);
      const zip=path.join(root,'exact-source.zip');
      const base=['-SourceRef','main','-ExpectedCommit',sha,'-Archive',zip];
      const created=helperCall(['-Mode','Create','-SourceRoot',src,...base]);
      assert.equal(created.status,'SHALLOW_SOURCE_SNAPSHOT_CREATED');
      assert.equal(created.head,sha);
      const checksum=created.sha256;
      assert.match(checksum,/^[0-9a-f]{64}$/);
      assert.equal(helperCall(['-Mode','Preflight',...base,'-ArchiveSha256',checksum]).status,
        'SHALLOW_SOURCE_ARCHIVE_PREFLIGHT_PASS');
      assert.notEqual(helperCall(['-Mode','Preflight',...base],
        {allowFailure:true}).status,0,'missing archive SHA must fail before prerequisites');
      assert.equal(helperCall(['-Mode','Verify',...base,'-ArchiveSha256',checksum]).status,
        'SHALLOW_SOURCE_SNAPSHOT_VERIFIED');
      const store=path.join(root,'store');
      const imported=helperCall(['-Mode','Import',...base,
        '-ArchiveSha256',checksum,'-StoreRoot',store]);
      assert.equal(imported.status,'SHALLOW_SOURCE_IMPORTED');
      const bare=imported.repoRoot;
      assert.equal(helperCall(['-Mode','VerifyRepo','-SourceRef','main',
        '-ExpectedCommit',sha,'-RepoRoot',bare]).status,
        'SHALLOW_SOURCE_REPOSITORY_VERIFIED');
      assert.equal(helperCall(['-Mode','Import',...base,
        '-ArchiveSha256',checksum,'-StoreRoot',store]).status,
        'SHALLOW_SOURCE_ALREADY_IMPORTED');
      assert.equal(git(['--git-dir='+bare,'rev-parse','HEAD']),sha);
      assert.equal(git(['--git-dir='+bare,'rev-list','--count','--all']),'1');
      assert.notEqual(exec('git.exe',['--git-dir='+bare,'cat-file','-e',oldSha],
        {allowFailure:true}).status,0,'historical specialist commit must be absent');
      const installed=path.join(root,'offline-target');
      git(['init','-q',installed]);
      git(['-C',installed,'remote','add','origin',bare]);
      git(['-C',installed,'fetch','--depth','1','--no-tags','origin','main']);
      git(['-C',installed,'checkout','-q','--detach','FETCH_HEAD']);
      assert.equal(git(['-C',installed,'rev-parse','HEAD']),sha);
      assert.equal(git(['-C',installed,'rev-parse','--is-shallow-repository']),'true');
      assert.equal(fs.readFileSync(path.join(installed,'README.md'),'utf8'),
        'PUBLIC_FIXTURE_ONLY');
      const wrong='0'.repeat(64);
      assert.notEqual(helperCall(['-Mode','Import',...base,
        '-ArchiveSha256',wrong,'-StoreRoot',store],
        {allowFailure:true}).status,0,'tampered expected SHA must fail closed');
      assert.equal(git(['--git-dir='+bare,'rev-parse','HEAD']),sha,
        'negative test may not mutate previously accepted staged source');
    }finally{
      fs.rmSync(root,{recursive:true,force:true});
    }
});
