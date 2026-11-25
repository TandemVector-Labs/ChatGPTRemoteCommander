# Commander 1 v0.12.0 — authorized UNSIGNED Stable release, pending independent acceptance

**Release status:** The project owner expressly authorized public distribution as an **UNSIGNED Stable** release of Commander 1 `v0.12.0` on **2026-11-10**. This document records the version-specific *signature waiver*, not a published GitHub Release, completed installation, successful hosted CI, or final Stable acceptance. The release train is currently `INTEGRATION_CANDIDATE_NOT_FINAL` / `NoPromote`. Do **not** create the `v0.12.0` tag, release, Latest-channel switch, or unattended fleet update before the remaining independent gates pass.

**Project brand:** TandemVector Labs (project metadata, not a Windows-trusted publisher). Source: https://github.com/GOD13emad/ChatGPTRemoteCommander. Principal source maintainer: Dr. Aliakbar Emadoddin (@GOD13emad). Supporting maintainer: MMZ (@mohammadmohammadzadeh19960-code).

## Windows installer: UNSIGNED

The Windows installer will have **no Authenticode publisher signature**; Windows may identify it as **Unknown publisher**. Microsoft Defender **SmartScreen** can warn or block the download or execution, and **Smart App Control** or organization policy may block unsigned software completely. Do not disable, bypass, weaken, or provide instructions to bypass those protections. The brand, GitHub repository, SHA-256 checksums and **GitHub attestation** (GitHub Sigstore build provenance) **do not replace Authenticode** and do not establish Microsoft-trusted publisher identity.

The owner authorizes distribution without a signing certificate for **this exact `v0.12.0` Stable version only**. The authorization is **not** evidence that the code, GUI, all features, installed access, or fleet is ready. The existing independent requirements for production admission, required features, OS compatibility, exact-source CI, release integrity and safe rollback remain mandatory. Do not silently elevate access rights or mutate existing profiles.

## Integrity and public release admission

1. Freeze a single exact `v0.12.0` source commit and annotated Git tag. Build Windows and Linux release assets from that tree; verify the version inside each binary/package is `0.12.0`, not `0.12.0-dev.1`.
2. Run and pass hosted Windows and Linux CI plus the exact release-specific R157 candidate-first `NoPromote` updater E2E. R157 verifies exact-source staging, the three qualification suites, Doctor/Store checks, and absence of route promotion. The legacy rollback-specific R170/R173 workflows against incompatible pre-v0.12 releases are not pre-v1.0 gates under the accepted 2026-10-28 `RELEASE_AUTHORITY.md` policy; retain their historical failures as evidence and reserve full rollback qualification for v1.0.0. Do not treat skipped R170/R173 as PASS or weaken schema-continuity rejection.
3. Produce a complete `SHA256SUMS.txt` for every immutable released binary; verify each byte against the download. Verify the **GitHub attestation** and expected signer workflow tied to the repository, tag, commit and SHA-256. These controls establish integrity/build provenance, **not** Authenticode.
4. Verify that Windows artifacts report `NotSigned`, and that the published unsigned release notice documents SmartScreen, Smart App Control and Unknown publisher. The version-scoped waiver is in `docs/UNSIGNED_WINDOWS_RELEASE_POLICY_0.12.0.json`.
5. Obtain real owner-approved G1/J01 and native GUI positive/negative evidence, authenticated installed version, per-host boot/login and all mandatory feature receipts, then reconcile actual host identity mapping and accept all eight known connectors before `RELEASE_APPROVED`. For the pre-v1.0 forward-only train, preserve verified rescue copies and reject schema-incompatible downgrades; do not require rollback to known-broken 0.10.x/0.11.x releases. v1.0.0 must repeat full compatible rollback and recovery qualification. Offline targets remain pending.
6. Never label the build `Stable` based solely on a manifest edit, tag, a passing test script, or this waiver. Preserve the previously installed version and its rollback data until exact candidate installation has been independently verified.

## Current bounded, not-yet-released QA evidence

The integrated **development** source commit `8c1993eadb7d4370d90238967f0830877b1e3ab8` passed local source `check:qualification`, `test:qualification` and historical security scan, and produced unsigned QA binaries. These are **not** assets for a `v0.12.0` Stable release until version identities and release gates close.

- Windows QA installer (`0.12.0-dev.1`) SHA-256: `1bb725a817323910dc0e763d04cbcd6122b9c4af470e249cee967efff5fdfc2c`.
- Windows QA Desktop SHA-256: `ce034581a72681c96721a08f931a4550940e6b255a636ed096aeb6b207ecaa9d`.
- Linux QA .deb (`0.12.0~dev1-2`, pinned Node.js `22.23.4`) SHA-256: `374430a54bfc621bb33f6252f501c1604a12d5091b4a44cf936e6021a0a4def2`.

At the current release-train snapshot, `isStable=false`, `publishApproved=false`, `autoupdateApproved=false`, `installedPromotionApproved=false`, and `fleetCoverage.acceptedHostIds=[]` (0/8). Exact source commit `0a1f6cf6f2e8ffd505eedb5a11dcd7daf6617243` passed hosted Windows+Ubuntu CI, Linux+Windows Server Install Canary, and Windows Setup+Linux Bootstrap build jobs; the Release Sync publish job was correctly skipped under NoPromote. R170/R173 are intentionally skipped by the accepted pre-v1.0 forward-only policy and are not PASS. R157 remains pending/in progress. The latest PR head `63995a0fe73d5de8d25caa2751d6f708175c55e1` adds release-train evidence documentation only; its newly triggered CI, Server Install Canary and Release Sync runs are still in progress. Local exact-checkout security audit passed over 62,913,932 Git-history bytes. Seven of eight connected hosts still report `0.11.0-dev.23` / `FULL_POWER`; `Saeid_PC` is unreachable. Production G1/J01, same-owner GUI, multi-user/FULL_ACCESS, stable install roots, per-host boot/login, rollback, eight-host mapping and artifact provenance remain unverified. New upstream Node.js security advisories must be assessed again at the time of release.

**Unsigned authorization is now accepted. Stable distribution is conditional on the remaining independent release acceptance gates; no public publication is claimed by this file.**
