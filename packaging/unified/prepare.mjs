import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const dir=path.dirname(fileURLToPath(import.meta.url));
const repo=path.resolve(dir,'../..');
const stage=path.join(dir,'.stage');
// One native installer family (NSIS/DEB), one cross-OS contract and one
// disposable source-transaction QA helper; never create a second live install.
const unifiedContract=JSON.parse(fs.readFileSync(
  path.join(repo,'installer/universal-install-contract.json'),'utf8'));
if(unifiedContract.schema!=='rc-unified-installer-v1' ||
   unifiedContract.product!=='ChatGPTRemoteCommander' ||
   unifiedContract.sourceTrain!=='0.12' ||
   unifiedContract.nativeCandidateRoot!=='packaging/unified' ||
   unifiedContract.qaTransactionHelper!=='tools/universal-install/engine.mjs' ||
   !Array.isArray(unifiedContract.requiredEmbeddedCoreFiles) ||
   unifiedContract.requiredEmbeddedCoreFiles.length<5 ||
   unifiedContract.presentation?.crossOsVisualParityAccepted!==false)
  throw Error('UNIFIED_CANDIDATE_CONTRACT_INVALID');
const core=path.join(stage,'core');
const runGit=(args)=>execFileSync('git',args,{
  cwd:repo,encoding:'utf8',env:{...process.env,GIT_NO_LAZY_FETCH:'1'},timeout:20000
}).trim();
const head=runGit(['rev-parse','HEAD']);
const tree=runGit(['rev-parse','HEAD^{tree}']);
if(!/^[0-9a-f]{40}$/.test(head)||!/^[0-9a-f]{40}$/.test(tree))
  throw Error('UNIFIED_GIT_SOURCE_INVALID');
const touched=runGit(['status','--porcelain=v1','--','src','tools','assets','vendor','extensions','config.json','package.json']);
if(touched)throw Error('UNIFIED_SOURCE_UNCOMMITTED: '+touched.slice(0,300));
const versionIdentityDirty=runGit(['status','--porcelain=v1','--',
  'docs/release-train-0.12.json','packaging/unified/package.json',
  'packaging/unified/package-lock.json',
  'installer/universal-install-contract.json']);
if(versionIdentityDirty)throw Error('UNIFIED_VERSION_IDENTITY_UNCOMMITTED');
if(fs.existsSync(core)){
  const marker=path.join(core,'source-manifest.json');
  if(!fs.existsSync(marker)||![1,2].includes(JSON.parse(fs.readFileSync(marker,'utf8')).schema))
    throw Error('UNIFIED_STAGE_UNKNOWN_CONTENT_REFUSED');
  fs.rmSync(core,{recursive:true,force:true});
}
fs.mkdirSync(core,{recursive:true});
const tar=path.join(stage,'committed-core.tar');
if(fs.existsSync(tar))throw Error('UNIFIED_ARCHIVE_PREEXISTS');
try{
  execFileSync('git',['-c','core.autocrlf=false','archive','--format=tar','--output',tar,head,
    'src','tools','vendor','assets','config.json','package.json'],{
      cwd:repo,timeout:30000,env:{...process.env,GIT_NO_LAZY_FETCH:'1'}
    });
  execFileSync('tar',['-xf',tar,'-C',core],{timeout:30000});
}finally{if(fs.existsSync(tar))fs.rmSync(tar);}
const entries=[];
function walk(root, rel=''){
  for(const e of fs.readdirSync(path.join(root,rel),{withFileTypes:true})){
    const current=rel?rel+'/'+e.name:e.name;
    if(e.isSymbolicLink())throw Error('UNIFIED_SOURCE_SYMLINK '+current);
    if(e.isDirectory())walk(root,current);
    else if(e.isFile())entries.push(current);
    else throw Error('UNIFIED_SOURCE_SPECIAL '+current);
  }
}
walk(core);
entries.sort();
const required=['src/server-v0.3.mjs','package.json','config.json'];
if(!required.every(p=>entries.includes(p)) ||
   !unifiedContract.requiredEmbeddedCoreFiles.every(p=>entries.includes(p)) ||
   new Set(unifiedContract.requiredEmbeddedCoreFiles).size!==unifiedContract.requiredEmbeddedCoreFiles.length ||
   entries.length<10)
  throw Error('UNIFIED_SOURCE_INCOMPLETE');
const hash=p=>createHash('sha256').update(fs.readFileSync(path.join(core,p))).digest('hex');
const manifest={schema:2,head,tree,count:entries.length,
  files:Object.fromEntries(entries.map(p=>[p,hash(p)])),
  packaging:'unified-pilot-no-promotion'};
fs.writeFileSync(path.join(core,'source-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
const pkg=JSON.parse(fs.readFileSync(path.join(core,'package.json'),'utf8'));
const guiPkg=JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));
const train=JSON.parse(fs.readFileSync(path.join(repo,'docs/release-train-0.12.json'),'utf8'));
if(!/^0\.12\.0-dev\.[1-9][0-9]*$/.test(pkg.version)
   ||pkg.version!==guiPkg.version||train.sourceVersion!==pkg.version
   ||train.train!=='0.12'||train.channel!=='development'
   ||train.status!=='INTEGRATION_CANDIDATE_NOT_FINAL'
   ||train.isStable!==false||train.publishApproved!==false
   ||train.autoupdateApproved!==false||train.installedPromotionApproved!==false
   ||train.releaseTag!==null)
  throw Error('UNIFIED_WRONG_CORE_OR_RELEASE_TRAIN_VERSION');
console.log('UNIFIED_SOURCE_PREPARED',JSON.stringify({head,tree,count:entries.length,version:pkg.version}));
