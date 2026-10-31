import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const browserHelpers=[
 'tools/browser-control.mjs',
 'tools/browser-control-firefox.mjs',
 'experimental/owned-browser-r3/tools/browser-control.mjs',
];
const malicious=[
 '</script><script>globalThis.compromised=true</script>',
 'selector"][onclick="alert(1)',
 '"); globalThis.compromised=true; //',
 'quote\' and " double quote',
 'literal\nnewline\rreturn\ttab\bbackspace\f',
 'divider\u2028joiner\u2029last',
 'unicode \u0000 emoji 🕶️ slash / backslash \\',
 'nested\n</ScRiPt> \u2029',
 '',
];
for(const file of browserHelpers){
 test(file+' uses a post-JSON script literal encoder in every dynamic browser action',()=>{
  const src=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
  const definition=src.match(/function serializePageValue\(value\)\{[\s\S]*?^\}/m);
  assert.ok(definition,'missing standalone literal sanitizer');
  for(const key of ['selector','text','textIncludes','urlIncludes']){
   assert.ok(src.includes('serializePageValue(req.'+key+')'),'missing '+key);
   assert.equal(src.includes('JSON.stringify(req.'+key+')'),false,'raw interpolation '+key);
  }
  const context={fail:code=>Object.assign(new Error(code),{browserCode:code})};
  const literal=vm.runInNewContext(definition[0]+'\n serializePageValue;',context);
  for(const input of malicious){
   const code=literal(input);
   assert.equal(typeof code,'string');
   assert.equal(code.includes('<'),false,'literal less-than escaped');
   assert.equal(code.includes('>'),false,'literal greater-than escaped');
   assert.equal(code.includes('\u2028'),false,'U+2028 escaped');
   assert.equal(code.includes('\u2029'),false,'U+2029 escaped');
   const sandbox={compromised:false};
   const output=vm.runInNewContext('('+code+')',sandbox,{timeout:1000});
   assert.equal(output,input,'original string preserved after evaluation');
   assert.equal(sandbox.compromised,false,'string must not become script');
  }
  assert.equal(literal('</script>'),'"\\u003c/script\\u003e"');
  assert.throws(()=>literal(undefined),/BROWSER_INPUT_INVALID/,'fail closed for missing string');
 });
}
