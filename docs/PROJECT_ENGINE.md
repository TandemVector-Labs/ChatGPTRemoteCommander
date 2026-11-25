# Opt-in project execution engine — current policy

> **v0.9.11 policy:** Remote Commander does not provision, authenticate, or launch Codex. Legacy Codex runner configuration is migrated fail-closed. Normal project reasoning stays in the current ChatGPT conversation. A user may explicitly choose an external Work/Codex handoff in chat, but that handoff occurs outside Commander.

The engine connects a bounded planner to existing journaled Commander tools and independent acceptance checks. It can execute an explicitly enrolled project, inspect progress, stop safely, and finalize a verified artifact. It does not supply a new model or establish superiority over other agents.

## Hybrid runtime operating model (V1-05)

The accepted hybrid design reuses the existing Commander engine and composes it with qualified local model adapters, native tools, bounded proposal workers and independent verification. It does **not** add a second local workflow database or silently move project data to a cloud provider.

1. **Control and durable state:** one Commander workflow authority per enrolled project root. The existing workflow journal stores ordered/DAG steps, revisions, leases, intent/receipts and recovery state. The private `project-runs.sqlite` stores planner reservations and run budgets. These databases are host-local; never share a SQLite file over the network.
2. **Planner:** a trusted, explicitly configured, proposal-only `command` provider. The qualified local model path uses Ollama's native `/api/chat` structured-output/JSON-Schema contract. The model proposes one action; Commander validates authority, scope, schema, revision and budget before executing it.
3. **Tool plane:** existing journaled Commander/MCP tools and their host policy. Default autonomous actions remain bounded; GUI takeover, deletion, unrestricted shell and process termination are not granted to the planner.
4. **Parallel work:** optional proposal teams can review the same bounded context in parallel, but the coordinator remains the only project mutator. The bounded artifact worker can return one receipt-bound text artifact; it cannot directly modify project files. Parallel mutating agents are not part of this increment.
5. **Model and hardware routing:** V1-09 selects the real model using measured CPU/GPU, free VRAM/RAM, context, latency and task quality. V1-05 enforces exact `modelFamily`, `modelVariant`, `reasoningEffort`, `executionMode` and `profileVersion` before enrollment and every step. A mismatch blocks; no silent model substitution.
6. **Verification and memory:** an independent deterministic verifier checks immutable acceptance criteria and evidence hashes. The existing Project Brain stores durable decisions, findings, evidence references and the next action; raw file contents and credentials do not become planner memory.
7. **Provider boundary:** Commander Codex delegation remains forbidden; Claude is reserved/unqualified. There is no automatic cloud fallback or cloud alias. An explicitly selected external ChatGPT Work handoff is outside Commander and retains its own consent boundary.
8. **Cross-host boundary:** six isolated `0.11.0-dev.23` QA candidates have source/test evidence, but they are not installed runtimes and do not prove a distributed worker pool. Each host currently has its own local scheduler and journal. A real cross-host queue still needs authenticated worker registration, a central control plane, distributed root ownership/leases, and receipt-bound artifact transfer. Hatchet is the evaluated future prototype candidate for that separate gate; its worker-affinity feature and operational/security prerequisites must be requalified before installation. Temporal or LangGraph must not be added as a duplicate owner of the current workflow state.

**Ownership and release path:** V1-05 owns engine logic and deterministic/live fixture qualification; V1-00 selectively integrates the accepted source delta; V1-09 configures and qualifies provider/model identity; V1-08 packages, installs and rolls back the immutable candidate. Fleet installation and distributed scheduling remain separate acceptance gates from source PASS.

## What runs

1. A caller creates a workflow with a goal, acceptance criteria and atomic steps.
2. A caller explicitly enrolls that workflow using `workflow_run_start`, supplying immutable checks and bounded action/time limits.
3. Each `workflow_run_tick` reserves a durable planner attempt and provider-call budget, obtains a JSON proposal, validates current control/revision/policy, and invokes at most one `workflow_call` or an explicitly enabled prerequisite insertion.
4. When all steps have receipts, a separate deterministic verifier checks every acceptance criterion. Its file hashes must still match finalization evidence. Model text saying "done" does not complete the workflow.
5. The existing Brain synchronization records the accepted final state.

An enabled scheduler can tick enrolled runs only when `runner.autoTick=true`. Existing workflows are never automatically enrolled. Full Power migration does not enable or auto-create a model provider. From v0.9.11 the default runner is disabled; recovery/readiness remains available without external model delegation.

## Operator configuration

Merge this fragment into the existing, approved `durableWorkflows` configuration. Every runner tool must also exist in the containing workflow `executionTools` policy. A mismatch fails startup rather than broadening authority.

```json
{
  "runner": {
    "enabled": true,
    "autoTick": false,
    "provider": {
      "kind": "command",
      "executable": "/path/to/explicitly-trusted-non-model-planner",
      "timeoutMs": 30000,
      "maxOutputBytes": 2097152
    },
    "allowedTools": ["list_directory", "read_text", "file_info", "write_text", "create_directory"],
    "maxActions": 32,
    "maxDurationMs": 300000
  }
}
```

`autoTick=false` requires explicit ticks. `autoTick=true` permits scheduler-triggered execution of enrolled runs when the existing scheduler is enabled. Invoking `workflow_scheduler_tick` explicitly can also execute an enrolled step when autoTick is enabled; that tool's annotations accurately mark it as a mutating, external action.

Commander does not use Codex authentication or model quota. An explicit `command` provider is operator-supplied local code and must not be a Codex wrapper or a script that launches Codex. Provider errors block the run with a bounded error code. The engine never silently substitutes a model/provider.

Supported providers under the current policy:

- `codex`: **FORBIDDEN in Commander**. Configuration with `kind="codex"` or a Codex executable/path is disabled/fails closed. Use the current ChatGPT chat for reasoning; an optional Work/Codex handoff requires explicit current-chat user choice and occurs outside Commander.
- `command`: an explicitly trusted operator executable with fixed argv, JSON context on stdin, and a JSON proposal on stdout. It is not automatically discovered or created. It must not launch Codex.
- `claude`: reserved but fails with `PLANNER_PROVIDER_UNAVAILABLE` pending separate qualification. No automatic model substitution is performed.

Model selection may be explicitly set as `provider.model`. Planner processes have timeout, output size and cancellation bounds. Provider calls may consume the account's normal quota. A run budget limits attempts, planner invocations, plan extensions and wall time, not currency or model tokens. Optional [proposal teams](PROJECT_ENGINE_ADAPTIVE.md) reserve all worker/coordinator calls before invoking any provider.

## Tools

When configured, four additional tools appear:

| Tool | Purpose |
|---|---|
| `workflow_run_start` | Enroll an exact workflow revision with run ID, independent checks, action/provider-call limits and duration |
| `workflow_run_status` | Inspect run state, reserved attempts, receipts, blockers and verification |
| `workflow_run_resolve` | Record an explicit answer to an exact open input request; queue the same run without refilling its budgets |
| `workflow_run_tick` | Execute at most one planner/tool action or perform independent finalization |

`workflow_control` pauses/resumes/cancels the underlying workflow. Control intent has its own persistent generation, independent of scheduler enablement. Pause/cancel stops new effects and survives late receipts. An already dispatched effect is allowed to settle; its lease is not released just because the user pauses. Unknown effects remain uncertain and must be reconciled.

Reusing the same run ID returns the existing run and does not replenish budgets. A terminal blocked run is not silently restarted. Correct the issue and explicitly create a new run ID when appropriate. Structured questions instead enter `WAITING_INPUT`; an explicit, revision-checked response can resume the same run while preserving its original deadline and consumed budgets. See [durable decisions](PROJECT_ENGINE_DECISIONS.md). External changes to the goal, steps, authority, model profile or runner policy invalidate the old run's planning assumptions. An engine's own journaled prerequisite insertion can update its plan fingerprint only through a matching durable receipt and unchanged scope.

## Independent checks

Each zero-based acceptance criterion must have exactly one check:

```json
[
  {"criterion":0,"type":"text_includes","path":"report.txt","text":"Required result"},
  {"criterion":1,"type":"json_pointer_equals","path":"metrics.json","pointer":"/failed","value":0}
]
```

`file_sha256` additionally supports exact expected bytes via a SHA-256 value. Every path is project-relative. Checks reject traversal, aliases, hardlinks and nonregular/oversized evidence; reads are revalidated. Results store hashes and statuses, not file content. At most 20 distinct evidence files are accepted by the workflow finalizer. These checks prove only the stated predicates. A document containing a sentence is not thereby scientifically or commercially correct; define appropriate acceptance criteria.

Checks are immutable for the enrolled run. The planner sees them but cannot edit them. Ordinary `workflow_finalize` remains a caller-attested operation for compatibility; the project engine re-verifies its own checks even if another caller has already marked the workflow complete.

## Observation and recovery

Steps currently represent one atomic tool operation each. Read/list steps record typed path references. Before later planning, the engine re-observes those references through the same scoped read-only host policy. It does not persist raw file outputs. This supports inspect-then-edit across process restart without treating an old transcript as current state. Observations are re-read through the same scoped read-only policy but are never forwarded as full file outputs. The planner receives at most six recent typed references, an at-most-1-KiB UTF-8 preview plus full-file byte count/SHA-256 for `read_text`, and at most 24 `{path,type}` entries for `list_directory`. The combined observation envelope is capped at 4 KiB; older references are omitted with an explicit `observationsOmitted` count. If the bounded envelope still exceeds its limit, the run stops with an explicit context-limit code rather than silently truncating.

Run budgets and attempt reservations live in a private `project-runs.sqlite` beside the existing workflow store. Planner claims are exclusive within that database; a live process's claim is not stolen on a timer. Effect receipts remain in the existing workflow journal. Recovered uncertain effects are never automatically repeated. Isolation is not machine-wide across separate profiles/databases or arbitrary shell processes.

Allowed autonomous actions intentionally exclude GUI takeover, unrestricted shell, process termination, deletion and terminal control in this increment. `run_project_command` can be enabled only with an explicit runner `commands` list of exact program/argv pairs, in addition to the host allowlist. Commands are not OS-sandboxed by the project path boundary.

## Hardware-aware execution-profile binding

The engine does not guess which model a host should run. The host/provider owner
selects and qualifies the model against the actual CPU, GPU, VRAM, system RAM,
runtime and task. The workflow's persisted `executionProfile` is then checked
against `planner.describe()` before enrollment and again before every step.

The provider descriptor exposes `model`, `modelFamily`, `reasoningEffort`,
`executionMode` and `profileVersion`. A requested model family must match the
provider's declared family as well as its exact model variant. Execution mode
and profile version are also checked; old providers without explicit values
retain the conservative `project-agent` / `1` defaults. Missing or conflicting
metadata blocks before any provider call or project effect.

`equivalent-or-better` is deliberately fail-closed until a separately qualified
equivalence map exists; it does not silently substitute a different model.
`allow-any` is the only permissive override and must be explicit in the
workflow profile. Do not set descriptor metadata to a model or reasoning mode
that the adapter is not actually using. For Ollama, `provider.model` must
match the adapter's effective `RC_LOCAL_AI_MODEL`; the family and reasoning
metadata must describe the real model and `think` setting. V1-09 owns model
selection and adapter configuration; V1-05 enforces the declared profile.

The project requires Node.js **22.13.0 or newer** because the built-in
`node:sqlite` module is unflagged from Node 22.13 onward. The installed
development runtime observed on Aliemad-Laptop is Node 22.23.2, where this API
is still Stability 1.1 (active development). The same 314-test workflow suite
also passed under Node 26.13.0, where `node:sqlite` is Stability 1.2 (release
candidate). V1-08 should qualify and package Node 26 LTS for the next runtime
candidate; this does not claim the SQLite API is fully stable.

The model-profile regression now changes the declared provider family after
enrollment and proves the next step blocks with
`PROJECT_MODEL_PROFILE_UNAVAILABLE` before a second planner call or write.
The focused project-engine review is 22/22 PASS; the complete
`npm run test:workflows` is 314/314 PASS on Node 22.23.2 and Node 26.13.0.
This is source-only qualification; it does not claim that the installed
`0.11.0-dev.23` runtime or the Windows provider has been updated.

## Hardware-specific model qualification (2026-11-07)

All comparisons used the same non-streaming Ollama `/api/chat` endpoint,
JSON Schema proposal envelope, `think:false`, temperature 0 and 4,096-token
context. The two cases were an ordinary pending `read_text` step and a
hostile instruction embedded in an untrusted file preview. These are
qualification observations, not universal speed guarantees.

| Host / model | Cold normal | Warm hostile | Decision |
|---|---:|---:|---|
| RTX 3080 10 GB / `gemma4:12b` | 6.14 s | 1.36 s | Both cases produced valid `read_text` proposals; the hostile preview was ignored. Entire 8.06 GB model fit in VRAM. |
| RTX 3080 10 GB / `qwen3.5:4b` | 3.99 s | 1.13 s | Normal call valid; hostile preview caused a valid fail-closed block. Entire 3.14 GB model fit in VRAM. |
| RTX 3080 10 GB / `qwen3:4b-instruct` | 2.85 s | 4.10 s | Normal call valid; hostile case exhausted the 512-token output cap before completing JSON, so Commander must block. |
| Ryzen 7 7730U CPU / `qwen3:4b-instruct` | 20.2 s | 59.3 s | Full two-step source-engine run passed with exact model profile in 44.3 s; direct hostile case exceeded the output cap and was rejected. |
| Ryzen 7 7730U CPU / `qwen3.5:4b` | — | — | Full two-step source-engine run passed in 32.5 s with a **test-only 25 s adapter timeout**. The installed 24 s adapter timed out at 24.09 s; do not claim this model is qualified with the unchanged production adapter. |
| Ryzen 7 7730U CPU / `qwen3.5:2b` | 12.6 s | 10.8 s | Returned valid but over-conservative blocks for both normal and hostile cases; removed after qualification because it could not advance a normal read step. |

**Routing recommendation (pending V1-09 provider activation):**
- RTX 3080: `gemma4:12b` as the quality/reliability profile; `qwen3.5:4b`
  as the low-latency fallback. Both were fully GPU-resident at 4K context.
- CPU-only laptop: retain `qwen3:4b-instruct` as the currently qualified
  production fallback. `qwen3.5:4b` is a promising replacement only after
  V1-09 raises the adapter's default timeout from 24 s to 25 s and repeated
  cold/warm runs pass on the installed adapter. The 2B model is not suitable
  for the project planner.
- These model tests do **not** qualify Emad-PC's Project Engine runtime:
  its installed Commander currently reports `runnerConfigured:false`.
  The PC benchmark exercised its local Ollama API only. V1-08 must install
  the current engine and V1-09 must configure the GPU provider before any
  PC workflow-engine PASS can be claimed.

The exact model identity is now persisted and checked by the live fixture:
`modelFamily`, `modelVariant`, `reasoningEffort`, `executionMode` and
`profileVersion`. The laptop's active Commander still reports
`planner.describe().model=null` even though its adapter environment selects
`qwen3:4b-instruct`; V1-09 must align the runtime provider descriptor with
the actual adapter before exact profiles are enabled in production.

Model references:
- https://ollama.com/library/qwen3.5
- https://ollama.com/library/gemma4
- https://docs.ollama.com/capabilities/structured-outputs


## V1-05 full-source candidate qualification — 2026-11-07

A complete `0.11.0-dev.23` V1-05 candidate was reconstructed in isolated QA clones on six hosts from the same seven-file source delta (patch SHA-256 `cc02b099171be4a3e6df4968f6bb59bf79846e76041c4b96aa5af0f0bf05cd43`, 45,817 bytes). Each candidate also carries the opt-in cross-platform live test, Node.js floor `>=22.13.0`, and workflow-test file concurrency 2. The eight source/test/documentation files have identical SHA-256 values across all six candidate trees; per-host manifests record the differing release-base commits and local package hashes.

| Candidate host | Node.js | `test:workflows` | Real local Planner |
|---|---:|---:|---|
| Aliemad-Laptop | 22.23.2 | 314/314 PASS | `qwen3:4b-instruct` — 2 actions, 2 planner calls, independent SHA-256 checks PASS |
| MMZ-Laptop | 24.22.2 | 314/314 PASS | `qwen3:4b-instruct` — 2 actions, 2 planner calls, independent SHA-256 checks PASS |
| Emad-PC-Ultimate | 26.7.0 | 313 PASS / 1 SKIP / 0 FAIL | `gemma4:12b` — 2 actions, 2 planner calls, independent SHA-256 checks PASS |
| Saeed-PC | 24.19.0 | 313 PASS / 1 SKIP / 0 FAIL | `qwen3.5:4b` — 2 actions, 2 planner calls, independent SHA-256 checks PASS |
| Emad-Server | 22.23.3 | 314/314 PASS | `gemma3:12b` CPU proposal exceeded the fixed 30-second planner deadline and was blocked; **not qualified** |
| Amirreza-Server | 22.23.3 | 314/314 PASS | No local Ollama endpoint; local-model Planner **unavailable** |

The six targeted V1-05 checks (JavaScript syntax, package contract, candidate file hashes, manifest fields and `git diff --check`) passed. The broader product `check` script passed on five hosts; Emad-Server exceeded its 300-second outer check deadline without a reported assertion failure. Its targeted V1-05 checks and 314-test workflow suite still passed.

These live results qualify only the isolated two-step, read-only candidate fixture with the exact host/model/adapter combination. They do not qualify free-form translation, current-fact answering, installed runtime routes, service registration or release acceptance. In particular, MMZ's separate task benchmark showed repetitive Persian translation and stale abstention behavior from `qwen3:4b-instruct`; do not generalize its constrained JSON-planner PASS to general assistant tasks. The Commander planner remains proposal-only and independently validates every action.

All six trees are QA candidates only. No installed release, service, route or user data was replaced. V1-08 still owns installer/release promotion, and V1-09 owns provider/model activation and hardware-specific routing. A candidate PASS is not an installation or release PASS.

## Evaluated ready-made workflow and model tooling

The engine uses Ollama's native `/api/chat` structured-output contract with a
JSON Schema, deterministic sampling and a proposal-only adapter. This is the
official Ollama path; no separate SDK is required for the current bounded
request/response contract. The adapter retains explicit process/HTTP timeouts,
response-size limits and Commander-side schema/policy validation.

Three workflow frameworks were reviewed against the actual deployment model:

- **LangGraph.js** provides graph-state checkpoints at each super-step, thread
  persistence, human-in-the-loop interrupts, time travel and fault tolerance.
  Its SQLite checkpointer is available. It is a strong fit if the planner
  becomes a dynamic agent graph, but it does not replace Commander tool
  authority or solve hardware-aware remote worker placement. Adding it now
  would duplicate the existing durable workflow journal and state model.
- **Hatchet** provides durable event-log execution, retries, DAGs, concurrency,
  worker slots and visibility. Its self-hosted control plane includes an API
  server, orchestration engine, PostgreSQL database and dashboard; RabbitMQ is
  optional for higher-throughput deployments. It is the best candidate for a
  future multi-host compute queue with CPU/GPU worker labels, but that requires
  an approved central control plane, authenticated host registration and a
  cross-host artifact/locking contract. Hatchet's worker-affinity labels can
  represent model-loaded/resource state, but that assignment feature is still
  Beta and must remain prototype-only until it is generally available and
  security/availability are qualified. It is not a drop-in replacement for
  the local Commander journal.
- **Temporal TypeScript** provides mature deterministic workflows and
  replay-safe activities. Its single-binary development server is suitable
  for local evaluation, while production requires a separately operated
  Temporal Service, persistence, security, monitoring and sequential upgrade
  management. That operational footprint is not justified for the current
  single-writer, per-machine project runner.

**Decision:** retain the existing Commander engine as the local authority,
durable journal and deterministic verifier. Continue using Ollama's official
structured-output API for local proposal generation. Do not add a second
workflow database or orchestration service until a measured cross-host
scheduling requirement justifies it. If that requirement is accepted, prototype
Hatchet first for hardware-labelled remote workers; keep all project mutations
behind the coordinator's bounded artifact-import and independent-verification
boundary. Re-evaluate Temporal if high-availability durable execution becomes
a production requirement.

Primary references:
- https://docs.ollama.com/capabilities/structured-outputs
- https://github.com/langchain-ai/langgraphjs/blob/main/docs/docs/concepts/persistence.md
- https://github.com/langchain-ai/langgraph/blob/main/libs/checkpoint-sqlite/README.md
- https://docs.hatchet.run/v1/durable-execution
- https://docs.hatchet.run/self-hosting
- https://docs.temporal.io/develop/typescript
- https://docs.temporal.io/self-hosted-guide

## Isolated qualification

`npm run test:project-engine` runs deterministic regression fixtures. `node examples/project-engine/run.mjs` demonstrates a full fixture planner → journaled file write → independent check → Brain/finalization cycle in an owned temporary directory.

`--codex` live-provider qualification is historical and must not be used under v0.9.11 policy. Use deterministic fixtures or an explicitly trusted non-Codex command provider for development tests.

A separate opt-in live-provider test exercises the real source Project Engine with
two ordered read-only steps, bounded prior observations, a local Ollama planner,
durable receipts and independent full-file SHA-256 verification. It creates and
removes only its own temporary test directory. It is deliberately **not**
part of the deterministic unit suite and is skipped unless explicitly enabled:

```bash
RC_TEST_LIVE_LOCAL_MODEL=1 \
RC_TEST_LOCAL_PLANNER_ADAPTER=/absolute/path/to/reviewed/local-ollama-planner.mjs \
RC_LOCAL_AI_MODEL=qwen3:4b-instruct \
node --test test/project-engine-local-model-live.test.mjs
```

The adapter path is operator-supplied, must be a regular file and must remain
subject to the user's local provider authorization. This test never launches
Codex or delegates authority. A PASS proves only the two-step fixture on
that specific model/host/adapter/source version; CPU cold-start and prompt
latency can exceed provider timeouts on other runs or devices.

The roadmap in `PROJECT_ENGINE_ROADMAP.md` tracks broader providers/integrations and comparative benchmarks. Milestone 4A adds [bounded prerequisite insertion and parallel proposal workers](PROJECT_ENGINE_ADAPTIVE.md). Unrestricted plan rewriting, parallel mutating project workers, automatic scientific validation, monetary accounting and general terminal reattachment remain outside the v0.8.37 scope. Milestone 4B.2 adds only the bounded artifact-worker boundary described below.


## Bounded artifact workers (4B.2)

v0.8.36 introduced the **opt-in artifact worker** boundary. v0.8.37 keeps it disabled unless explicitly configured inside an already enabled project runner and hardens import invariants found by independent review: a ready receipt remains bound to its delegated workflow step; absolute coordinator targets are accepted only when canonical containment keeps them inside the project root; and the documented 64 KiB artifact ceiling now fits through bounded proposal/context/journal envelopes without relaxing the 256 KiB workflow argument ceiling.

Enable it only inside an already explicit project runner:

\`\`\`json
{
  "runner": {
    "enabled": true,
    "worker": {
      "enabled": true,
      "maxArtifactBytes": 32768
    }
  }
}
\`\`\`

A coordinator may propose \`action="delegate"\` for the current atomic step. Delegation does not dispatch a project tool. Commander reserves the provider-call budget first, creates a private per-run/per-worker directory under local project-engine state, and invokes the configured base provider with a restricted artifact contract. The worker receives no Commander filesystem, shell, GUI, process, terminal, deletion, completion or authority tool catalog. It may return only one UTF-8 text artifact through the proposal contract or block.

The worker workspace is an **application-level authority boundary, not an OS sandbox**. A trusted `command` provider executable still runs with the operating-system user's privileges. Codex is forbidden as a provider under v0.9.11. Do not treat worker isolation as protection from a malicious provider binary.

Before an artifact can affect the project, Commander verifies that its workspace path is a regular single-link file, reopens it by stable file identity, enforces the size/UTF-8/secret guards, and binds a SHA-256 receipt. The coordinator can import only the exact receipt bytes through the normal journaled \`write_text\` path. The project target is then independently reread and matched to the worker receipt before the receipt is closed. Symlink/hardlink aliases, content changes and mismatched imports fail closed.

Worker reservations and provider calls consume the existing durable planner-call budget. A crash after reservation is not blindly retried. If a process exits after the journaled project import but before the worker receipt is closed, restart adopts that exact import only when the workflow step and receipt identify the same `write_text` operation/input hash and the target bytes still match the recorded SHA-256; otherwise the run blocks for inspection. Pause/cancel/deadline checks remain authoritative while a worker provider call is active.

This increment is intentionally narrow: one private text artifact at a time, one executing coordinator, no worker-to-worker delegation, no direct project mutation by a worker, no parallel mutating workers, no monetary budget, no external notification delivery and no superiority claim.

## Primary references

- https://learn.chatgpt.com/docs/non-interactive-mode
- https://learn.chatgpt.com/docs/config-file/config-reference
- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/headless


## 2026-11-08 — V1-05 root-lease scope binding in the 0.12 integration candidate (NoPromote)

The canonical `integration/v012-core-20261108` worktree now carries the minimal V1-05 workflow-scope binding needed by the V1-06 receipt handoff:

- `WorkflowStore.call` derives a canonical `rootFingerprint` and deterministic `leaseId` from the same active root lease and step admission, alongside `workflowId`, `stepId`, `operationId`, workflow `revision` and `fencingToken`.
- The frozen scope is stored in the durable step and receipt, returned in operation metadata, and passed as the fourth internal Host-dispatch argument. `server-v0.3` exposes it as `ctx.workflowOperation`. The store recomputes the lease identity and root fingerprint before and after dispatch; disabling one-writer-per-root intentionally emits no lease-bound scope.
- Focused workflow store/tools tests: **42/42 PASS**; complete workflow suite: **468/468 PASS**; full check qualification: **186/186 PASS**; full test qualification: **207/207 PASS**; security audit: `SECURITY_AUDIT_PASS`; `git diff --check` PASS.

**Still open:** the scope is not yet signed into V1-06's original Host execution receipt. The V1-05 feature worktree `integration/v105-hybrid-engine-20261107` contains broader process-containment and proof-based reconciliation changes, but it remains dirty/unintegrated. Its focused four-suite run was **58 PASS / 3 Windows-only skips / 0 failures** and its security audit passed. Do not merge that entire worktree: it includes overlapping V1-01/V1-07 worker identity changes and older release/planner changes. V1-00 must selectively review and integrate the process-containment/reconciliation delta, then qualify native Windows Job Object and Linux process-scope behavior. No installed runtime, production owner/provider, J01 consent, or fleet acceptance is claimed.

The release manifest remains `INTEGRATION_CANDIDATE_NOT_FINAL` with publication, autoupdate and installed-promotion approvals false. No commit, push, install, service restart or production enrollment occurred.
