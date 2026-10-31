import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));
const fail = (m) => { throw new Error(m); };

const pkg = JSON.parse(read('package.json'));
// Preserve the exact historical 0.10.26 acceptance gate, while admitting only
// explicitly marked non-publishable 0.11 development candidates.
if (pkg.version !== '0.10.26') {
  if (!/^0\.11\.0-(?:dev|rc)\.[1-9][0-9]*$/.test(pkg.version) ||
      !exists('docs/release-train-0.11.json'))
    fail('source-candidate package version not allowed by release train');
  const train = JSON.parse(read('docs/release-train-0.11.json'));
  if (train.sourceVersion !== pkg.version || train.isStable !== false ||
      train.publishApproved !== false || train.autoupdateApproved !== false ||
      train.installedPromotionApproved !== false || train.releaseTag !== null)
    fail('0.11 source candidate lacks explicit non-promotion release authority');
}
const serverSource = read('src/server-v0.3.mjs');
const serverVersion = serverSource.match(/const VERSION = '([^']+)'/u)?.[1];
if (serverVersion !== pkg.version) fail(`server runtime version ${serverVersion ?? 'missing'} does not match package version ${pkg.version}`);

for (const p of [
  'START_HERE.md','WORK_SETUP.md','PRIVACY.md','TERMS.md','docs/PLUGIN_SETUP.md',
  'plugin-template/plugin.json','plugin-template/.app.json.example',
  'plugin-template/bind-app.ps1','plugin-template/bind-app.sh',
  'install-work-plugin.ps1','install-work-plugin.sh',
  'setup-wizard.ps1','setup-wizard.sh','build-device-plugin.ps1','build-device-plugin.sh','tools/generate-device-plugin.mjs',
  'plugin-template/WORK_INSTALL_PROMPT.md','plugin-template/skills/remote-commander/SKILL.md',
  '.agents/plugins/marketplace.json','.codex/config.toml',
  'assets/plugin-icon.png','assets/plugin-logo.png','assets/plugin-icon.svg',
  'plugin-template/assets/icon.png','plugin-template/assets/logo.png'
]) if (!exists(p)) fail(`missing onboarding/plugin artifact: ${p}`);

const start = read('START_HERE.md');
for (const required of [
  'Single source of truth for assisted installation',
  'Full / Power Mode',
  'Never paste it into ChatGPT',
  'Plugins → + → Add custom MCP server',
  'the adopter\'s own ChatGPT account and workspace',
  'distinct tunnel per device',
  'I understand and want to continue',
  'Create as a plugin',
  'Developer Mode is **not required**',
  'Never ask them to copy another person\'s',
  'Connection**, choose **Tunnel**',
  'No authentication / None',
  'Scan Tools',
  'FINAL PASS checklist',
  'releases/latest/download/install.ps1',
  'releases/latest/download/install.sh',
  'docs/PLUGIN_SETUP.md',
  'GUI Control — zero-interference by default',
  'gui_screenshot',
  'synthetic input',
  'ChatGPT-Remote-Commander-Windows-Setup.zip',
  'ChatGPT-Remote-Commander-Linux-Setup.zip',
  'SETUP_WAITING_APP_ID',
  'device-specific Plugin ZIP'
]) if (!start.includes(required)) fail(`START_HERE missing: ${required}`);

// ChatGPT is the primary tool caller. Verify source guardrails against
// cross-account API-key inheritance; this contract does not certify live
// ChatGPT identity, Platform RBAC, or an actual tunnel credential.
for (const marker of [
  'Codex is not required',
  'does **not** automatically supply a retrievable `OPENAI_API_KEY`',
  'matching profile credential',
  'an active connection alone does not authenticate'
]) if (!start.includes(marker)) fail('ChatGPT account/Runtime key boundary missing: ' + marker);
const pluginDoc = read('docs/PLUGIN_SETUP.md');
for (const marker of ['ChatGPT-only default (no Codex required)', 'Optional Codex/Work distribution only', 'No authentication', 'session token'])
  if (!pluginDoc.includes(marker)) fail('ChatGPT-first installer instructions missing: ' + marker);
const skillDoc = read('plugin-template/skills/remote-commander/SKILL.md');
for (const marker of ['ChatGPT-first key boundary', 'locally enrolled Runtime API key', 'system_status'])
  if (!skillDoc.includes(marker)) fail('Remote Commander skill caller/key boundary missing: ' + marker);
const linuxEnrollment = read('connect-chatgpt-account.sh');
if (!linuxEnrollment.includes('unset OPENAI_API_KEY') ||
    !linuxEnrollment.includes('export CONTROL_PLANE_API_KEY="$RUNTIME_KEY"'))
  fail('Linux interactive enrollment must isolate ambient key from this profile Runtime key');
const linuxSupervisor = read('autostart-linux.sh');
if (!linuxSupervisor.includes('env -u OPENAI_API_KEY CONTROL_PLANE_API_KEY="$(cat "$cred")"'))
  fail('Linux persistent supervisor must use local profile credential without global OpenAI key');
const windowsEnrollment = read('enable-autostart.ps1');
for (const marker of [
  'Reusing existing DPAPI credential for profile',
  '$HadAmbientOpenAiApiKey = Test-Path Env:OPENAI_API_KEY',
  'Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue',
  '$env:CONTROL_PLANE_API_KEY = $PlainKey',
  '$env:OPENAI_API_KEY = $AmbientOpenAiApiKey'
]) if (!windowsEnrollment.includes(marker))
  fail('Windows interactive enrollment must isolate and restore ambient OpenAI key: ' + marker);
const windowsSupervisor = read('windows-supervisor-runtime.ps1');
for (const marker of [
  'Read-RcCredentialPlainText $Item.Credential',
  "Environment['CONTROL_PLANE_API_KEY']=$ApiKey",
  "Environment.Remove('OPENAI_API_KEY')"
]) {
  const source = marker.startsWith('Read-RcCredentialPlainText')
    ? read('autostart-windows.ps1') : windowsSupervisor;
  if (!source.includes(marker)) fail('Windows supervisor profile key isolation missing: ' + marker);
}

const plugin = JSON.parse(read('plugin-template/plugin.json'));
if (plugin.version !== pkg.version) fail('plugin version does not match package version');
if (plugin.name !== 'chatgpt-remote-commander') fail('unexpected plugin name');
const codexPlugin = JSON.parse(read('plugin-template/.codex-plugin/plugin.json'));
if (codexPlugin.name !== plugin.name || codexPlugin.version !== pkg.version) fail('Codex plugin identity/version drift');
if (codexPlugin.skills !== './skills/' || !exists(`plugin-template/${codexPlugin.skills}`)) fail('Codex skill discovery missing');
if (codexPlugin.apps || exists('plugin-template/.app.json')) fail('public Codex template must not contain a private app binding');
for (const field of ['composerIcon', 'logo']) {
  if (!exists(`plugin-template/${codexPlugin.interface?.[field]}`)) fail(`Codex plugin asset missing: ${field}`);
}
const openai = plugin.extensions?.['com.openai'];
if (!openai?.interface) fail('OpenAI plugin interface missing');
if (openai.apps) fail('public plugin template must not contain workspace-specific apps binding');
for (const field of ['displayName','shortDescription','longDescription','developerName','category','capabilities','websiteURL','privacyPolicyURL','termsOfServiceURL','defaultPrompt','brandColor','composerIcon','logo']) {
  if (openai.interface[field] == null) fail(`plugin interface missing ${field}`);
}

const appExample = JSON.parse(read('plugin-template/.app.json.example'));
if (!appExample.apps?.['remote-commander']?.id?.includes('REPLACE_WITH_YOUR_APP_ID')) fail('app binding example placeholder missing');

const marketplace = JSON.parse(read('.agents/plugins/marketplace.json'));
const entry = marketplace.plugins?.find((p) => p.name === 'chatgpt-remote-commander');
if (!entry || entry.source?.source !== 'local' || entry.source?.path !== './plugin-template') fail('marketplace entry invalid');
if (entry.policy?.installation !== 'INSTALLED_BY_DEFAULT') fail('marketplace plugin must be installed-by-default');
const codexConfig = read('.codex/config.toml');
if (!codexConfig.includes('[plugins."chatgpt-remote-commander@chatgpt-remote-commander"]') || !codexConfig.includes('enabled = true')) fail('project plugin enablement missing');
const work = read('WORK_SETUP.md');
for (const required of ['codex plugin marketplace add GOD13emad/ChatGPTRemoteCommander --ref main','codex plugin add chatgpt-remote-commander@chatgpt-remote-commander','releases/latest/download/install-work-plugin.ps1','releases/latest/download/install-work-plugin.sh','plugin-template.zip','Workspace settings → Plugins','@plugin-creator','plugin_asdk_app_','Do not substitute a fuzzy Plugin Directory search result','GUI Control in Work','gui_screenshot','FINAL PASS in Work','build-device-plugin.ps1','build-device-plugin.sh','Admin → Plugins → Add → Upload plugin']) if (!work.includes(required)) fail(`WORK_SETUP missing ${required}`);
const workPrompt = read('plugin-template/WORK_INSTALL_PROMPT.md');
for (const required of ['Read START_HERE.md first','WORK_SETUP.md','@plugin-creator','install-work-plugin.ps1/.sh','real tool invocation','gui_status','gui_screenshot']) if (!workPrompt.includes(required)) fail(`WORK_INSTALL_PROMPT missing ${required}`);
const skill = read('plugin-template/skills/remote-commander/SKILL.md');
for (const required of ['GUI Control workflow','gui_screenshot','gui_mouse_click','real-time/high-speed gameplay','ChatGPT-first reasoning and explicit external handoff','Continue in this chat with Remote Commander','Move to Work/Codex','Local Codex launch is a separate default-deny path']) if (!skill.includes(required)) fail(`remote-commander skill missing ${required}`);
const pluginSetup = read('docs/PLUGIN_SETUP.md');
for (const required of ['Windows GUI Control capability','MCP image content','Native Computer Use remains a fallback','DEVICE_PLUGIN.json','Admin → Plugins → Add → Upload plugin','apps = "./.app.json"']) if (!pluginSetup.includes(required)) fail(`PLUGIN_SETUP missing ${required}`);
const workPs = read('install-work-plugin.ps1');
for (const required of ['$MyInvocation.MyCommand.Path','releases/latest/download/plugin-template.zip','TemplateSource','[IO.Path]::IsPathRooted($TemplateSource)','Join-Path (Get-Location).Path $TemplateSource','[IO.Path]::IsPathRooted($InstallRoot)','Join-Path (Get-Location).Path $InstallRoot','plugin_((?:asdk_app_|connector_|templated_apps_)','chatgpt-remote-commander-personal','ChatGPT Remote Commander (Personal)','codex plugin add failed','WORK_PLUGIN_INSTALL_PASS','Generated native plugin manifest is not app-bound']) if (!workPs.includes(required)) fail(`install-work-plugin.ps1 missing ${required}`);
const workSh = read('install-work-plugin.sh');
for (const required of ['${BASH_SOURCE[0]:-}','releases/latest/download/plugin-template.zip','TEMPLATE_SOURCE','^plugin_((asdk_app_|connector_|templated_apps_)','chatgpt-remote-commander-personal','ChatGPT Remote Commander (Personal)','codex plugin add','WORK_PLUGIN_INSTALL_PASS','native.apps']) if (!workSh.includes(required)) fail(`install-work-plugin.sh missing ${required}`);

function pngSize(rel) {
  const b = fs.readFileSync(path.join(root, rel));
  if (b.length < 24 || b.toString('hex',0,8) !== '89504e470d0a1a0a') fail(`${rel} is not a PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}
for (const [rel,min] of [['assets/plugin-icon.png',512],['assets/plugin-logo.png',1024],['plugin-template/assets/icon.png',512],['plugin-template/assets/logo.png',1024]]) {
  const [w,h]=pngSize(rel);
  if (w !== h || w < min) fail(`${rel} dimensions invalid: ${w}x${h}`);
}

const langs = ['en','fa','ar','tr','es','fr','de','ru','zh-CN','ja'];
for (const lang of langs) {
  const p = `docs/SETUP.${lang}.md`;
  const t = read(p);
  if (!t.includes('START_HERE.md')) fail(`${p} does not point to canonical onboarding`);
  for (const stale of ['raw.githubusercontent.com/GOD13emad/ChatGPTRemoteCommander/main/install.ps1','Download ZIP','npm start','keep this window open']) {
    if (t.toLowerCase().includes(stale.toLowerCase())) fail(`${p} contains stale flow: ${stale}`);
  }
}

const winDisable=read('disable-autostart.ps1');
for (const required of ['tunnel-client.exe','server-v0\\.3\\.mjs','credential=']) if (!winDisable.includes(required)) fail(`Windows stop flow missing ${required}`);
const linuxDisable=read('disable-autostart-linux.sh');
for (const required of ['tunnel-client','src/server-v0.3.mjs','--remove-credential']) if (!linuxDisable.includes(required)) fail(`Linux stop flow missing ${required}`);
const winEnable=read('enable-autostart.ps1');
for (const required of ['Ensure-McpHealth','MCP was not running; it has been started automatically.']) if (!winEnable.includes(required)) fail(`Windows start flow missing ${required}`);
const linuxEnable=read('enable-autostart-linux.sh');
for (const required of ['ensure_mcp','MCP was not running; it has been started automatically.']) if (!linuxEnable.includes(required)) fail(`Linux start flow missing ${required}`);

console.log('ONBOARDING_PLUGIN_CHECK_PASS');
