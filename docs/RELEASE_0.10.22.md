# Remote Commander Core v0.10.22 — version-locked candidate

## Identity
This new candidate incorporates the Windows native J01 focus mutex pre-dispatch fix from PR #217, merged to main at a90c7196cae3ca2bd471a0db3e42eb7eb89929eb. It is distinct from the previously annotated v0.10.21 tag and existing Draft assets, which MUST NOT be replaced or relabeled. The final v0.10.22 tag must be annotated and match the exact tested version-bump source SHA.

## Included functionality
- Windows GUI focusWindow: only an exact, three-field native NOT_SUBMITTED mutex-denial receipt from WaitOne(0) may close that call's own J01 pending record. Historical unknown native input effects, malformed receipts, other input, crashes, and timeouts remain fail-closed and never auto-replayed.
- Regression suite is admitted to the normal GUI gate (90/90 before version bump).
- Runtime, Windows Desktop, plugin manifests, Windows and Linux installer/default source references and unsigned distribution policy all share 0.10.22.
- Stable Remote Commander Browser v0.8.1 remains pinned, and user browser profiles are not silently migrated.

## Release safety and acceptance
Windows installer: UNSIGNED. Trusted Authenticode publisher identity is unavailable. SmartScreen or Smart App Control may block the installation; never disable or bypass these Windows protections. A version-scoped JSON distribution policy requires exact-source GitHub attestation from the official release-sync workflow, SHA256SUMS for all 20 assets, independent final Windows setup provenance verification, annotated Git tag and GitHub Draft creation. A GitHub attestation proves build origin, not OS publisher trust, malware freedom or native user acceptance.

Public Stable Core remains v0.10.20 until owner-native Windows/Desktop and Linux host Canary/rollback, CEF login/profile continuity, Work authenticated same-chat ACK, controlled four-host Mesh and power-loss/soak acceptance. The historical Emad Windows GUI uncertain latch must not be cleared or replayed by this code update. Saeid Windows and MMZ Linux are physically powered off; their fleet acceptance is deferred until normal power-on.

This candidate stays a Draft and must not trigger unsupervised in-place upgrades or silent stable publication. See docs/UNSIGNED_WINDOWS_RELEASE_POLICY.md and docs/RELEASE_AUTHORITY.md.
