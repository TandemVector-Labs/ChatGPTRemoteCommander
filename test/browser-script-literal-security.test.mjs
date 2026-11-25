import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';

// The three executable helpers are intentionally standalone shipped scripts.
 // Verify their exact audited serializer bytes without ever evaluating source
 // strings extracted from repository files (which would execute arbitrary JS).
const APPROVED_SERIALIZER_SHA256='d844d934ddb8cff346f3d2dc99b9df1b867ee003a728fff4d6a7a0ad00ec3976';
function approvedSerializer(value){
 const literal=JSON.stringify(value);
 if(typeof literal!=='string')throw Error('BROWSER_INPUT_INVALID');
 return literal.replace(/</g,'\\u003c')
   .replace(/>/g,'\\u003e')
   .replace(/\u2028/g,'\\u2028')
   .replace(/\u2029/g,'\\u2029');
}
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
  assert.equal(createHash('sha256').update(definition[0]).digest('hex'),
   APPROVED_SERIALIZER_SHA256,'helper sanitizer implementation changed');
  const literal=approvedSerializer;
  for(const input of malicious){
   const code=literal(input);
   assert.equal(typeof code,'string');
   assert.equal(code.includes('<'),false,'literal less-than escaped');
   assert.equal(code.includes('>'),false,'literal greater-than escaped');
   assert.equal(code.includes('\u2028'),false,'U+2028 escaped');
   assert.equal(code.includes('\u2029'),false,'U+2029 escaped');
   const output=JSON.parse(code);
   assert.equal(output,input,'original string preserved after JSON decode');
  }
  assert.equal(literal('</script>'),'"\\u003c/script\\u003e"');
  assert.throws(()=>literal(undefined),/BROWSER_INPUT_INVALID/,'fail closed for missing string');
 });
}
