# Remote Commander Core v0.10.23 — SOURCE RELEASE CANDIDATE

## Source lineage and scope
v0.10.23 includes the exact-staged-source Linux updater rollback repair from PR #219, integrated in main after Core v0.10.22. The previous annotated v0.10.22 tag and 20-asset GitHub Draft remain immutable. Only a **new** annotated v0.10.23 tag with the exact accepted source commit may authorize an independent Draft build.

J01 no-replay and uncertain native GUI records remain preserved. New safe behavior: after candidate-first qualification, \`auto-update-linux.sh\` promotes the tracked control checkout by fetching the exact SHA from the already validated staged checkout using Git's \`--update-shallow\`. The stage HEAD must match the expected commit, and the peeled \`FETCH_HEAD\` is rechecked before checkout. The final control step no longer fetches owner-private rollback-r521 from a public GitHub origin. Dirty staged/unstaged control safeguards and untracked files remain protected. Four Linux-only Bash regressions plus one cross-platform static contract are included.

## Acceptance and retained stable authority
Published stable remains Core v0.10.20 and Browser v0.8.1. v0.10.22 candidate and backend/router rollback were proven on the Emad Linux owner host; an original automated control checkout failed. v0.10.23 is not accepted as fully automatic rollback until a separate exact-stage owner canary successfully promotes and restores the entire tracked control, route, health and workflow state without manual repair.

**Windows installer: UNSIGNED.** Windows Defender SmartScreen / Smart App Control may warn or block. Never bypass security warnings or claim Authenticode publisher signing. The version-scoped JSON policy permits GitHub attestation as **build provenance only**, not operating-system publisher trust. A new exact-tag SHA256SUMS 20-asset GitHub Draft and independent Sigstore attestation verification are required before native user acceptance; ensure repository identity, tag, commit, signer workflow and final EXE digest all match.

Windows Emad's historical uncertain native GUI operation stays quarantined: do not clear or replay it. Native Desktop, Browser/CEF login/profile continuity, RTL, HiDPI and monitoring acceptance remain open. Work authenticated same-chat ACK/Runner, Mesh, power-loss/soak, and Saeid Windows / MMZ Linux fleet acceptance remain open; the latter two devices are physically powered off by their owner. Private Saeid R478 cumulative Brain is still missing.

The v0.10.23 source and Draft build must not silently auto-promote to Stable. Preserve rollback snapshots and user profile data.
