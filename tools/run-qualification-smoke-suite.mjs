import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'test/browser-helper-init-failure-run.mjs',
  'test/browser-path-encoding-run.mjs',
  'test/fs-safety.test.mjs',
  'test/gui-control-check.mjs',
  'test/linux-gui-contract.mjs',
  'test/windows-runtime-contract.mjs',
  'test/source-integrity.mjs'
];

for (const file of files) {
  const result = spawnSync(process.execPath, [file], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    windowsHide: true
  });
  if (result.error) {
    process.stderr.write('QUALIFICATION_SMOKE_LAUNCH_FAILED '+file+' '+String(result.error.code || result.error.message)+'\n');
    process.exit(1);
  }
  if (result.signal || result.status !== 0) {
    process.stderr.write('QUALIFICATION_SMOKE_FAILED '+file+' exit='+String(result.status)+' signal='+String(result.signal)+'\n');
    process.exit(Number.isInteger(result.status) && result.status > 0 ? result.status : 1);
  }
}
process.stdout.write('QUALIFICATION_SMOKE_SUITE_PASS '+files.length+'\n');
