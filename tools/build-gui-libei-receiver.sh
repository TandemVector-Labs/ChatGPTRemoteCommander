#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE="$SCRIPT_DIR/../src/gui-libei-receiver.c"
DEFAULT_DIR="$HOME/.local/libexec/chatgpt-remote-commander"
OUTPUT="$DEFAULT_DIR/gui-libei-receiver"
if [[ "${1:-}" == "--output" ]]; then
  [[ $# -eq 2 && "$2" = /* ]] || { echo "usage: $0 [--output /absolute/path]" >&2; exit 64; }
  OUTPUT="$2"
elif [[ $# -ne 0 ]]; then
  echo "usage: $0 [--output /absolute/path]" >&2
  exit 64
fi

[[ -f "$SOURCE" && ! -L "$SOURCE" ]] || { echo "GUI_LIBEI_SOURCE_INVALID" >&2; exit 65; }
command -v cc >/dev/null 2>&1 || { echo "GUI_LIBEI_COMPILER_UNAVAILABLE" >&2; exit 69; }
command -v pkg-config >/dev/null 2>&1 || { echo "GUI_LIBEI_PKG_CONFIG_UNAVAILABLE" >&2; exit 69; }
pkg-config --exists libei-1.0 || { echo "GUI_LIBEI_DEVELOPMENT_PACKAGE_UNAVAILABLE" >&2; exit 69; }

OUT_DIR="$(dirname -- "$OUTPUT")"
mkdir -p -- "$OUT_DIR"
[[ -d "$OUT_DIR" && ! -L "$OUT_DIR" ]] || { echo "GUI_LIBEI_OUTPUT_DIRECTORY_INVALID" >&2; exit 65; }
[[ "$(stat -c '%u' -- "$OUT_DIR")" == "$(id -u)" ]] || { echo "GUI_LIBEI_OUTPUT_NOT_OWNER_CONTROLLED" >&2; exit 77; }
chmod 700 -- "$OUT_DIR"
if [[ -e "$OUTPUT" || -L "$OUTPUT" ]]; then
  [[ -f "$OUTPUT" && ! -L "$OUTPUT" ]] || { echo "GUI_LIBEI_EXISTING_OUTPUT_INVALID" >&2; exit 65; }
  [[ "$(stat -c '%u:%h' -- "$OUTPUT")" == "$(id -u):1" ]] || {
    echo "GUI_LIBEI_EXISTING_OUTPUT_NOT_OWNER_CONTROLLED" >&2; exit 77;
  }
fi

TMP="$(mktemp "$OUT_DIR/.gui-libei-receiver.XXXXXXXX")"
cleanup() { rm -f -- "$TMP"; }
trap cleanup EXIT HUP INT TERM

cc -std=c11 -O2 -Wall -Wextra -Werror -Wconversion -Wshadow -D_FORTIFY_SOURCE=2 \
  $(pkg-config --cflags libei-1.0) "$SOURCE" -o "$TMP" \
  $(pkg-config --libs libei-1.0)
chmod 700 -- "$TMP"
"$TMP" --help >/dev/null
mv -f -- "$TMP" "$OUTPUT"
trap - EXIT HUP INT TERM
printf 'GUI_LIBEI_RECEIVER_BUILD_PASS path=%s sha256=%s\n' "$OUTPUT" "$(sha256sum "$OUTPUT" | awk '{print $1}')"
