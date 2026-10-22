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

## Phase 1 optional controller status hook

The review-only src/gui-tools-windows.mjs change accepts a dependency-injected
ownerSessionStatusProbe. It is called only when Windows native GUI is unavailable,
the GUI feature itself is enabled, and guiControl.ownerSessionBridgeReadOnly is
explicitly true. There is no production default provider or automatic agent.

A validated signed status attestation adds a separate ownerSessionBridge field,
never changes gui_status.available, and never permits gui_session_begin or any
native screenshot, mouse, keyboard, focus or takeover operation. Invalid data,
provider failures and emergency stops fail closed. Unit tests and a temporary
SYSTEM-Core-to-owner-Session1 real IPC test verify these properties.

This hook is not a persistent service, deployment recipe, automatic session
handoff, GUI takeover bridge, or an authorization to merge into protected main.
A packaged trusted provider, owner enrollment and full session-switch/lease
lifecycle review remain required for production.

## Protected binary admission (installer prerequisite)

The optional status provider deliberately refuses to execute native code from
the user's source checkout or mutable profile. A candidate DLL must be placed
by a trusted installer under Program Files/TandemVector-Labs/RemoteCommander
and its SHA-256 pinned by that trusted installer. Files with unexpected hash,
missing/untrusted paths, symlinks, overlong descriptors or unexpected protocol
values fail closed. The shipped source-stage default has no pinned digest and
therefore leaves this provider DISABLED, even if the opt-in GUI status flag is
set. It must not be described as a working automatic GUI session bridge.

Operator enrollment must create a read-only descriptor containing only
{schema, pipe, ownerSid, keyFile} and an NTFS ACL-protected short-lived key
readable to the exact owner and SYSTEM, never a raw key in chat, logs or a CLI
argument. The .NET client verifies signed status; the GUI controller still
refuses Session 0 native availability and all GUI input leases.

Installer packaging, binary pin provisioning, privilege boundaries, agent
lifecycle/session switches, owner opt-in and independent security review remain
release gates. No auto-start or Task Scheduler persistence is provided here.
