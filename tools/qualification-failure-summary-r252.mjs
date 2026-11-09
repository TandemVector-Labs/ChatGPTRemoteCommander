#!/usr/bin/env node
// CI-only, bounded, verified diagnostic. Never echo raw logs or arbitrary paths.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const codePattern = /^[A-Z][A-Z0-9_]{3,95}$/;
const redact=/token|secret|password|bearer|api.?key|private|credential/i;
const safeName=value=>{
  const result=String(value).replace(/[^A-Za-z0-9 .():_/-]/g,'?').slice(0,96);
  return redact.test(result)?'[REDACTED]':result;
};
function run(filename, digest) {
  if(typeof filename!=='string'||!path.isAbsolute(filename)
    || !/^qualification-output-qualification-test-[A-Za-z0-9-]+\.stdout\.log$/i.test(path.basename(filename))
    || !/^[A-Fa-f0-9]{64}$/.test(digest||''))throw Error('INVALID_INPUT');
  const meta=fs.lstatSync(filename);
  if(!meta.isFile()||meta.isSymbolicLink()||meta.size<1||meta.size>2097152)throw Error('INVALID_FILE');
  const bytes=fs.readFileSync(filename);
  if(crypto.createHash('sha256').update(bytes).digest('hex').toLowerCase()!==digest.toLowerCase())
    throw Error('HASH_MISMATCH');
  const lines=bytes.toString('utf8').replace(/\x1b\[[0-9;]*m/g,'').split(/\r?\n/);
  const failed=[],tokens=[],subtests=[],counts=[];
  let lastPhaseStarted=null,lastPhasePassed=null;
  for(const line of lines){
    let match;
    if((match=line.match(/^RC_QUAL_PHASE_(START|PASS)_([0-9]{2})$/))){
      if(match[1]==='START')lastPhaseStarted=match[2];
      else lastPhasePassed=match[2];
    }
    if((match=line.match(/^\s*not ok \d+ - (.+)$/))&&failed.length<8)failed.push(safeName(match[1]));
    if((match=line.match(/^\s*# Subtest: (.+)$/))&&subtests.length<8000)subtests.push(safeName(match[1]));
    if((match=line.match(/^\s*# (tests|pass|fail|cancelled|skipped) (\d+)\s*$/)))counts.push([match[1],match[2]]);
    if((match=line.match(/^([A-Z][A-Z0-9_]{3,95})(?=[:\s]|$)/))
      &&/(?:FAIL|ERROR|BLOCK|TIMEOUT)/.test(match[1])&&codePattern.test(match[1]))
      tokens.push(match[1]);
  }
  const lastSubtests=subtests.slice(-3);
  console.log('R252_DIAG_HASH_PASS bytes='+meta.size+' lines='+lines.length);
  if(lastPhaseStarted!==null)console.log('R252_LAST_PHASE_STARTED='+lastPhaseStarted);
  if(lastPhasePassed!==null)console.log('R252_LAST_PHASE_PASSED='+lastPhasePassed);
  if(lastPhaseStarted!==null&&lastPhaseStarted!==lastPhasePassed)
    console.log('R252_UNFINISHED_PHASE='+lastPhaseStarted);
  for(const [key,value] of counts.slice(-5))console.log('R252_TAP_'+key.toUpperCase()+'='+value);
  for(const n of failed)console.log('R252_FAILED_TEST='+n);
  for(const n of lastSubtests)console.log('R252_LAST_SUBTEST='+n);
  for(const n of [...new Set(tokens)].slice(-8))console.log('R252_FAILURE_TOKEN='+n);
  if(!failed.length&&!tokens.length)console.log('R252_NO_TYPED_FAILURE markers=0');
}
try {run(process.argv[2],process.argv[3]);}
catch {console.error('R252_DIAG_FAIL_CLOSED');process.exitCode=3;}
