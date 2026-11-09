# Windows unsigned release policy: v0.10.24 only

**Approval scope: owner-authorized public unsigned PREVIEW; not Stable.** The user explicitly approved an unsigned Windows distribution for this specific version on 2026-10-16. The previous policy was fail-closed; this decision authorizes only the v0.10.24 version-scoped exception with exact GitHub Sigstore provenance. It does not grant consent for future versions, silent installation, or any bypass of Windows protections.

**Windows installer: UNSIGNED.** Authenticode publisher identity is absent. SmartScreen and Smart App Control may warn, classify the binary as **Unknown publisher**, or block it. GitHub organization/maintainer names, exact source tags, SHA256SUMS and GitHub attestation do not replace Authenticode; none is a Microsoft-trusted signer. We will not disable or bypass Defender, SmartScreen, Smart App Control, UAC or certificate trust checks.

**Mandatory release integrity:** use a fresh immutable annotated v0.10.24 Git tag matching its qualified exact commit; require all 20 assets, sorted complete SHA256SUMS checks, and independent GitHub Sigstore attestation verification of the exact tag, source digest and expected signer workflow. Recheck actual installer signature status. If NotSigned, the verifier may return UNSIGNED_WITH_REQUIRED_SIGSTORE_PROVENANCE for v0.10.24 only. Stable v0.10.20 and existing v0.10.23 Draft remain untouched.

**Mandatory visibility:** release notes must display source credits, lack of Authenticode, prerelease scope, remaining native GUI/CEF and J01, Work same-chat ACK and fleet risk. Automatic stable updates are not authorized.

**Project brand:** TandemVector Labs is the GitHub display name of organization Usefull-Skills; its legal registration has not been independently verified. Publishing Core source repository: GOD13emad/ChatGPTRemoteCommander. Primary release/source maintainer: Aliakbar Emadoddin (@GOD13emad); supporting contributor: MMZ (@mohammadmohammadzadeh19960-code).

The approval evidence is the user instruction of 2026-10-16 and this bounded policy. It is not a Windows OS signature.
