#!/usr/bin/env bash
# Build a single, self-extracting Linux bootstrap launcher from source.
# This is not an offline/full-product bundle: prerequisites still use distro package managers.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
if [[ $# -gt 0 ]]; then OUT="$1"; else OUT="$ROOT/dist/installer/Remote-Commander-Linux-Setup.run"; fi
command -v node >/dev/null || { echo 'Node is required on the BUILD host.' >&2; exit 2; }
for tool in tar gzip sha256sum mktemp sed; do
  command -v "$tool" >/dev/null || { echo "Missing build tool: $tool" >&2; exit 2; }
done
VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9._-]+)?$ ]] || { echo 'Invalid source version' >&2; exit 2; }
# The published launcher must fetch the exact source tree it was built from.
# PR builds may produce QA archives; only matching release tags can install.
SOURCE_COMMIT="$(git -C "$ROOT" rev-parse 'HEAD^{commit}')"
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo 'Missing exact build source commit' >&2; exit 2; }
STAGE="$(mktemp -d)"
trap 'rm -rf -- "$STAGE"' EXIT
mkdir -p "$STAGE/payload/installer" "$STAGE/payload/tools"
for file in install.sh setup-wizard.sh; do
  test -f "$ROOT/$file" || { echo "Missing source $file" >&2; exit 2; }
  cp "$ROOT/$file" "$STAGE/payload/$file"
done
cp "$ROOT/installer/products.json" "$STAGE/payload/installer/products.json"
cp "$ROOT/tools/install-browser-linux.sh" "$STAGE/payload/tools/install-browser-linux.sh"
cat > "$STAGE/payload/SETUP.sh" <<'LAUNCH'
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
# These build-time pins override ambient environment defaults and prevent
# a new single-file installer from silently installing an older Core.
export REMOTE_COMMANDER_SOURCE_REF='__RC_BUILD_SOURCE_REF__'
export REMOTE_COMMANDER_EXPECTED_COMMIT='__RC_BUILD_SOURCE_COMMIT__'
exec /bin/bash "$HERE/setup-wizard.sh" "$@"
LAUNCH
sed -i -e "s/__RC_BUILD_SOURCE_REF__/v$VERSION/" \
       -e "s/__RC_BUILD_SOURCE_COMMIT__/$SOURCE_COMMIT/" "$STAGE/payload/SETUP.sh"
cat > "$STAGE/payload/README.txt" <<'DOC'
Remote Commander Linux single-file bootstrap (online)
Run: bash Remote-Commander-Linux-Setup.run --list-products
     bash Remote-Commander-Linux-Setup.run --plan-only --all
     bash Remote-Commander-Linux-Setup.run --all
Selected supported product installation uses online distro/Node/tunnel-client sources.
This bundle includes a checksum-pinned ONLINE installer for Browser v0.8.1.
Browser requires X11, Linux x86_64 and interactive sudo to configure Chromium sandbox.
The GTK Control Center preview and experimental companion are not qualified.
Runtime API keys and tunnel IDs must be enrolled after installation, not baked into the file.
DOC
chmod 700 "$STAGE/payload/SETUP.sh" "$STAGE/payload/install.sh" "$STAGE/payload/setup-wizard.sh" "$STAGE/payload/tools/install-browser-linux.sh"
tar -czf "$STAGE/payload.tar.gz" -C "$STAGE/payload" .
HASH="$(sha256sum "$STAGE/payload.tar.gz" | cut -d' ' -f1)"
cat > "$STAGE/header" <<'HEADER'
#!/usr/bin/env bash
set -euo pipefail
# A self-extracting script that preserves the user's per-account install context.
# The embedded digest detects payload corruption, not publisher authenticity.
for tool in tar sha256sum mktemp grep tail; do
  command -v "$tool" >/dev/null || { echo "LINUX_BOOTSTRAP_MISSING_TOOL $tool" >&2; exit 2; }
done
umask 077
TEMP="$(mktemp -d)"
trap 'rm -rf -- "$TEMP"' EXIT
MARKER="$(grep -anm1 '^__RC_PRODUCT_PAYLOAD_BEGIN__$' "$0" | cut -d: -f1)"
[[ "$MARKER" =~ ^[0-9]+$ ]] || { echo 'LINUX_PAYLOAD_MARKER_MISSING' >&2; exit 3; }
tail -n "+$((MARKER + 1))" "$0" > "$TEMP/payload.tar.gz"
ACTUAL="$(sha256sum "$TEMP/payload.tar.gz" | cut -d' ' -f1)"
[[ "$ACTUAL" == "__PRODUCT_PAYLOAD_SHA256__" ]] || { echo 'LINUX_PAYLOAD_SHA256_MISMATCH' >&2; exit 3; }
tar -xzf "$TEMP/payload.tar.gz" -C "$TEMP"
[[ -f "$TEMP/SETUP.sh" && -f "$TEMP/installer/products.json" ]] || { echo 'LINUX_PAYLOAD_INCOMPLETE' >&2; exit 3; }
/bin/bash "$TEMP/SETUP.sh" "$@"
exit $?
__RC_PRODUCT_PAYLOAD_BEGIN__
HEADER
sed "s/__PRODUCT_PAYLOAD_SHA256__/$HASH/" "$STAGE/header" > "$STAGE/launcher"
mkdir -p "$(dirname "$OUT")"
cat "$STAGE/launcher" "$STAGE/payload.tar.gz" > "$OUT"
chmod 755 "$OUT"
printf 'LINUX_SINGLE_FILE_BUILD_PASS version=%s output=%s sha256=%s payloadSha256=%s\n' "$VERSION" "$OUT" "$(sha256sum "$OUT"|cut -d' ' -f1)" "$HASH"
