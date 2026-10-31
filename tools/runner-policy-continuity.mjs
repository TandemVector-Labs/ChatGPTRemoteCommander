#!/usr/bin/env node
// A bounded, read-only upgrade check for an owner's explicitly configured runner.
// Never report the provider command, credentials, paths, or raw config contents.
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

function readConfig(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw Error('INVALID_PATH');
  const st = fs.lstatSync(filename);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size < 2 || st.size > 2 * 1024 * 1024) throw Error('INVALID_FILE');
  const doc = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw Error('INVALID_CONFIG');
  return doc;
}

function check() {
  if (process.argv.length !== 4) throw Error('INVALID_ARGS');
  const current = readConfig(process.argv[2]).durableWorkflows?.runner;
  const candidate = readConfig(process.argv[3]).durableWorkflows?.runner;
  if (current?.enabled === true) {
    if (candidate?.enabled !== true) throw Error('RUNNER_DISABLED');
    if (!isDeepStrictEqual(current, candidate)) throw Error('RUNNER_POLICY_CHANGED');
  } else if (candidate?.enabled === true) {
    throw Error('RUNNER_ACTIVATED_WITHOUT_EXISTING_AUTHORITY');
  }
  process.stdout.write('RUNNER_CONTINUITY_PASS\n');
}
try { check(); } catch (error) {
  const codes = new Set(['INVALID_PATH','INVALID_FILE','INVALID_CONFIG','INVALID_ARGS',
    'RUNNER_DISABLED','RUNNER_POLICY_CHANGED','RUNNER_ACTIVATED_WITHOUT_EXISTING_AUTHORITY']);
  const code = codes.has(error?.message) ? error.message : 'UNVERIFIED_CONFIG';
  process.stderr.write('RUNNER_CONTINUITY_BLOCK ' + code + '\n');
  process.exitCode = 3;
}
