#!/usr/bin/env bash
# Build one native dpkg-managed Commander installation shared by Linux profiles.
# This is a source QA artifact, NOT a signed Stable release or permission grant.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
OUT="$ROOT/dist/installer/Remote-Commander-Linux-amd64.deb"
NODE_VERSION=22.23.4
NODE_ASSET="node-v$NODE_VERSION-linux-x64.tar.xz"
NODE_SHA256=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce
PACKAGE_DIR=/usr/lib/chatgpt-remote-commander
for executable in git node curl tar unzip sha256sum dpkg-deb python3; do
  command -v "$executable" >/dev/null || { echo "Missing native package build prerequisite $executable" >&2; exit 2; }
done
OUT="$(node "$ROOT/tools/native-package-output-guard.mjs" absent "$ROOT" "$OUT")"
test "$(uname -s)" = Linux && test "$(uname -m)" = x86_64 || {
  echo 'NATIVE_LINUX_PACKAGE_REQUIRES_LINUX_AMD64' >&2; exit 2;
}
# Git can report a dirty worktree when an older CRLF blob is checked out
# under a newer eol=lf attribute despite exact on-disk blob parity.
# Accept ONLY byte-for-byte identity with HEAD; never permit staged changes,
# added/untracked files, renames, symlinks or actual dirty source.
python3 - "$ROOT" <<'SOURCE_GUARD'
import os, pathlib, subprocess, sys
root=pathlib.Path(sys.argv[1]).resolve()
def deny():
    print('NATIVE_LINUX_PACKAGE_REQUIRES_CLEAN_SOURCE',file=sys.stderr)
    sys.exit(3)
try:
    state=subprocess.check_output(
        ['git','-C',str(root),'status','--porcelain=v1','-z','--untracked-files=all'],
        timeout=12
    )
    records=[r for r in state.split(b'\0') if r]
    if len(records)>16: deny()
    for item in records:
        if len(item)<4 or item[:2]!=b' M' or item[2:3]!=b' ': deny()
        rel=os.fsdecode(item[3:])
        target=root/rel
        if not target.is_file() or target.is_symlink() or target.stat().st_size>1048576: deny()
        if not target.resolve().is_relative_to(root): deny()
        raw=subprocess.check_output(['git','-C',str(root),'show','HEAD:'+rel],timeout=12)
        if raw!=target.read_bytes(): deny()
    if records:
        print('NATIVE_GIT_ATTRIBUTES_EXACT_BLOB_PASS files='+str(len(records)))
except (OSError,ValueError,subprocess.CalledProcessError,subprocess.TimeoutExpired):
    deny()
SOURCE_GUARD
HEAD="$(git -C "$ROOT" rev-parse HEAD^{commit})"
EPOCH="$(git -C "$ROOT" show -s --format=%ct HEAD)"
VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")"
if [[ ! "$VERSION" =~ ^0\.12\.0-dev\.[1-9][0-9]*$ ]]; then
  echo 'NATIVE_LINUX_QA_VERSION_NOT_APPROVED' >&2; exit 4
fi
node - "$ROOT/docs/release-train-0.12.json" "$VERSION" <<'NODE'
const fs=require('node:fs'),data=JSON.parse(fs.readFileSync(process.argv[2]));
if(data.train!=='0.12'||data.sourceVersion!==process.argv[3]
   ||data.status!=='INTEGRATION_CANDIDATE_NOT_FINAL'||data.channel!=='development'
   ||data.isStable!==false||data.publishApproved!==false
   ||data.autoupdateApproved!==false||data.installedPromotionApproved!==false
   ||data.releaseTag!==null)process.exit(1);
NODE
[[ ! -e "$OUT" && ! -L "$OUT" ]] || {
  echo 'NATIVE_LINUX_PACKAGE_OUTPUT_ALREADY_EXISTS' >&2; exit 5;
}
STAGE="$(mktemp -d /tmp/commander-v012-dpkg-build-XXXXXX)"
cleanup(){ rm -rf -- "$STAGE"; }
trap cleanup EXIT INT TERM
DEB="$STAGE/pkg"
APP="$DEB$PACKAGE_DIR/app"
RUNTIME="$DEB$PACKAGE_DIR/runtime"
mkdir -p "$APP" "$RUNTIME" "$DEB/DEBIAN" \
  "$DEB/usr/lib/systemd/user" \
  "$DEB/usr/share/doc/chatgpt-remote-commander" \
  "$DEB$PACKAGE_DIR/tunnel"
# Match the exact committed-Core allowlist used by packaging/unified/prepare.mjs.
# Do not ship repository governance docs, skill bundles, tests or Git history.
git -C "$ROOT" archive --format=tar "$HEAD" -- src tools vendor assets config.json package.json | tar -xf - -C "$APP"
test "$(node -p 'require(process.argv[1]).version' "$APP/package.json")" = "$VERSION"
# Every build of the single v0.12 Linux product MUST contain the real protected
# Core + J01 + signed Worker implementation. Version strings alone are not proof.
for rel in \
 src/server-v0.3.mjs src/v012-private-core-runtime.mjs \
 src/v2-private-pair-mcp-http-ingress.mjs \
 src/v2-private-tunnel-https-gateway.mjs \
 src/v2-private-pair-operation-gate.mjs \
 src/v2-private-signed-worker-grant-adapter.mjs \
 src/v101-private-pair-native-owner-stack.mjs \
 src/native-owner-session-provider-linux.mjs \
 src/native-tunnel-attestor.mjs; do
  [[ -f "$APP/$rel" && ! -L "$APP/$rel" && -s "$APP/$rel" ]] || {
    echo "RC012_PROTECTED_NATIVE_CORE_REQUIRED_FILE_MISSING $rel" >&2; exit 4;
  }
done
BASE="https://nodejs.org/dist/v$NODE_VERSION"
curl --fail --silent --show-error --location --retry 2 \
  --connect-timeout 6 --max-time 75 "$BASE/SHASUMS256.txt" -o "$STAGE/SHASUMS256.txt"
actual_manifest_line="$(grep -E "^[a-f0-9]{64}  $NODE_ASSET$" "$STAGE/SHASUMS256.txt")"
test "$actual_manifest_line" = "$NODE_SHA256  $NODE_ASSET" || {
  echo 'NODE_OFFICIAL_MANIFEST_PIN_MISMATCH' >&2; exit 6;
}
curl --fail --silent --show-error --location --retry 2 \
  --connect-timeout 6 --max-time 180 "$BASE/$NODE_ASSET" -o "$STAGE/$NODE_ASSET"
printf '%s  %s\n' "$NODE_SHA256" "$STAGE/$NODE_ASSET" | sha256sum -c --status || {
  echo 'NODE_RUNTIME_SHA_MISMATCH' >&2; exit 7;
}
tar -xJf "$STAGE/$NODE_ASSET" --strip-components=2 -C "$RUNTIME" \
  "node-v$NODE_VERSION-linux-x64/bin/node"
tar -xJf "$STAGE/$NODE_ASSET" --strip-components=1 -C "$RUNTIME" \
  "node-v$NODE_VERSION-linux-x64/LICENSE"
chmod 755 "$RUNTIME/node"
test "$("$RUNTIME/node" --version)" = "v$NODE_VERSION"
# Reuse the one official SHA-pinned installer rather than maintaining a second downloader.
# This bundles the already accepted tunnel client with license/SBOM, but never enrolls
# a credential, opens a public listener, or starts a service as part of dpkg installation.
TUNNEL_VERSION="$(node "$APP/tools/json-field.mjs" --file "$APP/tools/tunnel-client-pin.json" --field version)"
TUNNEL_UPSTREAM="$(node "$APP/tools/json-field.mjs" --file "$APP/tools/tunnel-client-pin.json" --field upstreamCommit)"
[[ "$TUNNEL_VERSION" == 0.0.15 && "$TUNNEL_UPSTREAM" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'NATIVE_TUNNEL_UNAPPROVED_PIN' >&2; exit 8;
}
/bin/bash "$APP/tools/install-tunnel-client-linux.sh" --install-dir "$STAGE/tunnel-download"
TUNNEL_SRC="$STAGE/tunnel-download/tools/tunnel-client-v${TUNNEL_VERSION}-linux-amd64"
TUNNEL="$DEB$PACKAGE_DIR/tunnel"
for name in tunnel-client cloudflared LICENSE NOTICE; do
  [[ -f "$TUNNEL_SRC/$name" && ! -L "$TUNNEL_SRC/$name" ]] || {
    echo "NATIVE_TUNNEL_MISSING_ASSET $name" >&2; exit 8;
  }
done
cp -a -- "$TUNNEL_SRC/." "$TUNNEL/"
[[ "$("$TUNNEL/tunnel-client" --version)" == "$TUNNEL_VERSION+$TUNNEL_UPSTREAM"* ]] || {
  echo 'NATIVE_TUNNEL_BINARY_PROVENANCE_MISMATCH' >&2; exit 8;
}
install -m 0644 "$STAGE/tunnel-download/var/tunnel-client-installed.json" \
  "$DEB/usr/share/doc/chatgpt-remote-commander/tunnel-client-provenance.json"
cat > "$DEB/DEBIAN/control" <<EOF
Package: chatgpt-remote-commander
Version: 0.12.0~dev1-2
Section: utils
Priority: optional
Architecture: amd64
Maintainer: Remote Commander maintainers
Depends: libc6 (>= 2.31), ca-certificates, curl (>= 7.68)
Description: Single native Remote Commander application core (V0.12 QA)
 One dpkg-owned immutable code and Node runtime for all local profiles.
 Native owner admission, authenticated G1/J01 and fleet approval are
 required before any privileged profile is activated.
EOF
cat > "$DEB/usr/lib/systemd/user/chatgpt-remote-commander@.service" <<'USERUNIT'
[Unit]
Description=Remote Commander shared native core for owner profile %i
After=network-online.target
ConditionPathExists=%h/.local/state/chatgpt-remote-commander/profiles/%i/config.json
[Service]
Type=simple
Environment=REMOTE_COMMANDER_CONFIG=%h/.local/state/chatgpt-remote-commander/profiles/%i/config.json
Environment=COMMANDER_ONE_REQUIRE_TRUSTED_INGRESS=1
WorkingDirectory=%h
ExecStartPre=/usr/lib/chatgpt-remote-commander/runtime/node /usr/lib/chatgpt-remote-commander/native-config-preflight.mjs
ExecStart=/usr/lib/chatgpt-remote-commander/runtime/node /usr/lib/chatgpt-remote-commander/app/src/server-v0.3.mjs
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
UMask=0077
Restart=on-failure
RestartSec=5
[Install]
WantedBy=default.target
USERUNIT
# An opt-in, per-owner tunnel service reuses the same native installation.
# No tunnel is activated during package installation; the owner must first enroll
# a valid same-owner profile and credential and explicitly enable its user unit.
cat > "$DEB/usr/lib/systemd/user/chatgpt-remote-commander-tunnel@.service" <<'TUNNELUNIT'
[Unit]
Description=Remote Commander private tunnel for owner profile %i
After=network-online.target chatgpt-remote-commander@%i.service
Wants=network-online.target
ConditionPathExists=%h/.config/tunnel-client/%i.yaml
ConditionPathExists=%h/.config/chatgpt-remote-commander/credentials/%i.key

[Service]
Type=simple
LoadCredential=api-key:%h/.config/chatgpt-remote-commander/credentials/%i.key
ExecStart=/usr/lib/chatgpt-remote-commander/tunnel/native-tunnel-launch.sh %i
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
UMask=0077
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
TUNNELUNIT
cat > "$DEB$PACKAGE_DIR/tunnel/native-tunnel-launch.sh" <<'TUNNELLAUNCH'
#!/bin/sh
# systemd LoadCredential scopes the pre-existing owner key to this user service.
set -eu
umask 077
profile="${1:-}"
case "$profile" in
  ''|*[!A-Za-z0-9._-]*) echo 'NATIVE_TUNNEL_INVALID_PROFILE' >&2; exit 2;;
esac
[ "${#profile}" -le 64 ] || { echo 'NATIVE_TUNNEL_INVALID_PROFILE' >&2; exit 2; }
config_dir="${HOME:?}/.config/tunnel-client"
[ -f "$config_dir/$profile.yaml" ] || { echo 'NATIVE_TUNNEL_PROFILE_MISSING' >&2; exit 2; }
credential="${CREDENTIALS_DIRECTORY:-}/api-key"
[ -n "${CREDENTIALS_DIRECTORY:-}" ] && [ -r "$credential" ] || {
  echo 'NATIVE_TUNNEL_CREDENTIAL_MISSING' >&2; exit 2;
}
# Keep the key in systemd LoadCredential. The supervised child alone reads
# the credential; the parent does not export it into a shell environment.
exec /usr/lib/chatgpt-remote-commander/runtime/node \
  /usr/lib/chatgpt-remote-commander/tunnel/native-tunnel-supervisor-linux.mjs \
  "$profile" "$config_dir"
TUNNELLAUNCH
chmod 755 "$DEB$PACKAGE_DIR/tunnel/native-tunnel-launch.sh"
install -m 0644 "$APP/src/native-tunnel-supervisor-linux.mjs" \
  "$DEB$PACKAGE_DIR/tunnel/native-tunnel-supervisor-linux.mjs"
cat > "$DEB$PACKAGE_DIR/native-config-preflight.mjs" <<'PREFLIGHT'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const fail=code=>{throw Error(code)};
const file=process.env.REMOTE_COMMANDER_CONFIG;
if(process.env.COMMANDER_ONE_REQUIRE_TRUSTED_INGRESS!=='1')fail('NATIVE_G1_TRUSTED_INGRESS_REQUIRED');
if(typeof file!=='string'||!path.isAbsolute(file)||path.resolve(file)!==file)
  fail('NATIVE_PROFILE_CONFIG_REQUIRED');
const home=fs.realpathSync(os.homedir());
const profiles=path.join(home,'.local','state','chatgpt-remote-commander','profiles');
const relative=path.relative(profiles,file);
if(!relative||relative.startsWith('..')||path.isAbsolute(relative)
  ||path.basename(file)!=='config.json')
  fail('NATIVE_PROFILE_CONFIG_LOCATION_INVALID');
const profile=path.basename(path.dirname(file));
if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile))
  fail('NATIVE_PROFILE_ID_INVALID');
const uid=process.getuid?.();
const parent=path.dirname(file);
const parentStat=fs.lstatSync(parent);
const configStat=fs.lstatSync(file);
if(parentStat.isSymbolicLink()||!parentStat.isDirectory()||parentStat.uid!==uid
  ||(parentStat.mode&0o077)!==0)
  fail('NATIVE_PROFILE_DIRECTORY_NOT_PRIVATE');
if(configStat.isSymbolicLink()||!configStat.isFile()||configStat.uid!==uid
  ||(configStat.mode&0o077)!==0||fs.realpathSync(file)!==file)
  fail('NATIVE_PROFILE_CONFIG_NOT_PRIVATE');
const c=JSON.parse(fs.readFileSync(file,'utf8'));
if(c.instance?.profile!==profile)fail('NATIVE_PROFILE_ID_MISMATCH');
if(!Number.isSafeInteger(c.port)||c.port<1024||c.port>65535)
  fail('NATIVE_PROFILE_PORT_INVALID');
if(!['127.0.0.1','::1'].includes(c.host))
  fail('NATIVE_LOOPBACK_REQUIRED');
const managed='/usr/lib/chatgpt-remote-commander';
function outsideManaged(p,key){
  if(typeof p!=='string'||!path.isAbsolute(p)||path.resolve(p)!==p)
    fail('NATIVE_MUTABLE_STATE_PATH_REQUIRED_'+key);
  const rel=path.relative(managed,p);
  if(rel===''||(!rel.startsWith('..')&&!path.isAbsolute(rel)))
    fail('NATIVE_MUTABLE_STATE_INSIDE_MANAGED_CODE_'+key);
}
for(const key of ['runtimeState','auditLog'])outsideManaged(c[key],key);
for(const [section,key] of [['durableDelivery','directory'],['asyncOperations','stateDir']]){
  const value=c[section]?.[key];
  if(value!==undefined)outsideManaged(value,section+'_'+key);
}
console.log('NATIVE_PROFILE_CONFIG_PREFLIGHT_PASS');
PREFLIGHT
cat > "$DEB/usr/share/doc/chatgpt-remote-commander/README.txt" <<'DOC'
One shared, dpkg-managed Remote Commander Core for all owner profiles.

Profile config: ~/.local/state/chatgpt-remote-commander/profiles/PROFILE/config.json
The included systemd USER template starts the same immutable Core for a profile:
  systemctl --user daemon-reload
  systemctl --user enable --now chatgpt-remote-commander@PROFILE.service

The package also includes the SHA-pinned tunnel-client and its license, NOTICE
and SBOM. It does not create tunnel credentials or enable the tunnel user service.
After separate same-owner profile enrollment and native G1/J01 acceptance:
  systemctl --user enable --now chatgpt-remote-commander-tunnel@PROFILE.service
Both user units stay disabled until the owner explicitly enables them.

The package does not migrate credentials/configuration, stop old services, enable
any service, grant FULL_POWER, or approve G1/J01. Keep existing profile services
running until each replacement has an authenticated canary and rollback proof.
DOC
cat > "$DEB/usr/share/doc/chatgpt-remote-commander/release-identity.txt" <<EOF
version=$VERSION
sourceCommit=$HEAD
sourceTree=$(git -C "$ROOT" rev-parse HEAD^{tree})
nativePackage=amd64
tunnelClientVersion=$TUNNEL_VERSION
tunnelClientSha256=$(sha256sum "$TUNNEL/tunnel-client" | cut -d' ' -f1)
tunnelAutoStart=false
installation=dpkg-managed-single-codebase
serviceAutoStart=false
publisherProvenance=not-accepted
releasePromotion=NoPromote
profileIsolation=systemd-user-instance-per-owner
autoStart=false
EOF
# One deterministic code installation. All user profiles reuse the same source.
find "$DEB" -type d -exec chmod 755 {} +
find "$DEB" -type f ! -path '*/DEBIAN/*' -exec chmod a+r {} +
find "$DEB" -type f ! -path '*/DEBIAN/*' -perm /111 -exec chmod a+x {} +
SOURCE_DATE_EPOCH="$EPOCH" dpkg-deb --root-owner-group --build "$DEB" "$STAGE/Remote-Commander-Linux-amd64.deb" >/dev/null
dpkg-deb --field "$STAGE/Remote-Commander-Linux-amd64.deb" Package Version Architecture
dpkg-deb --contents "$STAGE/Remote-Commander-Linux-amd64.deb" |
  grep -E 'native-config-preflight.mjs|systemd/(system|user)/chatgpt-remote-commander.*service|app/src/server-v0.3.mjs|runtime/node$|tunnel/tunnel-client$|tunnel/LICENSE$'
mkdir -p "$(dirname "$OUT")"
# Recheck parent components after creation and before the no-clobber move.
OUT="$(node "$ROOT/tools/native-package-output-guard.mjs" absent "$ROOT" "$OUT")"
EXPECTED_PACKAGE_SHA256="$(sha256sum "$STAGE/Remote-Commander-Linux-amd64.deb" | cut -d' ' -f1)"
mv -n -- "$STAGE/Remote-Commander-Linux-amd64.deb" "$OUT"
FINAL_PACKAGE_SHA256="$(node "$ROOT/tools/native-package-output-guard.mjs" verify "$ROOT" "$OUT" "$EXPECTED_PACKAGE_SHA256")"
echo "NATIVE_LINUX_QA_PACKAGE_PASS commit=$HEAD version=$VERSION package=$OUT sha256=$FINAL_PACKAGE_SHA256 installed=false nativeServiceStarted=false"
