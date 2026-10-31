# Remote Commander 0.10.25 — SOURCE CANDIDATE ONLY

**NOT tagged, released, installed or approved for unsigned public distribution.**
Owner execution surface: ChatGPT + Remote Commander, not Work.

Parent reviewed and merged source: 99d3908e848eee01714eb8e2832b4f5eba5f8df1
(PR #238). Candidate changes only declared application/Plugin/desktop version
identity and release-admission tests; existing historical tags remain immutable.

Four native roadmap tools are included in source:
- workflow_roadmap: read the complete current ordered DAG, not an executed claim.
- workflow_plan_insert: add approved task before an untouched pending target.
- workflow_plan_prioritize: reorder independent unfinished steps without
  modifying dependencies or completed work.
- workflow_plan_edit: change only untouched pending step title.

## Release and signing boundaries

The historical v0.10.24 policy authorizes an **UNSIGNED Preview only for that
exact version**. It does NOT authorize unsigned v0.10.25. Existing install
defaults therefore remain v0.10.24. No v0.10.25 tag or public release may be
created by this candidate pipeline; publishing requires separate exact source
SHA, trusted signer or explicitly owner-reviewed version-specific admission,
and rollback verification. A local UntrustedRoot code-signing certificate is
NOT publisher-trusted even with a matching private key. Do not disable OS
security, sign with unknown roots as though trusted, or infer new owner approval.

## Qualification and isolated canary

Require source identity and policy regression tests, npm check/test/audit and
hosted Windows + Ubuntu CI. Run native MCP canary against the exact
source-approved commit on a disposable local port/config/profile; verify
tool registration and durable readback after restart without touching live
port, tunnel, browser, GUI latch or existing SQLite workflow. Preserve current
Core 0.10.24 installation and a byte-exact recovery artifact.

Source qualification and isolated canary do not activate an unattended model
runner, do not complete real 41-case independent model evaluation and do not
replace a verified installed product.
## Release-first scope decision — 2026-10-19 (owner direction)

**Goal:** ship a working, bounded product first; deliver new capabilities later as small, independently qualified GitHub releases. This is a scope/roadmap decision, NOT publication authorization, version-specific unsigned approval, a new Stable tag, or permission to mutate installed hosts.

**Core v0.10.25 scope freeze:** retain the existing cross-platform MCP/router, durable operations/workflows, profiles, observed-only GUI safety, and four roadmap tools above. Release-blocking maintenance is limited to proven updater downgrade/unknown-status and exact GitHub release-origin hardening, source/CI acceptance, safe candidate-first install and rollback, privacy/profile preservation, and accepted publisher/signing policy. Experimental native private-workspace, ChatGPT owner broker, automatic planner, UI overhauls, CEF, Game/Video and speculative agent expansions remain *out of this Core release*. Tests and review-only PRs may continue independently without extending this frozen feature scope.

**Three separately releasable products (no all-or-nothing gate):**
- **Core:** publish v0.10.25 only after its own version-specific acceptance and provenance. Source candidate or hosted CI is not a published product; installed v0.10.24 profiles remain unchanged until authorized rollout.
- **Browser:** stable v0.8.1 remains independent. Its next release should choose one visually approved CEF shell and validate native tab controls, light/sky and navy themes, RTL, drag, login/profile/session continuity and native install/rollback; do not silently import all stacked UI experiments.
- **Monitoring/Control Center:** ship a usable Windows/Linux owner-native UI that reports honest identity, connected profiles, tools, active operations, workflow states and updater status. Expose Pause/Resume/Cancel/profile/update controls *only* where verified Core authority and outcome receipts exist; no fake-green status or unsafe implicit mutation. Incomplete controls remain visibly unavailable rather than delaying unrelated Core/Browser releases.

**GitHub automatic update contract (future eligible installations, not enabled by this document):**
1. Each product tracks its **own canonical repository and release channel**. Default unattended Core uses the published Stable release, not moving `main`, Draft PRs or unsigned preview candidates. Preview upgrades require explicit user opt-in and version-scoped acceptance.
2. Resolve an exact trusted HTTPS GitHub repository release URL; pin the immutable tag, commit and expected version. Verify the applicable release checksum, manifest and provenance/signing admission before download/promotion. GitHub attestation establishes origin and integrity, *not* Windows Authenticode trust or product safety (https://cli.github.com/manual/gh_attestation_verify).
3. **No silent downgrade, no upgrade on uncertain current identity:** when an active route, running MCP or prior installed/direct runtime cannot be reconciled, report DEFER/UNVERIFIED rather than replace it. An explicit authorized rollback is separate from unattended update.
4. Stage in a new isolated versioned directory, verify candidate, preserve config/tunnels/browser authenticated profiles/workflow journals, switch exact route safely, and retain verified rollback and owned-process cleanup. Busy or uncertain GUI/workflow effects are not replayed or reset.
5. Roll out one controlled canary first, read back actual version/route/profile and rollback behavior, then promote separately to other reachable hosts. Offline hosts remain pending and never block independent product publication.

**Required before v0.10.25 release:** qualify the *existing* dedicated `.github/workflows/candidate-rollback-v01025.yml` promotion/rollback jobs for Windows and Linux on the exact final head, independently review updater guards (PRs #250/#252 or equivalent rebased QA), complete exact-head general CI and native canary, and obtain real publisher approval for signed artifacts or a reviewed 0.10.25-specific Preview policy. Historical R170/R173 remain pinned to their original v0.10.24 acceptance scope; do not weaken their version assertions merely to satisfy issue #251. The dedicated v0.10.25 workflow is a separate candidate gate, not inherited proof of release. Preserve the v0.10.24 unsigned exception as historical and version-scoped. Release-publisher remains the named maintainer; supporting reviewers do not constitute publisher authorization.

## 2026-10-20 scoped unsigned Preview consent (supersedes release admission only)

The historical v0.10.24 exception above still does NOT authorize unsigned v0.10.25. A distinct user instruction on 2026-10-20 now explicitly authorizes an UNSIGNED v0.10.25 public Preview, subject to exact 20-asset integrity, annotated tag, GitHub attestation and release readback. Unknown publisher and SmartScreen warnings must be disclosed without bypassing OS security. GitHub project brand: TandemVector Labs / Usefull-Skills. Principal author: Dr. Aliakbar Emadoddin. This records user authorization and does not claim independent personal sign-off by the credited author. Publication and installed host acceptance require their own evidence.
