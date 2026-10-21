# ChatGPT Remote Commander

> **Official project brand:** **[TandemVector Labs](https://github.com/Usefull-Skills)**. Lead source/release maintainer: [Aliakbar Emadoddin](https://github.com/GOD13emad); supporting collaborator: [MMZ](https://github.com/mohammadmohammadzadeh19960-code). [Maintainer credits](docs/PUBLISHER_AND_MAINTAINERS.md). Windows v0.10.24 preview is **UNSIGNED**; checksums and GitHub provenance do not replace Authenticode or remove SmartScreen warnings. Current Stable remains v0.10.20.

> **Current published Core is [v0.10.20](docs/RELEASE_0.10.20.md).** [Release authority and open gates](docs/RELEASE_AUTHORITY.md) distinguish stable Core, separate Browser stable, and unaccepted UI/Updater drafts. `main` is not itself a release.

![ChatGPT Remote Commander icon](assets/plugin-icon.png)

Cross-platform Windows + Linux MCP server for controlled remote project and machine access from ChatGPT through OpenAI Secure MCP Tunnel.

> **Giving this repository to ChatGPT for installation? Start with [START_HERE.md](START_HERE.md).** It is the single current source of truth for Standard/Full mode selection, install/update, Secure MCP Tunnel, persistent enrollment, ChatGPT custom app creation, Plugin packaging/install, icon use, real tool testing, autostart, stop/start, and FINAL PASS. For ChatGPT Work/Codex orchestration, also use [WORK_SETUP.md](WORK_SETUP.md).

**Setup guides in 10 languages:** [English](docs/SETUP.en.md) · [فارسی](docs/SETUP.fa.md) · [العربية](docs/SETUP.ar.md) · [Türkçe](docs/SETUP.tr.md) · [Español](docs/SETUP.es.md) · [Français](docs/SETUP.fr.md) · [Deutsch](docs/SETUP.de.md) · [Русский](docs/SETUP.ru.md) · [简体中文](docs/SETUP.zh-CN.md) · [日本語](docs/SETUP.ja.md)

[Documentation index](docs/README.md) · [Server install](docs/SERVER_INSTALL.md) · [Current release: v0.10.20](docs/RELEASE_0.10.20.md) · [Project status](docs/PROJECT_CONTROL_STATE.md) · [Development roadmap](docs/PROJECT_ENGINE_ROADMAP.md)

[Finite companion 1.0.0 source-review snapshot](experimental/finite-companion-v1.0.0/README.md) · [گزارش فارسی همراه](docs/COMPANION_1.0.0_20261003_FA.md). This separate, owner-scoped companion was privately accepted on core 0.10.6; it is not a public installer, core upgrade, or general autonomous agent. Compatibility with the current core and same-chat retry recovery remain unproven.

## Persistent startup

Three deployment patterns are supported: **one ChatGPT account -> multiple computers**, **multiple ChatGPT accounts -> one computer**, and **multiple concurrent chats -> the same computer**. Each computer runs its own MCP server; each account uses its own Secure MCP Tunnel profile; concurrent chat mutations on the same path are serialized to reduce write races.

After the one-time tunnel enrollment, you do **not** need to re-enter the Tunnel ID, local MCP address, health port, or Runtime API key after each login.

### Windows persistent startup

```powershell
.\enable-autostart.ps1 -Profile chatgpt-remote-commander
```

For an existing profile, this only asks for the Runtime API key once. It is stored with Windows DPAPI for the current user. An HKCU logon supervisor then starts/restarts the MCP server and every enrolled tunnel profile automatically.

### Linux persistent startup

```bash
./enable-autostart-linux.sh --profile "$(hostname)"
```

The Linux helper registers a systemd user service when available, otherwise falls back to `crontab`. Runtime keys are stored outside the repository in a user-only `chmod 600` credential file.

## One-command Windows install

For a **fresh Windows Server, Server Core, or machine without WinGet/Git/Node/PowerShell 7**, use [the server bootstrap](docs/SERVER_INSTALL.md) instead of this desktop-oriented path.

Paste this into **PowerShell** for a standard safe-by-default install (it installs missing Git/Node.js/PowerShell 7 with `winget`, downloads and verifies the official OpenAI tunnel client, runs tests/audit, and starts the local MCP server):

```powershell
& ([scriptblock]::Create((irm 'https://github.com/GOD13emad/ChatGPTRemoteCommander/releases/latest/download/install.ps1'))) -InstallPrerequisites -StartServer
```

For trusted machines that need full filesystem/shell/process control, add `-PowerMode`:

```powershell
& ([scriptblock]::Create((irm 'https://github.com/GOD13emad/ChatGPTRemoteCommander/releases/latest/download/install.ps1'))) -InstallPrerequisites -PowerMode -StartServer
```

The same command is also the update command. On Windows v0.3.4+, the installer first detects an already-active installation from the registered supervisor and updates that Git checkout in place. Otherwise, new source code is installed under `%LOCALAPPDATA%\\ChatGPTRemoteCommander\\app`, while persistent state such as `credentials/` and `downloads/` stays one level above. `-StartServer` upgrades a running v0.3 MCP to the newly installed version when needed. The installer never embeds your OpenAI Runtime API key. After creating a Secure MCP Tunnel, run `enable-autostart.ps1` once to enroll the account and enable zero-reentry startup.

## One-command Linux install

```bash
curl -fsSL --connect-timeout 15 --max-time 180 https://github.com/GOD13emad/ChatGPTRemoteCommander/releases/latest/download/install.sh | bash -s -- --install-prerequisites --start-server
```

For Power Mode, add `--power-mode`. Linux amd64 and arm64 are supported by the installer when an official OpenAI tunnel-client artifact is available.

## Features

Remote Commander is **ChatGPT-first**. Hidden/background project runners never use Codex, and local Codex launch remains default-deny. From v0.9.15, a trusted `FULL_POWER` owner profile may explicitly opt in to local Codex launch for a current request that explicitly asks for Codex; this does not create automatic delegation authority. External Work/Codex handoff still requires the user to choose between **Move to Work/Codex** and **Continue in this chat with Remote Commander**; continuing here is the default. In v0.8.35, [durable input requests](docs/PROJECT_ENGINE_DECISIONS.md) let an enrolled project ask for a decision and resume from an explicit answer without resetting its budgets or changing its acceptance criteria.

[The opt-in project execution engine](docs/PROJECT_ENGINE.md), introduced in v0.8.34, adds bounded planner proposals, journaled execution, durable budgets, pause/cancel controls, fresh observations after restart and independent evidence-bound finalization. It is disabled unless explicitly configured and does not automatically enroll existing workflows. See the [development roadmap](docs/PROJECT_ENGINE_ROADMAP.md) for remaining capabilities and comparative qualification.

Optional [adaptive planning and proposal teams](docs/PROJECT_ENGINE_ADAPTIVE.md) add journaled prerequisite insertion, parallel worker advice, one coordinating executor and persistent provider-call budgets. v0.8.36 adds opt-in bounded artifact workers whose receipt-bound output can enter the project only through the normal journaled coordinator path. Acceptance criteria and execution authority remain immutable within a run. v0.8.37 hardens that boundary with exact delegated-step binding, canonical contained imports, end-to-end bounded 64 KiB artifact envelopes, and qualified fail-closed Codex CLI 0.156.1 diagnostics.

- Loopback-only MCP server by default (`127.0.0.1:47831`)
- Configurable allowed filesystem roots
- Directory listing and UTF-8 text reads
- Text writes with automatic backup and optional SHA-256 precondition
- Allowlisted direct executable execution without a shell wrapper
- Cross-platform Power Mode shell: PowerShell 7 on Windows, Bash-compatible shell on Linux
- JSONL audit log and recoverable file mutation backups
- Multi-account / multi-device Secure MCP Tunnel workflow
- Concurrent-chat path locking for mutating operations
- Windows and Linux persistent supervisors

## Background browser — zero-interference web automation

v0.9.3 carries the hardened background-browser and durable-command layers forward with transport-deadline/response-budget hardening. Windows and Linux hosts with Chromium/Chrome use owned headless Chromium over CDP; Linux hosts without Chromium can use an existing Firefox + geckodriver WebDriver backend. Both paths use Commander-owned persistent or isolated profiles and remain background-first. It does **not** move the user's mouse, change foreground focus, type into the user's browser window, reuse the user's normal browser profile, or expose cookies/password-store contents.

Long-running command work is also background-first: `operation_start` returns a durable operation ID quickly, `operation_status` polls bounded state, `operation_result` returns bounded tails plus evidence metadata, and `operation_cancel` stops only the exact Commander-owned operation. Stable request IDs make lost acknowledgements idempotent and uncertain effects are never blindly replayed.\n\nThe intended order for web work is: **background first → approval only when genuinely required → temporary same-profile foreground interaction → return to background**. If the background page encounters MFA, WebAuthn, CAPTCHA, or a site that rejects background operation, `browser_foreground_requirement` returns an explicit approval boundary instead of seizing the desktop. After approval, `browser_foreground_begin` temporarily exposes the same Commander-owned profile visibly; after the minimum GUI step, `browser_foreground_end` returns that same session to headless background operation. Existing user-browser saved passwords are never extracted or copied. See [Background browser and foreground approval](docs/BACKGROUND_BROWSER.md).

This path is deterministic local browser automation and does **not require Codex**. Codex is not a Commander Project Engine provider; any local Codex launch is a separate explicit owner-authorized path, never an automatic browser or project-runner dependency.

## GUI Control — Windows and GNOME/Wayland Linux

Remote Commander exposes **built-in GUI Control** on Windows and, from v0.8.21, GNOME/Wayland Linux. The MCP returns screenshots as image content and exposes bounded mouse, keyboard, window-focus and coordination tools. Zero-interference is invariant: observe-only is the default, and foreground mutation requires an explicit current user request plus a fresh single-use frame.

Safe visual-control loop:

```text
gui_status
→ gui_session_begin
→ gui_screenshot(lease)
→ one gui_* action(lease + single-use frame)
→ gui_screenshot(lease)
→ verify visible result
→ gui_session_end
```

A frame is short-lived and single-use. A second chat cannot take the active desktop lease. GUI actions are never considered successful merely because input was submitted; a fresh screenshot must verify the visible result.

On Windows, enable it on a trusted checkout with:

```powershell
.\install.ps1 -PowerMode -GuiControl -StartServer -SkipTunnelClient
```

After enabling, refresh/re-scan the ChatGPT custom app tools. The owner can stop GUI input locally at any time by holding **Escape** or creating `var\GUI_STOP`; the assistant must not remove that stop file remotely.

Limits remain explicit: Windows Secure Desktop/UAC prompts, the lock screen, anti-cheat/protected-input paths, software that rejects synthetic input, and high-speed real-time gameplay are not bypassed. Different trust levels also require separate OS sessions/authorization; multiple tunnel profiles alone are not security isolation.

## Requirements

- Windows 10/11 with PowerShell 7, or a modern Linux distribution
- Node.js 22+
- Git
- OpenAI Secure MCP Tunnel client and a configured ChatGPT custom plugin/app

## Manual/developer start (optional)

Normal users should follow [START_HERE.md](START_HERE.md) and the latest Release installer. For source-level development only:

1. Clone the repository.
2. Review `config.json`; `%USERPROFILE%` is expanded at runtime.
3. Run `npm run check`.
4. Run `npm test`; expected result: `SMOKE_PASS`.
5. Start the MCP server with `npm start`.
6. Verify `http://127.0.0.1:47831/health`.

The MCP endpoint is `http://127.0.0.1:47831/mcp`.
## Connect ChatGPT

Follow [START_HERE.md](START_HERE.md) for the current end-to-end flow. Create an OpenAI Secure MCP Tunnel and Runtime API key, then run the persistent enrollment entry point:

```powershell
pwsh.exe -NoProfile -File .\connect-chatgpt.ps1
```

On Windows v0.5.0+, `connect-chatgpt.ps1` is the persistent enrollment entry point: it reuses an existing DPAPI-protected credential when available and leaves the background supervisor as the single owner of managed tunnel profiles.

In ChatGPT, create a custom MCP **app** with Connection = Tunnel, select the tunnel, use **None / No authentication** for this server, run **Scan Tools**, review permissions, and create the app. See [START_HERE.md](START_HERE.md) for the plan/workspace requirements and FINAL PASS checklist.

For Plugin packaging, icons, app binding, and private/workspace distribution, see [docs/PLUGIN_SETUP.md](docs/PLUGIN_SETUP.md) and [plugin-template](plugin-template/). For ChatGPT Work/Codex, [WORK_SETUP.md](WORK_SETUP.md) includes `@plugin-creator` plus self-contained latest-Release one-command app-bound installers for Windows/Linux. They accept either the underlying App ID or the `plugin_...` technical identifier shown by ChatGPT and automatically fetch the Release Plugin template when no checkout is present.

## Tools

Legacy-safe tools: `system_status`, `list_directory`, `read_text`, `write_text`, `run_project_command`. Power Mode can also expose the direct-session background browser tools (`browser_status`, session begin/renew/end, navigate, snapshot, screenshot, fill, click, wait, foreground-requirement coordination, and explicit same-profile foreground begin/end). These browser tools are not part of autonomous workflow execution. Power Mode adds `power_status`, `file_info`, `read_file`, `write_file`, `create_directory`, `copy_path`, `move_path`, `delete_path`, `search_files`, `run_shell`, `system_info`, `list_processes`, `kill_process`, and persistent terminal tools (`start_terminal`, `read_terminal`, `send_terminal`, `stop_terminal`).

## Owner-directed persistent project roadmap

ChatGPT and Remote Commander can manage one durable end-to-end project map
without inventing another Project Brain or moving work to ChatGPT Work.
The native roadmap interface exposes accepted goal/criteria, ordered step IDs,
dependencies, blockers and next ready step through `workflow_roadmap`.
An approved new step can be placed with `workflow_plan_insert` and user
priority among independent pending steps can be changed with
`workflow_plan_prioritize`. Pending task labels may also be edited with
`workflow_plan_edit` without changing IDs or dependencies.
Replays return receipts; unchanged edits are
NO_OP and stale/conflicting edits are rejected. The existing
`workflow_revise` handles goal/criteria changes.

This is the **current ChatGPT + Commander conversation**, not a new Work app.
If runnerConfigured=false, unattended execution is unavailable; ChatGPT
can work through authorized ready steps with Commander, verify effects and
advance the persistent plan. Full Power does not grant root, consent or
cross-account authorization. See
[Owner-directed workflow roadmap](docs/OWNER_ROADMAP.md). For strictly
bounded, trusted non-Codex steps with actual native scheduler readback,
see [ChatGPT + Commander automatic execution](docs/RUNNER_CHAT_COMMANDER_ONLY.md).

## Security

Filesystem containment is enforced, but command execution is **not an OS sandbox**. An allowlisted executable or project script may itself access resources beyond the configured roots. Treat command execution as privileged. See [SECURITY.md](SECURITY.md) and the point-in-time [SECURITY_AUDIT.md](SECURITY_AUDIT.md).

## Validation

v0.8.24 hardens the Linux GNOME/Wayland GUI lifecycle: unchanged extension bytes are not replaced, changed active extensions are orderly disabled before atomic replacement and re-enabled afterward, and enabled-but-inactive state gets a bounded same-session recovery attempt. Runtime `/var/` files are ignored so operational logs/state do not make the control checkout appear dirty.

v0.8.23 fixes stable-channel release discovery: both platforms now prefer GitHub's published `releases/latest` redirect and use the Releases API only as fallback. Raw Git tags are never treated as stable releases, so tagged-but-unpublished candidates cannot be auto-promoted.

v0.8.22 hardens the zero-downtime route invariant: an unresolved previous generation must be safely retired before any new cutover, and the router switch itself refuses to overwrite `route.previous`. Windows deferred maintenance also checks persistent terminals before every old-backend stop path. v0.8.21 adds guarded GNOME/Wayland GUI control on Linux and makes the zero-interference rule machine-readable across config, capability migration and runtime status. Linux install/update synchronizes the per-user GNOME extension without forcing logout/reboot; on GNOME 46 a newly introduced extension may remain unavailable until the next normal desktop session, and that limitation is reported rather than bypassed. Published stable-version discovery now uses GitHub Release authority, and scheduler status distinguishes automatic recovery/readiness from the intentionally absent model/agent execution runner.

v0.8.20 prevents updates from orphaning persistent terminal control: automatic promotion is deferred before route cutover when the active backend owns a Remote Commander interactive terminal, and any already-draining previous backend is also protected before every stop path on Windows and Linux. This follows the same general design principle as persistent/reconnectable terminal managers and graceful endpoint draining: preserve the live session owner until it can be safely retired. v0.8.19 closes a maintenance-loop failure found by the GUI/chess stress test. Release cleanup is now decoupled from supervisor restart: locked superseded releases produce explicit cleanup-pending evidence while the healthy supervisor/tunnel remain untouched. Behavioral Windows regressions cover both successful cleanup and an intentionally locked release, and platform contracts require cleanup-only paths on Windows and Linux to contain no supervisor recycle.

v0.8.18 closes the Windows drain-lifecycle failure found during live v0.8.15 promotion. Long-lived staged backends no longer inherit the updater's piped MCP stdio handles; stale drain recovery is evidence-based rather than version-based; persistent terminals block automatic retirement; successful drains atomically clear `route.previous`; and runtime server version is required to match package/plugin release metadata. Behavioral Windows regressions cover stdio detach, stale-drain policy and route retirement.

v0.8.17 fixes a live Linux auto-update lock inheritance defect: the promoted backend and stable router now close the updater lock descriptor before becoming long-lived processes, preventing a completed update from permanently blocking future updates with `AUTO_UPDATE_ALREADY_RUNNING`.\n\nv0.8.16 hardens Linux lifecycle and release packaging: the supervisor now boots the installer-managed portable Node runtime under systemd/crontab, Linux scripts are Git-tracked executable, disable cleanup covers routed backend/router ownership, and tunnel-client downloads use bounded timeouts. This closes the live Ubuntu auto-update stall and the earlier mode-only `control tracked dirty` installer failure.\n\nv0.8.15 fixes a release-test harness flake discovered by exercising the packaged Full Power installer from an exact tag. Stable-router tests no longer send loopback test traffic through Node Fetch, whose browser-compatible blocked-port list can reject otherwise valid OS-assigned free ports such as 5060. The tests now use `node:http`, the same local transport family being exercised. Router/product runtime behavior is unchanged. The corrected suite passed 10 consecutive focused runs before full release validation.

v0.8.14 closes candidate-validation lifecycle gaps found while installing the immutable v0.8.12 release. Candidate processes are ownership-tracked immediately after spawn and cleaned on pre-cutover failure, preventing orphan listeners and locked workflow-shadow stores. Unattended Windows update validation no longer calls the shared interactive `gui_status` helper; it uses the existing native no-input self-test plus candidate `system_status` GUI backend/policy evidence, so update checks do not contend for or seize the user's desktop. v0.8.14 keeps all v0.8.13 supervisor continuity protections and adds a checksum-manifested installer bundle.

v0.8.13 adds fail-closed supervisor liveness and canonical-listener continuity on top of v0.8.12 monotonic updates, v0.8.11 drain-accounting and v0.8.10 zero-interference desktop authority. A routed backend cannot be force-recycled after one transient health miss: recovery requires three consecutive misses, readable router activity, zero in-flight work, and a final health/activity re-check. A healthy canonical router is also retained when only its loaded source hash is stale, avoiding an intentional update-time listener gap.

v0.8.12 makes stable automatic updates monotonic on both Windows and Linux: an unattended updater will not replace a running newer build with an older GitHub Latest release. Explicit forced/exact-ref operations remain available for deliberate testing or rollback. This closes the live sequencing failure observed while an unpublished v0.8.10/v0.8.11 candidate was newer than the public stable release.

v0.8.11 fixes a stable-router lifecycle edge case observed during the v0.8.10 blue/green cutover: when an MCP client disconnected while the backend response still existed, the proxy could leave the old backend permanently counted as in-flight even after the tool action had completed. The router now unpipes a closed downstream response and drains the upstream response to its real completion without cancelling or replaying the operation. A production-shaped regression failed before the fix and passes afterward.

v0.8.10 adds a zero-interference desktop contract: GUI sessions are observe-only by default, and every mouse/keyboard/scroll/focus mutation requires a separate `takeover` lease carrying an explicit-current-user authorization basis. Full Power no longer implies permission to seize the foreground desktop. Headless/filesystem/shell/API paths remain preferred when the user has not explicitly requested interactive desktop control. The server enforces the session mode before native input, while the Plugin/Work contracts forbid inferring takeover permission from history, workflow memory, or screen content. Durable workflow execution also refuses takeover acquisition and GUI mutations, so resumed/background project state cannot become desktop-input authority.

v0.8.9 retains the v0.8.8 router source-activation hardening and the v0.8.7 persistent GUI performance/deferred-drain work. Unattended Windows updates no longer run the interactive focus/click/type GUI E2E, because Windows intentionally restricts background SetForegroundWindow requests and an updater must not steal the user's desktop. Automatic candidates instead run the native no-input self-test and then prove the candidate GUI backend with the candidate MCP hardware self-test; the full interactive GUI E2E remains mandatory on the exact clean release commit. Explicit Full Power remains an all-on authority class, durable workflows remain crash/restart/update-resumable, and unknown or mutating work is never blindly replayed or force-killed.

 Each isolated account can use a distinct loopback MCP port, config, audit log, runtime marker and private workflow database; secondary profiles default to Standard Mode with GUI/shell/full-filesystem disabled. Workflow actions use intent-before-effect journaling, evidence checkpoints and explicit uncertain-outcome reconciliation with no automatic replay. Use `configure-durable-workflows.ps1` for the primary profile and `configure-profile-instance.ps1 -Profile <name>` (or `connect-chatgpt-account.ps1 -Profile <name> -Isolate`) for additional accounts. This is a local application boundary, not an OS sandbox: use separate Windows users/VMs for principals with different OS-level trust. See `docs/DURABLE_WORKFLOWS_R1.md` and `docs/PROFILE_ISOLATION_R1.md`.

v0.6.5 is an integrity hotfix over v0.6.4: SHA-256 write preconditions now fail closed when the target is missing or malformed, and interrupted moves preserve the only complete promoted copy plus explicit recovery evidence instead of risking data loss. v0.6.4 retained the v0.6.3 diagnostics/test-isolation and v0.6.2 Power Mode/GUI/runtime hardening, and added bounded Linux network operations so external-download failures cannot hang indefinitely. Legacy 2025 clients remain supported, while MCP `2026-07-28` clients receive stateless discovery/routing, required `tools/list` cache hints, strict protocol-header validation, closed-schema tool inputs, and tool-level `isError` failures for known-tool validation/runtime errors. The release gate includes a dependency-free real-server conformance test and was additionally exercised against the official `@modelcontextprotocol/client@2.0.0` in legacy, modern-auto, and modern-pinned modes. Linux installer and Plugin downloads use explicit connection/total deadlines; failures return nonzero instead of waiting without a bound. Persistent audit logs are serialized and bounded/rotated by default. `npm run doctor -- --expected-device <name>` performs a loopback-only read-only health/version/device/tool-catalog drift check against the active server. Use `npm run check`, `npm test`, `npm run audit`, and on Windows `npm run test:gui-native` before releases.

## License

MIT — see [LICENSE](LICENSE).

## Power Mode security model

Power Mode is an explicit Full-Control mode for trusted machines. The runtime automatically prefers `config.local.json` when present; this file is gitignored. The public `config.json` remains safe-by-default with Power Mode disabled.

On this machine, Power Mode can enable full filesystem access, direct PowerShell execution, process control, binary file I/O, recursive search, recoverable delete, and persistent terminal sessions. Existing files are backed up before Power Mode overwrite/move/delete operations. In explicit Full Power, permanent delete is enabled unless filesystem.permanent_delete is explicitly disabled in the persisted capability profile.

Explicit Full Power does not retain a hidden Commander shell-pattern denylist: shell capability is unrestricted unless shell.unrestricted or shell.execute is explicitly opted out. Runtime ownership checks, protected-process checks, operation journaling and OS permissions still apply. Full Power is intentionally privileged and is not an OS sandbox; expose it only to trusted accounts.

`FORBIDDEN: This conversation does not support developer MCPs` is a ChatGPT conversation-surface gate that occurs before requests reach this server; server code cannot bypass it. Use a fresh MCP-capable chat when that platform gate appears.

### Local private configuration

Copy the public configuration to `config.local.json`, enable only the Power Mode capabilities you want, and keep that file private. `config.local.json`, audit logs, backups, Runtime API keys, and tunnel credentials must never be committed.

## Multiple ChatGPT accounts on one PC

One MCP server can serve multiple authorized ChatGPT accounts. Each account gets its own Secure MCP Tunnel profile. Health ports are auto-selected; no manual IP/port management is required.

Enroll another Windows account once:

```powershell
.\enable-autostart.ps1 -Profile friend-pro
```

Enroll another Linux account once:

```bash
./enable-autostart-linux.sh --profile friend-pro
```

Each account must use its own tunnel and Runtime API key. The supervisor automatically starts every enrolled profile that points to this local MCP. For one account controlling multiple computers, repeat the installation/enrollment on each computer with a distinct tunnel so each device appears separately in ChatGPT.

v0.8.25 fixes Windows multi-account update isolation: a drain or persistent terminal owned by one ChatGPT profile defers only that profile, while independently healthy profiles can promote without terminating the blocked profile's workload.

v0.8.26 adds Windows terminal-keeper lifecycle handling: long-running persistent-terminal workloads can survive successive zero-downtime upgrades without occupying the single route `previous` slot forever, while cleanup and reaping remain evidence-gated.

v0.8.27 closes the stale-router-accounting edge case: when a previous Windows backend has a live persistent terminal but reports zero active/queued operations, idle/unleased GUI state, no unexpected socket owners, and no non-terminal descendant workload, the updater may detach that backend from `route.previous` while keeping the terminal subtree alive in the retained-backend registry.


v0.8.31 keeps isolated/custom Windows installer validation from mutating live routing when `-NoStartServer` is used. Canonical live installs retain candidate-first delegation, while custom existing checkouts update in place only.
