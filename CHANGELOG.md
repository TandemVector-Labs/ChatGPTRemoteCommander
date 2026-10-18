## 0.10.23 - 2026-10-15 (SOURCE CANDIDATE, NOT PUBLISHED STABLE)

- Integrate owner-host Linux rollback control Git fix from PR #219: exact verified staged SHA and shallow update. R566-R569 regression-first, full isolated QA and hosted Windows/Linux CI accepted before integration.
- Advance Core/Desktop/plugin/installer and the explicit one-version-only unsigned provenance policy to v0.10.23 while keeping original v0.10.22 tag and 20 assets unchanged.
- New tagged Draft, native owner rollback acceptance, Windows Authenticode and profile/CEF acceptance, Work ACK/Mesh and powered-off fleet remain separate gates. Public Stable v0.10.20, Browser Stable v0.8.1.

## 0.10.22 - 2026-10-15 (version-locked candidate, NOT released Stable)

- Version and release-policy synchronization after PR #217 Windows focus mutex J01 protection, based on main a90c7196cae3ca2bd471a0db3e42eb7eb89929eb.
- Preserve immutable v0.10.21 tag and original Draft; new annotated tag and attested twenty-asset Draft are independent admission gates.
- Full native owner acceptance, trusted Windows provenance, serial fleet rollback, Work ACK, and powered-off host validation remain open. Stable Core v0.10.20 and Browser v0.8.1 unchanged.

## 0.10.21 - 2026-10-11

- Close the Windows qualification Job Object containment defect documented in #173: exact executable children start suspended, are assigned to the kill-on-close Job before resume, and detached Node descendants remain contained.
- Execute local npm CLI through node.exe directly under the owned Job, rather than a command-shell wrapper; unsupported wrappers fail closed and the existing native descendant/owned-listener regressions remain active.
- Carry forward candidate-first update, rollback/no-replay semantics, user/profile ownership and exact SHA policy without widening automatic GUI, browser or Codex authority.
- Qualification before this release version bump: hosted Windows/Ubuntu PR #174 CI PASS; focused native Windows Job test PASS; Emad Windows exact candidate full check/test/audit PASS; separate real updater NoPromote E2E CANDIDATE_PASS with live Stable route unchanged. The exact v0.10.21 release candidate and immutable assets require new hosted gates before publication.
- Keep Remote Commander Browser v0.8.1 pinned. Browser previews, native UI and authenticated autonomous Runner remain independent gates rather than being silently promoted.

## 0.10.18 - 2026-10-07

- Fix the Linux updater pre-cutover tunnel gate so a tunnel whose local `/readyz` OAuth-discovery subcheck is stale can still be admitted only when `/healthz` is `live` and `commands_poll_last_successful_timestamp_seconds` proves a recent successful control-plane poll.
- Keep the fallback fail-closed for missing/zero/stale metrics or non-live health, and keep all tunnel verification before the cutover commit point.
- Preserve Remote Commander Browser v0.8.0 as the immutable, hash-pinned optional Browser dependency and leave browser profile/login authority unchanged.
- Advance runtime, installers, server installers and plugin release identity to v0.10.18 without moving or rewriting v0.10.17.
## 0.10.17 - 2026-10-06

- Preserve per-run Windows qualification stdout/stderr with SHA-256 evidence while keeping the existing owned Job Object, timeout, cleanup, backoff and failure semantics unchanged.
- Add native regression coverage for successful child, failing child and failing runner diagnostic retention with zero leaked descendants.
- Pin the immutable stable Remote Commander Browser v0.8.0 Setup (SHA-256 61fd810130845815dd20073f72051aec3b42c1a89b9577b3457f2190bd9b1a5e) as the optional Browser dependency; no Browser sign-in/profile automation policy is widened.
- Advance runtime, installer, server installer and plugin release identity to v0.10.17 without rewriting the immutable v0.10.16 release.

## 0.10.16 - 2026-10-06

- Collapse Windows Start Menu exposure to one public Remote Commander application; Profiles & Access, Operations Monitor, and Admin Runtime remain internal pages/tools launched from the product shell.
- Add a single-file Windows Setup executable with Commander Core and Commander + Control & Monitoring installation modes, optional desktop shortcut, and post-install multi-profile onboarding.
- Keep per-user Commander/profile state in the original user context; elevate only verified machine-wide prerequisites, preserving DPAPI ownership and avoiding installation into the UAC administrator account.
- Add secure in-memory profile enrollment support so Runtime API keys are not placed on command lines; legacy DPAPI persistence still occurs only after tunnel validation.
- Standardize the product ICO as a multi-size Windows icon and add regression guards preventing internal tools from reappearing as separate Start Menu applications.
- Add an optional compile-time Browser component hook. No Browser installer is bundled until the Browser has its own stable, verified standalone installer; the current Browser remains a separate pre-release product boundary.
- Extend release automation with a pinned Windows build job for the single-file Setup artifact and checksum inclusion in immutable GitHub Releases.
- Advance runtime, installers, server installers, plugin templates, contracts, and release identity to v0.10.16.

## 0.10.15 - 2026-10-05

- Fix Windows interactive terminal startup by executing the initial validated command through PowerShell argv instead of writing it to stdin before shell readiness.
- Keep follow-up interactive input on the same stdin channel while preserving Linux interactive behavior.
- Harden lifecycle qualification with bounded marker accumulation and readiness budgets validated under loaded Windows conditions.
- Advance runtime, installers, server installers, plugin templates and release contracts to v0.10.15 without rewriting the immutable v0.10.14 release.

## 0.10.14 - 2026-10-04

- Stabilize Linux durable-delivery identity across routed config-path rotation: final candidates preserve the active delivery directory/scope, fresh managed installs pin a stable device/profile scope, and diagnostic candidates use an isolated shadow store so qualification cannot pollute production delivery state.
- Keep historical config-path-derived delivery stores intact for forensic recovery; cleanup is gated on a profile/reference audit and archive manifest rather than deletion.

- Separate Linux transport-derived auto-deferred operation receipts from user-actionable durable delivery: retry/idempotency state remains durable, while synthetic `transport-*` correlations no longer inflate completion-beacon pending counts.
- Add bounded `TRANSPORT_RECEIPT` reclassification for legacy internal operation receipts with zero delivery attempts; artifacts and audit history are preserved and no user acknowledgement is synthesized.
- Add Linux/core regressions proving transport-derived `copy_path` survives retry/restart without delivery pollution while explicit request IDs retain normal claim/ack-capable delivery semantics.
- Fix Linux post-cutover control promotion when historical PowerShell files are dirty only because of CR-at-EOL normalization: staged or substantive mutations still fail closed, while proven EOL-only drift is auditable and tolerated.
- Detach a manually invoked Linux updater from a managed Commander backend process tree before taking the update lock, so retiring the previous backend cannot terminate the updater that is performing the cutover.
- Persist successful Linux update/maintenance completion atomically to `last-update.json` with exact version, commit, source ref and completion timestamp; invalid receipt identity fails closed without replacing the prior receipt.
- Keep the updater ERR trap active after the route commit point so post-cutover maintenance failures are durably classified instead of silently truncating the maintenance tail.
- Synchronize an already-installed personal Remote Commander Work/Codex plugin from the exact staged release template during both same-version maintenance recovery and normal post-cutover promotion.
- Preserve the existing private app binding byte-for-byte, validate its shape without logging it, create a prestate backup, perform an atomic source swap with rollback, and verify portable/native versions and app references before PASS.
- Add executable Linux regressions for EOL-only control promotion plus Work plugin sync success, absent-plugin no-op, and malformed-binding fail-closed behavior.
- Advance runtime, installer, server-installer, plugin-template, release-contract and final-gate identity to v0.10.14; v0.10.13 remains accepted stable until hosted and rollout gates pass.

## 0.10.13 - 2026-10-04

- Extend the scoped `codex_plugin_refresh` result with a bounded summary of each Codex `PluginSummary.source` so local marketplace/cache mismatches can be diagnosed without exposing raw app-server output or enabling general Codex delegation.
- Support the official Codex 0.157.1 source variants `local`, `git`, `npm`, and `remote`; every returned source field remains subject to the existing 512-character field cap and overall marketplace/plugin response bounds.
- Add regression coverage for local source-path preservation and bounded Git-source fields.
- Advance current release/runtime/installer identity to v0.10.13; v0.10.12 remains the accepted stable baseline until qualification and release gates pass.

## 0.10.12 - 2026-10-04

- Add a narrowly scoped `codex_plugin_refresh` maintenance tool that starts a short-lived Codex app-server sidecar and performs only `initialize` / `initialized` / `plugin/list(forceRefetch=true)` to refresh configured local plugin caches through the supported Codex path.
- Keep general Codex delegation default-deny: the maintenance tool accepts no prompt, arbitrary command or arguments and cannot invoke `exec`, `review`, turns, threads, or agents.
- Require explicit confirmation from the current request plus an explicitly authorized Full-Power profile, while keeping `powerMode.codexControl.allowLaunch` unchanged.
- Strip OpenAI/Codex API credentials from the maintenance sidecar environment, bound the complete synchronous maintenance budget to eight seconds, and add fail-closed protocol/schema regressions.
- Advance runtime, installer, server-installer, plugin-template, release-contract and final-gate identity to v0.10.12; v0.10.11 remains the accepted stable baseline until all qualification and release gates pass.

## 0.10.11 - 2026-10-04

- Fix Windows post-cutover control promotion when an older checkout is dirty only because historical CRLF blobs are reinterpreted by current EOL attributes.
- Keep promotion fail-closed for staged changes and every substantive tracked mutation; only a completely unstaged EOL-only diff may pass, with explicit `CONTROL_TRACKED_EOL_DRIFT_ACCEPTED` evidence.
- Add a real Git regression that reproduces the historical CRLF-blob state and proves substantive unstaged plus staged mutations remain blocked.
- Advance runtime, installer, server-installer, plugin-template, release-contract and final-gate identity to v0.10.11; v0.10.10 remains immutable.

## 0.10.10 - 2026-10-04

- Fix durable delivery compaction so repeated bounded passes advance beyond artifacts that were already archived instead of repeatedly consuming the limit on the first page.
- Preserve completed-undelivered state, exact correlation/acknowledgement semantics, transparent verified archived reads, and exclusion of active/unresolved/dead-letter deliveries.
- Add a bounded multi-pass regression proving three successive limit=1 compactions archive three distinct artifacts without synthesizing acknowledgement.
- Align Windows/Linux server-installer default refs and Windows bootstrap User-Agent with v0.10.10, with a regression preventing release/default drift.
- Advance runtime, installer, plugin-template and release-contract identity to v0.10.10; publication remains gated by full cross-platform qualification.
- Refuse Commander-native recursive `list_directory` / `search_files` at a bare Windows volume root and hard-cap synchronous search to 5,000 visited entries, with explicit truncation telemetry.
- Add a reversible Windows unattended-update pause sentinel for degraded-host recovery without weakening explicit owner `-Force` authority.
- Record the Emad-PC kernel-resource incident as a host/recovery boundary: abnormal System PID 4 handles/kernel pool are confirmed; `wcifs` attribution remains probable rather than stack-confirmed, and no automatic reboot/filter unload/System-handle closure is introduced.

## 0.10.9 - 2026-10-03

- Contain every Windows auto-update qualification gate inside an owned kill-on-close Job Object with bounded timeout, leak evidence, and repeated-failure backoff.
- Add durable isolated-browser lease markers and startup orphan reaping without touching persistent/user browser profiles.
- Add verified machine-level backup archive retention with age/count/byte budgets and scheduled maintenance.
- Bound stale workflow startup reconciliation, improve release-lock diagnostics, and retain delivery compaction safety.
- Preserve the v0.10.8 public surface while integrating the experimental finite Companion source snapshot separately from production authority.

# Changelog

## 0.10.8 — 2026-10-03

- Fix Windows candidate-first updates that could permanently block on an idle Commander-owned browser-control helper left under a verified old backend.
- Classify the browser helper as safe only after direct old-backend `browser_status` proves `active=false`, `busy=false`, `leased=false`, and `uncertain=false`; any missing or unsafe evidence remains fail-closed.
- Apply the same browser-idle proof to retained-work drain evidence so later generations cannot reintroduce the stale-descendant deadlock.
- Preserve v0.10.7 runtime semantics outside updater drain classification and advance installer/server/plugin/release identity to v0.10.8.

## 0.10.7 — 2026-10-03

- Isolate the MCP Tasks extension regression from the bulk Node test batch so workstation load cannot create a false qualification failure.
- Automatically prioritize timing/process-sensitive isolated fixtures on Windows for installer and updater qualification, not only hosted CI.
- Add harness regressions proving MCP Tasks is referenced exactly once, runs as an isolated test-file command, and participates in deterministic sensitive ordering.
- Preserve v0.10.6 production runtime semantics; this release changes qualification scheduling and release identity only.

## 0.10.6 — 2026-10-02

- Promote the evidence-backed Saeid operation-child lifecycle hardening on top of v0.10.5, capturing exit/close/error state before awaited persistence can race it.
- Add operation-child lifecycle syntax/test gates to the default qualification path.
- Version Saeid V03 policy/monitor, paused-domain, blocked Q5 private-file, and accepted Browser-R3 component sources under `experimental/` without wiring blocked components into production runtime.
- Preserve v0.10.5 stream-resume protections, background-first transport, rollback baseline, and fail-closed update behavior.
- Advance installer, server, plugin templates, release contracts and default source ref to v0.10.6.
## 0.10.5 — 2026-10-02

- Harden ChatGPT stream-resume behavior by shortening direct synchronous command exposure from 15 seconds to 10 seconds and reducing the per-turn synchronous Commander budget from three calls to two.
- Cap direct run_shell and run_project_command output at 32 KiB so a successful command cannot return multi-megabyte structured MCP payloads through one ChatGPT response stream.
- Add bounded terminal output paging: read_terminal defaults to 32 KiB per stream, caps pages at 64 KiB, returns continuation offsets/remaining counts, and supports at most a 5-second long-poll for fresh output.
- Make start_terminal the explicit compatibility fallback for long/high-output work when a ChatGPT custom app still has a stale cached tool catalog and has not exposed operation_*; never compensate by increasing synchronous timeouts.
- Preserve durable operation_*, MCP Tasks, idempotency, delivery, workflow recovery, one-writer semantics, and candidate-first update behavior. The fix reduces dependence on one long-lived ChatGPT response stream rather than claiming to repair a platform-side resume service.
- Add regressions for 90,000-character paged terminal output, bounded wait behavior, 10-second direct-call rejection, updated MCP instructions/schema, and retry/transport compatibility.

## 0.10.4 — 2026-10-01

- Make hosted qualification deterministic by isolating scheduler-sensitive async/workflow/tunnel-log test files from the large concurrent file batch and extending only fixture observation deadlines; production runtime deadlines are unchanged.
- Make inherited-stdio fixture readiness publication atomic under hosted Windows load, and add a fail-closed regression proving live-worker finalization grace remains bounded.
- Normalize Windows supervisor PowerShell blobs to canonical LF in Git while retaining CRLF checkout policy via .gitattributes, preventing fresh Linux clones from appearing dirty after checkout.
- Bound tunnel log growth without restarting live tunnel connections: tunnel-client now logs to stdout under a Commander-owned rotating logger (8 MiB current file + 3 gzip archives) with atomic machine-readable rotation status and bounded legacy-tail migration.
- Add identity-safe durable delivery artifact compaction: verified gzip archives preserve content hashes and unread delivery state, never synthesize acknowledgement, and expose storage/oldest-pending metrics.
- Bound Power Mode file-backup growth: append mutations now create verified truncate-recovery journals instead of full growing-file copies, and file rollback points retain only the newest configurable per-target snapshots (default 8, range 2–64).
- Harden the concurrency smoke runtime-marker readiness gate after HTTP health; production runtime behavior is unchanged.
- Apply the existing fail-closed explicit owner runner-policy overlay to named Windows profiles as well as the default profile, preserving routed runtime state while preventing canonical owner runner intent from being lost during candidate migration.
- Normalize minor tracked-file text hygiene discovered by the full repository audit.

## 0.10.3 — 2026-09-30

- Harden the isolated-profile HTTP regression startup gate with a 30-second elapsed deadline and early child-exit diagnostics, matching the already-qualified transport-correlation startup pattern.
- Remove an arbitrary approximately 10-second Windows full-suite scheduling window without changing production runtime, HTTP, routing, authority, or operation timeouts.
- Make the inherited-stdio regression fixture deterministic under hosted-runner load by synchronously writing the direct-child marker before explicit exit; production async-operation worker/runtime behavior is unchanged.
- Harden workflow chat-handoff restart recovery qualification with a 30-second elapsed wait and explicit status diagnostics; production workflow recovery behavior is unchanged.
- Preserve the v0.10.2 production behavior and maintenance fixes unchanged; this release exists to make candidate-first Windows qualification deterministic under host load.

## 0.10.2 — 2026-09-30

- Reconcile retained Windows backends on the updater CURRENT fast path before deferred drains and release cleanup, reusing the existing liveness-safe reconciler so dead retained entries can be cleaned without killing live terminal-bearing backends.
- Harden the transport-correlation HTTP test startup gate with a 30-second elapsed deadline and early child-exit diagnostics, removing an arbitrary Windows full-suite scheduling window without changing production HTTP/runtime timeouts.
- Reuse verified Node.js and Git for Windows installations from their standard Program Files locations when an administrator/server environment has removed them from PATH, avoiding unsafe duplicate prerequisite installs while retaining verified-download fallback.
- Preserve Full Power authority, stable routing, browser/GUI policy, durable workflow history, no-blind-replay semantics, and Linux runtime policy; this is maintenance hardening rather than a capability expansion.

## 0.10.1 — 2026-09-29

- Harden Windows BootRecovery diagnostics: structured self-test failures now preserve exact profile/integrity errors, and missing-result failures include Task Scheduler state/LastTaskResult context without weakening fail-closed integrity checks.
- Add a Windows regression proving an intentional isolated-profile config-hash mismatch produces a persisted structured failure instead of disappearing behind a generic timeout.
- Clarify durable workflow status without deleting history: expose persistedNonterminal, explicit pending semantics, and whether any root lease is active.
- Make the inherited-stdio async-operation regression event/property based: prove the operation completes while the stdio-holding process is still alive, then clean that process up explicitly.
- Keep runtime authority and production operation timeouts unchanged; no automatic historical workflow cleanup, Linux runner enablement, reboot, or permission expansion is introduced.

## 0.10.0 — 2026-09-29

- Add Windows and Linux application-like Setup bundles that delegate to the existing release-qualified installers rather than creating a second privileged updater/runtime.
- Add local setup wizards for Standard / Full Power / Full Power + GUI selection, persistent tunnel enrollment, health/readiness checks and truthful WAITING_APP_ID continuation.
- Add deterministic device-specific Plugin ZIP generation. Each machine/profile receives a stable distinct plugin name, display name, brand color and generated icon/logo; the ZIP contains the exact registered App ID but no Runtime API key, Tunnel ID, bearer token or tunnel credential.
- Bind and verify registered apps in both the portable root manifest and the native `.codex-plugin/plugin.json` compatibility manifest.
- Add current OpenAI ZIP/upload/app-binding guidance and grow the immutable release asset set from 15 to 19 with stable and versioned Windows/Linux Setup ZIPs.
- Repair this changelog projection for v0.9.11–v0.9.23 from the authoritative per-release evidence files; historical release files remain unchanged.

## 0.9.23 — 2026-09-29
- Reuse bounded check/test qualification in hosted/install/update Windows paths to prevent repeated test-file resource starvation without changing production runtime timeouts.

## 0.9.22 — 2026-09-29
- Preserve an explicitly owner-authorized Project Engine runner across candidate-first Windows updates using a narrowly validated canonical runner-policy overlay.

## 0.9.21 — 2026-09-28
- Reconcile the Project Engine runner contract with explicit FULL_POWER owner authorization while retaining default-deny local Codex behavior.

## 0.9.20 — 2026-09-28
- Add disposable Windows/Linux server-install canaries and close fresh-Linux prerequisite/headless qualification gaps.

## 0.9.19 — 2026-09-28
- Harden external Agent Extension routing with explicit-trigger dominance and separated multiword trigger matching.

## 0.9.18 — 2026-09-28
- Preserve successful Windows update outcomes across cleanup races, finish headless PowerShell helper coverage, and add read-only external Skill routing/retrieval.

## 0.9.17 — 2026-09-28
- Make immutable GitHub Release publication attach deterministic/checksummed installer, plugin and server assets in the initial release transaction.

## 0.9.16 — 2026-09-28
- Remove only Commander's stale generated no-Codex CODEX_HOME sentinel during explicitly authorized local Codex launch while preserving legitimate user configuration.

## 0.9.15 — 2026-09-28
- Honor persisted FULL_POWER owner authorization for stale-schema GUI takeover compatibility and replace the former absolute Codex block with a narrow explicit-owner opt-in.

## 0.9.14 — 2026-09-28
- Map unknown MCP task IDs to the standards-required Invalid params result while preserving durable/idempotent execution semantics.

## 0.9.13 — 2026-09-28
- Add MCP Tasks mapping and same-conversation continuation/outbox behavior so long work survives client/stream interruption without switching execution paths.

## 0.9.12 — 2026-09-27
- Preserve Project Engine tool definitions while the runner is disabled so live schema continuity remains compatible and invocation still fails closed.

## 0.9.11 — 2026-09-27
- Restore ChatGPT-first reasoning boundaries by removing unintended automatic Codex delegation from normal Commander execution.

## 0.9.10 — 2026-09-27
- Recover an unreadable terminal operation state projection only when its durable request reservation and final receipt agree exactly on operation ID, input hash and correlation identity.
- Preserve the original corrupt `state.json` bytes as a content-addressed `.bin` evidence backup before atomically reconstructing the terminal projection; never replay the external effect.
- Stop corrupted historical terminal projections from remaining forever in the periodic delivery tracked set after exact recovery, while mismatched reservation/receipt evidence remains fail-closed and undelivered.
- Add positive and mismatch regressions plus a read-only-copy validation over the 22 all-zero Windows projections observed in production: 22/22 repaired, 22/22 backups preserved, 0 invalid, tracked→0.


## 0.9.9 — 2026-09-27
- Bound durable-delivery reconciliation to one startup discovery plus the live tracked-operation set instead of rediscovering every historical operation directory every five seconds.
- Stop repeated terminal-receipt adoption/state-file rewrites after a completion has already been published; preserve restart backfill, exact correlation isolation, durable artifacts and no-blind-replay semantics.
- Add a regression proving the second reconciliation pass checks zero historical terminal operations and does not touch the persisted operation state.
- Keep ChatGPT host-stream failures as a separate external/host boundary: Commander guarantees durable/idempotent work recovery, but cannot manufacture host wake/push or prevent a platform-side response stream from expiring.


## 0.9.8 — 2026-09-27
- Add Remote Commander-Agent Extension Contract v1 for reusable declarative capability packs without expanding execution authority.
- Expose read-only extension discovery through `agent_extension_list`, `agent_extension_get`, and `agent_extension_match`, with bounded status/diagnostics in `system_status`.
- Fail closed on invalid manifests, traversal, linked manifest files, and duplicate IDs, including multi-way duplicate conflicts.
- Teach the Remote Commander skill to reuse declared shared runtimes/models and preserve all existing Commander workflow, GUI/browser, idempotency and safety gates.
- Keep domain Agents outside the Core repository; Core qualification uses generic extension fixtures and external discovery roots only.

## 0.9.6 — 2026-09-27
- Add a schema-compatible completion beacon to the existing `system_status` result so chats with a cached older MCP tool catalog can still discover bounded metadata for durable completed-but-undelivered work.
- Require continuation turns to check the completion beacon before unrelated work, preserve correlation isolation, and visibly close every execution turn as COMPLETED/BACKGROUND/BLOCKED/WAITING/FAILED instead of silently extending one UI stream.
- Keep full result artifacts private and correlation-scoped; the beacon exposes metadata only and does not inline command output, project contents, or secrets.
- Preserve the three-direct-call chat-stream budget, durable background execution, idempotent mutation replay protection, Full Power capabilities, Windows/Linux power recovery hardening, and zero-downtime update guards from v0.9.5.
- Explicitly retain the platform boundary: autonomous wake/push into a ChatGPT conversation remains unavailable unless the host negotiates a supported task/subscription capability; durable inbox/beacon recovery is the safe fallback.

## 0.9.5 — 2026-09-27
- Fix Windows real-power-return recovery by resolving the pinned tunnel client from stable per-user app state and binding SYSTEM BootRecovery/UserSessionHandoff tasks to the stable app root so future zero-downtime promotions do not leave task-path drift.
- Harden Linux unattended recovery: enable systemd user lingering during autostart enrollment and recycle only Commander-owned tunnels whose control-plane success metric is stale while a network route is present; local /readyz alone is no longer treated as proof of control-plane freshness.
- Preserve Full Power semantics with no disabled capabilities, candidate-first updates, unchanged-schema continuity checks, durable workflows, Project Brain, background-first browser/GUI policy, and fail-closed mutation replay.
- Supersede the stale v0.9.4 release channel so stable auto-update no longer repeatedly qualifies an older schema-changing commit.

## 0.9.4 — 2026-09-26
- Add a private durable completion/delivery inbox with idempotent claim/ack, content-addressed bounded artifacts, and restart-safe detached-operation receipt backfill.
- Carry opaque correlation IDs through detached operations and Project Engine runs; publish WAITING_INPUT/BLOCKED and mapped terminal project states into durable delivery.
- Reserve explicit transport headroom for synchronous command calls and keep long/unknown command work background-first.
- Pin official OpenAI tunnel-client v0.0.15 for Windows/Linux candidate qualification.
- Carry forward v0.9.3 Linux retained-terminal cutover and owned Firefox background-browser parity.
- Preserve fail-closed mutation uncertainty, foreground-interaction policy, and project/scientific evidence during cleanup.

## 0.9.3 — 2026-09-25

- Complete Linux Full Power parity without killing persistent terminal workloads: validated route cutovers may retain a terminal-bearing previous backend after routed inflight work reaches zero, detach it from route.previous, and protect its release tree until the terminal workload ends.
- Add a safe Firefox + geckodriver background-browser backend for Linux hosts without Chromium. Firefox Snap uses an owned profile root under ~/snap/firefox/common; Windows Chrome/CDP behavior is unchanged.
- Keep Browser background-first and fail-closed: no global browser install, no sudo requirement, no user browser-profile reuse, no saved-password extraction, and no --no-sandbox fallback.
- Record rejected approaches as evidence: Playwright Chromium CDN geoblocking and Ubuntu AppArmor user-namespace restrictions made private Chromium unsuitable on the audited Linux host.
- Carry forward the v0.9.2 installer cleanup fix, v0.9.1 release hardening, and v0.9.0 Project Engine/retry parity behavior.
## 0.9.2 — 2026-09-25

- Make the Windows existing-install updater wrapper cleanup idempotent after a successful candidate-first cutover: if its temporary fetch tree has already disappeared, cleanup no longer converts `SAFE_UPDATE_PASS` into a false process failure.
- Keep cleanup fail-closed for real residual failures: a caught removal error is rethrown when the temporary tree still exists.
- Carry forward all v0.9.1 release-hardening changes, including Linux `--skip-tunnel-client` parity and the browser-process regression race fix.
- v0.9.0 is an immutable published parity release; v0.9.1 remains a tagged but unpublished hardening candidate, and v0.9.2 supersedes it as the release target.

## 0.9.1 — 2026-09-25

- Harden final release acceptance without widening runtime authority or changing the v0.9.0 Project Engine capability model.
- Add Linux `--skip-tunnel-client` parity with Windows: an existing pinned client is reused and verified; when none is present, the network download can be explicitly skipped for isolated/fresh qualification.
- Eliminate a test-only unhandled-rejection race in the browser helper forced-shutdown regression by attaching the expected timeout rejection handler immediately; runtime browser timeout semantics are unchanged.
- v0.9.0 was subsequently published as an immutable parity release; v0.9.1 remains a tagged but unpublished hardening candidate superseded by v0.9.2.

## 0.9.0 — 2026-09-25

- Promote the next milestone around capability parity rather than revision-only versioning: canonical Full Power installations auto-configure the bounded Project Engine runner from the pinned private Codex CLI 0.156.1 provider, bootstrapping that provider when needed.
- Converge the Linux/Emad deployment with the proven Work-created configuration observed on the Emad Windows PC: automatic enrolled-project execution, bounded planner proposals, builder/reviewer proposal team, adaptive bounded extensions, durable worker artifacts and resume-after-restart/update semantics.
- Add explicit `workflow.project_engine` capability accounting and opt-out. Standard authority and explicit Full Power opt-outs continue to fail closed; missing qualified provider leaves durable recovery enabled but does not enable autonomous execution.
- Normalize inherited provider timeouts to the 30-second synchronous transport budget introduced in v0.8.41; longer work continues through durable operation/workflow state rather than extending tunnel deadlines.
- Make installer and candidate-first updater configuration discover the same qualified provider on Windows and Linux from the private Commander state root, with regression coverage for parity, authority, provider absence and timeout migration.
- Carry forward v0.8.41 background-first browser, durable operation, idempotency, response-envelope and connection-interruption hardening unchanged.

## 0.8.42 — 2026-09-25

- Restore live upgrade compatibility for persisted Project Engine provider configurations that legitimately carry historical timeout values such as 120000 ms.
- Separate configured timeout acceptance from effective execution time: provider configuration remains accepted up to the historical 600000 ms bound, while the effective planner process deadline remains clamped to 30000 ms for transport-safe retry hardening.
- Add regression coverage proving a legacy 120000 ms provider configuration loads successfully while `planner.describe().timeoutMs` remains 30000 ms.
- v0.8.41 remained immutable and failed safely during its first live rollout; v0.8.42 superseded it for deployment and is the published compatibility baseline carried into v0.9.0.

## 0.8.41 — 2026-09-25 (published, deployment superseded by 0.8.42)

- Harden Secure MCP Tunnel reliability after real logs repeatedly showed `command response deadline reached; dropping without posting a response`: synchronous command/browser/planner work is bounded to 30 seconds and longer work is directed to durable `operation_*` execution.
- Remove large-result duplication between MCP text content and structured content, and cap the final serialized MCP response at an 8 MiB safe envelope; oversize results now fail as a compact `MCP_RESPONSE_TOO_LARGE` JSON-RPC error instead of risking a 413/transport interruption.
- Keep legitimate large reads usable inside the envelope: regression coverage passes a 5 MiB structured result without duplicate text and converts a 9 MiB response into the compact bounded error.
- Fix fresh/custom Windows `-SkipTunnelClient` acceptance so an intentionally skipped tunnel client no longer requires a pre-existing executable; an existing pinned client is still reused when present.
- Align provider/browser timeout defaults with the tunnel deadline budget while preserving durable cancellation and no-blind-retry semantics.
- Recalibrate the Windows provider-tree regression to the existing bounded cleanup budget after direct diagnostics measured `taskkill /T /F` latency under load; the runtime termination mechanism itself is unchanged.
- v0.8.40 remains an immutable historical tag but was not published as a GitHub Release; v0.8.41 supersedes it before public publication.

## 0.8.40 — 2026-09-25 (unpublished candidate, superseded by 0.8.41)

- Add durable background command operations (`operation_start`, `operation_status`, `operation_result`, `operation_cancel`) so long-running builds, tests, audits and shell/project commands do not hold one MCP request open.
- Make stable request IDs idempotent across lost acknowledgements; changed inputs with the same request ID fail closed, and uncertain outcomes are never blindly replayed.
- Keep captured stdout/stderr file-backed and policy-bounded while recording total byte counts and SHA-256 over the complete stream; bounded result tails keep MCP responses small.
- Harden Windows durability with receipt-first recovery and bounded atomic-state rename retries so a valid completion receipt cannot be downgraded by a transient `EPERM/EACCES/EBUSY` state update failure.
- Bound post-exit stdio draining so descendants that inherit a pipe cannot strand an already-finished command; receipts explicitly report whether output capture was complete.
- Carry forward the hardened background-browser implementation from unpublished v0.8.39; v0.8.38 and v0.8.39 tags remain historical and are not moved.

## 0.8.39 — 2026-09-25 (unpublished candidate, superseded by 0.8.40)

- Ship the hardened background-first browser layer after two independent review rounds found ten pre-publication defects and every reproduced issue was converted to regression coverage.
- Isolate browser profiles by Commander instance, preserve helper sessions across ordinary page errors, make non-HTTP snapshot URLs null-safe, and clean browser/profile state on startup, timeout, crash and forced-shutdown paths.
- Harden same-profile foreground handoff so failed visible relaunches recover safely, result metadata reflects actual foreground/background mode, and helper path handling remains correct with spaces and non-ASCII checkout paths.
- Centralize exact `--user-data-dir` ownership matching so cleanup terminates only browser processes belonging to the Commander-owned profile and preserves prefix-sibling processes and persistent profile data.
- Keep the browser deterministic and direct-session-only; it does not require Codex and does not grant autonomous workflow browsing authority.


## 0.8.38 — 2026-09-25 (unpublished candidate, superseded by 0.8.39)

- Add a direct-session zero-interference background browser that drives an owned Chromium profile through CDP without moving the user's mouse, changing foreground focus, reusing the user's normal browser profile, or extracting saved passwords.
- Add approval-on-demand coordination for MFA, WebAuthn, CAPTCHA, saved-user-browser credential boundaries, and sites that reject headless operation.
- Add explicit same-profile foreground handoff: after current-task authorization, the Commander-owned profile may be relaunched visibly for the minimum required GUI step and then returned headlessly with its cookies/session preserved.
- Keep browser tools out of durable/autonomous workflow execution and require fresh reconciliation after uncertain browser mutations.
- Harden browser helper shutdown/relaunch lifecycle, URL query/fragment redaction, and isolated-profile cleanup.

## 0.8.37 — 2026-09-25

- Qualify the bounded project-engine planner against Codex CLI 0.156.1 while accepting only its exact fail-closed `code_mode_host`-disabled diagnostic; unknown, widened, duplicated or out-of-order provider errors remain blocked.
- Bind a ready worker receipt to the exact delegated workflow step so plan progress cannot retarget a verified artifact to another step.
- Accept absolute coordinator import targets only when canonical containment keeps them inside the enrolled project root.
- Preserve the documented 64 KiB worker-artifact ceiling through bounded proposal/context/journal envelopes, with an explicit 256 KiB workflow argument ceiling and negative regression above it.

## 0.8.36 — 2026-09-25

- Add opt-in bounded artifact-worker delegation for explicitly enrolled project runs without granting workers direct Commander project-tool authority.
- Store worker artifacts only in private per-run engine state and require regular single-link files, bounded UTF-8 content, secret guards and SHA-256 receipts before coordinator import.
- Bind imports to the normal journaled `write_text` path and record canonical input hashes plus operation IDs; crash recovery refuses same-bytes/different-call effects and never blindly replays a reserved worker.
- Preserve pause/cancel/deadline control, durable provider-call budgets, independent final verification and disabled-mode behavior. This is an application-level authority boundary, not an OS sandbox.

## 0.8.35 — 2026-09-24

- Persist bounded planner questions as WAITING_INPUT and expose them in run status/scheduler blockers without stalling other enrolled projects.
- Add explicit revision-checked, idempotent workflow_run_resolve responses. Resume the same run with its original scope, acceptance checks, deadline and consumed budgets; responses do not grant tool authority.
- Preserve question/answer state across restart and reject stale/conflicting answers, credentials, changed policy/scope, cancelled/paused execution and exhausted budgets.

## 0.8.34 — 2026-09-24

- Deliver the durable adaptive project engine, isolated Linux installer and Standard-authority fixes from the unpublished 0.8.32/0.8.33 candidates.
- Recheck the persisted project deadline after a timer wakes early, preserving EXHAUSTED classification and preventing an early abort. A deterministic early-wakeup integration regression retains the no-effect and single-attempt assertions.
- Release evidence: docs/RELEASE_0.8.34.md.

## 0.8.33 — 2026-09-23 (unpublished candidate)

- Deliver the opt-in durable/adaptive project engine prepared in 0.8.32 after final cross-platform qualification.
- Keep custom Linux no-start installer updates in their own checkout; only canonical live installs or explicit start requests delegate to candidate-first service promotion.
- Preserve explicitly selected Standard authority across repeated capability migrations; an explicit Standard choice must never imply Full Power authorization.
- Give process-crash regression tests separate bounded startup/scenario budgets and cancellation cleanup for slower Windows CI workers, retaining all receipt, deadline and no-replay assertions.
- v0.8.32 was tagged for installer acceptance but not publicly released. Its duplicate hosted Windows run exposed a test time budget issue, and final Linux installer review exposed the custom no-start activation issue.

## 0.8.32 — 2026-09-23 (unpublished candidate, superseded by 0.8.33)

- Add an opt-in durable project runner with a bounded Codex/trusted-command planner, journaled execution, independent acceptance checks and evidence-bound Project Brain completion.
- Preserve pause/cancel authority across late receipts; reserve action/provider budgets before dispatch and recover recorded read observations after restart.
- Add opt-in adaptive prerequisite insertion with exact revision/receipt recovery and bounded parallel proposal workers with a single executing coordinator.
- Reject hardlinked write targets before mutation and validate file identity/canonical paths for independent verification.
- Existing installations retain recovery/readiness-only behavior until the runner is explicitly configured and projects are enrolled. Native desktop input behavior is unchanged.
- Cross-platform qualification and release evidence: docs/RELEASE_0.8.32.md. Claude execution, isolated mutating workers, monetary accounting and universal comparative superiority remain unqualified.
- Install the Linux native helper's GdkPixbuf dependencies in hosted CI before running its existing contract/self-test.

## 0.8.31 — 2026-09-22

- Keep custom/isolated Windows installer validation from delegating an existing non-canonical checkout into the global candidate updater when `-NoStartServer` is used.
- Canonical live installations still use candidate-first safe update; isolated/custom existing checkouts update only themselves in place and do not mutate global routing/state.
- Supersedes unpublished v0.8.30 candidate for release publication; retains all v0.8.30 runtime-identity and already-current-profile protections.

## 0.8.30 — 2026-09-22

- Prevent Windows multi-profile updater candidate churn from reusing one `commit/profile` runtime marker across repeated same-release runs. Candidate runtime and backup state are now unique per candidate port.
- Skip candidate creation for an already-current profile with no pending previous route during ordinary automatic updates, while preserving explicit mutation/force behavior.
- This prevents stale `secondary` backend processes from losing ownership evidence and accumulating as cleanup-blocking orphans when another profile remains deferred.

## 0.8.29 — 2026-09-22

- Treat the descendant subtree of an idle, unleased Windows GUI helper as part of that helper during non-destructive terminal-retention evidence, so its console host does not falsely block route detachment.
- Continue to fail closed for every descendant outside the persistent-terminal subtree, the idle GUI-helper subtree, or a direct console host.

## 0.8.28 — 2026-09-22

- Fix the Windows terminal-retention evidence helper to avoid PowerShell's reserved automatic `$PID` variable; the prior v0.8.27 helper failed closed as `DEFER_PROCESS_TREE` before classifying descendants.
- Preserve the v0.8.27 double-check, non-destructive retained-terminal design unchanged.

## 0.8.27 — 2026-09-22

- Allow Windows retained-terminal handoff to retire stale router inflight accounting only after independent backend-idle, GUI-idle, socket-owner and process-tree evidence passes twice.
- Preserve the entire persistent-terminal subtree; this path never stops the retained backend and never treats persistent terminals as safe for destructive stale-backend retirement.
- Keep profile-scoped update admission and all v0.8.26 safety barriers unchanged.

## 0.8.26 — 2026-09-22

- Add a Windows retained-backend terminal keeper so a zero-inflight previous backend may leave the single route slot without terminating its persistent terminals.
- Preserve active persistent-terminal backends through cutover; after cutover they remain the routed `previous` generation until their workload ends safely.
- Protect both routed previous and retained release trees from cleanup; retained backends are reaped only after terminal/process safety evidence allows it.
- Keep Linux updater behavior unchanged.

## 0.8.25 — 2026-09-22

- Fix Windows multi-profile update admission so one ChatGPT profile with a legitimate persistent-terminal drain no longer blocks independent healthy profiles.
- Preserve fail-closed terminal safety per profile: blocked profiles keep their live backends and terminal process trees untouched; only eligible profile candidates may cut over.
- Record partial promotion explicitly and avoid supervisor recycle/release cleanup while any profile remains deferred.
- Keep the v0.8.24 Linux GNOME lifecycle unchanged.

## 0.8.24 — 2026-09-22

- Make GNOME/Wayland GUI extension updates session-safe: byte-identical extension trees are no longer replaced.
- When extension bytes really change, disable the active extension before atomic replacement, then re-enable it; recover enabled-but-inactive state with one bounded disable/enable cycle and bridge polling.
- Keep the no-logout/no-reboot/no-desktop-takeover invariant while allowing the GUI D-Bus bridge to become active in the current GNOME 46 session when possible.
- Ignore runtime `/var/` state/log output so the control checkout remains clean without deleting operational logs.
- Preserve v0.8.23 published-release authority and all earlier route, persistent-terminal, GUI-policy and cleanup protections.

## 0.8.23 — 2026-09-22

- Correct stable-channel discovery: ordinary Git tags are no longer treated as releases.
- Prefer GitHub's documented `/releases/latest` web redirect on both Linux and Windows, with the Releases REST endpoint as fallback.
- Fail closed if published-release discovery is unavailable; never fall back to the highest raw semantic-version tag.
- Preserve v0.8.22 route/drain barriers and all prior GUI, persistent-terminal and updater safety controls.

## 0.8.22 — 2026-09-22

- Prevent nested blue/green generations from overwriting an unresolved `route.previous`. Windows and Linux now attempt to finish the existing drain after candidate validation but before any new route mutation; unresolved drains stop the candidate with `BLOCKED_EXISTING_DRAIN` / `AUTO_UPDATE_EXISTING_DRAIN_BLOCK`.
- Complete Windows deferred-drain terminal safety: `Complete-DeferredDrains` checks persistent-terminal descendants before every direct old-backend stop path, including zero-inflight/cancellable maintenance.
- Enforce the invariant inside `tools/router-switch.mjs`: any switch with an existing `current.previous` fails closed with `ROUTER_PREVIOUS_NOT_DRAINED`, so a future caller cannot silently overwrite older route authority.
- Add a functional router regression proving rejected nested switches leave generation, active and previous state unchanged, plus Windows/Linux ordering regressions around existing-drain admission.
- Preserve all v0.8.21 Linux GNOME/Wayland GUI and zero-interference controls, v0.8.20 persistent-terminal admission, and v0.8.19 cleanup-only/no-recycle protection.

## 0.8.21 — 2026-09-22

- Add guarded native GUI control for Linux GNOME 46 / Wayland through a local GNOME Shell extension plus bounded helper, while preserving the existing exclusive lease, fresh single-use frame and explicit-current-user takeover boundary.
- Make zero-interference machine-readable and migration-stable: observe-only by default, background/headless preferred, foreground mutation forbidden without an explicit current request, and durable workflows unable to acquire GUI takeover.
- Recheck foreground window and monitor geometry immediately before Linux native input, honor local GUI stop files, and authenticate the per-user Shell bridge with a mode-0600 token.
- Install and synchronize the Linux GUI extension through fresh install and candidate-first update paths without forcing logout, GNOME restart or reboot. GNOME 46 may require the next normal desktop session before a newly introduced local extension becomes active; gui_status remains fail-closed until then.
- Prefer Git repository tags for Linux stable-version discovery, using the GitHub Releases API only as fallback, reducing exposure to API rate-limit/403/timeout failures.
- Clarify durable scheduler semantics: automatic recovery/reconciliation/readiness remains enabled, while automaticExecution=false and runnerConfigured=false truthfully state that Remote Commander is an execution/control plane rather than a duplicate model runtime.
- Preserve v0.8.20 persistent-terminal cutover/drain protection and v0.8.19 cleanup-only/no-recycle behavior unchanged while adding GUI backend synchronization to control-code maintenance and final promotion.
- Add Linux GUI contract/packaging/parser regression, zero-interference migration/status regression and stress evidence separating local MCP latency from external connector latency and decision quality.

## 0.8.20 — 2026-09-21

- Prevent automatic cutover while the currently active backend owns any persistent interactive terminal. Candidate validation can complete, but candidates are stopped before route mutation and the updater records `BLOCKED_PERSISTENT_TERMINALS` / `AUTO_UPDATE_PERSISTENT_TERMINAL_BLOCK`.
- Protect already-draining previous backends on both Windows and Linux: a live persistent terminal now emits `DRAIN_PERSISTENT_TERMINAL_DEFER` before any old-backend stop path, including the zero-inflight path.
- Detect only the interactive shells created by Remote Commander `start_terminal` (`pwsh -NoLogo -NoProfile` on Windows and shell `--noprofile --norc` on Linux), avoiding false positives from ordinary non-interactive updater/run-shell children.
- Align terminal-session upgrade behavior with established session-drain designs: keep the endpoint/session owner alive or defer cutover rather than orphaning an interactive session. A full terminal broker/reconnect architecture is intentionally deferred because the smaller admission/drain guard achieves the required safety outcome with much less new complexity.
- Carry forward v0.8.19 cleanup-only/no-recycle protection and all prior candidate-first, ownership, GUI non-interference, durable-workflow and rollback controls.

## 0.8.19 — 2026-09-21

- Break a confirmed Windows auto-update maintenance feedback loop: stale superseded-release cleanup is now independent of supervisor recycle, so a locked old release can no longer restart a healthy supervisor every scheduler cycle.
- Supervisor recycle is now reserved for actual control-code promotion. Cleanup-only maintenance records explicit `RELEASE_CLEANUP_PASS`, `RELEASE_CLEANUP_DEFER`, and `AUTO_UPDATE_CLEANUP_PENDING` evidence without disrupting a healthy tunnel/backend.
- Make Windows release cleanup observable and fail-closed instead of silently swallowing locked-directory deletion failures; cleanup-pending state is persisted in the updater receipt.
- Apply the same cleanup-only/no-recycle separation to Linux maintenance to prevent the equivalent self-restart feedback loop.
- Add contract regression that cleanup-only paths on both platforms must not contain supervisor recycle.
- Live behavioral regressions on Windows proved both cases: removable stale release cleanup preserved the same supervisor PID; an intentionally locked stale release produced `AUTO_UPDATE_CLEANUP_PENDING` while the same supervisor PID remained alive and no recycle event was emitted.
- Production cleanup retired ownership-proven orphan backends from v0.8.9, v0.8.10 and v0.8.11 only after proving they were unrouted, idle, connection-free and without unsafe descendants. Subsequent scheduled update checks remained `AUTO_UPDATE_CURRENT`.

## 0.8.18 — 2026-09-21

- Fix Windows updater child-process stdio inheritance: staged long-lived backends are now launched with detached `Start-Process` semantics rather than inheriting the MCP `run_shell` stdout/stderr pipe. A behavioral regression proves the updater parent can observe EOF and exit while the child remains alive.
- Replace version-gated legacy drain recovery with evidence-gated stale-drain recovery. Cleanup requires zero backend active operations/queue, no unexpected TCP peer beyond the canonical router, no persistent-terminal/other unsafe descendant, GUI not busy/leased, ownership identity, and an immediate second evidence check before stop.
- Persistent terminal processes are never auto-classified as idle-safe. This prevents an updater from terminating a completed-but-still-owned interactive project shell without explicit session closure.
- Atomically retire `route.previous` after ownership-proven drain/cleanup on Windows and Linux using generation/profile/port/commit preconditions, preventing stale previous-route metadata from surviving maintenance.
- Fix runtime version authority drift carried by v0.8.16/v0.8.17: `src/server-v0.3.mjs` now reports the same version as package/plugin metadata, and onboarding regression requires equality.
- Preserve all v0.8.17 Linux updater-lock descriptor protections, v0.8.16 Linux lifecycle hardening, and v0.8.15 Windows test-transport stabilization.

## 0.8.17 — 2026-09-21

- Fix a confirmed Linux updater-lock inheritance defect: long-lived promoted backend and stable-router processes now explicitly close updater lock file descriptor 9 before exec, so the first successful cutover cannot permanently block every later update with `AUTO_UPDATE_ALREADY_RUNNING`.
- Add updater contract regressions requiring both long-lived Linux processes to close the inherited lock descriptor.
- This successor release preserves all v0.8.16 Linux lifecycle/package hardening and exists because v0.8.16 was already published immutably before live post-promotion evidence exposed the inherited-lock root cause.

## 0.8.16 — 2026-09-21

- Fix Linux systemd/crontab supervisor runtime discovery by prepending the installer-managed portable Node runtime before any routed recovery or automatic-update work; generated systemd user units also persist that PATH explicitly.
- Preserve executable mode in Git/release metadata for all Linux lifecycle scripts instead of relying on post-checkout chmod. This prevents the installer from manufacturing tracked mode-only dirtiness that can block control-checkout promotion with `control tracked dirty`.
- Extend Linux disable lifecycle cleanup to ownership-validate and stop routed backend/router processes, not only direct control-checkout servers and tunnel processes.
- Restore bounded connect/total timeout policy for the tunnel-client binary download by routing the asset fetch through the shared `curl_fetch` helper.
- Add source-integrity regressions for Linux executable modes, portable-runtime bootstrapping, routed cleanup markers, and bounded tunnel-client download.
- Make systemd supervisor recycle self-safe: post-cutover cleanup and durable PASS logging complete before an asynchronous `systemctl --user restart --no-block`, avoiding self-termination of the updater inside the service control group.
- Live Ubuntu audit that motivated this patch: v0.8.13 runtime/tunnel were healthy, but the systemd user supervisor PATH omitted the portable Node directory and no scheduled auto-update launch was recorded despite `autoUpdate.enabled=true`; the source authority was already v0.8.15.
- Retain v0.8.15 test-transport stabilization and all v0.8.13 supervisor continuity/no-live-work-recycle protections.

## 0.8.15 — 2026-09-21

- Fix a nondeterministic release/installer test-harness failure caused by Node Fetch blocked-port policy. The stable-router tests previously chose any OS-assigned free port and then accessed the router through `fetch`; valid TCP ports such as 5060 can be rejected as unsafe by Fetch before the request reaches the local router.
- Replace local router test traffic with `node:http` requests, matching the transport under test and removing browser-style blocked-port behavior from the harness. Product/router runtime code is unchanged by this fix.
- Add repeated focused validation: the stable-router suite passed 10 consecutive runs after the harness correction.
- Supersede the unpublished v0.8.14 candidate tag; no v0.8.14 GitHub release was published. All v0.8.14 candidate-cleanup/installer hardening is carried forward unchanged.
- Retain v0.8.13 supervisor continuity, v0.8.12 monotonic updates, v0.8.11 response-drain accounting and v0.8.10 zero-interference desktop authority.

## 0.8.14 — 2026-09-21

- Fix pre-cutover candidate leakage on Windows and Linux. Every spawned candidate is ownership-tracked immediately, and validation failures clean only the exact owned candidate before returning failure.
- Remove unattended Windows candidate dependence on the shared interactive `gui_status` helper. Update validation now uses the native no-input self-test plus candidate `system_status` GUI backend/policy fields, avoiding `GUI_NATIVE_BUSY` contention without taking desktop control.
- Preserve v0.8.13 supervisor continuity hardening: busy routed backends and healthy canonical routers remain protected from transient health/source-drift recycling.
- Add updater-contract regression coverage for immediate candidate tracking, ownership-safe failure cleanup, shared-GUI-helper independence, and Linux validation cleanup traps.
- Ship a release-specific installer bundle with pinned Windows/Linux installers, Work-plugin installers, setup documents and SHA-256 manifest; fresh-install acceptance is performed in an isolated install directory before publication.
- Retain v0.8.12 monotonic no-downgrade updates, v0.8.11 response-drain accounting and v0.8.10 zero-interference desktop authority.

## 0.8.13 — 2026-09-21

- Harden active routed-backend recovery after live evidence showed that one transient two-second health miss could force-stop a busy backend and trigger a burst of multi-chat HTTP 502 failures.
- Require three consecutive backend health misses, readable canonical-router activity, zero in-flight work, and a final health/activity re-check immediately before any ownership-proven backend recycle.
- Defer recovery whenever router activity is unavailable or work is still in flight; unknown or mutating work is never killed merely because liveness probes missed.
- Preserve a healthy canonical router when only its loaded source hash is stale; source activation is deferred and logged instead of intentionally creating an update-time canonical-listener gap.
- Apply the no-live-source-recycle policy to both Windows and Linux supervisors and add a behavioral Windows regression proving busy-backend and healthy-router guards cannot be bypassed.
- Retain v0.8.12 monotonic no-downgrade updates, v0.8.11 downstream-disconnect drain accounting, v0.8.10 zero-interference desktop authority, Full Power persistence and no-blind-replay semantics unchanged.

## 0.8.12 — 2026-09-21

- Make stable-channel automatic updates monotonic on Windows and Linux: when the installed active version is newer than the latest stable release, unattended update exits with `AUTO_UPDATE_NEWER_CURRENT` instead of downgrading.
- Preserve explicit operator control: `-Force`/`--force` continues to permit deliberate exact-ref downgrade/testing when requested.
- Add Windows/Linux updater-contract regressions requiring the downgrade guard to execute before candidate gates or route cutover.
- Correct release sequencing for this project: publish and verify the immutable stable release before live promotion so the scheduled stable updater and manual promotion share the same authority.
- Retain the v0.8.11 router disconnect-drain fix and v0.8.10 zero-interference desktop authority unchanged.

## 0.8.11 — 2026-09-21

- Fix stable-router drain accounting when the downstream MCP client disconnects before a completed upstream response is fully consumed. The router now detaches the closed downstream response and continues consuming the backend response to its real end/close event instead of leaving a permanent inflight entry.
- Preserve mutation safety: downstream disconnect does **not** cancel or retry the upstream request. The old backend is considered drainable only after the upstream response actually completes or closes.
- Add a deterministic regression that reproduced the production failure before the fix (`inflight=1` after client disconnect) and passes after the fix.
- Record and recover the v0.8.10 production incident with ownership-proven shutdown of the superseded backend only after its audit showed `run_shell ok=true`, no non-console child workload remained, and the route/runtime marker/PID/port/profile all matched.
- Retain all v0.8.10 zero-interference desktop controls unchanged.

## 0.8.10 — 2026-09-21

- Add a zero-interference GUI session boundary: `gui_session_begin` defaults to observe-only, while mouse/keyboard/scroll/focus mutations require an explicit `takeover` session with a current-user authorization basis.
- Enforce takeover mode in the MCP controller before consuming a frame or invoking native input, so Full Power alone cannot seize the user's pointer or foreground application.
- Prevent durable/resumed workflows from acquiring takeover mode or dispatching GUI mutations; interactive desktop input is direct-session-only so stale workflow memory cannot become authorization.
- Update Plugin, Work, setup, security and GUI-acceptance contracts to prefer shell/filesystem/API/headless/background paths unless the current user explicitly requests desktop interaction.
- Add regressions proving observe-only sessions can inspect the desktop but reject native mutation, and that takeover mode remains guarded by the existing lease/fresh-frame/uncertain-outcome protections.
- Keep unattended updates strictly no-input; interactive GUI E2E remains a separately authorized disposable-release gate.

## 0.8.9 — 2026-09-21

- Replace the unattended Windows updater's interactive GUI E2E gate with the existing native no-input self-test, preventing scheduled updates from stealing desktop focus or failing because Windows denies background foreground activation.
- Keep real focus/click/Farsi+Japanese typing/button/screenshot/cursor/foreground GUI E2E as a mandatory release-validation gate on the exact clean release commit.
- Keep candidate hardware validation of the GUI backend through candidate MCP `gui_status`, so the target machine must still prove the native backend is available before promotion.
- Preserve v0.8.8 router loaded-source SHA binding and ownership-proven stale-router recycle, plus v0.8.7 persistent GUI latency and conservative drain handling.
- Add updater-contract regression proving interactive `test:gui-native` is not invoked by unattended candidate updates.

## 0.8.8 — 2026-09-21

- Bind every running stable router to a SHA-256 of the exact `stable-router.mjs` source loaded by that process and expose the digest through router status/runtime state.
- Make Windows and Linux supervisors require the running router source digest to match the authoritative promoted checkout; stale or pre-hash routers are recycled automatically.
- Keep router recycle ownership-proven through runtime marker, canonical port/state-file identity and process identity checks; unknown canonical listeners remain fail-closed.
- Preserve v0.8.7 GUI latency improvements, conservative post-cutover drain handling, Full Power capability persistence, durable workflow recovery and immutable release policy.
- Add regression coverage for loaded-source hash binding and supervisor source-drift recycle contracts on both Windows and Linux.

## 0.8.7 — 2026-09-21

- Replace per-GUI-call PowerShell startup and C# recompilation with a bounded, lazily started persistent helper using newline-delimited JSON over existing child-process pipes; keep the one-shot helper path for compatibility and regression.
- Preserve all GUI safety invariants: single desktop lease, fresh single-use frame, foreground/geometry validation, local emergency stop, global native mutex, bounded output/timeouts, and uncertain-mutation suspension with no blind replay.
- On the validated Windows target, reduce warm GUI status from ~1.78 s to ~16 ms median, controller window listing to ~37 ms median, and common 1000 px screenshot reads to ~87 ms median.
- Add conservative router in-flight metadata without retaining request arguments, classify only known long-lived transport requests as cancellable, and expose JSON drain details while preserving the old numeric router-status interface.
- Change Windows/Linux post-cutover drain handling so unknown or mutating long-running work is deferred rather than force-killed; promote control state, preserve compatible old release/schema state, and complete cleanup automatically when the old request ends.
- Keep GitHub immutable-release policy and full-SHA/least-privilege Actions hardening from v0.8.6.

## 0.8.6 — 2026-09-20

- Make workflow checkpoints atomically synchronize WAITING lifecycle, scheduler enablement and next-run projection in the same SQLite transaction, closing the observed workflow snapshot/scheduler divergence.
- Add regression coverage that requires checkpointed workflows to report WAITING consistently while preserving automatic continuation when enabled.
- Harden GitHub Actions with explicit read-only contents permission and full commit-SHA pins for checkout/setup-node instead of floating major-version tags.
- Prepare publication under GitHub immutable-releases policy so the next published release tag and assets cannot be changed after publication.
- Preserve direct local-validated GitHub Release publication while the account-level hosted-Actions billing lock remains an external GitHub Support gate.

## 0.8.5 — 2026-09-20

- Make profile-instance test fixtures platform-native so the release gate uses Windows absolute paths on Windows and POSIX absolute paths on Linux instead of feeding Windows-only fixture paths to the Linux local-path guard.
- Preserve the production fail-closed local-path validator unchanged; this is a release-gate portability fix, not a relaxation of filesystem authority.
- Reproduce the GitHub Ubuntu job locally on Ubuntu 24.04 with Node 22 and verify `npm run check`, `npm test`, and `npm run audit` all pass.
- GitHub-hosted CI remains externally blocked from starting while the repository owner's GitHub account reports a billing lock; jobs receive no runner and execute zero steps.

## 0.8.4 — 2026-09-20

- Fix Windows updater target discovery so only immediate profile directories are considered; historical `instance.json` files inside profile backup trees can no longer be mistaken for live profiles.
- Fail closed when a direct profile directory name disagrees with the profile recorded in its `instance.json`.
- Add regression coverage that forbids recursive instance discovery. This closes the v0.8.3 `-NoPromote` cleanup failure where archived `secondary` records produced duplicate candidates and an ownership mismatch before any route cutover.
- v0.8.3 was published but is superseded by this hotfix before production promotion; live v0.7.3 remained authoritative throughout discovery.

## 0.8.3 — 2026-09-20

- Make native Windows GUI E2E self-contained in clean Git checkouts by creating its ignored runtime `var` directory before launching the fixture app.
- Make `-NoPromote` candidate validation ownership-safe and self-cleaning so diagnostic backends cannot remain running after a successful dry run.
- Harden tunnel-ID history scanning to the canonical lowercase `tunnel_` prefix and add a regression that rejects uppercase status/error symbols as credential false positives.
- v0.8.2 was intentionally not tagged or released after the clean detached-worktree gate exposed the GUI test-harness directory assumption.

## 0.8.2 — 2026-09-20

- Include the tracked `tools/build-candidate-config.mjs` runtime helper required by clean staged automatic updates.
- Harden `test/source-integrity.mjs` so lifecycle/updater runtime dependencies must be Git-tracked, preventing untracked working-tree helpers from making local gates pass while clean release checkouts fail.
- Includes the v0.8.1 Windows gate-argument fix; v0.8.1 was intentionally not tagged or released after clean-stage validation exposed the missing tracked helper.

## 0.8.1 — 2026-09-20

- Fix Windows auto-update gate execution: the helper parameter named `Args` collided with PowerShell's automatic `$args` variable, causing staged `npm run check` to launch npm without arguments and fail closed before cutover.
- Add an explicit missing-gate-arguments guard so the updater cannot silently treat an empty gate command as valid.
- Preserve the v0.8.0 candidate-first safety behavior: the failed updater never reached cutover, so live v0.7.3 production remained unchanged during discovery of this defect.

## 0.8.0 — 2026-09-20

- Capability Profile v2: explicit Full Power enables every known capability by default and automatically adopts new capabilities on later upgrades; only persistent explicit opt-outs keep individual capabilities disabled.
- Full Power durable orchestration now covers the complete filesystem, shell, process, persistent-terminal and GUI surface while preserving intent-before-effect journaling, operation classification, reconciliation and no blind mutation replay.
- Durable Workflows R2 adds scheduler state, operation receipts, idempotency keys, one-writer project-root leases, crash recovery, retry/root-cause budgets, user revision overrides, execution-profile persistence, Project Brain synchronization and evidence-backed FINAL completion.
- Candidate validation uses a consistent shadow workflow database; live schema finalization occurs only after verified cutover, preserving rollback compatibility before the commit point.
- Candidate-first automatic updates on Windows and Linux stage releases side-by-side, run repository/security/hardware diagnostics before promotion, and leave the active installation untouched when validation fails.
- Stable loopback routing provides generation-guarded atomic cutover, drains in-flight work on the previous backend, and removes superseded backends/releases after successful drain.
- Post-commit maintenance recovery and supervisor recycle keep the promoted runtime authoritative without requiring logout or reboot.
- Stable-channel automatic update checks are enabled by default. Full Power includes automatic and zero-downtime lifecycle capabilities unless explicitly opted out.
- Linux receives parity for candidate-first install/update, shadow workflow validation, hardware self-test, route recovery and scheduled automatic update checks.
- Cross-platform release contracts now cover all-on Full Power, persistent opt-outs, router safety, workflow crash/reconcile behavior, Linux shell parsing and native Windows GUI E2E.

## 0.7.3 — 2026-09-19

- Sanitize `REMOTE_COMMANDER_CONFIG` at Windows supervisor startup. A supervisor launched from an isolated MCP context can no longer inherit that profile config into primary MCP startup.
- Keep isolated MCP launch explicit through `ProcessStartInfo.Environment[REMOTE_COMMANDER_CONFIG]`; primary and per-profile configuration selection are now unambiguous.
- Add regression coverage to the profile-reconfiguration contract after reproducing the live primary-port timeout caused by inherited environment state.
- When an isolated profile explicitly enables Power + GUI, durable workflows can journal the bounded power/file and GUI tool subset (including fresh-frame GUI actions) while shell, delete, process-kill and terminal control remain excluded from durable replay.


## 0.7.2 — 2026-09-19

- Add transactional reconfiguration for existing isolated profiles without changing Tunnel ID, DPAPI credential, MCP port, runtime marker path, or durable workflow store.
- Add ownership-proven isolated MCP recycle: supervisor may stop a mismatched listener only when runtime marker PID/port/profile/projectDir prove it owns that exact process; unknown listeners remain fail-closed.
- Add a Windows reconfiguration wrapper with bounded health verification and backup rollback when the new instance does not come healthy.
- Keep permanent delete disabled; Power Mode and GUI remain explicit opt-ins per isolated profile.


## 0.7.1 — 2026-09-19

- Security hardening for isolated Standard profiles: command execution allowlist is empty by default, so general-purpose interpreters/compilers cannot escape project-path policy.
- Remove `run_project_command` from the default durable workflow execution set for Standard isolated profiles. Explicit isolated Power Mode may opt back into the base command allowlist.
- Keep per-profile memory, runtime markers and tunnel routing unchanged; no credential or Tunnel ID rotation is required.


## 0.7.0 — 2026-09-19

- Add opt-in durable project workflows with crash-safe intent/receipt journaling, checkpoint evidence hashes, resume/reconcile semantics and logical export.
- Add per-profile local MCP isolation so additional ChatGPT accounts can use distinct ports, configs, audit logs, runtime markers and private workflow databases.
- Add transactional Windows profile migration that reuses the existing tunnel ID and DPAPI Runtime API credential, validates a candidate MCP with tunnel-client doctor, and rolls back the profile on failure.
- Keep isolated secondary profiles conservative by default: Standard Mode, no shell/process/GUI/full-filesystem access unless explicitly opted in.
- Integrate workflow/profile recovery tests into standard release gates.


## 0.6.5 — 2026-09-19

- Fail closed when `expectedSha256` is malformed or targets a missing file; no parent/file creation occurs on a failed precondition.
- Preserve the complete promoted destination and recovery metadata when a move source deletion partially fails; never delete the last complete copy to restore an overwritten target.
- Add focused recovery regressions for Standard and Power Mode writes/moves.


## 0.6.4 — 2026-09-19

- Bounded Linux external downloads with explicit connect and total timeouts so unavailable TLS/network paths fail deterministically instead of hanging indefinitely.
- Applied the same bounded-download policy to the Linux Work Plugin template fetch and bounded the Linux account connector's local MCP health probe.
- Added regression contracts so release checks fail if the timeout controls are removed.
- Reproduced the original failure on WSL2: DNS resolved `nodejs.org` but TLS connection attempts timed out while the old installer waited without a deadline.
- Retains v0.6.3 read-only doctor diagnostics and isolated concurrency testing, plus all v0.6.2 runtime/tunnel/GUI hardening.

## 0.6.3 — 2026-09-19

- Isolated the concurrency smoke server inside a disposable application copy so tests never write, restore, or race with the live `var/mcp-runtime.json` ownership marker.
- Added a hard regression asserting the live ownership-marker SHA-256 is unchanged by the concurrency gate.
- Added a loopback-only read-only `npm run doctor` diagnostic for health, active server version/device, core tool discovery, optional config SHA-256 comparison, and drift detection.
- Added doctor regression coverage for healthy state, version drift, missing core tools, URL-secret rejection, remote-host rejection, and timeout/argument validation.
- Re-ran the full Windows release gate including MCP conformance, audit rotation, filesystem safety, 67/67 GUI contract tests, security audit, and native Windows screenshot/input/focus E2E.

## 0.6.2 — 2026-09-19

- Fixed Windows tunnel profile path ambiguity by passing the repository-managed profile directory explicitly to tunnel-client init, doctor, and run.
- Windows enrollment now recognizes an already-ready tunnel-client process for the same profile during an installation handoff, even when that process belongs to the previous installation path.
- Preserves the existing `%APPDATA%\\tunnel-client` profile store; no profile migration or secret rewrite is required.
- Prevents false doctor failures during in-place production promotion when the previous healthy tunnel already owns the profile health port.
- Added Windows runtime-contract gates for explicit profile-dir binding and upgrade-ready profile detection.

## 0.6.1 — 2026-09-19

- Fixed exact release identity checks for annotated Git tags by peeling fetched refs to their commit before ExpectedCommit comparison.
- Added Linux parity for exact expected-commit verification through `--expected-commit` / `REMOTE_COMMANDER_EXPECTED_COMMIT`.
- Made fresh source acquisition transactional: failed Windows installs remove incomplete fresh checkouts; Linux stages into a temporary checkout and only moves it into place after fetch, peel, expected-commit verification, and checkout succeed.
- Detects existing incomplete Git installations with no HEAD instead of treating them as valid update targets.
- Added a regression using a real annotated Git tag to prove raw `FETCH_HEAD` differs from the release commit while `FETCH_HEAD^{commit}` resolves exactly to it.
- Reproduced and closed the v0.6.0 clean-production installer failure; positive clean install and negative wrong-ExpectedCommit cleanup both PASS.

## 0.6.0 — 2026-09-19

- Completed real dual-era MCP conformance for legacy 2025 clients and MCP `2026-07-28` stateless clients.
- Added required modern `tools/list` cache hints, strict modern header/body version classification, `Mcp-Method`/`Mcp-Name` routing validation, and modern rejection of the removed `notifications/initialized` lifecycle.
- Added centralized closed-schema tool-input validation. Known-tool validation/handler failures now return normal MCP tool results with `isError: true`; unknown tools remain JSON-RPC protocol errors.
- Hardened tool risk annotations so potentially overwriting/destructive file/process/shell operations are conservatively marked destructive/open-world where applicable.
- Added a dependency-free MCP conformance gate and independently validated the candidate with the official `@modelcontextprotocol/client@2.0.0` in legacy, modern-auto, and modern-pinned modes.
- Added serialized bounded audit logging with an 8 MiB default segment limit and three retained rotated generations; concurrent-rotation regression verifies parseable, non-duplicated JSONL.
- Revalidated the existing Power Mode full-filesystem compatibility, concurrency, filesystem safety, runtime ownership, HTTP admission, secret scan, Windows GUI contract, and native screenshot/input/screenshot E2E.
- Kept OpenAI `tunnel-client v0.0.14` pinned after current-release verification; it remains the published rollout target for MCP 2026-07-28/sessionless tunnel traffic.

## 0.5.2 — 2026-09-19

- Restored full-filesystem compatibility for the five legacy MCP tools when explicit Power Mode has `fullFilesystem=true`. `list_directory`, `read_text`, `write_text`, and `run_project_command` can now use absolute paths outside configured `allowedRoots` subject to OS permissions and the existing policy.
- Kept command hardening intact: `run_project_command` remains executable-allowlisted, while `python -c` and Node eval/print modes remain blocked.
- Power-mode legacy writes outside configured roots now use the configured Power Mode backup root instead of creating repository-style backup directories beside the target.
- Added explicit effective-access signaling to `system_status`: `allowedRootsEnforced`, `effectiveAccess.filesystem`, and `legacyFiveToolCompatibility`.
- Updated MCP tool descriptions and server instructions so clients do not misinterpret configured roots as an active boundary while full-filesystem Power Mode is enabled.
- Added regression coverage for legacy read/write/list/command access outside configured roots plus HTTP/MCP metadata/instruction consistency.

## 0.5.1 — 2026-09-19

- Fixed concurrency-test isolation so `npm test` preserves the live `var/mcp-runtime.json` ownership marker instead of leaving the temporary port-47931 test server identity behind.
- Verified the fix against a live supervised v0.5.x runtime: the runtime-state SHA-256 was identical before and after the full test suite, then controlled MCP recycle restored a self-written marker for the actual port-47831 process.
- Re-ran `npm run check`, `npm test`, `npm run audit`, and the native Windows GUI E2E gate successfully after the fix.
- Removed the obsolete public `release/v0.5.0-rc1` branch after creating a local rollback bundle; this removed stale audit-only test fixtures from reachable public branch history and restored `SECURITY_AUDIT_PASS`.
- Keeps the v0.5.0 GUI/runtime feature set and security boundaries unchanged; this is a maintenance and release-integrity patch.

## 0.5.0 — 2026-09-18

- Added opt-in Windows GUI Control for trusted Power Mode machines with MCP image screenshots, mouse move/delta/click/drag/scroll, Unicode typing, bounded key combinations, window discovery/focus, and a local emergency stop.
- Added a repeatable native Windows GUI E2E gate using a disposable WinForms target. It verifies real screenshot capture, exact-window focus, mouse click, Farsi/Japanese Unicode typing, button activation, post-action screenshot change, cursor restore, and best-effort focus restore.
- Fixed redirected PowerShell stdin/stdout to explicit UTF-8 so multilingual GUI typing is not corrupted by the host console code page; hardened focus with verified thread-input attachment and safe detach.
- Pinned release installers to `v0.5.0` by default while keeping explicit source-ref/commit overrides for controlled validation and recovery.
- Added an exclusive expiring desktop lease and short-lived single-use frame tokens. Every GUI mutation must be based on a fresh screenshot; concurrent chats cannot independently drive the same desktop.
- Added strict runtime GUI schemas, fixed native dispatch, sanitized helper errors, bounded subprocess/image output, corrected Win32 INPUT layout, DPI/foreground/desktop checks, and an uncertain-outcome latch instead of blind retries.
- Hardened loopback HTTP admission against untrusted Host/Origin/content-type requests while preserving Secure MCP Tunnel architecture.
- Hardened Power Mode containment against canonical path/symlink escapes, same/ancestor/descendant copy/move hazards, and parent/child lock races. Copy/move overwrite now stages and rolls back instead of deleting the destination first.
- Made Windows installer mode transitions real and config-aware: local policy is merged/backed up, Standard disables an existing Power policy, health exposes config identity, and same-version config changes restart the owned MCP.
- Pinned tunnel-client executable identity with recorded SHA-256, strict profile names, exact TunnelId/HealthPort reuse, post-validation credential persistence, readiness checks, and ownership-safe stop/start.
- Converted the legacy multi-account foreground connector to the persistent supervisor path.
- Public configuration remains Power/GUI disabled by default. Secure Desktop/UAC, lock screen, anti-cheat/protected input and high-speed real-time gameplay remain explicit platform limits.

## 0.4.4 — 2026-09-18

- Fixed the public Bash one-line Work Plugin installer when executed via `curl | bash -s`: `BASH_SOURCE[0]` is now expanded safely under `set -u`, eliminating the harmless but confusing unbound-variable warning.
- Kept the v0.4.3 app-identity guardrail, self-contained Release template download, private-path fixes, and exact-app verification unchanged.


## 0.4.3 — 2026-09-18

- Added an explicit app-identity guardrail for Work/Plugin binding: bind only the exact Custom App created for this project's Secure MCP Tunnel and verify its scanned tools include `system_status`.
- Documented that fuzzy Plugin Directory search results or similarly named remote-control apps must never be substituted for the intended ChatGPT Remote Commander app.
- Kept the self-contained latest-Release Work Plugin installer flow from v0.4.2 and verified its public one-line Windows path end-to-end with an isolated synthetic app identifier.
- Clarified that the optional `tunnel-client` Codex Plugin is separate from this project's Plugin and is not a FINAL PASS requirement.
- Fixed relative `-TemplateSource` and `-InstallRoot` resolution in the Windows Work Plugin installer so controlled offline/private paths resolve from the caller's current PowerShell location rather than the host process directory.


## 0.4.2 — 2026-09-18

- Made the app-bound Work Plugin installers self-contained when executed directly from a Release asset or in-memory PowerShell.
- If no adjacent `plugin-template/` exists, the installers download the generic `plugin-template.zip` asset from the latest Release and clean up temporary files after installation.
- Added optional `TemplateSource` / `TEMPLATE_SOURCE` overrides for controlled offline/private deployments.
- Added public one-line Windows and Linux Work Plugin installation commands that need only the registered app technical ID.
- Release packaging now publishes both stable `plugin-template.zip` and versioned `plugin-template-v0.4.2.zip` assets.


## 0.4.1 — 2026-09-18

- Added one-command app-bound Work Plugin installers for Windows and Linux.
- The installers accept either a real app ID (`asdk_app_`, `connector_`, `templated_apps_`) or the corresponding ChatGPT technical `plugin_...` identifier and normalize it correctly.
- They create a private per-user Plugin copy, generate `.app.json`, add a personal marketplace, install/enable the Plugin through Codex, and verify the app binding.
- Added explicit current OpenAI guidance that `.app.json` uses the underlying app ID, not the `plugin_...` wrapper shown in Plugin URLs.
- Documented the optional tunnel-client Codex Plugin as non-blocking; the Remote Commander Plugin is the required project integration.


## 0.4.0 — 2026-09-18

- Added `START_HERE.md` as the single source of truth for AI-assisted installation from a GitHub link through FINAL PASS.
- Added explicit Standard versus Full/Power Mode guidance, including benefits, boundaries, plan availability, and safe secret handling.
- Added current ChatGPT custom MCP app creation steps: Developer Mode, Tunnel connection, no-auth selection, Scan Tools, creation, and real `system_status` verification.
- Added `docs/PLUGIN_SETUP.md`, `WORK_SETUP.md`, a portable Plugin template, repository marketplace, project-level Plugin enablement, app-binding helpers, workflow skill, privacy/terms documents, and ready PNG/SVG visual assets.
- Replaced outdated foreground-tunnel instructions across the 10 setup-language pages with the persistent supervisor flow and latest Release installer assets.
- Updated Windows and Linux disable scripts so stopping persistent mode also stops managed tunnel/MCP processes while preserving credentials unless explicitly removed.
- Updated Windows and Linux enrollment so Start is self-contained: when MCP is stopped, enrollment starts it automatically before restoring persistent supervision; no manual `npm start` is required.
- Bumped runtime/package version to 0.4.0.


## 0.3.4 — 2026-09-18

- Fixed Windows installer path resolution when `install.ps1` is executed from an in-memory `irm`/ScriptBlock rather than from a `.ps1` file.
- `Resolve-InstallDir` now returns the resolved path explicitly and the installer assigns it in the caller scope, avoiding PowerShell `$script:` scope differences.
- Added validation for the public one-line `irm` install/update execution path.


## 0.3.3 — 2026-09-18

- Fixed the Windows installer path collision between application source and persistent local state (`credentials` / `downloads`).
- New installs use `%LOCALAPPDATA%\\ChatGPTRemoteCommander\\app`; state remains under `%LOCALAPPDATA%\\ChatGPTRemoteCommander`.
- Existing active installations are auto-detected from the Windows logon supervisor and updated in place, preserving custom/source-repo installations.
- Legacy installs where the state root itself is a Git checkout remain supported.
- `-StartServer` now upgrades a running v0.3 MCP to the newly installed version when needed, so normal updates do not require sign-out or reboot.
- Added explicit Git ignore coverage for legacy local `credentials/` and `downloads/` directories.


## 0.3.2 — 2026-09-18

- Converted `connect-chatgpt.ps1` into a persistent-connection compatibility wrapper instead of starting a second foreground tunnel.
- Re-running the legacy connect command now delegates to the idempotent autostart enrollment flow, reuses the saved DPAPI credential, and leaves the background supervisor as the single tunnel owner.
- Prevents the common `tunnel-client run failed: -1` confusion caused by launching a duplicate tunnel for an already-managed profile.


## 0.3.1 — 2026-09-18

- Fixed Windows one-time autostart enrollment when the same tunnel profile is already running on its configured health port.
- Existing DPAPI credentials are reused on reruns, so a failed validation does not require entering the Runtime API key again.
- Enrollment now recognizes an already-ready matching tunnel and skips the conflicting `doctor` listener bind check.
- Verified persistent Windows startup registration, MCP auto-restart, and tunnel kill/restart using the DPAPI credential with no repeated Tunnel ID, port, or API-key entry.


## 0.3.0 — 2026-09-17

Cross-platform, multi-topology and zero-reentry startup release.

- Added Windows + Linux core runtime support and Linux amd64/arm64 installer paths.
- Added one account -> many computers and many accounts -> one computer deployment support.
- Added concurrent-chat stress coverage and path-scoped mutation locking.
- Added automatic tunnel health-port selection for additional accounts.
- Added Windows logon supervisor with DPAPI-protected per-profile Runtime API keys.
- Added Linux supervisor with systemd-user/crontab registration and user-only credential files.
- Added automatic MCP/tunnel restart supervision after login or transient process failure.
- Added portable direct executable execution for safe-mode project commands.
- Added Windows + Ubuntu CI matrix configuration and cross-platform security audit.
- Validated real Ubuntu/WSL Standard and Power Mode installs, including official OpenAI tunnel-client SHA-256 verification.

## 0.2.1 — 2026-09-17

- Added repeatable repository security audit (`npm run audit`) covering current tracked files and Git history.
- Added `SECURITY_AUDIT.md` with verified findings and privacy notes.
- Added click-by-click setup guides in 10 languages: English, Persian, Arabic, Turkish, Spanish, French, German, Russian, Simplified Chinese, and Japanese.
- CI now checks full Git history and runs the security audit after syntax and smoke tests.
- Added a tested one-command Windows installer with optional prerequisite installation, official tunnel-client checksum verification, Standard/Power Mode selection, local validation, and optional server startup.
- Added one-command install instructions to all 10 language guides.

## 0.2.0 — 2026-09-17

Power Mode release.

- Added explicit Power Mode with local-only `config.local.json` preference.
- Added full-filesystem file I/O, metadata, copy/move/delete, recursive search, direct PowerShell, process controls, and persistent terminal sessions.
- Public configuration remains safe-by-default with Power Mode disabled.
- Local policy can keep permanent delete disabled and blocks shutdown/restart/logoff patterns.
- Added `POWER_SMOKE_PASS` regression coverage and live v0.2 MCP E2E validation.

## 0.1.0 — 2026-09-17

Initial public release.

- Local Windows MCP server on loopback
- OpenAI Secure MCP Tunnel workflow
- `system_status`, `list_directory`, `read_text`, `write_text`, and `run_project_command`
- realpath filesystem containment
- write backup + SHA-256 precondition support
- executable allowlist and selected eval blocking
- JSONL audit logging
- legacy and modern MCP protocol support used by ChatGPT tunnel sessions
- end-to-end validation from ChatGPT UI for list/read/write/command paths
