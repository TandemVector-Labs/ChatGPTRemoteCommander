import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');

test('Windows setup wizard preserves secret boundary and produces device plugin continuation',()=>{
  const t=read('setup-wizard.ps1');
  for(const required of [
    'SHA256SUMS.txt','install.ps1','connect-chatgpt.ps1','build-device-plugin.ps1',
    'Runtime API key entry stays in the local hidden prompt','SETUP_MACHINE_PASS',
    'SETUP_FINAL_PASS','SETUP_WAITING_APP_ID','secretsPersistedInWizardState=$false',
    'rebootPerformed=$false'
  ]) assert.equal(t.includes(required),true,'missing '+required);
  assert.equal(/RuntimeApiKey|ApiKey\s*=|CONTROL_PLANE_API_KEY/u.test(t),false,'wizard must not accept/persist Runtime API key');
});

test('Linux setup wizard preserves secret boundary and produces device plugin continuation',()=>{
  const t=read('setup-wizard.sh');
  for(const required of [
    'SHA256SUMS.txt','install.sh','enable-autostart-linux.sh','build-device-plugin.sh',
    'Runtime API key entry stays in the local hidden prompt','SETUP_MACHINE_PASS',
    'SETUP_FINAL_PASS','SETUP_WAITING_APP_ID','secretsPersistedInWizardState:false',
    'rebootPerformed:false'
  ]) assert.equal(t.includes(required),true,'missing '+required);
  assert.equal(/--runtime-api-key|CONTROL_PLANE_API_KEY=/u.test(t),false,'wizard must not accept/persist Runtime API key');
  for(const marker of ['--display-name','PROFILE_DISPLAY_NAME_SAVED',
                       'PROFILE_DISPLAY_LABEL_COLLISION','TUNNEL_READY']) assert.ok(t.includes(marker));

});

test('device builders use stable local machine identity and require app id',()=>{
  const ps=read('build-device-plugin.ps1');
  const sh=read('build-device-plugin.sh');
  for(const required of ['MachineGuid','generate-device-plugin.mjs','DEVICE_PLUGIN_ZIP_PASS','.codex-plugin/plugin.json']) assert.equal(ps.includes(required),true,'Windows builder missing '+required);
  for(const required of ['/etc/machine-id','generate-device-plugin.mjs','DEVICE_PLUGIN_ZIP_PASS','.codex-plugin/plugin.json']) assert.equal(sh.includes(required),true,'Linux builder missing '+required);
});

test('manual bind helpers bind both portable and native plugin manifests',()=>{
  const ps=read('plugin-template/bind-app.ps1');
  const sh=read('plugin-template/bind-app.sh');
  for(const t of [ps,sh]){
    assert.equal(t.includes('.codex-plugin'),true);
    assert.equal(t.includes("./.app.json")||t.includes("'./.app.json'"),true);
    assert.equal(t.includes('plugin_'),true);
  }
});

test('installer ZIP includes identity map module used by the Plugin generator',()=>{
  const source=fs.readFileSync(path.join(root,'tools/build-release-assets.sh'),'utf8');
  assert.match(source,/src\/profile-identity-registry\.mjs/u);
  assert.match(source,/\$installer_stage\/src\/profile-identity-registry\.mjs/u);
  assert.match(source,/SHA256SUMS-INSTALLER\.txt/u);
});
