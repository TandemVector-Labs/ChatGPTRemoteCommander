import { spawnSync } from 'node:child_process';
// Behavioral tests replace the previous name/string-presence-only GUI gate.
// Native Windows validation is a separate explicit test; no fake native PASS.
const run=spawnSync(process.execPath,['--test','test/gui-safety.test.mjs','test/http-admission.test.mjs','test/gui-windows-mutex-j01-r536.test.mjs'],{stdio:'inherit',timeout:30000});
if(run.error || run.status!==0) throw new Error('GUI_BEHAVIOR_TEST_FAILED');
console.log('GUI_CONTROL_CHECK_PASS scope=contract,coordination,helper-process,http-with-stubs native=SEPARATE_WINDOWS_GATE');
