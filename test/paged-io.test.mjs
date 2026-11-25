import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readText, writeText } from '../src/tools-v0.3.mjs';
import { readAnyFile, writeAnyFile, searchFiles } from '../src/power-tools-v0.3.mjs';
import { withFullPowerAccess } from './helpers/access-mode-fixtures.mjs';

function fixture(){
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc-paged-io-')));
  const config={allowedRoots:[root],maxReadBytes:8*1024*1024,maxWriteBytes:8*1024*1024,auditLog:path.join(root,'audit.jsonl'),
    powerMode:{enabled:true,fullFilesystem:true,maxFileBytes:8*1024*1024,allowShell:true,allowProcessControl:true,allowPermanentDelete:false,backupRoot:path.join(root,'backups')}};
  const ctx=withFullPowerAccess({config,roots:[root],auditLog:config.auditLog});
  return {root,ctx,dispose(){fs.rmSync(root,{recursive:true,force:true});}};
}

test('large text reads require paging and remain bounded',async()=>{
  const f=fixture();try{
    const p=path.join(f.root,'large.txt');fs.writeFileSync(p,'x'.repeat(700*1024));
    await assert.rejects(readText(f.ctx,{path:p}),/SYNCHRONOUS_READ_REQUIRES_PAGING/);
    const first=await readText(f.ctx,{path:p,offset:0,maxBytes:65536});
    assert.equal(first.bytes,65536);assert.equal(first.offset,0);assert.equal(first.nextOffset,65536);assert.equal(first.truncated,true);
    const second=await readText(f.ctx,{path:p,offset:first.nextOffset,maxBytes:65536});
    assert.equal(second.offset,65536);assert.equal(second.bytes,65536);
  }finally{f.dispose();}
});

test('large Power Mode file reads require bounded paging for utf8 and base64',async()=>{
  const f=fixture();try{
    const p=path.join(f.root,'large.bin');fs.writeFileSync(p,Buffer.alloc(700*1024,65));
    await assert.rejects(readAnyFile(f.ctx,{path:p,encoding:'base64'}),/SYNCHRONOUS_READ_REQUIRES_PAGING/);
    const page=await readAnyFile(f.ctx,{path:p,encoding:'base64',offset:0,maxBytes:262144});
    assert.equal(page.bytes,262144);assert.equal(page.truncated,true);assert.ok(page.content.length<400000);
  }finally{f.dispose();}
});

test('synchronous write payloads are capped below the 1 MiB HTTP request envelope',async()=>{
  const f=fixture();try{
    const text='x'.repeat(600*1024);
    await assert.rejects(writeText(f.ctx,{path:path.join(f.root,'too-large.txt'),content:text}),/exceeds maxWriteBytes/);
    await assert.rejects(writeAnyFile(f.ctx,{path:path.join(f.root,'too-large.bin'),content:text,encoding:'utf8'}),/synchronous write limit/);
    const ok='x'.repeat(256*1024);
    assert.equal((await writeText(f.ctx,{path:path.join(f.root,'ok.txt'),content:ok})).bytes,Buffer.byteLength(ok));
  }finally{f.dispose();}
});

test('search is result-capped and exposes timeout/truncation state',async()=>{
  const f=fixture();try{
    for(let i=0;i<240;i++)fs.writeFileSync(path.join(f.root,`match-${i}.txt`),'needle');
    const r=await searchFiles(f.ctx,{path:f.root,pattern:'match-',maxResults:200,maxDurationMs:10000});
    assert.ok(r.count<=200);assert.equal(typeof r.timedOut,'boolean');assert.equal(r.truncated,true);
  }finally{f.dispose();}
});


test('UTF-8 paging preserves multibyte boundaries and rejects unsafe arbitrary offsets', async()=>{
  const f=fixture();try{
    const original='الف🙂'.repeat(5000);
    const p=path.join(f.root,'unicode.txt');fs.writeFileSync(p,original,'utf8');
    let offset=0,combined='';
    do{
      const page=await readText(f.ctx,{path:p,offset,maxBytes:17});
      combined+=page.text;
      offset=page.nextOffset;
    }while(offset!==null);
    assert.equal(combined,original);
    await assert.rejects(readText(f.ctx,{path:p,offset:1,maxBytes:16}),/UTF8_PAGE_OFFSET_UNSAFE/);
    await assert.rejects(readAnyFile(f.ctx,{path:p,encoding:'utf8',offset:1,maxBytes:16}),/UTF8_PAGE_OFFSET_UNSAFE/);
  }finally{f.dispose();}
});
