/**
 * V1-01 private installed DENIAL preflight.
 *
 * A legacy behavior harness can return success for historically expected but
 * insecure HTTP 200 responses. Re-run its real, disposable on-host installation
 * and assess the output independently. Neither result proves G1 authorization.
 *
 * Never touches an installed user profile, Router, tunnel, or OS grant.
 */
import {createHash} from 'node:crypto';
import {createReadStream, lstatSync, realpathSync, copyFileSync, chmodSync, mkdtempSync, rmSync, constants} from 'node:fs';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {assessInstalledDenial} from './installed-negative-admission-gate.mjs';

export const PINNED_HARNESS_SHA256 =
  '8f34fe4368cd86d332d3d49790a3f6558d45e69d264b4a222ac95f5bdc4029b3';
export const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
export const MAX_HARNESS_BYTES = 64 * 1024;
export const MAX_RECEIPT_BYTES = 64 * 1024;
const HEX = /^[0-9a-f]{64}$/;
const BASE = Object.freeze({
  gate: 'V101_INSTALLED_NEGATIVE_ADMISSION',
  authenticatedCallerProved: false,
  nativeOwnerGrantProved: false,
  signedChatIdentityProved: false,
  rollbackProved: false,
  productionReleaseAuthorized: false
});

export class EvidenceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'EvidenceError';
    this.code = code;
  }
}

export function parseArgs(args) {
  if (!Array.isArray(args) || args.length < 2 || args.length > 4)
    throw new EvidenceError('ARGUMENT_SCOPE_INVALID');
  const out = {};
  for (const raw of args) {
    if (typeof raw !== 'string') throw new EvidenceError('ARGUMENT_TYPE_INVALID');
    const index = raw.indexOf('=');
    const key = index > 0 ? raw.slice(0, index) : '';
    const value = index > 0 ? raw.slice(index + 1) : '';
    if (!['--installer', '--sha256', '--harness', '--python'].includes(key)
      || !value || Object.hasOwn(out, key))
      throw new EvidenceError('ARGUMENT_SCOPE_INVALID');
    out[key] = value;
  }
  if (!out['--installer'] || !HEX.test(out['--sha256'] || ''))
    throw new EvidenceError('INSTALLER_PIN_REQUIRED');
  if (out['--python'] && !['python', 'python3'].includes(out['--python']))
    throw new EvidenceError('PYTHON_COMMAND_INVALID');
  return {
    installer: path.resolve(out['--installer']),
    expectedSha256: out['--sha256'],
    harness: out['--harness'] ? path.resolve(out['--harness'])
      : path.resolve(path.dirname(fileURLToPath(import.meta.url)),
        '..', 'v1-01', 'test-installed-ingress-10.py'),
    python: out['--python'] || (process.platform === 'win32' ? 'python' : 'python3')
  };
}

export function privateHarnessEnvironment(source = process.env) {
  // Pass only noncredential environment needed by Python and the disposable
  // installer. Never inherit caller-specific OAuth, signing or connector tokens.
  const keys = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec',
    'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'USER', 'LOGNAME',
    'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA',
    'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
    'LANG', 'LC_ALL', 'LC_CTYPE'
  ];
  const out = {};
  for (const key of keys) {
    if (typeof source[key] === 'string' && source[key].length > 0)
      out[key] = source[key];
  }
  out.PYTHONUTF8 = '1';
  return out;
}

export async function validatePinnedRegularFile(file, expectedSha256, limit) {
  if (!HEX.test(expectedSha256) || !Number.isSafeInteger(limit) || limit < 1)
    throw new EvidenceError('PIN_POLICY_INVALID');
  let info;
  try { info = lstatSync(file); }
  catch { throw new EvidenceError('PINNED_FILE_MISSING'); }
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > limit)
    throw new EvidenceError('PINNED_FILE_TYPE_OR_SIZE_INVALID');
  // Reject aliases to avoid silently testing a different supplied artifact.
  if (path.normalize(realpathSync.native(file)).toLowerCase()
      !== path.normalize(path.resolve(file)).toLowerCase())
    throw new EvidenceError('PINNED_FILE_ALIAS_INVALID');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  if (digest.digest('hex') !== expectedSha256)
    throw new EvidenceError('PINNED_FILE_HASH_MISMATCH');
  const after = lstatSync(file);
  if (info.size !== after.size || info.mtimeMs !== after.mtimeMs ||
      info.ino !== after.ino || info.dev !== after.dev)
    throw new EvidenceError('PINNED_FILE_CHANGED_DURING_HASH');
  return true;
}

/**
 * Stage an immutable-by-convention owner-local copy, never chmod or execute
 * the package in its source release archive. Linux .run packages can ship
 * as nonexecutable; the verified copy gets the owner-only executable bit.
 */
export async function stagePinnedInstaller(installer, expectedSha256) {
  await validatePinnedRegularFile(installer, expectedSha256, MAX_PACKAGE_BYTES);
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'rc-v101-installed-denial-'));
  const staged = path.join(scratch, 'pinned-installer' + path.extname(installer));
  try {
    copyFileSync(installer, staged, constants.COPYFILE_EXCL);
    chmodSync(staged, 0o700);
    await validatePinnedRegularFile(staged, expectedSha256, MAX_PACKAGE_BYTES);
    return {
      path: staged,
      cleanup() { rmSync(scratch, {recursive:true, force:true}); }
    };
  } catch (error) {
    rmSync(scratch, {recursive:true, force:true});
    throw error;
  }
}

export function evaluateHarnessResult({stdout, exitCode, packageSha256}) {
  if (!HEX.test(packageSha256 || '')) throw new EvidenceError('INSTALLER_PIN_REQUIRED');
  if (!Number.isInteger(exitCode) || exitCode !== 0)
    return {...BASE, status:'BLOCKED', code:'HARNESS_EXECUTION_FAILED',
      denialCasesProved:0, requiredCases:10};
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_RECEIPT_BYTES
    || stdout.trim().split(/\r?\n/).length !== 1)
    return {...BASE, status:'BLOCKED', code:'HARNESS_RECEIPT_MALFORMED',
      denialCasesProved:0, requiredCases:10};
  let receipt;
  try { receipt = JSON.parse(stdout.trim()); }
  catch { return {...BASE, status:'BLOCKED', code:'HARNESS_RECEIPT_MALFORMED',
    denialCasesProved:0, requiredCases:10}; }
  // Even a harness exitCode=0 is not security acceptance.
  const verdict = assessInstalledDenial(receipt, packageSha256);
  return {...verdict, harnessBehaviorExitCode:exitCode};
}

export async function runInstalledDenialPreflight(options) {
  const {expectedSha256, python} = options;
  // Enforce the interpreter allowlist at the execution boundary as well as
  // the CLI parser. Programmatic callers must not select an arbitrary program.
  if (python !== 'python' && python !== 'python3')
    throw new EvidenceError('PYTHON_COMMAND_INVALID');
  const installer = path.resolve(options.installer);
  const harness = path.resolve(options.harness);
  await validatePinnedRegularFile(installer, expectedSha256, MAX_PACKAGE_BYTES);
  await validatePinnedRegularFile(harness, PINNED_HARNESS_SHA256, MAX_HARNESS_BYTES);
  const stage = await stagePinnedInstaller(installer, expectedSha256);
  try {
    const args = [harness, '--installer', stage.path, '--sha256', expectedSha256];
    const spawnOptions = {encoding:'utf8', cwd:path.dirname(harness),
      env:privateHarnessEnvironment(), windowsHide:true, shell:false,
      timeout:240000, maxBuffer:MAX_RECEIPT_BYTES + 8192,
      stdio:['ignore', 'pipe', 'pipe']};
    const result = python === 'python'
      ? spawnSync('python', args, spawnOptions)
      : spawnSync('python3', args, spawnOptions);
    if (result.error || result.signal)
      return {...BASE,status:'BLOCKED',code:'HARNESS_EXECUTION_FAILED',
        denialCasesProved:0,requiredCases:10};
    return evaluateHarnessResult({stdout:result.stdout, exitCode:result.status,
      packageSha256:expectedSha256});
  } finally {
    stage.cleanup();
  }
}

export async function main(args = process.argv.slice(2)) {
  let report;
  try {
    report = await runInstalledDenialPreflight(parseArgs(args));
  } catch (error) {
    report = {...BASE, status:'BLOCKED',
      code:error instanceof EvidenceError ? error.code : 'PREFLIGHT_INTERNAL_ERROR',
      denialCasesProved:0, requiredCases:10};
    process.stdout.write(JSON.stringify(report) + '\n');
    return 2;
  }
  process.stdout.write(JSON.stringify(report) + '\n');
  return report.status === 'NEGATIVE_PREFLIGHT_PASS' ? 0 : 3;
}

if (process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
