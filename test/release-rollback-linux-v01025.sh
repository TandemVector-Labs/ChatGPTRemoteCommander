#!/usr/bin/env bash
# v0.10.25 SOURCE CANDIDATE isolated CI qualification: promote exact PR SHA, then roll back to accepted v0.10.24 Preview.
# Never run on an owner workstation or on a configured Commander host.
set -Eeuo pipefail
umask 077

# Owner-PC safety: the real upgrade/rollback may run only on GitHub-hosted Linux.
# CI is user-settable; the GitHub/runner identity must also match before any mutation.
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == Linux && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]] || { echo V025L_GITHUB_HOSTED_LINUX_ONLY >&2; exit 60; }
[[ "${CI:-}" == true && -n "${GITHUB_WORKSPACE:-}" && -n "${RUNNER_TEMP:-}" ]] || { echo V025L_CI_ONLY >&2; exit 61; }
WORKSPACE="$(realpath "$GITHUB_WORKSPACE")"
TEMPBASE="$(realpath "$RUNNER_TEMP")"
TARGET="$(git -C "$WORKSPACE" rev-parse HEAD)"
EXPECTED="$1"
BASELINE='890b637c5ff3c7dcc5df2c0b99031333d522c6e4'
[[ "$TARGET" == "$EXPECTED" && "$TARGET" =~ ^[a-f0-9]{40}$ ]] || { echo V025L_SOURCE_SHA_MISMATCH >&2; exit 62; }
[[ "$(node -p "require('$WORKSPACE/package.json').version")" == 0.10.25 ]] || { echo V025L_SOURCE_VERSION_CHANGED >&2; exit 63; }
ROOT="$TEMPBASE/remote-commander-rollback-v025l"
[[ "$ROOT" == "$TEMPBASE/"* && ! -e "$ROOT" ]] || { echo V025L_SANDBOX_NOT_FRESH >&2; exit 64; }
[[ ! -e "$HOME/.local/share/ChatGPTRemoteCommander" ]] || { echo V025L_OWNER_INSTALL_DETECTED >&2; exit 65; }
command -v timeout >/dev/null && command -v curl >/dev/null && command -v python3 >/dev/null || exit 66
if command -v ss >/dev/null; then
  ! ss -ltn | grep -Eq '127\.0\.0\.1:47831[[:space:]]' || { echo V025L_PORT_IN_USE >&2; exit 67; }
fi
mkdir -m 700 -p "$ROOT/install" "$ROOT/state" "$ROOT/config" "$ROOT/data"
# Always stop only Node routers/backends whose cwd and argv prove V025L sandbox ownership.
# Unexpected residual processes fail closed and cannot be mistaken for host success.
r172_cleanup_on_exit(){
  local prior=$?
  trap - EXIT
  if [[ ! -e "$ROOT/CLEANUP_V025C.json" ]]; then
    if ! python3 "$WORKSPACE/test/release-rollback-owned-cleanup-v01025.py" --root "$ROOT"; then
      echo V025C_FINAL_CLEANUP_FAILED >&2
      [[ "$prior" != 0 ]] || prior=86
    fi
  fi
  exit "$prior"
}
trap r172_cleanup_on_exit EXIT
git clone --quiet --depth 1 --branch v0.10.24 https://github.com/GOD13emad/ChatGPTRemoteCommander.git "$ROOT/install"
[[ "$(git -C "$ROOT/install" rev-parse HEAD)" == "$BASELINE" ]] || { echo V025L_BASELINE_SHA_MISMATCH >&2; exit 68; }
# The accepted v0.10.25 Preview baseline must be clean, not grandfathered
# under the immutable v0.10.24 CRLF exception from historical V025L.
[[ -z "$(git -C "$ROOT/install" status --porcelain --untracked-files=no)" ]] || { echo V025L_BASELINE_DIRTY_REFUSED >&2; exit 69; }
git -C "$ROOT/install" diff --cached --quiet -- || { echo V025L_STAGED_DELTA_BLOCK >&2; exit 69; }

python3 - "$WORKSPACE/config.json" "$ROOT/install/config.local.json" "$WORKSPACE" <<'PY'
import json,pathlib,sys
source,dest,allowed=sys.argv[1:]
c=json.loads(pathlib.Path(source).read_text())
c['allowedRoots']=[allowed]
c['autoUpdate']['enabled']=True
c['powerMode']['enabled']=False
c['powerMode']['guiControl']['enabled']=False
c['powerMode']['browserControl']['enabled']=False
p=pathlib.Path(dest)
p.write_text(json.dumps(c,indent=2)+'\n')
p.chmod(0o600)
print('V025L_ISOLATED_CONFIG_PASS')
PY

export XDG_STATE_HOME="$ROOT/state" XDG_CONFIG_HOME="$ROOT/config" XDG_DATA_HOME="$ROOT/data"
START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "SOURCE=$TARGET BASELINE=$BASELINE" > "$ROOT/START_V025L.txt"

set +e
timeout --signal=TERM --kill-after=10s 800s bash "$WORKSPACE/auto-update-linux.sh" \
  --install-dir "$ROOT/install" --source-ref "$TARGET" --expected-commit "$TARGET" \
  > "$ROOT/PROMOTE_V025L.log" 2>&1
PROMOTE_CODE=$?
set -e
printf 'PROMOTE_CODE=%s\n' "$PROMOTE_CODE"
if [[ "$PROMOTE_CODE" != 0 ]]; then
  tail -70 "$ROOT/PROMOTE_V025L.log"
  echo V025L_LINUX_PROMOTION_FAILED >&2
  exit 70
fi
[[ "$(git -C "$ROOT/install" rev-parse HEAD)" == "$TARGET" ]] || { echo V025L_PROMOTE_CONTROL_SHA_FAIL >&2; exit 71; }
grep -q 'AUTO_UPDATE_PASS version=0.10.25' "$ROOT/PROMOTE_V025L.log" || { echo V025L_PROMOTE_NOT_ACCEPTED >&2; exit 72; }
ROUTE="$ROOT/state/chatgpt-remote-commander/routing/default.json"
[[ -f "$ROUTE" ]] || { echo V025L_NO_ROUTER_STATE >&2; exit 73; }
node "$WORKSPACE/tools/router-state.mjs" --state "$ROUTE" > "$ROOT/ROUTE_AFTER_PROMOTE.json"
python3 - "$ROOT/ROUTE_AFTER_PROMOTE.json" "$TARGET" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
assert r['profile']=='default' and r['active']['commit']==sys.argv[2]
assert r['active']['version']=='0.10.25'
print('V025L_LINUX_PROMOTION_ROUTE_PASS')
PY
curl -fsS --connect-timeout 2 --max-time 5 http://127.0.0.1:47831/health > "$ROOT/HEALTH_PROMOTED.json"

# Verify the updater can safely return to the immutable accepted Preview baseline without rewriting arbitrary state.
set +e
timeout --signal=TERM --kill-after=10s 800s bash "$WORKSPACE/auto-update-linux.sh" \
  --install-dir "$ROOT/install" --source-ref "$BASELINE" --expected-commit "$BASELINE" --force \
  > "$ROOT/ROLLBACK_V025L.log" 2>&1
ROLLBACK_CODE=$?
set -e
printf 'ROLLBACK_CODE=%s\n' "$ROLLBACK_CODE"
if [[ "$ROLLBACK_CODE" != 0 ]]; then
  tail -70 "$ROOT/ROLLBACK_V025L.log"
  echo V025L_LINUX_ROLLBACK_FAILED >&2
  exit 74
fi
[[ "$(git -C "$ROOT/install" rev-parse HEAD)" == "$BASELINE" ]] || { echo V025L_ROLLBACK_CONTROL_SHA_FAIL >&2; exit 75; }
grep -q 'AUTO_UPDATE_PASS version=0.10.24' "$ROOT/ROLLBACK_V025L.log" || { echo V025L_ROLLBACK_NOT_ACCEPTED >&2; exit 76; }
node "$WORKSPACE/tools/router-state.mjs" --state "$ROUTE" > "$ROOT/ROUTE_AFTER_ROLLBACK.json"
python3 - "$ROOT/ROUTE_AFTER_ROLLBACK.json" "$BASELINE" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
assert r['active']['commit']==sys.argv[2]
assert r['active']['version']=='0.10.24'
print('V025L_LINUX_ROLLBACK_ROUTE_PASS')
PY
curl -fsS --connect-timeout 2 --max-time 5 http://127.0.0.1:47831/health > "$ROOT/HEALTH_ROLLBACK.json"
[[ -z "$(git -C "$WORKSPACE" status --porcelain)" ]] || { echo V025L_SOURCE_CHANGED >&2; exit 77; }
python3 "$WORKSPACE/test/release-rollback-owned-cleanup-v01025.py" --root "$ROOT"
python3 - "$ROOT/CLEANUP_V025C.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
assert r["status"]=="PASS_ZERO_OWNED_NODE_AFTER_ROLLBACK" and not r["ownedAfter"]
print("V025C_ROLLBACK_ZERO_OWNED_NODE_ACCEPTED")
PY
python3 - "$ROOT" "$TARGET" "$BASELINE" "$START" <<'PY'
import json,hashlib,pathlib,sys,datetime
root=pathlib.Path(sys.argv[1])
def h(p):return hashlib.sha256(p.read_bytes()).hexdigest()
record={
'schema':1,'revision':'V025L','status':'PASS_LINUX_REAL_PROMOTION_AND_ROLLBACK_IN_ISOLATED_HOST',
'candidateHead':sys.argv[2],'rollbackHead':sys.argv[3],'startedUtc':sys.argv[4],
'completedUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
'isolatedHost':True,'userHostMutation':False,
'promoteLogSha256':h(root/'PROMOTE_V025L.log'),
'rollbackLogSha256':h(root/'ROLLBACK_V025L.log'),
'routePromoteSha256':h(root/'ROUTE_AFTER_PROMOTE.json'),
'routeRollbackSha256':h(root/'ROUTE_AFTER_ROLLBACK.json'),
'cleanupSha256':h(root/'CLEANUP_V025C.json'),
'ownedNodeCleanup':json.loads((root/'CLEANUP_V025C.json').read_text()),
'signingAndNativeUIAcceptance':'OPEN'
}
p=root/'RETURN_V025L.json'
p.write_text(json.dumps(record,indent=2)+'\n')
print('V025L_PASS exact='+sys.argv[2]+' receiptSha='+h(p))
PY
