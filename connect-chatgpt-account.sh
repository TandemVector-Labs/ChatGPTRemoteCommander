#!/usr/bin/env bash
set -euo pipefail

PROFILE=""
HEALTH_PORT="0"
TUNNEL_ID=""
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_BIN="$ROOT/.runtime/node-current/bin"
[[ -x "$RUNTIME_BIN/node" ]] && export PATH="$RUNTIME_BIN:$PATH"
MCP_URL="http://127.0.0.1:47831/mcp"
HEALTH_URL="http://127.0.0.1:47831/health"

usage() {
  echo "Usage: $0 --profile NAME [--health-port PORT] [--tunnel-id tunnel_...]"
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --health-port) HEALTH_PORT="$2"; shift 2 ;;
    --tunnel-id) TUNNEL_ID="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done
[[ -n "$PROFILE" ]] || { echo "--profile is required" >&2; exit 2; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
if ! curl -fsS --connect-timeout 1 --max-time 3 "$HEALTH_URL" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
  echo "ChatGPT Remote Commander is not healthy at $HEALTH_URL" >&2
  exit 1
fi

port_in_use() {
  local port="$1"
  if command -v ss >/dev/null; then
    ss -ltnH "sport = :$port" 2>/dev/null | grep -q .
  elif command -v netstat >/dev/null; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}$"
  else
    return 1
  fi
}
if [[ "$HEALTH_PORT" == "0" ]]; then
  for candidate in $(seq 47832 47931); do
    if ! port_in_use "$candidate"; then HEALTH_PORT="$candidate"; break; fi
  done
  [[ "$HEALTH_PORT" != "0" ]] || { echo "No free health port found" >&2; exit 1; }
elif port_in_use "$HEALTH_PORT"; then
  echo "Health port $HEALTH_PORT is already in use; omit --health-port for auto-selection." >&2
  exit 1
fi
TUNNEL_EXE=""
while IFS= read -r candidate; do
  TUNNEL_EXE="$candidate"
done < <(find "$ROOT/tools" -type f -name tunnel-client -perm -u+x 2>/dev/null | sort)
if [[ -z "$TUNNEL_EXE" ]] && command -v tunnel-client >/dev/null; then
  TUNNEL_EXE="$(command -v tunnel-client)"
fi
[[ -n "$TUNNEL_EXE" ]] || { echo "tunnel-client not found; run install.sh first." >&2; exit 1; }

if [[ -z "$TUNNEL_ID" ]]; then
  read -r -p "Paste OpenAI tunnel_id for this account: " TUNNEL_ID
fi
[[ "$TUNNEL_ID" =~ ^tunnel_[A-Za-z0-9_-]+$ ]] || { echo "Invalid tunnel_id format" >&2; exit 1; }
read -r -s -p "Paste Runtime API key for this account (hidden): " RUNTIME_KEY
echo
[[ -n "$RUNTIME_KEY" ]] || { echo "Runtime API key is empty" >&2; exit 1; }

unset OPENAI_API_KEY  # Never let an ambient OpenAI API key override this account/profile Runtime key.
export CONTROL_PLANE_API_KEY="$RUNTIME_KEY"
trap 'unset CONTROL_PLANE_API_KEY RUNTIME_KEY' EXIT
LISTEN="127.0.0.1:${HEALTH_PORT}"
"$TUNNEL_EXE" init \
  --sample sample_mcp_remote_no_auth \
  --profile "$PROFILE" \
  --tunnel-id "$TUNNEL_ID" \
  --mcp-server-url "$MCP_URL" \
  --health-listen-addr "$LISTEN" \
  --force
"$TUNNEL_EXE" doctor --profile "$PROFILE" --explain
echo
echo "ACCOUNT_TUNNEL_READY profile=$PROFILE healthPort=$HEALTH_PORT"
echo "Local tunnel UI: http://127.0.0.1:${HEALTH_PORT}/ui"
echo "Keep this process running while this ChatGPT account uses the computer."
exec env CONTROL_PLANE_API_KEY="$RUNTIME_KEY" "$TUNNEL_EXE" run --profile "$PROFILE"
