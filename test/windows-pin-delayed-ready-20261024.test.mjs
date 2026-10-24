import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('late native Windows directory guard readiness is bounded and still holds the ancestor', {timeout: 60000}, t => {
  if (process.platform !== 'win32') { t.skip('Windows native pin only'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-win-pin-delay-'));
  const privateDir = path.join(root, 'private');
  const hook = path.join(root, 'delayed-pin.cjs');
  try {
    fs.mkdirSync(privateDir);
    fs.writeFileSync(hook, [
      "const cp=require('node:child_process');",
      "const {syncBuiltinESMExports}=require('node:module');",
      "const original=cp.spawn;",
      "cp.spawn=function(file,args,options){",
      " const child=original.call(this,file,args,options);",
      " if(String(file).toLowerCase()==='pwsh.exe' && args.some(a=>String(a).endsWith('win-dest-pin.ps1'))){",
      "  const on=child.stdout.on.bind(child.stdout);",
      "  child.stdout.on=function(event,listener){",
      "   if(event==='data') return on(event,data=>setTimeout(()=>listener(data),13000));",
      "   return on(event,listener);",
      "  };",
      " }",
      " return child;",
      "};",
      "syncBuiltinESMExports();"
    ].join('\n'));
    const source = new URL('../src/windows-directory-pin.mjs', import.meta.url).href;
    const program = [
      "import fs from 'node:fs';",
      'import {withPinnedWindowsDirectory} from ' + JSON.stringify(source) + ';',
      "const dir=process.env.RC_TEST_PRIVATE;",
      "await withPinnedWindowsDirectory(dir,async()=>{",
      " let denied=false;",
      " try{fs.renameSync(dir,dir+'.moved');}",
      " catch(error){denied=['EPERM','EACCES','EBUSY'].includes(error.code);}",
      " if(!denied)throw Error('NATIVE_GUARD_NOT_HELD');",
      " process.stdout.write('LATE_READY_PROTECTED\\n');",
      "});"
    ].join('\n');
    const result = spawnSync(process.execPath, ['--input-type=module','-e',program], {
      env:{...process.env,NODE_OPTIONS:'--require='+hook,RC_TEST_PRIVATE:privateDir},
      cwd:root,encoding:'utf8',timeout:50000,windowsHide:true
    });
    assert.equal(result.status, 0, String(result.error || '') + '\n' + result.stderr + '\n' + result.stdout);
    assert.match(result.stdout, /LATE_READY_PROTECTED/);
    assert.equal(fs.existsSync(privateDir),true);
    assert.equal(fs.existsSync(privateDir+'.moved'),false);
  } finally {
    fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:120});
  }
});