import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));
const fail = (m) => { throw new Error(m); };

const pkg = JSON.parse(read('package.json'));
if (pkg.version !== '0.10.25') fail('source-candidate package version must be 0.10.25');
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
