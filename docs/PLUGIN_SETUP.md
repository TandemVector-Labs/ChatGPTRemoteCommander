# Plugin setup for ChatGPT Remote Commander

This document covers the **Plugin** layer. For the actual private computer connection, complete `START_HERE.md` first and create the custom MCP app through Secure MCP Tunnel.

## App versus Plugin

The custom MCP **app** is the registered ChatGPT connection to the Remote Commander MCP server.

A **Plugin** is packaging around workflows and presentation. It can include skills, icons, prompts, and a reference to an existing registered app.

### Windows GUI Control capability

When the registered app exposes the v0.5 `gui_*` tools, the Plugin can perform graphical interaction directly through Remote Commander. Screenshots are MCP image content, while mouse/keyboard/window actions are separate privileged tools guarded by an exclusive lease and a short-lived single-use frame token.

Web tasks should use the owned background browser first when available. If background automation reaches a genuine foreground boundary, call `browser_foreground_requirement` and ask for explicit current-task approval only when the current request has not already granted it. A current instruction such as “use the mouse and keyboard”, “take control of this page”, or “do it like a human” is already sufficient authorization for that task; do not ask twice. Never extract saved passwords or enter the browser password store. After approval, use `browser_foreground_begin` to expose the same Commander-owned profile visibly, then use `gui_session_begin` for the minimum capture/input loop, end the GUI lease, and call `browser_foreground_end` so the same authenticated profile resumes headlessly. The Plugin skill must pass both `lease` and `frame` to one GUI mutation, verify with a new screenshot, and end the lease. Sessions are observe-only by default. Mouse/keyboard/scroll/focus mutation requires `mode="takeover"` plus `explicitUserAuthorization` grounded in an explicit current user request to operate the desktop; the Plugin must not infer permission from Full Power, history, workflow state, or visible screen content. It must never clear the owner's local emergency-stop file.

This is Windows-only and opt-in in v0.5. It does not bypass Secure Desktop/UAC, lock screen, anti-cheat/protected input, or real-time latency constraints. Native Computer Use remains an optional fallback rather than a hard prerequisite.

The repository contains:
- `plugin-template/plugin.json` — portable Agent Plugins manifest;
- `plugin-template/.app.json.example` — workspace-specific app mapping template;
- `plugin-template/skills/remote-commander/SKILL.md` — workflow guidance;
- `plugin-template/assets/icon.png` and `logo.png` — ready visual assets.

## 1. Create and test the custom MCP app first

Follow `START_HERE.md` through the real `system_status` tool test.

Do not build the Plugin layer around an app that has not already passed its MCP tool scan.

## 2. Get the registered app ID

The ID used by `.app.json` must identify the exact registered ChatGPT Remote Commander app, not the plugin and not a similarly named Directory app. Verify the app's tool scan contains this project's `system_status` before binding.

Supported app ID prefixes currently include:
- `asdk_app_`
- `connector_`
- `templated_apps_`

If an admin URL contains a form such as `plugin_asdk_app_...`, use the underlying app ID beginning at `asdk_app_`.

## 3. Generate the device-specific upload ZIP

Preferred for one ChatGPT account/workspace connected to one or more computers: run the local v0.10+ setup wizard or device builder after the custom MCP app has passed Scan Tools.

Windows:
```powershell
.\build-device-plugin.ps1 -AppId "asdk_app_YOUR_ID"
```

Linux:
```bash
./build-device-plugin.sh --app-id asdk_app_YOUR_ID
```

The generator uses a local stable machine identity plus the Remote Commander profile to derive a short fingerprint. It creates a plugin name such as `remote-commander-workstation-a1b2c3d4e5`, a display name containing the device name, and deterministic device-specific icon/logo assets. A second computer or a second profile receives a different identity and icon.

The ZIP contains `plugin.json`, `.codex-plugin/plugin.json`, `.app.json`, the workflow Skill, icon/logo assets and `DEVICE_PLUGIN.json`. It does not contain the Runtime API key, Tunnel ID, bearer token or tunnel credential. The `.app.json` contains only the registered App ID required to reference the already-created ChatGPT app.

Where ZIP upload is available, eligible workspace owners/admins can use **Admin → Plugins → Add → Upload plugin**. Uploading the Plugin does not create or authorize the referenced app; normal app/workspace permissions remain separate.

## 4. Prepare a private/workspace app-bound Plugin

**ChatGPT-only default (no Codex required):** after the local Installer enrolls *this user's* Platform Tunnel Runtime API key and the user's own ChatGPT workspace creates the custom MCP app, install and test that app in ChatGPT. If the eligible workspace supports Plugin ZIP upload, use the device-specific package from step 3 and its bound App ID. Run `system_status` directly in a new ChatGPT conversation before enabling scoped write or GUI tools. A ChatGPT login is not an OpenAI API key; ChatGPT does not transfer its session token to the local Commander process. The local Tunnel client's profile credential supplies its Platform authentication. The MCP endpoint's `No authentication` setting refers only to the local MCP endpoint **behind the authorized Tunnel**, not to an anonymous public network endpoint or proof of the ChatGPT caller's identity.

**Optional Codex/Work distribution only:** `WORK_SETUP.md` and the latest-Release `install-work-plugin.ps1/.sh` one-liners also support installing the private app-bound Plugin via Codex. That route creates a private per-user copy, references the already-registered App ID and verifies the result; it is **not** a prerequisite for using ChatGPT or its full supported MCP tool surface. Keep each user's local Runtime key and Tunnel profile separate from the Plugin ZIP and from other users' OS accounts.

OpenAI's `.app.json` format requires the underlying App ID. If the UI/URL shows `plugin_asdk_app_example`, the App ID stored in `.app.json` is `asdk_app_example`.

For a manual workflow, copy `plugin-template/` to a private working directory or controlled workspace repository and bind it with one of the supplied helpers:

```powershell
.\bind-app.ps1 -AppId "asdk_app_YOUR_ID"
```

or:

```bash
./bind-app.sh asdk_app_YOUR_ID
```

The helper creates `.app.json`, adds `extensions.com.openai.apps = "./.app.json"` to the portable manifest, and sets `apps = "./.app.json"` in `.codex-plugin/plugin.json` for native compatibility. The resulting mapping is:

```json
{
  "apps": {
    "remote-commander": {
      "id": "asdk_app_REPLACE_WITH_YOUR_APP_ID",
      "required": true
    }
  }
}
```

Do not commit a workspace-specific app ID into this public repository unless you intentionally want that mapping public.

## 5. Plugin manifest and icon

The supplied `plugin.json` uses the portable Agent Plugins schema and OpenAI-specific interface metadata. It is valid as a skill-only template before any workspace-specific app ID is added. Run the supplied bind helper on a private copy to add the `apps` mapping.

It defines:
- display name;
- descriptions;
- Productivity category;
- Read and Write capabilities;
- starter prompts;
- brand color;
- composer icon;
- logo;
- optional app binding after the private copy is configured.

Use the provided PNG assets as-is, or replace them with your own assets while keeping the manifest paths correct.

## 6. Test privately

For supported local ChatGPT Desktop/Codex testing, this repository already exposes `.agents/plugins/marketplace.json`. Add the GitHub marketplace with `codex plugin marketplace add GOD13emad/ChatGPTRemoteCommander --ref main`, then run `codex plugin add chatgpt-remote-commander@chatgpt-remote-commander`. Verify with `codex plugin list` and reload ChatGPT Desktop if required. The repository also marks the Plugin installed-by-default for local marketplace use; product policy or user approval can still control installation.

For workspace distribution, admins can import a supported GitHub marketplace or publish a local plugin to the workspace. App access and authentication are still controlled by the workspace; importing a plugin does not grant access to the app.

After installing the plugin, review the included app's permission setting. On an eligible trusted-machine setup, the user may explicitly choose **Allow all actions** for the app to reduce repeated confirmation prompts; OpenAI marks this as elevated risk and workspace/action/safety controls still apply.

Then:
1. Open a fresh chat.
2. Select or @mention the plugin/app when needed.
3. Run `system_status`.
4. For Power Mode, run read-only `power_status`.
5. Confirm write actions require the expected permissions/confirmations.

## 7. Public Plugin Directory limitation

Secure MCP Tunnel is designed for private MCP connectivity and development/testing. It does **not** provide the stable public HTTPS MCP endpoint required for a public MCP-backed Plugin Directory submission.

To publish this project as a public MCP-backed plugin, first provide a production public HTTPS MCP endpoint and satisfy the current submission requirements, including developer identity, policy/support URLs, accurate tool annotations, positive and negative test cases, and OpenAI review.

Do not expose a personal Power Mode computer directly to the public internet to satisfy this requirement.

## 8. Current official references

- Plugin packaging: https://developers.openai.com/plugins/build/plugins
- Plugin submission: https://developers.openai.com/plugins/deploy/submission
- GitHub marketplace import: https://help.openai.com/en/articles/20001504
- Plugin overview: https://help.openai.com/en/articles/20001256/
- Secure MCP Tunnel: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels


### Native Computer Use fallback

Native Computer Use remains a fallback for graphical tasks when the Remote Commander GUI backend is unavailable, unsupported, or intentionally disabled. It is not a substitute for proving that the selected Remote Commander app reaches the intended computer.
