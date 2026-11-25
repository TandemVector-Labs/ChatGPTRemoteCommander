import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {assembleV012Overlay,parseArgs} from '../tools/v1-01/assemble-v012-j01-g1-overlay.mjs';

test('V012 G1/J01 builder requires exact absolute inputs and no duplicate keys',()=>{
 const good=path.resolve('test');
 assert.deepEqual(parseArgs(['--qa-root='+good,'--output='+path.join(good,'new')]),
   {qa:good,output:path.join(good,'new')});
 for(const args of [
   [],['--qa-root='+good],['--qa-root='+good,'--output=relative'],
   ['--qa-root=relative','--output='+good],
   ['--qa-root='+good,'--qa-root='+good],
   ['--qa-root='+good,'--output='+good,'--unsafe=true']
 ])assert.throws(()=>parseArgs(args),/V012_OVERLAY_/);
});
test('V012 G1/J01 overlay refuses to overwrite a nonempty existing destination',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'v012-overlay-no-clobber-'));
 const out=path.join(root,'existing'),marker=path.join(out,'owner.txt');
 fs.mkdirSync(out);fs.writeFileSync(marker,'PRESERVE_OWNER_DATA');
 try{
   assert.throws(()=>assembleV012Overlay({qa:root,output:out}),
     /V012_OVERLAY_OUTPUT_ALREADY_EXISTS/);
   assert.equal(fs.readFileSync(marker,'utf8'),'PRESERVE_OWNER_DATA');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('V012 overlay does not publish from an unverified older or missing QA source',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'v012-overlay-qa-source-'));
 const candidate=path.join(root,'candidate'),out=path.join(root,'out');
 fs.mkdirSync(candidate);
 try{
   fs.writeFileSync(path.join(candidate,'package.json'),
      JSON.stringify({version:'0.11.0-dev.15'}));
   assert.throws(()=>assembleV012Overlay({qa:candidate,output:out}),
      /V012_OVERLAY_SOURCE_VERSION_UNEXPECTED/);
   assert.equal(fs.existsSync(out),false);
   fs.writeFileSync(path.join(candidate,'package.json'),
      JSON.stringify({version:'0.11.0-dev.23'}));
   assert.throws(()=>assembleV012Overlay({qa:candidate,output:out}),
      /V012_OVERLAY_VALIDATION_FAILED/);
   assert.equal(fs.existsSync(out),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
