import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {parseArgs,runPinnedInterop,parseCandidateArgs,isVersionAtLeast,runVersionedCandidateInterop} from '../tools/v1-01/run-pinned-v2-interop.mjs';

const sha='a'.repeat(40);
test('pinned V2 interop requires a single explicit absolute source and full commit',()=>{
  for(const args of [
    [],['--commit='+sha],['--v2-repo=relative','--commit='+sha],
    ['--v2-repo='+path.resolve('test'),'--commit=main'],
    ['--v2-repo='+path.resolve('test'),'--commit='+sha,'--commit='+sha],
    ['--v2-repo='+path.resolve('test'),'--commit='+sha,'--unsigned=1'],
  ])assert.throws(()=>parseArgs(args),/V101_INTEROP_/);
  const repository=path.resolve('test');
  const good=parseArgs(['--v2-repo='+repository,'--commit='+sha]);
  assert.equal(good.repository,repository);
  assert.equal(good.commit,sha);
});
test('non-repository source never qualifies as V2 interop and cannot start candidate ingress',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'rc-v101-invalid-repo-'));
  try{
    assert.throws(()=>runPinnedInterop({repository:dir,commit:sha}),
      /V101_INTEROP_COMMAND_FAILED/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});


const candidateFiles=[
  'src/v2-mcp-http-ingress.mjs',
  'src/v2-oauth-resource-metadata.mjs',
  'src/v2-direct-mtls-attestor.mjs',
  'src/v2-openai-mtls-trust.mjs'
];
function candidateFixture(version='0.11.0-dev.23'){
  const root=mkdtempSync(path.join(tmpdir(),'v101-versioned-candidate-'));
  mkdirSync(path.join(root,'src'));
  writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'candidate',version,type:'module'}));
  for(const file of candidateFiles)writeFileSync(path.join(root,file),'export const testFixture=true;\n');
  return root;
}
test('versioned V2 interop comparator rejects downgrades including earlier dev releases',()=>{
  for(const [actual,min,expected] of [
    ['0.11.0-dev.15','0.11.0-dev.23',false],
    ['0.11.0-dev.23','0.11.0-dev.23',true],
    ['0.11.0-dev.24','0.11.0-dev.23',true],
    ['0.11.0','0.11.0-dev.23',true],
    ['0.10.99','0.11.0-dev.23',false],
    ['0.12.0-dev.1','0.11.0-dev.23',true],
    ['0.11.0-dev.23','0.11.0',false],
  ])assert.equal(isVersionAtLeast(actual,min),expected,actual+' / '+min);
  for(const bad of ['main','0.11.0-dev','0.11.0-dev.023','0.11.0-rc.1','1.2.3+private','0.11.0-dev.99999999999999999999999'])
    assert.throws(()=>isVersionAtLeast(bad,'0.11.0-dev.23'),/V101_CANDIDATE_VERSION_INVALID/);
});
test('versioned V2 interop requires explicit local root, minimum version, and pinned digest',()=>{
  const root=path.resolve('test');
  const good=parseCandidateArgs(['--candidate-root='+root,'--minimum-version=0.11.0-dev.23',
    '--source-sha256='+'b'.repeat(64)]);
  assert.equal(good.root,root);
  assert.equal(good.digest,'b'.repeat(64));
  const inspect=parseCandidateArgs(['--candidate-root='+root,'--minimum-version=0.11.0-dev.23','--inspect']);
  assert.equal(inspect.inspect,true);
  for(const args of [
    [],['--candidate-root='+root,'--minimum-version=0.11.0-dev.23'],
    ['--candidate-root=relative','--minimum-version=0.11.0-dev.23','--inspect'],
    ['--candidate-root='+root,'--minimum-version=0.11.0-dev.15','--inspect','--source-sha256='+'b'.repeat(64)],
    ['--candidate-root='+root,'--minimum-version=0.11.0-dev.23','--source-sha256=bad'],
    ['--candidate-root='+root,'--minimum-version=0.11.0-dev.23','--inspect','--privileged=true'],
    ['--candidate-root='+root,'--minimum-version=0.11.0-dev.23','--inspect','--inspect'],
  ])assert.throws(()=>parseCandidateArgs(args),/V101_CANDIDATE_/);
});
test('versioned candidate source refuses earlier package and incorrect digest without executing tests',()=>{
  const root=candidateFixture('0.11.0-dev.15');
  try{
    assert.throws(()=>runVersionedCandidateInterop({
      root,minimumVersion:'0.11.0-dev.23',digest:'a'.repeat(64)
    }),/V101_CANDIDATE_DOWNGRADE_REJECTED/);
    writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'candidate',version:'0.11.0-dev.23'}));
    assert.throws(()=>runVersionedCandidateInterop({
      root,minimumVersion:'0.11.0-dev.23',digest:'a'.repeat(64)
    }),/V101_CANDIDATE_DIGEST_MISMATCH/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('versioned candidate input rejects symlinked V2 module before starting a process',()=>{
  const root=candidateFixture();
  const outside=path.join(root,'source-outside.mjs'),module=path.join(root,candidateFiles[0]);
  try{
    writeFileSync(outside,'export const dummy=true;\n');
    rmSync(module);
    try{
      symlinkSync(outside,module);
      assert.throws(()=>runVersionedCandidateInterop({
        root,minimumVersion:'0.11.0-dev.23',digest:'a'.repeat(64)
      }),/V101_CANDIDATE_FILE_INVALID/);
    }catch(error){
      if(!['EPERM','EACCES','ENOTSUP'].includes(error.code))throw error;
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});
