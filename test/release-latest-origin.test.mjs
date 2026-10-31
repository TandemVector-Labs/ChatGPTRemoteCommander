import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const linux=fs.readFileSync(path.join(root,'auto-update-linux.sh'),'utf8');
const windows=fs.readFileSync(path.join(root,'auto-update-windows.ps1'),'utf8');
const linuxMatch=linux.match(/sed -nE 's#(\^https:\/\/github\[\.\]com\/GOD13emad\/ChatGPTRemoteCommander\/releases\/tag\/[^#]+)#\\1#p'/);
const windowsMatch=windows.match(/\$effective -cmatch '(\^https:\/\/github\[\.\]com\/GOD13emad\/ChatGPTRemoteCommander\/releases\/tag\/[^']+)'/);
test('updater discovery patterns are anchored to the exact trusted release origin',()=>{
 assert.ok(linuxMatch,'Linux latest_ref must anchor complete GitHub redirect URL');
 assert.ok(windowsMatch,'Windows Get-LatestTag must anchor complete GitHub redirect URL');
 for (const input of [
  'https://github.com/GOD13emad/ChatGPTRemoteCommander/releases/tag/v0.10.24',
  'https://github.com/GOD13emad/ChatGPTRemoteCommander/releases/tag/v1.2.3'
 ]) {
  for (const [label,pattern] of [['Linux',linuxMatch[1]],['Windows',windowsMatch[1]]]) {
   const result=input.match(new RegExp(pattern));
   assert.equal(result?.[1],input.split('/').at(-1),label+': '+input);
  }
 }
 for (const input of [
  'https://foreign.example/other/releases/tag/v0.10.24',
  'https://github.com.attacker.example/GOD13emad/ChatGPTRemoteCommander/releases/tag/v0.10.24',
  'http://github.com/GOD13emad/ChatGPTRemoteCommander/releases/tag/v0.10.24',
  'https://github.com/AnotherOwner/ChatGPTRemoteCommander/releases/tag/v0.10.24',
  'https://github.com/GOD13emad/ChatGPTRemoteCommander/releases/tag/v0.10.24?next=evil',
  'https://github.com/GOD13emad/ChatGPTRemoteCommander/releases/tag/v0.10.24#fragment',
  'https://github.com/GOD13emad/ChatGPTRemoteCommander/releases/tag/v0.10.24/extra',
  'https://attacker@github.com/GOD13emad/ChatGPTRemoteCommander/releases/tag/v0.10.24'
 ]) {
  for (const [label,pattern] of [['Linux',linuxMatch[1]],['Windows',windowsMatch[1]]]) {
   assert.equal(new RegExp(pattern).test(input),false,label+' accepted untrusted effective URL '+input);
  }
 }
});
test('Windows fallback and Linux API fallback remain present for nonmatching redirects',()=>{
 assert.match(windows,/Invoke-RestMethod 'https:\/\/api[.]github[.]com\/repos\/GOD13emad\/ChatGPTRemoteCommander\/releases\/latest'/);
 assert.match(linux,/https:\/\/api[.]github[.]com\/repos\/GOD13emad\/ChatGPTRemoteCommander\/releases\/latest/);
});
