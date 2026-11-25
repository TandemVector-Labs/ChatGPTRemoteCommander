#!/usr/bin/env bash
set -euo pipefail
APP_ID=""
DEVICE_NAME="${HOSTNAME:-$(hostname 2>/dev/null || echo device)}"
PROFILE="chatgpt-remote-commander"
IDENTITY_MAP=""
HOST_ID=""
ACCOUNT_ID=""
DEVICE_NAME_EXPLICIT=0
OUTPUT_DIR=""
KEEP_DIR=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-id) APP_ID="$2"; shift 2 ;;
    --device-name) DEVICE_NAME="$2"; DEVICE_NAME_EXPLICIT=1; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --identity-map) IDENTITY_MAP="$2"; shift 2 ;;
    --host-id) HOST_ID="$2"; shift 2 ;;
    --account-id) ACCOUNT_ID="$2"; shift 2 ;;
    --output-directory) OUTPUT_DIR="$2"; shift 2 ;;
    --keep-directory) KEEP_DIR=1; shift ;;
    -h|--help)
      echo "Usage: $0 --app-id ID [--device-name NAME] [--profile NAME] [--identity-map FILE --host-id ID --account-id ID] [--output-directory DIR] [--keep-directory]"
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$APP_ID" ]] || { echo '--app-id is required' >&2; exit 2; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
GENERATOR="$ROOT/tools/generate-device-plugin.mjs"
TEMPLATE="$ROOT/plugin-template"
[[ -f "$GENERATOR" && -f "$TEMPLATE/plugin.json" ]] || { echo 'Remote Commander plugin generator/template missing; update installation.' >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo 'node is required' >&2; exit 1; }

if [[ -z "$OUTPUT_DIR" ]]; then
  if [[ -d "$HOME/Downloads" ]]; then OUTPUT_DIR="$HOME/Downloads/RemoteCommander-Plugins"; else OUTPUT_DIR="$HOME/RemoteCommander-Plugins"; fi
fi
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd -P)"
MACHINE_ID=""
[[ -r /etc/machine-id ]] && MACHINE_ID="$(tr -d '\r\n' </etc/machine-id)"
[[ -n "$MACHINE_ID" ]] || MACHINE_ID="$(hostname 2>/dev/null || echo unknown)-$(uname -m 2>/dev/null || echo arch)"
FINGERPRINT_SEED="$PROFILE"
[[ -z "$IDENTITY_MAP" ]] || FINGERPRINT_SEED="$ACCOUNT_ID"
FINGERPRINT="$(printf '%s\0%s' "$MACHINE_ID" "$FINGERPRINT_SEED" | sha256sum | awk '{print substr($1,1,10)}')"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
STAGE="$TMP/plugin"
PREZIP="$TMP/device-plugin.zip"
set -- --template "$TEMPLATE" --output "$STAGE" --zip "$PREZIP" --app-id "$APP_ID" --profile "$PROFILE" --fingerprint "$FINGERPRINT"
if [[ -n "$IDENTITY_MAP" || -n "$HOST_ID" || -n "$ACCOUNT_ID" ]]; then
  [[ -n "$IDENTITY_MAP" && -n "$HOST_ID" && -n "$ACCOUNT_ID" ]] || {
    echo 'identity-map, host-id and account-id are required together' >&2; exit 2;
  }
  set -- "$@" --identity-map "$IDENTITY_MAP" --host-id "$HOST_ID" --account-id "$ACCOUNT_ID"
  [[ "$DEVICE_NAME_EXPLICIT" == 0 ]] || set -- "$@" --device-name "$DEVICE_NAME"
else
  set -- "$@" --device-name "$DEVICE_NAME"
fi
JSON="$(node "$GENERATOR" "$@")"
PLUGIN_NAME="$(PLUGIN_JSON="$JSON" node --input-type=module <<'NODE'
const j=JSON.parse(process.env.PLUGIN_JSON);
if(!j.ok || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(j.pluginName)) process.exit(2);
process.stdout.write(j.pluginName);
NODE
)"
EXPECTED_SHA="$(PLUGIN_JSON="$JSON" node --input-type=module <<'NODE'
const j=JSON.parse(process.env.PLUGIN_JSON); process.stdout.write(j.zipSha256);
NODE
)"
ZIP="$OUTPUT_DIR/$PLUGIN_NAME.zip"
cp -f "$PREZIP" "$ZIP"
ACTUAL_SHA="$(sha256sum "$ZIP" | awk '{print $1}')"
[[ "$ACTUAL_SHA" == "$EXPECTED_SHA" ]] || { echo 'generated ZIP hash changed during copy' >&2; exit 1; }

node --input-type=module - "$ZIP" <<'NODE'
import fs from 'node:fs';
const b=fs.readFileSync(process.argv[2]);
const names=['plugin.json','.app.json','.codex-plugin/plugin.json','assets/icon.png','assets/logo.png','skills/remote-commander/SKILL.md','DEVICE_PLUGIN.json'];
for(const n of names){if(!b.includes(Buffer.from(n))) throw new Error('generated plugin ZIP missing '+n);}
NODE

if [[ "$KEEP_DIR" -eq 1 ]]; then
  rm -rf "$OUTPUT_DIR/$PLUGIN_NAME"
  cp -a "$STAGE" "$OUTPUT_DIR/$PLUGIN_NAME"
fi
echo "$JSON"
echo "DEVICE_PLUGIN_ZIP_PASS path=$ZIP sha256=$ACTUAL_SHA name=$PLUGIN_NAME"
