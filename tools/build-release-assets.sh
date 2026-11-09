#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT="${1:-$ROOT/dist/release}"
VERSION="$(node -p "require('$ROOT/package.json').version")"
COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
EPOCH="$(git -C "$ROOT" show -s --format=%ct HEAD)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for f in \
  install.ps1 install.sh install-work-plugin.ps1 install-work-plugin.sh \
  setup-wizard.ps1 setup-wizard.sh build-device-plugin.ps1 build-device-plugin.sh tools/generate-device-plugin.mjs \
  server-install-windows.ps1 server-install-linux.sh START_HERE.md WORK_SETUP.md \
  assets/plugin-icon.png assets/plugin-icon.svg assets/plugin-logo.png \
  plugin-template/plugin.json plugin-template/.codex-plugin/plugin.json
do
  [[ -f "$ROOT/$f" ]] || { echo "missing release input: $f" >&2; exit 1; }
done
command -v python3 >/dev/null 2>&1 || { echo 'python3 is required to build deterministic ZIP assets' >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo 'sha256sum is required to build release checksums' >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT"

cp "$ROOT/install.ps1" "$OUT/install.ps1"
cp "$ROOT/install.sh" "$OUT/install.sh"
cp "$ROOT/install-work-plugin.ps1" "$OUT/install-work-plugin.ps1"
cp "$ROOT/install-work-plugin.sh" "$OUT/install-work-plugin.sh"
cp "$ROOT/server-install-windows.ps1" "$OUT/server-install-windows.ps1"
cp "$ROOT/server-install-linux.sh" "$OUT/server-install-linux.sh"
cp "$ROOT/START_HERE.md" "$OUT/START_HERE.md"
cp "$ROOT/WORK_SETUP.md" "$OUT/WORK_SETUP.md"
cp "$ROOT/assets/plugin-icon.png" "$OUT/plugin-icon.png"
cp "$ROOT/assets/plugin-icon.svg" "$OUT/plugin-icon.svg"
cp "$ROOT/assets/plugin-logo.png" "$OUT/plugin-logo.png"

zip_tree() {
  local src="$1" dest="$2"
  python3 - "$src" "$dest" "$EPOCH" <<'PY'
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
import stat, sys, time
src = Path(sys.argv[1]).resolve()
dest = Path(sys.argv[2]).resolve()
epoch = max(int(sys.argv[3]), 315532800)
dt = time.gmtime(epoch)[:6]
with ZipFile(dest, "w", compression=ZIP_DEFLATED, compresslevel=9) as z:
    for path in sorted((p for p in src.rglob("*") if p.is_file()), key=lambda p: p.relative_to(src).as_posix()):
        rel = path.relative_to(src).as_posix()
        info = ZipInfo(rel, date_time=dt)
        mode = stat.S_IMODE(path.stat().st_mode)
        info.external_attr = (mode & 0xFFFF) << 16
        info.compress_type = ZIP_DEFLATED
        z.writestr(info, path.read_bytes(), compress_type=ZIP_DEFLATED, compresslevel=9)
PY
}

plugin_stage="$TMP/plugin-template"
mkdir -p "$plugin_stage"
cp -a "$ROOT/plugin-template/." "$plugin_stage/"
zip_tree "$plugin_stage" "$OUT/plugin-template.zip"
cp "$OUT/plugin-template.zip" "$OUT/plugin-template-v$VERSION.zip"

installer_stage="$TMP/installer"
mkdir -p "$installer_stage/tools"
for f in install.ps1 install.sh install-work-plugin.ps1 install-work-plugin.sh setup-wizard.ps1 setup-wizard.sh build-device-plugin.ps1 build-device-plugin.sh server-install-windows.ps1 server-install-linux.sh START_HERE.md WORK_SETUP.md; do
  cp "$ROOT/$f" "$installer_stage/$f"
done
cp "$ROOT/tools/generate-device-plugin.mjs" "$installer_stage/tools/generate-device-plugin.mjs"
cp "$OUT/plugin-template.zip" "$installer_stage/plugin-template.zip"
# Versioned release ZIP wizards must bind the SAME immutable source identity
# as the self-extracting Linux .run and compiled Windows EXE.
python3 - "$installer_stage" "$VERSION" "$COMMIT" <<'PIN_WIZARDS'
from pathlib import Path
import re, sys
stage, version, commit = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
assert re.fullmatch(r"[0-9a-f]{40}", commit), "release commit required"
assert re.fullmatch(r"[0-9]+[.][0-9]+[.][0-9]+", version), "release version required"
pw = stage / "setup-wizard.ps1"
script = pw.read_text()
old = "$args=@('-StartServer')"
new = "$args=@('-StartServer','-SourceRef','v" + version + "','-ExpectedCommit','" + commit + "')"
assert script.count(old) == 1, "Windows wizard install invocation changed"
pw.write_text(script.replace(old,new))
sh = stage / "setup-wizard.sh"
script = sh.read_text()
header = "#!/usr/bin/env bash\n"
assert script.startswith(header), "Linux wizard shebang changed"
assert "REMOTE_COMMANDER_SOURCE_REF=" not in script and "REMOTE_COMMANDER_EXPECTED_COMMIT=" not in script
pinned = ("export REMOTE_COMMANDER_SOURCE_REF='v" + version + "'\n"
          "export REMOTE_COMMANDER_EXPECTED_COMMIT='" + commit + "'\n")
# Some standard ZIP extractors do not restore executable permission bits.
# Execute the Bash installer via the interpreter, independent of chmod.
call = '  "$INSTALLER" "$' + '{args[@]}"'
assert script.count(call) == 1, "Linux installer invocation changed"
script = script.replace(call, '  bash "$INSTALLER" "$' + '{args[@]}"')
sh.write_text(header + pinned + script[len(header):])
PIN_WIZARDS
cat > "$installer_stage/README-INSTALL.txt" <<EOF
ChatGPT Remote Commander v$VERSION
Release commit: $COMMIT

Easiest Windows path:
  pwsh.exe -NoLogo -NoProfile -File .\setup-wizard.ps1

Easiest Linux path:
  bash ./setup-wizard.sh

The wizard installs/updates Commander, enrolls the private tunnel using local hidden
credential prompts, verifies health/readiness, and after the ChatGPT custom app is
created/scanned accepts its App ID and produces a device-specific Plugin ZIP.
Runtime API keys and tunnel credentials are never included in that Plugin ZIP.

Direct Windows install:
  pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -PowerMode -StartServer -SourceRef v$VERSION -ExpectedCommit $COMMIT

Windows Server bootstrap (run from an elevated Administrator PowerShell 7):
  pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\server-install-windows.ps1 -SourceRef v$VERSION -ExpectedCommit $COMMIT

Direct Linux install:
  ./install.sh --power-mode --start-server --source-ref v$VERSION --expected-commit $COMMIT

Linux Server bootstrap:
  ./server-install-linux.sh --source-ref v$VERSION --expected-commit $COMMIT

No antivirus exclusions are added by the server bootstrap.
EOF
(
  cd "$installer_stage"
  sha256sum install.ps1 install.sh install-work-plugin.ps1 install-work-plugin.sh \
    setup-wizard.ps1 setup-wizard.sh build-device-plugin.ps1 build-device-plugin.sh tools/generate-device-plugin.mjs \
    server-install-windows.ps1 server-install-linux.sh plugin-template.zip START_HERE.md WORK_SETUP.md README-INSTALL.txt \
    | LC_ALL=C sort -k2 > SHA256SUMS-INSTALLER.txt
  sha256sum -c SHA256SUMS-INSTALLER.txt
)
zip_tree "$installer_stage" "$OUT/ChatGPT-Remote-Commander-v$VERSION-Installer.zip"

windows_stage="$TMP/windows-setup"
mkdir -p "$windows_stage"
cp "$installer_stage/setup-wizard.ps1" "$windows_stage/setup-wizard.ps1"
cp "$ROOT/install.ps1" "$windows_stage/install.ps1"
cat > "$windows_stage/SETUP.cmd" <<'CMD'
@echo off
setlocal
where pwsh.exe >nul 2>nul
if errorlevel 1 (
  echo ChatGPT Remote Commander requires PowerShell 7.
  echo Install PowerShell 7, then run SETUP.cmd again.
  pause
  exit /b 2
)
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-wizard.ps1"
set "RC_EXIT=%ERRORLEVEL%"
echo.
if not "%RC_EXIT%"=="0" echo Setup exited with code %RC_EXIT%.
pause
exit /b %RC_EXIT%
CMD
cat > "$windows_stage/README.txt" <<EOF
ChatGPT Remote Commander v$VERSION — Windows Setup

1. Extract this ZIP.
2. Double-click SETUP.cmd.
3. Choose Standard, Full/Power, or Full/Power + GUI.
4. Enter tunnel/runtime credentials only in the local hidden prompts.
5. Create/scan the ChatGPT custom app when instructed.
6. Paste only its App ID into the local wizard. The wizard creates a unique
   device Plugin ZIP in Downloads\RemoteCommander-Plugins.

The Plugin ZIP contains the app binding, workflow skill, unique device name,
unique deterministic icon/logo, and no Runtime API key or tunnel credential.
EOF
zip_tree "$windows_stage" "$OUT/ChatGPT-Remote-Commander-Windows-Setup-v$VERSION.zip"
cp "$OUT/ChatGPT-Remote-Commander-Windows-Setup-v$VERSION.zip" "$OUT/ChatGPT-Remote-Commander-Windows-Setup.zip"

linux_stage="$TMP/linux-setup"
mkdir -p "$linux_stage"
cp "$installer_stage/setup-wizard.sh" "$linux_stage/setup-wizard.sh"
cp "$ROOT/install.sh" "$linux_stage/install.sh"
cat > "$linux_stage/SETUP.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec bash "$ROOT/setup-wizard.sh"
SH
chmod +x "$linux_stage/SETUP.sh" "$linux_stage/setup-wizard.sh" "$linux_stage/install.sh"
cat > "$linux_stage/README.txt" <<EOF
ChatGPT Remote Commander v$VERSION — Linux Setup

1. Extract this ZIP.
2. Run: ./SETUP.sh
3. Choose Standard, Full/Power, or Full/Power + GUI.
4. Enter tunnel/runtime credentials only in the local hidden prompts.
5. Create/scan the ChatGPT custom app when instructed.
6. Paste only its App ID into the local wizard. The wizard creates a unique
   device Plugin ZIP in ~/Downloads/RemoteCommander-Plugins when available.

The Plugin ZIP contains the app binding, workflow skill, unique device name,
unique deterministic icon/logo, and no Runtime API key or tunnel credential.
EOF
zip_tree "$linux_stage" "$OUT/ChatGPT-Remote-Commander-Linux-Setup-v$VERSION.zip"
cp "$OUT/ChatGPT-Remote-Commander-Linux-Setup-v$VERSION.zip" "$OUT/ChatGPT-Remote-Commander-Linux-Setup.zip"

(
  cd "$OUT"
  find . -maxdepth 1 -type f ! -name SHA256SUMS.txt -printf '%f\n' \
    | LC_ALL=C sort \
    | while IFS= read -r f; do sha256sum "$f"; done > SHA256SUMS.txt
  sha256sum -c SHA256SUMS.txt
)

count="$(find "$OUT" -maxdepth 1 -type f | wc -l | tr -d ' ')"
[[ "$count" -eq 19 ]] || { echo "unexpected release asset count: $count" >&2; exit 1; }
echo "RELEASE_ASSETS_PASS version=$VERSION commit=$COMMIT count=$count out=$OUT"
