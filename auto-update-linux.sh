#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${HOME}/.local/share/ChatGPTRemoteCommander"
ORIGINAL_ARGS=("$@")
SELF_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
SOURCE_REF=""
EXPECTED_COMMIT=""
FORCE=0
POWER_MODE=0
STANDARD_MODE=0
NO_PROMOTE=0
SELF_TEST=0
DRAIN_TIMEOUT=60
DISABLE_CAPS=()
ENABLE_CAPS=()
BROWSER_EXECUTABLE=""
BROWSER_PROFILE_ROOT=""
REPO_URL="${REMOTE_COMMANDER_REPO_URL:-https://github.com/GOD13emad/ChatGPTRemoteCommander.git}"
CURL_CONNECT_TIMEOUT="${REMOTE_COMMANDER_CURL_CONNECT_TIMEOUT:-15}"
CURL_MAX_TIME="${REMOTE_COMMANDER_CURL_MAX_TIME:-180}"
STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/chatgpt-remote-commander"
RELEASE_ROOT="$STATE_ROOT/releases"
ROUTING_ROOT="$STATE_ROOT/routing"
RUNTIME_ROOT="$STATE_ROOT/runtimes"
BACKUP_ROOT="$STATE_ROOT/update-backups"
LOG_DIR="$STATE_ROOT/update-logs"
RESULT_FILE="$STATE_ROOT/last-update.json"
RETAINED_FILE="$STATE_ROOT/retained-backends.json"
PROFILE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/tunnel-client"

usage(){
  cat <<'USAGE'
Usage: auto-update-linux.sh [options]
  --install-dir PATH
  --source-ref REF
  --expected-commit SHA
  --force
  --power-mode | --standard-mode
  --disable-capability CAP   Repeatable explicit opt-out
  --enable-capability CAP    Repeatable explicit opt-in
  --no-promote
  --self-test
  --drain-timeout SECONDS
USAGE
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir) INSTALL_DIR="$2"; shift 2;;
    --source-ref) SOURCE_REF="$2"; shift 2;;
    --expected-commit) EXPECTED_COMMIT="$2"; shift 2;;
    --force) FORCE=1; shift;;
    --power-mode) POWER_MODE=1; shift;;
    --standard-mode) STANDARD_MODE=1; shift;;
    --disable-capability) DISABLE_CAPS+=("$2"); shift 2;;
    --enable-capability) ENABLE_CAPS+=("$2"); shift 2;;
    --no-promote) NO_PROMOTE=1; shift;;
    --self-test) SELF_TEST=1; shift;;
    --drain-timeout) DRAIN_TIMEOUT="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2;;
  esac
done
[[ "$POWER_MODE" == 0 || "$STANDARD_MODE" == 0 ]] || { echo 'power/standard modes are mutually exclusive' >&2; exit 2; }
[[ -z "$SOURCE_REF" || "$SOURCE_REF" =~ ^[A-Za-z0-9._/-]{1,128}$ ]] || { echo 'invalid source ref' >&2; exit 2; }
[[ -z "$EXPECTED_COMMIT" || "$EXPECTED_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]] || { echo 'invalid expected commit' >&2; exit 2; }
[[ "$DRAIN_TIMEOUT" =~ ^[1-9][0-9]{0,2}$ ]] || { echo 'invalid drain timeout' >&2; exit 2; }

INSTALL_DIR="$(cd "$INSTALL_DIR" 2>/dev/null && pwd -P || printf '%s' "$INSTALL_DIR")"
mkdir -p "$RELEASE_ROOT" "$ROUTING_ROOT" "$RUNTIME_ROOT" "$BACKUP_ROOT" "$LOG_DIR"

log(){ printf '%s %s\n' "$(date --iso-8601=seconds 2>/dev/null || date)" "$*" >> "$LOG_DIR/auto-update.log"; [[ "$SELF_TEST" == 1 ]] || printf '%s\n' "$*"; }

updater_has_commander_backend_ancestor(){
  local pid="${PPID:-0}" depth=0 cmd cwd parent
  while [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 && "$depth" -lt 16 ]]; do
    cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    if [[ "$cmd" == *"src/server-v0.3.mjs"* || "$cmd" == *"src/server.mjs"* ]]; then
      if [[ "$cwd" == "$INSTALL_DIR" || "$cwd" == "$STATE_ROOT/releases/"* || "$cwd" == "$STATE_ROOT/runtimes/"* ]]; then
        return 0
      fi
    fi
    parent="$(awk '$1=="PPid:"{print $2}' "/proc/$pid/status" 2>/dev/null || true)"
    [[ "$parent" =~ ^[0-9]+$ ]] || break
    pid="$parent"
    depth=$((depth+1))
  done
  return 1
}

detach_from_commander_backend_if_needed(){
  [[ "$SELF_TEST" == 1 ]] && return 0
  [[ "${REMOTE_COMMANDER_AUTO_UPDATE_DETACHED:-0}" == 1 ]] && return 0
  updater_has_commander_backend_ancestor || return 0
  if ! command -v setsid >/dev/null 2>&1; then
    log 'AUTO_UPDATE_SELF_DETACH_BLOCK reason=setsid-missing'
    return 1
  fi
  nohup setsid -f env REMOTE_COMMANDER_AUTO_UPDATE_DETACHED=1 /bin/bash "$SELF_PATH" "${ORIGINAL_ARGS[@]}" >>"$LOG_DIR/auto-update-detached.log" 2>&1 </dev/null &
  log 'AUTO_UPDATE_SELF_DETACH_REQUESTED'
  exit 0
}

write_update_result(){
  local status="$1" version="$2" commit="$3" ref="$4"
  node --input-type=module - "$RESULT_FILE" "$status" "$version" "$commit" "$ref" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const [, , file, status, version, commit, sourceRef] = process.argv;
if (!/^(?:pass|maintenance_pass)$/.test(status)) process.exit(2);
if (!/^\d+\.\d+\.\d+$/.test(version)) process.exit(3);
if (!/^[0-9a-fA-F]{40}$/.test(commit)) process.exit(4);
if (sourceRef.length > 128 || !/^[A-Za-z0-9._/-]+$/.test(sourceRef)) process.exit(5);
fs.mkdirSync(path.dirname(file), { recursive: true });
const tmp = file + '.tmp-' + process.pid;
const payload = {
  schema: 1,
  platform: 'linux',
  status,
  version,
  commit: commit.toLowerCase(),
  sourceRef,
  completedAt: new Date().toISOString()
};
fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
fs.renameSync(tmp, file);
NODE
}
curl_fetch(){ curl --fail --silent --show-error --location --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" "$@"; }
json_field(){ node "$1/tools/json-field.mjs" --file "$2" --field "$3" 2>/dev/null || true; }
route_tsv(){ node "$1/tools/router-state.mjs" --state "$2" --tsv; }
version_gt(){
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$2" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "AUTO_UPDATE_VERSION_COMPARE_INVALID left=$1 right=$2" >&2; return 2; }
  local IFS=. a1 a2 a3 b1 b2 b3
  read -r a1 a2 a3 <<< "$1"; read -r b1 b2 b3 <<< "$2"
  ((10#$a1 > 10#$b1)) || { ((10#$a1 == 10#$b1)) && ((10#$a2 > 10#$b2)); } || { ((10#$a1 == 10#$b1)) && ((10#$a2 == 10#$b2)) && ((10#$a3 > 10#$b3)); }
}

wait_health(){
  local port="$1" version="$2" sha="$3" profile="$4" i body
  for i in $(seq 1 80); do
    body="$(curl -fsS --connect-timeout 1 --max-time 2 "http://127.0.0.1:$port/health" 2>/dev/null || true)"
    if [[ "$body" == *'"ok":true'* && "$body" == *"\"version\":\"$version\""* && "$body" == *"\"configSha256\":\"$sha\""* && "$body" == *"\"profile\":\"$profile\""* ]]; then return 0; fi
    sleep 0.25
  done
  return 1
}
start_backend(){
  local project="$1" cfg="$2" log_file="$3"
  mkdir -p "$(dirname "$log_file")"
  (cd "$project"; REMOTE_COMMANDER_CONFIG="$cfg" nohup node src/server-v0.3.mjs 9>&- >>"$log_file" 2>&1 & echo $!)
}
stop_pid(){ local pid="$1"; kill "$pid" 2>/dev/null || true; for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.1; done; kill -9 "$pid" 2>/dev/null || true; }
stop_owned_candidate(){
  local pid="${1:-}" project="${2:-}"
  [[ -z "$pid" ]] && return 0
  kill -0 "$pid" 2>/dev/null || return 0
  local actual expected
  actual="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  expected="$(cd "$project" && pwd -P)"
  [[ -n "$actual" && "$actual" == "$expected" ]] || { log "CANDIDATE_CLEANUP_OWNERSHIP_MISMATCH pid=$pid"; return 1; }
  stop_pid "$pid"
}
run_gate(){ local project="$1" name="$2"; shift 2; log "GATE_START $name"; (cd "$project"; "$@"); log "GATE_PASS $name"; }
ensure_project_provider(){
  if [[ "$NO_PROMOTE" == 1 ]]; then
    log "PROJECT_PROVIDER_CLEANUP_SKIPPED reason=no-promote"
    return 0
  fi
  # R230: no unknown legacy tool projection is removed as a side effect of
  # a Core update. Require independent exact owner acceptance before cleanup.
  local legacy_root="$STATE_ROOT/tools/codex-cli"
  if [[ -e "$legacy_root" || -L "$legacy_root" ]]; then
    log 'LEGACY_CODEX_PROVIDER_CLEANUP_PENDING reason=OWNER_ACCEPTANCE_REQUIRED'
  fi
  log 'PROJECT_PROVIDER_DISABLED policy=NO_CODEX_VIA_COMMANDER'
}
ensure_browser_backend(){
  local helper="$1" cfg="$2" requested=0 tier exe driver
  if [[ "$POWER_MODE" == 1 ]]; then requested=1
  elif [[ "$STANDARD_MODE" == 0 ]]; then
    tier="$(json_field "$helper" "$cfg" capabilityProfile.tier)"
    [[ "$tier" == "FULL_POWER" ]] && requested=1
  fi
  [[ "$requested" == 1 ]] || return 0
  for exe in "$(command -v google-chrome 2>/dev/null || true)" "$(command -v google-chrome-stable 2>/dev/null || true)" "$(command -v chromium 2>/dev/null || true)" "$(command -v chromium-browser 2>/dev/null || true)" "$(command -v microsoft-edge 2>/dev/null || true)"; do
    if [[ -n "$exe" && -x "$exe" ]]; then
      BROWSER_EXECUTABLE="$exe"
      BROWSER_PROFILE_ROOT="$STATE_ROOT/browser-profiles"
      log "BROWSER_BACKEND_PASS backend=chromium executable=$exe"
      return 0
    fi
  done
  exe="$(command -v firefox 2>/dev/null || true)"
  driver="$(command -v geckodriver 2>/dev/null || true)"
  if [[ -z "$driver" ]]; then
    for candidate in /snap/bin/geckodriver /usr/bin/geckodriver /usr/local/bin/geckodriver "$HOME/.local/bin/geckodriver"; do
      if [[ -x "$candidate" ]]; then driver="$candidate"; break; fi
    done
  fi
  if [[ -n "$exe" && -x "$exe" && -n "$driver" && -x "$driver" ]]; then
    BROWSER_EXECUTABLE="$exe"
    if command -v snap >/dev/null 2>&1 && snap list firefox >/dev/null 2>&1; then
      BROWSER_PROFILE_ROOT="$HOME/snap/firefox/common/chatgpt-remote-commander/browser-profiles"
    else
      BROWSER_PROFILE_ROOT="$STATE_ROOT/browser-profiles"
    fi
    mkdir -p "$BROWSER_PROFILE_ROOT"
    log "BROWSER_BACKEND_PASS backend=firefox-webdriver executable=$exe driver=$driver profileRoot=$BROWSER_PROFILE_ROOT"
    return 0
  fi
  log 'BROWSER_BACKEND_UNAVAILABLE authorized=true reason=no-safe-local-browser-backend'
  return 0
}
latest_ref(){
  if [[ -n "$SOURCE_REF" ]]; then printf '%s\n' "$SOURCE_REF"; return; fi
  local tag body effective
  effective="$(curl --fail --silent --show-error --location --head \
    --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" \
    --output /dev/null --write-out '%{url_effective}' \
    https://github.com/GOD13emad/ChatGPTRemoteCommander/releases/latest 2>/dev/null || true)"
  tag="$(printf '%s' "$effective" | sed -nE 's#^.*/releases/tag/(v[0-9]+\.[0-9]+\.[0-9]+)$#\1#p' | head -n1)"
  if [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then printf '%s\n' "$tag"; return; fi
  body="$(curl_fetch -H 'User-Agent: ChatGPTRemoteCommander-Updater' https://api.github.com/repos/GOD13emad/ChatGPTRemoteCommander/releases/latest 2>/dev/null || true)"
  tag="$(printf '%s' "$body" | sed -nE 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n1)"
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'latest published release tag discovery failed' >&2; return 1; }
  printf '%s\n' "$tag"
}
# The security audit checks exact Git-commit provenance of historical fixtures.
# A depth-1 staged checkout relabels its initial file diff as the shallow HEAD,
# so the audit must never run until the staged, pinned commit has full ancestry.
ensure_complete_audit_history(){
  local stage="$1" expected="$2" current shallow
  [[ "$expected" =~ ^[0-9a-f]{40}$ ]] || { log 'AUDIT_HISTORY_EXPECTED_SHA_INVALID'; return 1; }
  current="$(git -C "$stage" rev-parse HEAD 2>/dev/null)" || return 1
  [[ "$current" == "$expected" ]] || { log 'AUDIT_HISTORY_STAGE_SHA_MISMATCH'; return 1; }
  [[ -z "$(git -C "$stage" status --porcelain --untracked-files=no)" ]] || { log 'AUDIT_HISTORY_DIRTY_STAGE'; return 1; }
  shallow="$(git -C "$stage" rev-parse --is-shallow-repository)"
  if [[ "$shallow" == true ]]; then
    log 'AUDIT_HISTORY_FETCH_START'
    if ! GIT_TERMINAL_PROMPT=0 timeout --signal=TERM --kill-after=10s 120s \
        git -C "$stage" fetch --quiet --no-tags --unshallow origin "$expected"; then
      log 'AUDIT_HISTORY_FETCH_FAILED'
      return 1
    fi
  fi
  [[ "$(git -C "$stage" rev-parse --is-shallow-repository)" == false ]] ||
    { log 'AUDIT_HISTORY_STILL_SHALLOW'; return 1; }
  [[ "$(git -C "$stage" rev-parse HEAD)" == "$expected" ]] ||
    { log 'AUDIT_HISTORY_STAGE_MOVED'; return 1; }
  [[ -z "$(git -C "$stage" status --porcelain --untracked-files=no)" ]] ||
    { log 'AUDIT_HISTORY_STAGE_MUTATED'; return 1; }
  log 'AUDIT_HISTORY_FULL_PROVENANCE_PASS'
}

stage_release(){
  local ref="$1" tmp resolved version final head
  tmp="$RELEASE_ROOT/stage-$(printf '%s' "$ref" | tr -c 'A-Za-z0-9._-' '_')-$$"
  rm -rf "$tmp"; mkdir -p "$tmp"
  git -C "$tmp" init >/dev/null
  git -C "$tmp" remote add origin "$REPO_URL"
  git -C "$tmp" fetch --depth 1 --no-tags origin "$ref"
  resolved="$(git -C "$tmp" rev-parse 'FETCH_HEAD^{commit}')"
  [[ "$resolved" =~ ^[0-9a-f]{40}$ ]] || { echo 'stage commit invalid' >&2; return 1; }
  if [[ -n "$EXPECTED_COMMIT" && "${resolved,,}" != "${EXPECTED_COMMIT,,}" ]]; then echo 'stage expected commit mismatch' >&2; return 1; fi
  git -C "$tmp" checkout --detach "$resolved" >/dev/null
  version="$(node "$tmp/tools/json-field.mjs" --file "$tmp/package.json" --field version)"
  if [[ "$ref" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ && "${BASH_REMATCH[1]}" != "$version" ]]; then echo 'stage tag/version mismatch' >&2; return 1; fi
  final="$RELEASE_ROOT/v${version}-${resolved:0:12}"
  if [[ -d "$final" ]]; then
    head="$(git -C "$final" rev-parse HEAD 2>/dev/null || true)"
    [[ "$head" == "$resolved" ]] || { echo 'release directory collision' >&2; return 1; }
    rm -rf "$tmp"
  else
    mv "$tmp" "$final"
  fi
  printf '%s\t%s\t%s\n' "$resolved" "$version" "$final"
}

active_config(){
  local helper="$1" route="$ROUTING_ROOT/default.json"
  if [[ -f "$route" ]]; then
    local p g port v c sha cfg project
    IFS=$'\t' read -r p g port v c sha cfg project < <(route_tsv "$helper" "$route")
    [[ -f "$cfg" ]] && { printf '%s\n' "$cfg"; return; }
  fi
  [[ -f "$INSTALL_DIR/config.local.json" ]] && printf '%s\n' "$INSTALL_DIR/config.local.json" || printf '%s\n' "$INSTALL_DIR/config.json"
}

tunnel_control_plane_fresh(){
  local port="$1" limit="${REMOTE_COMMANDER_TUNNEL_STALE_SECONDS:-90}" metrics last now age
  [[ -n "$limit" && "$limit" =~ ^[1-9][0-9]{1,3}$ ]] || limit=90
  metrics="$(curl -fsS --connect-timeout 1 --max-time 2 "http://127.0.0.1:$port/metrics" 2>/dev/null || true)"
  [[ -n "$metrics" ]] || return 1
  last="$(printf '%s\n' "$metrics" | awk '/^commands_poll_last_successful_timestamp_seconds([{ ]|$)/{print $NF;exit}')"
  awk -v v="$last" 'BEGIN{exit !((v+0)>0)}' || return 1
  now="$(date +%s)"
  age="$(awk -v n="$now" -v b="$last" 'BEGIN{printf "%.0f",n-b}')"
  awk -v n="$now" -v b="$last" -v l="$limit" 'BEGIN{age=n-b; exit !((age>=0)&&(age<=l))}' || return 1
  printf '%s\n' "$age"
}

tunnel_profile_ready(){
  local file="$1" raw hp ready live age
  raw="$(cat "$file")"
  [[ "$raw" == *'http://127.0.0.1:47831/mcp'* ]] || return 0
  hp="$(printf '%s' "$raw" | sed -nE 's/.*listen_addr:[[:space:]]*["'\'']?127\.0\.0\.1:([0-9]+).*/\1/p' | head -n1)"
  [[ -n "$hp" ]] || { log "TUNNEL_READINESS_BLOCK profile=$(basename "$file") reason=health-port-missing"; return 1; }
  ready="$(curl -fsS --connect-timeout 1 --max-time 2 "http://127.0.0.1:$hp/readyz" 2>/dev/null || true)"
  [[ "$ready" == ready ]] && return 0
  live="$(curl -fsS --connect-timeout 1 --max-time 2 "http://127.0.0.1:$hp/healthz" 2>/dev/null || true)"
  [[ "$live" == live ]] || { log "TUNNEL_READINESS_BLOCK profile=$(basename "$file") port=$hp reason=health-not-live"; return 1; }
  age="$(tunnel_control_plane_fresh "$hp")" || { log "TUNNEL_READINESS_BLOCK profile=$(basename "$file") port=$hp reason=control-plane-stale-or-missing"; return 1; }
  log "TUNNEL_READINESS_FRESH_FALLBACK profile=$(basename "$file") port=$hp pollAgeSeconds=$age"
  return 0
}

tunnels_ready(){
  [[ -d "$PROFILE_DIR" ]] || return 0
  local file
  while IFS= read -r -d '' file; do
    tunnel_profile_ready "$file" || return 1
  done < <(find "$PROFILE_DIR" -maxdepth 1 -type f -name '*.yaml' -print0 2>/dev/null)
}

stop_owned_from_config(){
  local helper="$1" cfg="$2" expected_project="${3:-}" marker pid project cwd
  marker="$(json_field "$helper" "$cfg" runtimeState)"
  [[ -n "$marker" ]] || marker="$INSTALL_DIR/var/mcp-runtime.json"
  [[ -f "$marker" ]] || return 0
  pid="$(json_field "$helper" "$marker" pid)"
  project="$(json_field "$helper" "$marker" projectDir)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 0
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  [[ -z "$expected_project" || "$cwd" == "$(readlink -f "$expected_project")" || "$project" == "$expected_project" ]] || { echo 'owned backend identity mismatch' >&2; return 1; }
  stop_pid "$pid"
}
owned_backend_alive(){
  local helper="$1" cfg="$2" expected_project="${3:-}" marker pid project cwd
  [[ -f "$cfg" ]] || return 1
  marker="$(json_field "$helper" "$cfg" runtimeState)"
  [[ -n "$marker" && -f "$marker" ]] || return 1
  pid="$(json_field "$helper" "$marker" pid)"
  project="$(json_field "$helper" "$marker" projectDir)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  [[ -z "$expected_project" || "$cwd" == "$(readlink -f "$expected_project")" || "$project" == "$expected_project" ]] || return 1
  return 0
}
persistent_terminal_pids(){
  local helper="$1" cfg="$2" expected_project="$3" marker backend_pid d child_pid ppid cmd
  owned_backend_alive "$helper" "$cfg" "$expected_project" || return 0
  marker="$(json_field "$helper" "$cfg" runtimeState)"
  backend_pid="$(json_field "$helper" "$marker" pid)"
  [[ "$backend_pid" =~ ^[0-9]+$ ]] || return 0
  for d in /proc/[0-9]*; do
    [[ -r "$d/stat" && -r "$d/cmdline" ]] || continue
    child_pid="${d##*/}"
    ppid="$(awk '{print $4}' "$d/stat" 2>/dev/null || true)"
    [[ "$ppid" == "$backend_pid" ]] || continue
    cmd="$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null || true)"
    [[ "$cmd" == *" --noprofile --norc "* ]] && printf '%s\n' "$child_pid"
  done
}
retained_project_protected(){
  local helper="$1" target="$2" candidate
  [[ -f "$RETAINED_FILE" ]] || return 1
  target="$(readlink -f "$target" 2>/dev/null || printf '%s' "$target")"
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    candidate="$(readlink -f "$candidate" 2>/dev/null || printf '%s' "$candidate")"
    [[ "$candidate" == "$target" ]] && return 0
  done < <(node "$helper/tools/retained-backends.mjs" --file "$RETAINED_FILE" --action protected-projects 2>/dev/null || true)
  return 1
}
retain_previous_backend(){
  local helper="$1" old_port="$2" old_cfg="$3" old_project="$4" terminal_pids="$5"
  local n old_version old_commit old_sha
  n="$(node "$helper/tools/router-status.mjs" --url http://127.0.0.1:47831/router/status --port "$old_port" 2>/dev/null || true)"
  [[ "$n" == 0 ]] || { log "DRAIN_TERMINAL_RETAIN_DEFER profile=default inflight=$n"; return 1; }
  old_version="$(json_field "$helper" "$ROUTE" previous.version)"
  old_commit="$(json_field "$helper" "$ROUTE" previous.commit)"
  old_sha="$(json_field "$helper" "$ROUTE" previous.configSha256)"
  [[ "$old_commit" =~ ^[0-9a-fA-F]{40}$ && "$old_sha" =~ ^[0-9a-fA-F]{64}$ ]] || { log "DRAIN_TERMINAL_RETAIN_IDENTITY_DEFER profile=default"; return 1; }
  node "$helper/tools/retained-backends.mjs" --file "$RETAINED_FILE" --action add --profile default --port "$old_port" --version "$old_version" --commit "$old_commit" --config-sha "$old_sha" --config-path "$old_cfg" --project-dir "$old_project" --terminal-pids "$terminal_pids" >/dev/null
  retire_previous_route "$helper" "$old_port"
  log "DRAIN_TERMINAL_RETAINED profile=default port=$old_port pids=$terminal_pids"
  return 0
}
retire_previous_route(){
  local helper="$1" old_port="$2" old_commit profile generation
  old_commit="$(node "$helper/tools/json-field.mjs" --file "$ROUTE" --field previous.commit 2>/dev/null || true)"
  [[ -n "$old_commit" ]] || return 0
  profile="$(node "$helper/tools/json-field.mjs" --file "$ROUTE" --field profile)"
  generation="$(node "$helper/tools/json-field.mjs" --file "$ROUTE" --field generation)"
  node "$helper/tools/router-retire.mjs" --state "$ROUTE" --expected-generation "$generation" --profile "$profile" --previous-port "$old_port" --previous-commit "$old_commit"
  log "ROUTER_PREVIOUS_RETIRED profile=$profile port=$old_port commit=$old_commit"
}
drain_previous_once(){
  local helper="$1" old_port="$2" old_cfg="$3" old_project="$4" n detail cancellable terminal_pids
  if ! owned_backend_alive "$helper" "$old_cfg" "$old_project"; then
    retire_previous_route "$helper" "$old_port"
    return 0
  fi
  terminal_pids="$(persistent_terminal_pids "$helper" "$old_cfg" "$old_project" | paste -sd, -)"
  if [[ -n "$terminal_pids" ]]; then
    if retain_previous_backend "$helper" "$old_port" "$old_cfg" "$old_project" "$terminal_pids"; then return 0; fi
    log "DRAIN_PERSISTENT_TERMINAL_DEFER profile=default pids=$terminal_pids"
    return 1
  fi
  n="$(node "$helper/tools/router-status.mjs" --url http://127.0.0.1:47831/router/status --port "$old_port" 2>/dev/null || true)"
  [[ "$n" =~ ^[0-9]+$ ]] || return 2
  if [[ "$n" == 0 ]]; then
    stop_owned_from_config "$helper" "$old_cfg" "$old_project"
    if owned_backend_alive "$helper" "$old_cfg" "$old_project"; then return 2; fi
    retire_previous_route "$helper" "$old_port"
    return 0
  fi
  detail="$(node "$helper/tools/router-status.mjs" --url http://127.0.0.1:47831/router/status --port "$old_port" --json 2>/dev/null || true)"
  [[ -n "$detail" ]] || return 1
  cancellable="$(node -e 'try{const x=JSON.parse(process.argv[1]);process.stdout.write(x.cancellableOnly===true?"true":"false")}catch{process.stdout.write("false")}' "$detail")"
  if [[ "$cancellable" == true ]]; then
    log "DRAIN_CANCEL_SAFE profile=default inflight=$n"
    stop_owned_from_config "$helper" "$old_cfg" "$old_project"
    if owned_backend_alive "$helper" "$old_cfg" "$old_project"; then return 2; fi
    retire_previous_route "$helper" "$old_port"
    return 0
  fi
  return 1
}
has_superseded_release(){
  local active="" d
  [[ -f "$ROUTE" ]] && active="$(route_tsv "$STAGE_DIR" "$ROUTE" 2>/dev/null | awk -F '\t' '{print $8}')"
  for d in "$RELEASE_ROOT"/v*; do
    [[ -d "$d" ]] || continue
    [[ -n "$active" && "$(readlink -f "$d")" == "$(readlink -f "$active")" ]] || return 0
  done
  return 1
}

start_router(){
  local project="$1" route="$2" log_file="$3"
  (cd "$project"; nohup node src/stable-router.mjs --listen-port 47831 --state-file "$route" --runtime-file "$ROUTING_ROOT/default.runtime.json" 9>&- >>"$log_file" 2>&1 & echo $!)
}
wait_router(){
  for _ in $(seq 1 80); do
    curl -fsS --connect-timeout 1 --max-time 2 http://127.0.0.1:47831/router/status 2>/dev/null | grep -q '"router":true' && return 0
    sleep 0.25
  done
  return 1
}

recycle_supervisor(){
  local had=0 pid
  if command -v systemctl >/dev/null 2>&1 && systemctl --user is-enabled chatgpt-remote-commander.service >/dev/null 2>&1; then
    systemctl --user daemon-reload
    log 'SUPERVISOR_RECYCLE_REQUEST mode=systemd'
    systemctl --user restart --no-block chatgpt-remote-commander.service
    return 0
  fi
  while read -r pid; do
    [[ -n "$pid" && "$pid" != "$$" ]] || continue
    had=1; kill "$pid" 2>/dev/null || true
  done < <(pgrep -f "/bin/bash $INSTALL_DIR/autostart-linux.sh|bash $INSTALL_DIR/autostart-linux.sh" 2>/dev/null || true)
  if [[ "$had" == 1 ]]; then
    nohup /bin/bash "$INSTALL_DIR/autostart-linux.sh" >>"$INSTALL_DIR/var/autostart-launch.log" 2>&1 &
    log "SUPERVISOR_RECYCLE_PASS mode=process pid=$!"
  fi
}

promote_control(){
  local commit="$1" ref="$2" dirty resolved promoted
  dirty="$(git -C "$INSTALL_DIR" status --porcelain --untracked-files=no)"
  if [[ -n "$dirty" ]]; then
    if ! git -C "$INSTALL_DIR" diff --cached --quiet --; then
      log 'CONTROL_TRACKED_DIRTY_BLOCK reason=staged'
      echo 'control tracked dirty (staged)' >&2
      return 1
    fi
    if ! git -C "$INSTALL_DIR" diff --ignore-cr-at-eol --quiet --; then
      log 'CONTROL_TRACKED_DIRTY_BLOCK reason=substantive'
      echo 'control tracked dirty (substantive)' >&2
      return 1
    fi
    log 'CONTROL_EOL_DRIFT_TOLERATED'
  fi
  # The already-qualified staged checkout is the authoritative commit source.
  # Fetching ref from public origin is unsafe for private rollback refs and
  # can be indeterminate when the source history is shallow.
  [[ -n "$STAGE_DIR" && -d "$STAGE_DIR/.git" && ! -L "$STAGE_DIR" ]] || {
    echo 'control staged source unavailable' >&2; return 1;
  }
  local staged_head
  staged_head="$(git -C "$STAGE_DIR" rev-parse HEAD 2>/dev/null || true)"
  [[ "$staged_head" == "$commit" ]] || {
    echo 'control staged commit mismatch' >&2; return 1;
  }
  git -C "$INSTALL_DIR" fetch --update-shallow --no-tags "$STAGE_DIR" "$commit"
  resolved="$(git -C "$INSTALL_DIR" rev-parse 'FETCH_HEAD^{commit}' 2>/dev/null || true)"
  [[ "$resolved" == "$commit" ]] || { echo 'control commit mismatch' >&2; return 1; }
  git -C "$INSTALL_DIR" checkout --detach --force "$commit" >/dev/null
  promoted="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
  [[ "$promoted" == "$commit" ]] || { echo 'control promotion verification failed' >&2; return 1; }
  log "CONTROL_PROMOTION_PASS commit=$commit"
}

install_linux_gui_backend(){
  local project="$1" cfg="$2" enabled
  enabled="$(json_field "$project" "$cfg" powerMode.guiControl.enabled)"
  [[ "$enabled" == true ]] || return 0
  chmod +x "$project/tools/gui-control-linux.py" "$project/tools/install-gnome-gui-extension.sh"
  "$project/tools/install-gnome-gui-extension.sh"
  log "LINUX_GUI_BACKEND_SYNCED project=$project"
}

# A separately installed Control Center is not automatically updated by
# Core's git checkout. Only upgrade an existing owner-local GUI after
# accepted Core promotion. Preserve an independently tested rollback copy.
# A GUI defer is reported separately; it cannot falsely mark the GUI as ready
# or take the healthy Core offline.
upgrade_optional_linux_control_center(){
  local project="$1" data_root="${XDG_DATA_HOME:-$HOME/.local/share}" launcher installer result
  [[ "$NO_PROMOTE" != 1 ]] || { log 'LINUX_CONTROL_CENTER_UPGRADE_SKIP_NOPROMOTE'; return 0; }
  launcher="$data_root/applications/io.github.god13emad.RemoteCommander.ControlCenter.desktop"
  installer="$project/desktop/linux-control-center/install_user.py"
  [[ -f "$launcher" && -d "$data_root/remote-commander-control-center" ]] || {
    log 'LINUX_CONTROL_CENTER_UPGRADE_SKIP_NOT_INSTALLED'
    return 0
  }
  [[ -f "$installer" && ! -L "$installer" ]] || {
    log 'LINUX_CONTROL_CENTER_UPGRADE_DEFER_PACKAGE_MISSING'
    return 0
  }
  if ! command -v python3 >/dev/null 2>&1; then
    log 'LINUX_CONTROL_CENTER_UPGRADE_DEFER_PYTHON_MISSING'
    return 0
  fi
  if ! result="$(python3 -B "$installer" --install 2>/dev/null)"; then
    log 'LINUX_CONTROL_CENTER_UPGRADE_DEFER_INSTALL_FAILED'
    return 0
  fi
  case "$result" in
    LINUX_CONTROL_CENTER_INSTALL_PASS|LINUX_CONTROL_CENTER_ALREADY_CURRENT)
      log "LINUX_CONTROL_CENTER_UPGRADE_PASS status=$result" ;;
    *) log 'LINUX_CONTROL_CENTER_UPGRADE_DEFER_RECEIPT_INVALID' ;;
  esac
}

sync_work_plugin_projection(){
  local project="$1" version="$2" commit="$3"
  local template="$project/plugin-template"
  local data_root="${XDG_DATA_HOME:-$HOME/.local/share}"
  local plugin_root="$data_root/ChatGPTRemoteCommander/work-plugin/marketplace/plugins/chatgpt-remote-commander"
  local parent stage retired backup app_sha

  if [[ ! -d "$plugin_root" ]]; then
    log 'WORK_PLUGIN_SOURCE_SYNC_SKIP reason=not-installed'
    return 0
  fi
  [[ -f "$plugin_root/.app.json" && ! -L "$plugin_root/.app.json" ]] || {
    log 'WORK_PLUGIN_SOURCE_SYNC_BLOCK reason=invalid-app-binding-file'
    echo 'work plugin app binding is missing or unsafe' >&2
    return 1
  }
  [[ -f "$template/plugin.json" && -f "$template/.codex-plugin/plugin.json" ]] || {
    log 'WORK_PLUGIN_SOURCE_SYNC_BLOCK reason=missing-template'
    echo 'work plugin template is incomplete' >&2
    return 1
  }

  app_sha="$(sha256sum "$plugin_root/.app.json" | awk '{print $1}')"
  node --input-type=module - "$template" "$version" "$plugin_root/.app.json" <<'NODE'
import fs from 'node:fs';
const [, , template, expectedVersion, appPath] = process.argv;
const portable = JSON.parse(fs.readFileSync(template + '/plugin.json', 'utf8'));
const native = JSON.parse(fs.readFileSync(template + '/.codex-plugin/plugin.json', 'utf8'));
const app = JSON.parse(fs.readFileSync(appPath, 'utf8'));
const id = app?.apps?.['remote-commander']?.id ?? '';
if (portable.version !== expectedVersion || native.version !== expectedVersion) process.exit(2);
if (!/^(?:asdk_app_|connector_|templated_apps_)[A-Za-z0-9_-]+$/.test(id)) process.exit(3);
NODE

  parent="$(dirname "$plugin_root")"
  stage="$parent/.chatgpt-remote-commander.next-$$"
  retired="$parent/.chatgpt-remote-commander.prev-$$"
  backup="$BACKUP_ROOT/$commit/work-plugin/chatgpt-remote-commander"
  [[ ! -e "$stage" && ! -e "$retired" ]] || {
    log 'WORK_PLUGIN_SOURCE_SYNC_BLOCK reason=staging-collision'
    echo 'work plugin staging path collision' >&2
    return 1
  }

  # R234: refuse unsafe projections and retain at most one inactive predecessor.
  # A second update cannot silently multiply copies or erase rollback data.
  if [[ -L "$plugin_root" ]]; then
    log 'WORK_PLUGIN_SOURCE_SYNC_BLOCK reason=source-root-symlink'
    return 1
  fi
  local unsafe_node previous
  unsafe_node="$(find "$plugin_root" ! -type f ! -type d -print -quit)" || {
    log 'WORK_PLUGIN_SOURCE_SYNC_BLOCK reason=source-enumeration-unverified'
    return 1
  }
  [[ -z "$unsafe_node" ]] || {
    log 'WORK_PLUGIN_SOURCE_SYNC_BLOCK reason=unknown-special-node'
    return 1
  }
  for previous in "$parent"/.chatgpt-remote-commander.prev-* "$parent"/.chatgpt-remote-commander.failed-* "$parent"/.chatgpt-remote-commander.next-*; do
    if [[ -e "$previous" || -L "$previous" ]]; then
      log 'WORK_PLUGIN_SOURCE_SYNC_BLOCK reason=prior-snapshot-or-quarantine-awaiting-owner'
      return 1
    fi
  done

  mkdir -p "$stage"
  # Preserve unknown owner files in the newly active projection as well as
  # its separately retained predecessor. Only template-owned files are updated.
  cp -a "$plugin_root/." "$stage/"
  cp -a "$template/." "$stage/"
  cp -p "$plugin_root/.app.json" "$stage/.app.json"

  node --input-type=module - "$stage" "$version" <<'NODE'
import fs from 'node:fs';
const [, , root, expectedVersion] = process.argv;
const appPath = root + '/.app.json';
const portablePath = root + '/plugin.json';
const nativePath = root + '/.codex-plugin/plugin.json';
const app = JSON.parse(fs.readFileSync(appPath, 'utf8'));
const id = app?.apps?.['remote-commander']?.id ?? '';
if (!/^(?:asdk_app_|connector_|templated_apps_)[A-Za-z0-9_-]+$/.test(id)) process.exit(2);
const portable = JSON.parse(fs.readFileSync(portablePath, 'utf8'));
const native = JSON.parse(fs.readFileSync(nativePath, 'utf8'));
if (portable.version !== expectedVersion || native.version !== expectedVersion) process.exit(3);
portable.extensions ??= {};
portable.extensions['com.openai'] ??= {};
portable.extensions['com.openai'].apps = './.app.json';
portable.extensions['com.openai'].interface ??= {};
portable.extensions['com.openai'].interface.displayName = 'ChatGPT Remote Commander (Personal)';
portable.extensions['com.openai'].interface.shortDescription = 'Use your registered Remote Commander app';
native.apps = './.app.json';
fs.writeFileSync(portablePath, JSON.stringify(portable, null, 2) + '\n');
fs.writeFileSync(nativePath, JSON.stringify(native, null, 2) + '\n');
NODE

  if [[ ! -d "$backup" ]]; then
    mkdir -p "$(dirname "$backup")"
    cp -a "$plugin_root" "$backup"
    log "WORK_PLUGIN_SOURCE_BACKUP_PASS commit=$commit"
  fi

  if ! mv -T -- "$plugin_root" "$retired"; then
    log 'WORK_PLUGIN_SOURCE_SYNC_BLOCK reason=retire-rename-failed'
    return 1
  fi
  if ! mv -T -- "$stage" "$plugin_root"; then
    if ! mv -T -- "$retired" "$plugin_root"; then
      log 'WORK_PLUGIN_SOURCE_SYNC_BLOCK reason=rollback-restore-failed'
      return 1
    fi
    log 'WORK_PLUGIN_SOURCE_SYNC_BLOCK reason=swap-failed-previous-restored'
    return 1
  fi

  if ! node --input-type=module - "$plugin_root" "$version" "$app_sha" <<'NODE'
import crypto from 'node:crypto';
import fs from 'node:fs';
const [, , root, expectedVersion, expectedAppSha] = process.argv;
const portable = JSON.parse(fs.readFileSync(root + '/plugin.json', 'utf8'));
const native = JSON.parse(fs.readFileSync(root + '/.codex-plugin/plugin.json', 'utf8'));
const appBytes = fs.readFileSync(root + '/.app.json');
const app = JSON.parse(appBytes.toString('utf8'));
const id = app?.apps?.['remote-commander']?.id ?? '';
const appSha = crypto.createHash('sha256').update(appBytes).digest('hex');
if (portable.version !== expectedVersion || native.version !== expectedVersion) process.exit(2);
if (portable.extensions?.['com.openai']?.apps !== './.app.json') process.exit(3);
if (portable.extensions?.['com.openai']?.interface?.displayName !== 'ChatGPT Remote Commander (Personal)') process.exit(4);
if (portable.extensions?.['com.openai']?.interface?.shortDescription !== 'Use your registered Remote Commander app') process.exit(5);
if (native.apps !== './.app.json') process.exit(6);
if (!/^(?:asdk_app_|connector_|templated_apps_)[A-Za-z0-9_-]+$/.test(id)) process.exit(7);
if (appSha !== expectedAppSha) process.exit(8);
NODE
  then
    # No recursive deletion on failed promotion: preserve the candidate for
    # inspection and restore the exact previous tree.
    local failed="$parent/.chatgpt-remote-commander.failed-${BASHPID}-${RANDOM}-${RANDOM}"
    if [[ -e "$failed" || -L "$failed" ]] || ! mv -T -- "$plugin_root" "$failed"; then
      log 'WORK_PLUGIN_SOURCE_SYNC_BLOCK reason=failed-projection-quarantine'
      return 1
    fi
    if ! mv -T -- "$retired" "$plugin_root"; then
      log 'WORK_PLUGIN_SOURCE_SYNC_BLOCK reason=rollback-restore-failed'
      return 1
    fi
    log 'WORK_PLUGIN_SOURCE_SYNC_BLOCK reason=post-verify-failed'
    return 1
  fi

  # Exact prior tree remains a single inactive rollback snapshot until
  # separately documented owner acceptance; never silently retire it.
  log "WORK_PLUGIN_RETIREMENT_PENDING reason=OWNER_ACCEPTANCE_REQUIRED path=$retired"
  log "WORK_PLUGIN_SOURCE_SYNC_PASS version=$version"
}

cleanup_releases(){
  local route="$ROUTING_ROOT/default.json" active="" d remaining=0
  [[ -f "$route" ]] && active="$(route_tsv "$INSTALL_DIR" "$route" 2>/dev/null | awk -F '\t' '{print $8}')"
  for d in "$RELEASE_ROOT"/v*; do
    [[ -d "$d" ]] || continue
    if [[ -n "$active" && "$(readlink -f "$d")" == "$(readlink -f "$active")" ]]; then
      continue
    fi
    if retained_project_protected "$INSTALL_DIR" "$d"; then
      log "RELEASE_CLEANUP_RETAINED_PROTECT name=$(basename "$d")"
      continue
    fi
    # R205: unknown/dirty/unaccepted folders never get deleted.
    local retire_guard="$INSTALL_DIR/tools/release-retirement-gate-r205.mjs" verdict
    if [[ ! -f "$retire_guard" ]]; then
      log "RELEASE_RETIRE_DEFER name=$(basename "$d") reason=GUARD_NOT_INSTALLED"
      remaining=1; continue
    fi
    if ! verdict="$(node "$retire_guard" --state-root "$STATE_ROOT" --release-root "$RELEASE_ROOT" --candidate "$d" --install-dir "$INSTALL_DIR" 2>&1)"; then
      log "RELEASE_RETIRE_DEFER name=$(basename "$d") reason=GUARD_REJECTED evidence=$verdict"
      remaining=1; continue
    fi
    if [[ "$verdict" != *'"status":"ALLOW"'* ]]; then
      log "RELEASE_RETIRE_DEFER name=$(basename "$d") reason=INVALID_GUARD_RESULT"
      remaining=1; continue
    fi
    log "RELEASE_RETIRE_AUTHORIZED name=$(basename "$d")"
    if rm -rf -- "$d" && [[ ! -d "$d" ]]; then
      log "RELEASE_CLEANUP_PASS name=$(basename "$d")"
    else
      remaining=1
      log "RELEASE_CLEANUP_DEFER name=$(basename "$d")"
    fi
  done
  return "$remaining"
}

detach_from_commander_backend_if_needed

mkdir -p "$INSTALL_DIR/var"
exec 9>"$STATE_ROOT/auto-update.lock"
if command -v flock >/dev/null 2>&1; then flock -n 9 || { log 'AUTO_UPDATE_ALREADY_RUNNING'; exit 0; }; fi

if [[ "$SELF_TEST" == 1 ]]; then
  printf '{"ok":true,"installDir":"%s","stateRoot":"%s"}\n' "$INSTALL_DIR" "$STATE_ROOT"
  exit 0
fi

REF="$(latest_ref)"
IFS=$'\t' read -r COMMIT VERSION STAGE_DIR < <(stage_release "$REF")
ACTIVE_CFG="$(active_config "$STAGE_DIR")"
AUTO_ENABLED="$(json_field "$STAGE_DIR" "$ACTIVE_CFG" autoUpdate.enabled)"
if [[ "$FORCE" != 1 && "$AUTO_ENABLED" != true ]]; then log 'AUTO_UPDATE_DISABLED'; exit 0; fi

ROUTE="$ROUTING_ROOT/default.json"
if [[ "$FORCE" != 1 && -f "$ROUTE" ]]; then
  IFS=$'\t' read -r _ _ _ ACTIVE_VERSION ACTIVE_COMMIT _ _ _ < <(route_tsv "$STAGE_DIR" "$ROUTE")
  if version_gt "$ACTIVE_VERSION" "$VERSION"; then
    log "AUTO_UPDATE_NEWER_CURRENT current=$ACTIVE_VERSION latest=$VERSION"
    exit 0
  fi
  if [[ "$ACTIVE_COMMIT" == "$COMMIT" ]]; then
    CONTROL="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
    PREV_PORT="$(json_field "$STAGE_DIR" "$ROUTE" previous.port)"
    PREV_CFG="$(json_field "$STAGE_DIR" "$ROUTE" previous.configPath)"
    PREV_PROJECT="$(json_field "$STAGE_DIR" "$ROUTE" previous.projectDir)"
    if [[ -n "$PREV_PORT" && -n "$PREV_CFG" ]] && ! drain_previous_once "$STAGE_DIR" "$PREV_PORT" "$PREV_CFG" "$PREV_PROJECT"; then
      [[ "$CONTROL" == "$COMMIT" ]] || promote_control "$COMMIT" "$REF"
      log 'AUTO_UPDATE_DRAIN_PENDING profile=default'
      exit 0
    fi
    if [[ "$CONTROL" != "$COMMIT" ]]; then
      LIVE_WF="$(json_field "$STAGE_DIR" "$ACTIVE_CFG" durableWorkflows.directory)"
      [[ -z "$LIVE_WF" ]] || node "$STAGE_DIR/tools/finalize-workflow-schema.mjs" --directory "$LIVE_WF"
      promote_control "$COMMIT" "$REF"
      install_linux_gui_backend "$STAGE_DIR" "$ACTIVE_CFG"
      upgrade_optional_linux_control_center "$STAGE_DIR"
      sync_work_plugin_projection "$STAGE_DIR" "$VERSION" "$COMMIT"
      cleanup_releases || log 'AUTO_UPDATE_CLEANUP_PENDING_AFTER_MAINTENANCE'
      write_update_result maintenance_pass "$VERSION" "$COMMIT" "$REF"
      log "AUTO_UPDATE_MAINTENANCE_PASS version=$VERSION"
      recycle_supervisor
      exit 0
    fi
    if has_superseded_release; then
      if ! cleanup_releases; then
        log 'AUTO_UPDATE_CLEANUP_PENDING'
        exit 0
      fi
    fi
    upgrade_optional_linux_control_center "$STAGE_DIR"
    log "AUTO_UPDATE_CURRENT version=$VERSION"
    exit 0
  fi
fi

CANDIDATE_PID=""
validation_cleanup(){
  local rc=$?
  if [[ -n "$CANDIDATE_PID" ]]; then stop_owned_candidate "$CANDIDATE_PID" "$STAGE_DIR" || true; fi
  CANDIDATE_PID=""
  exit "$rc"
}
trap validation_cleanup ERR

run_gate "$STAGE_DIR" linux-gui-safety node tools/linux-gui-safety-audit.mjs
run_gate "$STAGE_DIR" check npm run check:qualification
run_gate "$STAGE_DIR" test npm run test:qualification
ensure_complete_audit_history "$STAGE_DIR" "$COMMIT"
run_gate "$STAGE_DIR" audit npm run audit

PORT="$(node "$STAGE_DIR/tools/find-free-port.mjs" --start 48831 --end 51999)"
STATE_DIR="$RUNTIME_ROOT/$COMMIT/default"
mkdir -p "$STATE_DIR" "$BACKUP_ROOT/$COMMIT/default"
cp -f "$ACTIVE_CFG" "$BACKUP_ROOT/$COMMIT/default/config.before.json"
LIVE_WF="$(json_field "$STAGE_DIR" "$ACTIVE_CFG" durableWorkflows.directory)"
[[ -n "$LIVE_WF" ]] || LIVE_WF="$STATE_ROOT/instances/default/workflows"
SHADOW_WF="$BACKUP_ROOT/$COMMIT/default/workflow-shadow"
node "$STAGE_DIR/tools/copy-workflow-store.mjs" --source-dir "$LIVE_WF" --dest-dir "$SHADOW_WF"

ensure_project_provider "$STAGE_DIR" "$ACTIVE_CFG"
ensure_browser_backend "$STAGE_DIR" "$ACTIVE_CFG"

MODE=preserve
[[ "$POWER_MODE" == 1 ]] && MODE=full
[[ "$STANDARD_MODE" == 1 ]] && MODE=standard
build_cfg(){
  local output="$1" wf="$2" delivery_mode="${3:-preserve}"
  local args=("$STAGE_DIR/tools/build-candidate-config.mjs" --default "$STAGE_DIR/config.json" --existing "$ACTIVE_CFG" --output "$output" --profile-id default --port "$PORT" --state-dir "$STATE_DIR" --workflow-dir "$wf" --mode "$MODE" --provider-root "$STATE_ROOT")
  if [[ "$delivery_mode" == shadow ]]; then
    args+=(--delivery-directory "$BACKUP_ROOT/$COMMIT/default/delivery-shadow-$PORT" --delivery-scope "diagnostic-${COMMIT:0:32}-$PORT")
  fi
  [[ -z "$BROWSER_EXECUTABLE" ]] || args+=(--browser-executable "$BROWSER_EXECUTABLE")
  [[ -z "$BROWSER_PROFILE_ROOT" ]] || args+=(--browser-profile-root "$BROWSER_PROFILE_ROOT")
  local c
  for c in "${DISABLE_CAPS[@]}"; do args+=(--disable-capability "$c"); done
  for c in "${ENABLE_CAPS[@]}"; do args+=(--enable-capability "$c"); done
  node "${args[@]}"
}

DIAG_CFG="$STATE_DIR/diagnostic-config.json"
build_cfg "$DIAG_CFG" "$SHADOW_WF" shadow >/dev/null
DIAG_SHA="$(sha256sum "$DIAG_CFG" | awk '{print $1}')"
CANDIDATE_PID="$(start_backend "$STAGE_DIR" "$DIAG_CFG" "$STATE_DIR/diagnostic.log")"
wait_health "$PORT" "$VERSION" "$DIAG_SHA" default || { stop_pid "$CANDIDATE_PID"; echo 'diagnostic health failed' >&2; exit 1; }
node "$STAGE_DIR/tools/doctor.mjs" --url "http://127.0.0.1:$PORT/mcp" --expected-version "$VERSION" --config "$DIAG_CFG" --json
node "$STAGE_DIR/tools/hardware-selftest.mjs" --url "http://127.0.0.1:$PORT/mcp" --config "$DIAG_CFG" --expected-version "$VERSION"
stop_owned_candidate "$CANDIDATE_PID" "$STAGE_DIR"
CANDIDATE_PID=""

FINAL_CFG="$STATE_DIR/config.json"
build_cfg "$FINAL_CFG" "$LIVE_WF" preserve >/dev/null
FINAL_SHA="$(sha256sum "$FINAL_CFG" | awk '{print $1}')"
CANDIDATE_PID="$(start_backend "$STAGE_DIR" "$FINAL_CFG" "$STATE_DIR/server.log")"
wait_health "$PORT" "$VERSION" "$FINAL_SHA" default || { stop_pid "$CANDIDATE_PID"; echo 'final candidate health failed' >&2; exit 1; }
node "$STAGE_DIR/tools/doctor.mjs" --url "http://127.0.0.1:$PORT/mcp" --expected-version "$VERSION" --config "$FINAL_CFG" --json
node "$STAGE_DIR/tools/hardware-selftest.mjs" --url "http://127.0.0.1:$PORT/mcp" --config "$FINAL_CFG" --expected-version "$VERSION"

if [[ "$NO_PROMOTE" == 1 ]]; then stop_owned_candidate "$CANDIDATE_PID" "$STAGE_DIR"; CANDIDATE_PID=""; trap - ERR; log 'AUTO_UPDATE_CANDIDATE_PASS'; exit 0; fi

if [[ -f "$ROUTE" ]]; then
  SCHEMA_OLD_PORT="$(json_field "$STAGE_DIR" "$ROUTE" active.port)"
  if [[ -n "$SCHEMA_OLD_PORT" ]]; then
    set +e
    SCHEMA_PRE="$(node "$STAGE_DIR/tools/schema-continuity-gate.mjs" --old-url "http://127.0.0.1:$SCHEMA_OLD_PORT/mcp" --candidate-url "http://127.0.0.1:$PORT/mcp" --router-url "http://127.0.0.1:47831/router/status" 2>/dev/null)"
    set -e
    SCHEMA_CHANGED="$(node -e 'try{const x=JSON.parse(process.argv[1]);process.stdout.write(x.changed===true?"true":"false")}catch{process.stdout.write("false")}' "$SCHEMA_PRE")"
    BOOTSTRAP="$(node "$STAGE_DIR/tools/router-source-bootstrap.mjs" --url http://127.0.0.1:47831/router/status --state "$ROUTE" --runtime "$ROUTING_ROOT/default.runtime.json" --candidate-source "$STAGE_DIR/src/stable-router.mjs" --log "$STATE_ROOT/router.log")"
    ROUTER_CHANGED="$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(x.changed===true?"true":"false")' "$BOOTSTRAP")"
    if [[ "$ROUTER_CHANGED" == true && "$SCHEMA_CHANGED" == true ]]; then
      stop_owned_candidate "$CANDIDATE_PID" "$STAGE_DIR"
      CANDIDATE_PID=""
      trap - ERR
      log 'AUTO_UPDATE_ROUTER_BOOTSTRAPPED_RETRY_REQUIRED profile=default'
      exit 0
    fi
    if ! node "$STAGE_DIR/tools/schema-continuity-gate.mjs" --old-url "http://127.0.0.1:$SCHEMA_OLD_PORT/mcp" --candidate-url "http://127.0.0.1:$PORT/mcp" --router-url "http://127.0.0.1:47831/router/status"; then
      echo 'SCHEMA_CONTINUITY_GATE_FAIL profile=default' >&2
      exit 1
    fi
    log 'SCHEMA_CONTINUITY_GATE_PASS profile=default'
  fi
fi

if [[ -f "$ROUTE" ]]; then
  EXISTING_PREV_PORT="$(json_field "$STAGE_DIR" "$ROUTE" previous.port)"
  EXISTING_PREV_CFG="$(json_field "$STAGE_DIR" "$ROUTE" previous.configPath)"
  EXISTING_PREV_PROJECT="$(json_field "$STAGE_DIR" "$ROUTE" previous.projectDir)"
  if [[ -n "$EXISTING_PREV_PORT" && -n "$EXISTING_PREV_CFG" ]] && ! drain_previous_once "$STAGE_DIR" "$EXISTING_PREV_PORT" "$EXISTING_PREV_CFG" "$EXISTING_PREV_PROJECT"; then
    stop_owned_candidate "$CANDIDATE_PID" "$STAGE_DIR"
    CANDIDATE_PID=""
    trap - ERR
    log 'AUTO_UPDATE_EXISTING_DRAIN_BLOCK profile=default'
    exit 0
  fi
fi

if [[ -f "$ROUTE" ]]; then
  LIVE_ROUTE_CFG=""
  LIVE_ROUTE_PROJECT=""
  IFS=$'\t' read -r _ _ _ _ _ _ LIVE_ROUTE_CFG LIVE_ROUTE_PROJECT < <(route_tsv "$STAGE_DIR" "$ROUTE")
  TERMINAL_PIDS="$(persistent_terminal_pids "$STAGE_DIR" "$LIVE_ROUTE_CFG" "$LIVE_ROUTE_PROJECT" | paste -sd, -)"
  if [[ -n "$TERMINAL_PIDS" ]]; then
    log "AUTO_UPDATE_ACTIVE_TERMINALS_PRESERVE profile=default pids=$TERMINAL_PIDS"
  fi
fi

trap - ERR
CUTOVER_COMMITTED=0
ROUTE_BACKUP="$BACKUP_ROOT/$COMMIT/default/route.before.json"
INITIAL_MIGRATION=0
OLD_CFG=""
OLD_PROJECT=""
OLD_PORT=""
ROUTER_PID=""
rollback(){
  local rc=$?
  if [[ "$CUTOVER_COMMITTED" == 0 ]]; then
    stop_pid "$CANDIDATE_PID" || true
    if [[ "$INITIAL_MIGRATION" == 1 ]]; then
      [[ -z "$ROUTER_PID" ]] || stop_pid "$ROUTER_PID" || true
      rm -f "$ROUTE"
      if [[ -n "$OLD_CFG" && -f "$OLD_CFG" ]]; then
        OLD_PID="$(start_backend "$INSTALL_DIR" "$OLD_CFG" "$INSTALL_DIR/var/mcp-rollback.log")"
        log "AUTO_UPDATE_ROLLBACK_DIRECT pid=$OLD_PID"
      fi
    elif [[ -f "$ROUTE_BACKUP" ]]; then
      cp -f "$ROUTE_BACKUP" "$ROUTE"
    fi
  else
    log 'AUTO_UPDATE_POST_COMMIT_MAINTENANCE_REQUIRED'
  fi
  exit "$rc"
}
trap rollback ERR

if [[ -f "$ROUTE" ]]; then
  cp -f "$ROUTE" "$ROUTE_BACKUP"
  IFS=$'\t' read -r _ _ OLD_PORT _ _ _ OLD_CFG OLD_PROJECT < <(route_tsv "$STAGE_DIR" "$ROUTE")
  GENERATION="$(json_field "$STAGE_DIR" "$ROUTE" generation)"
  node "$STAGE_DIR/tools/router-switch.mjs" --state "$ROUTE" --expected-generation "$GENERATION" --profile default --port "$PORT" --version "$VERSION" --commit "$COMMIT" --config-sha "$FINAL_SHA" --config-path "$FINAL_CFG" --project-dir "$STAGE_DIR"
else
  INITIAL_MIGRATION=1
  OLD_CFG="$ACTIVE_CFG"; OLD_PROJECT="$INSTALL_DIR"
  stop_owned_from_config "$STAGE_DIR" "$OLD_CFG" "$INSTALL_DIR"
  node "$STAGE_DIR/tools/router-init.mjs" --state "$ROUTE" --profile default --port "$PORT" --version "$VERSION" --commit "$COMMIT" --config-sha "$FINAL_SHA" --config-path "$FINAL_CFG" --project-dir "$STAGE_DIR"
  ROUTER_PID="$(start_router "$STAGE_DIR" "$ROUTE" "$STATE_ROOT/router.log")"
  wait_router || { echo 'router startup failed' >&2; false; }
fi

node "$STAGE_DIR/tools/doctor.mjs" --url http://127.0.0.1:47831/mcp --expected-version "$VERSION" --config "$FINAL_CFG" --json
node "$STAGE_DIR/tools/hardware-selftest.mjs" --url http://127.0.0.1:47831/mcp --config "$FINAL_CFG" --expected-version "$VERSION"
tunnels_ready || { echo 'tunnel readiness failed' >&2; false; }
CUTOVER_COMMITTED=1
log "CUTOVER_COMMIT version=$VERSION commit=$COMMIT"

if [[ -n "$OLD_PORT" ]]; then
  deadline=$(( $(date +%s) + DRAIN_TIMEOUT ))
  while (( $(date +%s) < deadline )); do
    n="$(node "$STAGE_DIR/tools/router-status.mjs" --url http://127.0.0.1:47831/router/status --port "$OLD_PORT" 2>/dev/null || echo 1)"
    [[ "$n" == 0 ]] && break
    sleep 0.25
  done
  if ! drain_previous_once "$STAGE_DIR" "$OLD_PORT" "$OLD_CFG" "$OLD_PROJECT"; then
    promote_control "$COMMIT" "$REF"
    log 'AUTO_UPDATE_DRAIN_PENDING profile=default'
    exit 0
  fi
fi

node "$STAGE_DIR/tools/finalize-workflow-schema.mjs" --directory "$LIVE_WF"
install_linux_gui_backend "$STAGE_DIR" "$FINAL_CFG"
promote_control "$COMMIT" "$REF"
upgrade_optional_linux_control_center "$STAGE_DIR"
sync_work_plugin_projection "$STAGE_DIR" "$VERSION" "$COMMIT"
cleanup_releases || log 'AUTO_UPDATE_CLEANUP_PENDING_AFTER_PROMOTION'
write_update_result pass "$VERSION" "$COMMIT" "$REF"
log "AUTO_UPDATE_PASS version=$VERSION commit=$COMMIT"
recycle_supervisor
