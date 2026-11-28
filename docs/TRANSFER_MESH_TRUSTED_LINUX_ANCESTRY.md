# Linux receive: optional trusted-ancestry gate

**Scope:** This design adds an opt-in, fail-closed *deployment precondition* for
the standalone Linux Pilot receiver. It does not certify the current general
transfer_mesh_receive default as safe under a hostile same-user rename.

For a Linux Core whose administrator already provisioned a trusted destination,
set config.transferMesh.requireTrustedLinuxAncestry=true. Core forwards
--require-trusted-linux-ancestry 1 to Pilot. The Linux receiver pins each
directory component with O_NOFOLLOW and, before the first target check,
verifies every **ancestor of the destination** from / through its parent by
fstat on the held native directory FDs. Every ancestor must be a directory
owned by uid 0 and have **no group/other write bit**. The receiving process
must run as a non-root user. An unsafe ancestry fails with
DESTINATION_TRUSTED_LINUX_ANCESTRY_REQUIRED before any receiver publication.
Unsupported platforms and root execution reject strict mode instead of
silently downgrading.

**Required trust assumption:** The Core/Pilot executable, configuration,
process environment and its running process are not modifiable by the
adversary. uid 0, the kernel, the mount namespace and
administrators are trusted; no adversary can acquire their filesystem
capabilities or modify those ancestors' ownership, ACLs or mount state during
the transfer. A root-owned mode-01777 /tmp is explicitly *not* trusted. Nor is
a mode-0500 ancestor owned by the receiving uid (that owner can chmod it).
A trusted parent cannot be created by an unprivileged owner merely changing
permissions in the same account.

**Limitations:** The test covers a scoped Linux original-path rename guarantee,
not integrity against an adversary with arbitrary write access *inside* the
approved leaf. This gate is optional and does not modify the legacy default.
Filesystem ACLs, privilege/capability and admin trust must be independently
reviewed at deployment; the group/other-mode gate intentionally rejects ACL
write access indicated by the class mask. Security acceptance remains open
until a separate-principal, runtime-controlled positive RED/GREEN fixture and
independent Code Owner review are completed. This QA gate does not replace
CodeQL or a production rollout decision.

**Scoped verification:** node --test test/transfer-trusted-linux-ancestry-20261128.test.mjs
checks that an untrusted same-UID path and malformed strict option reject
*before* publication, Core propagates strict policy, and non-strict transfers
remain compatible. Run full npm run check and hosted Windows/Ubuntu CI on
the exact commit.

**Positive acceptance fixture:** On an isolated Ubuntu hosted runner, an
administratively provisioned root-owned mode-0755 parent beneath /var/lib
contains a mode-0700 leaf owned by the unprivileged receiving UID. Strict
receive must publish normally while an actual rename attempt against the
root-owned parent's leaf fails at the kernel permission boundary. This only
validates the stated principal separation, not a hostile privileged actor.
