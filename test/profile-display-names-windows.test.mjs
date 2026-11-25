import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('Profile Setup sets a display label distinct from technical tunnel identity',()=>{
  const enroll=read('desktop/profile-enrollment-windows.ps1');
  const manager=read('desktop/profile-manager-windows.ps1');
  for(const text of ["Display name (editable later)",
    "Assert-ProfileDisplayAvailable $n $displayName",
    "Set-ProfileDisplayName $n $displayName",
    "enable-autostart.ps1","configure-profile-instance.ps1"])
    assert.ok(enroll.includes(text),text);
  for(const text of ["Save display name", "Set-ProfileDisplayName $technical $display.Text",
    "Get-ProfileDisplayName $name", "Assert-EditableSelection",
    "Apply selected access policy"])assert.ok(manager.includes(text),text);
  assert.ok(manager.indexOf("$saveName.Add_Click")!==-1);
  assert.ok(manager.indexOf("$apply.Add_Click")!==-1);
  assert.ok(manager.indexOf("$saveName.Add_Click")<manager.indexOf("$apply.Add_Click"));
});

test('Dashboard shows display name and keeps technical identity independent',()=>{
  const dashboard=read('desktop/RemoteCommanderDashboard/Program.cs');
  assert.match(dashboard,/ReadDisplayNames\(\)/);
  assert.match(dashboard,/profile-display-names\.json/);
  assert.match(dashboard,/Tag = p\.Name \+ " " \+ p\.DisplayName/);
  assert.match(dashboard,/Profile ID: \{p\.Name\}/);
  assert.match(dashboard,/DisplayName = labels\.TryGetValue\(p\.Name/);
});

test('Desktop build and both installers carry the label-store helper',()=>{
  for(const f of ['desktop/build-windows.ps1','desktop/install-windows.ps1',
                  'installer/RemoteCommander.iss'])
    assert.match(read(f),/profile-display-names\.ps1/u,f);
  const helper=read('desktop/profile-display-names.ps1');
  for(const marker of ['profile-display-names.json','PROFILE_DISPLAY_LABEL_COLLISION',
                       'PROFILE_DISPLAY_STORE_UNTRUSTED','FileStream','PROFILE_DISPLAY_READBACK_FAILED'])
    assert.ok(helper.includes(marker),marker);
  assert.doesNotMatch(helper,/enable-autostart|configure-profile-instance|RuntimeApiKey|TunnelId|Start-Process/u);
});

test('owner-local label persistence is atomic and isolated on Windows',t=>{
  if(process.platform!=='win32'){t.skip('Windows-only PowerShell runtime');return;}
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rc-display-labels-'));
  const script=path.join(root,'desktop','profile-display-names.ps1');
  const run=code=>{
    const source=". '"+script.replaceAll("'","''")+"'; "+code;
    return spawnSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',source],{
      encoding:'utf8',windowsHide:true,env:{...process.env,LOCALAPPDATA:tmp},timeout:15000
    });
  };
  try{
    assert.equal(run("[void](Set-ProfileDisplayName 'default' 'My Workstation')").status,0);
    assert.equal(run("[void](Set-ProfileDisplayName 'MMZ' 'کاربر MMZ')").status,0);
    assert.equal(run("Get-ProfileDisplayName 'default'").stdout.trim(),'My Workstation');
    assert.equal(run("Get-ProfileDisplayName 'mmz'").status,0);
    assert.equal(run("Get-ProfileDisplayName 'saeed-emad'").stdout.trim(),'saeed-emad');
    const saved=path.join(tmp,'ChatGPTRemoteCommander','profile-display-names.json');
    const data=JSON.parse(fs.readFileSync(saved,'utf8'));
    assert.equal(data.schema,1);
    assert.equal(data.profiles.mmz,'کاربر MMZ');
    assert.deepEqual(Object.keys(data.profiles).sort(),['default','mmz']);
    const first=fs.readFileSync(saved);
    for(const bad of [
      "Set-ProfileDisplayName 'saeed-emad' 'کاربر MMZ'",
      "Set-ProfileDisplayName '../wrong' 'Valid Label'",
      "Set-ProfileDisplayName 'saeed-emad' 'Invalid\nLabel'",
      "Set-ProfileDisplayName 'saeed-emad' ' '"
    ]){
      const result=run(bad);
      assert.notEqual(result.status,0,'should reject '+JSON.stringify(bad));
      assert.deepEqual(fs.readFileSync(saved),first,'rejected write changed label store');
    }
    assert.equal(fs.existsSync(path.join(tmp,'ChatGPTRemoteCommander','routing')),false);
    assert.equal(fs.existsSync(path.join(tmp,'ChatGPTRemoteCommander','instances')),false);
  } finally {fs.rmSync(tmp,{recursive:true,force:true,maxRetries:4,retryDelay:70});}
});
