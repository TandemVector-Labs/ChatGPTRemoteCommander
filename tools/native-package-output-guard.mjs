import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

function fail(code){throw Object.assign(new Error(code),{code});}

export function resolveNativePackageOutput(root,requested,{mustBeAbsent=true}={}){
  let realRoot;
  try{realRoot=fs.realpathSync(root);}catch{fail('NATIVE_PACKAGE_ROOT_INVALID');}
  const expected=path.join(realRoot,'dist','installer','Remote-Commander-Linux-amd64.deb');
  const output=path.resolve(realRoot,requested??path.relative(realRoot,expected));
  if(output!==expected)fail('NATIVE_PACKAGE_OUTPUT_OUTSIDE_ROOT');
  let current=realRoot;
  for(const part of ['dist','installer']){
    current=path.join(current,part);
    try{
      const stat=fs.lstatSync(current);
      if(stat.isSymbolicLink()||!stat.isDirectory()||fs.realpathSync(current)!==current)
        fail('NATIVE_PACKAGE_OUTPUT_PARENT_UNSAFE');
    }catch(error){
      if(error?.code==='ENOENT')break;
      if(error?.code==='NATIVE_PACKAGE_OUTPUT_PARENT_UNSAFE')throw error;
      fail('NATIVE_PACKAGE_OUTPUT_PARENT_UNSAFE');
    }
  }
  try{
    const stat=fs.lstatSync(output);
    if(stat.isSymbolicLink()||!stat.isFile())fail('NATIVE_PACKAGE_OUTPUT_TARGET_UNSAFE');
    if(mustBeAbsent)fail('NATIVE_PACKAGE_OUTPUT_ALREADY_EXISTS');
  }catch(error){
    if(error?.code==='ENOENT')return output;
    if(error?.code?.startsWith?.('NATIVE_PACKAGE_'))throw error;
    fail('NATIVE_PACKAGE_OUTPUT_TARGET_UNSAFE');
  }
  return output;
}

export function verifyNativePackageOutput(root,requested,expectedSha256){
  const output=resolveNativePackageOutput(root,requested,{mustBeAbsent:false});
  if(typeof expectedSha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedSha256))
    fail('NATIVE_PACKAGE_EXPECTED_SHA256_INVALID');
  let stat;
  try{stat=fs.lstatSync(output);}catch{fail('NATIVE_PACKAGE_OUTPUT_MISSING');}
  if(stat.isSymbolicLink()||!stat.isFile()||stat.size===0)
    fail('NATIVE_PACKAGE_OUTPUT_TARGET_UNSAFE');
  const actual=createHash('sha256').update(fs.readFileSync(output)).digest('hex');
  if(actual!==expectedSha256)fail('NATIVE_PACKAGE_OUTPUT_SHA256_MISMATCH');
  return actual;
}

if(import.meta.url===pathToFileURL(path.resolve(process.argv[1]??'')).href){
  const [mode,root,requested,expected]=process.argv.slice(2);
  if(!['absent','verify'].includes(mode)||!root||!requested)
    fail('NATIVE_PACKAGE_OUTPUT_GUARD_ARGUMENTS');
  if(mode==='absent')console.log(resolveNativePackageOutput(root,requested));
  else console.log(verifyNativePackageOutput(root,requested,expected));
}
