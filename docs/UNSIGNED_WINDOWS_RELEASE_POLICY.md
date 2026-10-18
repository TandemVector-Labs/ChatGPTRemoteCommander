# Windows unsigned release policy — v0.10.23

Owner-directed, version-scoped distribution option (2026-10-14). Traditional code-signing certificate enrollment is unavailable. This policy does **not** claim that the final Windows installer is Authenticode-signed.

## Requirements for this one release
- Immutable annotated `v0.10.23` tag referencing the exact release source commit; release notes and the fixed 20-asset manifest must be present.
- `SHA256SUMS.txt` for all release assets verified at publish time.
- A **GitHub Sigstore build-provenance attestation** must be created, then independently verified for the final Windows installer against the expected repository, signing workflow, tag and source commit **before** GitHub Release publication.
- An explicit allowlist for *this tag only* in `docs/UNSIGNED_WINDOWS_RELEASE_POLICY.json`. This decision must not generalize to future versions.
- The release notes must warn of the missing Authenticode publisher identity and potential SmartScreen/Smart App Control warnings. Do not disable or evade Windows security policies.
- If trusted Authenticode signing becomes available, use that route. If neither a valid signature nor a verifiable GitHub attestation exists, the release must fail closed.

## Verification by recipient
Verify the file SHA-256 against the `SHA256SUMS.txt` fetched from the matching official GitHub release, and run:

```bash
gh attestation verify Remote-Commander-Setup-v0.10.23.exe \
  --repo GOD13emad/ChatGPTRemoteCommander \
  --source-ref refs/tags/v0.10.23 \
  --signer-workflow GOD13emad/ChatGPTRemoteCommander/.github/workflows/release-sync.yml
```

`gh attestation verify` checks where the artifact was built and which source was used. It does **not** grant OS publisher trust, guarantee absence of bugs/malware, or silence SmartScreen. If Windows refuses execution under the machine's policy, do not disable security controls.

## Scope
Applies only to the release **distribution gate**, not to automatic unattended upgrades. The four deployed stable Core `0.10.20` instances remain unchanged until the separate compatibility, data-preservation and rollback gates pass.
