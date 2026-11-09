#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REMOTE_COMMANDER_REPO_URL:-https://github.com/GOD13emad/ChatGPTRemoteCommander.git}"
INSTALL_DIR="${HOME}/.local/share/ChatGPTRemoteCommander"
POWER_MODE=0
STANDARD_MODE=0
DISABLE_CAPS=()
ENABLE_CAPS=()
BROWSER_EXECUTABLE=""
BROWSER_PROFILE_ROOT=""
START_SERVER=0
INSTALL_PREREQS=0
SKIP_TUNNEL_CLIENT=0
SOURCE_REF="${REMOTE_COMMANDER_SOURCE_REF:-v0.10.24}"
EXPECTED_COMMIT="${REMOTE_COMMANDER_EXPECTED_COMMIT:-}"
CURL_CONNECT_TIMEOUT="${REMOTE_COMMANDER_CURL_CONNECT_TIMEOUT:-15}"
CURL_MAX_TIME="${REMOTE_COMMANDER_CURL_MAX_TIME:-180}"

usage() {
  cat <<'USAGE'
Usage: install.sh [options]
  --install-dir PATH        Install/update directory
  --install-prerequisites   Install basic OS packages and portable Node 22+ if needed
  --power-mode              Enable Full Power: all current/future capabilities unless explicitly disabled
  --standard-mode           Explicitly select Standard mode
  --disable-capability CAP  Explicit capability opt-out (repeatable)
  --enable-capability CAP   Explicit capability opt-in (repeatable)
  --start-server            Start MCP server with nohup after validation
  --skip-tunnel-client      Skip tunnel-client download; reuse existing pinned client when present
  --source-ref REF          Git ref to install (default: v0.10.24)
  --expected-commit SHA     Require the fetched ref to peel to this exact 40-hex commit
  -h, --help                Show help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --install-prerequisites) INSTALL_PREREQS=1; shift ;;
    --power-mode) POWER_MODE=1; shift ;;
    --standard-mode) STANDARD_MODE=1; shift ;;
    --disable-capability) DISABLE_CAPS+=("$2"); shift 2 ;;
    --enable-capability) ENABLE_CAPS+=("$2"); shift 2 ;;
    --start-server) START_SERVER=1; shift ;;
    --skip-tunnel-client) SKIP_TUNNEL_CLIENT=1; shift ;;
    --source-ref) SOURCE_REF="$2"; shift 2 ;;
    --expected-commit) EXPECTED_COMMIT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done
[[ "$POWER_MODE" == 0 || "$STANDARD_MODE" == 0 ]] || { echo "Use only one of --power-mode or --standard-mode" >&2; exit 2; }
[[ "$SOURCE_REF" =~ ^[A-Za-z0-9._/-]{1,128}$ ]] || { echo "Invalid --source-ref" >&2; exit 2; }
[[ -z "$EXPECTED_COMMIT" || "$EXPECTED_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]] || { echo "Invalid --expected-commit SHA" >&2; exit 2; }
[[ "$CURL_CONNECT_TIMEOUT" =~ ^[1-9][0-9]{0,3}$ ]] || { echo "REMOTE_COMMANDER_CURL_CONNECT_TIMEOUT must be a positive integer" >&2; exit 2; }
[[ "$CURL_MAX_TIME" =~ ^[1-9][0-9]{0,4}$ ]] || { echo "REMOTE_COMMANDER_CURL_MAX_TIME must be a positive integer" >&2; exit 2; }
need() { command -v "$1" >/dev/null 2>&1; }
curl_fetch() {
  curl --fail --silent --show-error --location \
    --connect-timeout "$CURL_CONNECT_TIMEOUT" \
    --max-time "$CURL_MAX_TIME" "$@"
}

install_os_packages() {
  [[ "$INSTALL_PREREQS" == "1" ]] || return 0
  local sudo_cmd=""
  if [[ "$(id -u)" != "0" ]]; then
    need sudo || { echo "sudo is required to install OS packages" >&2; exit 1; }
    sudo_cmd="sudo"
  fi
  if need apt-get; then
    $sudo_cmd apt-get update
    $sudo_cmd apt-get install -y git curl unzip tar xz-utils ca-certificates python3
  elif need dnf; then
    $sudo_cmd dnf install -y git curl unzip tar xz ca-certificates python3
  elif need yum; then
    $sudo_cmd yum install -y git curl unzip tar xz ca-certificates python3
  elif need zypper; then
    $sudo_cmd zypper --non-interactive refresh
    $sudo_cmd zypper --non-interactive install git curl unzip tar xz ca-certificates python3
  elif need pacman; then
    $sudo_cmd pacman -Sy --needed --noconfirm git curl unzip tar xz ca-certificates python
  else
    echo "Unsupported package manager. Install git curl unzip tar xz python3 manually." >&2
    exit 1
  fi
}

invoke_existing_safe_update() {
  local temp resolved updater
  temp="$(mktemp -d)"
  git -C "$temp" init >/dev/null
  git -C "$temp" remote add origin "$REPO_URL"
  git -C "$temp" fetch --depth 1 --no-tags origin "$SOURCE_REF"
  resolved="$(git -C "$temp" rev-parse 'FETCH_HEAD^{commit}')"
  [[ "$resolved" =~ ^[0-9a-f]{40}$ ]] || { rm -rf "$temp"; echo 'Updater fetched commit is invalid.' >&2; return 1; }
  if [[ -n "$EXPECTED_COMMIT" && "${resolved,,}" != "${EXPECTED_COMMIT,,}" ]]; then
    rm -rf "$temp"
    echo "Updater commit $resolved does not match expected commit $EXPECTED_COMMIT." >&2
    return 1
  fi
  git -C "$temp" checkout --detach "$resolved" >/dev/null
  updater="$temp/auto-update-linux.sh"
  [[ -f "$updater" ]] || { rm -rf "$temp"; echo 'Candidate auto-update-linux.sh is missing.' >&2; return 1; }
  chmod +x "$updater"
  local args=(--install-dir "$INSTALL_DIR" --source-ref "$SOURCE_REF" --expected-commit "$resolved" --force)
  [[ "$POWER_MODE" == 1 ]] && args+=(--power-mode)
  [[ "$STANDARD_MODE" == 1 ]] && args+=(--standard-mode)
  local cap
  for cap in "${DISABLE_CAPS[@]}"; do args+=(--disable-capability "$cap"); done
  for cap in "${ENABLE_CAPS[@]}"; do args+=(--enable-capability "$cap"); done
  /bin/bash "$updater" "${args[@]}"
  rm -rf "$temp"
  echo "SAFE_UPDATE_PASS commit=$resolved"
}

install_source() {
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    local dirty resolved current
    dirty="$(git -C "$INSTALL_DIR" status --porcelain --untracked-files=no)"
    [[ -z "$dirty" ]] || { echo "Tracked local changes exist in InstallDir; refusing update." >&2; exit 1; }
    git -C "$INSTALL_DIR" fetch --no-tags origin "$SOURCE_REF"
    resolved="$(git -C "$INSTALL_DIR" rev-parse 'FETCH_HEAD^{commit}')"
    [[ "$resolved" =~ ^[0-9a-f]{40}$ ]] || { echo "Could not peel fetched source ref to a commit." >&2; exit 1; }
    if [[ -n "$EXPECTED_COMMIT" && "${resolved,,}" != "${EXPECTED_COMMIT,,}" ]]; then
      echo "Fetched commit $resolved does not match expected commit $EXPECTED_COMMIT." >&2
      exit 1
    fi
    current="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
    [[ "$current" =~ ^[0-9a-f]{40}$ ]] || {
      echo "InstallDir contains an incomplete Git checkout with no HEAD. Move/remove that failed installation and retry." >&2
      exit 1
    }
    if [[ "$current" != "$resolved" ]]; then
      git -C "$INSTALL_DIR" merge-base --is-ancestor "$current" "$resolved" || {
        echo "Refusing non-fast-forward update or downgrade." >&2; exit 1;
      }
      git -C "$INSTALL_DIR" checkout --detach "$resolved"
    fi
  elif [[ -e "$INSTALL_DIR" ]]; then
    echo "Install directory exists but is not a Git repository: $INSTALL_DIR" >&2
    exit 1
  else
    local stage resolved
    stage="${INSTALL_DIR}.install.$$"
    rm -rf "$stage"
    mkdir -p "$stage"
    if ! git -C "$stage" init ||
       ! git -C "$stage" remote add origin "$REPO_URL" ||
       ! git -C "$stage" fetch --depth 1 --no-tags origin "$SOURCE_REF"; then
      rm -rf "$stage"
      echo "Failed to initialize/fetch source; incomplete staging checkout removed." >&2
      exit 1
    fi
    resolved="$(git -C "$stage" rev-parse 'FETCH_HEAD^{commit}' 2>/dev/null || true)"
    if [[ ! "$resolved" =~ ^[0-9a-f]{40}$ ]]; then
      rm -rf "$stage"
      echo "Could not peel fetched source ref to a commit; incomplete staging checkout removed." >&2
      exit 1
    fi
    if [[ -n "$EXPECTED_COMMIT" && "${resolved,,}" != "${EXPECTED_COMMIT,,}" ]]; then
      rm -rf "$stage"
      echo "Fetched commit $resolved does not match expected commit $EXPECTED_COMMIT; incomplete staging checkout removed." >&2
      exit 1
    fi
    if ! git -C "$stage" checkout --detach "$resolved"; then
      rm -rf "$stage"
      echo "git checkout failed; incomplete staging checkout removed." >&2
      exit 1
    fi
    mv "$stage" "$INSTALL_DIR"
  fi

  local head
  head="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
  if [[ -n "$EXPECTED_COMMIT" && "${head,,}" != "${EXPECTED_COMMIT,,}" ]]; then
    echo "Installed HEAD $head does not match expected commit $EXPECTED_COMMIT." >&2
    exit 1
  fi
  echo "Source ref: $SOURCE_REF"
  echo "Source commit: $head"
}
node_major() {
  node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0
}

install_portable_node() {
  local current=0
  if need node; then current="$(node_major)"; fi
  if [[ "$current" -ge 22 ]]; then return 0; fi
  [[ "$INSTALL_PREREQS" == "1" ]] || {
    echo "Node.js 22+ is required. Re-run with --install-prerequisites or install Node 22+." >&2
    exit 1
  }
  local machine node_arch
  machine="$(uname -m)"
  case "$machine" in
    x86_64|amd64) node_arch="x64" ;;
    aarch64|arm64) node_arch="arm64" ;;
    *) echo "Unsupported Linux architecture for portable Node: $machine" >&2; exit 1 ;;
  esac
  local index version asset base tmp expected actual
  index="$(curl_fetch https://nodejs.org/dist/index.json)"
  version="$(printf '%s' "$index" | grep -oE '"version"[[:space:]]*:[[:space:]]*"v22\.[^"]+"' | head -n1 | sed -E 's/.*"(v22\.[^"]+)"/\1/')"
  [[ -n "$version" ]] || { echo "Could not resolve latest Node 22 release" >&2; exit 1; }
  asset="node-${version}-linux-${node_arch}.tar.xz"
  base="https://nodejs.org/dist/${version}"
  tmp="$(mktemp -d)"
  curl_fetch "$base/$asset" -o "$tmp/$asset"
  curl_fetch "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  expected="$(awk -v f="$asset" '$2==f {print $1}' "$tmp/SHASUMS256.txt")"
  actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
  [[ -n "$expected" && "$actual" == "$expected" ]] || { echo "Node SHA-256 verification failed" >&2; exit 1; }
  mkdir -p "$INSTALL_DIR/.runtime"
  rm -rf "$INSTALL_DIR/.runtime/node-${version}-linux-${node_arch}" "$INSTALL_DIR/.runtime/node-current"
  tar -xJf "$tmp/$asset" -C "$INSTALL_DIR/.runtime"
  ln -s "node-${version}-linux-${node_arch}" "$INSTALL_DIR/.runtime/node-current"
  rm -rf "$tmp"
  export PATH="$INSTALL_DIR/.runtime/node-current/bin:$PATH"
  echo "Portable Node installed: $(node --version)"
}

ensure_node_path() {
  if [[ -x "$INSTALL_DIR/.runtime/node-current/bin/node" ]]; then
    export PATH="$INSTALL_DIR/.runtime/node-current/bin:$PATH"
  fi
  local major
  major="$(node_major)"
  [[ "$major" -ge 22 ]] || { echo "Node.js 22+ not available" >&2; exit 1; }
  need npm || { echo "npm is required" >&2; exit 1; }
}
ensure_project_provider() {
  echo 'PROJECT_PROVIDER_DISABLED policy=NO_CODEX_VIA_COMMANDER'
}

ensure_browser_backend() {
  if [[ "$CUSTOM_NO_START" == 1 ]]; then
    echo 'Browser backend bootstrap deferred for custom/no-start installation.'
    return 0
  fi
  local requested=0 exe driver state_root
  if [[ "$POWER_MODE" == 1 ]]; then requested=1
  elif [[ "$STANDARD_MODE" == 0 && -f "$INSTALL_DIR/config.local.json" ]]; then
    local tier
    tier="$(node "$INSTALL_DIR/tools/json-field.mjs" --file "$INSTALL_DIR/config.local.json" --field capabilityProfile.tier 2>/dev/null || true)"
    [[ "$tier" == "FULL_POWER" ]] && requested=1
  fi
  [[ "$requested" == 1 ]] || return 0
  state_root="${XDG_STATE_HOME:-$HOME/.local/state}/chatgpt-remote-commander"
  for exe in "$(command -v google-chrome 2>/dev/null || true)" "$(command -v google-chrome-stable 2>/dev/null || true)" "$(command -v chromium 2>/dev/null || true)" "$(command -v chromium-browser 2>/dev/null || true)" "$(command -v microsoft-edge 2>/dev/null || true)"; do
    if [[ -n "$exe" && -x "$exe" ]]; then
      BROWSER_EXECUTABLE="$exe"
      BROWSER_PROFILE_ROOT="$state_root/browser-profiles"
      echo "BROWSER_BACKEND_PASS backend=chromium executable=$exe"
      return 0
    fi
  done
  exe="$(command -v firefox 2>/dev/null || true)"
  driver="$(command -v geckodriver 2>/dev/null || true)"
  if [[ -n "$exe" && -x "$exe" && -n "$driver" && -x "$driver" ]]; then
    BROWSER_EXECUTABLE="$exe"
    if command -v snap >/dev/null 2>&1 && snap list firefox >/dev/null 2>&1; then
      BROWSER_PROFILE_ROOT="$HOME/snap/firefox/common/chatgpt-remote-commander/browser-profiles"
    else
      BROWSER_PROFILE_ROOT="$state_root/browser-profiles"
    fi
    mkdir -p "$BROWSER_PROFILE_ROOT"
    echo "BROWSER_BACKEND_PASS backend=firefox-webdriver executable=$exe driver=$driver profileRoot=$BROWSER_PROFILE_ROOT"
    return 0
  fi
  echo 'BROWSER_BACKEND_UNAVAILABLE authorized=true reason=no-safe-local-browser-backend'
  return 0
}
install_tunnel_client() {
  local pin helper version machine arch dir actual upstream
  pin="$INSTALL_DIR/tools/tunnel-client-pin.json"
  helper="$INSTALL_DIR/tools/install-tunnel-client-linux.sh"
  [[ -f "$pin" && -f "$helper" ]] || { echo "Pinned tunnel-client installer metadata is missing." >&2; exit 1; }

  version="$(node "$INSTALL_DIR/tools/json-field.mjs" --file "$pin" --field version)"
  upstream="$(node "$INSTALL_DIR/tools/json-field.mjs" --file "$pin" --field upstreamCommit)"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$upstream" =~ ^[0-9a-f]{40}$ ]] || {
    echo "Pinned tunnel-client metadata is invalid." >&2
    exit 1
  }

  if [[ "$SKIP_TUNNEL_CLIENT" == 1 ]]; then
    machine="$(uname -m)"
    case "$machine" in
      x86_64|amd64) arch="amd64" ;;
      aarch64|arm64) arch="arm64" ;;
      *) echo "Unsupported tunnel-client architecture: $machine" >&2; exit 1 ;;
    esac
    dir="$INSTALL_DIR/tools/tunnel-client-v$version-linux-$arch"
    if [[ -x "$dir/tunnel-client" ]]; then
      actual="$("$dir/tunnel-client" --version 2>/dev/null || true)"
      [[ "$actual" == "$version+$upstream"* ]] || {
        echo "Existing pinned tunnel-client provenance mismatch: $actual" >&2
        exit 1
      }
      echo "Reusing existing pinned tunnel-client while skip was requested: $dir/tunnel-client"
    else
      echo "Skipping tunnel-client installation as requested; no pinned executable is present."
    fi
    return 0
  fi

  /bin/bash "$helper" --install-dir "$INSTALL_DIR"
}

write_local_config() {
  local workspace="$HOME/source/repos"
  local state_root="${XDG_STATE_HOME:-$HOME/.local/state}/chatgpt-remote-commander"
  local backup_root="$HOME/.chatgpt-remote-commander/backups"
  if [[ "$CUSTOM_NO_START" == 1 ]]; then
    workspace="$INSTALL_DIR/workspace"
    state_root="$INSTALL_DIR/var/isolated"
    backup_root="$state_root/backups"
  fi
  local state_dir="$state_root/instances/default"
  local workflow_dir="$state_dir/workflows"
  local cfg="$INSTALL_DIR/config.local.json"
  local mode="standard"
  local preserve_custom=0
  if [[ "$CUSTOM_NO_START" == 1 && -f "$cfg" ]]; then
    preserve_custom=1
    mode=preserve
  else
    mkdir -p "$workspace"
    mkdir -p "$state_dir"
  fi
  [[ "$POWER_MODE" == 1 ]] && mode="full"
  [[ "$STANDARD_MODE" == 1 ]] && mode="standard"

  local args=()
  if [[ "$preserve_custom" == 1 ]]; then
    # No backup-root argument: config migration preserves explicit state paths
    # without opening the referenced workflow database or activating a service.
    local profile_id existing_workflow
    profile_id="$(node "$INSTALL_DIR/tools/json-field.mjs" --file "$cfg" --field capabilityProfile.id 2>/dev/null || true)"
    [[ -n "$profile_id" ]] || profile_id=default
    existing_workflow="$(node "$INSTALL_DIR/tools/json-field.mjs" --file "$cfg" --field durableWorkflows.directory 2>/dev/null || true)"
    [[ -z "$existing_workflow" ]] || workflow_dir="$existing_workflow"
    args=("$INSTALL_DIR/tools/capability-migrate.mjs" --default "$INSTALL_DIR/config.json"
      --existing "$cfg" --output "$cfg" --profile-id "$profile_id" --workflow-dir "$workflow_dir")
    [[ "$POWER_MODE" == 1 ]] && args+=(--request-power)
    [[ "$STANDARD_MODE" == 1 ]] && args+=(--request-standard)
  else
    args=("$INSTALL_DIR/tools/build-candidate-config.mjs" --default "$INSTALL_DIR/config.json"
      --output "$cfg" --profile-id default --port 47831 --state-dir "$state_dir"
      --workflow-dir "$workflow_dir" --mode "$mode" --backup-root "$backup_root"
      --device-name "$(hostname)" --allowed-root "$workspace"
      --allowed-program git --allowed-program node --allowed-program npm
      --allowed-program npx --allowed-program python3 --allowed-program python
      --allowed-program dotnet --allowed-program cmake --allowed-program ninja)
  fi
  local cap
  [[ "$CUSTOM_NO_START" == 1 ]] || args+=(--provider-root "$state_root")
  [[ -z "$BROWSER_EXECUTABLE" ]] || args+=(--browser-executable "$BROWSER_EXECUTABLE")
  [[ -z "$BROWSER_PROFILE_ROOT" ]] || args+=(--browser-profile-root "$BROWSER_PROFILE_ROOT")
  for cap in "${DISABLE_CAPS[@]}"; do args+=(--disable-capability "$cap"); done
  for cap in "${ENABLE_CAPS[@]}"; do args+=(--enable-capability "$cap"); done
  node "${args[@]}" >/dev/null

  local tier
  tier="$(node "$INSTALL_DIR/tools/json-field.mjs" --file "$cfg" --field capabilityProfile.tier)"
  echo "Local capability profile: $tier"
  if [[ "$tier" == "FULL_POWER" ]]; then
    echo "Full Power active: all known capabilities enabled except explicit disabledCapabilities."
  else
    echo "Standard local policy active."
  fi
}

install_linux_gui_backend() {
  local project="$1" cfg="$2" enabled
  enabled="$(node "$project/tools/json-field.mjs" --file "$cfg" --field powerMode.guiControl.enabled 2>/dev/null || true)"
  [[ "$enabled" == true ]] || return 0
  if [[ "$CUSTOM_NO_START" == 1 ]]; then
    echo 'Linux GUI registration deferred for custom/no-start installation; registration occurs during explicit activation.'
    return 0
  fi
  [[ -x "$project/tools/install-gnome-gui-extension.sh" ]] || { echo 'Linux GUI backend installer missing or not executable.' >&2; return 1; }
  "$project/tools/install-gnome-gui-extension.sh"
}

validate_installation() {
  cd "$INSTALL_DIR"
  npm run check:qualification
  npm run test:qualification
  npm run audit
}

start_server() {
  [[ "$START_SERVER" == "1" ]] || return 0
  cd "$INSTALL_DIR"
  mkdir -p var
  local expected current health pid cwd
  expected="$(sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' package.json | head -n1)"
  health="$(curl -fsS --connect-timeout 1 --max-time 2 http://127.0.0.1:47831/health 2>/dev/null || true)"
  current="$(printf '%s' "$health" | sed -nE 's/.*"version":"([^"]+)".*/\1/p')"
  if [[ -n "$current" && "$current" == "$expected" ]]; then
    echo "MCP server is already healthy at version $expected."
    return 0
  fi
  if [[ -n "$current" && "$current" != "$expected" ]]; then
    echo "Updating running MCP from version $current to $expected..."
    for pid in $(pgrep -f 'node .*src/server-v0\.3\.mjs' 2>/dev/null || true); do
      cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
      if [[ "$cwd" == "$(readlink -f "$INSTALL_DIR")" ]]; then
        kill "$pid" 2>/dev/null || true
      fi
    done
    for _ in $(seq 1 40); do
      sleep 0.25
      health="$(curl -fsS --connect-timeout 1 --max-time 2 http://127.0.0.1:47831/health 2>/dev/null || true)"
      current="$(printf '%s' "$health" | sed -nE 's/.*"version":"([^"]+)".*/\1/p')"
      if [[ "$current" == "$expected" ]]; then
        echo "Supervisor restarted MCP at version $expected."
        return 0
      fi
    done
  fi
  nohup ./run-server.sh > var/server.log 2>&1 &
  echo $! > var/server.pid
  for _ in $(seq 1 40); do
    sleep 0.25
    health="$(curl -fsS --connect-timeout 1 --max-time 2 http://127.0.0.1:47831/health 2>/dev/null || true)"
    current="$(printf '%s' "$health" | sed -nE 's/.*"version":"([^"]+)".*/\1/p')"
    if [[ "$current" == "$expected" ]]; then
      echo "MCP server started at version $expected: http://127.0.0.1:47831/mcp"
      return 0
    fi
  done
  echo "Server failed to reach expected version $expected; see $INSTALL_DIR/var/server.log" >&2
  exit 1
}
[[ "$(uname -s)" == "Linux" ]] || { echo "This installer supports Linux only. Use install.ps1 on Windows." >&2; exit 1; }
install_os_packages
for cmd in git curl unzip tar sha256sum readlink python3; do
  need "$cmd" || { echo "$cmd is required; re-run with --install-prerequisites." >&2; exit 1; }
done

INSTALL_DIR="$(readlink -m -- "$INSTALL_DIR")"
CANONICAL_INSTALL_DIR="$(readlink -m -- "$HOME/.local/share/ChatGPTRemoteCommander")"
CUSTOM_NO_START=0
[[ "$INSTALL_DIR" == "$CANONICAL_INSTALL_DIR" || "$START_SERVER" == 1 ]] || CUSTOM_NO_START=1

# Track only a brand-new install committed by this invocation. Existing
# installations, unknown data and running instances are never quarantined.
FRESH_INSTALL_CANDIDATE=0
[[ -e "$INSTALL_DIR" || -L "$INSTALL_DIR" ]] || FRESH_INSTALL_CANDIDATE=1
FRESH_INSTALL_PREACTIVATION=0
FRESH_INSTALL_INODE=""
FRESH_INSTALL_COMMIT=""
rollback_fresh_preactivation() {
  local rc=$?
  trap - EXIT
  if [[ "$rc" -ne 0 && "$FRESH_INSTALL_PREACTIVATION" == 1 ]]; then
    local current_inode current_commit failed_dir
    current_inode="$(stat -c '%d:%i' -- "$INSTALL_DIR" 2>/dev/null || true)"
    current_commit="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
    if [[ -n "$FRESH_INSTALL_INODE" && "$current_inode" == "$FRESH_INSTALL_INODE" &&
          "$current_commit" == "$FRESH_INSTALL_COMMIT" && -d "$INSTALL_DIR/.git" &&
          ! -L "$INSTALL_DIR" ]]; then
      failed_dir="${INSTALL_DIR}.failed-install-$(date -u +%Y%m%dT%H%M%SZ)-$"
      if [[ ! -e "$failed_dir" && ! -L "$failed_dir" ]] && mv -- "$INSTALL_DIR" "$failed_dir"; then
        echo "FRESH_INSTALL_QUARANTINED path=$failed_dir: source remains available for recovery" >&2
      else
        echo "FRESH_INSTALL_QUARANTINE_REVIEW_REQUIRED: preserving unknown installation state" >&2
      fi
    else
      echo "FRESH_INSTALL_ROLLBACK_REVIEW_REQUIRED: target identity changed; preserving it" >&2
    fi
  fi
  exit "$rc"
}

if [[ -d "$INSTALL_DIR/.git" && "$CUSTOM_NO_START" != 1 ]]; then
  ensure_node_path
  invoke_existing_safe_update
else
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    echo "Updating isolated/custom checkout in place without global routing mutation: $INSTALL_DIR"
  fi
  install_source
  if [[ "$FRESH_INSTALL_CANDIDATE" == 1 ]]; then
    FRESH_INSTALL_INODE="$(stat -c '%d:%i' -- "$INSTALL_DIR")"
    FRESH_INSTALL_COMMIT="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
    FRESH_INSTALL_PREACTIVATION=1
    trap rollback_fresh_preactivation EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
  fi
  install_portable_node
  ensure_node_path
  install_tunnel_client
  ensure_project_provider
  ensure_browser_backend
  write_local_config
  chmod +x "$INSTALL_DIR/install.sh" "$INSTALL_DIR/connect-chatgpt-account.sh" "$INSTALL_DIR/run-server.sh" \
    "$INSTALL_DIR/autostart-linux.sh" "$INSTALL_DIR/supervisor-routing-linux.sh" "$INSTALL_DIR/auto-update-linux.sh" \
    "$INSTALL_DIR/tools/install-tunnel-client-linux.sh" \
    "$INSTALL_DIR/enable-autostart-linux.sh" "$INSTALL_DIR/disable-autostart-linux.sh" \
    "$INSTALL_DIR/tools/gui-control-linux.py" "$INSTALL_DIR/tools/install-gnome-gui-extension.sh"
  install_linux_gui_backend "$INSTALL_DIR" "$INSTALL_DIR/config.local.json"
  validate_installation
  # Beyond this point a new runtime may be activated. Never relocate an
  # installation that could have a running server or enrolled owner state.
  FRESH_INSTALL_PREACTIVATION=0
  trap - EXIT INT TERM
  start_server
  if [[ "$START_SERVER" == "1" ]]; then
    head="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
    args=(--install-dir "$INSTALL_DIR" --source-ref "$SOURCE_REF" --expected-commit "$head" --force)
    [[ "$POWER_MODE" == 1 ]] && args+=(--power-mode)
    [[ "$STANDARD_MODE" == 1 ]] && args+=(--standard-mode)
    for cap in "${DISABLE_CAPS[@]}"; do args+=(--disable-capability "$cap"); done
    for cap in "${ENABLE_CAPS[@]}"; do args+=(--enable-capability "$cap"); done
    /bin/bash "$INSTALL_DIR/auto-update-linux.sh" "${args[@]}"
  fi
fi

effective_cfg="$INSTALL_DIR/config.local.json"
route="${XDG_STATE_HOME:-$HOME/.local/state}/chatgpt-remote-commander/routing/default.json"
if [[ "$CUSTOM_NO_START" != 1 && -f "$route" ]]; then
  routed_cfg="$(node "$INSTALL_DIR/tools/router-state.mjs" --state "$route" --tsv 2>/dev/null | awk -F '\t' '{print $7}')"
  [[ -n "$routed_cfg" && -f "$routed_cfg" ]] && effective_cfg="$routed_cfg"
fi
mode="$(node "$INSTALL_DIR/tools/json-field.mjs" --file "$effective_cfg" --field capabilityProfile.tier 2>/dev/null || echo STANDARD)"

echo
echo "INSTALL_PASS"
echo "Installed at: $INSTALL_DIR"
echo "Source ref: $SOURCE_REF"
echo "Source commit: $(git -C "$INSTALL_DIR" rev-parse HEAD)"
echo "Mode: $mode"
echo "Device: $(hostname)"
echo
echo "Next: create a distinct OpenAI Secure MCP Tunnel for this computer, then run once:"
echo "  $INSTALL_DIR/enable-autostart-linux.sh"
echo "For additional ChatGPT accounts on this same computer, run it again with a different --profile."
echo "The script auto-selects a free health port and stores the Runtime API key in a user-only local credential file outside the repository."
