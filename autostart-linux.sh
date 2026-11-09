#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_BIN="$ROOT/.runtime/node-current/bin"
[[ -x "$RUNTIME_BIN/node" ]] && export PATH="$RUNTIME_BIN:$PATH"
VAR_DIR="$ROOT/var"
CFG_BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
PROFILE_DIR="$CFG_BASE/tunnel-client"
CRED_DIR="$CFG_BASE/chatgpt-remote-commander/credentials"
INTERVAL="${REMOTE_COMMANDER_SUPERVISOR_INTERVAL:-5}"
mkdir -p "$VAR_DIR" "$CRED_DIR"
chmod 700 "$CRED_DIR" 2>/dev/null || true

require_runtime() {
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && return 0
  log "RUNTIME_MISSING node=$(command -v node 2>/dev/null || echo missing) npm=$(command -v npm 2>/dev/null || echo missing)"
  return 1
}

log() {
  printf '%s %s\n' "$(date --iso-8601=seconds 2>/dev/null || date)" "$*" >> "$VAR_DIR/autostart.log"
}

exec 9>"$VAR_DIR/autostart-linux.lock"
if command -v flock >/dev/null 2>&1; then
  flock -n 9 || exit 0
fi

mcp_healthy() {
  curl -fsS --max-time 2 http://127.0.0.1:47831/health 2>/dev/null | grep -q '"ok"[[:space:]]*:[[:space:]]*true'
}

safe_profile() {
  printf '%s' "$1" | sed 's/[^A-Za-z0-9._-]/_/g'
}

candidate_tunnels() {
  find "$ROOT/tools" -maxdepth 2 -type f -path "$ROOT/tools/tunnel-client-v*-linux-*/tunnel-client" 2>/dev/null | sort -V
}

rejected_tunnel_file() {
  printf '%s/tunnel-rejected-%s.path\n' "$VAR_DIR" "$(safe_profile "$1")"
}

find_tunnel() {
  local profile="${1:-default}" rejected="" f
  local reject_file
  reject_file="$(rejected_tunnel_file "$profile")"
  [[ -f "$reject_file" ]] && rejected="$(cat "$reject_file" 2>/dev/null || true)"
  mapfile -t candidates < <(candidate_tunnels)
  for ((i=${#candidates[@]}-1; i>=0; i--)); do
    f="${candidates[$i]}"
    [[ -x "$f" ]] || continue
    [[ -n "$rejected" && "$f" == "$rejected" ]] && continue
    printf '%s\n' "$f"
    return 0
  done
  command -v tunnel-client
}

fallback_tunnel() {
  local desired="$1" f
  mapfile -t candidates < <(candidate_tunnels)
  for ((i=${#candidates[@]}-1; i>=0; i--)); do
    f="${candidates[$i]}"
    [[ -x "$f" && "$f" != "$desired" ]] || continue
    printf '%s\n' "$f"
    return 0
  done
  return 1
}

start_mcp() {
  mcp_healthy && return 0
  (
    cd "$ROOT"
    nohup npm start --silent >> "$VAR_DIR/mcp-autostart.out.log" 2>> "$VAR_DIR/mcp-autostart.err.log" &
  )
  for _ in $(seq 1 30); do
    sleep 0.5
    if mcp_healthy; then log 'MCP_STARTED'; return 0; fi
  done
  log 'MCP_START_TIMEOUT'
  return 1
}

profile_matches() {
  local file="$1"
  grep -q 'http://127\.0\.0\.1:47831/mcp' "$file"
}

profile_health_port() {
  local file="$1" value
  value="$(sed -nE 's/.*listen_addr:[[:space:]]*["'\''"]?127\.0\.0\.1:([0-9]+).*/\1/p' "$file" | head -n1)"
  [[ "$value" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$value"
}

tunnel_ready() {
  local port="$1"
  [[ "$port" =~ ^[0-9]+$ && "$port" -gt 0 ]] || return 1
  [[ "$(curl -fsS --max-time 2 "http://127.0.0.1:$port/readyz" 2>/dev/null || true)" == "ready" ]]
}

network_route_present() {
  command -v ip >/dev/null 2>&1 || return 0
  ip route show default 2>/dev/null | grep -q .
}

control_plane_fresh() {
  local port="$1" limit="${REMOTE_COMMANDER_TUNNEL_STALE_SECONDS:-90}" metrics last started now base
  [[ "$limit" =~ ^[1-9][0-9]{1,3}$ ]] || limit=90
  metrics="$(curl -fsS --max-time 2 "http://127.0.0.1:$port/metrics" 2>/dev/null || true)"
  [[ -n "$metrics" ]] || return 0
  last="$(printf '%s\n' "$metrics" | awk '/^commands_poll_last_successful_timestamp_seconds([{ ]|$)/{print $NF;exit}')"
  started="$(printf '%s\n' "$metrics" | awk '/^process_start_time_seconds([{ ]|$)/{print $NF;exit}')"
  now="$(date +%s)"
  base="$last"
  awk -v v="$base" 'BEGIN{exit !((v+0)>0)}' || base="$started"
  [[ -n "$base" ]] || return 0
  awk -v n="$now" -v b="$base" -v l="$limit" 'BEGIN{age=n-b; exit !((age>=0)&&(age<=l))}'
}

cred_path() {
  local profile="$1"
  printf '%s/%s.key\n' "$CRED_DIR" "$(safe_profile "$profile")"
}

profile_tunnel_rows() {
  local profile="$1" pid exe verb flag value rest
  while read -r pid exe verb flag value rest; do
    [[ -n "$pid" && -n "$exe" ]] || continue
    [[ "$verb" == "run" && "$flag" == "--profile" && "$value" == "$profile" ]] || continue
    printf '%s\t%s\n' "$pid" "$exe"
  done < <(ps -eo pid=,args= 2>/dev/null)
}

owned_tunnel_exe() {
  local exe="$1"
  [[ "$exe" == "$ROOT"/tools/tunnel-client-v*-linux-*/tunnel-client ]]
}

stop_owned_profile_tunnels() {
  local profile="$1" pid exe
  while IFS=$'\t' read -r pid exe; do
    [[ -n "$pid" ]] || continue
    owned_tunnel_exe "$exe" || continue
    kill "$pid" 2>/dev/null || true
  done < <(profile_tunnel_rows "$profile")
  for _ in $(seq 1 20); do
    local remaining=0
    while IFS=$'\t' read -r pid exe; do
      [[ -n "$pid" ]] || continue
      owned_tunnel_exe "$exe" && remaining=$((remaining+1))
    done < <(profile_tunnel_rows "$profile")
    (( remaining == 0 )) && return 0
    sleep 0.25
  done
  while IFS=$'\t' read -r pid exe; do
    [[ -n "$pid" ]] || continue
    owned_tunnel_exe "$exe" || continue
    kill -9 "$pid" 2>/dev/null || true
  done < <(profile_tunnel_rows "$profile")
}

STARTED_TUNNEL_PID=""
launch_tunnel_with_exe() {
  local profile="$1" cred="$2" exe="$3" log_file status_file runner
  [[ -f "$cred" ]] || return 1
  [[ -x "$exe" ]] || return 1
  chmod 600 "$cred" 2>/dev/null || true
  log_file="$VAR_DIR/tunnel-$(safe_profile "$profile").log"
  status_file="$VAR_DIR/tunnel-$(safe_profile "$profile").log.rotation.json"
  runner="$ROOT/tools/tunnel-log-runner.mjs"
  [[ -f "$runner" ]] || { log "TUNNEL_LOG_RUNNER_MISSING profile=$profile"; return 1; }
  env -u OPENAI_API_KEY CONTROL_PLANE_API_KEY="$(cat "$cred")"     nohup node "$runner"       --log-file "$log_file"       --status-file "$status_file"       --max-bytes 8388608       --max-files 3       -- "$exe" run --profile "$profile" --profile-dir "$PROFILE_DIR" --log.file stdout >/dev/null 2>&1 &
  STARTED_TUNNEL_PID=$!
  log "TUNNEL_STARTED profile=$profile pid=$STARTED_TUNNEL_PID exe=$exe logRotation=8MiB/3"
}

wait_tunnel_ready() {
  local port="$1" pid="$2"
  for _ in $(seq 1 50); do
    sleep 0.2
    tunnel_ready "$port" && return 0
    kill -0 "$pid" 2>/dev/null || return 1
  done
  return 1
}

start_tunnel() {
  local profile="$1" cred="$2" profile_file="$3"
  local desired health reject_file previous="" pid exe fallback external=0
  [[ -f "$cred" ]] || { log "CREDENTIAL_MISSING profile=$profile"; return 0; }
  health="$(profile_health_port "$profile_file" 2>/dev/null || true)"
  [[ -n "$health" ]] || { log "TUNNEL_HEALTH_PORT_MISSING profile=$profile"; return 1; }
  desired="$(find_tunnel "$profile" 2>/dev/null || true)"
  [[ -n "$desired" && -x "$desired" ]] || { log "TUNNEL_CLIENT_MISSING profile=$profile"; return 1; }
  reject_file="$(rejected_tunnel_file "$profile")"

  while IFS=$'\t' read -r pid exe; do
    [[ -n "$pid" ]] || continue
    if ! owned_tunnel_exe "$exe"; then
      external=$((external+1))
      continue
    fi
    [[ "$exe" == "$desired" ]] || [[ -n "$previous" ]] || previous="$exe"
    if [[ "$exe" == "$desired" ]] && tunnel_ready "$health"; then
      if control_plane_fresh "$health"; then
        # Preserve rejected candidate quarantine while fallback is healthy.
        return 0
      fi
      if ! network_route_present; then
        return 0
      fi
      log "TUNNEL_CONTROL_PLANE_STALE profile=$profile port=$health exe=$desired"
    fi
  done < <(profile_tunnel_rows "$profile")

  if (( external > 0 )); then
    log "TUNNEL_EXTERNAL_PROFILE_CONFLICT profile=$profile count=$external"
    return 1
  fi

  stop_owned_profile_tunnels "$profile"
  for _ in $(seq 1 20); do
    tunnel_ready "$health" || break
    sleep 0.25
  done

  STARTED_TUNNEL_PID=""
  if launch_tunnel_with_exe "$profile" "$cred" "$desired" && wait_tunnel_ready "$health" "$STARTED_TUNNEL_PID"; then
    # Keep rejected candidate quarantined after fallback succeeds.
    log "TUNNEL_READY profile=$profile pid=$STARTED_TUNNEL_PID port=$health exe=$desired"
    return 0
  fi

  [[ -n "$STARTED_TUNNEL_PID" ]] && kill "$STARTED_TUNNEL_PID" 2>/dev/null || true
  printf '%s\n' "$desired" > "$reject_file"
  log "TUNNEL_CANDIDATE_REJECTED profile=$profile exe=$desired"

  fallback="$previous"
  [[ -n "$fallback" && -x "$fallback" ]] || fallback="$(fallback_tunnel "$desired" 2>/dev/null || true)"
  if [[ -n "$fallback" && -x "$fallback" ]]; then
    STARTED_TUNNEL_PID=""
    if launch_tunnel_with_exe "$profile" "$cred" "$fallback" && wait_tunnel_ready "$health" "$STARTED_TUNNEL_PID"; then
      log "TUNNEL_ROLLBACK_PASS profile=$profile pid=$STARTED_TUNNEL_PID port=$health exe=$fallback"
      return 0
    fi
  fi

  log "TUNNEL_ROLLBACK_FAIL profile=$profile"
  return 1
}

. "$ROOT/supervisor-routing-linux.sh"

require_runtime || exit 1
log "SUPERVISOR_STARTED pid=$$ root=$ROOT"
while true; do
  if ensure_routed_default || start_mcp; then
    if [[ -d "$PROFILE_DIR" ]]; then
      while IFS= read -r -d '' file; do
        profile_matches "$file" || continue
        profile="$(basename "$file" .yaml)"
        start_tunnel "$profile" "$(cred_path "$profile")" "$file" || true
      done < <(find "$PROFILE_DIR" -maxdepth 1 -type f -name '*.yaml' -print0 2>/dev/null)
    fi
  fi
  start_auto_update_if_due || true
  sleep "$INTERVAL"
done
