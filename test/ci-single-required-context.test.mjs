import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const text=fs.readFileSync(path.join(root,'.github/workflows/ci.yml'),'utf8').replace(/\r\n/g,'\n');

test('one required CI job per feature PR while retaining canonical main and tag push coverage',()=>{
 const start=text.indexOf('\non:\n');
 const end=text.indexOf('\npermissions:\n',start);
 assert.ok(start>=0&&end>start,'CI trigger and permission boundaries must exist');
 const events=text.slice(start+1,end);
 assert.match(events,/^on:\n  push:\n    branches: \[main\]\n    tags: \['\*\*'\]\n  pull_request:\n/m);
 assert.doesNotMatch(events,/pull_request_target:/,'no elevated untrusted-PR trigger');
 assert.doesNotMatch(events,/workflow_run:/,'avoid indirect event duplication');
 assert.ok(!events.includes('branches-ignore:'),'do not smuggle a hidden PR scope exemption');
});

test('required Windows and Ubuntu check identities, pinned actions and read-only token remain unchanged',()=>{
 assert.match(text,/permissions:\n  contents: read/);
 assert.match(text,/jobs:\n  test:\n/);
 assert.match(text,/os: \[windows-latest, ubuntu-latest\]/);
 assert.match(text,/runs-on: \$\{\{ matrix\.os \}\}/);
 assert.match(text,/actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
 assert.match(text,/actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
 assert.match(text,/node tools\/run-bounded-test-script\.mjs --script test --concurrency 1 --prioritize-sensitive 1/);
 assert.match(text,/npm run audit/);
});
