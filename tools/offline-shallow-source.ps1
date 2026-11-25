# Source-only offline transport. Retain the exact Commit SHA without bundling
# Git parents/history; no service, registry, profile or installer effects.
[CmdletBinding()]
param(
  [ValidateSet('Create','Verify','Import','VerifyRepo','Preflight')][string]$Mode,
  [string]$SourceRoot = '',
  [string]$SourceRef = '',
  [string]$ExpectedCommit = '',
  [string]$Archive = '',
  [string]$ArchiveSha256 = '',
  [string]$StoreRoot = '',
  [string]$RepoRoot = ''
)
$ErrorActionPreference='Stop'
$upstream='https://github.com/GOD13emad/ChatGPTRemoteCommander.git'
if($ExpectedCommit -notmatch '^[0-9a-fA-F]{40}$'){throw 'SHALLOW_SOURCE_BAD_COMMIT'}
$ExpectedCommit=$ExpectedCommit.ToLowerInvariant()
if($SourceRef -notmatch '^[A-Za-z0-9._/-]{1,128}$' -or $SourceRef -match '(^|/)\.\.?(/|$)'){
  throw 'SHALLOW_SOURCE_BAD_REF'
}
if($Mode -ne 'VerifyRepo' -and (-not [IO.Path]::IsPathFullyQualified($Archive) -or [IO.Path]::GetExtension($Archive) -ne '.zip')){
  throw 'SHALLOW_SOURCE_BAD_ARCHIVE_PATH'
}
if($Mode -ne 'VerifyRepo'){$Archive=[IO.Path]::GetFullPath($Archive)}
function Git([string[]]$Argv){
  $r=@(& git.exe @Argv 2>&1)
  if($LASTEXITCODE -ne 0){throw ('SHALLOW_SOURCE_GIT_FAILED '+($Argv -join ' '))}
  return @($r)
}
function Verify-Bare([string]$Root){
  $rootItem=Get-Item -LiteralPath $Root -Force -ErrorAction Stop
  if(-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
    throw 'SHALLOW_SOURCE_REPARSE_REJECTED'
  }
  $head=[string](Git @("--git-dir=$Root",'rev-parse','HEAD') | Select-Object -Last 1)
  if($head.Trim().ToLowerInvariant() -cne $ExpectedCommit){throw 'SHALLOW_SOURCE_HEAD_MISMATCH'}
  $bare=[string](Git @("--git-dir=$Root",'rev-parse','--is-bare-repository') | Select-Object -Last 1)
  $shallow=[string](Git @("--git-dir=$Root",'rev-parse','--is-shallow-repository') | Select-Object -Last 1)
  if($bare.Trim() -ne 'true' -or $shallow.Trim() -ne 'true'){throw 'SHALLOW_SOURCE_REPOSITORY_KIND_WRONG'}
  $branch=[string](Git @("--git-dir=$Root",'symbolic-ref','HEAD') | Select-Object -Last 1)
  if($branch.Trim() -cne ('refs/heads/'+$SourceRef)){throw 'SHALLOW_SOURCE_BRANCH_MISMATCH'}
  $count=[string](Git @("--git-dir=$Root",'rev-list','--count','--all') | Select-Object -Last 1)
  if($count.Trim() -ne '1'){throw 'SHALLOW_SOURCE_HISTORY_INCLUDED'}
  $boundary=Join-Path $Root 'shallow'
  if(-not(Test-Path -LiteralPath $boundary -PathType Leaf) -or
     (Get-Content -LiteralPath $boundary -Raw).Trim().ToLowerInvariant() -cne $ExpectedCommit){
    throw 'SHALLOW_SOURCE_BOUNDARY_MISMATCH'
  }
  if(Test-Path -LiteralPath (Join-Path $Root 'objects/info/alternates')){
    throw 'SHALLOW_SOURCE_ALTERNATE_OBJECT_STORE_DENIED'
  }
  [void](Git @("--git-dir=$Root",'fsck','--strict','--no-reflogs','--no-progress'))
  $objects=@(Git @("--git-dir=$Root",'rev-list','--objects','--all'))
  $known=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach($line in $objects){
    $oid=([string]$line).Split(' ',2)[0]
    [void]$known.Add($oid)
    if($line -match '(?i) (?:extensions/coucou-bridge|packages/engineering-solver-readiness|private-extensions)(?:/|$)'){
      throw 'SHALLOW_SOURCE_PRIVATE_HISTORY_PATH'
    }
  }
  $all=@(Git @("--git-dir=$Root",'cat-file','--batch-all-objects','--batch-check=%(objectname)'))
  foreach($oid in $all){if(-not $known.Contains(([string]$oid).Trim())){throw 'SHALLOW_SOURCE_UNREACHABLE_OBJECT'}}
  $remote=[string](Git @("--git-dir=$Root",'config','--get','remote.origin.url') | Select-Object -Last 1)
  if($remote.Trim() -cne $upstream){throw 'SHALLOW_SOURCE_ORIGIN_NOT_PUBLIC'}
  return [ordered]@{head=$ExpectedCommit;sourceRef=$SourceRef;objects=$known.Count;shallow=$true}
}
function Check-Archive([string]$File){
  $item=Get-Item -LiteralPath $File -Force -ErrorAction Stop
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
    throw 'SHALLOW_SOURCE_ARCHIVE_UNTRUSTED'
  }
  if($item.Length -lt 100 -or $item.Length -gt 134217728){throw 'SHALLOW_SOURCE_ARCHIVE_SIZE'}
  if($ArchiveSha256){
    if($ArchiveSha256 -notmatch '^[0-9a-fA-F]{64}$'){throw 'SHALLOW_SOURCE_BAD_SHA256'}
    $h=(Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
    if($h -cne $ArchiveSha256.ToLowerInvariant()){throw 'SHALLOW_SOURCE_ARCHIVE_SHA256_MISMATCH'}
  }
  $zip=[IO.Compression.ZipFile]::OpenRead($File)
  try{
    if($zip.Entries.Count -lt 5 -or $zip.Entries.Count -gt 6000){throw 'SHALLOW_SOURCE_ARCHIVE_ENTRIES'}
    [long]$logical=0
    $paths=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($entry in $zip.Entries){
      $n=$entry.FullName
      if($n.Contains('\') -or $n.StartsWith('/') -or $n -match '^[A-Za-z]:' -or
         [string]::IsNullOrWhiteSpace($n)){throw 'SHALLOW_SOURCE_ZIP_UNSAFE_PATH'}
      $components=@($n.TrimEnd('/').Split('/'))
      if($components | Where-Object {$_ -in @('','.', '..')}){throw 'SHALLOW_SOURCE_ZIP_UNSAFE_PATH'}
      if(-not $paths.Add($n.TrimEnd('/'))){throw 'SHALLOW_SOURCE_ZIP_DUPLICATE_PATH'}
      $top=$components[0]
      if($top -notin @('HEAD','config','description','shallow','packed-refs','objects','refs','hooks','info','branches','logs')){
        throw 'SHALLOW_SOURCE_ZIP_UNEXPECTED_ENTRY'
      }
      $type=($entry.ExternalAttributes -shr 16) -band 0xF000
      if($type -eq 0xA000){throw 'SHALLOW_SOURCE_ZIP_SYMLINK'}
      $logical+=$entry.Length
      if($logical -gt 134217728){throw 'SHALLOW_SOURCE_ZIP_UNCOMPRESSED_LIMIT'}
    }
    if(-not $paths.Contains('shallow') -or -not $paths.Contains('HEAD')){
      throw 'SHALLOW_SOURCE_ZIP_REQUIRED_MISSING'
    }
  }finally{$zip.Dispose()}
}
function Report([string]$Status,[string]$Repo=''){
  ([ordered]@{status=$Status;head=$ExpectedCommit;sourceRef=$SourceRef;
   archive=$Archive;repoRoot=$Repo;sha256=(Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()} |
   ConvertTo-Json -Compress -Depth 4)
}
if($Mode -eq 'Preflight'){
  if($ArchiveSha256 -notmatch '^[0-9a-fA-F]{64}$'){throw 'SHALLOW_SOURCE_SHA_REQUIRED'}
  Check-Archive $Archive
  Report 'SHALLOW_SOURCE_ARCHIVE_PREFLIGHT_PASS'
}elseif($Mode -eq 'VerifyRepo'){
  if(-not [IO.Path]::IsPathFullyQualified($RepoRoot)){throw 'SHALLOW_SOURCE_REPO_ROOT_REQUIRED'}
  [void](Verify-Bare $RepoRoot)
  ([ordered]@{status='SHALLOW_SOURCE_REPOSITORY_VERIFIED';head=$ExpectedCommit;sourceRef=$SourceRef;repoRoot=[IO.Path]::GetFullPath($RepoRoot)} | ConvertTo-Json -Compress)
}elseif($Mode -eq 'Create'){
  if(-not $SourceRoot -or -not [IO.Path]::IsPathFullyQualified($SourceRoot) -or
      -not(Test-Path -LiteralPath (Join-Path $SourceRoot '.git'))){throw 'SHALLOW_SOURCE_BUILD_ROOT_INVALID'}
  $head=[string](Git @('-C',$SourceRoot,'rev-parse','HEAD') | Select-Object -Last 1)
  if($head.Trim().ToLowerInvariant() -cne $ExpectedCommit){throw 'SHALLOW_SOURCE_BUILD_HEAD_DRIFT'}
  if(Test-Path -LiteralPath $Archive){throw 'SHALLOW_SOURCE_ARCHIVE_PREEXISTS'}
  $parent=Split-Path -Parent $Archive
  if(-not(Test-Path -LiteralPath $parent -PathType Container)){throw 'SHALLOW_SOURCE_BUILD_PARENT_MISSING'}
  $temporary=Join-Path $parent ('source-shallow-'+[guid]::NewGuid().ToString('N')+'.git')
  $staged=$Archive+'.stage-'+[guid]::NewGuid().ToString('N')
  try{
    $localUri=([uri]::new([IO.Path]::GetFullPath($SourceRoot))).AbsoluteUri
    [void](Git @('clone','-q','--bare','--depth','1','--single-branch','--no-tags','--branch',$SourceRef,
      $localUri,$temporary))
    [void](Git @("--git-dir=$temporary",'remote','set-url','origin',$upstream))
    [void](Verify-Bare $temporary)
    [IO.Compression.ZipFile]::CreateFromDirectory($temporary,$staged,[IO.Compression.CompressionLevel]::Optimal,$false)
    Check-Archive $staged
    [IO.File]::Move($staged,$Archive)
    Report 'SHALLOW_SOURCE_SNAPSHOT_CREATED'
  }finally{
    if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Recurse -Force}
    if(Test-Path -LiteralPath $staged){Remove-Item -LiteralPath $staged -Force}
  }
}elseif($Mode -eq 'Verify'){
  Check-Archive $Archive
  $temporary=Join-Path ([IO.Path]::GetTempPath()) ('rc-offline-source-verify-'+[guid]::NewGuid().ToString('N'))
  try{
    [IO.Compression.ZipFile]::ExtractToDirectory($Archive,$temporary)
    [void](Verify-Bare $temporary)
    Report 'SHALLOW_SOURCE_SNAPSHOT_VERIFIED'
  }finally{if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Recurse -Force}}
}elseif($Mode -eq 'Import'){
  if($ArchiveSha256 -notmatch '^[0-9a-fA-F]{64}$'){throw 'SHALLOW_SOURCE_SHA_REQUIRED'}
  Check-Archive $Archive
  if(-not $StoreRoot -or -not [IO.Path]::IsPathFullyQualified($StoreRoot)){throw 'SHALLOW_SOURCE_STORE_PATH_INVALID'}
  $store=[IO.Path]::GetFullPath($StoreRoot)
  if(-not(Test-Path -LiteralPath $store)){New-Item -ItemType Directory -Path $store -Force | Out-Null}
  $item=Get-Item -LiteralPath $store -Force
  if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
    throw 'SHALLOW_SOURCE_STORE_UNTRUSTED'
  }
  $target=Join-Path $store ('source-'+$ExpectedCommit+'.git')
  if(Test-Path -LiteralPath $target){
    [void](Verify-Bare $target)
    Report 'SHALLOW_SOURCE_ALREADY_IMPORTED' $target
  }else{
    $incoming=Join-Path $store ('.incoming-'+[guid]::NewGuid().ToString('N')+'.git')
    try{
      [IO.Compression.ZipFile]::ExtractToDirectory($Archive,$incoming)
      [void](Verify-Bare $incoming)
      [IO.Directory]::Move($incoming,$target)
      [void](Verify-Bare $target)
      Report 'SHALLOW_SOURCE_IMPORTED' $target
    }finally{if(Test-Path -LiteralPath $incoming){Remove-Item -LiteralPath $incoming -Recurse -Force}}
  }
}
