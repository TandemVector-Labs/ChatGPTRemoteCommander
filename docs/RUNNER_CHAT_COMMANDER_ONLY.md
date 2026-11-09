# Bounded automatic execution with ChatGPT + Remote Commander

Status: **source-level qualification only**. This document does not enable or
deploy a model runner on any connected host.

## What can execute without another chat message

The native durable scheduler can advance an **explicitly enrolled**, accepted
WorkflowStore project when all of these are simultaneously true:

- A trusted, owner-approved non-Codex `command` planner is actually configured,
  its exact executable and arguments are known, and the effective config
  independently reports `runnerConfigured=true`.
- `scheduler.enabled=true`, `runner.enabled=true` and
  `runner.autoTick=true`, with bounded time/action/planner budgets. The
  *running instance*, not a repository manifest, must report
  `automaticExecution=true`.
- The planner only proposes a next atomic operation. The native engine still
  checks the approved project root, immutable goal/acceptance, step revision,
  tool allowlist, execution policy, evidence receipts and recovery state.
- The user has enrolled that particular project with `workflow_run_start`
  and exact checks. Recording a roadmap alone is not enrollment.
- Missing approval or an unfamiliar new task becomes `WAITING_INPUT` /
  `BLOCKED`, not a guessed shell command or unrestricted work.

The native trusted-command provider runs an **actual OS executable with the
hosting user's privileges**. It is **not a sandbox or a language model**. A
person reviewing this profile must pin the executable/script, constrain roots
and tools, reject credentials/network/process/GUI/privileged operations, and
preserve an exact stop/rollback path. A model-like autonomous coordinator is
not conjured by setting one boolean. Codex delegation remains forbidden unless
the *separate* explicit owner policy actually authorizes it; this feature
does not seek that authorization.

## Source-level admission tests

`test/project-autotick-noncodex.test.mjs` constructs a disposable private
workflow root and a deterministic, owner-pinned Node command planner. It
normalizes the real explicit runner config (including one reviewer), then:

1. Proves that native status genuinely reports both runner and auto-tick
   enabled for **that test instance**.
2. Enrolls exactly one preapproved read-only step. It deliberately never calls
   `workflow_run_tick`, and observes scheduler auto-ticks perform one
   `read_text` and deterministic SHA acceptance.
3. Confirms only one operation receipt, unchanged file bytes/mtime, no
   automatic replay during continued scheduler ticks and completion retained
   after closing/reopening WorkflowStore.
4. Proves an unrecognized instruction stops at `WAITING_INPUT` with an
   owner question and no host tool effect.
5. Checks disabled owner authorization and Codex-policy blocks.

On Windows Emad, the independent **native HTTP** isolated canary also
succeeded with a separate exact source commit, ephemeral loopback port,
SQLite root, restart and receipt replay. Its evidence is owned by the
existing Commander coordination project's EVIDENCE directory. These are
deterministic software/integration tests, not an independent LLM evaluation
of open-ended engineering or scientific decisions.

## Real host and project controls

- `workflow_roadmap` is read-only; it does not execute a pending step.
- User-visible `workflow_run_start` enrolls only a fully scoped workflow
  with budget and independent deterministic acceptance checks.
- `workflow_run_status` displays progress or the actual blocker.
- `workflow_control` with `pause` stops accepting more steps, subject to
  in-flight operation reconciliation. Resume requires exact current revision.
- `workflow_reconcile` handles uncertain outcomes; never retry unconfirmed
  writes based merely on timeout.
- A new user request is classified and placed into the same accepted DAG
  before subsequent execution; custom route text is **not** blanket approval.

If the connected host still reports `runnerConfigured=false` and
`automaticExecution=false`, unattended execution is **not active there**.
ChatGPT can still execute safe ready steps synchronously through Commander in
the chat, even with the scheduler disabled. The current public v0.10.24
unsigned Preview does not authorize new unsigned version distribution, and
source test PASS is not an owner-reviewed native service cutover.

**Never conflate** safe automatic step execution, full unattended reasoning,
published release/host installation, cross-client UI controls or independent
model behavior PASS.
