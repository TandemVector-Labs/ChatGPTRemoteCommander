#!/usr/bin/env node
// Compare two separately prepared native installer Core inventories.
// This is source-byte parity, not a claim about tool execution or GUI behavior.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const SHA40=/^[0-9a-f]{40}$/;
const SHA64=/^[0-9a-f]{64}$/;
const fail=msg=>{throw Error(msg)};
const check=(condition,msg)=>{if(!condition)fail(msg)};
const args=process.argv.slice(2);
const params=new Map();
try {
  for(let i=0;i<args.length;i+=2){
    check(i+1<args.length && ['--windows','--linux','--expected-commit'].includes(args[i]),'PARITY_BAD_ARGUMENT');
    check(!params.has(args[i]),'PARITY_DUPLICATE_ARGUMENT');
    params.set(args[i],args[i+1]);
  }
  check(params.size===3,'PARITY_REQUIRED_ARGUMENTS');
  const expected=params.get('--expected-commit');
  check(SHA40.test(expected),'PARITY_EXPECTED_COMMIT_INVALID');

  function load(platform){
    const name=params.get('--'+platform);
    check(typeof name==='string'&&path.isAbsolute(name),'PARITY_MANIFEST_ABSOLUTE_REQUIRED');
    const file=path.resolve(name),info=fs.lstatSync(file);
    check(info.isFile()&&!info.isSymbolicLink()&&info.size>0&&info.size<=1024*1024,
      'PARITY_MANIFEST_FILE_UNTRUSTED');
    const source=fs.readFileSync(file,'utf8');
    const keys=[];
    // JSON.parse's last-value-wins can hide ambiguous duplicate properties.
    const data=JSON.parse(source);
    check(data && data.schema===2 && data.head===expected && SHA40.test(data.head) &&
      SHA40.test(data.tree) && Number.isSafeInteger(data.count) &&
      data.count>=100 && data.count<=10000 &&
      data.files && typeof data.files==='object' && !Array.isArray(data.files),
      'PARITY_MANIFEST_SCHEMA_INVALID');
    const files=Object.entries(data.files);
    check(files.length===data.count,'PARITY_COUNT_MISMATCH');
    const seen=new Set();
    for(const [file,sha] of files){
      check(typeof file==='string'&&file.length<=260 &&
        !file.includes('\\')&&!file.startsWith('/') &&
        file.split('/').every(bit=>bit&&bit!=='.'&&bit!=='..'&&
          /^[A-Za-z0-9._+@-]+$/.test(bit)) &&
        SHA64.test(sha),'PARITY_INVALID_SOURCE_FILE');
      check(!seen.has(file.toLowerCase()),'PARITY_PATH_COLLISION');
      seen.add(file.toLowerCase());keys.push(file);
    }
    for(const p of ['package.json','config.json','src/server-v0.3.mjs',
       'src/browser-tools.mjs','src/workflow-tools.mjs','src/transfer-tools.mjs']){
      check(Object.hasOwn(data.files,p),'PARITY_REQUIRED_FILE_ABSENT');
    }
    const canonical=files.sort(([a],[b])=>a<b?-1:a>b?1:0)
      .map(([p,sha])=>p+'\0'+sha+'\n').join('');
    return {head:data.head,tree:data.tree,count:data.count,
      digest:crypto.createHash('sha256').update(canonical).digest('hex'),
      files:data.files};
  }
  const w=load('windows'),l=load('linux');
  check(w.tree===l.tree,'PARITY_TREE_DIFFERENT');
  check(w.count===l.count,'PARITY_FILE_COUNT_DIFFERENT');
  check(w.digest===l.digest,'PARITY_SOURCE_BYTES_DIFFERENT');
  for(const name of Object.keys(w.files))
    check(l.files[name]===w.files[name],'PARITY_INDIVIDUAL_FILE_DIFFERENT');
  console.log(JSON.stringify({
    status:'NATIVE_INSTALLER_COMMON_CORE_PARITY_PASS',commit:expected,
    tree:w.tree,files:w.count,canonicalSha256:w.digest,
    nativeUiOrFeatureParityVerified:false,realDeploymentVerified:false,
    privilegedOwnerGrantVerified:false
  }));
}catch(e){
  console.error(JSON.stringify({status:'NATIVE_INSTALLER_COMMON_CORE_PARITY_FAILED',
    reason:String(e.message||e)}));
  process.exitCode=2;
}
