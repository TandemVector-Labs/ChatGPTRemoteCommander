#!/usr/bin/env bash
# Disposable hosted Linux runner only. Exercises actual same-name Debian upgrade,
# native tunnel persistence, sandboxed GUI and downgrade rollback.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == Linux &&
   "${RUNNER_ENVIRONMENT:-}" == github-hosted &&
   "${CI:-}" == true && -n "${GITHUB_WORKSPACE:-}" && -n "${RUNNER_TEMP:-}" ]] || {
  echo 'RC012_NATIVE_UPGRADE_TEST_HOSTED_RUNNER_ONLY' >&2; exit 2;
}
[[ "$(id -u)" != 0 ]] || { echo RC012_NATIVE_UPGRADE_TEST_NONROOT_EXPECTED >&2; exit 2; }
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ "$ROOT" == "$(realpath "$GITHUB_WORKSPACE")" &&
   "$HOME" != "$GITHUB_WORKSPACE" &&
   ! -e "$HOME/.local/share/ChatGPTRemoteCommander" &&
   ! -e "$HOME/.local/share/chatgpt-remote-commander" ]] || {
  echo RC012_NATIVE_UPGRADE_TEST_OWNER_INSTALL_REFUSED >&2;exit 3;
}
cd "$ROOT"
OLD="$ROOT/dist/installer/Remote-Commander-Linux-amd64.deb"
command -v node >/dev/null || { echo RC012_SOURCE_VERSION_NODE_MISSING >&2; exit 3; }
VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")"
GUI_VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT/packaging/unified/package.json")"
[[ "$VERSION" =~ ^0\.12\.0-dev\.[1-9][0-9]*$ && "$VERSION" == "$GUI_VERSION" ]] || {
  echo RC012_NATIVE_UPGRADE_SOURCE_VERSION_MISMATCH >&2;exit 3;
}
NEW="$ROOT/dist/unified/Remote-Commander-Unified-${VERSION}-Linux-amd64.deb"
test -f "$OLD" && test -f "$NEW"
test "$(dpkg-deb --field "$OLD" Package)" = chatgpt-remote-commander
test "$(dpkg-deb --field "$NEW" Package)" = chatgpt-remote-commander
dpkg --compare-versions "$(dpkg-deb --field "$NEW" Version)" gt "$(dpkg-deb --field "$OLD" Version)"
# Audit *actual* Native and merged DEB payload names BEFORE installing even on
# this disposable hosted runner. The public app payload is only the committed
# runtime Core, never the complete repository or human project/Skill records.
python3 - "$OLD" "$NEW" <<'PUBLIC_APP_BOUNDARY'
import subprocess, sys
prefix="./usr/lib/chatgpt-remote-commander/app/"
allowed_dirs={"src","tools","vendor","assets"}
allowed_files={"config.json","package.json"}
for pkg in sys.argv[1:]:
    listing=subprocess.check_output(["dpkg-deb","--contents",pkg],text=True)
    seen=set()
    for row in listing.splitlines():
        at=row.find(prefix)
        if at<0: continue
        relative=row[at+len(prefix):].split(" -> ",1)[0].strip().rstrip("/")
        if not relative: continue
        head=relative.split("/",1)[0]
        if relative in allowed_files or head in allowed_dirs:
            seen.add(relative)
            continue
        raise SystemExit("RC012_PUBLIC_NATIVE_APP_PATH_DISALLOWED "+relative)
    required={"package.json","config.json","src/server-v0.3.mjs"}
    if not required.issubset(seen):
        raise SystemExit("RC012_PUBLIC_NATIVE_APP_REQUIRED_FILE_MISSING")
print("RC012_PUBLIC_NATIVE_APP_ALLOWLIST_PASS")
PUBLIC_APP_BOUNDARY
if dpkg-query -W -f='${Status}' chatgpt-remote-commander 2>/dev/null | grep -q 'install ok installed'; then
  echo RC012_HOSTED_RUNNER_ALREADY_HAS_COMMANDER; exit 3
fi
command -v xvfb-run >/dev/null || { echo RC012_XVFB_PREFETCH_MISSING >&2; exit 4; }
dpkg-query -W -f='${Status}\n' libnotify4 libsecret-1-0 2>/dev/null | grep -c '^install ok installed$' | grep -qx 2 || { echo RC012_SIGNED_GUI_DEPENDENCIES_NOT_PREFETCHED >&2; exit 4; }
sudo dpkg --install "$OLD" || {
  echo RC012_NATIVE_OLD_INSTALL_FAILED >&2; exit 4;
}
NATIVE=/usr/lib/chatgpt-remote-commander
for rel in runtime/node tunnel/native-tunnel-launch.sh tunnel/tunnel-client tunnel/cloudflared; do
  test -s "$NATIVE/$rel"
done
test -f /usr/lib/systemd/user/chatgpt-remote-commander-tunnel@.service
test ! -e '/opt/Remote Commander/remote-commander-unified'
TMP="$(mktemp -d /tmp/rc012-native-upgrade-XXXXXX)"
trap 'rm -rf -- "$TMP"' EXIT
for rel in runtime/node tunnel/native-tunnel-launch.sh tunnel/tunnel-client tunnel/cloudflared; do
  sha256sum "$NATIVE/$rel" | sed "s|$NATIVE/|$TMP/|" >> "$TMP/pre-upgrade-sha256.txt"
done
sudo dpkg --install "$NEW"
test "$(dpkg-query -W -f='${Status}' chatgpt-remote-commander)" = 'install ok installed'
test "$(dpkg-query -W -f='${Version}' chatgpt-remote-commander)" = "$(dpkg-deb --field "$NEW" Version)"
for rel in runtime/node tunnel/native-tunnel-launch.sh tunnel/tunnel-client tunnel/cloudflared; do
  actual="$(sha256sum "$NATIVE/$rel" | cut -d' ' -f1)"
  expected="$(grep -F " $TMP/$rel" "$TMP/pre-upgrade-sha256.txt" | cut -d' ' -f1)"
  test "$actual" = "$expected"
done
test -f /usr/lib/systemd/user/chatgpt-remote-commander-tunnel@.service
test -x '/opt/Remote Commander/remote-commander-unified'
test "$(stat -c %u '/opt/Remote Commander/chrome-sandbox')" -eq 0
cd "$ROOT"
xvfb-run -a env RC_TEST_INSTALLED_GUI=1 node --test test/unified-electron-gui.test.mjs
sudo dpkg --install "$OLD"
test "$(dpkg-query -W -f='${Version}' chatgpt-remote-commander)" = "$(dpkg-deb --field "$OLD" Version)"
test -f "$NATIVE/tunnel/native-tunnel-launch.sh"
test ! -e '/opt/Remote Commander/remote-commander-unified'
echo 'RC012_NATIVE_UPGRADE_SANDBOX_GUI_AND_ROLLBACK_PASS'
