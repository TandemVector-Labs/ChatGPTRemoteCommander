# Windows Native RootDirectory Probe — security qualification only

Standalone prototype: NtCreateFile + OBJECT_ATTRIBUTES.RootDirectory for handle-relative directory traversal. A drive anchor and every child component are opened with held handles. Reparse-point directories/files are rejected using FILE_OPEN_REPARSE_POINT and FileAttributeTagInfo. Final journal reads are bounded to 128 KiB.

NOT wired into the Transfer Mesh Node worker. Tests compile .NET 10 SDK code only on native Windows with: node --test test/windows-native-dirfd-prototype.test.mjs. The optional third CLI argument is exclusively a synthetic test pause hook and MUST be removed before operational integration.

Prior to production use: remove the test hook; independently pin executable provenance outside writable transfer data; verify signed package/rollback and .NET availability/architecture; define safe drive/device/ADS path policy and finite memory and timeouts; verify real owner-token NTFS effective rights; extend handle-relative guarantees to write, rename, hash and publication paths; run updated adversarial tests and CodeQL.

The live Windows transfer-root ACL audit is REVIEW_REQUIRED. This prototype alone does not close the Windows security gate.
