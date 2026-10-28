# Remote Commander Core v0.10.26 — TandemVector Labs | UNSIGNED Preview

**Release status:** Source and release-admission candidate; this document does not assert that the public release, immutable tag or installer exists until GitHub publication is separately verified.

**Project / publisher brand:** **TandemVector Labs**, project and installer metadata. Canonical public source: https://github.com/GOD13emad/ChatGPTRemoteCommander (MIT). The current repository owner is GitHub account `GOD13emad`. This branding does not by itself prove legal company incorporation, GitHub organization ownership, or a verified Windows certificate.

**Principal source author and release maintainer:** Dr. Aliakbar Emadoddin (@GOD13emad). **Supporting maintainer:** MMZ (@mohammadmohammadzadeh19960-code).

**Channel:** Public **prerelease / Preview**, not Stable. Stable `v0.10.20` and the immutable `v0.10.25` UNSIGNED Preview are preserved. Automatic Stable updates and owner-installed devices must not be promoted by publication.

## Windows installer: UNSIGNED — explicit owner authorization for v0.10.26

On **2026-10-21**, the owner explicitly requested unsigned public distribution under the TandemVector Labs project brand before obtaining a trusted signing certificate so the project can gain users, feedback and GitHub stars. This consent authorizes the **unsigned distribution mode for this exact v0.10.26 Preview only**, not a security exemption or release of unfinished features.

The Windows installer has **no Authenticode signature** and may display **Unknown publisher**. **SmartScreen** or Smart App Control may warn or block execution. The organization/product name, MIT license, `SHA256SUMS.txt` and **GitHub attestation** (Sigstore build provenance) **do not replace Authenticode**. Do **not** switch off or bypass Windows security warnings or controls to install it.

## Supported candidate scope

- Cross-platform Commander Core, MCP Router and profile management, narrowly scoped capability execution and continued stable release channels.
- Source-qualified bounded read-only GUI observation and isolated updater promotion/rollback diagnostics where specifically tested.
- Windows/Linux version identity `0.10.26` in package, server, plugin and Desktop build metadata.
- Any Control Center, Browser, Tunnel Observer and native multichat GUI additions appear **only if their exact source commit is included and independently qualified**. Unmerged PR demonstrations are not claimed as shipped.

## Verify the public download before use

1. Confirm the release is marked **Prerelease**, the exact annotated `v0.10.26` Git tag, and the peeled source commit.
2. Verify that `SHA256SUMS.txt` lists and validates all **20 payload files**; together with the manifest, the release contains **21 assets**, including `Remote-Commander-Setup-v0.10.26.exe` and `Remote-Commander-Linux-Setup.run`.
3. Verify **GitHub Sigstore provenance / GitHub attestation** against that tag, commit and `.github/workflows/release-sync.yml`; an attestation verifies CI build identity, not Windows signer identity.
4. Confirm the EXE reports `NotSigned` in Windows Authenticode checks; its advertised project brand is **not** a Windows-trusted publisher.
5. Install only on an explicitly chosen profile/device after preserving current user data and a verified rollback. Do not infer owner fleet opt-in from the GitHub release.

## Acceptance and later signing

Publishing a Preview is not a declaration that code-scanning alerts, J01, Browser observer revocation, GUI/session authentication, or all independent author reviews are closed. Do not publish artifacts unless exact-source CI, code/security disposition, immutable manifest and GitHub attestation release gates pass. Signed distributions and formal/legal registration may be pursued **later**; do not misrepresent their current status.

**Unsigned v0.10.26-only admission:** `docs/UNSIGNED_WINDOWS_RELEASE_POLICY_0.10.26.json`. Future versions require their own recorded distribution decision.
