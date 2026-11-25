#!/usr/bin/env bash
# Reversible no-grant Linux Core+broker verification. No production changes.
set -Eeuo pipefail
umask 077
if [ "$#" -ne 4 ];then echo 'USAGE: CORE_PROFILE TUNNEL_PROFILE HTTPS_PORT NODE' >&2;exit 2;fi
coreProfile="$1";profile="$2";port="$3";node="$4"
[[ "$coreProfile" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || exit 2
[[ "$profile" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || exit 2
[[ "$port" =~ ^[0-9]{4,5}$ ]] && ((port>=1024 && port<=65535)) || exit 2
[ -x "$node" ] && [[ "$node" = /* ]] || exit 2
root="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
dir="$HOME/.config/chatgpt-remote-commander/private-pair/$profile"
[ "$profile" = chatgpt-remote-commander ] && dir="$HOME/.config/chatgpt-remote-commander/private-pair/default"
config="$HOME/.local/state/chatgpt-remote-commander/profiles/$coreProfile/config.json"
[ -f "$config" ] && [ -d "$dir" ] || exit 2
runtime="/run/user/$(id -u)"
[ "$(stat -c %a "$runtime")" = 700 ] || exit 2
[ -z "$(ss -Hltpn "( sport = :$port )")" ] || { echo RC012_QA_PORT_BUSY;exit 2;}
qa=$(mktemp -d "$runtime/rc012-core-qa-XXXXXXXX")
# A stale failed transient unit must never block the next independent owner QA.
# Use the mktemp-generated suffix to isolate concurrent run lifecycles.
qaTag="${qa##*-}"
brokerUnit="rc012-no-grant-broker-$(id -u)-$qaTag"
qaUnit="rc012-no-grant-core-$(id -u)-$qaTag"
cleanup(){
 systemctl --user stop "$brokerUnit.service" >/dev/null 2>&1 || :
 # RuntimeMaxSec may leave a failed transient unit loaded after owner denial.
 systemctl --user reset-failed "$brokerUnit.service" >/dev/null 2>&1 || :
 rm -rf -- "$qa"
}
trap cleanup EXIT
mainUnit="${RC012_QA_MAIN_UNIT:-chatgpt-remote-commander.service}"
[[ "$mainUnit" =~ ^chatgpt-remote-commander([a-z0-9_-]*)\.service$ ]] || { echo RC012_INVALID_QA_MAIN_UNIT;exit 2;}
original=$(systemctl --user show "$mainUnit" -p MainPID --value)
[ "$original" -gt 1 ] || { echo RC012_ORIGINAL_CORE_NOT_RUNNING;exit 2;}
"$node" --input-type=module - "$qa" <<'JS'
import fs from 'node:fs';import path from 'node:path';import {generateKeyPairSync} from 'node:crypto';
const d=process.argv[2],k=generateKeyPairSync('ed25519');
fs.writeFileSync(path.join(d,'private.pem'),k.privateKey.export({format:'pem',type:'pkcs8'}),{flag:'wx',mode:0o600});
fs.writeFileSync(path.join(d,'public.pem'),k.publicKey.export({format:'pem',type:'spki'}),{flag:'wx',mode:0o600});
JS
cat > "$qa/loader.mjs" <<EOF
export async function resolve(specifier,context,nextResolve){
 const r=await nextResolve(specifier,context);
 if(r.url==='file:///usr/lib/chatgpt-remote-commander/app/src/native-owner-session-provider-linux.mjs')
   return {url:'file://$root/src/native-owner-session-provider-linux.mjs',shortCircuit:true};
 return r;
}
EOF
chmod 600 "$qa/loader.mjs"
systemd-run --user --quiet --unit="$brokerUnit" -p NoNewPrivileges=yes \
 -p RuntimeMaxSec=50s -E RC012_NATIVE_BROKER_SCOPE=READ_ONLY_OWNER_WITNESS \
 "$node" "$root/tools/linux-native-tunnel-observer-broker.mjs" \
 "$profile" "$dir" "$qa/proof.sock" "$qa/private.pem"
for i in $(seq 1 40);do [ -S "$qa/proof.sock" ] && break;sleep 0.1;done
[ -S "$qa/proof.sock" ] || { echo RC012_QA_BROKER_NOT_READY;exit 2;}
# Native consent only after explicit user opt-in.
extraEnv=()
if [ "${RC012_QA_J01_OWNER_BIND:-0}" = 1 ];then
 extraEnv=(-E RC012_CORE_BROKER_J01_BIND_REQUEST=OWNER_VISIBLE_J01_BIND_ONLY)
fi
systemd-run --user --quiet --pipe --wait --collect --unit="$qaUnit" \
 -p PrivateTmp=yes -p ProtectSystem=full -p NoNewPrivileges=yes \
 -E REMOTE_COMMANDER_CONFIG="$config" \
 -E RC012_OWNER_BOOTSTRAP_SCOPE=OWNER_ENROLLED_NO_GRANT \
 -E RC012_CORE_BROKER_QA_SCOPE=NO_EFFECTS \
 "${extraEnv[@]}" \
 -E RC012_OWNER_TUNNEL_PROFILE="$profile" \
 -E RC012_OWNER_PRIVATE_HTTPS_PORT="$port" \
 -E RC012_OWNER_WITNESS_SOCKET_PATH="$qa/proof.sock" \
 -E RC012_OWNER_WITNESS_PUBLIC_KEY_PATH="$qa/public.pem" \
 -E RC012_OWNER_PAIR_DIR="$dir" \
 "$node" --experimental-loader "$qa/loader.mjs" \
 "$root/tools/qa-v012-broker-core-no-grant-linux.mjs"
[ "$original" = "$(systemctl --user show "$mainUnit" -p MainPID --value)" ] || { echo RC012_ORIGINAL_CORE_PID_CHANGED;exit 2;}
echo RC012_PRODUCTION_CORE_AND_TUNNEL_UNCHANGED_NO_GRANT_QA_COMPLETE
