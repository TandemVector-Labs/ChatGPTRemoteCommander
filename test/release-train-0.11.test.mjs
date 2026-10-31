import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const root=new URL('../',import.meta.url);
const read=p=>readFileSync(new URL(p,root),'utf8');
test('0.11 development train never masquerades as Stable or approved promotion',()=>{
 const a=JSON.parse(read('docs/release-train-0.11.json'));
 assert.equal(a.train,'0.11');assert.equal(a.sourceVersion,'0.11.0-dev.15');
 assert.equal(a.targetPrerelease,'0.11.0');assert.equal(a.firstStable,'1.0.0');
 assert.equal(a.isStable,false);assert.equal(a.publishApproved,false);
 assert.equal(a.autoupdateApproved,false);assert.equal(a.installedPromotionApproved,false);
 assert.equal(a.releaseTag,null);
 assert.equal(a.distribution.noPublicStableAccepted,true);
 assert.ok(a.components.length>=8&&a.components.every(x=>x.required&&!x.verified));
 assert.ok(Object.values(a.acceptance).every(x=>x===false));
 assert.equal(a.fleet.length,5);
});
test('server, plugin, npm package and Windows Control Center development identity agree',()=>{
 const ver='0.11.0-dev.15';
 assert.equal(JSON.parse(read('package.json')).version,ver);
 assert.equal(JSON.parse(read('plugin-template/plugin.json')).version,ver);
 assert.equal(JSON.parse(read('plugin-template/.codex-plugin/plugin.json')).version,ver);
 assert.ok(read('src/server-v0.3.mjs').includes("const VERSION = '"+ver+"';"));
 const cs=read('desktop/RemoteCommanderDashboard/RemoteCommanderDashboard.csproj');
 assert.ok(cs.includes('<Version>'+ver+'</Version>'));
 assert.ok(cs.includes('<FileVersion>0.11.0.15</FileVersion>'));
 assert.ok(cs.includes('<AssemblyVersion>0.11.0.15</AssemblyVersion>'));
});
test('historical releases are not silently deleted or accepted as product stable',()=>{
 const a=JSON.parse(read('docs/release-train-0.11.json'));
 assert.equal(a.distribution.keepAssetsAndTags,true);
 assert.equal(a.distribution.oldReleaseMetadataPending,true);
 assert.equal(a.distribution.noLatestChannelRetargetUntilUpdaterMigration,true);
 assert.match(read('README.md'),/no currently accepted Stable/);
});


test('tracked Windows router PowerShell blob uses LF internally while checkout selects CRLF',()=>{
 const cwd=new URL('../',import.meta.url);
 const source=execFileSync('git',['show','HEAD:tools/router-commandline-windows.ps1'],{cwd,encoding:null});
 assert.ok(source.length>0);
 assert.equal(source.includes(Buffer.from('\r\n')),false,'tracked git blob must be LF normalized');
 const eol=execFileSync('git',['check-attr','eol','--','tools/router-commandline-windows.ps1'],{cwd,encoding:'utf8'});
 assert.match(eol,/eol: crlf/);
});
