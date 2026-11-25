## 0.11.0-dev.105 — dev23-based V1-05 source-integration preview (2026-11-07; NoPromote)

- Exact base: `40256873627780cc7b62359935e43bac5ef856b3`, recovered from `/home/aliemad/.local/state/chatgpt-remote-commander/releases/v0.11.0-dev.23-402568736277`. Its package/Core/manifest identify `0.11.0-dev.23`; its `.git` HEAD is detached at this exact commit.
- V1-05 accepted commit ported in isolated worktree: `110f25ceef30c2058a886c04dc2d0d699c549ec0`; 9 files / 580 insertions / 30 deletions, no cherry-pick conflict. This is the committed V1-05 delta only; its later uncommitted working-tree edits are not silently included.
- Release identity synchronized to `0.11.0-dev.105`. The train's `sourceBaseSha` remains historical baseline `c057494329490257e3d79046ea7599c60dde1e89`; it is shared by the dev23 base, main and dev19 branch and is not the current source commit.
- Commander 2 / `mmz/v2-unified-candidate-20261103` (`0.11.0-dev.19`) was inspected but deliberately not merged. V1-00 explicitly selects exact dev23 as the V1-08 base and forbids substituting dev19 RemoteCommanderV2 or artifact-heavy Main. The V2 branch remains unchanged.
- The dev23 release root has uncommitted V1-03 GUI changes in `src/gui-tools-windows.mjs`, `src/workspace-tools.mjs`, plus untracked `tools/gui-control-x11.py`. They remain preserved in the original root and are excluded from this clean preview pending V1-03 acceptance; this preview therefore does not claim parity with those live GUI overlay changes.
- Windows updater cleanup now binds both pre-registration candidate objects to `$stage.Version` and checks `$Candidate.Version` during the native owner-attestation fallback, avoiding the previous hard-coded dev23 mismatch.
- Qualification: `npm run check` PASS; candidate-scoped `npm run audit` PASS after removing only temporary local Commander2 audit refs; `npm test` exit 0 with no failures (main TAP group 637 PASS / 17 platform skips; auxiliary suites also exit 0); workflow 314/314; Release Train 4/4; SemVer 4/4; updater contract 39 PASS / 4 skips; browser monitor 4 PASS / 2 Windows-only skips; Windows PowerShell Parser PASS for updater SHA256 `3ed00e806a17f4852aa8ad6390e8b707ddf8cc5aedcc535708112acf33ffa91b`; staged and unstaged `git diff --check` PASS.
- No immutable full-product commit, Builder artifact, install, route switch, service restart, public release, autoupdate enablement or Stable promotion is performed. Cross-owner source freeze, current V1-03/V1-01/V1-06/V1-07/V1-09/V1-10 integration, V2 package provenance and real G1/J01/ACK/boot-login/canary/rollback remain open.

## 0.11.0-dev.23 — isolate owner-session CUA channels (2026-11-01; development / NoPromote)

- Bind each owner broker channel to a separate named CUA pipe: rc-workspace-cua-v038-active versus rc-workspace-cua-v038-candidate. The workspace CUA adapter accepts only those exact channel names and rejects a shared legacy/foreign endpoint.
- The versioned launcher resolves the pipe from its authenticated manifest channel, validates the exact same-session CUA process identity and refuses ambiguous or unowned ready pipes. It may start only its own exact-channel CUA child for an actual broker run.
- Launcher SelfTest performs no CUA pipe probe, driver start, GUI observation or desktop input; it validates the channel-bound runtime/config/manifest and reports cuaPipeReady=false. Candidate preparation therefore cannot share or disturb the active v0.11.0-dev.18 CUA pipe.
- Add deterministic active/candidate/invalid-pipe regression tests. No scheduled-task change, broker start, browser interaction or live model call. NoPromote.

## 0.11.0-dev.22 — owner-session candidate handoff and runtime pinning (2026-11-01; development / NoPromote)

- Add a Windows owner-session candidate preparer for a distinct sidecar profile/port. It requires the owner interactive SID, a verified dev/NoPromote source release, exact broker/launcher hashes, pinned Node version/SHA, pinned CUA driver SHA, and a free candidate port. It creates candidate config/manifest using CreateNew and refuses conflicting pre-existing candidates.
- Extend the versioned owner launcher and broker to verify owner SID, launcher hash, Node runtime hash/version and release-package version. Fail closed when the candidate port is occupied. Self-test returns safe identity/evidence only.
- Candidate prep/launcher never changes the active owner config, existing Scheduled Task, active broker or live desktop. The preparer starts no candidate broker; separate owner-session staging and tool-catalog verification remain open.
- PowerShell 7.6.8 AST checks pass for launcher and preparer. Full npm check, isolated npm test and security audit pass on the source candidate; all release/promotion flags remain false. NoPromote.

## 0.11.0-dev.21 — versioned owner-session broker packaging (2026-11-01; development / NoPromote)

- Bring the owner-workspace broker adapter into canonical source and the deterministic installer payload, alongside a versioned hash-verifying owner launcher. The launcher binds owner SID/name, interactive session, config/profile/loopback port, release-root containment and exact broker/CUA SHA-256 values; it can self-test without starting/replacing a broker.
- Restrict the packaged broker to the existing workspace-only tool catalog. Remove the inherited generic owner_session_shell PowerShell execution tool and ad-hoc driver diagnostic. Set mouse, keyboard, window focus and browser input/fallback permissions false in the broker context; keep loopback-only, timing-safe bearer verification, Origin rejection, bounded request size/concurrency, exact owner/session checks and existing native UIA policy.
- The launcher binds the interactive Windows owner SID as well as account name/session, validates Node/CUA/broker/launcher hashes and version, and reserves a channel-specific candidate named pipe and loopback port. Candidate self-test performs no CUA start or window discovery. At runtime it refuses any pre-existing matching CUA process (including an orphan) rather than killing/adopting it; it stops only the exact child it launched. It does not create, modify, stop or retarget Scheduled Tasks.
- New owner-broker release contract tests verify the reduced API and installer inclusion. Candidate-only; no task switch, sidecar install or live GUI operation yet. NoPromote; publish/autoupdate/install flags remain false.

## 0.11.0-dev.20 — align owner-proxy deadlines with native UIA effect bounds (2026-10-31; development / NoPromote)

- Correct an owner-broker response timeout mismatch: native UIA Observe has an 11s child-process bound and SetValue/Invoke have 16s bounds. The prior 6.5s generic owner-proxy deadline could return before the owner-session operation produced its durable result.
- Use 14s for native Observe and 22s for native SetValue/Invoke, leaving bounded response headroom while preserving all native process limits, owner-session authorization, request IDs and uncertain-effect journal behavior. Browser-specific deadlines and unrelated tools remain unchanged.
- Add deterministic owner-proxy regression assertions for the three native deadlines. No extension of native effect timeouts, authority, GUI focus, keyboard, or retry policy.
- Development candidate only. NoPromote, no installation, publication, or live Personalization browser test.

## 0.11.0-dev.19 — exact-window Windows UIA text entry (2026-10-31; development / NoPromote)

- Add a distinct owner-session Native Windows UIA SetValue path for enabled, non-password Edit/Document controls bound to one exact PID/HWND/application and a fresh single-use fingerprint. Text travels over redirected UTF-8 stdin only; result exposes length, SHA-256 and exact native readback status, never field contents.
- Keep InvokePattern separate from text entry, require a fresh observation, explicit per-effect consent and durable at-most-once/uncertain-effect journal. No SendInput, SendKeys, clipboard or blind retry.
- Delegate UIA only through the authenticated interactive owner-session broker; reject Session 0/SYSTEM. Respect the existing allowKeyboard=false and allowWindowFocus=false policy. Invoke without focus permission requires the exact target already foreground; a focus transition requires a separate explicit authorization plus the native policy gate and exact HWND/PID postcheck.
- Candidate commit 28710406d8206d171e4d26fc90b01c81e25d3dec is local-only and based on PR #434 head. Native PowerShell 7.6.8 parser PASS; complete npm run check exit 0 (final aggregate 39/39), npm run audit PASS, focused UIA/owner-proxy tests PASS. Session 0 guard was exercised and rejected before GUI inspection.
- NoPromote: no GitHub push/PR, release tag, installer, owner-broker deployment, live Brave input, model evaluation or fleet acceptance. Installed 0.11.0-dev.18 remains active. Exact Personalization Brave target must be re-identified before live tests; independent security review and explicit release/install approval remain open. All nine release-train acceptance flags stay false.

## 0.11.0-dev.18 — GNOME Firefox semantic input, development / NoPromote

AT-SPI is a distinct owner accessibility route requiring exact PID/HWND, focused window, current explicit takeover authorization and fresh one-shot accessibility element receipt. The original multi-monitor native pointer guard is unchanged. The browser's existing profile and institutional authentication are not copied or inspected. Pilot owner GTK control QA is PASS; real Firefox mutation and 52 P12 searches need independent authorization-scoped verification.

## 0.11.0-dev.17 — owner GNOME per-window monitor binding, development / NoPromote

Targeted Firefox dual-monitor correction after real Emad host observation: prior `workspace_target_snapshot` produced display 0 even though an owner Firefox window was reported on another display. Add verified `Meta.Window.get_monitor()` and `get_frame_rect()` to native inventory, persist monitor/window geometry per lease, require matching target and reject off-window coordinates; candidate-source acceptance and exact native readback are separate mandatory gates. Existing dev.16 pilot remains active until accepted promotion. No credentials, browser profiles or cookies are read.

# Remote Commander suite — 0.11 release train
**Opened:** 2026-10-27 · **Status:** INTEGRATION CANDIDATE / NO PUBLIC RELEASE / NO HOST PROMOTION

## 0.11.0-dev.16 — Workspace Target and local Runner QA, development / NoPromote

New `workspace_target_*` tools route exact existing owner-window identity through the native GUI contract; this does not copy Firefox profiles or use WebDriver for the live user's browser. CUA/GUI authorization, fresh frame, owner consent and negative cross-session tests remain required. Local Ollama `qwen3:4b-instruct` on Emad Linux independently completed one read-only enrolled Runner E2E with `PROJECT_ACCEPTANCE_VERIFIED` after increasing bounded provider timeout to 24 seconds. No cross-host unattended execution or Stable promotion is inferred. All release acceptance flags remain false.

## 0.11.0-dev.15 — retain accepted fifth transfer peer without second engine

Direct installed source comparison on MMZ Linux and Windows Emad identified a single PEERS enum delta in the native transfer adapter: missing MMZ. The canonical adapter now enumerates PC/Linux/MMZ/EmadServer/Amirreza; transport, source/destination allowlists and confirmations remain unchanged. Regression uses static metadata only. Legacy .candidate.mjs implementations remain non-authoritative evidence, not a second engine. Separate takeover-enabled GUI candidate is unaccepted and must not be silently promoted. Full suite/public release and all-host acceptance remain NoPromote.

## 0.11.0-dev.14 — targeted R157 hosted Windows autotick scheduling correction

The verified GitHub R470 diagnostic for dev.13 identifies a single native non-Codex command-provider autotick test failure under loaded Windows R157; the identical isolated test passes on Windows Emad. Run the unchanged test file exactly once before high-volume Windows qualification groups. No test skipping, timeout relaxation, auto elevation, GUI capability change or production promotion. The version remains development / NoPromote until exact-SHA hosted R157 and component/fleet acceptance pass.

## 0.11.0-dev.13 — preserve per-host local GUI, profile and tunnel fixes

The active installed 0.10.26 trees on Aliemad Linux, MMZ Linux and two Windows servers contain *substantive owner-local tracked differences*. Bring matching owner-local source into the one upstream release branch: Windows shared-account inherited/read-only enforcement and owner policy SHA guard, Linux Control Center multi-profile evidence, and MMZ quarantine preservation. Do not override current common dev-aware updater monotonicity with older installed parser code. Full test suites, per-user/profile role isolation and native installation/cutover receipts are required independently. NoPromote until accepted.

## 0.11.0-dev.12 — Windows qualification check HTTP readiness isolation

Full native `0.11.0-dev.11` `NoPromote` on headless Emad Windows Server failed solely in `workflow-http.test.mjs` under `npm run check:qualification` with an HTTP health timeout; same original test passed 4/4 in isolation. Move the existing Windows HTTP fixture groups for the **check** gate ahead of loaded general tests without changing deadlines, assertions, capabilities or permissions. Preserve all previous development failures and accept new build only on its own exact-head receipts.

## 0.11.0-dev.11 — bounded Windows qualification per command (NoPromote)

Exact `dev.10` R157 isolated native preflight and `check` passed but `test` aborted *before any suite* because index-only qualification markers made the **aggregate** `cmd.exe /c` command too long (`R157_PHASE_WINDOWS_CMD_LENGTH`). Same exact source's `npm test` passed outside R157 on Windows Emad and Windows Amir. Replace only the R157 opt-in Windows execution strategy with strict sequential independent `cmd.exe` invocations for each validated original `node` segment, keeping start/pass numeric receipts and stopping on first nonzero. A segment over 7000 characters or an unsafe/ambiguous group still fails closed. Preserve full test coverage, production Core execution semantics and all security gates. Hosted exact-head R157/R173 must requalify.

## 0.11.0-dev.10 — deterministic waiting-budget test under Windows fixture load (QA-only)

Dev.9 real Windows full-suite failed a 1s synthetic input-wait budget before it could enter WAITING_INPUT, plus strict team fixture cancellation under load. The team reservation test stays **exactly six seconds, unchanged** and is already independently prioritized cold in Windows CI. Only the synthetic human-waiting test's initial execution duration is raised to 10s; the full real 1.1s wait, deadline extension and resume assertions remain. No runtime budget or security policy changes. Source remains NoPromote; R157/R173 require exact-head hosted qualification. Linux GUI fixture also injects an isolated synthetic GNOME Gio schema for KDE/headless test hosts; no system GSettings changes or runtime GUI capability widening.

## 0.11.0-dev.9 — LF-normalized Git blob for Windows router helper (source-only QA)

Hosted R170 on dev.8 promoted and rolled back Linux successfully (`PROMOTE_CODE=0`, `ROLLBACK_CODE=0`) but failed the final source-clean check (`R170_SOURCE_CHANGED`). Independently reproduced a dirty clean checkout: Git blob `2cfa8b57d485c03795a56291f1516813b2476797` stored 37 CRLF line endings despite `.gitattributes` `text eol=crlf`; worktree status immediately showed ` M tools/router-commandline-windows.ps1`. Normalize only that Git blob to LF, preserve CRLF platform checkout and test the exact Git blob so the invariant cannot silently regress. This does NOT assume it was the only R170 dirty path; hosted exact-SHA R170 must confirm. Windows R173 and R157 still require independent correction and hosted proof, and all fleet promotions remain forbidden before those gates.

## 0.11.0-dev.8 — Windows Parser/R157 qualification correction

Dev.7 Windows native PowerShell ParseFile failed (20 diagnostic errors at malformed prerelease route expression). Dev.8 reconstructs from known good dev.6 script and applies exact two route guards and shared comparison without string-template expansion. CI's R157 postcondition validates a qualified version **and** the all-false development NoPromote manifest. Exact SHA Windows parser, R157, R173, Linux R170, full CI and real rollback are still independent OPEN gates. Five live working Core 0.10.26 routes must be preserved.
## 0.11.0-dev.7 — one bounded SemVer parser for both Native Updaters

One shared Node comparison (strict stable/dev.N/rc.N, fail-closed malformed versions) feeds both Windows and Linux native updaters. Linux update receipt serializes a bounded candidate version; route guards accept a legitimate prerelease identifier. The public Stable discovery path remains exact stable tags and explicit NoPromote flags remain false. **Not yet promoted**: requirement to reproduce hosted R170/R173/R157 plus native rollback and then five-host cutover remains open. Independent CI test step prevents repeating Windows command-length regression.

## P0 fleet task usability — 2026-10-27 (user's current first priority)

The overriding delivery order is **make all five current computers useful for real work**, retaining their existing working Core `0.10.26` routes until the replacement passes native rollback. This does **not** authorize new broad Administrator/root privileges, interactive input without consent, a premature 0.11 release, or silent overwrite of dirty checkouts. The exact observational record, scope and incident ID are in existing [PROJECT_BRAIN](PROJECT_BRAIN.md#rc011-fleet-ops-20261027--five-host-work-ready-smoke-blocked-gui-paths); this roadmap tracks next acceptance only.

| Immediate operational gate | Direct five-host evidence | Unclosed DoD |
| --- | --- | --- |
| OPS-1 Core / Shell / Files / Git | **5/5 PASS**: distinct MCP endpoint, temporary write/read/cleanup, Node/Git, primary localhost Health 0.10.26 and dev.3 sidecar Health | Preserve routing and rollback path; no further change required for safe baseline work |
| OPS-2 Browser for routine web tasks | **5/5 PASS**: isolated background owner-only session begin → local navigation → DOM observation → session end; all `userDesktopTouched=false` | Confirm separately packaged CEF browser, authenticated profile isolation and site-specific consent before claiming all Browser Commander features |
| OPS-3 Durable project state | **5/5 DB integrity PASS**; Scheduler enabled, **automatic execution OFF**; only MMZ has read-only proposal Runner | Validate per-project consent, output receipts, stop/revoke and restart; no mass resume of historical persisted nonterminal records |
| OPS-4 GUI work on desktops | Windows Emad **observe-only** (mouse/keyboard disabled); Linux Emad ambiguous mouse incident **pending** but observe lease/window enumeration PASS; MMZ Wayland owner consent **not active** | For Windows owner-bound Cua connection without pipe ACL widening, Linux incident effect reconciliation before input reset, MMZ native Portal consent and E2E; no UI actions on headless servers |
| OPS-5 Multi-user / privilege | Per-user permanent Workers and centrally revocable grants **NOT DONE**; OS native tokens vary, FULL_POWER is not Admin/root | SID/UID+session-bound Workers; Control Center grant/expiry/revoke; narrow OS-elevated broker with native UAC/sudo/polkit and negative cross-user tests |
| OPS-6 0.11 replacement | All five primary hosts **still 0.10.26**, dev.3 locally available but not routed; dev.6 source only, native R170/R173/R157 promotions **FAIL** | Fix prerelease SemVer/real rollback and test each platform, package Core+CEF+ControlCenter+Mesh+Workers+Installer then guarded five-host primary cutover/readback |
| OPS-7 Stable | All nine suite acceptance flags `false` | Release 0.11 prerelease only after OPS-4/5/6; 1.0 Stable only after full independent acceptance and operational soak |

**Action rule:** For live work *now*, route authorized shell/filesystem/read-only project tasks and background-owned Browser through current verified connections instead of requiring an unqualified 0.11 rollout. Where an interactive operation is indispensable, provide the exact smallest owner-attended GUI approval path; keep unaffected machine operations running. Do not reintroduce the older problematic GUI user-session permissions by silently elevating SYSTEM or compromising another account. After native rollback is proven, migrate one host at a time without junctions, check all five, and retain one canonical product installation per host.


## Version rules
- Every code-changing integration must increment its source/pre-release identity with traceable commit, changelog and tests (`0.11.0-dev.N`, then `0.11.0-rc.N`).
- `v0.11.0`: one suite, all required products included, tagged and published as **GitHub Pre-release**, not Stable, only after required gates PASS.
- `v1.0.0`: **first Stable**, based on the same suite after all owner GUI, server headless, browser/login, cross-host, rollback, security and independent acceptance gates PASS. Never promote by changing the version string alone.
- Prior published Core `v0.10.20` and Browser `v0.8.1` are historical release artifacts, not accepted fully stable suite. Do not alter immutable tags/assets, and do not break legacy updater latest endpoints until the migration is verified.

## 0.11.0-dev.4 — opt-in offline local model provider and multi-user GUI architecture (NOT INSTALLED)

- Code increment: `tools/local-ollama-planner.mjs` implements a strict localhost Ollama JSON-proposal provider for the existing `kind=command` Runner; it returns **proposals only**, never executes tools. Bounded input/output/time, explicit model env `RC_LOCAL_AI_MODEL`, caller-supplied tool subset and fail-closed errors. Explicit opt-in sample: `provider.kind=command`, `provider.executable=/absolute/path/to/node`, `provider.args=[/absolute/path/to/tools/local-ollama-planner.mjs]`; `runner.enabled` and `autoTick` remain false until the owner separately configures accepted scopes. No Codex delegation.
- Multi-account target: one unprivileged same-OS-user worker per enrolled identity. The SYSTEM/service coordinator may schedule but must not read user DPAPI/profile or impersonate without legitimate token. Every worker binds SID/UID, session, device, short-lived grant, allowed operation+target, revision, audit and revoke. **Admin/root is not globally granted:** elevated operations require a separately OS-authorized broker with a narrow action allowlist, UAC/sudo/polkit consent and independent revocation tests.
- Cua Driver becomes preferred interactive GUI adapter **after** signed binary, same-user pipe, background noninterference, consent and revoke E2E. Agent-S4 supplies optional interface-planning research, UFO2/UFO3 app API/coordination ideas, UI-TARS visual fallback, OpenAdapt recorded replay and Xpra Linux independent X11 seats. These are optional adapters, not simultaneously privileged resident daemons.
- [REA](https://github.com/morluto/rea) (MIT) is lawful binary/app analysis and evidence collection **on authorized apps**, not GUI runtime. [colibri](https://github.com/JustVugg/colibri) (Apache-2.0) is disk-streamed MoE local inference; needs model/RAM/disk benchmark and is **not** the workflow orchestrator. Existing local Ollama/llama.cpp should be qualified first.
- Proof status: implementation and narrow unit tests only; not OS user-worker deployment, local-model semantic correctness, full CI, fleet promotion or Stable.

## 0.11.0-dev.6 — CI qualification command-size corrective gate (2026-10-27, NOT FINAL)

Dev.5 formally tested exact-manifest NoPromote version admission in both R170/R173 and separated dev Windows Server Canary evidence from stable allowlist requirements. Hosted R170 source version preflight passed; real promotion did not. CI and both Canaries failed the separate `R157_PHASE_WINDOWS_CMD_LENGTH` protection after inline Node test additions. Dev.6 restores the original bounded check/test scripts and moves new policy-negative tests to a dedicated CI step. Acceptance remains blocked until exact dev.6 CI, R170/R173/R157, Server Canary and actual 5/5 host integration show their own PASS receipts. The release-train manifest stays all false.

## Current cross-product delivery roadmap — 2026-10-27 (integrated architecture decided; acceptance NOT FINAL)

**Decision event `RC011-UPSTREAM-ARCH-20261027`.** The existing [PROJECT_BRAIN](PROJECT_BRAIN.md#rc011-upstream-arch-20261027--component-specific-last-release-decisions) holds the one evidence-backed upstream release inventory (as of 2026-10-27), alternatives, licenses and detailed host deltas. This Roadmap is the **single active suite-wide sequence**, superseding this section's earlier dev.3-only gate snapshot. No new authoritative Brain, Index, package-lock or mutable `latest` installed-version claim is created here.

### Frozen product boundaries and activation contract

- **Always required:** Core Node MCP server/Router/Tunnel; one stable per-host install and one correct chat/profile route; Control Center; device/user capability inventory, sessions and per-user grant/revoke; single Workflow/Project Engine (journal, scheduler, evidence/checkpoints, no blind retry); Transfer Mesh; native install/rollback and immutable source/asset provenance.
- **Platform-selected:** Windows owner-interactive same-user worker with Cua Driver (and validated UIA fallback), Linux Wayland portal/libei or separately isolated Xpra/X11 seat; Browser Commander CEF/Chromium built separately then pinned in the suite; headless Windows/Linux server without monitor/login dependence. The Core never impersonates user accounts from SYSTEM Session 0 merely because `FULL_POWER` is configured.
- **Optional opt-in capability adapters:** Playwright MCP, Chrome DevTools MCP, Agent-S4, UFO3 API/coordination patterns, UI-TARS visual, OpenAdapt replay, local Ollama/llama.cpp/colibri model providers, REA diagnostics, CoS workspace patterns and Codex Web capability design. They receive only explicit audited tool and data boundaries, no independent universal credentials, no parallel Runner or unapproved model/task enrollment.
- **Interface contract:** per-user `deviceId + identity SID/UID + session + profile + capability + target + lease revision` and `OBSERVE → AUTHORIZE → ACT → VERIFY → RECOVER`. Any uncertain effect blocks retries until externally reconciled. Owner may stop/revoke Worker; server and Browser use distinct authority profiles. OS elevation requires a separate authorized, revocable narrow broker (UAC/sudo/polkit), not automatic admin/root for everyone.
- **Upgrade discipline:** for every adopted external component discover its current component-specific stable release, compare pre-release/nightly, verify ABI/API/OS compatibility and license, pin exact tag **and commit/hash** and produce a reproducible lock/receipt; only then package. When newer upstream arrives, run delta qualification on the selected adapter before replacing that pin. Rollback retention is bounded evidence, not a second active install, and no junctions are created.

### Ordered delivery / acceptance matrix

| Gate | Current evidence (dev.4 exact source 08eb601) | Definitive DoD / sequence |
| --- | --- | --- |
| **P0-A Source/authority & version** | PR #409 Draft; source `0.11.0-dev.4`; all nine manifest component approvals `false` | Exact Core+Browser SHA, independent package and provenance, branch protection; all changes versioned only when modifying code; no public release until all nine verified |
| **P0-B CI installer blocker** | At exact source `34e39d4c`, hosted Ubuntu CI and clean Ubuntu Server Canary PASS; R170/R173 **source admission PASS** but actual promotion **FAIL** (`PROMOTE_CODE=3` / `R185_PROMOTE_NOT_ACCEPTED`); R157 **FAIL test gate**. Windows CI/Server Canary were IN_PROGRESS at last read. | Read bounded R170/R173/R157 promotion artifacts, fix updater prerelease SemVer without enabling release authorization, rerun exact-source Windows/Linux genuine promotion + rollback, complete Windows canary; only then close P0-B. |
| **P0-C Suite packaging** | Core Candidate loopback 5/5 prior health; Windows & Linux Control Center preview QA scoped; independent Browser latest preview `v0.8.3-rc.3` not suite-integrated | Build one compatible Core+CEF+Control Center+GUI+Mesh+Workflow+Workers+Updater bundle per Windows/Linux profile, verified hashes, matched Browser commit/assets; availability and version readback by each platform |
| **P0-D Same-user Multi-User Worker** | Owner Windows SYSTEM Session 0; Aa.Emad Cua Session 1 observed; no cross-user worker E2E. Linux accounts/sessions differ | Account enroll/discover, OS identity binding, no DPAPI/profile leakage, per-tool ACL grant/expiry/revoke, negative cross-user tests, Control Center visibility, owner consent; accepted on actual hosts |
| **P0-E Native GUI + headless** | Cua Windows owner process found, pipe not accepted; Linux Xpra absent; Wayland Portal grant issues; Windows server non-elevated token on Amir | Cua isolated latest **eligible** Driver candidate background nonfocus/action/verify E2E in owner session; fallback UIA/Portal/Xpra only if matched; monitorless servers remain GUI-independent; stop/revoke safety and uncertain effect tests |
| **P0-F Local AI scheduling** | Ollama Linux Emad `qwen3:4b-instruct` live `block` proposal PASS in read-only scope; adapter unit 7/7 PASS; no autonomous enrollment | Local model quality/rate/resource tests, exact Runner allowed tools and event budget, explicit workflow enrollment, autoTick scheduler timed tests, pause/restart/resume/revoke and independent evidence. No self-grant/shell/secret prompt |
| **P0-G Five host controlled primary rollout** | 5/5 production Core `0.10.26`; 5/5 isolated source `0.11.0-dev.3`, not routed production | In-place guarded installation with correct accounts and routes on **all five hosts**, version and E2E readback for every required component, checksum and full workflow/Browser/GUI/Transfer/ControlCenter tests; verified reversible rollback, preserve dirty trees/owner data, no junction |
| **P0-H Release** | `v0.11.0` and `v1.0.0` NOT AUTHORIZED; old releases historical | Publish `v0.11.0` GitHub prerelease only after required P0 acceptance; `v1.0.0` Stable after soak/recovery, security and independent owner review, with installer and updater migration evidence |
| **P1 structured Browser / replay / visibility** | CEF independent source; Playwright/DevTools/OpenAdapt considered, not deployed in 0.11 | Independently pinned adapters, owned-profile privacy, positive/negative E2E, no cookie transfer, operational telemetry and bounded artifact logs |
| **P1 transferable models + GPU** | Emad Linux Ollama real; MMZ NVIDIA 6GB API unavailable; Windows Emad RTX3080 10GB; servers VMware SVGA; colibri candidate only | Same prompts/accuracy/latency/RAM/disk/privacy/cost across Ollama, llama.cpp and colibri on each qualified machine; measured fallback/timeout; no uncontrolled model downloads |
| **P2 later multi-agent scaling** | OpenHands/LangGraph/Temporal/Graphiti and unrestricted upstream integrations NOT required | Compare measurable workload advantage before migration; no second scheduler, graph or state authority without test-proven benefit |

**Critical next executable decision:** P0-B now moves beyond source-admission into **actual updater SemVer and native rollback**. Collect scoped R170/R173 promotion/rollback artifacts and R157 inner test failures; correct only the prerelease comparison/result serializer and gate dispatch proven faulty, preserving exact SHA/NoPromote and historical Stable path. Qualify with negative tests, rerun Linux/Windows R170/R173/R157 and clean Server Canary. Then build P0-C and validate P0-D/E/F with each OS owner. Never perform a primary five-host cutover while native rollback is failing. Independent hardware/model benchmark work remains safe without touching dirty source or installed services.

### Per-host optimized adapter / inference assignment — measured 2026-10-27

| Host | Measured RAM / free disk / GPU | Inference and desktop policy |
| --- | --- | --- |
| Emad Windows | 127.8 GiB RAM; 582.6 GiB free system disk; RTX3080 10 GiB | First candidate for larger local AI/colibri benchmarks, not automatic model downloads; owner-seat Cua Driver bounded manifest, separate browser/desktop runtimes |
| Emad Linux | 14.5 GiB RAM, 7.9 GiB available; 214.9 GiB free home; AMD Barcelo | Existing Ollama `qwen3:4b-instruct` proposal-only baseline; avoid heavy resident MoE and foreground GUI assumptions |
| MMZ Linux | 15.3 GiB RAM, 9.3 GiB available; 135.9 GiB free home; RTX4050 6 GiB | Evaluate small quantized model after local consent and installation; native Wayland Portal; Ollama currently unreachable |
| Amirreza Server | 65 GiB RAM; 85.2 GiB free system disk; VMware SVGA 3D | Headless Core/Transfer/Workflow, CPU-only inference optional; no elevated token and no GUI dependency |
| Emad Server | 65 GiB RAM; 264.3 GiB free disk; VMware SVGA 3D | Headless Core and already-running Ollama service; model availability/benchmark not yet verified |

These readings are ephemeral capacity observations, not acceptance of local AI performance or an authorization to allocate every available byte. Cua [bounded permission](https://cua.ai/docs/cua-driver/guides/permissions) requires a time-limited capability manifest; do not combine origin-restricted browser and general desktop-control scope in one runtime.

### Upstream version and source verification

See the current [PROJECT_BRAIN source selection table](PROJECT_BRAIN.md#rc011-upstream-arch-20261027--component-specific-last-release-decisions): Cua Driver v0.38.0 (release API marks prerelease; 0.38.1-nightly excluded from rollout), Agent-S4 source SHA (not 2025 v0.3.2), UFO3 v3.0.10, UI-TARS v0.3.1, OpenAdapt flow v2.4.0/desktop v0.24.0, Xpra v6.5.5, REA v6.8.0, colibri v2.0.0, Ollama v0.40.11, MCP SDK v2.4.0, Playwright MCP v0.0.83, Chrome DevTools MCP v1.12.0, CoS v2.1.46, Codex Web v6.1.14, Cosign v3.1.4, and distinct Browser stable v0.8.1 / RC v0.8.3-rc.3. These are research candidate identities only, **not installed pins**. Keep exact version/tag/SHA of each accepted component separate from development head, and refresh the live upstream check before actual adoption.

**Coverage limit:** 680 tracked Core Candidate file bytes were read/hashed and 107 independent Browser paths enumerated; full account-wide chat transcripts, untracked files on five systems and semantic audit of every revision are not exposed/accepted. Current BRAIN_COVERAGE stays INCOMPLETE. Notion remains NOTION_SYNC_PENDING after explicit quota failure; no duplicate records created.


## Authoritative scope
Core, Browser Commander (including independent CEF UI), Control Center / user permissions, headless Windows servers, Linux desktops, GUI same-user private seats, Transfer Mesh, Project/Workflow Engine, local AI & scheduled Workers, profile/login ownership, deployment & updater. Browser has a separate source repo and release line; its independently versioned build must be pinned by SHA in the eventual suite release manifest. No unverified external components can silently count as integrated.

## Mandatory gates
1. Exact source SHA, protected CI, native tests, source-integrity and security review.
2. Verified multi-product build/package manifests, signing/provenance and supported Windows + Linux installers.
3. Five real-host installation, tool/API/Router/Browser/GUI/TransferMesh/Workflow + Control Center E2E, with real same-user session and headless server acceptance.
4. Native user consent, DPAPI/login isolation, persistent per-user grant/revoke and appropriately elevated OS access.
5. Reversible release promotion/rollback and retirement of old process/installer launch paths; no legacy Junction aliases.
6. Project Brain / release log reflects actual PASS or open gates; no auto-open of GUI, cookie sharing or blind retries.
7. Before any retroactive GitHub prerelease reclassification of historical public releases, verify each legacy updater will not break when `releases/latest/download` changes/disappears.

This initial `0.11.0-dev.1` change only aligns the source version train and policy. Every unaccepted gate remains false in `docs/release-train-0.11.json`; no claim of operational `0.11` or `1.0`.


## 0.11.0-dev.2 — candidate-only bootstrap correction (2026-10-27)

Core, Plugin, Codex Plugin, Windows UI numeric assembly identity and suite manifest advanced together from dev.1 to dev.2. Server bootstrap admits prerelease only with exact matching development manifest whose release/publish/autoupdate/promote flags are all false. Historical 0.10.25 rollback QA now skips this development version. R170/R173 rollback, public packaging, native acceptance and fleet promotion remain open; this is not an install approval.


## 0.11.0-dev.3 — candidate identity qualification (2026-10-27)

Retain historical 0.10.26 release policy regression while accepting the exact all-false 0.11 development manifest for cross-platform source identity. Does not relax native rollback/installed suite acceptance or authorize release.
