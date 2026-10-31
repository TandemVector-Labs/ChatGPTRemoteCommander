# Project Brain — ChatGPT Remote Commander

## HISTORICAL AUDIT — 2026-10-27: cross-product evidence and architecture

### RC011-WINDOWS-PARSER-20261027 — dev.8 fail-closed repair
Dev.7 source exact `ac5044e66e71f8860bb26c8d6c1034264353878d`: Linux scoped tests 42 PASS/4 Windows-specific SKIP. Hosted Windows R157 failed at native Parser preflight; R173 exited immediately without last-update receipt. Direct Emad Windows disposable exact-head clone and PowerShell ParseFile returned 20 errors beginning at line 982. Root cause: regex replacement in the dev.7 integration inserted JavaScript replacement-template suffix substitution (`$'`) into PowerShell, truncating two route regexes and duplicating text. Dev.8 rebuilds Windows updater from known dev.6 source and safely reapplies bounded native SemVer helper calls + two prerelease route regexes. R157 isolated source postcondition also required only `major.minor.patch`, now strengthened with exact all-false dev manifest admission. CI/root-cause acceptance still PENDING; do not mark R173/R157 PASS until independent Windows hosted checks, and do not mutate any of five production installs.
### RC011-SEMVER-20261027 — dev.7 source correction, scoped acceptance only

CI failure provenance: dev.6 hosted CI and Windows/Linux Server Canary passed; isolated Linux real rollback R170 produced `PROMOTE_CODE=3`, Windows R173 `R185_PROMOTE_NOT_ACCEPTED`, Windows R157 `GATE_FAIL test exit=1`. Precise promotion logs are preserved as GitHub Action artifacts and not fully read in this tool session. Source inspection found Linux `write_update_result` rejected development labels with exit code 3, Linux `version_gt` required three numeric fields, Windows `Test-VersionGreater` used `[version]` and Windows pre-stage route guards rejected prerelease. Dev.7 adds deterministic shared prerelease compare CLI/negative unit tests and fixes these contracts, **without** relaxing latest-public-Stable discovery or any NoPromote manifest flags. This is a repair candidate, not proof that native promotion and rollback now pass. User's five-host actual-work priority remains: do not disrupt 0.10.26 shell/file/browser routes until all hosted and live-host guards pass. No multiuser GUI/OS elevation is granted here.

### RC011-FLEET-OPS-20261027 — five-host work-ready smoke, blocked GUI paths

**User priority:** Make all five existing machines practically useful for work **before** other feature expansion or publishing `0.11`. This is an operations-first acceptance track, not a release override. Date/source: live direct Remote Commander status, shell/file roundtrips and isolated-browser API calls on all five hosts during this conversation (2026-10-27). Event key `RC011-FLEET-OPS-20261027`. Privileged policy remains unchanged.

**Validated current fleet facts:** Each of Emad Windows PC, Emad Linux, Amir Windows Server, Emad Windows Server, and MMZ Linux responded via its distinct Commander MCP endpoint, `system_status version=0.10.26` with profile `FULL_POWER`; on each actual host, `http://127.0.0.1:47831/health` reported `ok=true,version=0.10.26` and isolated `http://127.0.0.1:48011/health` reported `ok=true,version=0.11.0-dev.3`. The developer sidecar is not the currently routed product. All five completed a unique temporary-file write/read/exact-value assertion/cleanup, `node --version`, `git --version` and two local health probes successfully (shell `exitCode=0`). All five also started a **Commander-owned isolated headless browser**, navigated to their own loopback Health endpoint, read a bounded DOM snapshot including `ok=true` and `version=0.10.26`, and successfully closed the borrowed browser session. `userDesktopTouched=false`, no user browser profiles/password stores, no external navigation. Different Windows/Firefox/Chrome backends used; this is usable Browser Automation, not acceptance of independently built CEF Browser Commander.

**Workflow engine:** `workflow_health` returned `ok=true,databaseIntegrity=ok` for all five. Scheduler enabled on all five, `automaticExecution=false` across fleet. Only MMZ Linux has an explicitly configured proposal-only read-text project Runner; others `runnerConfigured=false`. Large Emad PC persisted nonterminal count (807) and Emad Linux count (105) explicitly mean **historical persisted records, NOT 807/105 active jobs**; both have zero current leases. Do not mass-resume/delete these records or enable unattended tool execution without per-project source/authority reconciliation and safe bounded workflow enrollment.

**Interactive GUI exception matrix:**
- Emad Windows PC: GUI monitor available, `windows-user32-gdi` owner delegate in Session 1, `mode=observe-only`; policy `allowMouse=false,allowKeyboard=false`. Cua Driver owner process was previously observed, but the Core's `SYSTEM / Session 0` shell cannot legitimately inject into that user identity. Require authenticated same-user Cua/MCP bridge, explicit limited grant and noninterference/verify E2E. Do not expand named-pipe ACL.
- Emad Linux: `gui_status` reports `GUI_INCIDENT_REVIEW_REQUIRED`, incident `d560c678-a656-457e-8b92-88c503ab8e8f` from an ambiguous `gui_mouse_click` at 2026-10-27 12:40:49 UTC. An `observe` lease and read-only window enumeration (3 windows) succeeded; lease was closed. Input remains blocked pending same-effect reconciliation and owner/target proof. Do not auto-clear latch or blindly replay click.
- MMZ Linux: KDE Wayland portal backend available/input technically available but owner consent not active (`consentRequired=true,consentedSessionActive=false`); an existing lease was present during status. Do not steal lease or circumvent Portal consent; use separate authorized owner session.
- Amir and Emad Windows Servers: `screens=[]`, GUI `available=false`; this is expected for monitorless service design, **not** a reason to add artificial display or interactive RDP session. Confirmed Headless Shell/File/Browser tests on both. Amir service token non-elevated in prior OS audit; privilege-sensitive operations require native local authorization, not blanket Admin grants.

**P0 usability acceptance distinction:** five working Core remote shell/file/git and isolated browser plus healthy persistence are NOW evidenced on 0.10.26. This proves a useful **minimal task subset**, not full cross-account GUI/Browser CEF/Control Center/Transfer/Updater/system-wide privileges. Keep these working routes unchanged until `0.11` updater performs real native rollback; current isolated hosted R170/R173/R157 previously FAILED promotion. No host deployment, git dirty checkout mutation, sidecar switch, junction, account grant, display focus, Stable tag or external publication occurred in this five-host smoke.

**Immediate readiness dependency chain:** P0-OPS1 preserve current working MCP/Shell/File/Headless Browser routing for all five; P0-OPS2 reconcile Emad Linux GUI incident and Windows Cua same-owner bridge with consent, obtain MMZ Wayland Portal user consent; P0-OPS3 implement per-user Worker Grant/Revocation and restricted elevated broker, prioritizing Windows owner account and headless server paths; P0-OPS4 safely enroll only identified read-only workflow/AI tasks with explicit policy and test stop/restart/recovery; P0-OPS5 repair SemVer/native R170/R173/R157 rollback and then stage `0.11` fleet install, verifying all products individually. No stage claims PASS based on source code alone.

### RC011-HOSTED-QA-20261027 — dev.5 failure / dev.6 scoped correction

Source dev.5 `191ab2d5a2fd0a8ab967bb232e30ade8d2797be6` had local negative manifest/release identity/auto-update-contract tests 38 PASS, 4 Windows-only SKIP. Hosted exact-dev.5 R170's hardcoded-version preflight moved from FAIL to PASS (`RC011_DEVELOPMENT_NOPROMOTE_QA_VERSION_ADMITTED_ONLY`), but promotion remained FAILED. Hosted both-platform CI and both Server Canaries then failed because the additional inlined npm `check` / `test` commands exceeded the existing bounded Windows CLI grouping contract (`R157_PHASE_WINDOWS_CMD_LENGTH`), not because the server dev allowlist guard had been fully exercised. Dev.6 restores unchanged full-suite command-string length and moves negative policy unit tests to a separate CI step; native actual R170/R173/R157 and Windows+Linux Canary must be freshly qualified before passing. This is source/CI correction only. One writer used GitHub integration branch; five dirty host source trees and active production routes were not changed.

**Exact-dev.6 runnable follow-up and host fit (2026-10-27):**
- Source SHA `34e39d4c6016bdf4792a50c62db470f824ce064b`: disposable Emad Linux clone of exact branch and source yielded `55 PASS / 7 Windows-only SKIP / 0 FAIL` from combined concurrency, isolated-QA, release-train and auto-update contracts, Bash native script syntax; no OS privilege or source tree mutation. GitHub Linux CI job **PASS** and Ubuntu clean Server Canary job **PASS** at this SHA. Hosted Windows CI and Windows Server Canary were **IN_PROGRESS** when last read; do not infer PASS.
- Hosted R170 and R173 both passed the new **exact development source NoPromote admission**. The real isolated promotion phases then **FAILED**: Linux R170 `PROMOTE_CODE=3`, Windows R173 `R185_PROMOTE_NOT_ACCEPTED`; Windows R157 `GATE_FAIL test exit=1`. These are separate failures, not just the previous 0.10-only source allowlist. Updater Linux `write_result` currently rejects any version not `major.minor.patch` with exit code 3 and `version_gt` excludes prereleases; Windows `Test-VersionGreater` casts to `[version]` and does not support prerelease strings. These are source-identified high-priority SemVer incompatibility candidates, but the **full root-cause attribution for R170/R173 requires their captured promotion stdout/stderr artifacts** and R157's failed test details; do not declare it fixed or promote owner machines.
- Hardware, runtime and deployment fit **read directly on each connected host**: Emad Windows 127.8 GiB RAM / 74.7 GiB available, 582.6 GiB free system disk, RTX3080 10 GiB VRAM, Cua Driver process in owner Session 1; Emad Linux 14.5/7.9 GiB RAM total/available, 214.9 GiB free home, AMD Barcelo iGPU, local Ollama active with `qwen3:4b-instruct`; MMZ Linux 15.3/9.3 GiB RAM, 135.9 GiB free home, RTX4050 6 GiB, Ollama endpoint unavailable; Amir Windows Server 65/56.9 GiB RAM, 85.2 GiB free system disk, VMware SVGA and non-elevated token; Emad Windows Server 65/48.7 GiB RAM, 264.3 GiB free disk, VMware SVGA and Ollama process present. These are **point-in-time resources, not reservations**.
- Resource decision: use existing small local Ollama model first on Emad Linux; evaluate a more capable quantized local planner on Emad Windows only after latency/quality/privacy benchmarking; MMZ 6 GiB VRAM warrants smaller model tier; servers stay headless and should not depend on GPU or a human desktop. Evaluate colibri v2 separately only on systems with adequate RAM/disk/CPU throughput; no speculative model downloads or global GPU assignment. Choose Cua only for owner-attended Desktop Workers, never Windows Session 0 or headless server requirement.
- Official Cua permission contract [Set permissions](https://cua.ai/docs/cua-driver/guides/permissions): `bounded` mode mandates a capability manifest with time limits; unlisted tools and out-of-scope apps denied. Browser origin-restricted profile and generic desktop input should **not be in one runtime**; separate owner-bound Browser and Desktop workers to prevent policy cross-over. Platform mechanisms [How Cua Driver works](https://cua.ai/docs/cua-driver/concepts/how-cua-driver-works) confirm Windows interactive session requirement and Wayland limits. No unrestricted grants, no AGPL perception extension bundling before license review.

### RC011-UPSTREAM-ARCH-20261027 — component-specific last-release decisions

**Event/authority.** Active integration architecture decision and upstream-release research dated 2026-10-27; no external package or privileged service is installed by this record. Primary source: official GitHub repositories/releases read live through connected GitHub; tag refers to the identified component, not a generic monorepo `latest`. Release metadata are **candidate pins to qualify**, not accepted binary digests or auto-update instructions. Before deploy, freeze resolved upstream commit/tree, dependency lockfiles, hashes, licenses/NOTICE, compatibility/perf/security matrix, and offline artifacts. Always evaluate the newest applicable upstream component release available **at the time of admission**, but never auto-track a mutable main/nightly/rolling tag on deployed hosts.

**Architecture frozen for 0.11 testability.** ONE Core/Router/MCP/tool schema, ONE durable Workflow scheduler/journal/verifier and ONE policy/audit/lease authority in Control Center. Per enrolled OS identity, start a least-privileged signed authenticated short-lived User Worker with SID/UID+session binding, per-action allowlist and revocable lease. Worker adapters implement a versioned Observe/Act/Verify/Recover API; Cua Driver preferred for owner-bound native Windows/desktop, UIA/FlaUI fallback, Wayland portal/libei or optional Xpra isolated X11 desktop, Browser CEF + owned Playwright/CDP controls; OS foreground input requires consent and no-retry after uncertain effects. Distinct system-only Headless adapter for monitorless servers. Elevated broker optional and separately OS-authorized with bounded approved actions; never blanket root/Admin, bypass UAC/polkit, DPAPI/cookie sharing or globally enabled unrestricted permission. All adapters deny by default when user login/consent/session identity is absent.

**Runtime and AI.** Local model provider is a separate explicitly configured proposal-only command adapter (dev.4 source `tools/local-ollama-planner.mjs`); it never gains direct GUI/files/shell permissions. The existing Runner runs only explicitly enrolled workflows with validated tool grants, budgets, independent evidence checks, cancellation and recovery; autoTick remains off until a narrowly enrolled workflow has real-model E2E. Ollama is the first practical local provider where installed; colibri is benchmark-only MoE model execution (requires disk/RAM/throughput acceptance), not a second scheduler. Agent-S4 learns/evolves GUI tool interfaces in a sandbox; UFO³ Galaxy is a coordination reference; UI-TARS visual fallback and OpenAdapt repeatable demonstrations/recorded replay stay opt-in and gated. REA is a lawfully authorized research/reverse-engineering diagnostic, not an unrestricted production desktop engine. No new background agent process gets user access just because a repository is installed.

**Official component-specific upstream candidate inventory (last verified 2026-10-27):**

| System role / source | Newest relevant GitHub release or source at audit | License shown | Admission decision |
|---|---|---|---|
| Native GUI [trycua/cua](https://github.com/trycua/cua) | Driver `cua-driver-rs-v0.38.0` (GitHub marks prerelease); Driver `0.38.1-nightly.20261027` is *nightly*, **not** owner stable; Spaces `cua-spaces-v0.16.0` is a different component | MIT for core Driver; optional perception OmniParser AGPL-3.0 | Evaluate 0.38.0 signed artifacts in isolated owner seat first; no automatic nightly or AGPL extension embedding |
| Planner [SIMULAR-AI/Agent-S](https://github.com/SIMULAR-AI/Agent-S) | last public `v0.3.2` (2025-12); S4 on `main` at `0fff0e634869dab72027435b4586e62300185d41` (2026-10-21 commit), **not** presumed included in tag | Apache-2.0 | Research sandbox only; pin exact S4 SHA and independent benchmark |
| Multi-device [microsoft/UFO](https://github.com/microsoft/UFO) | `v3.0.10` | MIT | Evaluate Galaxy/MCP routing ideas; no rival scheduler |
| Visual [bytedance/UI-TARS-desktop](https://github.com/bytedance/UI-TARS-desktop) | `v0.3.1` | Apache-2.0 | Optional visual fallback, model/runtime requirements and focus safety testing |
| Replay [OpenAdaptAI/openadapt](https://github.com/OpenAdaptAI/openadapt) | `openadapt-flow-v2.4.0` and independent `openadapt-desktop-v0.24.0`; monorepo tags are component-specific | MIT | Opt-in deterministic recorded-workflow converter; no secret replay |
| Private Linux X11 [Xpra-org/xpra](https://github.com/Xpra-org/xpra) | `v6.5.5` | GPL-2.0 | External isolated executable only pending GPL/packaging check, not a Wayland portal bypass |
| Analysis [morluto/rea](https://github.com/morluto/rea) | `rea-agents-6.8.0` | MIT | Research/diagnostics only, with application-owner rights |
| Disk-streamed local MoE [JustVugg/colibri](https://github.com/JustVugg/colibri) | `v2.0.0` | Apache-2.0 | Benchmark optional, never assume faster than Ollama; verify RAM/disk costs |
| First local inference [ollama/ollama](https://github.com/ollama/ollama) | `v0.40.11` | MIT | Qualify with actual current model and bind loopback only |
| Native local inference [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) | `v0.7.0` | MIT | Provider fallback only after comparable quality/latency |
| MCP interface [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) | `v2.4.0` | GitHub repository SPDX NOASSERTION; inspect package licenses | Protocol conformance; no wholesale Core rewrite |
| Browser selector [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | `v0.0.83` | Apache-2.0 | Owned-profile, bounded permission-aware adapter |
| Browser diagnostics [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) | `chrome-devtools-mcp-v1.12.0` | Apache-2.0 | Opt-in local debugging; no remote authenticated CDP |
| Windows native UI [FlaUI/FlaUI](https://github.com/FlaUI/FlaUI) | public GitHub release `v5.0.0`; verify NuGet separately before claiming newer binary | MIT | Owner-session UIA fallback; no Session 0 UI |
| Windows specialist [microsoft/winappCli](https://github.com/microsoft/winappCli) | `v0.7.1` | MIT | Compare UIA API/CLI capability; no dual input controller |
| Workspace [totec448-spec/chat-on-steroids](https://github.com/totec448-spec/chat-on-steroids) | `v2.1.46` | MIT | UX and resume patterns, not independent backend daemon |
| Optional Codex bridge [miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web) | `v6.1.14` | MIT | Context/capability design only; respect existing no-Codex-launch policy |
| Access control [apache/casbin-node-casbin](https://github.com/apache/casbin-node-casbin) | `v5.51.1` | Apache-2.0 | Policy evaluator optional after native user grants/revoke |
| Telemetry [open-telemetry/opentelemetry-js](https://github.com/open-telemetry/opentelemetry-js) | `v3.0.0` | Apache-2.0 | Opt-in redacted local traces with storage limits |
| Binary provenance [sigstore/cosign](https://github.com/sigstore/cosign) | `v3.1.4` | Apache-2.0 | Verify signed release artifacts/provenance |
| Existing product [TandemVector-Labs/remote-commander-browser](https://github.com/TandemVector-Labs/remote-commander-browser) | `v0.8.3-rc.3` newest published prerelease; `v0.8.1` newest Stable | own product license to verify | Pin exact independent Browser commit and assets in 0.11 suite manifest after cross-OS E2E |

**Non-adoption boundary:** optional LangGraph/Temporal/Graphiti/OpenHands are comparison baselines only; adopting them would duplicate an existing working journal or agent UI before 0.11 integration. No wholesale cloning and no auto-upgrade to a prerelease because it sorts newer; use exact version by component after dependency and QA review.

**Real source CI at dev.4 exact SHA `08eb601ef13d47e037f9704fb317e00b0278d63a`:** CI, GTK R32/R35, Windows Control Center R34, Browser Linux canary, R39 UI, Release Sync and historical candidate rollback success. Linux native R170 FAIL, Windows R173 FAIL, Windows updater R157 FAIL and Windows Server Install Canary FAIL. Subset CI PASS does not transfer to the whole suite. The Canary previously confirmed Windows development installation itself PASS, then failed because the historical canary demanded a ProgramData production allowlist that a NoPromote developer installation intentionally does not write. Native R170/R173 reject dev versions in hardcoded 0.10 allowlists. Corrections must retain exact dev-manifest no-promotion and actually rerun full isolated promotion/rollback; never fake a production allowlist or relax guard on owner machines.

**Existing operational constraints:** 5/5 production Core 0.10.26 and isolated dev.3 localhost Candidate 0.11.0-dev.3 were previously observed, with divergent dirty host source roots and a different Browser head on Emad Linux. Dev.4 is source-only; no implied five-host upgrade. Cua Windows owner-hosted and Emad Linux Ollama are observed only in their real machine/session scopes. Whole-suite acceptance remains NOT FINAL. NOTION_SYNC_PENDING from previously rejected write (quota); do not spawn a shadow Brain.


### Increment RC011-LOCAL-AI-20261027 (dev.4; source-only pending exact-head CI)
User provided prior source/host evidence for Cua Driver 0.22.2 under Aa.Emad Session 1, InteractiveToken Git/DPAPI PASS and owner GUI record GUI-BROWSER-OWNER-WORKSPACE-001; these remain historical scoped evidence, not present multi-user/elevated runtime PASS. Current direct five-host shell observations independently confirm Emad Windows core executes NT AUTHORITY\\SYSTEM Session 0, Cua process exists in Session 1 and registered cua-driver-serve Task principal Aa.Emad uses InteractiveToken; actual pipe/control handshake remains untested. Emad Linux user-systemd Ollama active with model qwen3:4b-instruct. MMZ Linux has RTX 4050 6 GiB but local Ollama endpoint unavailable. Emad Windows RTX 3080 10 GiB, the two Windows servers report VMware SVGA 3D and only Emad Server shows Ollama running. The Linux desktops lack Cua/Xpra in PATH. Never infer these observations prove all-user OS elevations or GUI input.
Decision: keep single Commander journal/executor. Cua-first owner-bound GUI worker, Agent-S4 planning/evolution, UFO3 coordination concepts, UI-TARS vision fallback, OpenAdapt replay and Xpra private desktops are separate consent-scoped drivers. REA (morluto/rea) supports lawful evidence-led app/binary analysis; colibri (JustVugg/colibri) supports MoE inference from disk with resource/latency constraints, not a task scheduler. Do not merge independent external full daemons or expose privileged GUI/DPAPI via SYSTEM. No wildcard NOPASSWD and no bulk Administrator grants. New opted-in local Ollama planner adapter returns typed bounded proposals, checks declared tool names, targets localhost, never executes effects or enables autoTick by itself. Owner approval / exact-host permissions and independent end-to-end remain open.


**Current authority and event:** RC011-AUDIT-20261027; this is the current cross-product continuity checkpoint. Older CURRENT labels are historical provenance. Release admission authority remains in RELEASE_AUTHORITY.md, RELEASE_TRAIN_0.11.md and the all-false machine-readable docs/release-train-0.11.json; do not infer owner acceptance from this documentation change.

**Objective / DoD:** deliver one maintainable Remote Commander suite per Windows/Linux host, with Core MCP/Router/Tunnel, separately versioned CEF Browser, Control Center, profiles/permission management, consent-bound GUI, Workflow/Project Engine, bounded workers, Transfer Mesh and reversible Installer/Updater. The user-directed delivery path is v0.11.0 prerelease for five-host qualification followed by v1.0.0 first integrated Stable only after complete native and owner acceptance. No junctions, no destruction of uncommitted work, and no unverified Stable claims.

**Source-history and coverage evidence:** GitHub tree of pinned candidate a06fe7ec510d5629f2a9f45f347d105f8de3bfc6 contains 680 tracked Core files (761 tree entries), untruncated. Independent organization Browser main d04ae5b5b0129b7c2b199ee99a22bda6709edf66 has 107 tracked files. On the Emad Linux pinned Core candidate, a bounded read-only scanner opened and SHA-256 hashed the complete bytes of all 680 git-tracked files (6,471,162 bytes; no read errors), classified 680 paths by subtree/file type and scanned UTF-8 text for TODO/FIXME/HACK/NOT FINAL/UNVERIFIED markers; five recognized binary/image files were not UTF-8. This is exhaustive **byte-level Core candidate coverage**, not line-by-line human/semantic audit, proof that TODOs are defects, all branches/historical revisions, ignored files or whole-fleet disk coverage. The independent Browser GitHub main has 107 tracked paths; Emad Windows canonical Browser matches exact main d04ae5b5 with 107 tracked files, while Emad Linux canonical Browser is on 8eb6512 with 83 tracked files and local tracked/untracked changes. Preserve and compare both Browser trees before migration. Personal and ignored/untracked host files are not included. The earliest verified public Core root is 2026-09-17, Browser root 2026-10-01; neither proves private conversation inception. The shared-project conversation excerpts and connected project documents were used, but no tool exposes an exhaustive account-wide chat transcript/export. Thus ALL_CHATS_REVIEWED=false, ALL_PROJECT_FILES_REVIEWED=false and BRAIN_COVERAGE=INCOMPLETE; do not claim a finished full-history audit.

**Installed / source divergence (2026-10-27):** Five connected endpoints report production Core 0.10.26; five isolated candidate localhost services report developer Core 0.11.0-dev.3. Prior isolated 5/5 doctor checks are limited to Core, not Browser/GUI/Control Center acceptance. Canonical RC_PRODUCTS/DEVELOPMENT/Commander roots differ: Emad-PC head 54bb5a1 with two tracked autostart changes; Emad Linux f1570d7 with two tracked autostart changes; both Windows servers e337f0e with no tracked changes returned; MMZ Linux e337f0e with three tracked docs/test changes. Separate legacy worktrees on Emad-PC and Emad Linux contain uncommitted user changes and must be preserved. Exact source, ownership and process dependency reconciliation precedes any cleanup or in-place overwrite. Browser maintains independent Git source and release authority.

**Exact candidate CI evidence:** Hosted CI, Browser Linux canary, GTK R32/R35, Windows Control Center R34, R39 UI integration, Release Sync and historical candidate scoped rollback jobs succeeded at exact SHA a06fe7ec. Linux R170 native rollback FAILED preflight; Windows R173 rollback FAILED R173_UNSUPPORTED_VERSION; Windows Server clean canary FAILED due missing ProgramData server-install-allowlist.json, while Linux clean canary succeeded. These scoped failures prohibit five-host promotion. PR #409 stays Draft/NoPromote, all manifest release/auto-update/stable approval fields false. Real owner GUI input, independent profile isolation, reliable headless service, full Browser native integration, signed/attested package and whole-suite soak are open.

**Architectural decisions (external sources are candidates, not bundled software):**
- Keep ONE Commander MCP execution/security/router and its existing journal/verifier. The official modelcontextprotocol/typescript-sdk v2 is a protocol-conformance/migration reference; reimplementing Core is not the default.
- Windows interactive GUI: FlaUI and microsoft/winappCli for UIA patterns; execute only in the authenticated user's interactive session, never through SYSTEM Session 0 or secure-desktop bypass. Linux: xdg-desktop-portal RemoteDesktop + libei/EIS after explicit owner consent. Preserve uncertain-outcome no-retry evidence.
- Browser: keep existing CEF/Chromium as the single native renderer and independently versioned repository. Evaluate microsoft/playwright-mcp structured accessibility snapshots and ChromeDevTools/chrome-devtools-mcp diagnostics through separately owned profiles; no production cookie copying or authenticated remote-debugging exposure.
- Workspace/Workers: compare totec448-spec/chat-on-steroids for worker resumption/visible task UX and miuuyy/codex-chatgpt-web for capability-binding patterns, but these are NOT verified installed components and do not grant ChatGPT Web login/session reuse or autonomous Codex invocation. OpenHands Canvas is a control-UI reference. LangGraph/Temporal are deferred benchmarking options, not a second durable engine.
- Mesh: preserve tested Commander/Syncthing transport and consider tus resumable protocol and tus-node-server only where E2E continuity/recovery gains are measurable. Authorization: compare Casbin RBAC/ABAC after current policy contract tests; no broadening of powers. Observability: OpenTelemetry JS for local, redacted trace/metrics. Release: GitHub CodeQL/secret scanning and Sigstore Cosign provenance with exact source/asset SHA. Audit third-party license, dependency and threat model before importing source or building a new daemon.

**Prioritized remaining work:** P0 fix prerelease SemVer/preflight, R170/R173 and Windows Server allowlist; package all 9 required components with exact Browser SHA; qualify one installation per platform and live 5-host routed cutover/rollback while keeping current tunnels and dirty work safe. P1 profile and GUI consent / Browser controller / Transfer + Worker real end-to-end and visible control center. P2 opt-in agent UX, graph memory and external schedulers only if benchmarks justify maintenance cost. The 0.11 machine manifest remains all-false until actual per-gate receipts are verified.

**Notion sync:** previously identified organization project registry page has rejected writes due block quota. Its current synchronization is NOT PROVEN; retain NOTION_SYNC_PENDING until successful write and readback. This public Brain contains no private host configuration, credentials or session data.


## HISTORICAL ADDENDUM — unique 2026-10-21 Browser PR #325 evidence preserved

### 2026-10-21 — Browser Core PR #325: ambiguous multi-tab mutation guard (source-only)

- **Authority and scope:** GitHub [PR #325](https://github.com/GOD13emad/ChatGPTRemoteCommander/pull/325) is the pending Browser Core source candidate. Prior exact head `06abf65980f723d05b7b10286ee452f25edd9375` had hosted [Windows+Ubuntu CI PASS](https://github.com/GOD13emad/ChatGPTRemoteCommander/actions/runs/39639129607) and [Windows R157 NoPromote PASS](https://github.com/GOD13emad/ChatGPTRemoteCommander/actions/runs/39639129709), but these receipts **do not** qualify subsequent source changes.
- **Verified failure and scoped correction:** In a red-then-green controller regression, an ambiguous `browser_chat_tab_open` error could be followed by an unrelated `browser_snapshot` that cleared the no-retry latch without proving target ownership/effect. The PR worktree now preserves `sessionResetRequired` after ambiguous chat tab open/close until the owned lease is ended; read-only DOM/target observation remains permitted and cannot release that latch. Controller regression covers both open and close, and a fresh owned session is accepted after confirmed end. The original failure was reproduced before the fix.
- **Bounded evidence:** MMZ source-only durable operation `66fc2799-944b-42ee-ad9c-2d9caa3c264e`, exit 0, stdout SHA-256 `776f304e9e073752db7366f69cf40d10c259afa602311a2ddc5efbc4f0da9439`; executed Browser suite, synthetic 12-to-16 tab E2E, Unicode fixture, `check:qualification`, `test:qualification`, and `audit` with `SECURITY_AUDIT_PASS`. No active Commander install, user browser profile, desktop J01 incident or release tag was modified.
- **Unclosed:** **fresh exact-head hosted CI** for the corrected candidate, independent PR approval, actual authenticated chat/profile binding, multi-account cookie/storage isolation, CEF full native build and opt-in canary. Product FINAL not claimed. GitHub PR/commit authority identifies the subsequent exact source head.

## CURRENT POLICY — unified forward-only development train, 2026-10-28

**Owner acceptance:** exactly one centrally governed Commander installation per host, three runtime profiles (Windows Desktop, Linux Desktop, Windows/Linux Headless Server), same Git source/manifest for personal and organizational fork, ChatGPT Chat-owned execution (no ChatGPT Work use or Work credits). `TandemVector-Labs/ChatGPTRemoteCommander` is already the actual GitHub fork of `GOD13emad/ChatGPTRemoteCommander`; its protected `main` must be synchronized via reviewed PR #195, not force-updated.

**Changed development gate:** numbered pre-v1 dev builds run **forward-only**; return-to-legacy `0.10.x` rollback qualification is deferred until `v1.0.0` Stable acceptance. Retain previous fault evidence, source integrity and installed configuration rescue, avoid destructive disconnection, require exact native install/start/function/readback on each host. This does NOT waive native Windows CI, installer safety, data isolation or Security/R157 NoPromote, and does not turn a staged source into a running release. Existing `0.10.26` and side-staged `0.11.0-dev.9`/Cua 0.38.0 are historical verified scope only.

**Single authoritative detailed spec:** [COMMANDER_ARCHITECTURE.md](COMMANDER_ARCHITECTURE.md); development/Stable gate status: [RELEASE_AUTHORITY.md](RELEASE_AUTHORITY.md). **Next critical edge:** validate new exactly-versioned dev build, native Windows/Linux/Server installer with combined components, install on 5 hosts with same live API contract, then dependency-aware retire old executable routes; thereafter Browser Commander and Control Center acceptance and independent v1 Stable. Linux Control Center native distribution and Windows Session 0 owner GUI worker remain OPEN. The user-requested final installation/cleanup is **not** yet verified.

---

## FLEET-CONTROL-20261028 — scope-limited live control acceptance

**User priority:** restore practical Commander system control on all five existing devices before an unqualified 0.11 rollout. Scope is the five connected MCP endpoints only, date 2026-10-28; no general product FINAL, stable or signed release is claimed.

**Exact live verified (5/5):** Core `0.10.26` online on Emad Windows PC, Emad Linux, Amir Windows Server, Emad Windows Server and MMZ Linux; each started a separately owned 60-second Terminal canary with the marker `RC_CONTROL_CANARY_ACTIVE`, returned that marker through `read_terminal`, then `stop_terminal` returned `running=false`. Earlier same-session file Temp roundtrip and isolated owned headless browser `https://example.com` navigation/DOM/read/release PASS on all five. This proves current Shell, filesystem, process lifecycle and browser subset, not full GUI or cross-device project coordination. Final status readback: each `activeOperations=0`, Browser `active=false,leased=false`; no user desktop/owner browser profile changed.

**GUI evidence and strict boundaries:**
- Emad Windows PC: interactive Cua Driver process in OS Session 1; Commander MCP endpoint in `SYSTEM / Session 0`. Delegated GUI `observe` leased/listed 9 windows successfully, but `takeover` explicitly refused `OWNER_GUI_OBSERVE_ONLY`. Verified source `src/gui-owner-delegation.mjs` is a deliberately read-only proxy (tools and mode restricted); never widen SYSTEM/session credentials or fake a user grant. Needed: same-OS-owner worker with independently validated, time-bound native permission and tested revoke/input; source/release gate remains OPEN.
- Emad Linux: read-only GUI lease and window enumeration (3 windows) PASS. `gui-pending-native-input-v1.json` contains incident ID `d560c678-a656-457e-8b92-88c503ab8e8f` for a `gui_mouse_click` with uncertain native effect. Keep fail-closed `GUI_INCIDENT_REVIEW_REQUIRED` until same-effect owner reconciliation, preserve evidence, **no replay or blind deletion**. Two owner-local private Xvfb displays :1960/:1961 respond to read-only X11 geometry queries; attempting shell-driven GUI mutation was correctly blocked by Commander policy, and was NOT repeated.
- MMZ Linux: owner KDE Wayland portal, same-user GUI API observation of one window PASS. A legitimate short `takeover` lease and fresh screenshot produced a native-consented portal stream. Official `gui_mouse_delta` +1 pixel then -1 pixel each returned `ok=true,nativeAcknowledged=true`; cursor readback moved from (716,446) to (717,446) and returned to (716,446). No click, typing or focus change, and lease ended; this is a bounded native input canary, **not** general GUI application acceptance. After lease close portal reports no permanently active consented session, as expected for ephemeral consent.
- Two Windows Servers: Shell/process/Browser headless work PASS; `gui_status.screens=[]`, `available=false`. Windows sessions exist but no available drawable display in those execution contexts. Do not simulate a user desktop or take over another RDP session merely to mark GUI PASS. Dedicated headless server capability is the accepted path; optional isolated virtual GUI has a separate admission gate.

**Status:** operational remote command/task control PASS on 5/5; GUI observation PASS on 3 desktop clients; native input narrowly PASS on MMZ, OPEN on Emad Windows and Emad Linux. Autonomous Workflow execution and cross-device fenced writers remain OPEN. Installed production routes kept at 0.10.26, no host upgrades or restarts. ChatGPT Chat used existing Commander connectors; ChatGPT Work was not invoked.

**Control-stack installation delta — 2026-10-28 (5/5 side-by-side verified; no runtime promotion):** Retrieved official `trycua/cua` `cua-driver-rs-v0.38.0` non-nightly release (upstream marks this component pre-release; newer `0.38.1` builds are Nightly). For each of Emad Windows PC, Emad Linux, Amir Windows Server, Emad Windows Server and MMZ Linux, downloaded the platform-specific x86_64 binary package, compared its SHA256 with the upstream release checksum and placed extracted Cua Driver `0.38.0` under a versioned user-local Commander `adapters/cua-driver/v0.38.0` directory **without overwriting/launching** the existing daemon. All five `--version` checks returned `cua-driver 0.38.0`. Windows binary SHA256 `ffa58d88779ee219304b0c307f4cfa970fe822f830c6ecf9254eda5c29e22bf2` (3/3 Windows); Linux binary SHA256 `bf57b2f3778a0a7daa9388e241f20ce948b32a7a2f4dd102e497f34e54137934` (2/2 Linux). Amir Server's initial directory move failed Access Denied; recovered by verified SHA-identity copy to destination; exact duplicate staging file was removed after independent hash verification. No OS elevation used.

**Cua doctor acceptance boundary:** Windows Emad primary Commander runs in SYSTEM Session 0 (no interactive desktop); its *existing* `0.22.2` Cua process remains in user Session 1, untouched. Linux Emad shell lacks `DISPLAY/WAYLAND_DISPLAY` despite private Xvfb sessions; MMZ reports live Wayland/XWayland + AT-SPI and one visible top-level window. On both Windows Servers, Cua doctor reports input desktop locked/disconnected; Emad Server additionally reported a 4-second UIA enumeration timeout. These are WARN/OPEN GUI activation gates, not proof that the Cua installation failed. Do not launch an unrestricted daemon from Session 0 or bypass owner permission. Cua `0.38.0` installation integrity PASS 5/5; integration with owner-scoped bounded daemon/MCP and actual app GUI input is not accepted on five hosts.

**Core 0.11 source availability, separate from installed Core:** exact source SHA `2a103d1dca913c236bb584b2d68acb924d1f0db6` (main-architecture-reconciled `0.11.0-dev.9`, [PR #414](https://github.com/GOD13emad/ChatGPTRemoteCommander/pull/414)) placed in separate read-only-intent `candidates/core-0.11.0-dev.9-2a103d1` on all 5 machines. SHA, `package.json`, development-only release manifest and **four** focused source identity/NoPromote tests per host checked: 5 hosts × 4 = 20 PASS, zero failures. This is staged candidate SOURCE, not an installed running release. Its hosted exact-SHA R170 Linux rollback and CI passed; **R157 and R173 Windows qualification failed**, so do not promote, tag, claim Stable or overwrite healthy `0.10.26` routes. Native device-scope control and browser health still PASS 5/5 after staging (Workflow database `ok`, Browser `available=true`, no outstanding active operations).

**Next validated hardware-dependent action:** same-owner Cua daemon/bridge with bounded permission manifest for Emad Windows Session 1; native consent and incident disposition for Emad Linux; headless capability contract on monitorless servers; qualify and repair Windows R157/R173 prior to any `0.11` fleet cutover. Notion portfolio synchronization remains pending on previous block-quota limit; repository Brain is canonical.

**Next direct dependency:** owner-session input worker with scoped Cua/bridge permission on Emad Windows, and owner disposition of Emad Linux incident with preserved uncertain-effect record. Proceed with headless server and MMZ scoped actions independently. Dev.9 exact-source QA remains separate from fleet installation.

---

## CURRENT ARCHITECTURE DECISION — 2026-10-28 (owner-accepted design; NOT product FINAL)

**Single product for all eligible machines:** the accepted future topology is one Remote Commander product/core/API/capability schema and release manifest, deployed through Windows Desktop, Linux Desktop and Headless Server adapters. Server is a runtime profile, not a separate OS. This supersedes historical *future-topology* proposals for independently operated products; it does not rewrite historical source branches, releases, signed/unsigned admission, tested environments or independent Browser/Control Center provenance.

**Execution owner / quota:** active **ChatGPT Chat** is primary reasoner, tool orchestrator, verifier and deliverer. Use best suitable tools, including a Codex task harness with ChatGPT Web model transport and compatible CoS-style local workers; Codex is **not banned**. **Do not invoke ChatGPT Work or route any project job through it**. The product must expose tool/provider routes and verify no Work invocation; no claim of guaranteed account-side zero billing/limits from an unofficial bridge. Existing security, provider and user-account limitations remain. A local operator's approval does not equate to an authorized new service or automated ChatGPT wake.

**Shared coordination:** multi-user/profile/device, multi-chat and concurrent task support require per-user identity/RBAC, isolated browser secrets, durable task receipts, one **globally fenced** writer per canonical project root (not only machine-local locks), Git worktrees and conflict-safe merge. Browser defaults to owned Chromium/CEF when qualified, with Playwright engines for coverage; desktop control uses safe native adapters plus evaluation of Cua, with headless server capability detection. Retain one WorkflowStore, Brain/roadmap authority and release authority, with no redundant execution engine.

**Canonical architecture specification and implementation DoD:** [COMMANDER_ARCHITECTURE.md](COMMANDER_ARCHITECTURE.md). **Active architecture delivery order:** (A) capability contract/install manifest; (B) authenticated Coordinator/distributed lock; (C) chat-owned Codex-Web/CoS routing without Work; (D) browser; (E) GUI/headless; (F) cross-chat worktree execution; (G) exact-version Windows/Linux/Server canary, rollback and authorized release. All A–G runtime acceptance gates remain **OPEN** as of this decision; the architecture being agreed and documented is **not** proof of implementation, stable qualification or fleet rollout.

**Scoped evidence:** connected `aliemad-Labtop` reported installed `0.10.26` with `automaticExecution=false`, `runnerConfigured=false`, `oneWriterScope=machine`; GitHub source baseline for this architecture branch was `main` `92620bfb350424d50316f396f8f98d049848c5a8`. These are separate observed contexts; no claim that installed runtime equals GitHub head. **Next action:** implement A+B in existing project development flow and qualify independently. Existing tests, older plans, protected reviews and release evidence retain their original scope.

---

## CURRENT — 2026-10-19: single-workspace cleanup and verified lineage

**Role and scope.** This versionless `PROJECT_BRAIN.md` is the project's single current continuity entrypoint and dated history index. Old "CURRENT" labels in the historical checkpoint below are **superseded as decisions**, but their original event evidence is preserved rather than silently rewritten. The immutable Git history, exact PRs and release/tag assets carry detailed source provenance. Security rules, publisher admission and actual version authority remain in [RELEASE_AUTHORITY](RELEASE_AUTHORITY.md) and [RELEASE_CANDIDATE_0.10.25](RELEASE_CANDIDATE_0.10.25.md); they are not parallel Brains. Private account-specific data, credentials, confidential inventions, browser profiles and local machine addresses are intentionally **not** copied into this public file.


### 2026-10-21 — GUI controller source gates and installed-runtime boundary

- **Current source, not an installed release:** Protected Core `main` at `0ea6be101546ce5185ce36feb8ee729380a9b2ec`. [PR #320](https://github.com/GOD13emad/ChatGPTRemoteCommander/pull/320) merged the 1500ms **read-only** Windows native mutex wait, never an input queue. [PR #322](https://github.com/GOD13emad/ChatGPTRemoteCommander/pull/322) merged one bounded (2500ms) **read-only** JavaScript `GUI_BUSY` waiter with STOP/lease/incident re-admission; mouse, keyboard and focus still reject concurrent execution. PR #322 merge tree `05cb6c4d4e4baf5a391f4f1dfd8aa281917ca0c0` exactly equaled qualified PR head `b37f47e2dcc85238d190236dcbb0b9a41b1c5ff9`.
- **Qualified gates and retained negative result:** Exact-head Windows/Ubuntu [CI](https://github.com/GOD13emad/ChatGPTRemoteCommander/actions/runs/39611723610), Windows [R157 NoPromote](https://github.com/GOD13emad/ChatGPTRemoteCommander/actions/runs/39611723672) **attempt 2**, [R170 Linux rollback](https://github.com/GOD13emad/ChatGPTRemoteCommander/actions/runs/39612564123), [R173 Windows rollback](https://github.com/GOD13emad/ChatGPTRemoteCommander/actions/runs/39612581028) and [Server Install Canary](https://github.com/GOD13emad/ChatGPTRemoteCommander/actions/runs/39612517555) completed/success. R157 attempt 1 had **one FAILED** `test/deferred-path-http.test.mjs` case out of 492 (477 pass, 14 skip); independent focused execution and attempt 2 passed. Its failure remains provenance, **not** proof the timing root cause was fixed. Post-merge CI `39615960608`, CodeQL `39615965856` and Release Sync `39615960771` all succeeded.
- **Release distinction:** Latest Core Stable remains immutable `v0.10.20`; `v0.10.25` was publicly published as a **version-scoped UNSIGNED Preview** on 2026-10-20 (20 assets; tag peels to `b5cc8bb16876831c829ba7597c27725d80184f5c`). Post-merge Release Sync emitted `R171_POSTTAG_MAIN_SKIP`, correctly preserving that older tag/assets; it did **not** publish `main`. The Windows unsigned exception applies **only** to `v0.10.25`; unsigned `v0.10.26` is not authorized, and policy regression checks 10/10 passed. Never bypass SmartScreen/UAC or represent GitHub provenance as Authenticode signing.
- **Read-only live GUI evidence:** Emad-PC-Ultimate, aliemad-Labtop and mmz-LOQ-15IRX9 each returned a native JPEG screenshot with a frame token; each observe-only lease was explicitly ended and final status was `available=true, leased=false, busy=false`. These are **read-only installed v0.10.25 observations**, not mouse/keyboard, independent private-session or fleet-installed rollback acceptance. On Emad-PC the installed `src/gui-tools-windows.mjs` SHA-256 `EDE158595E1B4DF4560B9E80D40B74CE0028E3D7418C672051C835695B7E6F84` differs from tested source `92D3C47ED0F58D637B3061BB44AE16C8092DC0EBBCE2F1249ECAEDD9C0762EF2`; installed `tools/gui-control.ps1` also differs. Hence GUI fixes are **not installed** there.
- **Independent workspace path and restrictions:** Official Windows desktop semantics allow only one active input desktop in a given interactive window station. Separate OS sessions/VMs or Linux authenticated headless private displays are appropriate candidates, not global mutex removal or SendInput tricks. GNOME user-headless RDP on the two inspected Linux desktops was `inactive/disabled`; Xvfb was not installed. Private X11/Xvfb GUI workers have independent NoPromote tests in [PR #279](https://github.com/GOD13emad/ChatGPTRemoteCommander/pull/279) and stacked Drafts, but this is **not deployed** and lacks real ChatGPT conversation attestation. [PR #313](https://github.com/GOD13emad/ChatGPTRemoteCommander/pull/313) is source-only NoPromote Windows IPC/SQLite QA pending independent reviewer approval. [PR #301](https://github.com/GOD13emad/ChatGPTRemoteCommander/pull/301) explicitly retains a **SECURITY HOLD** on cached private observer-frame access after owner revocation; do not merge without the corresponding [PR #306](https://github.com/GOD13emad/ChatGPTRemoteCommander/pull/306) correction, requalification and review.
- **Critical next gates:** Preserve all J01 uncertain-outcome evidence; qualify actual independent workspace owner/observer authorization and private native input without touching physical desktops; obtain explicit exact-version signing/unsigned Preview authorization for a new version; build and attest a distinct immutable tag, then execute opt-in native install/rollback/profile continuity on target hosts. No Stable automatic rollout or whole-product FINAL is established by these source/test passes.

### آغاز قابل‌اثبات و تغییر مسیرها — traceable history

- **2026-09-17 — first retained Core source root:** Git root commit `19dbb27e2a38ded843ecf52c943d0f245f19968f` is dated September 17 and titled *Release v0.1.0*. This is the earliest public source root verified here, **not proof the underlying product idea or private planning began that day**.
- **2026-09-28–30 — controlled execution:** The historical Brain records progressive bounded workflow/runner authorization, journal, Windows qualification and recovery changes through v0.9.21–v0.10.3. Failures and corrected paths belong to the immutable record, not to a set of separately active QA checkouts.
- **2026-10-01 — separate Browser lineage:** The public Browser Git root `d1a697422e0021985daa901b893947aaaea779c6` is dated October 1 and titled *Release v0.7.1: hardened CEF Linux client*. CEF, session/RTL support and native Browser safety became an independently versioned product.
- **2026-10-04–16 — verified releases and lessons:** The earlier Core v0.10.9 milestone, later immutable Core Stable `v0.10.20`, and separately published Browser Stable `v0.8.1` are distinct from source/main and experimental PRs. On October 16, `v0.10.24` received a **version-specific unsigned Windows Preview** concession; that permission does not transfer to later tags.
- **2026-10-19 — release-first, three independent products:** Freeze Core `v0.10.25` features; deliver **Core**, then independently qualified **Browser**, then useful native **Control Center**, followed by version-pinned in-place updates. No experimental GUI broker, unattended agent, browser theme draft or unverified Control Center mutation is silently admitted into Core. This supersedes an all-features-before-any-release strategy.
- **Technical readiness, not publication:** Core [PR #278](https://github.com/GOD13emad/ChatGPTRemoteCommander/pull/278) exact head `b8a1f6b7482c486eb7527f3b64cf9240927bdae9` / tree `527c78061852c53a73cfafcb4dbd44e616395f5f` passed five dedicated hosted workflows (Windows/Ubuntu CI, Windows NoPromote, Windows/Linux isolated promotion+rollback, Server Install Canary and Release Sync). Two independent Linux hosts reproduced source QA; the publisher's Windows computer ran a separate safe source-only 47-tool MCP canary. The unsigned 20-asset offline QA set was byte-identical across two hosts (manifest SHA-256 `7aaaf97be6e53d5a47460164f4f34febc7fad1c11fdeb7036a6a5db5e42ad72a`). **No exact-v0.10.25 signed or expressly publisher-authorized Release, human sign-off, approved live-data rollout or final native installed rollback was proven.**

### One development workspace; installations are separate

1. On each enrolled computer the target is **one canonical development parent**, `RC_PRODUCTS/DEVELOPMENT`, with named `Commander`, `Browser`, and `CONTROL` subprojects where applicable. Core and Browser retain **separate Git upstreams** and independent release/tag authority; a shared parent does not combine their histories. Future source updates must modify the same checkout in place after a clean/dirty-state and branch-owner audit, not create more `RC_QA_*` working copies.
2. Each product should have **one active installed runtime per host** with legitimate multi-account/profile instances using that runtime. Distinguish **one installation** from legitimate multiple processes, tunnels or routing profiles. Preserve exactly the minimum verified rollback until native promotion, profile/journal continuity and safe retirement are accepted; deleting an old directory only by its version string is forbidden.
3. Uncommitted tracked changes, unique untracked files, private user state, unresolved GUI effects and not-yet-extracted historical Git refs are **NOT disposable**. For each old directory: check ownership, symlinks, live consumers, Git source/commit/ref coverage, unique files, recoverability and rollback need; then retire only independently proven duplicate Build/QA outputs. No broad `git clean -fdx`, live process kill, credential copy or desktop takeover.
4. A workspace manifest is **not** a deployment receipt. Keep source status, installed route/backend health, user-data preservation and reviewer/publisher decisions separate. The current five-connected-host cohort and unreachable server(s) must be reconciled before fleet FINAL.

### 2026-10-19 consolidation events and open gates

- **Emad Linux:** The original existing `RC_PRODUCTS/DEVELOPMENT/{Commander,Browser,CONTROL}` parent was retained. A validated 20-asset Core QA bundle was moved inside its Commander development area; the redundant clean Core QA clone was retired. An old, clean Browser RC3 source clone (remote-branch SHA `22e708b860f5009161d249d8ad5a9ab5b3538581`) and its rebuildable CEF dependencies were retired after confirming the source lives on GitHub. Existing dirty/active repositories were preserved.
- **MMZ Linux:** One redundant, clean `v0.10.25` QA packaging clone with bit-identical assets was retired. The independently validated source QA tree remained available. Other dirty feature/incident branches require staged preservation, not guessed deletion.
- **Emad Windows:** A canonical Browser checkout under `RC_PRODUCTS/DEVELOPMENT/Browser` was created from the official Browser repository (observed development main `d04ae5b5b0129b7c2b199ee99a22bda6709edf66`). The owned temporary Core source canary/state were retired after receipt verification. Three old clean Browser build checkouts were removed; two were confirmed on their exact remote branch tips, and **seven historical refs** from the third were first imported into the canonical Browser Git object store under `refs/rc-history/cef-final-20261003/` and validated. This local-only archived Git history still needs deliberate disaster-recovery treatment before any future canonical repository retirement.
- **2026-10-20 — MMZ canonical checkout:** A private `RC_PRODUCTS/DEVELOPMENT` parent now contains clean independently cloned `Commander` (official `main`, exact `5cd6ec5`) and `Browser` (official `main`, exact `d04ae5b`). The old MMZ candidate's two local Git refs, including unique source commit `f3da4133`, were imported into `Commander` under `refs/rc-history/mmz-20261019/` and SHA-verified; the `v0.10.25` candidate remote ref `b8a1f6b` is available. The old `RC_RELEASE_FIRST_01025_QA_20261019` directory is **retained** because six user-session DBus/GVFS/portal/keyring processes still hold its cwd; those services were not killed or detached. No installed Core or user profile changed.
- **2026-10-20 — verified Browser build retirement:** On Emad Linux, exact expanded contents of three detached QA runtime directories were streamed and compared **byte-for-byte** against their preserved local tar archives, including complete file-set equality: `RC_BROWSER_R109/stage` (240 files, 1,497 MiB), `RC_BROWSER_CANARY_R73/stage` (240 files, 1,497 MiB) and `_cef_rc3_acceptance/app` (240 files, 1,497 MiB). All three expanded directories were then removed with verified post-delete absence. Their matching tar archives, small QA receipts and separate private self-test states were retained; no active consumer pointed into these expanded directories. About **4,491 MiB of expanded duplicate build data** was retired, not a claim of equivalent disk free-space gain after compression, snapshots or filesystem effects.
## 2026-10-20 additional verified consolidation

- **MMZ history custody and linked worktrees:** The shallow source GUI checkpoint `9303cdd930240b202122dc9c164a3d636ff591be` was imported using Git's explicit shallow-boundary handling into the canonical Commander checkout. All eleven local branches from the separate GUI QA store were SHA-checked after archival under `refs/rc-history/mmz-gui-control-20261019/`. Both clean linked GUI worktrees were detached with `git worktree remove`, rather than deleting their shared Git metadata. The canonical Browser checkout likewise took custody of **15 local feature branch refs and 12 release tags** from the old UI QA store, then the old overlay-preview linked worktree was removed. The installed Core checkout and any GUI worktree with unique changes remain untouched.
- **Emad Linux: only byte-identical old binaries retired:** `RC_BROWSER_LINUX_R1/stage-v0.8.0` and `stage-v0.8.1` each had 240 files identical to their archived release tarball; only the same 8,441-byte `VERIFY_MANIFEST.log` was extra, consolidated to a single retained copy. Both 1,497-MiB extracted directories were removed while their tarballs were retained. `RC_BROWSER_R112/run` (1,488 MiB) matched the separately retained `R109` Browser runtime archive across 231 regular members, including the original bytes of its QA-verified Chrome sandbox payload; deleting the *link* did not modify its separately installed destination. `RC_DEV/BrowserRuntime/package` (1,488 MiB, 233 files) was byte-equivalent to its preserved `artifact.zip` (SHA-256 `5cd1ac35f98f4abe537f5d2ed2e59e8086f8f67b2c3d22b57c94eb6d20a362a2`). All four old expanded runtime trees were removed after full content comparison; their archives, receipts and private test profile state remain. **Approximately 5,970 MiB** of duplicate expansions were retired, not a guaranteed equivalent net filesystem gain.
- **Windows build cache retirement:** On Emad PC and Saeid PC the Git-ignored `.deps` CEF 154 Windows SDK trees (approximately 586 MiB each) were retired separately after verifying their archive SHA-256 `aa1f7ab28005307edcc13f95e3ce5cd9d221894b00458fb5e368c00603204a2a` matches the committed `fetch-cef-windows.ps1` pin. Dirty source/QA branches were retained. Loopback health afterwards still reported active Core `0.10.25`, route commit `d4b9b290c6d5234825befaa247f5bdf598215957`; the separate isolated release candidate `b8a1f6b` is NOT to be assumed the same deployment.
- **Canonical Windows development roots:** Saeid now has clean official `RC_PRODUCTS/DEVELOPMENT/Commander` (`a5f70e5053e0247b5712d3467ca7d37afd92f441`) and `Browser` (`d04ae5b5b0129b7c2b199ee99a22bda6709edf66`) sources. HPC Semnan has the same official Core `a5f70e5` source in its own canonical parent; no unnecessary headless Browser source was created. The existing installed Core and routing were not changed: Saeid `0.10.25` and HPC `0.10.24` by actual backend health. Old dirty/unique branches on other paths still require custody review before retirement.
- **2026-10-20 — reproducible archives retired after official asset custody:** Three old Emad Linux QA tar archives for Browser `v0.8.0`, `v0.8.1` and Preview `v0.8.3-rc.1` were individually verified against the exact **SHA-256 digest and byte size of the still-published GitHub Release assets** in the official Browser repository and then deleted from detached QA paths. Digests respectively: `81f56f62c238002a2845c11d6057572503c9d6e2544c668736afcff251388705`, `8cac4150b844e48c5f6fbf90df84b306d49165bef77f716f5c61d20bad164073`, and `c5283a22dbe8b1f717d1bee5d29c8da7f1e28a3cb5fcc6dfbf404fc2b956aa81`. **1,099,883,334 bytes (~1.02 GiB) of redundant compressed payload** were retired in addition to previously removed extractions, while small QA receipts/manifest, private profile state and actual installed browser contents were preserved. Previous checkpoint statements that these three local tarballs remain retained are superseded as *current state*; their authentic online release copies remain retrievable. The unreleased `v0.8.2` Canary artifact has no matching official tagged Release in this check and was **not** removed.
- **2026-10-20 — no-clone update and renamed Browser repository reconciliation:** MMZ's clean canonical Commander `main` was fast-forwarded **in place** from `5cd6ec545b37dca32d63dc31c462bbe6d1399f3f` to protected main `a5f70e5053e0247b5712d3467ca7d37afd92f441`; all eleven local GUI history refs and the source-only release references remained valid, no installed Core was changed. The Emad Linux Browser's old upstream URL `Usefull-Skills/chatgpt-cef-linux` and canonical `Usefull-Skills/remote-commander-browser` proved to be **the same GitHub repository ID `1399865521`**, not two independent products. Only the `origin` URL was normalized inside the existing canonical Browser checkout, preserving HEAD `8eb6512e00ff0f2e80073bd9277735a48257f114` and **exactly unchanged staged/unstaged/untracked state hash** `98fc9e5058767391de4611d897d0a1a864e088796d5c2d73f99c66eddc8278ac`. The unique dirty Brain, workflow and script content remains pending deliberate integration; it was not cleaned or forced.

- **2026-10-20 — complete retirement of the old MMZ GUI QA worktree family:** Eight remaining linked, source-clean GUI worktrees were checked for cwd consumers and local changes; their only ignored content was small reproducible Python bytecode and legacy-test fixture outputs. All were detached using Git worktree removal after SHA-matching every one of the **11** local GUI branch refs to the canonical Commander `refs/rc-history/mmz-gui-control-20261019/heads/` namespace. The now-single former common Git root was also retired after confirming zero stashes/tags, no external object alternates, **zero unreachable or dangling objects** under `git fsck --no-reflogs --unreachable`, the single known Python cache, and no dependent cwd. **Nine superseded directories removed** in this family; canonical Commander `main=a5f70e5`, archived 11 branch refs, official Browser checkout, live Core `0.10.24`, user profiles and runtime router remain intact. This is source/worktree consolidation, not approval to delete active versioned rollback releases.
- **Concurrency and readiness warning:** The protected Core `main` moved to `a5f70e5` via unrelated accepted source maintenance after this docs branch was cut from `5cd6ec5`. This document-only change must be compared with that live branch before any merge. Neither clean checkout construction nor removal of Build caches proves that the final fleet has one installed version and no backups; version-specific publication, profile/journal continuity, unreconciled devices, and independent owner acceptance remain separate gates.

### 2026-10-20 — Emad Linux source-history retirement (scoped, verified)

- **98 archived refs in one canonical checkout:** The old Emad Linux Core source root contained 98 local branch/tag references. All 98 Git objects were imported and SHA-compared under `refs/rc-history/emad-laptop-legacy-20261020/{heads,tags}/` within the existing `RC_PRODUCTS/DEVELOPMENT/Commander` repository. The original source checkout's dirty 29-file state and the canonical development checkout's dirty 4-file state retained their respective unchanged status fingerprints. The legacy checkout remains in place pending custody of its unique uncommitted changes; this transfer does not authorize overwriting it.
- **Five detached, clean historical worktrees retired:** Five independently pinned detached QA HEAD commits — `380bebb9946a`, `666649da832d`, `674990c743fc`, `2245495e6554` and `31414b65f829` — were imported under the same private canonical Git `refs/rc-history/.../worktrees/` namespace and verified before `git worktree remove --force` retired those five worktree directories. Each checkout had zero tracked/untracked changes. Its only ignored data was the same generated two-file legacy-test fixture and a bounded, separately unique ~2 KB test audit log.
- **Private evidence consolidated, not published:** The five generated audit logs and shared fixtures were retained in one local, owner-private archive `RC_PRODUCTS/HISTORY/historic-core-test-fixture-audits-20261020.zip`, SHA-256 `24205baf408c0a6e72094f59eb1e25a45413a5ab4dd57bb45e87edd54da4bc73`. No audit contents, personal state or credentials were copied to GitHub. The archive and archived refs are local-only continuity evidence, not substitutes for an independently backed-up owner record.
- **New merged Brain source authority:** Documentation PR #282 was merged into protected `main` at `3a3b70a34ff7f2a792ecc662a35ad7ead7bbac59`. The canonical Core development checkout on Saeid PC and on HPC Semnan was separately observed already at that exact source commit (no new Clone or update performed in this verification). Emad Linux/Windows dirty feature checkouts were preserved. MMZ connector and Amirreza server tunnel were unavailable during this particular verification; their live state was not inferred.
- **Open cleanup gates:** Other linked QA worktrees and uncommitted local branches still require the same hash-based custody process. Do not remove the old common Git root, live Core runtime or minimal tested rollback before unique local changes, journal/profile continuity and supported owner-approved release adoption are reconciled. Core candidate PR #278 remains independent, unsigned and unpublished.

- **Saeid Windows and HPC Windows:** Installation/config and many source working copies were inventoried but **not** blindly deleted. Amirreza's tunnel was unreachable during this audit; its current state is not certified.
- **Observed live divergence (date-bound, not an approved release):** The Windows developer routes on Emad PC and Saeid pointed to source `v0.10.25` commit `d4b9b290c6d5234825befaa247f5bdf598215957` and loopback health verified version 0.10.25. This is **not** the separately green `b8a1f6b` release-candidate source above. MMZ Linux, Emad Linux and HPC remained routed to v0.10.24 in the same inventory. Do not assume UI/plugin-reported versions and current routing coincide until refreshed/verified.
- **Next critical path:** reconcile all active route/process/SHA authorities; preserve unique dirty Git content in the canonical workspace; index event provenance once; perform staged source/build retirement. Only after owner acceptance and valid signer or version-scoped unsigned policy should any product receive a tagged install/update with tested native rollback. Subsequent Browser appearance and Control Center releases remain independent.

---

## Archived earlier Brain checkpoints (historical evidence, NOT current operator instruction)


> **HISTORICAL CHECKPOINT — SUPERSEDED AS CURRENT.** The `Status: CURRENT` text below was written for v0.10.9 on 2026-10-04 and is retained verbatim for provenance, not operational authority. For the published Core v0.10.20, separate Browser v0.8.1, and current open release/acceptance gates, use [RELEASE_AUTHORITY](RELEASE_AUTHORITY.md) and the immutable release/tag evidence. Private cumulative account-transfer Brains are not embedded in this public file.

Status: CURRENT — v0.10.9 RELEASED / MMZ LINUX LIVE + FRESH QUALIFICATION PASS / WINDOWS HOSTED TEST-HARNESS DETERMINISM GATE OPEN
Updated: 2026-10-04
Authority: immutable release/tag -> exact live route records -> exact-SHA CI/canary evidence -> project control/evidence records.


## Current accepted baseline — v0.10.9

**Release authority — CONFIRMED / ACCEPTED**

- Annotated tag object: `ef32598f34df99d9c0390ae04749c02088d42ea0`; tag `v0.10.9` peels exactly to product commit `157d2b18c2c2a2d6a144148230a30b0418eea8c4`.
- GitHub release id `402919128` is stable, `draft=false`, `prerelease=false`, `immutable=true`, published `2026-10-04T08:21:50Z`, with exactly 19 assets carrying SHA-256 digests.
- Exact product SHA `157d2b18...` has a successful `main` CI run `37188105744`: Ubuntu full check/test/audit PASS and Windows bounded qualification check/test/audit PASS.
- Exact product SHA also has successful Release Sync run `37188105716`.
- Current `main` is `6f192c96d51efb3eebdad4dfd49ff36df1888d4b`, two commits ahead of the product release SHA; comparison shows the only file delta is the one-shot publisher workflow `.github/workflows/release-v0.10.9-publish-once.yml`. Product release bytes remain bound to `157d2b18...`.

**MMZ Linux host — CONFIRMED / FRESH V&V PASS**

- Remote Commander `system_status` reports version `0.10.9` on `mmz-LOQ-15IRX9`.
- Installed control checkout `/home/mmz/.local/share/ChatGPTRemoteCommander` is detached at exact product commit `157d2b18...`.
- Two tracked Windows scripts appear modified only because CRLF was normalized to LF; `git diff --ignore-space-at-eol --exit-code` is clean for both, so semantic drift is not evidenced.
- Fresh Linux `check:qualification && test:qualification && audit` completed against that exact checkout on 2026-10-04 with process exit `0`. Observed test batches had zero failures; the final audit reported `SECURITY_AUDIT_PASS` and no secret-key, tunnel-id, private-key, bearer-token, GitHub-token, tracked-local-config, or developer-path finding.

**Contradictory evidence — OPEN / UNVERIFIED ROOT CAUSE**

- A second CI run on branch `release/v0.10.9-publisher` at the same product SHA, run `37188394413`, failed the Windows `Run qualification check with bounded Windows file concurrency` step while its Ubuntu job passed.
- Job log isolates the only failure to `test/process-tree-lifecycle.test.mjs`: `start_terminal remains interactive only when explicitly requested with an initial command`, error `interactive terminal did not accept initial command`. The test polls 80 times at 25 ms (~2 s readiness window); the failed instance lasted 2.533 s, while two successful exact-SHA main instances took 0.723 s and 0.698 s. Failure mechanism is therefore **PROBABLE hosted-Windows startup-latency/timing flake**, but root cause remains **UNVERIFIED** because no direct child-start trace proves it. This is one occurrence, so no test relaxation, product patch, or blind rerun is justified.

## Open gates / critical path — current

1. MMZ Linux exact-checkout fresh qualification/audit: **CLOSED / PASS**.
2. Publisher-branch Windows duplicate-run failure is classified **PROBABLE timing/startup-latency flake; ROOT CAUSE UNVERIFIED**. Preserve as a watch gate; do not patch or rerun solely for this first occurrence. If it recurs meaningfully, perform historical/root-cause audit before changing the test or runtime.
3. PR #120 exposed a separate historical fixture-startup family in `retry-http.test.mjs`: same head push CI PASS on Windows/Ubuntu, while PR-event Windows suite failed only before behavior assertions because the copied server missed its legacy ~10 s health window. Historical project evidence already accepts a 30 s elapsed startup deadline plus early child-exit diagnostics for this fixture family. **CURRENT mutation objective:** align this stale harness with that accepted pattern; runtime/product timeout semantics remain unchanged. Focused 10/10 and full MMZ Linux qualification/audit are now PASS; hosted Windows/Ubuntu on the patched head remains the promotion gate.
4. Keep Saeid rollout/connectivity and the separate CEF/Companion qualification outside Commander stable acceptance unless independently evidenced.
5. Preserve durable delivery/history backlog as project state; no mass delete or blind replay.

## Exact next action — current

Push the locally qualified `retry-http.test.mjs` harness alignment and require fresh hosted Windows/Ubuntu PR CI on the exact patched head. Do not merge PR #120 until the required hosted head is green. Keep the accepted v0.10.9 runtime unchanged.

## Previous accepted baseline — v0.10.8

**v0.10.8 — RELEASE ARTIFACT FINAL / ACCEPTED**

Release tag target: `4ca2efe57ceb6d22a75176420fc41ae904666f00`.
Qualified product candidate: `23dea9881f8d60959f499d7e39e78df676d3b8ae`.
Accepted tree shared by candidate and merge commit: `92b628765f5d19a090eddb1654e2d936a0e6775e`.
GitHub release is immutable, stable (not draft/prerelease), published 2026-10-03 with exactly 19 uploaded assets carrying SHA-256 metadata.

v0.10.8 closes the real Windows candidate-first drain deadlock observed while rolling v0.10.7 on HPC-159-17. An old backend could be independently idle while its Commander-owned `tools/browser-control.mjs --server` helper remained alive. The updater now treats that helper as safe only after exact old-backend `browser_status` proves active=false, busy=false, leased=false and uncertain=false. Unknown or conflicting evidence remains fail-closed.

Accepted host readback:
- `aliemad-Labtop` Linux: v0.10.8, exact commit `4ca2efe...`, route generation 117, workflow DB integrity `ok`, active operations 0, current leases 0.
- `HPC-154-66` Windows: v0.10.8, exact commit `4ca2efe...`, route generation 33, workflow DB integrity `ok`, active operations 0, current leases 0.
- `HPC-159-17` Windows: v0.10.8 real regression host; candidate-first update retired the previously blocking verified-idle browser helper path without manual process killing; active operations 0 and current leases 0 at readback.
- Saeid Windows host: MISSING rollout/readback in this session because its tunnel-client has not been seen for 300 seconds. No blind mutation or downgrade is authorized while that connector is offline.

The Saeid Companion/V03/paused-domain/Q5/Browser-R3 sources remain explicitly experimental unless separately qualified. Commander stable acceptance does not promote the CEF companion or Windows private-file guard.

## Open gates / critical path

1. Bring Saeid tunnel-client back online; then perform read-only authority/route audit followed by exact-tag v0.10.8 candidate-first update only if needed.
2. CEF cross-platform preview qualification remains a separate project. Linux runtime is already qualified; Windows native runtime is being qualified independently.
3. Real Commander↔CEF ownership/transport/current-session integration, native Windows private-file ACL guard, and sustained non-interference remain OPEN.
4. Durable-delivery/history backlog on user machines is retained project state, not a release blocker; reconcile only by project authority and never mass-delete or blind-replay UNCERTAIN effects.

## Exact next action

Do not change accepted v0.10.8 hosts. Restore Saeid connectivity before any Saeid mutation. Continue CEF Windows-native qualification from its exact feature head; publish only a prerelease until Windows private-file ownership/ACL and end-to-end Commander binding are independently accepted.

## Final objective

Maintain a cross-platform Remote Commander that safely executes substantial work in the background, survives interruption/update, preserves one-writer/evidence semantics, supports explicit owner-authorized GUI/Codex paths without hidden delegation, and routes relevant separately installed domain Skills without bundling them into Commander Core.

## Accepted current baseline

**v0.9.20 — SCOPED FINAL / ACCEPTED**

Release/tag commit: `cbbc6dc19f63a87e651a8f1af9f429aa7b6a5063`.
Qualified candidate tree: `674990c743fc996d84d0b0c4e008f0255078e44c` with no file diff against the merge commit.

Accepted evidence:
- local Windows exact-SHA full gate PASS;
- local Linux exact-SHA full gate PASS;
- hosted Windows/Ubuntu CI PASS on run `36445899951`;
- disposable Windows Server + clean Ubuntu Server canary PASS on run `36445899940`;
- immutable release verification PASS with 15 assets and 14 verified payload checksums;
- candidate-first live rollout complete on primary Windows, Windows `saeed-emad`, Linux, and HPC Windows;
- all accepted route records point to exact v0.9.20 commit with `previous=null`;
- live Skill routing canaries PASS on Windows/Linux/HPC.

Official separately installed Agent Extensions:
- ansys-modeling v1.1.1
- comsol-modeling v1.1.1
- project-execution-brain v1.0.0
- final-thesis-report v1.0.0

The owner-private video-trend extension remains intentionally outside the official catalog. Domain extensions remain lifecycle-independent from Commander Core and are not bundled by the Commander installer/release.

## Locked decisions

- Background/headless execution is default. Console/terminal windows are not a progress UI.
- Actual task UI or an explicit official progress UI may be foregrounded.
- Domain Agent Extensions are separately installed; Commander owns validation/routing/policy intersection only.
- Explicit trigger evidence dominates weak lexical routing; compatible project-method and domain Skills may layer.
- Hidden/background project runners remain No-Codex. Local Codex launch is only the explicitly authorized owner path defined by policy.
- Immutable releases remain enabled.
- Windows Server bootstrap remains verification/allowlist based; it does not disable Defender/EDR or create AV exclusions.
- Fresh-server qualification is a permanent release gate: Windows Server bootstrap and clean Ubuntu bootstrap.
- Do not mass-cancel durable workflows belonging to unrelated user projects merely to make release dashboards empty.
- No blind rerun after meaningful failure; repeated failure families require root-cause audit and prevention.

## v0.9.20 closure

Root causes closed:
1. fresh Linux bootstrap omitted Python 3 although qualification requires it;
2. headless Linux server qualification incorrectly required native GNOME/PyGObject integration;
3. inherited-stdio async regression mixed hosted scheduling latency with the intended post-ready drain invariant.

Prevention now retained in code/tests:
- Python 3 is installed/required by supported Linux fresh-server paths;
- headless server validation keeps static GUI checks but skips only the native GNOME probe;
- normal Linux GUI qualification still exercises native GNOME integration;
- permanent disposable Windows/Linux server canary;
- async fixture ready-handshake and bounded post-ready assertion window.

A single local Windows full-gate attempt on the final candidate observed one clean fixture-server exit in the HTTP conversation test while several qualification workloads were concurrent. The same exact test then passed 10/10 in isolation, hosted Windows passed, and a clean full Windows exact-SHA rerun passed. Root cause of that one local occurrence is therefore UNVERIFIED; no product patch was made from it.

## Deferred / external — not v0.9.20 blockers

- ChatGPT host/UI stream errors such as Resume stream unavailable are outside Commander transport authority; Commander reduces exposure through durable/background execution but cannot guarantee the host UI stream.
- Historical/other-project durable workflow records are retained when they belong to unrelated projects. Integrity is checked; they are not mass-cancelled for cosmetic cleanup.
- Broader provider expansion, monetary accounting, additional integrations, and equal-model/equal-budget competitive benchmarks are future roadmap items.
- Claims that Commander is universally superior to every external agent/work product remain UNPROVEN without comparable benchmark evidence.
- Dependency-update PRs and legacy historical branches are maintenance/history, not release acceptance evidence.

## Post-release repository closure

Main closure commit: `f0157ccff98da9e42c25e5ea0bd55bc9ee7de0ab`.

Exact closure-head evidence:
- focused Windows fixture-startup stress: 36/36 PASS;
- hosted CI run `36451298406`: Windows PASS, Ubuntu PASS;
- Server Install Canary run `36451298534`: Windows Server PASS, clean Ubuntu PASS;
- Actions pins refreshed to checkout v7.0.1 / setup-node v7.0.0;
- stale/superseded PRs #43, #3, #4 and legacy draft #30 closed without deleting Git history.

No runtime/release bytes changed after immutable v0.9.20 publication.

## Exact next action

No action is required for the accepted v0.9.20 scope. For new work, start from v0.9.20 as the production baseline and open one bounded change set only when a new requirement, reproducible defect, security issue, or evidence-backed improvement is identified.

## History pointers

Detailed append-only evidence: `docs/PROJECT_KNOWLEDGE_EVIDENCE.md`.
Current/release roadmap: `docs/PROJECT_CONTROL_STATE.md`.
Historical snapshots: `docs/history/`.


## Milestone — 2026-09-28 — v0.9.21 owner-authorized runner closure

**Previous accepted state:** GitHub main at 4a93d5475447f751e81ceaa87495b8c684fd1e87, release 0.9.20. Live FULL_POWER Windows configuration explicitly requested a local Codex Project Engine runner, but runtime reported runnerConfigured=false / automaticExecution=false.

**Current delta:** repaired the policy/configuration mismatch so an explicitly configured local Codex runner is preserved only when FULL_POWER, explicit owner authorization, powerMode.codexControl.allowLaunch=true, exact provider kind=codex, and a real Codex executable are all present. All other Codex paths remain default-deny. Planner remains proposal-only under the existing restricted launch contract. Release/version/install/plugin metadata are aligned to 0.9.21.

**Evidence / V&V:** local final gate PASS at 2026-09-28T21:50:18.6502700+03:30. Project Engine 222 pass / 0 fail / 1 environment skip; comprehensive check and test suites completed with zero failures; SECURITY_AUDIT_PASS; source-integrity/runtime/installer/plugin/release-asset gates passed; git diff --check passed. Gate log SHA-256: 406a95addaff1ccc343969c2d4097bf401eac2145b36e5ad18431429108bb569.

**Authority:** the single writer is the clean canonical writer clone on the primary Windows host, on branch finalize/v0.9.21. The legacy dirty checkout remains non-authoritative and untouched.

**Open gates / critical path:** GitHub promotion/CI and live runtime deployment/readback. Native ChatGPT host wake/push remains external. Long-soak qualification is UNPROVEN until elapsed evidence exists.

**Exact next action:** commit and push the clean branch, open/validate GitHub PR, merge only after available CI/status gates, then deploy the immutable promoted revision and verify live Windows/Linux status.


## Milestone delta — 2026-09-28 — Windows hosted qualification correction

Hosted Linux gates on the amended v0.9.21 candidate passed. Two Windows-only qualification failures were isolated to browser lifecycle tests: an 80 ms setup-sensitive timeout and a raw-PID liveness predicate for a profile-owned process. Production browser cleanup remains unchanged. The candidate now uses the fixture-default 1000 ms timeout for the intended timeout-cleanup test and verifies profile-owned descendants by exact browser profile identity rather than numeric PID existence. Promotion remains open pending targeted stress, full local gate, and fresh hosted Windows gates.


## Milestone delta — 2026-09-28 — Local requalification complete

The Windows qualification correction is locally requalified. Browser-process tests are 7/7 PASS and the two previously failing hosted-Windows scenarios passed 20/20 repeated targeted runs. The complete release gate then passed: Project Engine 222 pass / 0 fail / 1 environment skip, full suite 481 pass / 0 fail / 6 environment skips, security audit PASS, and diff-check PASS. Gate-log SHA-256 is 107D33026CD9294B07ED8B7AAB79B0A6B63B5EE325E634A663E184C505FD80DB. Promotion remains open until fresh hosted CI and both server canaries pass on the amended commit.


## Milestone delta — 2026-09-28 — Hosted Windows spawn/PID fixture race

A third meaningful hosted-Windows browser qualification occurrence triggered stop-patching review. The new failure was not cleanup: the fixture marker contained an invalid PID because it serialized child.pid immediately after asynchronous spawn. Primary Node documentation confirms the spawn event as the successful-creation boundary and that pid can be undefined. The fixture now awaits spawn before recording PID on both child-process paths. Production browser lifecycle code is unchanged. Promotion remains blocked pending targeted regression, one final local gate, and fresh hosted gates.


## Milestone delta — 2026-09-28 — Final local candidate requalified

The spawn/PID fixture guard passed targeted validation (browser-process 7/7; affected child-spawn stress 10/10) and the complete release gate then passed. Project Engine: 222 pass / 0 fail / 1 environment skip. Full suite: 481 pass / 0 fail / 6 environment skips. GUI contract: 77/77. Security audit and diff check passed. Final gate marker: 2026-09-28T23:06:39.5908545+03:30; gate-log SHA-256: 0DC03CE86CF73A2847B68ECC566D7CDF916F91F7B3E0D69DB33A51DF8DA5F817. The source candidate is locally accepted but not yet promoted; fresh hosted CI and server canaries remain mandatory.


## Milestone delta — 2026-09-28 — v0.9.21 post-qualification local gate PASS

The Windows qualification blockers were isolated to test predicates/teardown rather than production behavior: browser profile-owned cleanup now verifies exact profile ownership instead of raw PID existence, the timeout-cleanup fixture no longer imposes an unrelated 80 ms setup requirement, and async-continuation teardown uses the repository's established Windows retry policy. Production browser and continuation runtime code remain unchanged by these qualification corrections. Targeted browser qualification stress passed 20/20; targeted async-continuation cleanup stress passed 20/20. The complete local promotion gate then passed at 2026-09-28T23:37:31.6925697+03:30 with zero failures, including security audit and diff check. GitHub hosted CI/canary, merge, immutable deployment, and live runtime readback remain open; native host wake/push and elapsed soak remain external/unproven.


## Milestone delta — 2026-09-28 — v0.9.22 runner-policy rollout repair

v0.9.21 source/hosted gates passed, but live validation exposed a rollout-precedence defect: canonical owner policy had the enabled Codex Project Engine runner while the routed runtime retained the historical `NO_CODEX_VIA_COMMANDER` disabled runner. The v0.9.22 hotfix keeps routed runtime config as the baseline and permits only a narrowly validated runner-policy overlay from canonical local configuration. No unrelated canonical settings are copied. FINAL remains UNPROVEN pending full gates, hosted CI, candidate-first rollout, and live `runnerConfigured=true / automaticExecution=true` readback.


## Milestone delta — 2026-09-29 — v0.9.22 local gate accepted

The narrow Windows runner-policy overlay hotfix passed the complete local promotion gate. The exact gate artifact is `var/final-gate-v0.9.22.log` with SHA-256 `a06b87e9a80be2bd0853207f3a9f33e191d27b12199af16e7cd0de79fe066b7f`. The next authority gates are hosted CI, merge, release publication and live candidate-first rollout. FINAL is still UNPROVEN until the routed runtime reports both runner configuration and automatic execution enabled.


## Milestone delta — 2026-09-29 — Windows hosted starvation control qualified

A Windows-hosted-only test-file concurrency bound of 2 was selected instead of increasing functional timeouts. The exact bounded path, complete CHECK, and full local v0.9.22 promotion gate all passed. Evidence log SHA-256 is `5f2bb611d2e43e921f57695119f1f3692313b4eb5ca6df1a7d71c631c157e87c`. Production runtime semantics are unchanged by this CI control. FINAL remains UNPROVEN pending fresh hosted gates, merge, release, live rollout, and live `runnerConfigured=true / automaticExecution=true` readback.


## Milestone delta — 2026-09-29 — qualification harness stabilized

PR #50's release candidate now uses one generic bounded qualification path (`test:qualification`, concurrency 2) for hosted/install/update qualification while retaining ordinary unbounded `npm test` for development/final-gate detection. Local targeted contracts, the exact qualification path, and the complete unbounded v0.9.22 final gate all pass. The latest final-gate artifact is `var/final-gate-v0.9.22.log`, SHA-256 `1338cc7cd5e3d5b65739342fe4e3b8b0fdeffbd0501fe0d9f514d04196af751c`. Hosted CI and both install canaries on the new commit remain the next authority gates; FINAL remains UNPROVEN until release rollout and live runner readback succeed.


## Milestone delta — 2026-09-29 — v0.9.23 closes the remaining Windows updater qualification gap

v0.9.22 was published successfully, its candidate-only live qualification passed, and its runner-policy repair was confirmed in the candidate. The first promotion safely deferred default while an older route drained and promoted the independent `saeed-emad` profile. After the old default previous backend disappeared, an evidence-backed updater resume exposed the last unbounded qualification path: Windows auto-update still ran raw `npm test` and one isolated workflow HTTP health test starved for ~30 seconds while 482 tests passed. The exact failing file then passed 3/3 in ~2.5 seconds. Official Node documentation confirms CLI test-file concurrency defaults to available parallelism minus one under process isolation. Because this is the third occurrence in the same qualification-starvation family, v0.9.22 remains immutable and v0.9.23 applies the minimum control: Windows auto-update reuses `test:qualification` concurrency=2 and the regression contract now covers that path. FINAL remains UNPROVEN pending v0.9.23 gates, release, and live default runner readback.


## Milestone delta — 2026-09-29 — v0.9.23 local qualification complete

The Windows auto-update qualification hotfix is locally accepted. Focused Project Engine passed 222/0/1 skip; the exact bounded qualification path passed 483/0/6 skips with concurrency=2; and the complete unbounded final gate passed at 2026-09-29T08:44:21.1074309+03:30. Security audit, source integrity, GUI contracts, schema continuity and diff check all passed. Evidence artifact `var/final-gate-v0.9.23.log` has SHA-256 `caf3697d100ab9d6ccdcac913178a2bb424938b5e8cf6dd40dbf684a851b53d5`. The next authority gates are fresh hosted CI and both server-install canaries on the committed hotfix SHA; FINAL remains UNPROVEN pending immutable release and live default runner readback.


## Milestone delta — 2026-09-29 — qualification CHECK starvation gap

PR #51's first head passed Ubuntu CI and both server-install canaries, but Windows hosted CHECK exposed the remaining half of the same qualification-starvation problem: the CHECK script contains its own large unbounded Node test batch, and an isolated MCP conformance server missed the existing 10-second health window under hosted Windows load. The failure carried no runtime error beyond the SQLite experimental warning. The minimum control is to reuse the existing concurrency-2 wrapper as `check:qualification` in hosted/install/update qualification paths while keeping ordinary CHECK unbounded in the local final gate. Merge remains blocked pending a fresh head and fresh hosted evidence.


## Milestone delta — 2026-09-29 — CHECK qualification control locally accepted

The remaining hosted-Windows starvation gap is now locally closed with the minimum control: `check:qualification` reuses the existing bounded Node test wrapper at concurrency 2 only in CI/install/update qualification paths, while ordinary `npm run check` remains unbounded in the complete local final gate. Focused contracts passed; bounded CHECK and TEST qualification passed; and the unbounded final gate passed at 2026-09-29T09:19:39.7374006+03:30. Evidence log `var/final-gate-v0.9.23.log` has SHA-256 `b9e5945c7155a95212d5c2864fadca2acc15680e8e00c896980b62d14486a156`. The next authority gates are fresh hosted CI and both server-install canaries on the new commit SHA.


## Milestone delta — 2026-09-29 — v0.9.23 live FINAL

v0.9.23 is published and live on the Windows default route at merge commit `a1b5368edf33d629111407aecd7f4c6a136a6122`. Candidate-first qualification passed, the live cutover succeeded, and final readback shows Full Power preserved with `runnerConfigured=true` and `automaticExecution=true`. Default route generation 116 has no previous backend. The independent `saeed-emad` profile is also on v0.9.23 while correctly preserving its explicit runner-disabled policy. The old v0.9.21 backend was not killed because it owns a persistent terminal; it was moved to the retained-backend registry and removed from routing authority, so active work is preserved without leaving a drain blocker. `last-update.status=CURRENT`. The v0.9.23 release/rollout objective is FINAL PASS; retained historical backends remain lifecycle-managed preservation state until their terminal descendants exit.


## Milestone delta — 2026-09-29 — live deployment audit and Windows persistence repair

A fresh post-release audit reconfirmed the Windows executable authority as v0.9.23 at `a1b5368edf33d629111407aecd7f4c6a136a6122`; the later repository head was docs-only. Both routed profiles remain healthy on v0.9.23, the installed stable app executable files match the immutable v0.9.23 release bytes for the router/supervisor/updater/server paths audited, and both v0.0.15 tunnel profiles are ready.

Six historical Remote Commander maintenance workflows that were superseded by the accepted v0.9.23 live state were retired through the official revision-guarded workflow control surface without replaying any step. Scheduler pending moved from 811 to 805 and RUNNING from 553 to 547; unrelated electromagnetic-generator and FreeNetHub workflows were explicitly excluded. Workflow SQLite integrity is `ok`, ordinary operation queue is empty, durable delivery has no dead letters or unfinished requests, and accumulated `COMPLETED_UNDELIVERED` items remain classified as durable unacknowledged result state rather than an executing-queue failure.

The Windows logon Run registration was found missing and was repaired with the authoritative `enable-autostart.ps1 -NoStart`; the existing DPAPI credential was reused, no process restart occurred, the Run command is hidden PowerShell 7, and both tunnel readiness endpoints remained healthy. The exact historical cause of the missing registration is unverified; source audit shows only the explicit disable-autostart path removes the value, so no updater defect is asserted without evidence.

A fresh regression against the exact installed release passed: focused lifecycle/delivery/router tests 42/0, `npm run check` exit 0, `npm test` 483 pass / 0 fail / 6 skip, security audit PASS, and doctor PASS with live/expected version 0.9.23. Release/runtime status remains **FINAL PASS**.

One machine-level deployment gate remains separate from the release: the SYSTEM `ChatGPTRemoteCommander-BootRecovery` and `ChatGPTRemoteCommander-UserSessionHandoff` tasks are absent. Two LocalMachine credential artifacts already exist, but the current execution token is not elevated. No UAC bypass was attempted. A bounded local admin runner was prepared to call only the authoritative `enable-boot-recovery.ps1 -NoStart`, verify both tasks/autostart/tunnel readiness, emit `RETURN.json`, and perform no reboot. Therefore boot-before-logon power-loss recovery remains an owner/admin gate, not a v0.9.23 release blocker.


## Milestone delta — 2026-09-29 — v0.10.0 product-finalization candidate locally accepted

The post-v0.9.23 product gap was narrowed to installation/distribution usability rather than a core execution defect. Current OpenAI primary documentation was rechecked before design: Secure MCP Tunnel remains private connectivity; app-backed Plugins reference an already-registered app through .app.json; native compatibility points .codex-plugin/plugin.json apps to ./.app.json; eligible workspace owners/admins may upload Plugin ZIPs through ChatGPT when that option is available. Tunnel credentials do not create the registered ChatGPT app.

The minimum sufficient product change is therefore a thin Setup layer around the already-qualified installers, not an Electron/Tauri/MSI/deb runtime rewrite. v0.10.0 adds stable and versioned Windows/Linux Setup ZIP release assets, interactive Standard/Full/Full+GUI selection, persistent tunnel onboarding, truthful WAITING_APP_ID continuation, and a dependency-free device Plugin packager. The packager derives a stable per-machine/per-profile fingerprint, creates distinct Plugin names/display names/brand colors/icons/logos for multi-computer accounts, binds the exact App ID in both portable and native manifests, and rejects secret-shaped tunnel/runtime credential material.

Fresh Windows candidate evidence: focused setup/plugin tests 7/7 PASS; a real build-device-plugin.ps1 smoke generated a valid device ZIP with normalized App ID and no secrets; Git Bash syntax checks for all new/changed shell paths PASS; setup-wizard.ps1 machine-path smoke PASS against the live v0.9.23 service. The complete local final gate PASSed with full test 490 pass / 0 fail / 6 skip, security audit PASS and diff check PASS. Exact final-gate log SHA-256: 8ede55b433ed03a64f4d6dc536f5daf49fcc053aad4db4613e544e1fe134045a.

Linux live hygiene audit proved the untracked nested app/ checkout was an orphan old commit (981e0b2...) with no live process/systemd/route/config references; only historical audit logs mentioned its path. Before deletion the complete 64 MB tree was archived to local state backups. Archive SHA-256: b21d02f646dda980aa65e2cec1dc39898170c1d28517e12a10536b52c71a0c73; compressed bytes: 30153972. The nested tree was then removed; the outer live v0.9.23 checkout is clean, systemd service remains active and health remains OK.

The CHANGELOG projection gap for v0.9.11-v0.9.23 was repaired from authoritative per-release evidence files without changing historical release records.

Current status: v0.10.0 source candidate is LOCAL PASS. Hosted CI/server canaries, clean Linux exact-tree qualification, immutable publication and live Windows/Linux rollout remain open. Windows SYSTEM BootRecovery/UserSessionHandoff task creation remains a separate owner/admin OS privilege gate; no UAC bypass is introduced.

## Final seal — 2026-09-29 — v0.10.0 released and live

v0.10.0 is now the accepted product release for the audited Windows and Linux targets.

Authoritative release identity:
- tag: v0.10.0
- merge commit: 26b8df90838f449bc61710981fc31b7a467e021d
- qualified candidate commit: 5bb6f541380514daf8924db7cb215d232405a8be
- candidate and merge tree: ef76b567ead34d0ca26c0c8b7c42d9b28cd3eefe
- immutable GitHub Release: published, 19 assets
- downloaded release verification: 19/19 assets present and SHA256SUMS verified.

Hosted acceptance:
- GitHub CI Windows: PASS.
- GitHub CI Ubuntu: PASS.
- Server Install Canary Linux: PASS.
- Server Install Canary Windows: first attempt had one transient interactive-terminal readiness timing failure under hosted contention; no affected runtime code changed. Exact-job rerun PASS, and seven consecutive local repetitions of the exact process-tree test file PASS. No timeout/runtime weakening was introduced.

Live Windows acceptance:
- default route generation 118 -> v0.10.0, commit 26b8df90838f449bc61710981fc31b7a467e021d, previous=null.
- saeed-emad route generation 162 -> v0.10.0, same commit, previous=null.
- last-update.json status=PROMOTED; doctor/hardware/shadowStore/liveStoreCompatibility all PASS for both profiles.
- live status FULL_POWER authority preserved; activeOperations=0, queued=0, lockedKeys=0.
- tunnel chatgpt-remote-commander: ready on local health port 47832.
- tunnel saeed-emad: ready on local health port 47833.
- auto-update log ends with AUTO_UPDATE_PASS version=0.10.0 commit=26b8df90838f449bc61710981fc31b7a467e021d.

Live Linux acceptance:
- default route generation 95 -> v0.10.0, same exact commit, previous=null.
- live status FULL_POWER authority preserved; activeOperations=0, queued=0, lockedKeys=0.
- systemd user service active.
- MCP health on routed port 48832 reports v0.10.0 and matching config identity.
- tunnel chatgpt-remote-commander ready on local health port 47832.
- updater log records check PASS, test PASS, audit PASS, schema continuity PASS, CUTOVER_COMMIT v0.10.0, previous retirement, GUI backend sync, maintenance PASS and supervisor recycle request.

Product delivery:
- stable Windows Setup asset: ChatGPT-Remote-Commander-Windows-Setup.zip.
- stable Linux Setup asset: ChatGPT-Remote-Commander-Linux-Setup.zip.
- complete installer asset: ChatGPT-Remote-Commander-v0.10.0-Installer.zip.
- setup wizard installs/updates Commander, enrolls the private tunnel using local-only credential prompts, verifies readiness, then waits for the registered ChatGPT App ID.
- once the App ID is available after ChatGPT Scan Tools, the local device builder creates a complete app-bound Plugin ZIP with deterministic per-device/per-profile name, icon/logo and provenance; it contains no Runtime API key, Tunnel ID or tunnel credential.
- one account may therefore connect to multiple systems through intentionally distinct Plugin identities.

Remaining external/owner gates are not product defects:
1. Per-device final Plugin ZIP is WAITING_APP_ID on a machine where the ChatGPT surface has not exposed/provided the registered App ID. No ID is fabricated from tunnel credentials.
2. Windows pre-logon BootRecovery SYSTEM/UserSessionHandoff task creation remains an explicit elevated-owner OS action if operation before interactive logon is required. The product does not bypass UAC.

Project status: PRODUCT FINAL PASS for v0.10.0 release/build/install/update/runtime/plugin-generation capability. Project Brain status CURRENT. Exact next action for a new machine: run the OS Setup bundle; after creating/scanning the custom ChatGPT app, provide its App ID to the local wizard to emit that machine's unique Plugin ZIP.


## Owner/admin gate closure — 2026-09-29 — Windows BootRecovery tasks installed

The previously open Windows owner/admin deployment gate was executed after explicit owner approval, without reboot/shutdown/logoff.

- The first elevated run of `enable-boot-recovery.ps1 -NoStart` hit `BOOT_RECOVERY_SYSTEM_PROBE_TIMEOUT`. No completion was claimed from that attempt.
- Read-only diagnosis proved SYSTEM ACL access to the app/var/profile/credential paths and proved that the Microsoft Store PowerShell 7 executable, Windows PowerShell 5.1 and cmd can all launch successfully as SYSTEM.
- One temporary diagnostic wrapper was rejected as non-authoritative after it demonstrated a local quoting defect in its own `Start-Process -ArgumentList` handling of `C:\Program Files\nodejs\node.exe`.
- An exact SYSTEM probe using the same `New-ScheduledTaskAction` argument string as the production boot setup passed in 1.303 seconds with `BootCore=true`, `CredentialScope=LocalMachine`, and both tunnel credentials `credentialReady=true`.
- The production `enable-boot-recovery.ps1 -NoStart` path was then rerun under elevation and returned `ok=true`.

Elevated post-check confirms:
- `ChatGPTRemoteCommander-BootRecovery`: Ready, SYSTEM, Highest, ServiceAccount, enabled BootTrigger, StartWhenAvailable, IgnoreNew, RestartCount 20, RestartInterval 1 minute, unlimited execution time.
- `ChatGPTRemoteCommander-UserSessionHandoff`: Ready, SYSTEM, Highest, ServiceAccount, enabled LogonTrigger for `EMAD-PC-ULTIMAT\Aa.Emad`, StartWhenAvailable, IgnoreNew, RestartCount 12, RestartInterval 1 minute, 12-minute execution limit.
- HKCU logon autostart remains present.
- No reboot was performed.

The historical Handoff `LastTaskResult=76` from 2026-09-27 was actively cleared by one controlled manual task run. Post-run: `LastTaskResult=0`, state Ready, MCP v0.10.0 ready, default tunnel ready, saeed-emad tunnel ready.

Evidence artifact:
`%LOCALAPPDATA%\ChatGPTRemoteCommander\audit\v0100-boot-recovery-20260929\FINAL_BOOT_RECOVERY_ACCEPTANCE.md`
SHA-256: `4817dddef6b497545369758da5be79c940500968b8df7375fb43c892a1ba832a`.

Status: owner/admin installation gate CLOSED / PASS. Real `AtStartup` behavior after an actual reboot/power-loss remains a separate validation event because this change set explicitly performed no reboot/shutdown/logoff.


## Pre-important-task readiness seal — 2026-09-29

Current objective is operational readiness for the owner's next important task, not feature expansion. The authoritative live product remains v0.10.0 / commit 26b8df90838f449bc61710981fc31b7a467e021d.

Windows:
- Doctor PASS, 94 tools, FULL_POWER, activeOperations=0, queued=0, lockedKeys=0, current workflow leases=0.
- default route generation 118 and saeed-emad generation 162 both point to exact v0.10.0 commit with previous=null.
- both Secure MCP Tunnel profiles are ready; HKCU logon autostart is present.
- BootRecovery/UserSessionHandoff owner gate is already closed; Handoff functional validation LastTaskResult=0.
- security audit PASS; GUI contract 77/77 PASS; live GUI backend available and idle.
- browser safety 12/12 PASS; native Chromium background browser PASS with userDesktopTouched=false, passwordStoreExtracted=false, DOM verification PASS; EOF/lifecycle cleanup PASS.
- local readiness artifact: %LOCALAPPDATA%\ChatGPTRemoteCommander\audit\PRE_IMPORTANT_TASK_READINESS_20260929.md
  SHA-256 f1f7ad9c126125d85ef0d5ab8c37d94bad458e2e5c7ed07690a4239e00eea7d4.

Linux:
- Doctor PASS, 94 tools, FULL_POWER, activeOperations=0, queued=0, lockedKeys=0, current workflow leases=0.
- workflow database integrity=ok.
- default route generation 95 points to exact v0.10.0 commit with previous=null.
- systemd user service active+enabled, Linger=yes, Secure MCP Tunnel ready.
- security audit PASS; Linux GUI contract PASS; browser safety 12/12 PASS.
- native Linux browser is not currently runnable: Firefox 156.0.1 is present, but geckodriver/Chromium is absent. apt offers no geckodriver candidate and noninteractive sudo is unavailable. Latest upstream geckodriver v0.37.1 asset is signed with Mozilla subkey 5ECB6497C1A20256, which Mozilla later revoked after an August 2026 key leak. Installing a new user-local executable before the owner's important task was rejected as disproportionate supply-chain risk. This is DEFERRED, not silently treated as PASS.
- Linux automaticExecution=false / runnerConfigured=false and recovery/readiness-only continuation are preserved. No parity change is made immediately before important work.
- local readiness artifact: /home/aliemad/.local/state/chatgpt-remote-commander/audit/PRE_IMPORTANT_TASK_READINESS_20260929.md
  SHA-256 bcca4f4529350c186f2568a0fac389f2c74b101cc3d83b8c943e9e88dc72038f.

Known non-blocking product debt retained for later development:
- durable workflow/delivery lifecycle hygiene and clearer active-vs-historical observability;
- explicit Windows/Linux autonomous-execution parity decision;
- reconcile/test/promote-or-discard the unpromoted v0.10.1 BootRecovery diagnostics work;
- minimal fleet inventory/health/version/tunnel/plugin-identity/policy view;
- optional capability-scoped sandbox/least-privilege execution;
- trusted Linux native browser dependency provisioning;
- macOS/native signed installer/enterprise RBAC only if product scope requires them.

The 20-product benchmark and the above roadmap are recorded in Project Knowledge. Do not mutate live runtime for these deferred items before the owner's important task unless one becomes a direct blocker.

Status: Windows READY/PASS. Linux core runtime READY/PASS; Linux native browser DEFERRED. Project Brain CURRENT.
Exact next action: use the existing v0.10.0 runtime for the important task.

## Milestone — 2026-09-29 — v0.10.1 maintenance candidate locally accepted

Objective: close the remaining current-release maturity gaps without expanding Commander authority or feature scope.

Accepted candidate delta:
- Windows BootRecovery self-test diagnostics now preserve exact profile/integrity exceptions in structured SelfTestOutput and include Task Scheduler state/LastTaskResult when no result file appears. No automatic repair or integrity weakening was added.
- Durable workflow scheduler status now makes the meaning of historical nonterminal records explicit: pending remains backward-compatible, persistedNonterminal exposes the same persisted count, pendingMeaning=PERSISTED_NONTERMINAL_RECORDS_NOT_LIVE_QUEUE, and hasActiveLease distinguishes current root-lease activity. No historical records were deleted or rewritten.
- The inherited-stdio async-operation regression no longer depends on an arbitrary 8-second CI window. The fixture exposes the holder PID, the operation must complete while that holder process is provably still alive, outputComplete remains false, and the holder is explicitly cleaned up afterward. Production operation timeout behavior is unchanged.
- Draft v0.10.1 documentation was corrected to remove an overclaimed BootRecovery root-cause statement. The initial live missing-result event remains precise-cause UNVERIFIED because later production-equivalent SYSTEM probes passed.

Fresh Windows candidate evidence:
- focused maintenance regressions: 44/44 PASS;
- inherited-stdio property stress: 10/10 PASS;
- Project Engine focused suite: 222 pass / 0 fail / 1 skip;
- complete full suite: 493 pass / 0 fail / 6 skip;
- SECURITY_AUDIT_PASS;
- git diff --check PASS;
- final-gate log SHA-256: 50e3bc6acf589884de2d369022e0cb6da89da32f826a4d521a411e501666eee3.

Status: LOCAL PASS / not yet released. Hosted Windows/Ubuntu CI, server-install canaries, clean Linux exact-tree qualification, immutable publication and live Windows/Linux rollout remain open gates.


## v0.10.1 live release seal — 2026-09-29 — one Windows recovery gate remains

Authoritative release:
- main merge commit: `b65c48ff8c2fdacd6fbfe0efef4d90742a9e791c` (PR #68).
- tag: `v0.10.1` annotated tag peels to exact commit `b65c48ff8c2fdacd6fbfe0efef4d90742a9e791c`.
- GitHub Release: published, draft=false, prerelease=false.
- 19 release assets present; all 18 payload assets listed in `SHA256SUMS.txt` independently downloaded and checksum-verified PASS.

Hosted release qualification:
- CI run 36580307031: Ubuntu PASS, Windows PASS.
- Server Install Canary run 36580307099: clean Linux container PASS, Windows server bootstrap PASS.
- local candidate evidence already recorded: focused 44/44 PASS; inherited-stdio stress 10/10 PASS; full suite/security/diff gates PASS.

Windows live:
- runtime version 0.10.1.
- canonical control source HEAD = `b65c48ff8c2fdacd6fbfe0efef4d90742a9e791c`, package=0.10.1.
- default route generation 120 -> exact v0.10.1/main merge commit, previous=null.
- saeed-emad route generation 164 -> exact same commit, previous=null.
- default + saeed-emad tunnels ready.
- Doctor PASS.
- activeOperations=0, queued=0, lockedKeys=0; workflow currentLeases=0, hasActiveLease=false.
- durable scheduler semantics now explicitly report `PERSISTED_NONTERMINAL_RECORDS_NOT_LIVE_QUEUE`.

Linux live:
- runtime version 0.10.1.
- initial final readback found a projection mismatch: routed runtime was v0.10.1 but canonical control checkout remained v0.10.0, causing Doctor expected=0.10.0 / active=0.10.1 FAIL.
- official v0.10.1 `auto-update-linux.sh` maintenance path was run in a retained terminal with exact tag+commit and full qualification; canonical control was promoted to exact `b65c48ff...`.
- postrepair Doctor PASS; package=0.10.1; systemd service active+enabled; Linger=yes; tunnel ready.
- route generation 99 -> exact v0.10.1 commit, previous=null.
- update log records `AUTO_UPDATE_PASS version=0.10.1 commit=b65c48ff...` and supervisor recycle request.
- activeOperations=0, queued=0, lockedKeys=0; workflow currentLeases=0, hasActiveLease=false.

Open Windows recovery gate:
- independent post-release Task Scheduler inventory found `ChatGPTRemoteCommander-BootRecovery` and `ChatGPTRemoteCommander-UserSessionHandoff` absent, despite prior v0.10.0 owner/admin acceptance where both were installed and Handoff was functionally validated.
- source audit found no update/install unregister path for those task names; only explicit `disable-boot-recovery.ps1` intentionally removes them. Precise deletion cause is UNVERIFIED.
- issue #69 records the regression and proposed future persisted-owner-intent/doctor guard.
- official v0.10.1 elevated repair was initiated under prior owner authorization, but Windows UAC returned `operation was canceled by the user`; no repair mutation occurred.
- no blind UAC retry was attempted.
- real reboot/power-return validation remains separately open (#66).

Status:
- v0.10.1 release/publication: FINAL/PASS.
- Windows core runtime/tunnels/routing: PASS.
- Linux core/runtime/control projection: PASS after repair.
- Windows BootRecovery/UserSessionHandoff desired live configuration: OPEN/BLOCKED_BY_OWNER_UAC.
- Project Brain: CURRENT.

Exact next action:
Owner approves the single UAC prompt for the official v0.10.1 `enable-boot-recovery.ps1 -NoStart` repair; then perform elevated task readback + controlled Handoff run, record evidence, and close issue #69. No reboot is required for that repair.


## Milestone delta — 2026-09-30 — retained-backend current-path fix

End-to-end v0.10.1 audit found Windows runtime/routing healthy but retained-backend lifecycle cleanup incomplete while already current. Three dead retained entries remain because `Complete-RetainedBackends` was not called in the CURRENT fast path before release cleanup; a fourth v0.9.10 entry still owns live terminal PID 44432 and must be preserved. The minimum correction has now been patched: run the existing safe reconciler before deferred drains and release cleanup, with ordering guards. Focused updater/registry regression is 15/15 PASS; full regression remains the next gate. No runtime authority, routing, runner, GUI/browser or Linux policy was changed.


## Milestone delta — 2026-09-30 — retained-maintenance local PASS

The Windows CURRENT-path retained-backend maintenance fix passed focused updater/registry tests and the complete local regression. The only production code delta is insertion of the existing safe retained reconciler before deferred-drain/release cleanup. Full test result is 493 pass / 0 fail / 6 platform skips and security audit PASS. Live registry is intentionally unchanged until fresh hosted qualification and merge make the source authoritative.


## Milestone delta — 2026-09-30 — retained liveness refreshed

A fresh Windows read-only audit shows all four retained backend entries now have no live registered terminal PID and no listener. This supersedes the earlier snapshot where one v0.9.10 terminal was still alive, without rewriting history. The existing v0.10.2 retained-maintenance patch remains the minimum safe fix; no manual retained registry edit or process kill is used. Promotion still requires fresh exact-tree regression and hosted gates.


## Milestone delta — 2026-09-30 — v0.10.3 hosted fixture determinism

Current accepted production authority is v0.10.2 on both Windows and Linux at exact immutable release commit `bc126ddf6351e107785096c1eec659cdf2982c1d`. PR #79 is a qualification-only v0.10.3 candidate; production runtime/tool schemas remain unchanged.

Two independent Ubuntu pull-request CI attempts on exact pre-fix head `8e72bed5dd8f42964e4d140af98e02307c67034d` failed the same inherited-stdio regression after about 20 seconds, while Windows CI/server-install canary passed and the exact unpatched Linux regression passed 20/20 isolated repetitions. The test fixture's direct child still depended on an asynchronous stdout callback before exit. The minimum correction is test-only: synchronously write `parent-done` to fd 1, then exit immediately while the detached holder remains alive. Production worker/runtime files are untouched.

Local patched evidence: Linux inherited-stdio 30/30 PASS; Windows 10/10 PASS; Linux full check 262/260 pass/0 fail/2 skip; full test 499/497 pass/0 fail/2 skip; security audit PASS. Exact next gate is fresh hosted Windows+Ubuntu CI plus both server-install canaries on the new committed head. Do not merge or release until those exact-head gates pass.


## Milestone delta — 2026-09-30 — post-merge workflow recovery gate

The first v0.10.3 merge commit `091cfb9e1ef131f5b18f5cf03976f2271ada4b93` is not publishable because post-merge Windows CI exposed a second test-harness timing weakness: workflow restart recovery was observed through a fixed 3-second wait. Exact-commit isolated reproduction passed Windows 15/15 and Linux 20/20, so no production workflow defect is established.

Minimum correction: test-only bounded 30-second elapsed wait plus controller-status failure diagnostics, preserving the automatic `queueMicrotask` recovery property. Production workflow/conversation code remains untouched. Publication stays blocked until fresh exact-head local + hosted qualification succeeds.


## 2026-10-01 — exact-main repository line audit

Audited authority: main ac02b9a0ef33f781d3b8cbd6f70a88fbce92092a, tree 2e06f0c2aa58fb2fbac3037470f7673713b0dfa4. Static coverage: 329 tracked files / approximately 45,975 lines; 165 JS/MJS parse clean; 16 shell scripts parse clean; JSON/YAML parse clean; relative Markdown broken links zero; non-doc TODO/FIXME/HACK/XXX zero; secret-pattern scan zero; workflow actions pinned to full commit SHAs; git fsck and diff-check clean. Exact-head Linux and Windows qualification, security audit and doctor all passed.

Two source defects remain actionable from historical PR audit. PR #75 contains a runtime-marker readiness guard that never reached current main, while current concurrency smoke still reads the marker immediately after HTTP health. The fix is rebased with a bounded 30-second marker-identity wait. Windows updater policy overlay is also generalized from only the default profile to named profiles using the existing narrow merge-primary-policy primitive; active routed runtime state remains authoritative except for explicitly owner-authorized runner policy.

Historical PR #74 is superseded by current deterministic v0.10.3 fixtures and successful bounded-concurrency hosted CI. PR #49 is not adopted wholesale: its canonical-first design has been superseded by guarded active-runtime plus explicit-owner-policy overlay semantics, now applied consistently to named profiles. Storage issues #81, #82 and #83 remain separate product work and are not cosmetically closed by this audit.


## 2026-10-01 — storage hardening #81 candidate

Root cause confirmed: Power Mode `writeAnyFile()` created a complete backup before every append, making a growing file produce quadratic backup bytes. Candidate correction keeps overwrite rollback snapshots but changes append recovery to a small verified journal containing target identity, pre-append byte length/hash and appended length/hash. Recovery is deterministic truncate-to-beforeBytes followed by beforeSha256 verification. File backup retention is per-target and retains the newest N rollback points (default 8; configurable 2–64) only after a new rollback point has been created and verified. Directory backup behavior is unchanged. `power_status.backupPolicy` exposes the effective root, retention count and append recovery mechanism.


## 2026-10-01 — delivery storage hardening #82 candidate

Compaction is deliberately separated from acknowledgement. Eligible completed artifacts may move from plain content-addressed JSON to verified gzip archive storage, but delivery state, attempt, correlation and receipt columns are never mutated. The archive is written to a private temporary file, fsynced, decompressed and hash/size verified, atomically renamed, verified again, and only then is the plain artifact removed. Reads are transparent across live/archive storage and keep exact correlation checks. DELIVERY_PENDING, DEAD_LETTER and non-COMPLETED kinds are excluded. delivery_status.storage reports database/artifact bytes, oldest pending timestamp and archive-candidate bytes.


## 2026-10-01 — storage hardening #83 candidate

Pinned tunnel-client v0.0.15 confirms that `--log.file stdout` is supported and is the safe ownership boundary for rotation. Commander now launches tunnel-client through `tools/tunnel-log-runner.mjs`: the child remains the real tunnel process with unchanged profile/health semantics, while the wrapper owns stdout/stderr persistence. Rotation never renames or truncates a file opened by tunnel-client. The wrapper keeps an 8 MiB current log and up to three gzip archives, retains only a bounded recent tail when migrating an oversized legacy current log, writes atomic `*.log.rotation.json` status, forwards termination on Linux, and Windows readiness-failure cleanup explicitly terminates the exact owned tunnel child before the wrapper to prevent orphaning. The wrapper scrubs control-plane/OpenAI credential variables from its own environment immediately after child spawn.

Acceptance regression forces multiple rotations while one child PID stays alive, reconstructs all stdout/stderr bytes exactly across archives/current file, validates archive count/size/status, and separately proves bounded legacy-tail migration. Linux lifecycle, Windows runtime contract, and source-integrity gates bind both platforms to the same logger architecture.


## 2026-10-01 — post-PR87 Git normalization gate

Fresh Linux checkout of main 219f101291ada1488f6f961e3844b94326770474 exposed a repository hygiene defect: autostart-windows.ps1 and windows-supervisor-runtime.ps1 were stored as CRLF bytes inside their Git blobs while .gitattributes already defines the PowerShell text/eol checkout policy. git add --renormalize . identified exactly those two files, and git diff --ignore-space-at-eol proved semantic content was unchanged. The corrective candidate stores canonical LF blobs while preserving checkout behavior through .gitattributes.

## 2026-10-01 — v0.10.4 release preparation

The post-v0.10.3 maintenance line is intentionally promoted to v0.10.4 rather than leaving main with package identity 0.10.3 plus unreleased runtime/storage changes. Exact release-preparation base is main eaba1122db96f7a47172ee0c1cc5ad96c7840b0e. Release scope is backward-compatible hardening: runtime-marker readiness guard, named-profile owner-policy overlay, bounded Power Mode backup recovery/retention, identity-safe delivery artifact compaction, zero-interruption Commander-owned tunnel log rotation, and canonical Git storage for Windows PowerShell blobs. Production remains v0.10.3 until exact v0.10.4 candidate qualification, hosted CI/canaries, immutable publication and live rollout all pass.


## 2026-10-01 — v0.10.4 clean-Ubuntu canary timing blocker
PR #89 head 8ef7ad3a799c3dc17493d47388e8d391b35fda35 had hosted CI PASS and Windows Server canary PASS. Clean-Ubuntu server canary bootstrapped successfully but one async corruption regression exhausted a generic 10-second pre-corruption terminal wait at about 10.03 seconds. Correction is test-only: that fixture now uses a bounded 30-second terminal/worker-exit window plus last-status/worker diagnostics. Production async operation behavior is unchanged.


## 2026-10-01 — async reconciliation deadline race found by v0.10.4 hosted CI
Updated PR #89 exposed a second 10-second hosted-runner boundary: manager reconciliation could mark an operation UNCERTAIN after reservation deadline+5s even while the owned worker PID was still alive and had only recently begun its own timeout budget. Root cause is mixed clocks: reservation deadline begins before worker scheduling; operation-worker timeout begins at actual child start. Correction makes live-worker finalization authoritative until startedAt+timeoutMs+10s receipt grace, with a bounded 60s scheduling hard guard when startedAt has not yet been persisted. Missing workers after deadline remain UNCERTAIN and no replay is introduced.


## 2026-10-01 — v0.10.4 Windows hosted fixture and release identity closure

PR #89 head 43f4b70f7d51e452fb861a235a6ba1685152b720 passed Ubuntu CI but Windows qualification failed before the inherited-stdio semantic assertion because the holder PID marker path became visible before its asynchronous write bytes were readable. Correction is fixture-only: write PID bytes to a unique temporary file and atomically rename to the ready path. The same change-set completes the four release projections that still referenced v0.10.3 (Windows/Linux public installer defaults, installer contract expectations and final-gate log identity). A second async reconciliation regression proves the new live-worker grace cannot mask a worker forever: once startedAt+timeout+finalization grace is exceeded, status fail-closes to UNCERTAIN without replay.


## 2026-10-01 — v0.10.4 final qualification-harness closure

Post-merge main Windows qualification exposed three load-sensitive failures even though PR #89 exact-head Windows/Ubuntu CI and both server canaries passed the identical source tree. Focused exact-main Windows reruns proved tunnel-log rotation 12/12 and workflow-http 8/8 stable. A subsequent hosted rerun exposed a separate default 10-second async-operation observation boundary. Root cause is qualification file-level scheduler/resource pressure, not production semantics. Final candidate isolates workflow-http, async-operations and tunnel-log-rotation from the large concurrent test-file batch and extends only fixture observation deadlines to 30 seconds. Production timeout/reconciliation/tunnel/workflow behavior is unchanged.


## 2026-10-01 — v0.10.4 hosted Windows final memory-order gate

Post-merge main 2321b887b15b22733a3d2f4a092ad7620bf49290 passed Ubuntu CI but Windows failed only after the large qualification batch, when the already-isolated tunnel-log rotation fixture attempted tiny buffer allocations and Node reported Array buffer allocation failure / heap OOM. The exact fixture and production rotation code had passed focused Windows/Linux qualification and PR canaries. Root cause is residual hosted-runner commit pressure plus ordering: scheduler-sensitive isolated fixtures were moved out of the concurrent batch but still executed after it. Candidate prevention is CI-only ordering: hosted Windows runs tunnel-log-rotation first, then async-operations and workflow-http, each still isolated and concurrency=1, then the bulk qualification command. Package/install/update qualification remains unchanged.


## 2026-10-02 — v0.10.5 stream-resume resilience

A strict comparison against Desktop Commander identified a transferable transport pattern: long work should be detached from one chat response, with persistent process state and bounded paged result reads. The user-observed difference between ChatGPT accounts/plans is recorded as correlation only; plan tier is not accepted as the sole root cause without platform evidence.

The exact v0.10.5 candidate reduces Commander's preventable contribution to host stream expiry:
- direct synchronous command ceiling 10 seconds;
- at most two direct synchronous Commander calls per assistant turn;
- direct run_shell/run_project_command response output capped at 32 KiB;
- read_terminal paged at 32 KiB default / 64 KiB max per stream with explicit continuation offsets and <=5 s bounded wait;
- stale custom-app tool catalogs fall back to one-shot start_terminal + bounded read_terminal rather than increasing sync timeouts;
- durable operation_start/MCP Tasks remain preferred when exposed.

Evidence: targeted 13/13 PASS; broad MCP/transport regression 31/31 PASS; full test qualification final run 483 PASS / 0 FAIL / 6 platform-gated SKIP plus all downstream GUI/source/schema gates PASS. A roughly 16-second test group timed out when held in one direct Commander call but completed through start_terminal + later read_terminal, directly validating the background-handoff mitigation.

Remaining external host gate after rollout: an already-open ChatGPT custom app may retain a stale scanned tool catalog. Refresh/Scan Tools and a fresh chat are required to expose the newest operation/read_terminal schemas when the ChatGPT surface permits it. This is not a reason to widen Commander timeouts or replay uncertain mutations.


## 2026-10-02 — v0.10.6 Saeid release line

Status: RELEASE CANDIDATE / NOT YET PUBLISHED.

Previous accepted baseline: official v0.10.5 commit d6912c750640ca57a67be4a9cc8e6485653eb36c.

Current delta: promote the accepted operation-child lifecycle hardening into the production tree; version Saeid V03 policy/monitor, paused-domain, blocked Q5 private-file and Owned Browser R3 development under experimental/ without production wiring. Browser R3 remains a fixture-only component; Q5 remains STOP/DO NOT RUN. No blocked experimental feature is granted runtime authority.

Evidence before full qualification: operation-child-lifecycle targeted 14/14 PASS; Owned Browser R3 source snapshot 11/11 focused tests PASS after exact dependency packaging; V03 focused suite 100/100 PASS; paused-domain suite 27/27 PASS. Full v0.10.6 Windows/hosted CI/canary/release gates remain open until executed on the exact final tree.

Release DoD: exact-tree parser/static/full qualification + security audit + installer/release contracts + hosted Windows/Ubuntu CI + server-install canaries + immutable tag/release readback. Rollback baseline remains v0.10.5 until those gates pass.


## 2026-10-02 — v0.10.6 exact-tree local qualification

Status: LOCAL_FULL_GATE_PASS / HOSTED_GATES_OPEN.

Exact release workspace baseline: official v0.10.5 commit d6912c750640ca57a67be4a9cc8e6485653eb36c plus production operation-child lifecycle hardening and versioned non-runtime experimental snapshots.

Evidence on Windows saeid / Node 24.19.0:
- production operation-child lifecycle targeted regression: 14/14 PASS;
- Owned Browser R3 packaging-rebound focused tests: 11/11 PASS;
- project-operations V03 focused suite: 100/100 PASS;
- paused-domain policy: 27/27 PASS;
- check qualification: PASS, including 248 tests / 243 pass / 0 fail / 5 Windows-host platform skips, GUI 77/77, schema continuity 9/9, source integrity and runtime contracts PASS;
- test qualification: 489 tests / 483 pass / 0 fail / 6 platform-gated skips, followed by workflow/async/tunnel/browser/GUI/source/schema downstream gates PASS;
- security audit: PASS with no secret/token/private-key/developer-path finding;
- installer check, onboarding plugin check and release asset contract: PASS.

Acceptance boundary: this is local exact-tree qualification only. GitHub hosted Windows/Ubuntu CI, server-install canaries, merge, tag, release assets and downstream update/readback remain OPEN. v0.10.5 remains rollback authority until those gates pass.

Companion preservation delta: PR #99 companion source at 715f99ae229e9e44ccc2e2b4ad6e6c3531b442da is now copied byte-for-byte under experimental/companion-v01 with a manifest. It remains blocked from production because hosted Windows recorded COMPANION_ACL_INVALID; this preserves the development without weakening owner/ACL policy.


## 2026-10-02 — R4 release transport reconciliation

The candidate was reconstructed from immutable Git objects on the publication host. Its complete Git tree matched Saeid tree bdc3175d370f7e4062bea078cec2adede6f12e1b exactly. Source commit f3dba1b177fd53fe58b684c0de16aafa81016cf5 remains provenance. A metadata-only correction updates the packaged Browser R3 client byte count from 3873 to 3822 after its previously tested relative-import rebind; its recorded SHA-256 already matched. Both current component manifests were rechecked for exact hashes and byte counts. Historical source snapshots remain unmodified. Hosted CI/canaries and immutable publication remain required; no host rollout is authorized by a passing source transfer alone.


## 2026-10-02 — R5 repeated Windows failure audit

Prior v0.10.4 CI changes serialized and reordered heavy tests after ArrayBuffer allocation failures. Fresh v0.10.6 Windows run 37059429795/job 111012109746 failed in the FIRST isolated tunnel-log fixture (57.5 s, Array buffer allocation failed), followed by child status 3221225794. This disproves residual pressure from this run's earlier bulk suite as a sufficient explanation. Production logger and fixture bytes are unchanged from baseline. Root cause of the observed allocation failure remains UNPROVEN.

A diagnostic hazard is present: strict deep-equality of two ~917 KiB buffers can format a large binary diff upon mismatch, obscuring the underlying comparison. R5 changes only the test comparator to Buffer.equals with fixed-size length/hash/first-difference diagnostics, preserving exact equality. A one-byte injected mismatch must still fail with under 512 characters of metadata. This is stronger diagnostic coverage, not a product fix or relaxed assertion. Independent stdout/stderr arrival order remains an investigation hypothesis; no ordering assertion is removed in R5.

Primary references checked: Node.js v22 process I/O documentation (https://nodejs.org/docs/latest-v22.x/api/process.html); Node.js Assert documentation (https://nodejs.org/api/assert.html). Exact v22.23.3 assertion source was unavailable from the attempted public URL, so allocation causality is not asserted. No blind rerun or deadline increase. Native fixture/hosted tests must determine the next step.


## 2026-10-03 — v0.10.7 Windows qualification isolation

Status: RELEASE CANDIDATE / NOT YET PUBLISHED.

Emad-PC v0.10.6 update remained rollback-safe on active v0.10.4 while local qualification exposed two host-load issues. One stale browser-process fixture subtree was identity-bound and terminated without touching production; the same browser-process test then passed 7/7 alone. MCP Tasks failed only when embedded in the bulk concurrency=2 batch, then passed 1/1 alone on the exact v0.10.6 candidate in about 18.3 seconds. This establishes qualification contention rather than a runtime defect.

Decision: v0.10.7 isolates MCP Tasks as a sensitive test-file command and automatically prioritizes sensitive fixtures on Windows in the bounded qualification wrapper. Runtime code and authority are unchanged. Acceptance requires hosted Windows/Ubuntu CI, install canaries, exact tag/release, and successful candidate-first Emad-PC rollout.


## 2026-10-04 — CURRENT: Emad-PC kernel-resource recovery gate and bounded-enumeration hardening

**Previous accepted state:** stable Commander v0.10.9 is published and accepted on reachable healthy hosts; Emad-PC remained v0.10.8. CEF rc.2 Windows private-file guard qualification has now been repaired and merged into its rc.2 line, not promoted to stable CEF.

**Current delta / key result:** Emad-PC v0.10.9 promotion was correctly stopped by candidate-first qualification. Deep host audit found approximately 3.326M System PID 4 handles, approximately 3.315M of them File handles, with about 23.1 GB paged pool and 15.2 GB nonpaged pool. wcifs is active on C:/D: and the local signature closely matches current Microsoft issue reports, but local stack-level attribution remains PROBABLE rather than CONFIRMED.

**Containment completed:** unattended auto-update on Emad-PC now honors a reversible pause sentinel before fetch/staging; the stale `fix/windows-lifecycle-qualification` sourceRef pin was removed from future local policy. A direct no-Force updater post-check returned `AUTO_UPDATE_PAUSED` with exit 0. No reboot, System-handle closure, filter unload, workflow replay, or destructive backlog cleanup was performed.

**Source prevention candidate:** clean base `6f192c96d51efb3eebdad4dfd49ff36df1888d4b`. Recursive `list_directory` / `search_files` on a bare Windows volume root is refused; synchronous search now has an explicit 5000-entry visit ceiling in addition to result/time bounds; updater pause sentinel is source-controlled. Focused guard 4/4, targeted compatibility/schema 14/14 and updater sentinel contract 1/1 pass. Full local qualification is intentionally DEFERRED because current host state invalidates it.

**Roadmap → NOW:**
1. **DONE / evidence-backed:** CEF PR #59 qualification-only fixes and rc.2 merge.
2. **DONE / evidence-backed:** Emad-PC host diagnosis to confirmed kernel-resource pathology; wcifs attribution remains high-confidence probable.
3. **DONE / evidence-backed:** unattended updater containment and stale development pin removal.
4. **CURRENT:** clean source hardening, documentation, PR and healthy hosted CI.
5. **OPEN OWNER/HOST GATE:** owner-performed Windows recovery/reboot; no automatic reboot authority is exercised.
6. **OPEN:** post-recovery fresh handle/pool baseline and one exact v0.10.9-or-newer qualification on Emad-PC.
7. **OPEN:** remove pause sentinel only after post-recovery gates; then promote through candidate-first updater and perform live readback.

**Critical path / blocker:** Windows kernel-resource recovery on Emad-PC. Until that occurs, local full qualification and v0.10.9 promotion are UNPROVEN/blocked. Hosted CI can validate the source candidate independently.

**Project Brain status:** CURRENT after this delta. Historical Commander and CEF decisions remain append-only; no prior accepted release claims are rewritten.

**Exact next action:** normalize the clean source change set to intended files only, create a guarded GitHub PR, and use hosted Windows/Ubuntu CI as the next valid product gate while Emad-PC remains paused.

## 2026-10-04 — Integrator reconciliation checkpoint

The parallel Windows recovery/prevention work was independently reconciled on clean base `6f192c96d51efb3eebdad4dfd49ff36df1888d4b`. Live Emad-PC kernel state remains abnormal: System PID 4 = **3,326,455 handles**, paged pool **21.537 GiB**, nonpaged pool **13.948 GiB**. Active LAMMPS thesis computation is the dominant CPU load and is preserved; it is not the kernel-handle root-cause claim.

Accepted source scope is intentionally narrow: bare Windows volume-root recursive native enumeration is refused, synchronous search is entry-visit bounded, updater pause sentinel is source-controlled, and the new regression is wired into standard/qualification scripts. Focused local evidence: guard 4/4 PASS, updater contract 1/1 PASS, MCP/schema 2/2 PASS, diff check PASS. Full local qualification is still **BLOCKED/UNPROVEN** by host kernel state.

**CURRENT →** publish this isolated change through GitHub PR and healthy hosted Windows/Ubuntu CI. Emad-PC rollout remains owner-recovery gated; no automatic reboot authority is exercised.

### 2026-10-04 — v0.10.10 integration ordering checkpoint

PR #120 (authority/readiness evidence) and PR #121 (delivery compaction + v0.10.10 release identity) were accepted only after exact-head hosted gates. They are now on main. #122 has been reconciled onto that main while retaining v0.10.10 package/install identity and its filesystem guard regression.

Post-reconcile focused local evidence: delivery + enumeration **18/18 PASS**, installer check PASS, updater contract 1/1 PASS, diff check PASS. **CURRENT →** push reconciled #122 and gate merge on fresh hosted Windows/Ubuntu CI plus Linux/Windows Server canaries. Emad-PC full qualification/rollout remains owner-reboot gated.

### 2026-10-04 — #122 bounded-enumeration refinement

Deep review found that the initial 5,000-entry search budget still sat above bulk `readdir()`, so one huge directory could be enumerated before the budget fired. #122 now streams recursive directory entries with `opendir(bufferSize:1)`. Guard 6/6, smoke PASS and Project Engine 59/59 all pass locally. This closes the I/O-boundedness gap without widening authority or adding a shell-policy feature.


### 2026-10-04 — CURRENT: v0.10.11 Windows control-promotion maintenance patch

**Previous accepted state:** v0.10.10 was published from exact commit `b570d935466665903a776bcca88ff3e51dcdf088`; Release Sync succeeded and the immutable GitHub release carried 19 uploaded assets. Exact candidate-first qualification on healthy Windows host HPC-154-66 passed check/test/audit, native GUI self-test, doctor, hardware self-test, and `AUTO_UPDATE_CANDIDATE_PASS`.

**Current delta / finding:** production canary cutover on HPC-154-66 successfully activated v0.10.10 at route generation 37, but post-commit maintenance stopped with `CONTROL_TRACKED_DIRTY`. Persistent route evidence points to v0.10.10 / `b570d935...` with no previous backend, while `last-update.json` reports `PROMOTED_MAINTENANCE_REQUIRED`.

**Root cause:** the control checkout remained at v0.10.9 and reported only `enable-autostart.ps1` and `enable-boot-recovery.ps1` dirty. `git diff --ignore-space-at-eol --exit-code` passed, both files are governed by `text eol=crlf`, and a forced restore immediately reproduced the same status. This is a historical EOL-normalization false positive, not an owner content edit.

**Decision / minimum sufficient control:** v0.10.11 changes only `Promote-Control`: staged changes remain forbidden; substantive unstaged changes remain forbidden; a fully unstaged EOL-only tracked diff may proceed after explicit evidence logging. No general dirty-tree bypass is introduced.

**Regression evidence:** focused updater contract and parser gate pass after adding a real historical-CRLF Git fixture; the suite is 16/16 PASS including the Windows Job Object lifecycle regression. Full release qualification is still OPEN.

**Roadmap → NOW:** targeted version/installer/release contracts → full local healthy-host qualification → GitHub PR exact-head hosted gates/canaries → merge → immutable v0.10.11 tag/release → exact-ref canary promotion and maintenance readback.

**Open gates:** Emad-PC remains owner-recovery gated with no automatic reboot; Linux laptop GNOME control-plane/session remains a separate host gate.

**Project Brain status:** CURRENT. v0.10.10 history remains immutable and append-only.

**Exact next action:** finish v0.10.11 identity gates, then run full healthy-host qualification before any PR or tag.


#### 2026-10-04 — v0.10.11 healthy-host full qualification PASS

HPC-154-66 completed the exact v0.10.11 source qualification without rerun or timeout relaxation. `check:qualification` main suite: **260 tests / 255 pass / 0 fail / 5 platform skips**; supplementary FS safety, GUI contract 77/77, Linux GUI contract, headless launch, Windows runtime, source integrity, and schema continuity 9/9 all passed. `test:qualification` main suite: **506 tests / 500 pass / 0 fail / 6 platform skips**; browser cleanup/path encoding, concurrency smoke, FS safety, GUI contract 77/77, Linux GUI contract, headless launch, Windows runtime, source integrity, and schema continuity 9/9 all passed. Security audit ended with `SECURITY_AUDIT_PASS` and no tracked secret/developer-path finding.

**Promotion status:** source candidate is locally ACCEPTED for GitHub PR, not yet released. **CURRENT →** commit the isolated v0.10.11 delta, push, and require exact-head hosted Windows/Ubuntu CI plus Linux/Windows Server install canaries before merge/tag.


### 2026-10-04 — FINAL RELEASE ACCEPTANCE: v0.10.11

**Previous accepted state:** v0.10.11 source was locally qualified on healthy Windows and PR #123 was open, but hosted exact-head gates, immutable publication, and the post-release production maintenance path were still OPEN.

**Current delta / key result:** PR #123 exact head `39b222a8f3b59046326578a7e410ae81aab40524` passed all required hosted gates: Windows CI PASS, Ubuntu CI PASS, Linux clean-container server canary PASS, and Windows Server bootstrap canary PASS. PR #123 merged as `8666c29abe1194b314babe4bed24d06a2b398336`. The merge tree is exactly `2ae494fe55eb318b977762c6c1b76e2056e19270`, byte-identical to the locally qualified tree.

**Immutable release:** annotated tag `v0.10.11` object `c1f6f2d9f2f45fb119adac6f49fa67cf1996e863` peels to merge commit `8666c29...`. GitHub Release `Remote Commander v0.10.11` was published 2026-10-04T17:13:40Z, is neither draft nor prerelease, and contains 19 uploaded assets. Release Sync succeeded.

**Post-release exact-ref production canary:** HPC-154-66 was idle before rollout (0 active operations, 0 queued, 0 workflow leases). Updater was invoked with `SourceRef=v0.10.11` and `ExpectedCommit=8666c29...`. Candidate qualification passed check, test, audit, native GUI self-test, doctor, hardware/shadow-store/live-store compatibility, and schema continuity. Qualification Job Objects ended with zero leaked descendants. Production cutover completed with route generation 39, active port 48832, version 0.10.11, exact commit `8666c29...`, previous=null.

**Maintenance blocker closure:** the exact failure from v0.10.10 is now closed. The updater logged `CONTROL_TRACKED_EOL_DRIFT_ACCEPTED`, then `SUPERVISOR_RECYCLE_PASS`, release cleanup of superseded v0.10.10/v0.10.9 trees, and finally `AUTO_UPDATE_PASS version=0.10.11 commit=8666c29...`. `last-update.json` status is `PROMOTED` with completedAt 2026-10-04T17:23:30.9613047Z.

**Known boundary:** the control checkout is now on HEAD `8666c29...`, but raw `git status` still reports only `enable-autostart.ps1` and `enable-boot-recovery.ps1` dirty because of the historical EOL anomaly. This is not an unproven content mutation: staged diff is empty and the complete unstaged diff passes `git diff --ignore-space-at-eol --exit-code`. v0.10.11 intentionally handles this safe EOL-only state rather than weakening dirty-tree protection generally.

**Roadmap → NOW:**
1. **DONE:** focused regression and full healthy-host local qualification.
2. **DONE:** exact-head hosted Windows/Ubuntu CI and Linux/Windows Server canaries.
3. **DONE:** PR #123 merge with qualified-tree identity preserved.
4. **DONE:** immutable v0.10.11 tag/release and 19-asset publication.
5. **DONE:** exact-ref HPC-154-66 production rollout and post-commit maintenance PASS.
6. **OPEN OWNER/HOST GATE:** Emad-PC kernel-resource recovery/reboot and post-recovery baseline remain separate; no automatic reboot authority was exercised.
7. **OPEN HOST GATE:** Linux laptop GNOME/session issue remains separate from the accepted v0.10.11 runtime.

**Project Brain status:** CURRENT. Remote Commander v0.10.11 is the accepted stable release. Historical v0.10.10 failure evidence remains append-only.

**Exact next action:** keep v0.10.11 as stable baseline; do not patch further without a new evidence-backed blocker. Separately continue Emad-PC owner-recovery and Linux host/session gates.


### 2026-10-04 — CURRENT: v0.10.12 scoped Codex plugin maintenance candidate

**Previous accepted state:** Remote Commander v0.10.11 remains the accepted stable release.

**Finding:** the canonical `linux-project-skills` source is version **1.4.13** while the derived managed Codex cache remains at **1.4.9**. OpenAI Codex **0.157.1** source confirms that local non-curated plugin cache refresh is performed through `plugin/list` with `forceRefetch=true`; `plugin/reconcile` is remote-plugin-only, and app-server startup by itself is not evidence of a local-cache refresh. The current v0.10.11 Commander default-deny Codex policy exposes no narrow administrative route for this supported maintenance operation.

**Decision / minimum sufficient control:** v0.10.12 adds `codex_plugin_refresh`, a fixed short-lived `codex app-server` maintenance sidecar. It requires `confirmCurrentRequest=true`, an explicitly authorized Full-Power profile, shell authority, and process-control authority. It does not enable or modify broad `powerMode.codexControl.allowLaunch`, accepts no prompt or arbitrary command/arguments, cannot invoke `exec`, `review`, turns, threads, agents, or delegation, strips OpenAI/Codex API credential environment variables, and uses one total synchronous deadline capped at eight seconds.

**Local qualification:** `npm run check` PASS; `npm test` PASS; `npm run audit` PASS; `npm run check:qualification` PASS with main batch **265 total / 259 pass / 0 fail / 6 platform skips**; `npm run test:qualification` PASS with main batch **511 total / 505 pass / 0 fail / 6 platform skips**. Supplementary GUI contract **77/77**, Linux GUI contract, filesystem safety, headless process-launch policy, Windows runtime contract, source integrity, and schema continuity **9/9** all PASS.

**Status:** ACCEPTED FOR PR / NOT RELEASED. v0.10.11 remains production authority until hosted exact-head gates, merge-tree identity, immutable publication, candidate-first rollout, and live post-cutover cache refresh are proven.

**Open gates:** exact-head hosted Windows and Ubuntu CI; Linux and Windows Server Install canaries; merge-tree identity; immutable v0.10.12 tag/release; candidate-first exact-ref rollout; live `codex_plugin_refresh`; final verification that managed `linux-project-skills` cache is 1.4.13 and authoritative/cache hashes agree.

**Exact next action:** commit only the isolated intended v0.10.12 delta, excluding the known EOL-only dirty PowerShell files; push a guarded PR and require all exact-head hosted gates before merge.


#### 2026-10-04 — v0.10.12 final-tree hardening requalification

Pre-PR review added two fail-closed transport controls without widening authority: `plugin/list` is now explicitly restricted to `marketplaceKinds=["local"]`, returned marketplace/plugin metadata is hard-bounded, text fields are clipped, and oversized app-server JSONL frames are rejected before parsing. Target-plugin lookup remains available even when the display summary is truncated.

Because this changed executable code after the earlier qualification, the complete qualification was rerun on the final tree. `check:qualification`: **267 total / 261 pass / 0 fail / 6 platform skips**. `test:qualification`: **513 total / 507 pass / 0 fail / 6 platform skips**. GUI contract **77/77**, Linux GUI, filesystem safety, headless launch policy, Windows runtime, source integrity, schema continuity **9/9**, and `SECURITY_AUDIT_PASS` all passed.

**CURRENT:** final local tree is QUALIFIED FOR PR; hosted exact-head gates and release/live E2E remain OPEN.


### 2026-10-04 — CURRENT: v0.10.13 Codex maintenance source observability candidate

**Previous accepted state:** Remote Commander v0.10.12 is released and live on Linux at commit `42a73b9e8db10bad34efb76b62dbd72f8a00f434`.

**Post-rollout finding:** the scoped `codex_plugin_refresh` path works through Codex 0.157.1 and keeps broad Codex launch disabled, but `plugin/list(forceRefetch=true)` reports `linux-project-skills@personal` at **1.4.12** while the canonical local Agent Plugins manifest is **1.4.13** and its Codex overlay is **1.4.13+codex.20261004**. Exact Codex 0.157.1 source confirms `PluginSummary` already carries the concrete `source` object, but v0.10.12 intentionally omitted it from Commander's bounded summary, leaving the concrete listed source unproven.

**Decision / minimum sufficient control:** v0.10.13 adds only bounded source observability to `codex_plugin_refresh`. Returned source types are limited to the official Codex 0.157.1 variants (`local`, `git`, `npm`, `remote`), every string remains capped at 512 characters, and existing JSONL frame / marketplace / plugin count bounds remain unchanged. No new method, prompt, command, argument, thread, turn, review, agent, or delegation surface is introduced.

**Local qualification:** focused maintenance/no-Codex suite **15/15 PASS**; `check:qualification` PASS with main batch **267 total / 261 pass / 0 fail / 6 platform skips**; `test:qualification` PASS with main batch **513 total / 507 pass / 0 fail / 6 platform skips**; GUI **77/77**, schema continuity **9/9**, Linux GUI, FS safety, headless launch, Windows runtime, source integrity, and `SECURITY_AUDIT_PASS` all PASS.

**Status:** ACCEPTED FOR PR / NOT RELEASED. v0.10.12 remains production authority until hosted exact-head gates, immutable release, exact-ref rollout, and live source-path diagnosis pass.

**Open gate after rollout:** run `codex_plugin_refresh` against `linux-project-skills`, record the returned concrete source path/type, and reconcile why Codex lists/materializes 1.4.12 while the canonical source tree is 1.4.13. Do not hand-edit the managed Codex cache.


### 2026-10-04 — CURRENT: v0.10.14 Linux post-cutover maintenance recovery candidate

**Previous accepted state:** Remote Commander v0.10.13 is released and live on the Linux laptop at merge commit `6bdc26f172155cd833c0569083ea34a3d8d64392`. The scoped Codex maintenance E2E now confirms `linux-project-skills@personal` at **1.4.13** from the canonical local path, with source/cache manifest hashes equal. The personal Remote Commander Work/Codex projection was manually reconciled from 0.10.4 to **0.10.13**, preserving its private app binding, and Codex materialized the 0.10.13 cache successfully.

**Finding:** routed runtime cutovers for v0.10.11, v0.10.12 and v0.10.13 succeeded, but the Linux control checkout remained at v0.10.9 and `last-update.json` was not durably completed. Live control status contains only `enable-autostart.ps1` and `enable-boot-recovery.ps1`; the index is clean and `git diff --ignore-space-at-eol --exit-code --` returns zero. Updater logs stop after post-cutover GUI synchronization, proving the maintenance tail was blocked by historical EOL-only dirtiness. This also allowed the personal Work plugin projection to remain stale until manual repair.

**Decision / minimum sufficient control:** v0.10.14 makes Linux control promotion tolerate only proven CR-at-EOL drift while continuing to reject staged and substantive tracked mutation; verifies the promoted exact commit; retains the ERR trap after route commit; and adds an atomic `sync_work_plugin_projection` maintenance step. That step is no-op when the personal plugin is absent, validates the existing app binding without logging it, backs up prestate, stages from the exact immutable candidate template, preserves `.app.json` bytes, applies the same personal interface/app references as the Work installer, atomically swaps with rollback, and post-verifies versions plus binding hash.

**Local qualification:** focused updater contract **17 pass / 0 fail / 1 Windows-only skip**; `check:qualification` **269 total / 263 pass / 0 fail / 6 platform skips**; `test:qualification` **515 total / 509 pass / 0 fail / 6 platform skips**; GUI **77/77**; schema continuity **9/9**; Linux GUI, FS safety, headless launch policy, Windows runtime, source integrity and `SECURITY_AUDIT_PASS` all PASS.

**Status:** ACCEPTED FOR PR / NOT RELEASED. v0.10.13 remains production authority until exact-head hosted gates, merge-tree identity, immutable release and Linux rollout prove the post-cutover maintenance tail end-to-end.

**Open gates:** Windows CI; Ubuntu CI; Linux Server Install Canary; Windows Server Install Canary; immutable v0.10.14 release; exact-ref Linux rollout; control HEAD == release merge commit; durable updater completion state; `WORK_PLUGIN_SOURCE_SYNC_PASS version=0.10.14`; personal Work plugin source/cache == 0.10.14 with binding preserved.

**Exact next action:** stage only the intended v0.10.14 files, exclude the two historical EOL-only PowerShell worktree artifacts, push the branch and require all hosted exact-head gates before merge.


### 2026-10-05 — Scope narrowed to Linux-only

**Authority update:** current owner direction limits continued work to Linux and Linux-specialized components on the active Linux host. Windows implementation, debugging and Windows-specific release acceptance are DEFERRED and are not part of the current DoD.

**Release interpretation:** v0.10.14 remains an exact-commit Linux candidate. Do not merge/tag it as a repository-wide cross-platform release under the current scope. Linux acceptance is based on Linux qualification, source/security integrity, candidate-first exact-commit rollout, control promotion completion, durable updater completion and Work/Codex projection/cache verification on the active Linux host.

**Exact next action:** commit the Linux test-scope correction, close the cross-platform PR to prevent accidental merge, push the Linux candidate branch, then roll out that exact commit on the active Linux machine and verify all Linux post-cutover invariants.


### 2026-10-05 — Linux updater self-termination root cause confirmed

**Fact / live reproduction:** exact-commit v0.10.14 rollout from a Commander-owned terminal passed both qualification gates and cut over runtime to `b8a136f92bf3958dc87945c47b88672fb80f1337`, but the updater process disappeared immediately after `ROUTER_PREVIOUS_RETIRED`. No updater process remained and the same invocation never reached control promotion, Work plugin sync or final PASS. This demonstrates that retiring the backend that owns the invoking terminal can terminate the updater's own process tree.

**Fact / recovery:** a second same-version maintenance invocation on the new runtime logged `CONTROL_EOL_DRIFT_TOLERATED`, promoted control to `b8a136f...`, synchronized the Work plugin to 0.10.14, logged `AUTO_UPDATE_MAINTENANCE_PASS` and requested supervisor recycle. Therefore EOL-only drift is a secondary control-promotion issue, not the complete explanation for the first-pass truncation.

**Change:** the Linux updater now performs a bounded managed-backend ancestry check before acquiring the updater lock. A Commander-owned manual invocation re-execs the exact original arguments in an independent `setsid` session with a one-shot detached marker. Supervisor invocations and self-test remain unchanged. Missing `setsid` fails closed.

**Change / durable completion:** Linux PASS paths now atomically write `last-update.json` before the PASS log. Receipt identity is validated (status, semver, exact commit and bounded source ref), file mode is 0600, and invalid rewrite attempts preserve the previous receipt.

**Qualification on final pre-commit byte-state:** focused Linux updater/installer/schema set **24 pass / 0 fail / 1 platform skip**; `check:qualification` **270/264/0/6**; `test:qualification` **516/510/0/6**; GUI **77/77**; schema continuity **9/9**; `SOURCE_INTEGRITY_PASS`; `SECURITY_AUDIT_PASS`.

**Current gate:** commit/push the exact Linux candidate and prove a new rollout started through Commander completes in one invocation after `AUTO_UPDATE_SELF_DETACH_REQUESTED`, with no same-version recovery run required.


### 2026-10-05 — Linux delivery beacon pollution root cause and candidate fix

**OS/scope authority:** active host was re-verified as Linux before each action. Windows remains out of scope.

**Fact / live evidence:** durable-delivery backlog grew above 420 while `deadLetter=0` and `unfinishedRequests=0`. Read-only SQLite inspection showed every pending row had `attempts=0`, a unique synthetic `transport-<sha256>` correlation, and no delivery-request reservation. Artifact metadata showed the backlog is overwhelmingly internal auto-deferred operations: copy_path 353, delete_path 67, move_path 8, plus 4 run_shell operation receipts; it is not evidence of hundreds of lost chat messages.

**Root cause:** legacy/cached MCP mutation calls without explicit requestId derive a transport idempotency key. For auto-deferred copy/move/delete, that transport key was also reused as the operation delivery correlation. Async reconciliation then published every terminal receipt into durable delivery, and Linux `queue-only` continuation has no authenticated consumer for those synthetic correlations. Retry durability and user-visible delivery were therefore conflated.

**Control:** transport-derived auto-deferred operations persist `deliveryMode=transport-retry-only`; worker/state/idempotency/restart recovery remain durable, but no actionable delivery event is published. Explicit operation/request correlations remain `durable` and preserve normal delivery behavior. Startup reconciliation skips persisted transport-only operations.

**Historical repair:** a new `TRANSPORT_RECEIPT` state and bounded `delivery_reclassify_transport_receipts` tool reclassify only zero-attempt `source=operation` rows with an exact synthetic transport correlation and operation event identity. No artifact is deleted and no acknowledgement is synthesized; default list/beacon excludes these internal receipts while full/history reads remain possible.

**Linux-focused qualification:** state/restart/delivery suite **38/38 PASS**; real HTTP transport regression **2/2 PASS**; combined Linux/core relevant suite **50/50 PASS**; `SOURCE_INTEGRITY_PASS`; `SECURITY_AUDIT_PASS`; `git diff --check` PASS.

**Exact next action:** commit/push this Linux candidate, roll out the exact commit on the active Linux host, back up the live delivery store, reclassify only proven legacy transport receipts, then verify pending drops without artifact loss and that a new transport-derived copy does not increase pending while an explicit-request copy still does.


### 2026-10-05 — Linux delivery identity stabilization across routed updates

**Previous accepted state:** live v0.10.14 commit `9fb2dacc96ee86b4e662de050e02d309aa11a85f` separates internal transport retry receipts from actionable delivery. After bounded legacy repair and exact-ID fallback-smoke cleanup, the active Linux delivery store reports `pending=0`, `deadLetter=0`, `unfinishedRequests=0`, and a live transport-derived `copy_path` completed with `deliveryMode=transport-retry-only` without increasing pending.

**New finding / read-only inventory:** the historical default delivery root contains **1790 SQLite scope directories**, **313 empty scopes**, **20,974 total rows**, and **20,531 historical pending rows**. The largest obsolete scopes contain hundreds of rows. The current scope formula includes the absolute runtime `configPath`; routed candidate config paths rotate on updates and qualification/test configs therefore create separate scope identities. These old databases are not the active queue, but the fragmentation obscures durable continuity and pollutes per-user state.

**Decision / minimum sufficient control:** do not mass-delete or mass-ack historical databases. Preserve backward compatibility for ad-hoc legacy configs, while making managed Linux candidate configs carry an explicit stable delivery identity. `deliveryLocation` now honors an explicit validated `durableDelivery.scope`; the candidate builder pins the currently active directory+scope when an existing config is supplied. A fresh managed install derives one stable scope from device identity + profile and stores it explicitly. Linux diagnostic candidates receive a dedicated delivery shadow and diagnostic scope; the final candidate preserves production delivery identity. Thus hardware/self-test effects cannot write into the production delivery queue while routed config-path rotation no longer fragments production state.

**Qualification on final byte-state:** shared delivery/async/candidate/schema suite **49/49 PASS**; Linux GUI/installer/tunnel suite **11/11 PASS**; targeted Linux updater contract **1/1 PASS**; `bash -n auto-update-linux.sh` PASS; `git diff --check` PASS; `SOURCE_INTEGRITY_PASS`; `SECURITY_AUDIT_PASS`. A minimal Linux installer fixture initially missed the new builder dependency (`src/delivery-store.mjs` + `src/platform.mjs`); the fixture was aligned with the actual repository dependency graph and all Linux installer isolation tests then passed. Windows remains outside the acceptance scope.

**Historical-state boundary:** the 1790 historical directories remain untouched and forensically recoverable. Before any cleanup, enumerate all current Linux routing/profile/config references, protect every referenced explicit or legacy scope, then archive unreferenced scope directories with a manifest and no deletion.

**Exact next action:** commit/push only the Linux delivery-identity files, roll out the exact commit, verify the active config contains the same production delivery directory+scope as pre-rollout with `pending=0`, and verify the diagnostic candidate used its shadow store. Only then archive unreferenced historical delivery scopes.


### 2026-10-05 — Cross-platform product-shell Access & Operations milestone

**Previous accepted state:** cross-platform candidate baseline `383393d` combines the current Windows product shell with the v0.10.14 Linux stabilization changes. Production Windows is still v0.10.13; promotion is not implied.

**Current delta / confirmed:** per-capability permission changes now reach the existing guarded capability migration path. Primary-profile edits are scoped through the qualified updater with `TargetProfile`; isolated profiles retain transactional reconfigure/rollback. Profile UI now exposes explicit access controls and authoritative inventory rather than treating stale version labels as profiles. The live Windows inventory remains `default` + `saeed-emad`; `10.04` is not a live profile.

**Admin design:** current-user Task Scheduler `Interactive + Highest` is the selected minimum-sufficient elevation boundary. Registration requires one UAC, then an elevated probe/readback must PASS before the legacy HKCU Run launcher is disabled. No password/S4U credential is stored; removal/activation have rollback/fallback paths. Source/contract is complete; live task registration is still OPEN.

**Monitoring:** workflow CLI wiring was repaired to consume full Commander config correctly and expand environment roots. It opens the real production SQLite store. Current live scheduler is recovery/readiness-only: `automaticExecution=false`, `runnerConfigured=false`, `persistedNonterminal=807`, `currentLeases=0`. Persisted RUNNING rows are explicitly not presented as live processes.

**UI/package:** Dashboard now exposes Profiles & Access, Operations Monitor and Admin Runtime. Desktop build includes all three scripts; installer defines four Start Menu shortcuts using the product icon. Windows self-contained publish PASS, v0.10.14 executable SHA-256 `7af21bbaa8036906b0483eca89154460cd8b10219cd13e6615fcb475a655ea5b`; candidate dashboard runtime window observed.

**Regression:** focused contracts **31/31 PASS**; `test:update` **78 pass / 0 fail / 2 platform skips** plus MCP Tasks **1/1 PASS**.

**Status:** CURRENT candidate / not yet FINAL. Exact-head full qualification, commit/push/hosted CI, live Windows install/readback, Linux laptop and Amirreza Server acceptance, and a separate truthful timed-scheduler/same-chat-continuation change set remain open.

**Exact next action:** exclude the two proven EOL-only checkout artifacts from staging, commit this Access & Operations change set with exact evidence, run exact-head qualification, then exercise the same commit on Windows/Linux/Amirreza before promotion.


### 2026-10-05 — Hosted Windows interactive-terminal root cause and prevention

**Previous accepted state:** product/access commit `263589c6381bfa9a0a62c430584b824b61bcd799` passed local bounded Windows qualification, Linux exact-head acceptance, Desktop v0.10.14 installation and live UI smoke. PR #129 then supplied independent hosted evidence.

**Hosted finding / reproduced failure:** Ubuntu CI and Linux clean-container canary passed, but both Windows CI and Windows Server bootstrap independently failed the same contract: `start_terminal remains interactive only when explicitly requested with an initial command`. This repeated failure supersedes the earlier load-only interpretation. A local diagnostic rerun reproduced the semantic race: the interactive PowerShell prompt appeared, while the immediately-written startup statement had not executed.

**Root cause:** Windows interactive terminal startup used plain `pwsh.exe -NoLogo -NoProfile` with piped stdin, then wrote the initial command immediately. That relies on implicit interactive-console stdin behavior and is not a stable redirected-stdin contract. Microsoft `about_Pwsh` documents `-Command -` as the explicit standard-input statement mode and `-NoExit` as keeping the process alive after startup commands.

**Minimum sufficient fix:** Windows interactive sessions now launch `pwsh.exe -NoLogo -NoProfile -NoExit -Command -`. Initial command and later `send_terminal` messages share the same explicit stdin statement channel. One-shot sessions are unchanged. Linux interactive behavior is unchanged. Regression now verifies both `INTERACTIVE_READY` and a follow-up `INTERACTIVE_FOLLOWUP` before cleanup.

**Focused evidence:** `test/process-tree-lifecycle.test.mjs` **7/7 PASS** on Windows after the implementation fix, including descendant termination, one-shot lifecycle, paged reads, bounded wait, interactive startup, follow-up input, and cleanup.

**Status:** fix locally verified; full bounded qualification, final-head hosted CI/canaries and final-head cross-host acceptance remain OPEN. No merge or core promotion until those gates pass.


**Post-fix full bounded qualification:** `npm run check:qualification` PASS on Windows; main batch **277 total / 270 pass / 0 fail / 7 platform skips**, with supplemental browser/GUI/installer/source/security gates completing under exit code 0. This supersedes the focused 7/7 evidence for local promotion readiness; hosted final-head gates remain authoritative for merge.

### 2026-10-05 — PR #129 Windows terminal-readiness blocker repaired locally

**Previous accepted state:** candidate `263589c` had Windows local bounded qualification PASS and Linux laptop exact-SHA acceptance PASS, but hosted Windows CI and Server Install Canary each failed the same interactive-terminal readiness test. Ubuntu CI and Linux clean-container canary were PASS.

**Current delta:** root cause was narrowed to Windows interactive PowerShell startup/readiness semantics, not Access/Admin/Monitor logic. Windows interactive initial commands now execute through PowerShell argv (`-NoExit -Command <command>`) instead of being written to stdin before shell readiness; follow-up stdin remains supported. The regression waits across multiple bounded read chunks and uses a 15 s readiness ceiling justified by observed loaded-host startup variance. Three sequential targeted local runs are **6/6 PASS**.

**Cross-platform evidence:** Linux laptop exact `263589c` acceptance PASS: 44 executed tests PASS + 1 Windows-only skip, Linux GUI contract PASS, source integrity PASS, security audit PASS; no live runtime mutation.

**Status:** CURRENT candidate, not FINAL. Hosted Windows/Server gates must pass on the new commit, then Amirreza Server exact-head acceptance and exact-head full bounded qualification must pass before merge/promotion.

**Exact next action:** commit only the Windows terminal-readiness repair + evidence, run `check:qualification` on that exact commit, push PR #129, then require hosted CI + Server Install Canary PASS and exact-head Amirreza acceptance before any runtime/release promotion.

### 2026-10-05 — CURRENT authority moved to v0.10.15 hotfix

**Previous accepted state:** `main` merged PR #129 as `b91fa45` and tagged `v0.10.14`; that tree equals PR head `db5053e`. The later terminal-readiness repair was not in main.

**Current delta:** clean hotfix worktree `_rc_hotfix_v01015_20261005` is based on `b91fa45`; `42b4031` carries exactly the five-file repair/evidence delta. Release metadata is being bumped to `0.10.15` / `v0.10.15`. The overlapping recurring finalization task is paused, leaving this worktree as the sole writer.

**Status:** CURRENT candidate, not FINAL. Do not rewrite `v0.10.14`. Exact-head Windows/Linux/Amirreza + hosted CI/canary + merge/tag/release/post-install gates remain OPEN.

**Exact next action:** commit the narrow release-metadata bump, qualify that exact SHA, push the hotfix branch, open a dedicated PR, then require all cross-host/hosted gates before merge and release.

### 2026-10-05 — v0.10.15 local qualification PASS

**Key result:** candidate code `b6cdeec` completed bounded Windows qualification with **270 pass / 0 fail / 7 platform skips**, plus installer/onboarding/release/browser/GUI supplemental PASS gates.

**Failure converted to guard:** the preceding `09f4e27` attempt failed because current-release contracts still pinned v0.10.14. Release identity is now treated as one atomic surface spanning package/runtime/installers/server installers/plugin templates/contracts/docs/final-gate naming.

**Roadmap ← now:** local Windows qualification PASS ← **CURRENT**; hosted PR CI/server canary, Linux laptop exact-head acceptance, Amirreza exact-head acceptance, merge, immutable v0.10.15 tag/release and post-release readback remain OPEN.

**Exact next action:** push the hotfix final documentation head, open the v0.10.15 PR, require exact-head hosted and cross-host PASS before merge/promotion.

### 2026-10-05 — v0.10.15 FINAL release milestone

**Previous accepted state:** v0.10.14 was immutable production; v0.10.15 candidate had local + hosted + cross-host qualification PASS but release and live rollout were still OPEN.

**Current delta:** PR #130 merged as `4438b546035da192999954dd40e78ddbb6a9e7bd`; annotated tag `v0.10.15` points to that exact merge commit; official release-sync published verified immutable assets. Live readback confirms v0.10.15 on the primary Windows PC, its isolated `saeed-emad` profile, the Linux laptop and Amirreza Server, all with healthy runtime responses.

**Roadmap ← now:** code qualification PASS → hosted CI/canary PASS → cross-host acceptance PASS → merge PASS → immutable release PASS → live rollout/readback PASS ← **CURRENT / FINAL for v0.10.15 software release**.

**Open / deferred:** physical AC-loss/reboot validation remains a distinct hardware/operations test; it is not inferred from software health and remains UNPROVEN until intentionally exercised.

**Exact next action:** no further v0.10.15 software mutation. Preserve `v0.10.15` immutably; future product changes start from current `main` under a new change set/version.

### 2026-10-06 — CURRENT v0.10.16 single-product Windows installer candidate

**Previous accepted state:** v0.10.15 is immutable production. Windows Commander runtime is healthy, but the installed Desktop shell/Start Menu packaging exposed internal tools as multiple applications. Remote Commander Browser is a separate pre-release line.

**Current delta:** Start Menu was repaired to one public Commander shortcut plus the independently installed Browser shortcut. The candidate now implements one Windows Setup executable with `Core` and `Control & Monitoring` modes, multi-profile post-install onboarding, a correct per-user/UAC boundary, secure in-memory API-key handoff, a standards-compliant multi-size icon, and release automation for the Setup EXE. The conditional Browser component compiles but is intentionally hidden unless a verified standalone Browser installer is supplied.

**Evidence:** both Inno compile branches PASS without warnings; focused installer/product contracts 9/9 PASS; update regression 83 pass / 0 fail / 2 platform skips plus MCP Tasks 1/1 PASS. Live runtime remains v0.10.15 and was not promoted by candidate testing.

**Authority / boundary:** accepted production remains `v0.10.15`. v0.10.16 is **CURRENT candidate / UNPROVEN for release** until exact-head full qualification + hosted CI/canary + Linux laptop + Amirreza Server acceptance + merge/tag/release + post-release readback. Browser v0.8.0-rc.4 is not promoted into the Commander release and fully bidirectional integration remains OPEN.

**Critical path ← CURRENT:** release-identity closure → exact-head qualification → hosted/cross-host gates → merge → immutable v0.10.16 tag/release with single-file Setup → live rollout/readback. Production Authenticode signing is an external certificate gate and is not fabricated with self-signing.

**Exact next action:** complete the v0.10.16 release-identity/documentation delta, qualify the exact commit, then push and require hosted/cross-host evidence before promotion.

### 2026-10-06 — Commander v0.10.16 single-shell change set locally PASS

**Key result:** Windows bounded qualification finished with **275 pass / 0 fail / 7 skips**. Single public shell, Core vs Control+Monitoring component split, multi-profile enrollment and fresh-Windows prerequisite bootstrap are verified locally.

**Authority:** branch base still equals current `origin/main 54bb5a1`; no writer overlap detected.

**← CURRENT:** commit this qualified single-shell/monitoring/profile change set. Browser rc.5 release is the only dependency before the next Commander mutation: pin/verify/embed the released Browser Setup, then rerun exact-head Windows/Linux/Amirreza/hosted gates.

### 2026-10-06 — Commander PR #132 Windows fixes locally PASS

**Root causes closed:** clean bootstrap no longer loses verified process-only Git/Node paths; Project Engine early-timer regression now models real wall-clock semantics instead of assuming scheduler punctuality.

**Evidence:** focused affected fixtures 15/15 PASS across five consecutive iterations; full bounded Windows qualification again PASS with **275 pass / 0 fail / 7 skips** in the main batch.

**← CURRENT:** commit/push exact fix head to PR #132 and require fresh hosted Windows CI + Windows clean Server canary. Browser rc.6 release remains the dependency before Commander release wiring and merge.

### 2026-10-06 — v0.10.16 conversation handoff gate locally PASS

**Previous delta:** bootstrap PATH and Project Engine deadline harness fixes at `8d40495` closed clean-server bootstrap and earlier scheduler timing failures. Push Windows CI and both server canaries were PASS, but PR-event Windows exposed one independent polling flake in `workflow-conversation.test.mjs`.

**Current delta:** test now waits on the controller's existing serialized `drainPromise` rather than polling store state. No delivery/runtime timeout or retry behavior changed. Focused regression: 10/10 PASS. Full Windows `check:qualification + test:qualification + audit`: exit 0, main bounded batch 275 PASS / 0 FAIL / 7 skips.

**Benchmark result:** Browser/profile ownership is aligned with Playwright MCP's persistent/isolated model. Remote hosted OAuth/device revocation is a future architecture option, not a current owner-bound release blocker. Windows publisher signing remains MISSING/EXTERNAL and must not be claimed FINAL without a real certificate/signing service.

**← CURRENT:** commit/push the deterministic drain test fix from the isolated worktree, require fresh hosted PR CI on exact head, then pin the immutable Browser rc.6 release asset into Commander Setup and rerun release gates. Original dirty worktree remains untouched.

### 2026-10-06 — v0.10.16 final release integration

**Previous accepted state:** PR #132 exact head `c00e379` had Windows/Linux CI and Server Install Canary PASS, single-shell Windows Setup implementation, profile enrollment, deterministic conversation drain and optional Browser compile hook. Browser bundling was deferred because no immutable standalone Browser Setup dependency had been published.

**Current delta:** Browser v0.8.0-rc.8 is now a qualified immutable release. Commander release CI pins its Setup SHA-256 `c1f04ff74bf3f7caf8b192bc35c4bf4d08f1149a890a164df511bcdfd16893c3`, verifies the download before bundling, uses the verified portable Inno 6.7.3 bootstrap, runs the real Setup build on relevant PRs, and includes latest main Companion admission changes.

**← CURRENT:** run local dependency fetch + contract tests + actual bundled Setup compile; then push the final exact head to PR #132 and require fresh hosted CI, Windows Server canary and Release Sync PR build PASS before marking ready/merging. After merge, tag `v0.10.16`, require immutable release publication and live asset readback.

### 2026-10-06 — local bundled Setup mechanics PASS

Browser rc.8 download/hash verification, pinned Inno acquisition, desktop payload build and actual Commander Setup compilation all PASS locally. The resulting Setup reports `browserBundled=true`. This is pre-push validation only because the worktree is intentionally dirty during the Change Set.

**← CURRENT:** run full local suite, commit only intentional release-integration files, push to existing PR #132, then require fresh exact-head hosted gates including the new Release Sync PR build.

### 2026-10-06 — local qualification anomaly disposition

Full local `check:qualification` was not promoted to PASS: one unrelated Windows temp-directory after-hook cleanup returned EPERM. All fixture descendant PIDs were already dead, the directory deleted successfully once the runner exited, and a single targeted regression passed 1/1. No code patch was justified.

**Gate:** fresh hosted exact-head CI/Server Canary/Release Sync must all PASS; otherwise stop promotion and investigate the hosted failure.

### 2026-10-06 — Release Sync blocker: clean guard aligned with qualified Windows EOL policy

**Failure:** exact-head Release Sync `37457196824` fetched and verified Inno + Browser successfully, then stopped because the Setup clean guard saw one tracked Windows checkout drift entry.

**Root cause:** raw porcelain status rejected historical CRLF-only normalization already tolerated by the project's qualified control-promotion classifier.

**Fix:** reject untracked, staged and substantive unstaged changes; allow only EOL-only tracked drift with an audit marker. No `-AllowDirty` in hosted release. **← CURRENT:** local no-AllowDirty compile, push fresh head, require all hosted gates PASS.

### 2026-10-06 — clean-guard local V&V complete

Negative regression rejected substantive unstaged drift; positive regression on the committed fix accepted only the single known EOL-only tracked drift and completed the Browser-bundled Setup build without `-AllowDirty`.

**← CURRENT:** publish the superseding exact head to PR #132 and require fresh hosted Release Sync + CI + Server Canary PASS before promotion.


### 2026-10-06 — v0.10.17 diagnostics finalization candidate

**Previous accepted state:** immutable v0.10.16 release at 46655c5ae7d5504956959dfc7f2126fcc6824b6a. One unattended Windows exact-release qualification failure retained lifecycle metadata but not child stdout/stderr.

**Current delta:** candidate v0.10.17 contains the qualified diagnostics tree from PR #134 while preserving Job Object containment, timeout, cleanup, backoff and fail-closed exit semantics. Release identity advances without modifying the immutable v0.10.16 tag.

**Historical failure audit:** three attempts of the superseded local release runner incorrectly required a cherry-picked commit SHA to equal the source commit SHA. Git records a new commit for a cherry-pick; content equivalence is therefore guarded by exact tree identity. The superseded runner is DO NOT RUN.

**Current gate:** focused local qualification open; no tag or live runtime mutation has occurred.

**Exact next action:** qualify this exact candidate on Windows/Linux and hosted gates, merge only if green, then tag/publish v0.10.17 and perform candidate-first fleet rollout/readback.

### 2026-10-06 — v0.10.17 hosted Windows Job Object harness latency

Exact-head CI run 37496855550 failed only the pre-existing Job Object containment test with missing report at 15.046s. The test outer spawnSync killed pwsh at exactly 15000ms before the runner finally/report path could complete. Local Windows full qualification, Linux cross-host, Ubuntu hosted CI, new qualification-output tests, and Release Sync were already PASS. Mutation is test-only: give the outer wrapper a bounded minimum 30s budget, detect early wrapper exit, and emit explicit timeout diagnostics; production Job Object, child timeout, cleanup and exit semantics are unchanged. Promotion remains blocked pending targeted stress, full local requalification and fresh hosted exact-head Windows CI.


### 2026-10-07 — stable Browser dependency admitted for v0.10.17

Remote Commander Browser v0.8.0 is published non-draft/non-prerelease and immutable. Stable tag peels to Browser merge commit `239a171eebb0f673f3bd57f59de80cf9229b3df6` with qualified tree `a203fbe8b0d3809de21c6647138dc5fbeca3ed98`. Official Setup asset is `Remote-Commander-Browser-Setup-v0.8.0.exe` size 136253241 bytes, SHA-256 `61fd810130845815dd20073f72051aec3b42c1a89b9577b3457f2190bd9b1a5e`. Commander v0.10.17 now pins that exact stable dependency. No user Browser profile/session authority changes.

**Current gate:** real dependency download/hash + bundled Setup compile, then fresh exact-head hosted/cross-host qualification.
### 2026-10-07 — deterministic conversation handoff test closure

**Failure:** push-CI run `37533283937` failed only `conversation-continuation.test.mjs` while Windows Job Object/output-retention tests and Ubuntu CI passed. The acknowledged-handoff fixture polled for only 1500 ms and asserted false after hosted scheduler delay; production controller already exposes its serialized `drainPromise`.

**Root cause / prevention:** stale test polling was replaced by `await controller.drain()` before deterministic state assertions. Production `src/conversation-continuation.mjs` remained byte-identical, SHA-256 `FC2472B024A73AA86655ECF03FD6A9C17C0F7323B946C126C45B00489F0715A3`; no delivery timeout, retry, acknowledgement or runtime behavior changed.

**V&V:** patched test SHA-256 `A7BABA1732CF0A46CD9E4AD134F2AE223699E37B7CB1A62317B1CFAE203BADEA`; 10 independent executions passed 8/8 tests each, zero failures. Stable Browser v0.8.0 dependency bundling is independently PASS on exact parent `a58e2ff` with official Browser Setup SHA-256 `61fd810130845815dd20073f72051aec3b42c1a89b9577b3457f2190bd9b1a5e`.

**Current gate:** commit this harness-only closure and run full exact-head qualification plus fresh hosted CI/Release Sync/Server Canary before merge/tag.
### 2026-10-07 — Windows Job Object ownership-predicate closure

**Failure audit:** exact-head local qualification failed the wrapper-termination fixture after both recorded descendant PIDs were confirmed gone because a raw TCP connect still succeeded on the previously reserved numeric port. This was the third recurrence in the Windows Job/fixture family, so blind timeout/predicate patching stopped and historical + primary-source review was performed.

**Primary semantics:** Microsoft Job Objects documentation states that child processes are associated with the parent job by default unless breakaway limits are enabled, and `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` terminates all associated processes when the last job handle closes. The production runner uses `CreateJobObject`, sets only KILL_ON_JOB_CLOSE, creates the root suspended, assigns it before resume, and exposes no breakaway flag. Microsoft `Get-NetTCPConnection` exposes `OwningProcess`, allowing listener identity rather than raw port occupancy to be tested. Sources: https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects and https://learn.microsoft.com/en-us/powershell/module/nettcpip/get-nettcpconnection .

**Root cause:** regression predicate conflated numeric port occupancy with original grandchild ownership. A different process may bind the freed port after the Job-owned process exits. Production runner behavior was not changed.

**Mutation / prevention:** test helper now resolves listeners via `Get-NetTCPConnection -LocalPort <port> -State Listen`, captures owning PID + command line, and rejects only the original grandchild identity. When the port is free after cleanup, the test deliberately rebinds it from the test process and proves that foreign reuse is not misclassified as a Job leak.

**V&V:** patched test SHA-256 `019DF03440600C6431F2BD14CE4D1088FF580F073906EA75A9BE5CE5FFB1AB52`; production runner SHA-256 remains `500882E264368794D6155B232991D94CC33EA73C47ABFF01970091280A501E74`. Five independent targeted Windows runs PASS 1/1 each, zero failures; operation `b1989854-4ad5-4361-a14b-70d4fe7e9c1e` completed exit 0. Previous raw-listener predicate is SUPERSEDED—DO NOT RUN.

**Related release state:** Remote Commander Browser v0.8.0 is published immutable/non-prerelease; official Setup SHA-256 `61fd810130845815dd20073f72051aec3b42c1a89b9577b3457f2190bd9b1a5e`. Emad Browser stable rollout PASS preserved 1821 profile files/501 profile directories and old rc.4 rollback; Saeed stable install was reconciled after wrapper timeout from authoritative post-state: version 0.8.0, package `f624fb89136718e99e52cce35d811b2ca96a5c2ff01f5223405e24c3cc367768`, no Browser process auto-launched and no profile created.

**Current gate:** full exact-head Commander qualification after this test-only correction; then fresh hosted CI/Release Sync/Server Canary on one final SHA, merge/tag/publish and fleet rollout.
### 2026-10-07 — Linux updater tunnel-readiness false-negative root cause / v0.10.18 hotfix candidate

**Previous accepted state:** Remote Commander v0.10.17 is immutable/released and Windows Emad default+saeed-emad are live/current on exact merge `8541e33f1d9dd1e63738e4c005106122990ad43c`. Linux v0.10.17 qualification repeatedly passed linux-gui-safety/check/test/audit, candidate doctor/hardware selftest and schema continuity, but failed before CUTOVER_COMMIT at `tunnel readiness failed`, preserving the v0.10.16 route.

**Historical Failure Audit / raw live evidence:** `tunnels_ready()` required every matching tunnel profile `/readyz` body to equal `ready`. The Linux `saeed-emad-laptop` tunnel on health port 47833 returned `/healthz=live` but `/readyz` reported an OAuth-discovery connection-refused message for local 47831. At the same timestamps that tunnel service journal repeatedly recorded `dispatcher forwarded command to MCP server` for the active ChatGPT Remote Commander calls. Its `/metrics` exposed `commands_poll_last_successful_timestamp_seconds` with age 0 seconds; the primary 47832 tunnel exposed the same successful-poll metric with age about 10 seconds. Existing accepted supervisor logic already uses that exact metric for control-plane freshness instead of treating `/readyz` as sole proof of upstream connectivity.

**Root cause:** updater readiness conflated one local OAuth-discovery readiness subcheck with actual tunnel/control-plane operability. This was a false-negative gate; candidate/runtime health was not the failure. Repeated blind reruns are superseded.

**Minimum safe mutation:** retain native `/readyz=ready` as the fast path. Only when readyz is non-ready, require `/healthz=live` AND a present positive `commands_poll_last_successful_timestamp_seconds` no older than bounded `REMOTE_COMMANDER_TUNNEL_STALE_SECONDS` (default 90 s). Missing metrics, zero metric, stale metric, or non-live health all fail closed. The fallback remains before `CUTOVER_COMMITTED=1`; no tunnel restart, credential change, route promotion, or user-session mutation is added.

**Focused V&V:** updater SHA-256 `F9386861D4F27E0BBED47EAFBA9E40282C03CCF0763429A8F126DCBD786FEF6C`; executable regression SHA-256 `06AE6EBAC61965F42B88C7D0EEF54AF2719ACEBB720AB177FF7A1E6FF70D406E`. Six readiness tests PASS: native-ready accept; live+fresh fallback accept; stale metric reject; missing metric reject; non-live reject; fail-closed/pre-cutover contract. Existing Linux updater contract PASS, Linux tunnel lifecycle 5/5 PASS, Security Audit PASS. An initial test-harness PATH error and an initial optional-env `set -u` error were caught before commit; the source default now matches the supervisor `${REMOTE_COMMANDER_TUNNEL_STALE_SECONDS:-90}` pattern.

**Status:** source fix VERIFIED locally but not yet published or promoted. v0.10.17 remains immutable. Exact next action: commit/push this single blocker fix, validate the exact commit on Linux against live metrics without route mutation, then prepare a separate v0.10.18 release-identity revision and run full hosted/local release gates.
### 2026-10-07 — v0.10.18 release-identity candidate

The single-blocker Linux tunnel-readiness fix is carried forward as a separate release-identity revision. v0.10.17 remains immutable and is not rewritten. Current candidate identity is v0.10.18; Browser dependency remains immutable stable v0.8.0 with its existing exact hash pin.

**Gate:** release-identity focused contracts, then exact-head full Windows/Linux and hosted qualification. No live v0.10.18 mutation is accepted before those gates.
