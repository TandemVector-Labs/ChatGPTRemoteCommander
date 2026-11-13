import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mergeExplicitOwnerRunnerPolicy } from '../src/project-runner-config.mjs';
import { mergeExplicitOwnerGuiPolicy } from '../src/owner-gui-policy.mjs';

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i], value = argv[++i];
    if (value === undefined) throw new Error('PRIMARY_POLICY_MERGE_ARGUMENT');
    if (key === '--active') out.active = value;
    else if (key === '--local') out.local = value;
    else if (key === '--output') out.output = value;
    else throw new Error('PRIMARY_POLICY_MERGE_ARGUMENT');
  }
  for (const key of ['active','local','output']) if (!out[key]) throw new Error('PRIMARY_POLICY_MERGE_REQUIRED_' + key.toUpperCase());
  return out;
}
function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp-' + process.pid + '-' + Date.now().toString(36);
  fs.writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}
const args = parse(process.argv.slice(2));
const active = JSON.parse(fs.readFileSync(args.active, 'utf8'));
const local = JSON.parse(fs.readFileSync(args.local, 'utf8'));
const result = mergeExplicitOwnerRunnerPolicy(active, local);
const ownerGui = mergeExplicitOwnerGuiPolicy(result.config, local);
const outputText = JSON.stringify(ownerGui.config, null, 2) + '\n';
atomicWrite(args.output, outputText);
console.log(JSON.stringify({
  ok: true,
  merged: result.merged || ownerGui.merged,
  status: ownerGui.merged ? 'EXPLICIT_OWNER_GUI_POLICY' : result.status,
  output: path.resolve(args.output),
  configSha256: createHash('sha256').update(outputText).digest('hex')
}));
