import test from 'node:test';import assert from 'node:assert/strict';
import {chooseAgentOSProvider} from '../src/agentos-provider-router.mjs';
import {workspaceToolDefinitions} from '../src/workspace-tools.mjs';
const plan=(x={})=>chooseAgentOSProvider({target:'existing-browser',platform:'linux',ownerSession:true,...x});
test('Firefox uses owner AT-SPI, not CDP',()=>{
 const x=plan({application:{browserFamily:'firefox'},capabilities:{linuxATSPI:true,chromeDevtoolsExistingAuthorized:true},grants:{nativeBrowserUI:true,browserProfileAttach:true}});
 assert.equal(x.provider,'linux-atspi-native');assert.equal(x.autoElevate,false);
});
test('Brave default-profile uses owner GUI, not assumed Chrome CDP',()=>{
 const x=plan({application:{browserFamily:'brave',profileKind:'default'},capabilities:{linuxATSPI:true,chromeDevtoolsExistingAuthorized:true},grants:{nativeBrowserUI:true,browserProfileAttach:true}});
 assert.equal(x.provider,'linux-atspi-native');
});
test('Extension, then BiDi, then native UI are authorized independent alternatives',()=>{
 const x=plan({application:{browserFamily:'firefox'},capabilities:{browserExtensionExistingAuthorized:true,webdriverBiDiExistingAuthorized:true,linuxATSPI:true},grants:{browserExtensionAttach:true,browserProfileAttach:true,nativeBrowserUI:true}});
 assert.equal(x.provider,'browser-extension-owner');assert.deepEqual(x.fallbackProviders,['webdriver-bidi-native','linux-atspi-native']);
});
test('Firefox verified BiDi is independent of Chromium',()=>{
 const x=plan({application:{browserFamily:'firefox'},capabilities:{webdriverBiDiExistingAuthorized:true},grants:{browserProfileAttach:true}});
 assert.equal(x.provider,'webdriver-bidi-native');
});
test('Unknown browser is not silently treated as Chrome',()=>{
 assert.equal(plan({capabilities:{chromeDevtoolsExistingAuthorized:true},grants:{browserProfileAttach:true}}).code,'BROWSER_EXISTING_PROFILE_ROUTE_UNAVAILABLE');
});
test('Verified nondefault Chrome CDP remains an optional backend',()=>{
 const x=plan({application:{browserFamily:'chrome',profileKind:'custom'},capabilities:{chromeDevtoolsExistingAuthorized:true},grants:{browserProfileAttach:true}});
 assert.equal(x.provider,'chrome-devtools-mcp');
});
test('UIA precedes scoped CUA for Windows Firefox',()=>{
 const x=plan({platform:'win32',application:{browserFamily:'firefox'},capabilities:{windowsUIA:true,cuaVerifiedOwnerTarget:true},grants:{nativeBrowserUI:true,visualFallback:true}});
 assert.equal(x.provider,'windows-uia-native');assert.deepEqual(x.fallbackProviders,['cua-last-resort']);
});
test('Dedicated Commander browser is only for ChatGPT connection',()=>{
 const c={commanderOwnedBrowser:true};
 assert.equal(plan({target:'new-browser',capabilities:c}).code,'OWNED_BROWSER_UNAVAILABLE');
 assert.equal(plan({target:'new-browser',application:{purpose:'general-browser'},capabilities:c}).code,'OWNED_BROWSER_UNAVAILABLE');
 assert.equal(plan({target:'new-browser',application:{purpose:'chatgpt-connection'},capabilities:c}).provider,'commander-owned-browser');
});
test('No credential copy, unowned or unconsented access',()=>{
 assert.equal(plan({ownerSession:false,capabilities:{linuxATSPI:true},grants:{nativeBrowserUI:true}}).code,'OWNER_SESSION_REQUIRED');
 const x=plan({capabilities:{linuxATSPI:true}});
 assert.equal(x.code,'BROWSER_OWNER_CONSENT_REQUIRED');assert.equal(x.credentials,'NEVER_COPY');
});
test('Planner public schema is browser neutral, read-only and no password argument',()=>{
 const t=workspaceToolDefinitions.find(x=>x.name==='workspace_agentos_plan');
 assert.ok(t);assert.equal(t.annotations.readOnlyHint,true);assert.equal(t.inputSchema.additionalProperties,false);
 assert.deepEqual(t.inputSchema.properties.browserFamily.enum.slice(0,3),['firefox','brave','chrome']);
 assert.ok(t.inputSchema.properties.purpose.enum.includes('chatgpt-connection'));
 assert.equal(Object.hasOwn(t.inputSchema.properties,'password'),false);
});
