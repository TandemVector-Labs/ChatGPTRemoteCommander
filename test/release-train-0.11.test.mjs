import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=new URL('../',import.meta.url);
const rootPath=resolve(fileURLToPath(root));
const git=(args,options={})=>execFileSync('git',['-c',`safe.directory=${rootPath}`,'-C',rootPath,...args],options);
const read=p=>readFileSync(new URL(p,root),'utf8');
test('0.11 development train never masquerades as Stable or approved promotion',()=>{
 const a=JSON.parse(read('docs/release-train-0.11.json'));
 assert.equal(a.train,'0.11');assert.equal(a.sourceVersion,'0.11.0-dev.105');
 assert.equal(a.sourceBaseSha,'c057494329490257e3d79046ea7599c60dde1e89');
 assert.equal(a.status,'INTEGRATION_CANDIDATE_NOT_FINAL');
 assert.match(read('CHANGELOG.md'),/^# 0\.11\.0-dev\.105 .*NoPromote/m);
 assert.match(read('docs/RELEASE_TRAIN_0.11.md'),/^## 0\.11\.0-dev\.105 .*NoPromote/m);
 assert.match(read('CHANGELOG.md'),/^# 0\.11\.0-dev\.20 .*NoPromote/m);
 assert.match(read('docs/RELEASE_TRAIN_0.11.md'),/^## 0\.11\.0-dev\.20 .*NoPromote/m);
 assert.match(read('CHANGELOG.md'),/^# 0\.11\.0-dev\.19 .*NoPromote/m);
 assert.match(read('docs/RELEASE_TRAIN_0.11.md'),/^## 0\.11\.0-dev\.19 .*NoPromote/m);
 assert.match(read('CHANGELOG.md'),/^# 0\.11\.0-dev\.21 .*NoPromote/m);
 assert.match(read('docs/RELEASE_TRAIN_0.11.md'),/^## 0\.11\.0-dev\.21 .*NoPromote/m);
 assert.match(read('CHANGELOG.md'),/^# 0\.11\.0-dev\.22 .*NoPromote/m);
 assert.match(read('docs/RELEASE_TRAIN_0.11.md'),/^## 0\.11\.0-dev\.22 .*NoPromote/m);
 assert.equal(a.targetPrerelease,'0.11.0');assert.equal(a.firstStable,'1.0.0');
 assert.equal(a.isStable,false);assert.equal(a.publishApproved,false);
 assert.equal(a.autoupdateApproved,false);assert.equal(a.installedPromotionApproved,false);
 assert.equal(a.releaseTag,null);
 assert.equal(a.distribution.noPublicStableAccepted,true);
 assert.ok(a.components.length>=8&&a.components.every(x=>x.required&&!x.verified));
 assert.ok(Object.values(a.acceptance).every(x=>x===false));
 assert.equal(a.fleet.length,5);
 assert.match(read('tools/workspace-owner-broker.mjs'),/timingSafeEqual/);
 assert.doesNotMatch(read('tools/workspace-owner-broker.mjs'),/owner_session_shell|workspace_driver_diagnostic|execFileAsync|EncodedCommand|powershell\.exe|SendInput|SendKeys/);
 assert.match(read('tools/workspace-owner-broker.mjs'),/allowMouse:false,allowKeyboard:false,allowWindowFocus:false/);
 assert.match(read('tools/launch-owner-workspace.ps1'),/OWNER_WORKSPACE_BROKER_HASH_MISMATCH/);
 assert.match(read('tools/launch-owner-workspace.ps1'),/OWNER_WORKSPACE_RELEASE_PATH_ESCAPE/);
 assert.match(read('src/workspace-tools.mjs'),/resolveOwnerCuaPipe/);
 assert.match(read('src/workspace-tools.mjs'),/WORKSPACE_CUA_OWNER_PIPE_INVALID/);
 assert.match(read('tools/workspace-owner-broker.mjs'),/CUA_CHANNEL_PIPE_INVALID/);
 assert.match(read('tools/launch-owner-workspace.ps1'),/rc-workspace-cua-v038-/);
 assert.match(read('tools/launch-owner-workspace.ps1'),/if \(\$SelfTest\)/);

 assert.match(read('tools/workspace-owner-broker.mjs'),/OWNER_SID_MISMATCH/);
 assert.match(read('tools/launch-owner-workspace.ps1'),/OWNER_WORKSPACE_OWNER_SID_MISMATCH/);
 assert.match(read('tools/launch-owner-workspace.ps1'),/OWNER_WORKSPACE_NODE_HASH_MISMATCH/);
 assert.match(read('tools/launch-owner-workspace.ps1'),/OWNER_WORKSPACE_LAUNCHER_HASH_MISMATCH/);
 const prep=read('tools/prepare-owner-workspace-candidate.ps1');
 assert.match(prep,/OWNER_WORKSPACE_CANDIDATE_POWERSHELL7_REQUIRED/);
 assert.match(prep,/\[IO\.FileMode\]::CreateNew/);
 assert.match(prep,/OWNER_WORKSPACE_CANDIDATE_SELFTEST_RECEIPT_MISMATCH/);
 assert.match(prep,/scheduledTaskChanged = \$false/);
 assert.match(prep,/activeConfigChanged = \$false/);


});
test('server, plugin, npm package and Windows Control Center development identity agree',()=>{
 const ver=JSON.parse(read('docs/release-train-0.12.json')).sourceVersion;
 assert.equal(JSON.parse(read('package.json')).version,ver);
 assert.equal(JSON.parse(read('plugin-template/plugin.json')).version,ver);
 assert.equal(JSON.parse(read('plugin-template/.codex-plugin/plugin.json')).version,ver);
 assert.ok(read('src/server-v0.3.mjs').includes("const VERSION = '"+ver+"';"));
 const cs=read('desktop/RemoteCommanderDashboard/RemoteCommanderDashboard.csproj');
 assert.ok(cs.includes('<Version>'+ver+'</Version>'));
 const numericVersion='0.12.0.'+ver.split('.').at(-1);
 assert.ok(cs.includes('<FileVersion>'+numericVersion+'</FileVersion>'));
 assert.ok(cs.includes('<AssemblyVersion>'+numericVersion+'</AssemblyVersion>'));
});
test('historical releases are not silently deleted or accepted as product stable',()=>{
 const a=JSON.parse(read('docs/release-train-0.11.json'));
 assert.equal(a.distribution.keepAssetsAndTags,true);
 assert.equal(a.distribution.oldReleaseMetadataPending,true);
 assert.equal(a.distribution.noLatestChannelRetargetUntilUpdaterMigration,true);
 assert.match(read('README.md'),/no currently accepted Stable/);
});


test('tracked Windows router PowerShell blob uses LF internally while checkout selects CRLF',()=>{
 const source=git(['show','HEAD:tools/router-commandline-windows.ps1'],{encoding:null});
 assert.ok(source.length>0);
 assert.equal(source.includes(Buffer.from('\r\n')),false,'tracked git blob must be LF normalized');
 const eol=git(['check-attr','eol','--','tools/router-commandline-windows.ps1'],{encoding:'utf8'});
 assert.match(eol,/eol: crlf/);
});
