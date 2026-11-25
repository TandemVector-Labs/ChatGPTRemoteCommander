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
SOURCE_REF="v$VERSION"
QA_ONLY=0
if [[ "$VERSION" =~ ^0\.12\.0-(dev|rc)\.[1-9][0-9]*$ ]]; then
  # A development package has no immutable release tag. Reference the
  # trusted integration branch and compare the exact source SHA separately.
  # This is a read-only QA provenance path, NOT an installation exception.
  node - "$ROOT/docs/release-train-0.12.json" "$VERSION" <<'NODE'
const fs=require('node:fs');
const manifest=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(manifest.sourceVersion!==process.argv[3]||
   manifest.status!=='INTEGRATION_CANDIDATE_NOT_FINAL'||
   manifest.channel!=='development'||manifest.isStable!==false||
   manifest.publishApproved!==false||
   manifest.autoupdateApproved!==false||
   manifest.installedPromotionApproved!==false||
   manifest.releaseTag!==null) {
  console.error('V012_QA_NO_PROMOTE_MANIFEST_REQUIRED');
  process.exit(2);
}
NODE
  SOURCE_REF='integration/v012-unsigned-approval-20261110'
  QA_ONLY=1
fi
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
# Development QA may inspect available products and the exact source pointer.
# It may never install into an owner account or replace a live Core.
if [[ '__RC_BUILD_QA_ONLY__' == 1 ]]; then
  if [[ "$#" == 1 && "$1" == '--verify-source' ]]; then
    command -v git >/dev/null || { echo 'V012_QA_SOURCE_GIT_REQUIRED' >&2; exit 4; }
    command -v timeout >/dev/null || { echo 'V012_QA_SOURCE_TIMEOUT_REQUIRED' >&2; exit 4; }
    ref="refs/heads/$REMOTE_COMMANDER_SOURCE_REF"
    resolved="$(GIT_TERMINAL_PROMPT=0 timeout 20s git ls-remote --exit-code --heads \
      https://github.com/GOD13emad/ChatGPTRemoteCommander.git "$ref" 2>/dev/null \
      | awk -v exact="$ref" '$2 == exact {print $1}')" || {
      echo 'V012_QA_SOURCE_UNREACHABLE' >&2; exit 4;
    }
    [[ "$resolved" =~ ^[0-9a-f]{40}$ && "$resolved" == "$REMOTE_COMMANDER_EXPECTED_COMMIT" ]] || {
      echo 'V012_QA_SOURCE_REF_MOVED_OR_MISMATCH' >&2; exit 4;
    }
    printf 'V012_QA_EXACT_SOURCE_REACHABLE commit=%s changesApplied=false\n' "$resolved"
    exit 0
  fi
  for arg in "$@"; do
    case "$arg" in
      --plan-only|--list-products|--help|-h)
        exec /bin/bash "$HERE/setup-wizard.sh" "$@"
        ;;
    esac
  done
  echo 'V012_DEV_QA_INSTALL_NOT_APPROVED' >&2
  exit 3
fi
exec /bin/bash "$HERE/setup-wizard.sh" "$@"
LAUNCH
sed -i -e "s|__RC_BUILD_SOURCE_REF__|$SOURCE_REF|" \
       -e "s|__RC_BUILD_SOURCE_COMMIT__|$SOURCE_COMMIT|" \
       -e "s|__RC_BUILD_QA_ONLY__|$QA_ONLY|" "$STAGE/payload/SETUP.sh"
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
if [[ "$QA_ONLY" == 1 ]]; then
  # The QA .run is never a live installer while Release Train is NoPromote.
  sed -i '/^     bash Remote-Commander-Linux-Setup.run --all$/d' "$STAGE/payload/README.txt"
  cat >> "$STAGE/payload/README.txt" <<'QADOC'
Development QA, NoPromote: only --list-products, --plan-only and --verify-source.
--verify-source checks the exact pinned integration Git commit without installs.
This file cannot install or replace an active Core; no v0.12-dev release tag
is created and native owner/ChatGPT G1+J01 admission remains mandatory.
QADOC
fi
chmod 700 "$STAGE/payload/SETUP.sh" "$STAGE/payload/install.sh" "$STAGE/payload/setup-wizard.sh" "$STAGE/payload/tools/install-browser-linux.sh"
# Pin tar member metadata and order to the exact Git commit, not mktemp creation time.
# GNU tar is an explicit Linux builder prerequisite; gzip -n drops input names/times.
SOURCE_EPOCH="$(git -C "$ROOT" show -s --format=%ct HEAD)"
[[ "$SOURCE_EPOCH" =~ ^[0-9]+$ ]] || { echo 'Invalid source epoch' >&2; exit 2; }
tar --sort=name --mtime="@$SOURCE_EPOCH" --owner=0 --group=0 --numeric-owner \
  --format=gnu -cf - -C "$STAGE/payload" . | gzip -n > "$STAGE/payload.tar.gz"
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
