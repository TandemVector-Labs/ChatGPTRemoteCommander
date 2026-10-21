'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ui=path.resolve(__dirname,'..','RemoteCommanderDashboard');
const core=fs.readFileSync(path.join(ui,'Program.cs'),'utf8');
const presentation=fs.readFileSync(path.join(ui,'DashboardChrome.cs'),'utf8');

test('UI-only module has no shell, backend network or arbitrary file authority',()=>{
 assert.doesNotMatch(presentation,/Process\.Start|HttpClient|Registry\.SetValue|File\.Write|ProcessStartInfo|ExecutionPolicy|Core\.Mutate/);
 assert.match(core,/new\(\) \{ Timeout = TimeSpan\.FromSeconds\(1\.5\) \}/);
 assert.match(core,/http\.GetAsync\(\$"http:\/\/127\.0\.0\.1:/);
});
test('routing UI remains version pinned to main baseline and does not invent identity',()=>{
 assert.match(core,/ROUTER \+ BACKEND IDENTITY VERIFIED/);
 assert.match(core,/ProfileHealthEvidence\.Matches/);
 assert.match(core,/\/router\/status/);
 assert.doesNotMatch(core,/● ONLINE/);
 assert.match(core,/stateFile\.GetString/);
 assert.match(core,/generation/);
 assert.match(presentation,/READ ONLY/);
 assert.match(presentation,/Live operations", "UNVERIFIED"/);
});
test('UI features include accessible local profile search and DPI-safe resizing',()=>{
 assert.match(presentation,/AccessibleName = "Filter verified local routing profiles"/);
 assert.match(presentation,/SizeChanged/);
 assert.match(presentation,/ApplyFilter/);
 assert.match(presentation,/AccessibleName = \(evidence/);
 assert.match(core,/AutoScaleMode = AutoScaleMode\.Dpi;/);
});
test('Windows appearance follows read-only per-user system preference',()=>{
 assert.match(core,/Registry\.CurrentUser\.OpenSubKey/);
 assert.match(core,/AppsUseLightTheme/);
 assert.match(core,/appearanceTimer\.Tick/);
 assert.match(core,/appearanceTimer\.Stop/);
 assert.doesNotMatch(core,/Registry\.SetValue|CreateSubKey/);
});
test('existing Core management tools and Browser entry remain gated',()=>{
 for(const helper of ['profile-enrollment-windows.ps1','profile-manager-windows.ps1','operations-monitor-windows.ps1','admin-runtime-windows.ps1'])
  assert.match(core,new RegExp('ToolInstalled\\("'+helper.replaceAll('.','\\.')+'"' ));
 assert.match(core,/File\.Exists\(tool\)/);
 assert.match(core,/LaunchBrowser\(\)/);
 assert.doesNotMatch(presentation,/CommandExecution|Credentials/);
});

test('R262 Control Center executable version must match Core release metadata',()=>{
 const project=fs.readFileSync(path.join(ui,'RemoteCommanderDashboard.csproj'),'utf8');
 const pack=JSON.parse(fs.readFileSync(path.resolve(__dirname,'..','..','package.json'),'utf8'));
 const values=['Version','FileVersion','AssemblyVersion'].map(key=>{
  const matches=[...project.matchAll(new RegExp('<'+key+'>([^<]+)</'+key+'>','g'))];
  assert.equal(matches.length,1,key+' must occur exactly once');
  return matches[0][1];
 });
 assert.deepEqual(values,[pack.version,pack.version+'.0',pack.version+'.0']);
 assert.match(project,/<UseWindowsForms>true<\/UseWindowsForms>/);
});