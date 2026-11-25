// V1-01 offline private-installed denial assessor. Does NOT grant release authority.
// A behavior-matrix harness may exit 0 when unsafe behavior matches old expectations;
// only the strict DENY result below qualifies the *negative* admission check.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const sha=/^[a-f0-9]{64}$/;
// Version 2 demands the same denial proof in ALL supported installed modes.
const CASES=['standard','full'].flatMap(mode=>[
  {key:mode+':absent',mode,flag:'absent'},
  {key:mode+':false',mode,flag:false},
  {key:mode+':true',mode,flag:true},
  {key:mode+':null',mode,flag:null},
  {key:mode+':string-false',mode,flag:'false'}
]);
function object(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function keyOf(item) {
  if(!object(item))return null;
  if(!['standard','full'].includes(item.mode))return null;
  if(item.flag==='absent')return item.mode+':absent';
  if(item.flag===false)return item.mode+':false';
  if(item.flag===true)return item.mode+':true';
  if(item.flag===null)return item.mode+':null';
  if(item.flag==='false')return item.mode+':string-false';
  return null;
}
export function assessInstalledDenial(receipt,expectedInstallerSha256){
  const base={gate:'V101_INSTALLED_NEGATIVE_ADMISSION',status:'BLOCKED',
    code:null,denialCasesProved:0,requiredCases:CASES.length,
    authenticatedCallerProved:false,nativeOwnerGrantProved:false,
    signedChatIdentityProved:false,rollbackProved:false,
    productionReleaseAuthorized:false};
  if(!sha.test(expectedInstallerSha256||'')||!object(receipt)
    ||receipt.matrixVersion!==2 || receipt.observationsOnly!==true
    ||receipt.installerSha256!==expectedInstallerSha256
    ||receipt.productionChanged!==false
    ||receipt.realOAuthProved!==false
    ||!Array.isArray(receipt.cases)
    ||receipt.cases.length!==CASES.length)
    return {...base,code:'RECEIPT_SCOPE_OR_IDENTITY_UNVERIFIED'};
  const found=new Map();
  for(const row of receipt.cases){
    const id=keyOf(row);
    if(!id||found.has(id))return {...base,code:'RECEIPT_CASES_INVALID_OR_DUPLICATED'};
    found.set(id,row);
  }
  for(const expected of CASES)if(!found.has(expected.key))
    return {...base,code:'REQUIRED_CASES_MISSING'};
  let denied=0,unexpectedAllow=0,malformed=0;
  const unsafeCases=[];
  for(const item of CASES){
    const row=found.get(item.key);
    if(!Array.isArray(row.invocations)||row.invocations.length!==2){
      malformed++;unsafeCases.push(item.key);continue;
    }
    const variants=new Map();
    for(const call of row.invocations){
      if(!object(call)||typeof call.variant!=='string'
        ||variants.has(call.variant)){malformed++;continue;}
      variants.set(call.variant,call);
    }
    if(variants.size!==2||!variants.has('anonymous')
      ||!variants.has('invalid-bearer-and-chat')){
      malformed++;unsafeCases.push(item.key);continue;
    }
    const ok=row.healthQuarantine===true
      &&[...variants.values()].every(call=>
        call.status===403&&call.match===false&&call.denied===true);
    if(ok){denied++;continue;}
    if([...variants.values()].some(call=>call.status===200
      ||call.match===true))unexpectedAllow++;
    unsafeCases.push(item.key);
  }
  const ready=denied===CASES.length&&malformed===0;
  return {...base,status:ready?'NEGATIVE_PREFLIGHT_PASS':'BLOCKED',
    code:ready?'ALL_INSTALLED_DENIAL_CASES_PROVED':
      unexpectedAllow?'UNAUTHENTICATED_RPC_ACCEPTED':
      malformed?'MALFORMED_OBSERVATIONS':'DENIAL_NOT_PROVED',
    denialCasesProved:denied,unsafeCases};
}
export function main(args=process.argv.slice(2)){
  if(!Array.isArray(args)||args.length!==2||!args[0].startsWith('--receipt=')
    ||!args[1].startsWith('--sha256='))throw Error('USAGE_RECEIPT_AND_SHA256_REQUIRED');
  const file=args[0].slice('--receipt='.length),expected=args[1].slice('--sha256='.length);
  if(!sha.test(expected))throw Error('INSTALLER_SHA256_INVALID');
  const stat=fs.statSync(file);
  if(!stat.isFile()||stat.size<32||stat.size>65536)throw Error('RECEIPT_SIZE_INVALID');
  const input=JSON.parse(fs.readFileSync(file,'utf8'));
  const result=assessInstalledDenial(input,expected);
  process.stdout.write(JSON.stringify(result)+'\n');
  if(result.status!=='NEGATIVE_PREFLIGHT_PASS')process.exitCode=3;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{main();}catch{
    process.stderr.write('RECEIPT_PREFLIGHT_FAILED\n');process.exitCode=2;
  }
}
