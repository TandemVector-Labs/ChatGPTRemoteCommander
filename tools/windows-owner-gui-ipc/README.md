# Windows owner-session GUI bridge: Phase 1 (read-only)

Issue #99, separate from the already qualified Control Center/monitor PR #78.

This is a **one-request experimental owner-session readiness bridge**, not
an installed service, an interactive-controller integration, or permission to
capture/use another session's desktop. It sends only non-sensitive metrics.
No screenshot, input, focus, window title, or browser data operations exist.

Design:
- The owner runs the `serve` process under the *existing* logged-in
  Windows user account, in an active user session. It binds to the exact
  supplied owner SID and refuses Session 0/SYSTEM.
- Core test client (`probe`) must be SYSTEM in Session 0. IPC is a private
  local Windows named pipe whose DACL allows exactly SYSTEM and the owner SID.
- A random 256-bit symmetric key is stored in an ephemeral file with NTFS ACL
  limited to SYSTEM and that owner. The key itself is never printed/passed
  on the command line.
- Both ends authenticate a versioned status request/response with HMAC-SHA256.
  A unique client nonce, short timestamp window, bounded messages and
  single-use server lifetime prevent accidental replay and overlong messages.
- A shared key accessible to user and SYSTEM is **not** sufficient for
  mutating commands or high-trust identity delegation. No such commands
  are offered in Phase 1.
- Core-to-agent integration, service supervision, session changes,
  GUI lease enforcement, and user-facing enrollment remain future gates.

The executable has two modes:
`OwnerSessionBridge serve --pipe <random-name> --key-file <acl-restricted-path> --owner-sid <SID>`
`OwnerSessionBridge probe --pipe <random-name> --key-file <acl-restricted-path> --owner-sid <SID>`

No passwords, signing-key material, screenshot or text typed by the user is
logged. Only a sanitized read-only signed status is emitted by `probe`.

Do not deploy, auto-start, or convert to a stable GUI feature without
CODEOWNER review and exact Windows guest/owner-session end-to-end tests.
