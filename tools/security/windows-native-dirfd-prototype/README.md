# Windows Native RootDirectory Probe — security qualification only

Standalone prototype: NtCreateFile + OBJECT_ATTRIBUTES.RootDirectory for handle-relative directory traversal. A drive anchor and every child component are opened with held handles. Reparse-point directories/files are rejected using FILE_OPEN_REPARSE_POINT and FileAttributeTagInfo. Final journal reads are bounded to 128 KiB.

NOT wired into the Transfer Mesh Node worker. Tests compile .NET 10 SDK code only on native Windows with: node --test test/windows-native-dirfd-prototype.test.mjs. The third CLI test pause marker is compiled **only** when explicitly defining CTMESH_TEST_RACE. The ordinary Release build requires exactly two arguments and rejects any test marker. Native regression tests build test-only and ordinary Release binaries in separate isolated output and intermediate directories; do not deploy the test-instrumented binary.

Prior to production use: remove the test hook; independently pin executable provenance outside writable transfer data; verify signed package/rollback and .NET availability/architecture; define safe drive/device/ADS path policy and finite memory and timeouts; verify real owner-token NTFS effective rights; extend handle-relative guarantees to write, rename, hash and publication paths; run updated adversarial tests and CodeQL.

The live Windows transfer-root ACL audit is REVIEW_REQUIRED. This prototype alone does not close the Windows security gate.

## Runtime admission is currently denied

PR118 demonstrated an unsafe opt-in COMMANDER_TRANSFER_NATIVE_READER /
COMMANDER_TRANSFER_NATIVE_READER_SHA256 pair: a helper EXE measured before
spawnSync could be replaced between verification and process creation.
In an isolated Windows fixture a different benign executable was launched
after the original hash matched the pin. Its output was rejected only after
execution. The standalone native directory-handle prototype remains
available for review, but it is not wired into the deployed Node worker.

test/windows-native-helper-admission.test.mjs is a narrowly scoped
source/runtime regression that rejects that exact unreviewed executable
selector and launch pattern. It does not prove that all process execution,
path resolution, Windows ACLs or native code are secure.

Before proposing runtime integration, require trusted package/provenance and
verifiable Authenticode signature, OS-enforced protection of the helper and
every writable ancestor from untrusted principals, the actual interactive
owner's effective rights and compatibility, and a reproducible post-verification
EXE-swap red test that can no longer launch a different image. Static analyzer
and independent security reviewer acceptance are distinct mandatory gates.
