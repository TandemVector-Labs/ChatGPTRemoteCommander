import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {writeText} from '../src/tools-v0.3.mjs';
import {writeAnyFile} from '../src/power-tools-v0.3.mjs';
import { withFullPowerAccess } from './helpers/access-mode-fixtures.mjs';
const fixture=()=>{
 const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'rc-integrity-')));
 const ctx={roots:[root],auditLog:path.join(root,'audit.jsonl'),config:{maxWriteBytes:524288,powerMode:{enabled:true,fullFilesystem:false,backupRoot:path.join(root,'backups')}}};
 withFullPowerAccess(ctx);
 return{root,ctx,dispose(){fs.rmSync(root,{recursive:true,force:true});}};
};
for(const [name,write] of [['standard',writeText],['power',writeAnyFile]]){
 test(name+' refuses missing expected-hash target without creating it',async()=>{const f=fixture();try{const p=path.join(f.root,'missing.txt');await assert.rejects(write(f.ctx,{path:p,content:'no',expectedSha256:'a'.repeat(64)}),/precondition/);assert.equal(fs.existsSync(p),false);}finally{f.dispose();}});
 test(name+' rejects malformed hash before touching target',async()=>{const f=fixture();try{const p=path.join(f.root,'missing.txt');await assert.rejects(write(f.ctx,{path:p,content:'no',expectedSha256:''}),/64-hex/);assert.equal(fs.existsSync(p),false);}finally{f.dispose();}});
 test(name+' exact hash allows change and wrong hash preserves bytes',async()=>{const f=fixture();try{const p=path.join(f.root,'present.txt');fs.writeFileSync(p,'before');await assert.rejects(write(f.ctx,{path:p,content:'bad',expectedSha256:'a'.repeat(64)}),/does not match/);assert.equal(fs.readFileSync(p,'utf8'),'before');const sha=createHash('sha256').update('before').digest('hex');await write(f.ctx,{path:p,content:'after',expectedSha256:sha});assert.equal(fs.readFileSync(p,'utf8'),'after');}finally{f.dispose();}});
}
test('power hash failure does not create new parents',async()=>{const f=fixture();try{const p=path.join(f.root,'new','missing.txt');await assert.rejects(writeAnyFile(f.ctx,{path:p,content:'no',expectedSha256:'a'.repeat(64)}),/precondition/);assert.equal(fs.existsSync(path.join(f.root,'new')),false);}finally{f.dispose();}});
for(const overwrite of [false,true])test('partial source deletion retains full promoted destination overwrite='+overwrite,async()=>{const f=fixture();try{
 const moduleRoot=path.join(f.root,'fault-src');fs.cpSync(path.resolve('src'),moduleRoot,{recursive:true});const p=path.join(moduleRoot,'power-tools-v0.3.mjs');let code=fs.readFileSync(p,'utf8');const anchor='await rm(sourceNow, { recursive: true, force: true });';assert.equal(code.split(anchor).length,2);code=code.replace(anchor,"await rm(path.join(sourceNow,'unique.txt')); throw Object.assign(new Error('INJECTED_PARTIAL_DELETE'),{code:'EACCES'});");fs.writeFileSync(p,code);
 const source=path.join(f.root,'source'),destination=path.join(f.root,'destination');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'unique.txt'),'complete original');fs.writeFileSync(path.join(source,'remaining.txt'),'partial source');if(overwrite){fs.mkdirSync(destination);fs.writeFileSync(path.join(destination,'old.txt'),'old target');}
 const {movePath}=await import(pathToFileURL(p).href);let error;try{await movePath(f.ctx,{source,destination,overwrite});}catch(e){error=e;}assert.match(error?.message??'',/MOVE_RECOVERY_REQUIRED/);
 assert.equal(fs.readFileSync(path.join(destination,'unique.txt'),'utf8'),'complete original');assert.equal(fs.readFileSync(path.join(source,'remaining.txt'),'utf8'),'partial source');assert.equal(error.recovery.destinationPreserved,true);
 if(overwrite){assert.equal(fs.readFileSync(path.join(error.recovery.displaced,'old.txt'),'utf8'),'old target');assert.ok(error.recovery.backupPath);}
}finally{f.dispose();}});
