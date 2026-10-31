import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const file=path.join(root,'tools/install-browser-linux.sh');
test('Linux Browser release is exact hash pinned and retains Chromium sandbox',()=>{
 const s=fs.readFileSync(file,'utf8');
 for(const p of ["VERSION='0.8.1'",'8cac4150b844e48c5f6fbf90df84b306d49165bef77f716f5c61d20bad164073','sha256sum -c SHA256SUMS.txt','sudo -v','BROWSER_RELEASE_SHA256_MISMATCH','BROWSER_LINUX_X11_REQUIRED','profilePreserved=true'])assert.ok(s.includes(p),p);
 assert.ok(!s.includes(' --no-sandbox '));
 assert.ok(!s.includes('rm -rf "$HOME/.config'));
});
test('Linux Browser planner runs offline and fails before any installation without X11',{skip:process.platform==='win32'},()=>{
 const opts={encoding:'utf8',timeout:4000,env:{...process.env,DISPLAY:''}};
 let q=spawnSync('bash',[file,'--plan-only'],opts);assert.equal(q.status,0,q.stderr);assert.match(q.stdout,/changesApplied=false/);
 q=spawnSync('bash',[file,'--install'],opts);assert.equal(q.status,2,q.stderr);assert.match(q.stderr,/BROWSER_LINUX_(X11_REQUIRED|UNSUPPORTED_ARCH)/);
 q=spawnSync('bash',[file,'--other'],opts);assert.equal(q.status,2);
});

test('Browser release wrapper supports exactly validated local artifact path for one-download canary',()=>{
 const s=fs.readFileSync(file,'utf8');
 assert.match(s,/--install --archive-file PATH/);
 assert.match(s,/ARCHIVE_SOURCE=/);
 assert.match(s,/BROWSER_LOCAL_ARCHIVE_UNAVAILABLE/);
 assert.match(s,/sha256sum "\$WORK\/\$ARCHIVE"/);
 assert.ok(s.indexOf("if [[ -n \"$ARCHIVE_SOURCE\" ]]")<s.indexOf("ACTUAL=\"$(sha256sum"),'local artifact must be checksum-verified');
});
