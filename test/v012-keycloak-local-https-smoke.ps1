# V0.12 owner-local, opt-in Keycloak QA: no public listener, users or credentials.
# Never use this self-signed certificate or local database for production OAuth.
$ErrorActionPreference='Stop'
$base=Join-Path $env:LOCALAPPDATA 'ChatGPTRemoteCommander\qa\identity-provider'
$kcRoot=Join-Path $base 'keycloak-26.8.2'
$bin=Join-Path $kcRoot 'bin\kc.bat'
$certDir=Join-Path $base '.rc012-temporary-realm-tls'
$cert=Join-Path $certDir 'qa-issuer.crt'
$key=Join-Path $certDir 'qa-issuer.key'
$metadataFile=Join-Path $certDir 'metadata.json'
$out=Join-Path $base 'qa-realm-https-stdout.log'
$err=Join-Path $base 'qa-realm-https-stderr.log'
$portBusy=(@(Get-NetTCPConnection -LocalPort 18443,19001 -State Listen -ErrorAction SilentlyContinue).Count -ne 0)
if(!(Test-Path -LiteralPath $bin) -or (Test-Path -LiteralPath $certDir) -or
    (Test-Path -LiteralPath $out) -or (Test-Path -LiteralPath $err) -or $portBusy){
 throw 'RC012_REALM_TLS_QA_PRECONDITION_REFUSED'
}
New-Item -ItemType Directory -Path $certDir|Out-Null
$qa=[ordered]@{
 state='QA_REALM_HTTPS_NOT_READY';httpsCode=0;issuerPinned=$false;
 scopeAdvertised=$false;pkceS256=$false;authCode=$false;
 tokenMethodSupported=$false;g1ProviderPreflight=$false;tlsVerified=$false;realUserAuth=$false;
 publicExposure=$false;adminCreated=$false
}
$proc=$null
try {
 & openssl.exe req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -config NUL -keyout $key -out $cert -subj '/CN=qa-issuer.example' -addext 'subjectAltName=DNS:qa-issuer.example' -addext 'basicConstraints=CA:FALSE' -addext 'extendedKeyUsage=serverAuth' 2>$null
 if($LASTEXITCODE -ne 0){throw 'RC012_QA_CERT_GENERATION_FAILED'}
 $arguments='/d /c ""'+$bin+'" start --optimized --http-enabled=false --http-host=127.0.0.1 --https-port=18443 --http-management-port=19001 --hostname=https://qa-issuer.example --https-certificate-file="'+$cert+'" --https-certificate-key-file="'+$key+'""'
 $proc=Start-Process -FilePath $env:ComSpec -ArgumentList $arguments -WindowStyle Hidden -PassThru -WorkingDirectory $kcRoot -RedirectStandardOutput $out -RedirectStandardError $err
 $timer=[Diagnostics.Stopwatch]::StartNew()
 while($timer.Elapsed.TotalSeconds -lt 23){
  Start-Sleep -Milliseconds 500
  $code=& curl.exe --silent --show-error --max-time 2 --noproxy '*' --connect-to 'qa-issuer.example:443:127.0.0.1:18443' --cacert $cert -o $metadataFile -w '%{http_code}' 'https://qa-issuer.example/realms/commander-v012/.well-known/openid-configuration' 2>$null
  if($LASTEXITCODE -eq 0 -and $code -eq '200'){
   $meta=Get-Content -LiteralPath $metadataFile -Raw|ConvertFrom-Json
   $qa.httpsCode=200
   $qa.issuerPinned=($meta.issuer -ceq 'https://qa-issuer.example/realms/commander-v012')
   $qa.scopeAdvertised=(@($meta.scopes_supported) -ccontains 'commander.workflow')
   $qa.pkceS256=(@($meta.code_challenge_methods_supported) -ccontains 'S256')
   $qa.authCode=(@($meta.response_types_supported) -ccontains 'code')
   $qa.tokenMethodSupported=(@($meta.token_endpoint_auth_methods_supported) -contains 'client_secret_basic')
   $acceptance=& node.exe '.\\test\\v012-keycloak-local-provider-acceptance.mjs' $metadataFile 2>&1
   if($LASTEXITCODE -eq 0){
     try {
       $v=($acceptance|Out-String)|ConvertFrom-Json -ErrorAction Stop
       $qa.g1ProviderPreflight=($v.pinnedIssuer -and $v.pinnedResource -and
         @($v.scopes) -contains 'commander.workflow' -and
         $v.g1AuthenticatedChat -eq $false)
     }catch {$qa.g1ProviderPreflight=$false}
   }
   $qa.tlsVerified=$true
   $listeners=@(Get-NetTCPConnection -LocalPort 18443,19001 -State Listen -ErrorAction SilentlyContinue)
   $qa.listenerOnlyLoopback=($listeners.Count -gt 0 -and
     @($listeners|Where-Object{$_.LocalAddress -notin @('127.0.0.1','::1')}).Count -eq 0)
   if($qa.issuerPinned -and $qa.scopeAdvertised -and $qa.pkceS256 -and
      $qa.authCode -and $qa.tokenMethodSupported -and $qa.g1ProviderPreflight -and $qa.listenerOnlyLoopback){
      $qa.state='QA_IMPORTED_REALM_OIDC_PASS'
   }else{$qa.state='QA_IMPORTED_REALM_OIDC_INCOMPLETE'}
   break
  }
 }
} finally {
 if($proc){& taskkill.exe /PID $proc.Id /T /F 1>$null 2>$null}
 Start-Sleep -Milliseconds 500
 $qa.listenersRemain=[bool](Get-NetTCPConnection -LocalPort 18443,19001 -State Listen -ErrorAction SilentlyContinue)
 if(Test-Path -LiteralPath $certDir){Remove-Item -LiteralPath $certDir -Recurse -Force}
 $qa.privateKeyRetained=(Test-Path -LiteralPath $key)
 $qa.cleanupAttempted=$true
}
[pscustomobject]$qa|ConvertTo-Json -Compress
if($qa.state -ne 'QA_IMPORTED_REALM_OIDC_PASS' -or $qa.listenersRemain -or $qa.privateKeyRetained){exit 2}
