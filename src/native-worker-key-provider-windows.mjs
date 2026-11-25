// V1-07 Windows DPAPI CurrentUser Ed25519 key adapter.
// The host provisions the protected blob separately; this module never generates,
// persists, exports, enrolls, or logs a production private key.
import {
  createHash, createPrivateKey, createPublicKey, KeyObject
} from 'node:crypto';
import {execFile as execFileDefault} from 'node:child_process';
import fs from 'node:fs';
import {win32} from 'node:path';
import {WINDOWS_SYSTEM_ROOT,WINDOWS_SYSTEM_POWERSHELL_EXE} from './platform.mjs';

const PROFILE=/^[A-Za-z0-9_-]{1,64}$/;
const HASH=/^[a-f0-9]{64}$/;
const PREFIX=Buffer.from('302e020100300506032b657004220420','hex');
const fail=code=>{throw Object.assign(new Error(code),{code,nativeWorkerKeyCode:code});};

function localWindowsPath(value,code){
  if(typeof value!=='string'||value.length<4||value.length>2048
    ||value.includes('\0')||!win32.isAbsolute(value)
    ||! /^[A-Za-z]:\\/.test(value)||/(^|\\)\.\.(\\|$)/.test(value))
    fail(code);
  const normalized=win32.normalize(value);
  if(normalized!==value.replace(/[\\/]+$/,'')&&normalized+'\\'!==value)
    fail(code);
  return normalized;
}
function defaultPowerShellPath(){
  return WINDOWS_SYSTEM_POWERSHELL_EXE;
}
function assertTrustedPowerShell(file,verifyExecutable){
  try{verifyExecutable(file);}
  catch{fail('NATIVE_WORKER_KEY_POWERSHELL_UNTRUSTED');}
}
function defaultVerifyExecutable(file){
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink())fail('NATIVE_WORKER_KEY_POWERSHELL_UNTRUSTED');
}
function encodedPowerShell(script){
  return Buffer.from(script,'utf16le').toString('base64');
}
function powerShellEnvironment(){
  const root=WINDOWS_SYSTEM_ROOT;
  const modulePath=win32.join(root,'System32','WindowsPowerShell','v1.0','Modules');
  const env={
    SystemRoot:root,WINDIR:root,
    PATH:[win32.join(root,'System32'),root,
      win32.join(root,'System32','WindowsPowerShell','v1.0')].join(';'),
    PSModulePath:modulePath
  };
  for(const key of ['TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','HOMEDRIVE','HOMEPATH']){
    const value=process.env[key];
    if(typeof value==='string'&&value.length>0&&!/[\\u0000-\\u001f]/.test(value))env[key]=value;
  }
  return env;
}
function executePowerShell({execFileImpl,powershellPath,script,encoding,maxBuffer,timeoutMs}){
  return new Promise((resolve,reject)=>{
    try{
      execFileImpl(powershellPath,[
        '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encodedPowerShell(script)
      ],{
        encoding,windowsHide:true,timeout:timeoutMs,maxBuffer,env:powerShellEnvironment()
      },(error,stdout)=>{
        if(error){reject(Object.assign(new Error('NATIVE_WORKER_KEY_POWERSHELL_FAILED'),{
          code:'NATIVE_WORKER_KEY_POWERSHELL_FAILED'
        }));return;}
        resolve(stdout);
      });
    }catch{
      reject(Object.assign(new Error('NATIVE_WORKER_KEY_POWERSHELL_FAILED'),{
        code:'NATIVE_WORKER_KEY_POWERSHELL_FAILED'
      }));
    }
  });
}

/** Resolve only the current Windows process owner's SID hash; this is not GUI consent. */
export function createWindowsNativeOwnerSidHashResolver({
  platform=process.platform,execFileImpl=execFileDefault,
  powershellPath=defaultPowerShellPath(),verifyExecutable=defaultVerifyExecutable
}={}){
  if(platform!=='win32'||typeof execFileImpl!=='function'
    ||typeof verifyExecutable!=='function')
    fail('NATIVE_WORKER_KEY_WINDOWS_BOOTSTRAP_REQUIRED');
  const executable=localWindowsPath(powershellPath,'NATIVE_WORKER_KEY_POWERSHELL_PATH_INVALID');
  assertTrustedPowerShell(executable,verifyExecutable);
  const script=[
    "$ErrorActionPreference='Stop'",
    "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$sha=[Security.Cryptography.SHA256]::Create()",
    "try{$bytes=[Text.Encoding]::UTF8.GetBytes($sid);$digest=$sha.ComputeHash($bytes);$hash=[BitConverter]::ToString($digest).Replace('-','').ToLowerInvariant();[Console]::Out.Write($hash)}",
    "finally{if($bytes){[Array]::Clear($bytes,0,$bytes.Length)};if($digest){[Array]::Clear($digest,0,$digest.Length)};$sha.Dispose()}"
  ].join('\n');
  return async()=>{
    let output;
    try{
      output=await executePowerShell({
        execFileImpl,powershellPath:executable,script,encoding:null,
        maxBuffer:4096,timeoutMs:5000
      });
    }catch{fail('NATIVE_WORKER_KEY_OWNER_UNAVAILABLE');}
    const candidates=Buffer.isBuffer(output)
      ?[output.toString('utf8'),output.toString('utf16le')]
      :typeof output==='string'?[output]:[];
    const hash=candidates.map(value=>value.replace(/^\uFEFF/,'').trim())
      .find(value=>HASH.test(value))??'';
    if(!HASH.test(hash))fail('NATIVE_WORKER_KEY_OWNER_UNAVAILABLE');
    return hash;
  };
}

/**
 * Create a DPAPI CurrentUser loader for one fixed profile-specific blob.
 * The blob must have been provisioned under a protected directory/file ACL and
 * encrypted with entropy: commander.worker.identity.v1|<profileId>|<ownerSidHash>.
 * It is decrypted only by the same Windows user on the same machine.
 */
export function createWindowsDpapiSeedLoader({
  platform=process.platform,credentialPath,profileId,
  execFileImpl=execFileDefault,powershellPath=defaultPowerShellPath(),
  verifyExecutable=defaultVerifyExecutable
}={}){
  if(platform!=='win32'||typeof execFileImpl!=='function'
    ||typeof verifyExecutable!=='function'||!PROFILE.test(profileId??''))
    fail('NATIVE_WORKER_KEY_WINDOWS_BOOTSTRAP_REQUIRED');
  const file=localWindowsPath(credentialPath,'NATIVE_WORKER_KEY_CREDENTIAL_PATH_INVALID');
  const executable=localWindowsPath(powershellPath,'NATIVE_WORKER_KEY_POWERSHELL_PATH_INVALID');
  assertTrustedPowerShell(executable,verifyExecutable);
  const pathB64=Buffer.from(file,'utf8').toString('base64');
  const profileB64=Buffer.from(profileId,'utf8').toString('base64');
  return async({ownerSidHash}={})=>{
    if(!HASH.test(ownerSidHash??''))fail('NATIVE_WORKER_KEY_OWNER_UNAVAILABLE');
    const script=[
      "$ErrorActionPreference='Stop'",
      "$ProgressPreference='SilentlyContinue'",
      "Add-Type -AssemblyName System.Security -ErrorAction Stop | Out-Null",
      "Import-Module Microsoft.PowerShell.Security -ErrorAction Stop | Out-Null",
      "$path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+pathB64+"'))",
      "$profile=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+profileB64+"'))",
      "$expectedOwner='"+ownerSidHash+"'",
      "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      "$sha=[Security.Cryptography.SHA256]::Create()",
      "try{$sidBytes=[Text.Encoding]::UTF8.GetBytes($sid);$sidDigest=$sha.ComputeHash($sidBytes);$actualOwner=[BitConverter]::ToString($sidDigest).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}",
      "if($actualOwner -cne $expectedOwner){throw 'OWNER_MISMATCH'}",
      "function Assert-PrivateAcl([string]$Target,[string]$OwnerSid,[bool]$Directory){",
      "  $item=Get-Item -LiteralPath $Target -Force",
      "  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'REPARSE_POINT'}",
      "  if([bool]$item.PSIsContainer -ne $Directory){throw 'PATH_TYPE'}",
      "  $acl=Get-Acl -LiteralPath $Target",
      "  if(!$acl.AreAccessRulesProtected){throw 'INHERITED_ACL'}",
      "  if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $OwnerSid){throw 'OWNER_ACL'}",
      "  $allowed=@($OwnerSid,'S-1-5-18','S-1-5-32-544')",
      "  foreach($rule in $acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier])){",
      "    if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $allowed -notcontains $rule.IdentityReference.Value){throw 'BROAD_ACL'}",
      "  }",
      "  return $item",
      "}",
      "$parent=[IO.Path]::GetDirectoryName($path)",
      "$cursor=[IO.DirectoryInfo]::new($parent)",
      "while($null -ne $cursor){$ancestor=Get-Item -LiteralPath $cursor.FullName -Force;if(($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'ANCESTOR_REPARSE'};$cursor=$cursor.Parent}",
      "$null=Assert-PrivateAcl $parent $sid $true",
      "$item=Assert-PrivateAcl $path $sid $false",
      "if($item.Length -lt 128 -or $item.Length -gt 4096){throw 'BLOB_SIZE'}",
      "$cipher=[IO.File]::ReadAllBytes($path)",
      "$entropy=[Text.Encoding]::UTF8.GetBytes('commander.worker.identity.v1|'+$profile+'|'+$expectedOwner)",
      "$plain=$null",
      "try{$plain=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser);if($plain.Length -ne 32){throw 'SEED_SIZE'};[Console]::OpenStandardOutput().Write($plain,0,$plain.Length)}",
      "finally{if($cipher){[Array]::Clear($cipher,0,$cipher.Length)};if($entropy){[Array]::Clear($entropy,0,$entropy.Length)};if($plain){[Array]::Clear($plain,0,$plain.Length)};if($sidBytes){[Array]::Clear($sidBytes,0,$sidBytes.Length)};if($sidDigest){[Array]::Clear($sidDigest,0,$sidDigest.Length)}}"
    ].join('\n');
    let output;
    try{
      output=await executePowerShell({
        execFileImpl,powershellPath:executable,script,encoding:null,
        maxBuffer:4096,timeoutMs:8000
      });
    }catch{fail('NATIVE_WORKER_KEY_CREDENTIAL_UNAVAILABLE');}
    if(!Buffer.isBuffer(output)||output.length!==32){
      output?.fill?.(0);
      fail('NATIVE_WORKER_KEY_CREDENTIAL_INVALID');
    }
    return output;
  };
}

/** Ed25519 KeyObject provider; owner changes and fingerprint drift fail closed. */
export function createWindowsDpapiWorkerKeyProvider({
  platform=process.platform,profileId,expectedKeyId,credentialPath,
  resolveOwnerSidHash,readProtectedSeed,execFileImpl=execFileDefault,
  powershellPath=defaultPowerShellPath(),verifyExecutable=defaultVerifyExecutable
}={}){
  if(platform!=='win32'||!PROFILE.test(profileId??'')||!HASH.test(expectedKeyId??'')
    ||typeof resolveOwnerSidHash!=='function'
    ||(typeof readProtectedSeed!=='function'&&typeof credentialPath!=='string'))
    fail('NATIVE_WORKER_KEY_PROVIDER_CONFIGURATION_REQUIRED');
  const loadSeed=readProtectedSeed??createWindowsDpapiSeedLoader({
    platform,credentialPath,profileId,execFileImpl,powershellPath,verifyExecutable
  });
  async function loadPrivateKey(){
    let supplied,seed,der,publicDer;
    try{
      const ownerBefore=await resolveOwnerSidHash();
      if(!HASH.test(ownerBefore??''))fail('NATIVE_WORKER_KEY_OWNER_UNAVAILABLE');
      supplied=await loadSeed({credentialPath,profileId,ownerSidHash:ownerBefore});
      if(!Buffer.isBuffer(supplied)||supplied.length!==32)
        fail('NATIVE_WORKER_KEY_CREDENTIAL_INVALID');
      seed=Buffer.from(supplied);
      der=Buffer.concat([PREFIX,seed]);
      const privateKey=createPrivateKey({key:der,format:'der',type:'pkcs8'});
      if(!(privateKey instanceof KeyObject)||privateKey.type!=='private'
        ||privateKey.asymmetricKeyType!=='ed25519')
        fail('NATIVE_WORKER_KEY_ED25519_REQUIRED');
      publicDer=createPublicKey(privateKey).export({type:'spki',format:'der'});
      const keyId=createHash('sha256').update(publicDer).digest('hex');
      if(keyId!==expectedKeyId)fail('NATIVE_WORKER_KEY_ID_MISMATCH');
      const ownerAfter=await resolveOwnerSidHash();
      if(ownerAfter!==ownerBefore)fail('NATIVE_WORKER_KEY_OWNER_CHANGED');
      return privateKey;
    }catch(error){
      if(error?.code?.startsWith?.('NATIVE_WORKER_KEY_'))throw error;
      fail('NATIVE_WORKER_KEY_MATERIAL_INVALID');
    }finally{
      supplied?.fill?.(0);
      seed?.fill?.(0);
      der?.fill?.(0);
      publicDer?.fill?.(0);
    }
  }
  return Object.freeze({
    source:'windows-dpapi-current-user',
    profileId,keyId:expectedKeyId,loadPrivateKey
  });
}
