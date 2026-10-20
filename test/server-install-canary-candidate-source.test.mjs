import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/server-install-canary.yml', import.meta.url), 'utf8');
const win = await readFile(new URL('../server-install-windows.ps1', import.meta.url), 'utf8');
const linux = await readFile(new URL('../server-install-linux.sh', import.meta.url), 'utf8');

test('candidate-only source rewrite is conditioned on the trusted organization repository', () => {
  assert.match(workflow, /RC_CANDIDATE_REWRITE_COUNT:.*github\.repository == 'TandemVector-Labs\/ChatGPTRemoteCommander'/);
  assert.match(workflow, /head\.repo\.full_name == github\.repository/);
  assert.match(workflow, /RC_EXPECTED_COMMIT:.*github\.event\.pull_request\.head\.sha/);
  assert.match(workflow, /RC_SOURCE_REF:.*github\.event\.pull_request\.head\.ref/);
});

test('Windows Git installer child sees the process-only source rewrite', () => {
  assert.match(workflow, /GIT_CONFIG_COUNT: \$\{\{ env\.RC_CANDIDATE_REWRITE_COUNT \}\}/);
  assert.match(workflow, /GIT_CONFIG_KEY_0: url\.https:\/\/github\.com\/TandemVector-Labs\/ChatGPTRemoteCommander\.git\.insteadOf/);
  assert.match(workflow, /GIT_CONFIG_VALUE_0: https:\/\/github\.com\/GOD13emad\/ChatGPTRemoteCommander\.git/);
  assert.match(workflow, /-ExpectedCommit \$env:RC_EXPECTED_COMMIT/);
});

test('Linux Docker installs exact candidate using process-only Git redirect', () => {
  for (const fragment of [
    '-e GIT_CONFIG_COUNT="$RC_CANDIDATE_REWRITE_COUNT"',
    '-e GIT_CONFIG_KEY_0="url.https://github.com/TandemVector-Labs/ChatGPTRemoteCommander.git.insteadOf"',
    '-e GIT_CONFIG_VALUE_0="https://github.com/GOD13emad/ChatGPTRemoteCommander.git"',
    '--expected-commit "$RC_EXPECTED_COMMIT"',
  ]) assert.ok(workflow.includes(fragment), 'Missing canary-only contract: ' + fragment);
});

test('upstream production installers stay unchanged, with no implicit fork override', () => {
  assert.match(linux, /REMOTE_COMMANDER_REPO_URL:-https:\/\/github\.com\/GOD13emad\/ChatGPTRemoteCommander\.git/);
  assert.match(win, /\$Repo = 'https:\/\/github\.com\/GOD13emad\/ChatGPTRemoteCommander\.git'/);
  assert.doesNotMatch(win, /GIT_CONFIG_COUNT|TandemVector-Labs\/ChatGPTRemoteCommander/);
});
