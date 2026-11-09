# Remote Commander Core v0.10.26 — SOURCE CANDIDATE ONLY

**State: SOURCE CANDIDATE ONLY; NOT TAGGED, NOT RELEASED OR INSTALLED. Owner approved the exact-version UNSIGNED Preview distribution mode on 2026-10-21; independent source/release gates remain.**

This document identifies a prospective, independently versioned Core source candidate based on the protected `main` source at `66dfe5e0097ba2a246dd3374140b8619b74a6888` (2026-10-21). It is not a publisher release note and is not an approval record. It preserves the publicly published immutable `v0.10.25` **UNSIGNED Preview** and the separately maintained `v0.10.20` Stable. The source candidate adds **no entitlement to replace** either release or modify their assets.

## Source-only scope

- Consistently identify version `0.10.26` in `package.json`, MCP server status, Plugin templates and Windows Desktop assembly metadata.
- Carry forward qualified source-only bounded read-only observation admission fixes from PRs #320/#322 and the exact-head Windows CI scheduling correction from PR #324.
- Retain installer defaults, stable updater channel, current user profiles, durable journal/incident J01 state and existing rollback copies unchanged.
- Preserve a separate, non-publishing test identity; source CI and disposable promotion/rollback PASS do not equal installation acceptance.

## Release admission: BLOCKED

The historical `v0.10.24` and `v0.10.25` policies do NOT authorize unsigned v0.10.26. Instead, the owner granted **new, exact-version** UNSIGNED Preview distribution authorization on 2026-10-21, recorded in `docs/UNSIGNED_WINDOWS_RELEASE_POLICY_0.10.26.json` and the public-risk disclosure `docs/RELEASE_0.10.26.md`. This resolves only the *signature-admission decision*: the exact CI source, signing-status detection, checksums, GitHub attestation, reviewer/security checks, tag, release assets and opt-in installs still require their independent gates. Do not disable or bypass Windows protections.

Before any immutable tag, installer upload, GitHub public release or Stable promotion, independently prove: (1) exact source SHA and reproducible 20-asset package/attestation integrity, including a newly authored exact-version release note; (2) Authenticode signer verification **or** a distinct owner-authorized, version-scoped unsigned Preview with documented SmartScreen/Unknown Publisher risk and GitHub provenance; (3) hosted Windows and Ubuntu full qualification, CodeQL, version-specific Windows NoPromote and reversible isolated installer tests; (4) opt-in named first host/profile, data checkpoint, production-route continuity, rollback and readback; (5) J01 and independent authorized GUI acceptance insofar as they are claimed in release notes. No security control may be bypassed.

**Publisher/author attribution:** TandemVector Labs is the public project/installer brand, principal source maintainer Dr. Aliakbar Emadoddin. The canonical repository is owned by GitHub account `GOD13emad`; this does not prove incorporation, GitHub organization ownership or Authenticode publisher trust.

## Next decision

Complete source candidate qualification and reviewer/security reconciliation with concurrent PRs. The owner-approved unsigned distribution mode is no longer a blocker, but **public release remains contingent on immutable exact-tag/asset/provenance and source security gates**. Signing may follow later; do not assert Fleet FINAL, independently authenticated ChatGPT multi-seat GUI or J01 owner disposition from this source candidate.
