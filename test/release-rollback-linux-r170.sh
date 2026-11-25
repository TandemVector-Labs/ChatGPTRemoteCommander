#!/usr/bin/env bash
# Isolated CI qualification: real promotion and rollback of a tagged, previously accepted Core.
# Never run on an owner workstation or on a configured Commander host.
set -Eeuo pipefail
umask 077

# Owner-PC safety: the real upgrade/rollback may run only on GitHub-hosted Linux.
# CI is user-settable; the GitHub/runner identity must also match before any mutation.
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == Linux && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]] || { echo R170_GITHUB_HOSTED_LINUX_ONLY >&2; exit 60; }
[[ "${CI:-}" == true && -n "${GITHUB_WORKSPACE:-}" && -n "${RUNNER_TEMP:-}" ]] || { echo R170_CI_ONLY >&2; exit 61; }
WORKSPACE="$(realpath "$GITHUB_WORKSPACE")"
TEMPBASE="$(realpath "$RUNNER_TEMP")"
TARGET="$(git -C "$WORKSPACE" rev-parse HEAD)"
EXPECTED="$1"
BASELINE='362375c464948be3001b307650c13fc3353ed05b'
# Preserve the legacy migration test; rollback must target a schema-compatible
# accepted dev.23 predecessor, not the pre-Workspace immutable 0.10.20 tag.
ROLLBACK_BASELINE='8ccf0fd16355a4ab79844feec6c295366763df0d'
ROLLBACK_VERSION='0.11.0-dev.23'
[[ "$TARGET" == "$EXPECTED" && "$TARGET" =~ ^[a-f0-9]{40}$ ]] || { echo R170_SOURCE_SHA_MISMATCH >&2; exit 62; }
SOURCE_VERSION="$(node -p "require('$WORKSPACE/package.json').version")"
node "$WORKSPACE/tools/isolated-qa-policy.mjs" || { echo R170_SOURCE_VERSION_NOT_QUALIFIED >&2; exit 63; }
echo "R170_ISOLATED_SOURCE_VERSION=$SOURCE_VERSION releaseAuthorization=false"
ROOT="$TEMPBASE/remote-commander-rollback-r170"
[[ "$ROOT" == "$TEMPBASE/"* && ! -e "$ROOT" ]] || { echo R170_SANDBOX_NOT_FRESH >&2; exit 64; }
[[ ! -e "$HOME/.local/share/ChatGPTRemoteCommander" ]] || { echo R170_OWNER_INSTALL_DETECTED >&2; exit 65; }
command -v timeout >/dev/null && command -v curl >/dev/null && command -v python3 >/dev/null || exit 66
if command -v ss >/dev/null; then
  ! ss -ltn | grep -Eq '127\.0\.0\.1:47831[[:space:]]' || { echo R170_PORT_IN_USE >&2; exit 67; }
fi
mkdir -m 700 -p "$ROOT/install" "$ROOT/state" "$ROOT/config" "$ROOT/data"
# Always stop only Node routers/backends whose cwd and argv prove R170 sandbox ownership.
# Unexpected residual processes fail closed and cannot be mistaken for host success.
r172_cleanup_on_exit(){
  local prior=$?
  trap - EXIT
  if [[ ! -e "$ROOT/CLEANUP_R172.json" ]]; then
    if ! python3 "$WORKSPACE/test/release-rollback-owned-cleanup-r172.py" --root "$ROOT"; then
      echo R172_FINAL_CLEANUP_FAILED >&2
      [[ "$prior" != 0 ]] || prior=86
    fi
  fi
  exit "$prior"
}
trap r172_cleanup_on_exit EXIT
git clone --quiet --depth 1 --branch v0.10.20 https://github.com/GOD13emad/ChatGPTRemoteCommander.git "$ROOT/install"
[[ "$(git -C "$ROOT/install" rev-parse HEAD)" == "$BASELINE" ]] || { echo R170_BASELINE_SHA_MISMATCH >&2; exit 68; }
# Immutable v0.10.20 has a documented CRLF Git-blob vs eol=crlf attribute conflict.
# Accept ONLY that one known tracked path, with zero staged or non-EOL semantic differences.
# Never reset or rewrite the immutable old tag; only known EOL drift is permitted.
dirty="$(git -C "$ROOT/install" status --porcelain --untracked-files=no)"
if [[ -n "$dirty" ]]; then
  [[ "$dirty" == ' M enable-boot-recovery.ps1' ]] || { echo R170_UNEXPECTED_BASELINE_DIRTY >&2; exit 69; }
  [[ "$(git -C "$ROOT/install" rev-parse 'HEAD:enable-boot-recovery.ps1')" == '4a95652f898ca168bab0a9ed8764c8776bbef321' ]] || { echo R170_HISTORIC_BLOB_SHA_DRIFT >&2; exit 69; }
  [[ "$(sha256sum "$ROOT/install/enable-boot-recovery.ps1"|cut -d' ' -f1)" == '220c241b7534c821be875dc4554b0986c4a7a3b5914fc0ff257736d8930d32db' ]] || { echo R170_WORKTREE_EOL_HASH_DRIFT >&2; exit 69; }
  git -C "$ROOT/install" diff --cached --quiet -- || { echo R170_STAGED_DELTA_BLOCK >&2; exit 69; }
  git -C "$ROOT/install" diff --ignore-space-at-eol --quiet -- || { echo R170_SEMANTIC_DELTA_BLOCK >&2; exit 69; }
  echo R170_KNOWN_IMMUTABLE_V01020_EOL_DRIFT_ACCEPTED
fi

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
print('R170_ISOLATED_CONFIG_PASS')
PY

export XDG_STATE_HOME="$ROOT/state" XDG_CONFIG_HOME="$ROOT/config" XDG_DATA_HOME="$ROOT/data"
START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "SOURCE=$TARGET BASELINE=$BASELINE" > "$ROOT/START_R170.txt"

set +e
# Force is confined to this disposable RUNNER_TEMP integration test: the release train
# remains NoPromote for every installed/user host. Preconditions above prove a fresh
# GitHub-hosted runner, exact source SHA, private config roots and no owner install.
timeout --signal=TERM --kill-after=10s 800s bash "$WORKSPACE/auto-update-linux.sh" \
  --install-dir "$ROOT/install" --source-ref "$TARGET" --expected-commit "$TARGET" --force \
  > "$ROOT/PROMOTE_R170.log" 2>&1
PROMOTE_CODE=$?
set -e
printf 'PROMOTE_CODE=%s\n' "$PROMOTE_CODE"
if [[ "$PROMOTE_CODE" != 0 ]]; then
  tail -70 "$ROOT/PROMOTE_R170.log"
  echo R170_LINUX_PROMOTION_FAILED >&2
  exit 70
fi
[[ "$(git -C "$ROOT/install" rev-parse HEAD)" == "$TARGET" ]] || { echo R170_PROMOTE_CONTROL_SHA_FAIL >&2; exit 71; }
grep -q "AUTO_UPDATE_PASS version=$SOURCE_VERSION" "$ROOT/PROMOTE_R170.log" || { echo R170_PROMOTE_NOT_ACCEPTED >&2; exit 72; }
ROUTE="$ROOT/state/chatgpt-remote-commander/routing/default.json"
[[ -f "$ROUTE" ]] || { echo R170_NO_ROUTER_STATE >&2; exit 73; }
node "$WORKSPACE/tools/router-state.mjs" --state "$ROUTE" > "$ROOT/ROUTE_AFTER_PROMOTE.json"
python3 - "$ROOT/ROUTE_AFTER_PROMOTE.json" "$TARGET" "$SOURCE_VERSION" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
assert r['profile']=='default' and r['active']['commit']==sys.argv[2]
assert r['active']['version']==sys.argv[3]
print('R170_LINUX_PROMOTION_ROUTE_PASS')
PY
curl -fsS --connect-timeout 2 --max-time 5 http://127.0.0.1:47831/health > "$ROOT/HEALTH_PROMOTED.json"

# A real rollback to pre-Workspace v0.10.20 MUST fail closed rather than silently
# removing nine supported MCP tools. Keep the promoted route and contract intact.
# This is intentionally a negative security acceptance, not a rollback PASS.
set +e
timeout --signal=TERM --kill-after=10s 800s bash "$WORKSPACE/auto-update-linux.sh" \
  --install-dir "$ROOT/install" --source-ref "$BASELINE" --expected-commit "$BASELINE" --force \
  > "$ROOT/REJECTED_INCOMPATIBLE_ROLLBACK.log" 2>&1
INCOMPATIBLE_CODE=$?
set -e
if [[ "$INCOMPATIBLE_CODE" == 0 ]] ||
   ! grep -q '^SCHEMA_CONTINUITY_GATE_FAIL profile=default$' "$ROOT/REJECTED_INCOMPATIBLE_ROLLBACK.log"; then
  echo R170_EXPECTED_LEGACY_SCHEMA_REFUSAL_MISSING >&2
  exit 74
fi
[[ "$(git -C "$ROOT/install" rev-parse HEAD)" == "$TARGET" ]] || { echo R170_INCOMPATIBLE_ATTEMPT_MUTATED_INSTALL >&2;exit 74; }
node "$WORKSPACE/tools/router-state.mjs" --state "$ROUTE" > "$ROOT/ROUTE_AFTER_REJECTED_ROLLBACK.json"
python3 - "$ROOT/ROUTE_AFTER_REJECTED_ROLLBACK.json" "$TARGET" <<'PY_CHECK'
import json,sys
s=json.load(open(sys.argv[1]))
assert s['active']['commit']==sys.argv[2], 'legacy refusal altered promoted router'
print('R170_LEGACY_INCOMPATIBLE_ROLLBACK_REJECTED_SAFELY')
PY_CHECK

# Verify an actual rollback to a previously qualified, schema-compatible dev.23
# predecessor without disabling the schema continuity gate.
set +e
timeout --signal=TERM --kill-after=10s 800s bash "$WORKSPACE/auto-update-linux.sh" \
  --install-dir "$ROOT/install" --source-ref "$ROLLBACK_BASELINE" --expected-commit "$ROLLBACK_BASELINE" --force \
  > "$ROOT/ROLLBACK_R170.log" 2>&1
ROLLBACK_CODE=$?
set -e
# The updater may request one router-source bootstrap before full rollback.
# Retry only on its exact receipt, in the isolated CI host; keep final gates.
if [[ "$ROLLBACK_CODE" == 0 ]] &&
   grep -q '^AUTO_UPDATE_ROUTER_BOOTSTRAPPED_RETRY_REQUIRED profile=default$' "$ROOT/ROLLBACK_R170.log"; then
  echo R170_ROUTER_BOOTSTRAP_RETRY_ONCE
  set +e
  timeout --signal=TERM --kill-after=10s 800s bash "$WORKSPACE/auto-update-linux.sh" --install-dir "$ROOT/install" --source-ref "$ROLLBACK_BASELINE" --expected-commit "$ROLLBACK_BASELINE" --force >> "$ROOT/ROLLBACK_R170.log" 2>&1
  ROLLBACK_CODE=$?
  set -e
fi
printf 'ROLLBACK_CODE=%s\n' "$ROLLBACK_CODE"
if [[ "$ROLLBACK_CODE" != 0 ]]; then
  tail -70 "$ROOT/ROLLBACK_R170.log"
  echo R170_LINUX_ROLLBACK_FAILED >&2
  exit 74
fi
[[ "$(git -C "$ROOT/install" rev-parse HEAD)" == "$ROLLBACK_BASELINE" ]] || { echo R170_ROLLBACK_CONTROL_SHA_FAIL >&2; exit 75; }
grep -q "AUTO_UPDATE_PASS version=$ROLLBACK_VERSION" "$ROOT/ROLLBACK_R170.log" || { echo R170_ROLLBACK_NOT_ACCEPTED >&2; exit 76; }
node "$WORKSPACE/tools/router-state.mjs" --state "$ROUTE" > "$ROOT/ROUTE_AFTER_ROLLBACK.json"
python3 - "$ROOT/ROUTE_AFTER_ROLLBACK.json" "$ROLLBACK_BASELINE" "$ROLLBACK_VERSION" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
assert r['active']['commit']==sys.argv[2]
assert r['active']['version']==sys.argv[3]
print('R170_LINUX_ROLLBACK_ROUTE_PASS')
PY
curl -fsS --connect-timeout 2 --max-time 5 http://127.0.0.1:47831/health > "$ROOT/HEALTH_ROLLBACK.json"
# Do not let an unrelated source mutation masquerade as an isolated rollback PASS.
# Keep a sanitized pathname receipt for triage. A host checkout's declared PS1
# CRLF attribute may cause a worktree-only EOL status; tolerate that only if
# there are no untracked/staged files and no semantic tracked diff.
source_status="$(git -C "$WORKSPACE" status --porcelain=v1 --untracked-files=normal)"
if [[ -n "$source_status" ]]; then
  printf '%s\n' "$source_status" > "$ROOT/SOURCE_STATUS_R170.txt"
  source_safe=true
  git -C "$WORKSPACE" diff --cached --quiet -- || source_safe=false
  # Byte-exact semantic parity is checked below: normalize CRLF only, never other whitespace.
  while IFS= read -r line; do
    [[ "$line" == ' M '* ]] || source_safe=false
    file="$(printf '%s' "$line" | cut -c4-)"
    case "$file" in
      *.ps1)
        [[ "$(git -C "$WORKSPACE" check-attr eol -- "$file")" == *': eol: crlf' ]] || source_safe=false
        ;;
      desktop/RemoteCommanderDashboard/Program.cs)
        # Known source blob has CRLF in the Git index but eol=lf in .gitattributes.
        # Linux checkout may report this one path dirty despite an EOL-only diff.
        eolmeta="$(git -C "$WORKSPACE" ls-files --eol -- "$file")"
        [[ "$eolmeta" == i/crlf* && ( "$eolmeta" == *w/lf* || "$eolmeta" == *w/crlf* ) && "$eolmeta" == *"attr/text eol=lf"* ]] || source_safe=false
        [[ "$(git -C "$WORKSPACE" rev-parse "HEAD:$file")" == d67eeb4bc6eb72f98bfbc3c286c2e70b0bb8a246 ]] || source_safe=false
        echo R170_KNOWN_DASHBOARD_EOL_CONFLICT_CHECKED
        ;;
      *) source_safe=false ;;
    esac
    # Refuse any semantic change, including whitespace edits other than CRLF/LF.
    # This is stricter than 'git diff --ignore-space-at-eol --quiet'.
    if ! python3 - "$WORKSPACE" "$file" <<'PY'
import pathlib, subprocess, sys
repo, rel = sys.argv[1:3]
target = pathlib.Path(repo) / rel
if not target.is_file() or target.is_symlink():
    raise SystemExit(1)
baseline = subprocess.check_output(['git','-C',repo,'show','HEAD:'+rel])
current = target.read_bytes()
def normalize(value):
    normalized = value.replace(b'\r\n',b'\n')
    if b'\r' in normalized:
        raise ValueError('lone CR byte')
    return normalized
if normalize(current) != normalize(baseline):
    raise SystemExit(1)
print('R170_EOL_BYTES_EQUAL')
PY
    then
      source_safe=false
      echo R170_EOL_BYTES_MISMATCH
    fi
  done <<< "$source_status"
  if [[ "$source_safe" != true ]]; then echo R170_SOURCE_CHANGED >&2; exit 77; fi
  echo R170_SOURCE_BOUNDED_EOL_ONLY_ACCEPTED
else
  echo R170_SOURCE_CLEAN_PASS
fi
python3 "$WORKSPACE/test/release-rollback-owned-cleanup-r172.py" --root "$ROOT"
python3 - "$ROOT/CLEANUP_R172.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
assert r["status"]=="PASS_ZERO_OWNED_NODE_AFTER_ROLLBACK" and not r["ownedAfter"]
print("R172_ROLLBACK_ZERO_OWNED_NODE_ACCEPTED")
PY
python3 - "$ROOT" "$TARGET" "$ROLLBACK_BASELINE" "$START" "$BASELINE" <<'PY'
import json,hashlib,pathlib,sys,datetime
root=pathlib.Path(sys.argv[1])
def h(p):return hashlib.sha256(p.read_bytes()).hexdigest()
record={
'schema':1,'revision':'R170','status':'PASS_LINUX_REAL_PROMOTION_AND_ROLLBACK_IN_ISOLATED_HOST',
'candidateHead':sys.argv[2],'rollbackHead':sys.argv[3],'startedUtc':sys.argv[4],
'legacyIncompatibleBaseline':sys.argv[5],'legacySchemaRefused':True,
'legacyRefusalLogSha256':h(root/'REJECTED_INCOMPATIBLE_ROLLBACK.log'),
'completedUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
'isolatedHost':True,'userHostMutation':False,
'promoteLogSha256':h(root/'PROMOTE_R170.log'),
'rollbackLogSha256':h(root/'ROLLBACK_R170.log'),
'routePromoteSha256':h(root/'ROUTE_AFTER_PROMOTE.json'),
'routeRollbackSha256':h(root/'ROUTE_AFTER_ROLLBACK.json'),
'cleanupSha256':h(root/'CLEANUP_R172.json'),
'ownedNodeCleanup':json.loads((root/'CLEANUP_R172.json').read_text()),
'signingAndNativeUIAcceptance':'OPEN'
}
p=root/'RETURN_R170.json'
p.write_text(json.dumps(record,indent=2)+'\n')
print('R170_PASS exact='+sys.argv[2]+' receiptSha='+h(p))
PY
