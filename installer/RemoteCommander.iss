#ifndef MyVersion
  #define MyVersion "0.10.18-dev"
#endif
#ifndef MyCommit
  #define MyCommit "0000000000000000000000000000000000000000"
#endif
#ifndef MySourceRef
  #define MySourceRef "v0.10.18"
#endif
#ifndef DesktopPayload
  #define DesktopPayload "..\dist\desktop\remote-commander-windows-x64"
#endif

[Setup]
AppId={{7AB894C6-897D-43B7-B83A-24E1A8DF66A2}
AppName=Remote Commander
AppVersion={#MyVersion}
AppVerName=Remote Commander {#MyVersion}
AppPublisher=TandemVector Labs
AppPublisherURL=https://github.com/Usefull-Skills
AppSupportURL=https://github.com/GOD13emad/ChatGPTRemoteCommander/issues
; AppPublisher is installer metadata, not an Authenticode-trusted publisher identity.
DefaultDirName={localappdata}\Programs\Remote Commander
DefaultGroupName=Remote Commander
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UseSetupLdr=yes
OutputDir=..\dist\installer
OutputBaseFilename=Remote-Commander-Setup-v{#MyVersion}
SetupIconFile=..\desktop\RemoteCommanderDashboard\remote-commander.ico
UninstallDisplayIcon={app}\RemoteCommander.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
DisableWelcomePage=no
CloseApplications=yes
RestartApplications=no
ChangesEnvironment=yes

[Types]
Name: "core"; Description: "Commander Core"
Name: "complete"; Description: "Commander + Control && Monitoring"
Name: "custom"; Description: "Custom"; Flags: iscustom

[Components]
Name: "core"; Description: "Remote Commander Core and profile management"; Types: core complete custom; Flags: fixed
Name: "controlmonitor"; Description: "Control && Monitoring panel"; Types: complete
Name: "workplugin"; Description: "ChatGPT Work Plugin setup (requires registered App ID after install)"; Types: complete
#ifdef BrowserSetup
  #define BrowserSetupName ExtractFileName(BrowserSetup)
Name: "browser"; Description: "Remote Commander Browser"; Types: complete
#endif

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "{#DesktopPayload}\RemoteCommander.exe"; DestDir: "{app}"; Components: core; Flags: ignoreversion
Source: "{#DesktopPayload}\profile-manager-windows.ps1"; DestDir: "{app}"; Components: core; Flags: ignoreversion
Source: "{#DesktopPayload}\profile-enrollment-windows.ps1"; DestDir: "{app}"; Components: core; Flags: ignoreversion
Source: "{#DesktopPayload}\operations-monitor-windows.ps1"; DestDir: "{app}"; Components: controlmonitor; Flags: ignoreversion
Source: "{#DesktopPayload}\admin-runtime-windows.ps1"; DestDir: "{app}"; Components: controlmonitor; Flags: ignoreversion
Source: "..\server-install-windows.ps1"; Flags: dontcopy noencryption
Source: "..\install.ps1"; Flags: dontcopy noencryption
#ifdef BrowserSetup
Source: "{#BrowserSetup}"; DestName: "{#BrowserSetupName}"; Flags: dontcopy noencryption
#endif

[Icons]
Name: "{group}\Remote Commander"; Filename: "{app}\RemoteCommander.exe"; WorkingDir: "{app}"; IconFilename: "{app}\RemoteCommander.exe"
Name: "{autodesktop}\Remote Commander"; Filename: "{app}\RemoteCommander.exe"; WorkingDir: "{app}"; IconFilename: "{app}\RemoteCommander.exe"; Tasks: desktopicon

[InstallDelete]
Type: files; Name: "{group}\Remote Commander Profiles & Access.lnk"
Type: files; Name: "{group}\Remote Commander Operations Monitor.lnk"
Type: files; Name: "{group}\Remote Commander Admin Runtime.lnk"

[Run]
#ifdef BrowserSetup
Filename: "{tmp}\{#BrowserSetupName}"; Parameters: "/VERYSILENT /NORESTART"; Components: browser; StatusMsg: "Installing Remote Commander Browser..."; Flags: waituntilterminated
#endif
Filename: "{app}\RemoteCommander.exe"; Description: "Open Remote Commander"; Flags: nowait postinstall skipifsilent

[Code]
var
  ProfilePage: TInputQueryWizardPage;
  PwshPath: String;

function JsonBool(Value: Boolean): String;
begin
  if Value then Result := 'true'
  else Result := 'false';
end;

function IsProfileChar(C: Char): Boolean;
begin
  Result := ((C >= 'a') and (C <= 'z')) or ((C >= 'A') and (C <= 'Z')) or
            ((C >= '0') and (C <= '9')) or (C = '.') or (C = '_') or (C = '-');
end;

function IsValidProfileName(const S: String): Boolean;
var
  I: Integer;
begin
  Result := False;
  if (Length(S) < 1) or (Length(S) > 64) then Exit;
  if Pos('..', S) > 0 then Exit;
  for I := 1 to Length(S) do
    if not IsProfileChar(S[I]) then Exit;
  Result := True;
end;

function NormalizeProfiles(const Raw: String; var Normalized: String): Boolean;
var
  P: Integer;
  N, Work: String;
begin
  Result := False;
  Normalized := '';
  Work := Raw;
  StringChangeEx(Work, #13, '', True);
  StringChangeEx(Work, ';', #10, True);
  Work := Work + #10;

  while Length(Work) > 0 do
  begin
    P := Pos(#10, Work);
    if P = 0 then
    begin
      N := Trim(Work);
      Work := '';
    end
    else
    begin
      N := Trim(Copy(Work, 1, P - 1));
      Delete(Work, 1, P);
    end;

    if N <> '' then
    begin
      if not IsValidProfileName(N) then
      begin
        MsgBox('Invalid profile name: ' + N + #13#10 +
          'Use 1-64 letters, digits, dot, underscore or dash; ".." is not allowed.', mbError, MB_OK);
        Exit;
      end;

      if Pos(#10 + N + #10, #10 + Normalized + #10) = 0 then
      begin
        if Normalized <> '' then Normalized := Normalized + #13#10;
        Normalized := Normalized + N;
      end;
    end;
  end;

  if Normalized = '' then Normalized := 'chatgpt-remote-commander';
  Result := True;
end;

function FindPwsh: String;
begin
  Result := ExpandConstant('{pf64}\PowerShell\7\pwsh.exe');
  if not FileExists(Result) then Result := '';
end;

procedure EnsurePowerShell7;
var
  Msi, Url, Sha: String;
  ResultCode: Integer;
begin
  PwshPath := FindPwsh;
  if PwshPath <> '' then Exit;

  Url := 'https://github.com/PowerShell/PowerShell/releases/download/v7.6.6/PowerShell-7.6.6-win-x64.msi';
  Sha := '958838FF55091E1C8705D89EFED0CC7E8245A3A6EF6C0CCFAE20015227108AD8';
  Msi := ExpandConstant('{tmp}\PowerShell-7.6.6-win-x64.msi');
  WizardForm.StatusLabel.Caption := 'Downloading verified PowerShell 7 prerequisite...';
  DownloadTemporaryFile(Url, ExtractFileName(Msi), Sha, nil);
  if not ShellExec('runas', ExpandConstant('{sys}\msiexec.exe'),
      '/i "' + Msi + '" /qn /norestart', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    RaiseException('Could not elevate PowerShell prerequisite installation.');
  if (ResultCode <> 0) and (ResultCode <> 3010) then
    RaiseException('PowerShell installer failed with exit code ' + IntToStr(ResultCode) + '.');

  PwshPath := FindPwsh;
  if PwshPath = '' then RaiseException('PowerShell 7 installation completed but pwsh.exe was not found.');
end;

procedure InitializeWizard;
begin
  ProfilePage := CreateInputQueryPage(wpSelectComponents,
    'Profiles',
    'Which ChatGPT profiles should be connected?',
    'Enter one or more profile names separated by semicolons. Tunnel IDs and Runtime API keys are requested only after installation and are never written into the installer log.');
  ProfilePage.Add('Profiles (semicolon-separated):', False);
  ProfilePage.Values[0] := 'chatgpt-remote-commander';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Raw, Normalized: String;
begin
  Result := True;
  if CurPageID = ProfilePage.ID then
  begin
    Raw := ProfilePage.Values[0];
    if not NormalizeProfiles(Raw, Normalized) then
    begin
      Result := False;
      Exit;
    end;
    ProfilePage.Values[0] := Normalized;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  PrereqScript, CoreScript, Params, ExistingCoreGit: String;
  ExistingCore: Boolean;
  ResultCode: Integer;
begin
  Result := '';
  try
    // Existing per-user Git installation is an access-policy authority.
    // An ordinary Desktop/Control Center upgrade must not silently switch
    // a previously owner-authorized FULL_POWER profile to Standard.
    ExistingCoreGit := ExpandConstant('{localappdata}\ChatGPTRemoteCommander\app\.git');
    ExistingCore := DirExists(ExistingCoreGit) or FileExists(ExistingCoreGit);
    EnsurePowerShell7;

    ExtractTemporaryFile('server-install-windows.ps1');
    PrereqScript := ExpandConstant('{tmp}\server-install-windows.ps1');
    Params :=
      '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + PrereqScript + '"' +
      ' -SourceRef "{#MySourceRef}" -ExpectedCommit "{#MyCommit}" -PrerequisitesOnly';
    WizardForm.StatusLabel.Caption := 'Verifying machine prerequisites...';
    if not ShellExec('runas', PwshPath, Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      RaiseException('Could not elevate prerequisite installation.');
    if ResultCode <> 0 then
      RaiseException('Remote Commander prerequisite installer failed with exit code ' + IntToStr(ResultCode) + '.');

    ExtractTemporaryFile('install.ps1');
    CoreScript := ExpandConstant('{tmp}\install.ps1');
    Params :=
      '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + CoreScript + '"' +
      ' -StartServer -SourceRef "{#MySourceRef}" -ExpectedCommit "{#MyCommit}"';
    if not ExistingCore then Params := Params + ' -StandardMode';
    WizardForm.StatusLabel.Caption := 'Installing and verifying Remote Commander core for this user...';
    if not Exec(PwshPath, Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      RaiseException('Could not start Remote Commander core installer.');
    if ResultCode <> 0 then
      RaiseException('Remote Commander core installer failed with exit code ' + IntToStr(ResultCode) + '.');
  except
    Result := GetExceptionMessage;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  QueueDir, QueuePath, Normalized, Mode, Manifest, PluginStatus: String;
begin
  if CurStep <> ssPostInstall then Exit;

  if not NormalizeProfiles(ProfilePage.Values[0], Normalized) then
    RaiseException('Profile list became invalid during installation.');

  QueueDir := ExpandConstant('{localappdata}\ChatGPTRemoteCommander\onboarding');
  ForceDirectories(QueueDir);
  QueuePath := QueueDir + '\requested-profiles.txt';
  SaveStringToFile(QueuePath, Normalized + #13#10, False);

  if WizardIsComponentSelected('controlmonitor') then Mode := 'ControlMonitoring'
  else Mode := 'Core';
  if WizardIsComponentSelected('workplugin') then PluginStatus := 'PENDING_APP_ID'
  else PluginStatus := 'NOT_REQUESTED';

  Manifest :=
    '{' + #13#10 +
    '  "schema": 1,' + #13#10 +
    '  "product": "Remote Commander",' + #13#10 +
    '  "version": "{#MyVersion}",' + #13#10 +
    '  "mode": "' + Mode + '",' + #13#10 +
    '  "controlMonitoring": ' + JsonBool(WizardIsComponentSelected('controlmonitor')) + ',' + #13#10
    '  "workPluginSelected": ' + JsonBool(WizardIsComponentSelected('workplugin')) + ',' + #13#10
    '  "workPluginStatus": "' + PluginStatus + '",' + #13#10 +
#ifdef BrowserSetup
    '  "browserSelected": ' + JsonBool(WizardIsComponentSelected('browser')) + ',' + #13#10 +
#else
    '  "browserSelected": false,' + #13#10 +
#endif
    '  "releaseCommit": "{#MyCommit}"' + #13#10 +
    '}' + #13#10;
  SaveStringToFile(ExpandConstant('{app}\product-install.json'), Manifest, False);
end;
