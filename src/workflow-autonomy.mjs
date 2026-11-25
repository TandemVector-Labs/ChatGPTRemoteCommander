import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const AUTONOMY_REVISION = 'durable-workflows-r2';
export const AUTONOMY_SCHEMA = 2;
export const LIFECYCLE = Object.freeze([
  'CREATED','RUNNING','WAITING','INTERRUPTED','RESUMING','BLOCKED',
  'VALIDATING','FINALIZING','COMPLETED','FAILED','CANCELLED'
]);
export const OPERATION_CLASS = Object.freeze([
  'READ_ONLY','IDEMPOTENT_MUTATION','NON_IDEMPOTENT_MUTATION','DESTRUCTIVE','EXTERNAL_SIDE_EFFECT'
]);

const READ_ONLY = new Set([
  'system_status','list_directory','read_text','power_status','file_info','read_file',
  'search_files','system_info','list_processes','workflow_run_status',
  'gui_status','gui_screenshot','gui_list_windows','gui_cursor_position'
]);
const EXTERNAL = new Set([
  'gui_session_begin','gui_session_renew','gui_session_end','gui_mouse_move','gui_mouse_delta',
  'gui_mouse_scroll','gui_mouse_click','gui_mouse_drag','gui_type_text','gui_key_press','gui_focus_window',
  'run_project_command','run_shell'
]);

export function canonicalHash(value) {
  const stable = v => {
    if (v === null || typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    const keys = Object.keys(v ?? {}).sort();
    return '{' + keys.map(k => JSON.stringify(k)+':'+stable(v[k])).join(',') + '}';
  };
  return createHash('sha256').update(stable(value)).digest('hex');
}

export function normalizeExecutionProfile(profile = {}) {
  const string = (v, max=128) => typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
  return {
    schemaVersion: 1,
    modelFamily: string(profile.modelFamily),
    modelVariant: string(profile.modelVariant),
    reasoningEffort: string(profile.reasoningEffort, 32),
    executionMode: string(profile.executionMode, 64) ?? 'project-agent',
    profileVersion: string(profile.profileVersion, 64) ?? '1',
    fallbackPolicy: ['equivalent-or-better','exact-only','allow-any'].includes(profile.fallbackPolicy)
      ? profile.fallbackPolicy : 'equivalent-or-better'
  };
}

export function normalizeSchedulerPolicy(policy = {}) {
  const n = Number(policy.maxConcurrentProjects);
  const retries = Number(policy.retryBudget);
  return {
    enabled: policy.enabled === true,
    resumeInterrupted: policy.enabled === true && policy.resumeInterrupted !== false,
    resumeAfterRestart: policy.enabled === true && policy.resumeAfterRestart !== false,
    resumeAfterUpdate: policy.enabled === true && policy.resumeAfterUpdate !== false,
    oneWriterPerRoot: policy.oneWriterPerRoot !== false,
    maxConcurrentProjects: Number.isSafeInteger(n) && n > 0 && n <= 32 ? n : 1,
    leaseMs: Number.isSafeInteger(Number(policy.leaseMs)) && Number(policy.leaseMs) >= 5000 ? Number(policy.leaseMs) : 30000,
    intervalMs: Number.isSafeInteger(Number(policy.intervalMs)) && Number(policy.intervalMs) >= 1000 ? Number(policy.intervalMs) : 5000,
    retryBudget: Number.isSafeInteger(retries) && retries >= 0 && retries <= 20 ? retries : 3
  };
}

// FULL_ACCESS is a separate Host/owner-grant contract and is not admitted here.
const unsupportedAuthorityTier=authority=>
  authority?.tier!==undefined&&!['STANDARD','FULL_POWER'].includes(authority.tier);

export function normalizeAuthority(authority = {}) {
  if(unsupportedAuthorityTier(authority))
    throw Object.assign(new Error('WORKFLOW_AUTHORITY_TIER_UNSUPPORTED'),
      {workflowCode:'WORKFLOW_AUTHORITY_TIER_UNSUPPORTED'});
  return {
    profileId: typeof authority.profileId === 'string' && authority.profileId ? authority.profileId : 'default',
    tier: authority.tier === 'FULL_POWER' ? 'FULL_POWER' : 'STANDARD',
    capabilities: Array.isArray(authority.capabilities)
      ? [...new Set(authority.capabilities.filter(x => typeof x === 'string' && x.length <= 128))].sort() : []
  };
}

export function authorityCompatible(expected, actual) {
  if(unsupportedAuthorityTier(expected)||unsupportedAuthorityTier(actual))
    return {ok:false,code:'WORKFLOW_AUTHORITY_TIER_UNSUPPORTED',missing:[]};
  const e = normalizeAuthority(expected), a = normalizeAuthority(actual);
  if (e.profileId !== a.profileId) return { ok:false, code:'WORKFLOW_AUTHORITY_PROFILE_CHANGED', missing:[] };
  const have = new Set(a.capabilities);
  const missing = e.capabilities.filter(x => !have.has(x));
  if (missing.length) return { ok:false, code:'WORKFLOW_AUTHORITY_REGRESSION', missing };
  if (e.tier !== a.tier) return {ok:false,code:'WORKFLOW_AUTHORITY_TIER_CHANGED',missing:[]};
  return {ok:true,code:'OK',missing:[]};
}

export function classifyTool(tool, args = {}) {
  // read_terminal consumes its output cursor by default; only an explicit
  // non-consuming observation can be safely retried after uncertain delivery.
  if (tool === 'read_terminal') return args.consume === false ? 'READ_ONLY' : 'NON_IDEMPOTENT_MUTATION';
  if (READ_ONLY.has(tool)) return 'READ_ONLY';
  if (tool === 'write_text') return args.mode === 'append' ? 'NON_IDEMPOTENT_MUTATION' : 'IDEMPOTENT_MUTATION';
  if (tool === 'write_file') return args.mode === 'append' ? 'NON_IDEMPOTENT_MUTATION' : 'IDEMPOTENT_MUTATION';
  if (tool === 'create_directory') return 'IDEMPOTENT_MUTATION';
  // Match complete snake_case action tokens, not substrings such as "skill".
  if (/(?:^|_)(?:delete|remove|kill|terminate)(?:_|$)/i.test(tool)) return 'DESTRUCTIVE';
  if (EXTERNAL.has(tool)) return 'EXTERNAL_SIDE_EFFECT';
  return 'NON_IDEMPOTENT_MUTATION';
}

export function reconciliationPlan(tool, args = {}) {
  const classification = classifyTool(tool,args);
  if (classification === 'READ_ONLY') return { strategy:'SAFE_RETRY', classification };
  if (tool === 'write_text' && args.mode !== 'append' && typeof args.content === 'string' && typeof args.path === 'string') {
    return {
      strategy:'FILE_SHA256',
      classification,
      path:args.path,
      expectedSha256:createHash('sha256').update(args.content,'utf8').digest('hex')
    };
  }
  if (tool === 'create_directory' && typeof args.path === 'string') {
    return { strategy:'DIRECTORY_EXISTS', classification, path:args.path };
  }
  return { strategy:'MANUAL_OR_REMOTE_STATE', classification };
}

export function normalizeWorkflowState(state, { authority, executionProfile, schedulerPolicy } = {}) {
  const next = state;
  next.schema ??= 1;
  next.lifecycleState ??= 'CREATED';
  next.executionProfile ??= normalizeExecutionProfile(executionProfile);
  next.authority ??= normalizeAuthority(authority);
  next.scheduler ??= {};
  next.scheduler.enabled ??= schedulerPolicy?.enabled === true;
  next.scheduler.automaticContinuation ??= schedulerPolicy?.enabled === true;
  next.scheduler.retryBudget ??= schedulerPolicy?.retryBudget ?? 3;
  next.scheduler.repeatedFailureCount ??= 0;
  next.scheduler.lastFailureCode ??= null;
  next.scheduler.lastRootCauseCode ??= null;
  next.scheduler.nextRunAt ??= null;
  next.finalization ??= { status:'UNVALIDATED', validatedAt:null, evidence:[] };
  next.brain ??= { markdownPath:'PROJECT_BRAIN.md', jsonPath:'project-brain.json', lastSyncedRevision:null, lastSyncSha256:null };
  return next;
}

export function safeRelative(value, fallback) {
  const v = typeof value === 'string' && value ? value : fallback;
  if (path.isAbsolute(v) || /^[A-Za-z]:|^\\\\/.test(v) || v.split(/[\\/]/).includes('..')) throw new Error('WORKFLOW_BRAIN_PATH_INVALID');
  return v;
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp=file+'.tmp-'+process.pid+'-'+Date.now().toString(36);
  fs.writeFileSync(tmp,text,{encoding:'utf8',mode:0o600});
  fs.renameSync(tmp,file);
}

export function renderBrain(state) {
  const completed = state.steps.filter(s => ['recorded','reconciled_applied','verified'].includes(s.status)).map(s=>s.id);
  const open = state.steps.filter(s => !completed.includes(s.id)).map(s=>({id:s.id,status:s.status,title:s.title}));
  const chatHandoffs = state.notes.filter(n=>n.kind==='handoff');
  const data = {
    schemaVersion:1,
    workflowId:state.id,
    project:state.root,
    finalObjective:state.goal,
    definitionOfDone:state.acceptance,
    lifecycleState:state.lifecycleState,
    currentPhase:state.checkpoint?.summary ?? null,
    completed,
    open,
    blockers:state.scheduler?.lastFailureCode ? [state.scheduler.lastFailureCode] : [],
    authoritative:{root:state.root,device:state.device,authority:state.authority},
    importantDecisions:state.notes.filter(n=>n.kind==='decision'),
    failures:state.notes.filter(n=>n.kind==='failure'),
    chatHandoffs,
    pendingChatHandoff:state.pendingChatHandoff ?? null,
    lastChatHandoff:state.lastChatHandoff ?? null,
    evidence:state.checkpoint?.evidence ?? [],
    currentBaseline:{configSha256:state.configSha256,executionProfile:state.executionProfile},
    exactNextAction:state.checkpoint?.nextAction ?? null,
    finalization:state.finalization,
    revision:state.revision,
    updatedAt:state.updatedAt
  };
  const md = [
    '# Project Brain',
    '',
    'Generated by ChatGPT Remote Commander durable workflow engine.',
    '',
    '## Current Authority',
    '- Workflow: '+state.id,
    '- Lifecycle: '+state.lifecycleState,
    '- Revision: '+state.revision,
    '- Device: '+state.device,
    '',
    '## Final Objective',
    state.goal,
    '',
    '## Definition of Done',
    ...state.acceptance.map(x=>'- '+x),
    '',
    '## Completed',
    ...(completed.length?completed.map(x=>'- '+x):['- None']),
    '',
    '## Open',
    ...(open.length?open.map(x=>'- '+x.id+' ['+x.status+'] — '+x.title):['- None']),
    '',
    '## Evidence',
    ...((state.checkpoint?.evidence?.length??0)?state.checkpoint.evidence.map(x=>'- '+x.path+' sha256='+x.sha256):['- None']),
    '',
    '## Chat Handoffs',
    ...(chatHandoffs.length?chatHandoffs.slice(-20).map(x=>'- ['+(x.verification??'UNVERIFIED')+'] '+x.text):['- None']),
    ...(state.pendingChatHandoff?['- Pending event: '+state.pendingChatHandoff.eventKey+' — '+state.pendingChatHandoff.summary]:[]),
    '',
    '## Exact Next Action',
    state.checkpoint?.nextAction ?? 'None',
    '',
    '## Execution Profile',
    JSON.stringify(state.executionProfile,null,2),
    '',
    '## Finalization',
    '- Status: '+(state.finalization?.status ?? 'UNVALIDATED'),
    ''
  ].join('\n');
  return { data, markdown:md };
}

export function syncProjectBrain(state) {
  const root = path.resolve(state.root);
  const markdownRel = safeRelative(state.brain?.markdownPath,'PROJECT_BRAIN.md');
  const jsonRel = safeRelative(state.brain?.jsonPath,'project-brain.'+state.id+'.json');
  const markdownPath = path.resolve(root,markdownRel), jsonPath=path.resolve(root,jsonRel);
  for (const p of [markdownPath,jsonPath]) {
    const rel=path.relative(root,p);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('WORKFLOW_BRAIN_PATH_INVALID');
    if (fs.existsSync(p)) {
      const stat=fs.lstatSync(p);
      if (stat.isSymbolicLink() || stat.nlink > 1) throw new Error('WORKFLOW_BRAIN_FILE_ALIAS');
    }
  }
  const rendered=renderBrain(state);
  const json=JSON.stringify(rendered.data,null,2)+'\n';
  const begin='<!-- RC_WORKFLOW_STATE:'+state.id+':BEGIN -->';
  const end='<!-- RC_WORKFLOW_STATE:'+state.id+':END -->';
  const block=begin+'\n'+rendered.markdown.trim()+'\n'+end+'\n';
  let markdown=block;
  if (fs.existsSync(markdownPath)) {
    const current=fs.readFileSync(markdownPath,'utf8');
    const a=current.indexOf(begin), b=current.indexOf(end);
    if (a >= 0 && b >= a) markdown=current.slice(0,a)+block+current.slice(b+end.length).replace(/^\r?\n/,'');
    else markdown=current.replace(/\s*$/,'')+'\n\n'+block;
  }
  atomicWrite(jsonPath,json);
  atomicWrite(markdownPath,markdown);
  return {
    markdownPath:markdownRel,
    jsonPath:jsonRel,
    jsonSha256:createHash('sha256').update(json).digest('hex'),
    markdownSha256:createHash('sha256').update(markdown).digest('hex')
  };
}
