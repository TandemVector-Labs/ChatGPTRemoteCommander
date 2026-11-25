import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'..');
const exe=process.platform==='linux'
  ? '/opt/Remote Commander/remote-commander-unified'
  : path.join(root,'dist','unified','win-unpacked','Remote Commander.exe');
const enabled=(process.platform==='win32' && process.env.RC_TEST_PACKAGED_GUI==='1')
  ||(process.platform==='linux' && process.env.RC_TEST_INSTALLED_GUI==='1');
const require=createRequire(path.join(root,'packaging','unified','package.json'));

test('real packaged GUI: sandboxed renderer and preview Start/Stop, isolated from active Commander',
  {skip:!enabled,timeout:45000},async()=>{
    assert.ok(fs.existsSync(exe),'native OS executable is missing');
    const {_electron}=require('playwright-core');
    const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'rc-unified-e2e-'));
    const launchEnv={...process.env,APPDATA:isolated,XDG_CONFIG_HOME:isolated};
    let app=null;
    try{
      app=await _electron.launch({executablePath:exe,args:[],
        env:launchEnv,timeout:25000});
      const page=await app.firstWindow({timeout:20000});
      assert.match(await page.title(),/Remote Commander/);
      await page.waitForFunction(()=>document.querySelector('#status')?.textContent?.includes('stopped'),
        null,{timeout:12000});
      const before=await page.locator('#status').innerText();
      assert.match(before,/source/);
      assert.match(before,/[0-9a-f]{40}/);
      assert.equal(await page.evaluate(()=>typeof require==='undefined' && typeof process==='undefined'),true,
        'Renderer must not expose Node integration');
      await page.waitForFunction(()=>{
        const t=document.querySelector('#migration')?.textContent||'';
        return t.includes('NO_PROMOTE')||t.includes('LOCAL_PREFLIGHT_UNAVAILABLE');
      },null,{timeout:12000});
      const check=await page.locator('#migration').innerText();
      assert.match(check,/NO_PROMOTE/);
      assert.match(check,/"readOnly": true/);
      assert.doesNotMatch(check,/api[_-]?key|password|bearer/i);
      await page.getByRole('button',{name:'Start isolated preview'}).click();
      await page.waitForFunction(()=>document.querySelector('#status')?.textContent?.includes('running'),
        null,{timeout:18000});
      const running=await page.locator('#result').innerText();
      assert.match(running,/isolated STANDARD loopback/);
      assert.match(running,/"privilegedAccess": false/);
      await page.getByRole('button',{name:'Stop preview'}).click();
      await page.waitForFunction(()=>document.querySelector('#status')?.textContent?.includes('stopped'),
        null,{timeout:12000});
    }finally{
      try{if(app)await app.close();}finally{
        fs.rmSync(isolated,{recursive:true,force:true,maxRetries:8,retryDelay:180});
      }
    }
  });
