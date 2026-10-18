#!/usr/bin/env bash
set -euo pipefail

SOURCE_REF="${REMOTE_COMMANDER_SOURCE_REF:-v0.10.23}"
EXPECTED_COMMIT="${REMOTE_COMMANDER_EXPECTED_COMMIT:-}"
INSTALL_DIR=""
ENABLE_GUI=0
START_SERVER=1
REPO_URL="${REMOTE_COMMANDER_REPO_URL:-https://github.com/GOD13emad/ChatGPTRemoteCommander.git}"

usage() {
  cat <<'USAGE'
Usage: server-install-linux.sh [options]
  --source-ref REF          Git ref to install (default: v0.10.23)
  --expected-commit SHA     Require the fetched ref to resolve to this exact commit
  --install-dir PATH        Override the normal per-user install directory
  --enable-gui              Keep GUI capabilities enabled (desktop Linux only)
  --no-start                Install/validate without starting the MCP server
  -h, --help                Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-ref) SOURCE_REF="$2"; shift 2 ;;
    --expected-commit) EXPECTED_COMMIT="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --enable-gui) ENABLE_GUI=1; shift ;;
    --no-start) START_SERVER=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

[[ "$SOURCE_REF" =~ ^[A-Za-z0-9._/-]{1,128}$ ]] || { echo 'Invalid --source-ref' >&2; exit 2; }
[[ -z "$EXPECTED_COMMIT" || "$EXPECTED_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]] || { echo 'Invalid --expected-commit' >&2; exit 2; }

need() { command -v "$1" >/dev/null 2>&1; }

as_root() {
  if [[ "$(id -u)" == 0 ]]; then
    "$@"
  else
    need sudo || { echo 'sudo is required to install server prerequisites.' >&2; exit 1; }
    sudo "$@"
  fi
}

install_bootstrap_packages() {
  if need apt-get; then
    as_root apt-get update
    as_root apt-get install -y git curl unzip tar xz-utils ca-certificates python3
  elif need dnf; then
    as_root dnf install -y git curl unzip tar xz ca-certificates python3
  elif need yum; then
    as_root yum install -y git curl unzip tar xz ca-certificates python3
  elif need zypper; then
    as_root zypper --non-interactive refresh
    as_root zypper --non-interactive install git curl unzip tar xz ca-certificates python3
  elif need pacman; then
    as_root pacman -Sy --needed --noconfirm git curl unzip tar xz ca-certificates python
  else
    echo 'Unsupported package manager. Supported: apt, dnf, yum, zypper, pacman.' >&2
    exit 1
  fi
}

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ "${ID:-}" == "alpine" ]]; then
    echo 'Alpine/musl is not qualified by this release. Use a supported glibc-based server distribution.' >&2
    exit 1
  fi
fi

install_bootstrap_packages
for cmd in git curl unzip tar sha256sum readlink python3; do
  need "$cmd" || { echo "$cmd is still unavailable after prerequisite installation." >&2; exit 1; }
done

stage="$(mktemp -d)"
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT

git -C "$stage" init >/dev/null
git -C "$stage" remote add origin "$REPO_URL"
git -C "$stage" fetch --depth 1 --no-tags origin "$SOURCE_REF"
resolved="$(git -C "$stage" rev-parse 'FETCH_HEAD^{commit}')"
[[ "$resolved" =~ ^[0-9a-f]{40}$ ]] || { echo 'Fetched source did not resolve to a commit.' >&2; exit 1; }
if [[ -n "$EXPECTED_COMMIT" && "${resolved,,}" != "${EXPECTED_COMMIT,,}" ]]; then
  echo "Resolved commit $resolved does not match ExpectedCommit $EXPECTED_COMMIT" >&2
  exit 1
fi
git -C "$stage" checkout --detach "$resolved" >/dev/null
expected_version="$(sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$stage/package.json" | head -n1)"
[[ "$expected_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Staged package version is invalid.' >&2; exit 1; }

installer="$stage/install.sh"
[[ -f "$installer" ]] || { echo 'Staged install.sh is missing.' >&2; exit 1; }
chmod +x "$installer"

args=(--install-prerequisites --power-mode --source-ref "$SOURCE_REF" --expected-commit "$resolved")
[[ -z "$INSTALL_DIR" ]] || args+=(--install-dir "$INSTALL_DIR")
[[ "$START_SERVER" == 1 ]] && args+=(--start-server)
if [[ "$ENABLE_GUI" != 1 ]]; then
  args+=(--disable-capability gui.screenshot)
  args+=(--disable-capability gui.mouse)
  args+=(--disable-capability gui.keyboard)
  args+=(--disable-capability gui.window_focus)
fi

if [[ "$ENABLE_GUI" == 1 ]]; then
  /bin/bash "$installer" "${args[@]}"
else
  REMOTE_COMMANDER_HEADLESS_VALIDATE=1 /bin/bash "$installer" "${args[@]}"
fi

if [[ "$START_SERVER" == 1 ]]; then
  health="$(curl -fsS --connect-timeout 2 --max-time 5 http://127.0.0.1:47831/health)"
  printf '%s' "$health" | grep -q '"ok"[[:space:]]*:[[:space:]]*true' || {
    echo 'Installed MCP health validation failed.' >&2
    exit 1
  }
  printf '%s' "$health" | grep -q "\"version\"[[:space:]]*:[[:space:]]*\"$expected_version\"" || {
    echo "Installed MCP version validation failed; expected $expected_version." >&2
    exit 1
  }
fi

echo
echo 'SERVER_INSTALL_LINUX_PASS'
echo "Source commit: $resolved"
echo "GUI capabilities enabled: $ENABLE_GUI"
echo 'No security controls or antivirus exclusions were disabled.'
