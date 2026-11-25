# Remote Commander Core v0.10.24 — TandemVector Labs official preview

**Project brand:** [TandemVector Labs](https://github.com/Usefull-Skills) (GitHub organization Usefull-Skills).

**Primary repository and release maintainer:** [Aliakbar Emadoddin (@GOD13emad)](https://github.com/GOD13emad).

**Supporting collaborator:** [MMZ (@mohammadmohammadzadeh19960-code)](https://github.com/mohammadmohammadzadeh19960-code).

**Repository:** https://github.com/GOD13emad/ChatGPTRemoteCommander — MIT license.

**Channel:** official public **prerelease** for evaluation. Stable Core remains **v0.10.20**, while v0.10.23 remains a separate pre-existing Draft. The Browser stable v0.8.1 is independently released and not implicitly updated.

## Features included
- PR #221: Router status bootstrap restricted to owned loopback/port/path with redirects forbidden; bounded security audit history streaming.
- PR #222: HTTP fixture readiness validates exact server config and a bounded timeout.
- PR #223: Coucou native hook isolates its working directory to avoid inherited private project path; remains opt-in.
- PR #226: Control Center reports healthy only when Router, profile, version, commit, config hash and backend match.
- Cross-platform Core and native management/source qualification, rollback and installer contracts.

## Windows installer: UNSIGNED — explicitly approved for this version only
The owner authorized a Windows **UNSIGNED** release on 2026-10-16 because a trusted Authenticode signing certificate was unavailable. An **Unknown publisher** warning or refusal from Microsoft **SmartScreen** or Smart App Control is possible. The project brand and **GitHub attestation** plus SHA256 do not replace Authenticode. This release does not instruct users to disable or bypass Windows safeguards.

Verify the SHA256 of every downloaded asset against the release SHA256SUMS manifest, then verify GitHub Sigstore provenance against the exact annotated v0.10.24 tag, source commit and release-sync signer workflow. Source provenance is not an OS publisher signature.

## What is verified and what remains open
The versioned source passed Windows Emad, Linux Emad and MMZ isolated source checks. Hosted R170 Linux and R173 Windows real promotion/rollback, R34 native Control Center, unified R39 UI, R32/R35 GTK, Server Canary on both systems, and latest R157 NoPromote CI succeeded in isolated runners. The original unsuccessful R157 attempt is retained as evidence; root cause remains unproven.

**NOT FINAL:** owner-native CEF login and session preservation, RTL and HiDPI end-user visual acceptance, historical J01 uncertain GUI input, authenticated same-chat Work ACK and Runner, Saeid Windows private R478, four-host Mesh power-loss and serial production rollout. No unattended Stable upgrade or modification to user installations is authorized by this preview.

**Attribution:** Project coordination under TandemVector Labs brand; lead release maintainer Aliakbar Emadoddin; supporting maintainer MMZ. This is attribution to public project GitHub identities, not an attested business registration, Authenticode certificate or legal warranty.

See [publisher and maintainers](PUBLISHER_AND_MAINTAINERS.md) and [version-specific unsigned release policy](UNSIGNED_WINDOWS_RELEASE_POLICY.md).
