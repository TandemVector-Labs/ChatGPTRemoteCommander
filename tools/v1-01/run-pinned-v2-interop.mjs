#!/usr/bin/env node
// V1-01: reproducible, isolated V1/V2 source-interop gate.
// No remote download, persistent install, live router switch or credentials.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,lstatSync,realpathSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const SHA=/^[a-f0-9]{40}$/;
const FILES=Object.freeze([
  'package.json','src/v2-mcp-http-ingress.mjs',
  'src/v2-oauth-resource-metadata.mjs',
  'src/v2-direct-mtls-attestor.mjs',
  'src/v2-openai-mtls-trust.mjs'
]);
const TEST=fileURLToPath(new URL('../v101-v2-protected-ingress-interop.test.mjs',import.meta.url));

function fail(code){throw Object.assign(new Error(code),{code});}
export function parseArgs(args){
  if(!Array.isArray(args)||args.length!==2)fail('V101_INTEROP_EXACT_SOURCE_AND_SHA_REQUIRED');
  const result=Object.create(null);
  for(const input of args){
    if(typeof input!=='string')fail('V101_INTEROP_ARGUMENT_INVALID');
    const at=input.indexOf('='),key=input.slice(0,at),value=input.slice(at+1);
    if(at<=0||!value||!['--v2-repo','--commit'].includes(key)
      ||Object.hasOwn(result,key))fail('V101_INTEROP_ARGUMENT_INVALID');
    result[key]=value;
  }
  if(!path.isAbsolute(result['--v2-repo'])||!SHA.test(result['--commit']))
    fail('V101_INTEROP_PIN_REQUIRED');
  return {repository:path.resolve(result['--v2-repo']),commit:result['--commit']};
}
function run(program,args,options={}){
  const result=spawnSync(program,args,{
    encoding:'utf8',windowsHide:true,timeout:30000,
    maxBuffer:1024*1024,stdio:['ignore','pipe','pipe'],...options
  });
  if(result.error||result.status!==0||result.signal)
    fail('V101_INTEROP_COMMAND_FAILED:'+program+':'+(result.error?.code??result.status));
  return result;
}
function safeEnv(extra={}){
  // Never propagate bearer tokens, client secrets or connector credentials.
  const keys=['PATH','Path','PATHEXT','SystemRoot','SYSTEMROOT','WINDIR','ComSpec',
    'TEMP','TMP','TMPDIR','HOME','USERPROFILE','USER','LOGNAME','LANG','LC_ALL'];
  const out=Object.create(null);
  for(const key of keys)
    if(typeof process.env[key]==='string'&&process.env[key])
      out[key]=process.env[key];
  return {...out,...extra};
}
export function runPinnedInterop({repository,commit}){
  const st=lstatSync(repository);
  if(!st.isDirectory()||st.isSymbolicLink())fail('V101_INTEROP_REPOSITORY_INVALID');
  const canonical=realpathSync.native(repository);
  // Per-invocation Git exception only for the explicitly chosen read-only
  // source repository; never change user/global safe.directory settings.
  const git=['-c','safe.directory='+canonical,'-C',canonical];
  const env=safeEnv();
  const type=run('git',[...git,'cat-file','-t',commit],{env}).stdout.trim();
  if(type!=='commit')fail('V101_INTEROP_COMMIT_REQUIRED');
  const scratch=mkdtempSync(path.join(tmpdir(),'rc-v101-v2-interop-'));
  try{
    const archive=path.join(scratch,'source.tar');
    run('git',[...git,'archive','--format=tar','--output='+archive,
      commit,'--',...FILES],{env});
    run('tar',['-xf',archive,'-C',scratch],{env});
    for(const relative of FILES){
      const source=path.join(scratch,relative);
      const entry=lstatSync(source);
      if(!entry.isFile()||entry.isSymbolicLink()
         ||realpathSync.native(source)!==path.resolve(source))
        fail('V101_INTEROP_EXTRACTED_SOURCE_INVALID');
    }
    const test=spawnSync(process.execPath,['--test',TEST],{
      cwd:path.dirname(TEST),encoding:'utf8',windowsHide:true,
      timeout:30000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe'],
      env:safeEnv({RC_V2_CANDIDATE_ROOT:scratch})
    });
    if(test.stdout)process.stdout.write(test.stdout);
    if(test.stderr)process.stderr.write(test.stderr);
    if(test.error||test.signal||test.status!==0)
      fail('V101_INTEROP_TEST_FAILED');
    process.stdout.write('V101_PINNED_V2_SOURCE_INTEROP_PASS commit='+commit+'\n');
    return true;
  }finally{rmSync(scratch,{recursive:true,force:true});}
}

const PIN_SHA=/^[0-9a-f]{64}$/;
const DEV_VERSION=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-dev\.(0|[1-9]\d*))?$/;
function versionParts(v){
  if(typeof v!=='string'||!DEV_VERSION.test(v))fail('V101_CANDIDATE_VERSION_INVALID');
  const p=v.match(DEV_VERSION);
  const result=[Number(p[1]),Number(p[2]),Number(p[3]),
    p[4]===undefined?1:0,Number(p[4]??0)];
  if(result.some(n=>!Number.isSafeInteger(n)))fail('V101_CANDIDATE_VERSION_INVALID');
  return result;
}
export function isVersionAtLeast(actual,required){
  const a=versionParts(actual),b=versionParts(required);
  for(let i=0;i<a.length;i++){
    if(a[i]>b[i])return true;
    if(a[i]<b[i])return false;
  }
  return true;
}
export function parseCandidateArgs(args){
  if(!Array.isArray(args)||args.length<2||args.length>3)fail('V101_CANDIDATE_ARGUMENTS_INVALID');
  const values=Object.create(null);
  for(const s of args){
    if(typeof s!=='string')fail('V101_CANDIDATE_ARGUMENTS_INVALID');
    if(s==='--inspect'){
      if(Object.hasOwn(values,'--inspect'))fail('V101_CANDIDATE_ARGUMENTS_INVALID');
      values['--inspect']=true;continue;
    }
    const k=s.slice(0,s.indexOf('=')),v=s.slice(s.indexOf('=')+1);
    if(!['--candidate-root','--minimum-version','--source-sha256'].includes(k)
       ||s.indexOf('=')<1||!v||Object.hasOwn(values,k))fail('V101_CANDIDATE_ARGUMENTS_INVALID');
    values[k]=v;
  }
  if(!path.isAbsolute(values['--candidate-root']??''))fail('V101_CANDIDATE_ROOT_ABSOLUTE_REQUIRED');
  versionParts(values['--minimum-version']);
  if(values['--inspect']){
    if(Object.hasOwn(values,'--source-sha256'))fail('V101_CANDIDATE_ARGUMENTS_INVALID');
  }else if(!PIN_SHA.test(values['--source-sha256']??''))fail('V101_CANDIDATE_DIGEST_REQUIRED');
  return {
    root:path.resolve(values['--candidate-root']),
    minimumVersion:values['--minimum-version'],
    digest:values['--source-sha256']??null,
    inspect:values['--inspect']===true
  };
}
function candidateSource(root){
  const st=lstatSync(root);
  if(!st.isDirectory()||st.isSymbolicLink()||
    realpathSync.native(root).toLowerCase()!==path.resolve(root).toLowerCase())
    fail('V101_CANDIDATE_ROOT_INVALID');
  const h=createHash('sha256'),data=new Map();
  for(const relative of FILES){
    const target=path.join(root,relative);
    const parent=path.dirname(target);
    const pst=lstatSync(parent),st=lstatSync(target);
    if(!pst.isDirectory()||pst.isSymbolicLink()||!st.isFile()||st.isSymbolicLink()||
      st.size<1||st.size>1024*1024||
      realpathSync.native(target).toLowerCase()!==path.resolve(target).toLowerCase())
      fail('V101_CANDIDATE_FILE_INVALID');
    const bytes=readFileSync(target);
    const after=lstatSync(target);
    if(st.size!==bytes.length||st.size!==after.size||st.mtimeMs!==after.mtimeMs||
      st.ino!==after.ino||st.dev!==after.dev)fail('V101_CANDIDATE_FILE_CHANGED');
    const digest=createHash('sha256').update(bytes).digest('hex');
    h.update(relative).update('\0').update(digest).update('\n');
    data.set(relative,bytes);
  }
  const pkg=JSON.parse(data.get('package.json').toString('utf8'));
  return {digest:h.digest('hex'),version:pkg?.version,files:data};
}
export function runVersionedCandidateInterop({root,minimumVersion,digest,inspect=false}){
  const snapshot=candidateSource(root);
  if(!isVersionAtLeast(snapshot.version,minimumVersion))
    fail('V101_CANDIDATE_DOWNGRADE_REJECTED');
  if(inspect){
    process.stdout.write(JSON.stringify({
      status:'PIN_DISCOVERY_ONLY',version:snapshot.version,
      minimumVersion,sourceSha256:snapshot.digest,
      productionG1Accepted:false})+'\n');
    return false;
  }
  if(!PIN_SHA.test(digest??'')||snapshot.digest!==digest)
    fail('V101_CANDIDATE_DIGEST_MISMATCH');
  const scratch=mkdtempSync(path.join(tmpdir(),'rc-v101-versioned-interop-'));
  try{
    for(const [relative,bytes] of snapshot.files){
      const target=path.join(scratch,relative);
      mkdirSync(path.dirname(target),{recursive:true});
      writeFileSync(target,bytes,{flag:'wx',mode:0o600});
    }
    if(candidateSource(scratch).digest!==digest||
      candidateSource(root).digest!==digest)fail('V101_CANDIDATE_CHANGED_DURING_STAGE');
    const result=spawnSync(process.execPath,['--test',TEST],{
      cwd:path.dirname(TEST),encoding:'utf8',windowsHide:true,
      timeout:30000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe'],
      env:safeEnv({RC_V2_CANDIDATE_ROOT:scratch})
    });
    if(result.stdout)process.stdout.write(result.stdout);
    if(result.stderr)process.stderr.write(result.stderr);
    if(result.error||result.signal||result.status!==0)fail('V101_CANDIDATE_INTEROP_TEST_FAILED');
    process.stdout.write('V101_VERSIONED_SOURCE_INTEROP_PASS version='+snapshot.version+
      ' sha256='+digest+' productionG1Accepted=false\n');
    return true;
  }finally{rmSync(scratch,{recursive:true,force:true});}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2);
    if(args.some(x=>x.startsWith('--candidate-root=')))runVersionedCandidateInterop(parseCandidateArgs(args));
    else runPinnedInterop(parseArgs(args));
  }catch(error){process.stderr.write(String(error.code??error.message)+'\n');process.exitCode=1;}
}
