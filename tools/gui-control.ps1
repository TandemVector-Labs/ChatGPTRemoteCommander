param([switch]$SelfTest,[switch]$Server)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$utf8NoBom = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
if (-not $IsWindows) { throw 'GUI_WINDOWS_ONLY' }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Path (Join-Path $PSScriptRoot 'gui-native.cs')
[RcGuiNative]::AssertLayout()
if ($SelfTest) {
    if ([RcGuiNative]::KeyCode('ENTER') -ne 13) { throw 'GUI_KEYMAP_FAILED' }
    $rejected = $false
    try { [RcGuiNative]::KeyCode('INVALID') | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'GUI_KEYMAP_FAILED' }
    @{ok=$true; inputSize=[RcGuiNative]::InputSize(); architecture=[Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString(); nativeLayoutOnly=$true} | ConvertTo-Json -Compress
    exit 0
}

function Convert-GuiErrorPayload($record) {
    $diagnostic = @(
        [string]$record,
        [string]$record.Exception,
        [string]$record.Exception.Message,
        [string]$record.FullyQualifiedErrorId,
        [string]$record.CategoryInfo.Reason
    ) -join ' '
    $match=[regex]::Match($diagnostic,'GUI_[A-Z0-9_]+')
    $payload = @{ok=$false;error=$(if($match.Success){$match.Value}else{'GUI_NATIVE_FAILED'})}
    if($env:RC_GUI_DIAGNOSTIC -eq '1') {
        $payload['errorType'] = $record.Exception.GetType().FullName
        $payload['fullyQualifiedErrorId'] = [string]$record.FullyQualifiedErrorId
        $payload['reason'] = [string]$record.CategoryInfo.Reason
    }
    return $payload
}

function Invoke-GuiRequest([hashtable]$req) {
$owned = $false
$mutex = $null
$oldDpi = [IntPtr]::Zero
try {
    $actions = @('status','screenshot','cursor','listWindows','move','moveRelative','scroll','click','drag','typeText','keyPress','focusWindow')
    if ($req['action'] -notin $actions) { throw 'GUI_UNKNOWN_ACTION' }
    $stop = Join-Path (Split-Path -Parent $PSScriptRoot) 'var\GUI_STOP'
    # Fixed local path: a request may not replace the local emergency-stop file.
    $mutex = [Threading.Mutex]::new($false, 'Local\ChatGPTRemoteCommander.GuiInput')
    try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned=$true; throw 'GUI_PREVIOUS_HELPER_ABANDONED' }
    if (-not $owned) { return @{ok=$false;error='GUI_NATIVE_BUSY';submission='NOT_SUBMITTED'} }
    $oldDpi = [RcGuiNative]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
    if ($oldDpi -eq [IntPtr]::Zero) { throw 'GUI_DPI_CONTEXT_FAILED' }
    $available = [RcGuiNative]::Available()
    if ($req['action'] -eq 'status') {
        $screens = @()
        if ($available) {
            $all=[Windows.Forms.Screen]::AllScreens
            for($i=0;$i -lt $all.Length;$i++) {
                $b=$all[$i].Bounds
                $screens+=@{index=$i;left=$b.Left;top=$b.Top;width=$b.Width;height=$b.Height;primary=$all[$i].Primary}
            }
        }
        return @{ok=$true;available=$available;session=[Diagnostics.Process]::GetCurrentProcess().SessionId;screens=$screens;inputSize=[RcGuiNative]::InputSize()}
    }
    [RcGuiNative]::Guard($stop)
    function Bounds([int]$index) {
        $screens=[Windows.Forms.Screen]::AllScreens
        if($index -lt 0 -or $index -ge $screens.Length) { throw 'GUI_MONITOR_RANGE' }
        return $screens[$index].Bounds
    }
    function Snapshot([int]$index) {
        $b=Bounds $index
        return @{screenIndex=$index;bounds=@{left=$b.Left;top=$b.Top;width=$b.Width;height=$b.Height};foreground=[RcGuiNative]::Foreground();processId=[int][RcGuiNative]::ForegroundPid()}
    }
    function Point($value,$observed) {
        $index=[int]($value['screenIndex'] ?? $observed['screenIndex'])
        if($index -ne $observed['screenIndex']) { throw 'GUI_MONITOR_NOT_OBSERVED' }
        $b=Bounds $index
        if(($value['coordinateMode'] ?? 'absolute') -eq 'relative') {
            $x=[double]$value['x']; $y=[double]$value['y']
            if($x -lt 0 -or $x -gt 1 -or $y -lt 0 -or $y -gt 1) { throw 'GUI_RELATIVE_RANGE' }
            $px=$b.Left+[int][Math]::Round($x*($b.Width-1)); $py=$b.Top+[int][Math]::Round($y*($b.Height-1))
        } else { $px=[int]$value['x']; $py=[int]$value['y'] }
        if(-not $b.Contains($px,$py)) { throw 'GUI_POINT_OUTSIDE_MONITOR' }
        return @{X=$px;Y=$py}
    }
    $mutation=$req['action'] -in @('move','moveRelative','scroll','click','drag','typeText','keyPress','focusWindow')
    if($mutation) {
        if(-not $req['expected']) { throw 'GUI_EXPECTED_FRAME_REQUIRED' }
        $observed=$req['expected']
        try {
            $observedScreenIndex = [int]$observed['screenIndex']
            $observedBounds = $observed['bounds']
            $observedForeground = [string]$observed['foreground']
            $observedProcessId = [uint32]$observed['processId']
            if($null -eq $observedBounds) { throw 'missing bounds' }
        } catch { throw 'GUI_EXPECTED_FRAME_INVALID' }

        $now=Snapshot $observedScreenIndex
        foreach($key in @('left','top','width','height')) {
            if($observedBounds[$key] -ne $now['bounds'][$key]) { throw 'GUI_MONITOR_GEOMETRY_CHANGED' }
        }
        try {
            [RcGuiNative]::CheckForeground($observedForeground,$observedProcessId)
        } catch {
            $foregroundDiagnostic = @([string]$_,[string]$_.Exception,[string]$_.Exception.Message) -join ' '
            $foregroundMatch = [regex]::Match($foregroundDiagnostic,'GUI_[A-Z0-9_]+')
            if($foregroundMatch.Success) { throw $foregroundMatch.Value }
            throw 'GUI_FOREGROUND_CHECK_FAILED'
        }
    }
    $result=switch($req['action']) {
        'screenshot' {
            $index=[int]($req['screenIndex'] ?? 0)
            $snapshot=Snapshot $index; $b=Bounds $index
            if(([long]$b.Width*$b.Height) -gt 33554432 -or $b.Width -le 0 -or $b.Height -le 0) { throw 'GUI_CAPTURE_GEOMETRY_LIMIT' }
            $maxWidth=[Math]::Min(1920,[Math]::Max(320,[int]($req['maxWidth'] ?? 1600)))
            $bitmap=$null; $graphics=$null; $scaled=$null; $sg=$null; $stream=$null; $parameters=$null
            try {
                $bitmap=[Drawing.Bitmap]::new($b.Width,$b.Height)
                $graphics=[Drawing.Graphics]::FromImage($bitmap)
                $graphics.CopyFromScreen($b.Left,$b.Top,0,0,$bitmap.Size)
                $width=[Math]::Min($b.Width,$maxWidth)
                $height=[Math]::Max(1,[int][Math]::Round($b.Height*$width/$b.Width))
                $scaled=[Drawing.Bitmap]::new($width,$height)
                $sg=[Drawing.Graphics]::FromImage($scaled)
                $sg.DrawImage($bitmap,0,0,$width,$height)
                $stream=[IO.MemoryStream]::new()
                if(($req['format'] ?? 'jpeg') -eq 'png') { $scaled.Save($stream,[Drawing.Imaging.ImageFormat]::Png);$mime='image/png' }
                else {
                    $codec=[Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg' | Select-Object -First 1
                    $parameters=[Drawing.Imaging.EncoderParameters]::new(1)
                    $parameters.Param[0]=[Drawing.Imaging.EncoderParameter]::new([Drawing.Imaging.Encoder]::Quality,[long][Math]::Min(90,[Math]::Max(25,[int]($req['quality'] ?? 70))))
                    $scaled.Save($stream,$codec,$parameters);$mime='image/jpeg'
                }
                $limit=[Math]::Min(4194304,[Math]::Max(262144,[int]($req['maxBytes'] ?? 2097152)))
                if($stream.Length -gt $limit) { throw 'GUI_IMAGE_BYTE_LIMIT' }
                [RcGuiNative]::CheckForeground([string]$snapshot.foreground,[uint32]$snapshot.processId)
                @{ok=$true;data=[Convert]::ToBase64String($stream.ToArray());mimeType=$mime;width=$width;height=$height;snapshot=$snapshot;capturedAt=[DateTimeOffset]::UtcNow.ToString('o')}
            } finally { foreach($resource in @($parameters,$stream,$sg,$scaled,$graphics,$bitmap)) { if($resource) {$resource.Dispose()} } }
        }
        'cursor' { $p=[RcGuiNative]::Cursor(); @{ok=$true;x=$p.X;y=$p.Y} }
        'listWindows' { @{ok=$true;windows=@([RcGuiNative]::ListWindows().ToArray())} }
        'move' { $p=Point $req $observed;[RcGuiNative]::Move($p.X,$p.Y,$stop);@{ok=$true} }
        'moveRelative' { [RcGuiNative]::Delta([int]$req['dx'],[int]$req['dy'],$stop);@{ok=$true} }
        'scroll' { [RcGuiNative]::Scroll([int]$req['delta'],[bool]($req['horizontal'] ?? $false),$stop);@{ok=$true} }
        'click' { $p=Point $req $observed;[RcGuiNative]::Move($p.X,$p.Y,$stop);[RcGuiNative]::Click([string]($req['button'] ?? 'left'),[int]($req['clicks'] ?? 1),[int]($req['intervalMs'] ?? 120),$stop);@{ok=$true} }
        'drag' { $a=Point $req['from'] $observed;$b=Point $req['to'] $observed;[RcGuiNative]::Drag($a.X,$a.Y,$b.X,$b.Y,[int]($req['durationMs'] ?? 500),[int]($req['steps'] ?? 24),[string]($req['button'] ?? 'left'),$stop);@{ok=$true} }
        'keyPress' { [RcGuiNative]::KeyCombo([string[]]$req['keys'],[int]($req['holdMs'] ?? 0),$stop);@{ok=$true} }
        'typeText' { [RcGuiNative]::TypeUnicode([string]$req['text'],[int]($req['intervalMs'] ?? 0),$stop,[string]$observed['foreground'],[uint32]$observed['processId']);@{ok=$true} }
        'focusWindow' {
            try { $windows=@([RcGuiNative]::ListWindows().ToArray()) }
            catch { throw 'GUI_FOCUS_ENUM_FAILED' }

            $handle = [string]$req['handle']
            $titleContains = [string]$req['titleContains']
            try {
                $matches = if($handle) {
                    @($windows | Where-Object { [string]$_.Handle -eq $handle })
                } else {
                    @($windows | Where-Object { ([string]$_.Title).IndexOf($titleContains,[StringComparison]::OrdinalIgnoreCase) -ge 0 })
                }
            } catch { throw 'GUI_FOCUS_MATCH_FAILED' }

            if(@($matches).Count -ne 1) { throw 'GUI_WINDOW_SELECTOR_NOT_UNIQUE' }
            try {
                [RcGuiNative]::Focus([string]$matches[0].Handle,$stop)
            } catch {
                $focusDiagnostic = @([string]$_,[string]$_.Exception,[string]$_.Exception.Message) -join ' '
                $focusMatch = [regex]::Match($focusDiagnostic,'GUI_[A-Z0-9_]+')
                if($focusMatch.Success) { throw $focusMatch.Value }
                throw 'GUI_FOCUS_INVOKE_FAILED'
            }
            @{ok=$true;handle=[string]$matches[0].Handle}
        }
    }
    return $result
} catch {
    return Convert-GuiErrorPayload $_
} finally {
    if($oldDpi -ne [IntPtr]::Zero) { [void][RcGuiNative]::SetThreadDpiAwarenessContext($oldDpi) }
    if($owned) { $mutex.ReleaseMutex() }
    if($mutex) { $mutex.Dispose() }
}
}

function Invoke-GuiRaw([string]$raw) {
    try {
        if($raw.Length -gt 32768) { throw 'GUI_REQUEST_LIMIT' }
        $req = $raw | ConvertFrom-Json -AsHashtable
        if($null -eq $req -or $req -isnot [hashtable]) { throw 'GUI_REQUEST_INVALID' }
        return Invoke-GuiRequest $req
    } catch {
        return Convert-GuiErrorPayload $_
    }
}

if($Server) {
    @{ok=$true;ready=$true;protocol=1} | ConvertTo-Json -Compress
    [Console]::Out.Flush()
    while(($raw=[Console]::In.ReadLine()) -ne $null) {
        $payload=Invoke-GuiRaw $raw
        $payload | ConvertTo-Json -Depth 8 -Compress
        [Console]::Out.Flush()
    }
} else {
    $raw=[Console]::In.ReadToEnd()
    $payload=Invoke-GuiRaw $raw
    $payload | ConvertTo-Json -Depth 8 -Compress
}
