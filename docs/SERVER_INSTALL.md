# Server installation

This is the server-focused installation path for ChatGPT Remote Commander v0.10.20.

## Windows Server

Use `server-install-windows.ps1` for a fresh Windows Server where Git, Node.js, PowerShell 7, or WinGet might not exist.

The bootstrap:

- runs from the built-in Windows PowerShell environment and installs PowerShell 7 before handing off product installation to `pwsh.exe`;
- does not depend on WinGet;
- supports x64 and ARM64;
- installs the pinned PowerShell 7.6.6 MSI only after SHA-256 and Authenticode validation;
- installs the pinned Node.js 22.23.4 LTS-line security-patched MSI only after matching its SHA-256 against the upstream `SHASUMS256.txt` and validating Authenticode;
- resolves the latest stable Git for Windows installer from the official GitHub release API and requires both the release-asset SHA-256 digest and a valid Authenticode signature;
- stages the requested Remote Commander ref with Git, resolves it to one exact commit, and passes that exact commit into the normal candidate-first installer;
- automatically disables GUI control on Windows Server Core. On Desktop Experience, `-GuiControl Auto` enables GUI control; use `-GuiControl Off` to keep it disabled;
- starts and health-checks the MCP server by default. Use `-NoStartServer` only when deployment policy requires install-only behavior.

Run from an elevated Administrator shell:

```powershell
.\server-install-windows.ps1
```

For an exact release pin:

```powershell
.\server-install-windows.ps1 -SourceRef v0.10.20 -ExpectedCommit <40-hex-release-commit>
```

### Defender / EDR / AppLocker behavior

The installer **does not disable Microsoft Defender, real-time protection, EDR, AppLocker, WDAC, or any other security control, and it does not create antivirus exclusions**.

Every downloaded prerequisite is verified before execution. The installer writes a machine-local evidence file to:

```text
%ProgramData%\ChatGPTRemoteCommander\server-install-allowlist.json
```

That file contains the resolved Remote Commander commit plus SHA-256 and signer information for downloaded prerequisite installers. If an enterprise security product blocks a verified artifact, prefer an administrator-managed allow rule based on publisher/signature or exact file hash. Use a path exception only when organizational policy explicitly requires it and scope it to the narrowest possible path.

Windows Server 2016 and newer already receive Defender built-in and server-role automatic exclusions from Microsoft. Do not add broad process exclusions for PowerShell, Node, Git, the entire user profile, temporary directories, or system folders.

## Linux server

Use `server-install-linux.sh`. It supports apt, dnf, yum, zypper, and pacman families, installs the required base packages, stages the requested source ref to an exact Git commit, then calls the normal installer with prerequisite installation, Full Power, candidate-first validation, and MCP startup.

GUI capabilities are disabled by default because a server is assumed headless. Use `--enable-gui` only on a qualified desktop Linux system.

```bash
chmod +x server-install-linux.sh
./server-install-linux.sh
```

Exact release pin:

```bash
./server-install-linux.sh --source-ref v0.10.20 --expected-commit <40-hex-release-commit>
```

Alpine/musl is intentionally fail-closed in this server wrapper for v0.10.20 because that path is not part of the qualified installer matrix.

## After installation

The MCP server is validated locally on loopback. Tunnel enrollment remains a separate one-time step because the tunnel ID and Runtime API key are account-specific secrets and must not be embedded in a distributable installer.

Windows:

```powershell
pwsh.exe -NoProfile -File "$env:LOCALAPPDATA\ChatGPTRemoteCommander\app\connect-chatgpt.ps1"
```

Linux:

```bash
~/.local/share/ChatGPTRemoteCommander/enable-autostart-linux.sh
```

Do not put tunnel credentials, API keys, or account secrets into deployment images or shared installer files.
