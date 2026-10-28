#!/usr/bin/env bash
# Opt-in pinned Linux Browser installation; never modify Core or user Browser profiles.
set -euo pipefail
umask 077
VERSION='0.8.1'
NAME="remote-commander-browser-v${VERSION}-linux-x86_64"
ARCHIVE="$NAME.tar.gz"
EXPECTED_SHA='8cac4150b844e48c5f6fbf90df84b306d49165bef77f716f5c61d20bad164073'
URL="https://github.com/TandemVector-Labs/remote-commander-browser/releases/download/v${VERSION}/${ARCHIVE}"
ACTION="${1:---plan-only}"
ARCHIVE_SOURCE=''
case "$#" in
  0|1) ;;
  3) [[ "$ACTION" == '--install' && "$2" == '--archive-file' && -n "$3" ]] ||
       { echo 'BROWSER_INSTALLER_USAGE --install --archive-file PATH' >&2; exit 2; }
     ARCHIVE_SOURCE="$3" ;;
  *) echo 'BROWSER_INSTALLER_USAGE --plan-only|--install [--archive-file PATH]' >&2; exit 2 ;;
esac
[[ "$ACTION" == '--plan-only' || "$ACTION" == '--install' ]] ||
  { echo 'BROWSER_INSTALLER_USAGE --plan-only|--install' >&2; exit 2; }
printf 'BROWSER_LINUX_PLAN version=%s arch=x86_64 desktop=X11 sudo=required sha256=%s action=%s\n' "$VERSION" "$EXPECTED_SHA" "$ACTION"
if [[ "$ACTION" == '--plan-only' ]]; then echo 'BROWSER_PLAN_ONLY changesApplied=false'; exit 0; fi
[[ "$(uname -m)" == x86_64 ]] || { echo 'BROWSER_LINUX_UNSUPPORTED_ARCH' >&2; exit 2; }
[[ -n "${DISPLAY:-}" ]] || { echo 'BROWSER_LINUX_X11_REQUIRED' >&2; exit 2; }
for tool in curl tar sha256sum sudo mktemp stat; do
  command -v "$tool" >/dev/null || { echo "BROWSER_MISSING_PREREQUISITE $tool" >&2; exit 2; }
done
TARGET="$HOME/.local/share/chatgpt-cef-v2/runtime-v${VERSION}"
LAUNCHER="$HOME/.local/bin/chatgpt-cef-v2"
[[ ! -e "$TARGET" && ! -L "$TARGET" ]] || { echo 'BROWSER_RUNTIME_ALREADY_PRESENT' >&2; exit 3; }
[[ ! -e "$LAUNCHER" && ! -L "$LAUNCHER" ]] || { echo 'BROWSER_LAUNCHER_ALREADY_PRESENT' >&2; exit 3; }
sudo -v || { echo 'BROWSER_SANDBOX_SUDO_NOT_AUTHORIZED' >&2; exit 3; }
WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
if [[ -n "$ARCHIVE_SOURCE" ]]; then
  [[ -f "$ARCHIVE_SOURCE" && ! -L "$ARCHIVE_SOURCE" ]] ||
    { echo 'BROWSER_LOCAL_ARCHIVE_UNAVAILABLE' >&2; exit 4; }
  cp -- "$ARCHIVE_SOURCE" "$WORK/$ARCHIVE"
else
  curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 \
    --connect-timeout 20 --max-time 2400 --output "$WORK/$ARCHIVE" "$URL"
fi
ACTUAL="$(sha256sum "$WORK/$ARCHIVE" | cut -d' ' -f1)"
[[ "$ACTUAL" == "$EXPECTED_SHA" ]] || { echo 'BROWSER_RELEASE_SHA256_MISMATCH' >&2; exit 4; }
while IFS= read -r member; do
  case "$member" in "$NAME"|"$NAME/"|"$NAME/"*) ;; *) echo 'BROWSER_ARCHIVE_UNEXPECTED_MEMBER' >&2; exit 4 ;; esac
  case "/$member/" in *"/../"*|*"/./"*) echo 'BROWSER_ARCHIVE_UNSAFE_PATH' >&2; exit 4 ;; esac
done < <(tar -tzf "$WORK/$ARCHIVE")
tar -xzf "$WORK/$ARCHIVE" -C "$WORK" --no-same-owner
PKG="$WORK/$NAME"
[[ -f "$PKG/SHA256SUMS.txt" && -f "$PKG/install.sh" && -f "$PKG/runtime/chrome-sandbox" ]] ||
  { echo 'BROWSER_RELEASE_PACKAGE_INCOMPLETE' >&2; exit 4; }
(cd "$PKG" && sha256sum -c SHA256SUMS.txt >/dev/null) ||
  { echo 'BROWSER_RELEASE_INTERNAL_HASH_FAILED' >&2; exit 4; }
# Vetted upstream installer configures Chromium SUID sandbox without --no-sandbox.
/bin/bash "$PKG/install.sh"
test -x "$LAUNCHER" || { echo 'BROWSER_POSTINSTALL_LAUNCHER_MISSING' >&2; exit 5; }
read -r mode owner group < <(stat -Lc '%a %U %G' "$TARGET/chrome-sandbox")
[[ "$mode" == 4755 && "$owner" == root && "$group" == root ]] ||
  { echo 'BROWSER_POSTINSTALL_SANDBOX_INVALID' >&2; exit 5; }
echo "BROWSER_LINUX_VERIFIED_INSTALL_PASS version=$VERSION profilePreserved=true"
