# Remote Commander 0.10.25 — SOURCE CANDIDATE ONLY

**Not yet tagged or publicly released from the canonical `TandemVector-Labs/ChatGPTRemoteCommander` distribution workflow; this document is not an unsigned-publication approval.**

**Installed runtime versus public release:** Connected hosts may already report a local Commander Core `0.10.25` runtime. That observation does NOT establish that their binaries correspond to the proposed GitHub integration HEAD, that the current candidate has passed production acceptance, or that an immutable public `v0.10.25` release exists. Qualify each installed build separately by exact source/build provenance.

**Canonical source:** https://github.com/TandemVector-Labs/ChatGPTRemoteCommander; primary maintainer Aliakbar Emadoddin (@GOD13emad), supporting contributor MMZ. Earlier `Usefull-Skills` and personal-repository names remain historical provenance, not the current release target. See [publisher and maintainers](PUBLISHER_AND_MAINTAINERS.md).

**Integration chain:** PR #20 carries the source integration proposal into protected `main`; security Mesh Doctor PR #22 and companion #24 require their own genuine independent review. Their exact commits, required checks and merge decisions must be re-read at release time rather than assumed from a previous CI run. Release exact-source SHA is not selected until the authorized `main` integration is complete.

Original project parent provenance: commit `99d3908e848eee01714eb8e2832b4f5eba5f8df1` (original PR #238). Candidate application/Plugin/desktop version identities and native roadmap capabilities are covered by the project regression suite; this does not promote a candidate into a release.

Four native roadmap tools are included in the source:
- `workflow_roadmap`: inspect the complete current ordered DAG.
- `workflow_plan_insert`: insert an approved task before an untouched pending task.
- `workflow_plan_prioritize`: reorder unfinished independent steps without bypassing dependencies.
- `workflow_plan_edit`: change an untouched pending task's descriptive title.

## Release and signing boundaries

The historical v0.10.24 policy allows an **UNSIGNED Preview only for that exact version** and does NOT authorize unsigned v0.10.25. Installers must not silently replace the existing pinned verified Preview with an unapproved candidate. The v0.10.25 release admission must identify the final reviewed source SHA and immutable tag, explicit version-scoped owner decision for unsigned distribution (or an authenticated trusted signing path), verified asset hashes, independent GitHub Sigstore build provenance, documented SmartScreen/Unknown publisher warnings, and successful release/rollback checks. A local UntrustedRoot certificate is not a trusted Windows publisher; no OS protection is disabled or bypassed.

## Qualification and isolated canary

Require exact-source identity tests, `npm run check`, `npm test`, `npm run audit`, Windows and Ubuntu hosted CI at the current commit, and the applicable source-review/CodeQL gates. Execute the native MCP canary on an isolated port/config/profile; verify tool discovery and durable readback after restart without disturbing live Router/tunnel/browser/GUI or SQLite state. Retain an exact verified recovery artifact before any host promotion.

Native source tests and isolated canaries do not prove production native GUI/CEF acceptance, same-chat delivery acknowledgment, independent 41-case model behavior validation, or four-host failover recovery. Such acceptance must be recorded independently when actually completed.
