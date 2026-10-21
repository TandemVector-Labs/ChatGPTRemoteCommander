# Isolated GUI seat coordinator — backend integration gate

**Status:** backend-neutral candidate only. This is not yet a live Commander GUI tool or a claimed production multiseat implementation. It deliberately cannot use the existing foreground GUI helper as an implicit fallback.

## Why a separate coordinator

The existing GUI tools are a **single-desktop coordination lease**, with a user-foreground takeover policy. That API must stay intact while adding independent, uniquely owned sessions. Browser PR #123 has shown simultaneous Xvfb CEF native tab Drag with distinct profiles in hosted CI. A separate, unprivileged MMZ-host pilot on 2026-10-21 also demonstrated two X11 virtual displays with rejected cross-Xauthority access, distinct pointer positions and distinct keyboard events, without touching the owner's desktop. Neither proof establishes **separate OS user identities**: two Xvfb processes under one Unix UID can still access same-UID files. Xauthority alone is insufficient to isolate profiles or secrets. GNOME Remote Login via GDM is a system-scope service distinct from an existing user's Desktop Sharing and conflicting same-user headless service.

## Coordinator contract

`src/isolated-seat-coordinator.mjs` exports `createIsolatedSeatCoordinator({ backend, ... })`. It requires an injected backend with four operations:

- `start({seatId,ownerId,profileId})`: create an isolated process/session, private profile, and display **without** affecting the owner's desktop. Return an opaque handle, never a credential.
- `inspect(handle)`: independently inspect process UID/PID, display, TCP listener, profile isolation and owner-desktop noninterference. Never accept a caller-supplied attestation as kernel evidence. Only a trusted backend may set `kernelIdentityVerified`.
- `execute(handle,{action,data,signal})`: route only the explicit seat's screenshot/cursor/move/click/drag/key/text. Never redirect a failure to `DISPLAY=:0`, Mutter input or the primary user's GUI. Abort must release held input.
- `stop(handle)`: terminate/reap the owned process group and destroy the owned display, credentials and private profile. Successful completion must mean the operating-system resources are actually gone.

`begin` refuses a missing backend, unsupported OS, unverified PID/UID, the host's Unix UID, duplicate seat UID/PID/display, non-private profile, missing no-TCP assertion, or any claim that the owner's desktop was touched. It returns an unpredictable seat ID and separate 256-bit lease secret only on success. Both the lease and a **server-derived authenticated owner ID** must match on `run` or `end`. The API caller must not accept `ownerId` from untrusted model input. TTL is 10–120 seconds; timers and `sweep` revoke expired leases. Capacity and pending starts are bounded.

Operations have a strict allowlist and schema; dynamic command execution, process launching, window focus, and OS-desktop fallback are absent. Calls on one seat cannot overlap, while distinct seats are independent. Shutdown blocks on in-flight admission, aborts in-flight actions and attempts cleanup. If cleanup cannot be verified, the seat remains quarantined and its UID/display cannot be reused. Failed initial cleanup closes the coordinator to further admission.

## Gates required for operational integration

1. Implement a **trusted real backend** using separate authorized Unix identities / OS process and display boundaries, plus an explicit authenticated user/agent/profile mapping. Core currently has no such backend, and this module is not connected to the MCP tool registry.
2. Verify PID and UID from the kernel rather than a self-declared object; verify profile ownership and directory mode, X server's `-auth` policy, no external TCP listener, actual compositor instance and child lifecycle. Host-wide `DISPLAY` and Xauthority must never be inherited as a fallback.
3. Add independent per-seat screenshot, drag, clipboard and keyboard acceptance, accurate cancellation, crash/restart/revocation with held-input release. Confirm the human operator can concurrently use the real GNOME desktop without any cursor/focus disturbance.
4. Add owner-authorized seat observation/control transfer with audit and per-tenant policy. A real service must persist lease recovery state and use a supervisor/OS process group on abnormal Core termination.
5. Independent human review, exact-head Ubuntu/Windows CI, and version-scoped publisher acceptance are required before merging/promoting the Core/Browser release.

## Scope of automated tests

`node --test test/isolated-seat-coordinator.test.mjs` verifies denial without backend, two owned seats, cross-owner rejection, input schema checks, capacity, TTL expiry, fail-closed cleanup/quarantine, rejection of same UID and unverifiable kernel identity, rejection of display collisions and duplicate concurrent seat IDs, concurrent close/start, and abort during an active operation.

These tests use deliberately injected mock backends. They verify coordinator logic, **not** a functioning separately authenticated GDM session or actual OS identity isolation. No services, accounts, credentials, RDP ports, installed binaries or live GUI profiles are changed by this candidate.
