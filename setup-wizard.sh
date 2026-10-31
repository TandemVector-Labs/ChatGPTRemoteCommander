#!/usr/bin/env bash
set -euo pipefail
MODE="standard"
MODE_SET=0
GUI=0
SKIP_PREREQS=0
SKIP_INSTALL=0
SKIP_CONNECT=0
SKIP_PLUGIN=0
PRODUCT_ALL=0
PRODUCT_LIST=0
PRODUCT_PLAN_ONLY=0
PRODUCT_REQUESTS=()
PRODUCT_SELECTION_EXPLICIT=0
BROWSER_SELECTED=0
BROWSER_EXPLICIT_ALL=0
TUNNEL_ID=""
APP_ID=""
PROFILE="chatgpt-remote-commander"
DEVICE_NAME="${HOSTNAME:-$(hostname 2>/dev/null || echo device)}"
PLUGIN_OUTPUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --power-mode) MODE="power"; MODE_SET=1; shift ;;
    --standard-mode) MODE="standard"; MODE_SET=1; shift ;;
    --gui-control) GUI=1; shift ;;
    --skip-prerequisites) SKIP_PREREQS=1; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    --skip-connect) SKIP_CONNECT=1; shift ;;
    --skip-plugin) SKIP_PLUGIN=1; shift ;;
    --all) PRODUCT_ALL=1; BROWSER_EXPLICIT_ALL=1; PRODUCT_SELECTION_EXPLICIT=1; shift ;;
    --product) [[ $# -ge 2 ]] || { echo '--product requires an id' >&2; exit 2; }; PRODUCT_REQUESTS+=("$2"); PRODUCT_SELECTION_EXPLICIT=1; shift 2 ;;
    --list-products) PRODUCT_LIST=1; shift ;;
    --plan-only) PRODUCT_PLAN_ONLY=1; shift ;;
    --tunnel-id) TUNNEL_ID="$2"; shift 2 ;;
    --app-id) APP_ID="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --device-name) DEVICE_NAME="$2"; shift 2 ;;
    --plugin-output-directory) PLUGIN_OUTPUT="$2"; shift 2 ;;
    -h|--help)
      cat <<'EOF'
Usage: setup-wizard.sh [--standard-mode|--power-mode] [--gui-control]
  [--list-products] [--all | --product ID...] [--plan-only]
  [--skip-prerequisites] [--skip-install] [--skip-connect] [--skip-plugin]
  [--tunnel-id ID] [--app-id ID] [--profile NAME] [--device-name NAME]
  [--plugin-output-directory DIR]
EOF
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
# Product selection runs before any installer, network access or state mutation.
# This table must match installer/products.json; unavailable components always fail closed.
list_products(){
  cat <<'PRODUCTS'
core              available          Remote Commander Core (required)
control-center    unavailable        Native GTK Control Center is a read-only preview; no qualified installer
browser           conditional        Browser v0.8.1 (online 367 MB, Linux x86_64 X11 and sudo required)
work-plugin       pending-activation ChatGPT Work Plugin setup; needs App ID after enrollment
companion         unavailable        Private experimental companions are not public installer products
PRODUCTS
}
if [[ "$PRODUCT_LIST" -eq 1 ]]; then
  list_products
  exit 0
fi
if [[ "$PRODUCT_ALL" -eq 1 && "${#PRODUCT_REQUESTS[@]}" -gt 0 ]]; then
  echo '--all conflicts with --product' >&2; exit 2
fi
if [[ "$PRODUCT_SELECTION_EXPLICIT" -eq 0 && ( -n "${DISPLAY:-}" || -n "${WAYLAND_DISPLAY:-}" ) ]] && command -v zenity >/dev/null 2>&1; then
  # Core is mandatory. Browser requires opt-in and a verified, sudo-configured X11 runtime.
  # GUI cancel must fail closed before any installer/prerequisite or credential action.
  if gui_choice="$(zenity --list --checklist \
      --title='Remote Commander — Select products' \
      --text='Remote Commander Core is required. Choose optional setup steps (not a promise of ChatGPT App activation).' \
      --column='Include' --column='Product' --column='Details' \
      TRUE 'work-plugin' 'ChatGPT Work Plugin — activation requires registered App ID' \
      FALSE 'browser' 'Browser v0.8.1 — 367 MB online, X11, sudo sandbox' \
      --separator='|' --width=690 --height=270)"; then
    # Zenity returns a delimited string. Accept exact choices only.
    case "$gui_choice" in
      '') PRODUCT_REQUESTS=(core) ;;
      'work-plugin') PRODUCT_REQUESTS=(core work-plugin) ;;
      'browser') PRODUCT_REQUESTS=(core browser) ;;
      'work-plugin|browser'|'browser|work-plugin') PRODUCT_REQUESTS=(core work-plugin browser) ;;
      *) echo 'INVALID_GUI_PRODUCT_SELECTION' >&2; exit 2 ;;
    esac
  else
    echo 'GUI_PRODUCT_SELECTION_CANCELLED' >&2
    exit 2
  fi
elif [[ "$PRODUCT_SELECTION_EXPLICIT" -eq 0 && -t 0 ]]; then
  echo 'Select products available in the Linux public installer:'
  echo '  1) Core only'
  echo '  2) Core + ChatGPT Work Plugin setup (activation requires App ID)'
  echo '  3) List all products and availability'
  read -r -p 'Selection [2]: ' product_choice
  case "${product_choice:-2}" in
    1) PRODUCT_REQUESTS=(core) ;;
    2) PRODUCT_ALL=1 ;;
    3) list_products; exit 0 ;;
    *) echo 'INVALID_PRODUCT_SELECTION' >&2; exit 2 ;;
  esac
elif [[ "$PRODUCT_SELECTION_EXPLICIT" -eq 0 ]]; then
  # A desktop launch without any selectable UI must not silently install software.
  if [[ -n "${DISPLAY:-}" || -n "${WAYLAND_DISPLAY:-}" ]]; then
    echo 'GUI_PRODUCT_CHOOSER_UNAVAILABLE: install zenity or run with --all / --product core' >&2
    exit 2
  fi
  # Preserve existing headless / automation onboarding defaults and --skip-plugin.
  if [[ "$SKIP_PLUGIN" -eq 1 ]]; then PRODUCT_REQUESTS=(core)
  else PRODUCT_ALL=1
  fi
fi
if [[ "$PRODUCT_ALL" -eq 1 ]]; then
  PRODUCT_REQUESTS=(core work-plugin)
  # Only an explicit --all on an X11 desktop adds the separately hosted Browser.
  # Legacy headless automation must never trigger a 367 MB download and sudo.
  if [[ "$BROWSER_EXPLICIT_ALL" -eq 1 && -n "${DISPLAY:-}" ]]; then
    PRODUCT_REQUESTS+=(browser)
  fi
fi
WIZARD_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SELECTED_PLUGIN=0
SEEN_CORE=0
for product in "${PRODUCT_REQUESTS[@]}"; do
  case "$product" in
    core) [[ "$SEEN_CORE" -eq 0 ]] || { echo 'DUPLICATE_PRODUCT_SELECTION core' >&2; exit 2; }; SEEN_CORE=1 ;;
    work-plugin) [[ "$SELECTED_PLUGIN" -eq 0 ]] || { echo 'DUPLICATE_PRODUCT_SELECTION work-plugin' >&2; exit 2; }; SELECTED_PLUGIN=1 ;;
    browser)
      [[ "$BROWSER_SELECTED" -eq 0 ]] || { echo 'DUPLICATE_PRODUCT_SELECTION browser' >&2; exit 2; }
      [[ -f "$WIZARD_SCRIPT_DIR/tools/install-browser-linux.sh" ]] ||
        { echo 'PRODUCT_NOT_BUNDLED browser installer component missing' >&2; exit 2; }
      BROWSER_SELECTED=1 ;;
    control-center|companion)
      echo "PRODUCT_UNAVAILABLE $product: not a qualified standalone Linux installer artifact" >&2; exit 2 ;;
    *) echo "UNKNOWN_PRODUCT $product" >&2; exit 2 ;;
  esac
done
if [[ "$SELECTED_PLUGIN" -eq 1 && "$SKIP_PLUGIN" -eq 1 ]]; then
  echo 'PRODUCT_SELECTION_CONFLICT work-plugin and --skip-plugin' >&2; exit 2
fi
if [[ "$SELECTED_PLUGIN" -eq 0 ]]; then SKIP_PLUGIN=1; fi
SELECTED_PRODUCTS='core'
if [[ "$SELECTED_PLUGIN" -eq 1 ]]; then SELECTED_PRODUCTS='core,work-plugin'; fi
if [[ "$BROWSER_SELECTED" -eq 1 ]]; then SELECTED_PRODUCTS="$SELECTED_PRODUCTS,browser"; fi
if [[ "$PRODUCT_PLAN_ONLY" -eq 1 ]]; then
  echo "INSTALL_PLAN platform=linux selected=$SELECTED_PRODUCTS changesApplied=false"
  if [[ "$SELECTED_PLUGIN" -eq 1 ]]; then echo 'WORK_PLUGIN_PENDING_APP_ID'; fi
  if [[ "$BROWSER_SELECTED" -eq 1 ]]; then
    echo 'BROWSER_REQUIRES_LINUX_X86_64_X11_INTERACTIVE_SUDO_ONLINE_367MB'
  fi
  exit 0
fi
# Selected Browser runtime requires a supported local X11 host. Check before
# Core prerequisites, any downloads, state writes or credential enrollment.
if [[ "$BROWSER_SELECTED" -eq 1 ]]; then
  [[ "$(uname -m)" == x86_64 ]] ||
    { echo 'BROWSER_LINUX_UNSUPPORTED_ARCH' >&2; exit 2; }
  [[ -n "${DISPLAY:-}" ]] ||
    { echo 'BROWSER_LINUX_X11_REQUIRED' >&2; exit 2; }
  for tool in curl tar sha256sum sudo stat; do
    command -v "$tool" >/dev/null 2>&1 ||
      { echo "BROWSER_MISSING_PREREQUISITE $tool" >&2; exit 2; }
  done
  [[ ! -e "$HOME/.local/share/chatgpt-cef-v2/runtime-v0.8.1" &&
     ! -L "$HOME/.local/share/chatgpt-cef-v2/runtime-v0.8.1" &&
     ! -e "$HOME/.local/bin/chatgpt-cef-v2" &&
     ! -L "$HOME/.local/bin/chatgpt-cef-v2" ]] ||
    { echo 'BROWSER_EXISTING_RUNTIME_PRESERVED: separately verify repair' >&2; exit 2; }
fi

if [[ "$MODE_SET" -eq 0 && -t 0 ]]; then
  echo 'Choose installation mode:'
  echo '  1) Standard — restricted project/file access'
  echo '  2) Full / Power — trusted-machine shell/filesystem/process access'
  echo '  3) Full / Power + GUI — also enable guarded desktop control'
  read -r -p 'Mode [1]: ' choice
  case "${choice:-1}" in
    2) MODE="power" ;;
    3) MODE="power"; GUI=1 ;;
    *) MODE="standard" ;;
  esac
fi
[[ "$GUI" -eq 0 || "$MODE" == "power" ]] || { echo '--gui-control requires --power-mode' >&2; exit 2; }

STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/chatgpt-remote-commander"
INSTALL_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/ChatGPTRemoteCommander"
WIZARD_STATE="$STATE_ROOT/onboarding"
mkdir -p "$WIZARD_STATE"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P || pwd)"
TMP=""

cleanup(){ [[ -z "$TMP" ]] || rm -rf "$TMP"; }
trap cleanup EXIT

resolve_installer(){
  if [[ -f "$SCRIPT_DIR/install.sh" ]]; then printf '%s\n' "$SCRIPT_DIR/install.sh"; return; fi
  TMP="$(mktemp -d)"
  local base='https://github.com/GOD13emad/ChatGPTRemoteCommander/releases/latest/download'
  command -v curl >/dev/null 2>&1 || { echo 'curl is required' >&2; exit 1; }
  curl -fsSL --connect-timeout 15 --max-time 180 "$base/install.sh" -o "$TMP/install.sh"
  curl -fsSL --connect-timeout 15 --max-time 180 "$base/SHA256SUMS.txt" -o "$TMP/SHA256SUMS.txt"
  local expected actual
  expected="$(awk '$2=="install.sh"{print $1;exit}' "$TMP/SHA256SUMS.txt")"
  [[ -n "$expected" ]] || { echo 'Latest checksum manifest does not list install.sh.' >&2; exit 1; }
  actual="$(sha256sum "$TMP/install.sh" | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || { echo 'Downloaded install.sh checksum mismatch.' >&2; exit 1; }
  chmod +x "$TMP/install.sh"
  printf '%s\n' "$TMP/install.sh"
}

echo "Remote Commander setup wizard — device=$DEVICE_NAME profile=$PROFILE mode=$MODE"
if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  INSTALLER="$(resolve_installer)"
  args=(--start-server)
  [[ "$SKIP_PREREQS" -eq 1 ]] || args+=(--install-prerequisites)
  [[ "$MODE" == "power" ]] && args+=(--power-mode)
  "$INSTALLER" "${args[@]}"
fi
[[ -f "$INSTALL_ROOT/package.json" ]] || { echo "Installed Remote Commander not found at $INSTALL_ROOT" >&2; exit 1; }

HEALTH="$(curl -fsS --max-time 4 http://127.0.0.1:47831/health)"
HEALTH="$HEALTH" node --input-type=module <<'NODE'
const j=JSON.parse(process.env.HEALTH); if(!j.ok) process.exit(2);
NODE

if [[ "$BROWSER_SELECTED" -eq 1 ]]; then
  echo 'Installing selected checksum-pinned Browser separately (interactive sudo, X11 required)...'
  bash "$WIZARD_SCRIPT_DIR/tools/install-browser-linux.sh" --install
fi

if [[ "$SKIP_CONNECT" -eq 0 ]]; then
  connect="$INSTALL_ROOT/enable-autostart-linux.sh"
  [[ -x "$connect" || -f "$connect" ]] || { echo 'Installed enable-autostart-linux.sh is missing.' >&2; exit 1; }
  echo
  echo 'Tunnel enrollment follows. Runtime API key entry stays in the local hidden prompt and is never written into the Plugin ZIP.'
  args=(--profile "$PROFILE")
  [[ -z "$TUNNEL_ID" ]] || args+=(--tunnel-id "$TUNNEL_ID")
  bash "$connect" "${args[@]}"
fi

PROFILE_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/tunnel-client/$PROFILE.yaml"
HEALTH_PORT=0
if [[ -f "$PROFILE_FILE" ]]; then
  HEALTH_PORT="$(sed -nE 's/.*listen_addr:[[:space:]]*"?127\.0\.0\.1:([0-9]+).*/\1/p' "$PROFILE_FILE" | head -n1)"
  HEALTH_PORT="${HEALTH_PORT:-0}"
fi
TUNNEL_READY=false
if [[ "$HEALTH_PORT" -gt 0 ]] && [[ "$(curl -fsS --max-time 3 "http://127.0.0.1:$HEALTH_PORT/readyz" 2>/dev/null || true)" == "ready" ]]; then
  TUNNEL_READY=true
fi

PLUGIN_STATUS="SKIPPED"
PLUGIN_JSON=""
if [[ "$SKIP_PLUGIN" -eq 0 ]]; then
  echo
  echo "Suggested ChatGPT custom app name: Remote Commander · $DEVICE_NAME"
  echo 'Create/verify the custom app with Connection=Tunnel, run Scan Tools, then use its exact App ID.'
  if [[ -z "$APP_ID" && -t 0 ]]; then
    read -r -p 'Paste the registered App ID (asdk_app_/connector_/templated_apps_ or plugin_ technical id), or press Enter to finish later: ' APP_ID
  fi
  if [[ -n "$APP_ID" ]]; then
    builder="$INSTALL_ROOT/build-device-plugin.sh"
    [[ -f "$builder" ]] || { echo 'Installed build-device-plugin.sh is missing; update Remote Commander.' >&2; exit 1; }
    args=(--app-id "$APP_ID" --device-name "$DEVICE_NAME" --profile "$PROFILE")
    [[ -z "$PLUGIN_OUTPUT" ]] || args+=(--output-directory "$PLUGIN_OUTPUT")
    PLUGIN_JSON="$(bash "$builder" "${args[@]}" | tee /dev/stderr | awk '/^\{/{line=$0} END{print line}')"
    PLUGIN_STATUS="READY"
  else
    PLUGIN_STATUS="WAITING_APP_ID"
  fi
fi

VERSION="$(HEALTH="$HEALTH" node --input-type=module <<'NODE'
const j=JSON.parse(process.env.HEALTH); process.stdout.write(String(j.version||''));
NODE
)"
SELECTED_PRODUCTS="$SELECTED_PRODUCTS" PLUGIN_STATUS="$PLUGIN_STATUS" PLUGIN_JSON="$PLUGIN_JSON" VERSION="$VERSION" DEVICE_NAME="$DEVICE_NAME" PROFILE="$PROFILE" MODE="$MODE" TUNNEL_READY="$TUNNEL_READY" node --input-type=module - "$WIZARD_STATE/latest.json" <<'NODE'
import fs from 'node:fs';
const plugin=process.env.PLUGIN_JSON ? JSON.parse(process.env.PLUGIN_JSON) : null;
const state={
  schema:1,
  completedAt:new Date().toISOString(),
  platform:'linux',
  deviceName:process.env.DEVICE_NAME,
  profile:process.env.PROFILE,
  mode:process.env.MODE==='power'?'FULL_POWER':'STANDARD',
  version:process.env.VERSION,
  mcpHealthy:true,
  tunnelReady:process.env.TUNNEL_READY==='true',
  pluginStatus:process.env.PLUGIN_STATUS,
  selectedProducts:process.env.SELECTED_PRODUCTS.split(','),
  pendingProducts:process.env.PLUGIN_STATUS==='WAITING_APP_ID'?['work-plugin']:[],
  pluginName:plugin?.pluginName??null,
  pluginZip:plugin?.zip??null,
  pluginSha256:plugin?.zipSha256??null,
  secretsPersistedInWizardState:false,
  rebootPerformed:false
};
fs.writeFileSync(process.argv[2],JSON.stringify(state,null,2)+'\n');
NODE

echo
echo "SETUP_MACHINE_PASS version=$VERSION mcp=true tunnel=$TUNNEL_READY mode=${MODE^^}"
if [[ "$PLUGIN_STATUS" == "READY" ]]; then
  echo 'SETUP_FINAL_PASS plugin ZIP generated.'
elif [[ "$PLUGIN_STATUS" == "WAITING_APP_ID" ]]; then
  echo 'SETUP_WAITING_APP_ID machine/tunnel are ready. After ChatGPT creates/scans the custom app, rerun with --skip-install --skip-connect --app-id "<APP_ID>".'
fi
