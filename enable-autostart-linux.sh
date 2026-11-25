#!/usr/bin/env bash
set -euo pipefail
PROFILE="chatgpt-remote-commander"
TUNNEL_ID=""
HEALTH_PORT=0
NO_START=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --tunnel-id) TUNNEL_ID="$2"; shift 2 ;;
    --health-port) HEALTH_PORT="$2"; shift 2 ;;
    --no-start) NO_START=1; shift ;;
    -h|--help)
      echo "Usage: $0 [--profile NAME] [--tunnel-id ID] [--health-port PORT] [--no-start]"
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_BIN="$ROOT/.runtime/node-current/bin"
[[ -x "$RUNTIME_BIN/node" ]] && export PATH="$RUNTIME_BIN:$PATH"
CFG_BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
PROFILE_DIR="$CFG_BASE/tunnel-client"
PROFILE_FILE="$PROFILE_DIR/$PROFILE.yaml"
CRED_DIR="$CFG_BASE/chatgpt-remote-commander/credentials"
SAFE_PROFILE="$(printf '%s' "$PROFILE" | sed 's/[^A-Za-z0-9._-]/_/g')"
CRED_FILE="$CRED_DIR/$SAFE_PROFILE.key"
MCP_URL='http://127.0.0.1:47831/mcp'
find_tunnel() {
  local f
  f="$(find "$ROOT/tools" -type f -name tunnel-client 2>/dev/null | sort -r | head -n1)"
  if [[ -n "$f" ]]; then printf '%s\n' "$f"; return 0; fi
  command -v tunnel-client
}

free_port() {
  local p
  for p in $(seq 47832 47931); do
    if ! (echo >/dev/tcp/127.0.0.1/$p) >/dev/null 2>&1; then
      printf '%s\n' "$p"; return 0
    fi
  done
  return 1
}

mcp_healthy() {
  curl -fsS --max-time 2 http://127.0.0.1:47831/health 2>/dev/null | grep -q '"ok"[[:space:]]*:[[:space:]]*true'
}
ensure_mcp() {
  mcp_healthy && return 0
  mkdir -p "$ROOT/var"
  (
    cd "$ROOT"
    nohup npm start --silent >> "$ROOT/var/mcp-connect.out.log" 2>> "$ROOT/var/mcp-connect.err.log" &
  )
  for _ in $(seq 1 30); do
    sleep 0.5
    if mcp_healthy; then
      echo 'MCP was not running; it has been started automatically.'
      return 0
    fi
  done
  echo 'Remote Commander MCP did not become healthy on 127.0.0.1:47831. Check var/mcp-connect.err.log.' >&2
  return 1
}
/bin/bash "$ROOT/tools/install-tunnel-client-linux.sh" --install-dir "$ROOT"
ensure_mcp

TUNNEL_EXE="$(find_tunnel)" || { echo 'tunnel-client not found; run install.sh first.' >&2; exit 1; }
mkdir -p "$CRED_DIR"
chmod 700 "$CRED_DIR"

if [[ ! -f "$PROFILE_FILE" ]]; then
  [[ -n "$TUNNEL_ID" ]] || { read -r -p 'Paste OpenAI tunnel_id: ' TUNNEL_ID; }
  [[ "$TUNNEL_ID" =~ ^tunnel_[0-9a-f]{32}$ ]] || { echo 'Invalid tunnel_id format.' >&2; exit 1; }
  [[ "$HEALTH_PORT" -ne 0 ]] || HEALTH_PORT="$(free_port)"
elif [[ "$HEALTH_PORT" -eq 0 ]]; then
  HEALTH_PORT="$(sed -nE 's/.*listen_addr:[[:space:]]*"?127\.0\.0\.1:([0-9]+).*/\1/p' "$PROFILE_FILE" | head -n1)"
  HEALTH_PORT="${HEALTH_PORT:-0}"
fi

if [[ -f "$CRED_FILE" ]]; then
  RUNTIME_KEY="$(cat "$CRED_FILE")"
  echo "Reusing existing local credential for profile $PROFILE."
else
  read -r -s -p 'Paste Runtime API key once (stored in a user-only local file): ' RUNTIME_KEY
  echo
  [[ -n "$RUNTIME_KEY" ]] || { echo 'Runtime API key is empty.' >&2; exit 1; }
  printf '%s' "$RUNTIME_KEY" > "$CRED_FILE"
  chmod 600 "$CRED_FILE"
fi

export CONTROL_PLANE_API_KEY="$RUNTIME_KEY"
unset OPENAI_API_KEY || true
if [[ ! -f "$PROFILE_FILE" ]]; then
  "$TUNNEL_EXE" init --sample sample_mcp_remote_no_auth --profile "$PROFILE" \
    --tunnel-id "$TUNNEL_ID" --mcp-server-url "$MCP_URL" \
    --health-listen-addr "127.0.0.1:$HEALTH_PORT" --force
fi
READY=0
if [[ "$HEALTH_PORT" -gt 0 ]]; then
  if [[ "$(curl -fsS --max-time 2 "http://127.0.0.1:$HEALTH_PORT/readyz" 2>/dev/null || true)" == "ready" ]]; then
    READY=1
  fi
fi
if [[ "$READY" -eq 1 ]]; then
  echo "Existing tunnel profile $PROFILE is already ready on health port $HEALTH_PORT; doctor bind check skipped."
else
  "$TUNNEL_EXE" doctor --profile "$PROFILE" --explain
fi
unset CONTROL_PLANE_API_KEY
RUNTIME_KEY=''

chmod +x "$ROOT/autostart-linux.sh"
UNIT_DIR="$CFG_BASE/systemd/user"
UNIT_FILE="$UNIT_DIR/chatgpt-remote-commander.service"
REGISTERED=0
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  LINGER_STATUS="unsupported"
  if command -v loginctl >/dev/null 2>&1; then
    if loginctl enable-linger "$USER" >/dev/null 2>&1; then
      LINGER_STATUS="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)"
      [[ "$LINGER_STATUS" == "yes" ]] || LINGER_STATUS="unverified"
    else
      LINGER_STATUS="failed"
    fi
  fi
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=ChatGPT Remote Commander supervisor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/bin/bash $ROOT/autostart-linux.sh
Restart=always
RestartSec=5
Environment="PATH=$RUNTIME_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable chatgpt-remote-commander.service >/dev/null
  [[ "$NO_START" -eq 1 ]] || systemctl --user restart chatgpt-remote-commander.service
  REGISTERED=1
elif command -v crontab >/dev/null 2>&1; then
  LINE="@reboot /bin/bash '$ROOT/autostart-linux.sh' >> '$ROOT/var/autostart-launch.log' 2>&1 &"
  { crontab -l 2>/dev/null | grep -v 'autostart-linux.sh' || true; echo "$LINE"; } | crontab -
  REGISTERED=1
  if [[ "$NO_START" -ne 1 ]]; then
    nohup /bin/bash "$ROOT/autostart-linux.sh" >> "$ROOT/var/autostart-launch.log" 2>&1 &
  fi
else
  echo 'Warning: neither systemd user services nor crontab is available; starting supervisor now but boot autostart could not be registered.' >&2
  if [[ "$NO_START" -ne 1 ]]; then
    nohup /bin/bash "$ROOT/autostart-linux.sh" >> "$ROOT/var/autostart-launch.log" 2>&1 &
  fi
fi

echo
echo "AUTOSTART_ENROLL_PASS profile=$PROFILE credential=$CRED_FILE registered=$REGISTERED linger=${LINGER_STATUS:-n/a}"
echo 'Future logins do not require the Tunnel ID, health port, or Runtime API key.'
echo 'Linux credential fallback is a local chmod-600 file outside the repository.'
