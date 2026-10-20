# GNOME 50 headless seat admission — read-only gate

This document covers the next **separate desktop per Commander agent** track. It does not claim that a shared Mutter RemoteDesktop input lease supplies multiple independent pointers; the current GNOME GUI lease remains observe-only by default with explicit current-task takeover. An independent seat requires its own compositor/session, process namespace, input channel and profile boundary.

## Reproducible host diagnosis

```sh
node tools/linux-headless-seat-readiness.mjs --json
node --test test/linux-headless-seat-readiness.test.mjs
```

The doctor invokes exactly four read-only commands: `grdctl --headless status`, `systemctl --user show` for the headless and desktop-sharing units, and `ss -H -ltn`. It never starts/stops a service, sets credentials, writes certificates, opens sockets, or injects GUI input. The structured report excludes usernames, passwords, certificate paths, and environment secrets. Invalid observations fail closed. The report is a preflight, not a readiness or release attestation.

**MMZ Ubuntu 26.04.1 / GNOME 50.1, observed 2026-10-20:** `gnome-remote-desktop 50.2` is installed, shared-desktop user service is active and TCP `*:3389` is already listening. `gnome-remote-desktop-headless.service` is inactive/disabled. `grdctl --headless status` reports RDP disabled, port 3389, and credentials empty. The read-only gate therefore reports `NOT_READY`, a port conflict and the absence of independent-seat input acceptance. It does **not** disable the current shared desktop or provision a credential. Do not mistake a matching listener for a headless seat; it may belong to the existing shared-desktop service.

GNOME Remote Desktop officially distinguishes desktop sharing, system remote login and a single-user headless session. See [GNOME's configuration documentation](https://github.com/GNOME/gnome-remote-desktop/blob/main/docs/configuration.md). The headless service is a useful backend candidate, **not** evidence that more than one simultaneous headless login or independently controllable physical mouse works. Exact GNOME version and OS behavior must be tested, not inferred from the service being installed.

## Proposed ownership and isolation model

1. **Core owns the seat manager.** Each agent, profile and chat requests an opaque seat lease and can list only its own seats. A unique worker/process tree and desktop state dir must be managed under private permissions; the signed-in desktop remains untouched.
2. **Backend owns desktop/display.** Prefer an independently started headless GNOME user session or an isolated VM/container compositor, rather than injecting another pointer into the owner's foreground display. Never assume one Mutter compositor can multiplex multiple independent seats without explicit capability evidence.
3. **Input is routed by seat ID.** Mouse, keyboard, clipboard, window-focus and screenshot calls target the acquired seat only. Host foreground GUI APIs remain opt-in and never serve as an implicit fallback. A supervisor cannot silently redirect input into a real user's active session.
4. **Transport and credentials are separately authorized.** A fresh RDP listener must not reuse busy port 3389; select and verify a deliberate nonconflicting port, bind to a private interface/network namespace or enforce host firewall, use unique credentials in the OS secret store and TLS trust, and verify actual listener addresses. A port change alone is insufficient: GNOME RDP may listen on all interfaces. Never place credentials in a command line, logs, workflow artifact or ChatGPT message.
5. **Revocation is complete.** Lease expiry and stop must release held keys/buttons, terminate the owned input channel/process group, close the isolated display and keep the real desktop available. Restarts are idempotent and never assume the original user focus was unchanged.
6. **Owner observation is explicit.** Viewing a seat, sharing it with a supervisor or allowing an operator to take over is separately authorized and auditable. Concurrent sessions may not share a HOME, Chromium profile, lockfile, clipboard or writable cache.

## Acceptance gates

- [x] Browser PR #123 exact-head CI `1e34af9`: two private Xvfb servers, two native CEF windows, independent virtual pointer Drag and per-profile state noninterference. Scope: CI virtual displays, not physical multiseat.
- [x] Core read-only GNOME headless preflight detects the actual inactive unit, missing credentials, existing port conflict and no accepted seat.
- [ ] Threat model and authorization for new service, secret storage, TLS and network binding reviewed by the authorized owner.
- [ ] A *new* private headless display starts without influencing desktop sharing or user focus; verify both native app windows and distinct screenshot domains.
- [ ] Two independently controlled seats accept overlapping input gestures, keyboard text and lifecycle operations with no cross-seat leakage.
- [ ] Physical operator may use or move mouse/keyboard without redirecting an agent's input; vice versa. Owner or dedicated environment signs off.
- [ ] A stopped or crashed seat releases resources and cannot reuse another user's profile.
- [ ] Published Core/Browser release passes native tests, review and a version-scoped publisher decision.

**Current decision:** No automatic headless enablement, no RDP port change, no credential creation, no product merge/publish based solely on this document or doctor. Keep existing Commander Core `0.10.25`, CEF launcher and browser profile unchanged.

The GNOME/Mutter RemoteDesktop low-level API is private and version-dependent; do not treat its ability to create multiple API sessions as proof of multiple isolated compositor seats.
