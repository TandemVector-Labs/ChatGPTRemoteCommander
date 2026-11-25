#!/usr/bin/env bash
# RC012 owner-local Linux recovery. Systemd user-scoped, host-key encrypted.
# Never changes the active Tunnel, profile, API key, service, or privileges.
set -Eeuo pipefail
umask 077
mode="${1:-}"
if { [ "$#" -ne 1 ] && [ "$#" -ne 2 ]; } ||
   [[ ! "$mode" =~ ^(Stage|Verify|TestRestore)$ ]];then
 echo RC012_LINUX_OWNER_CREDS_MODE_INVALID >&2;exit 2
fi
explicitProfile=0
profileName="Emad"
if [ "$#" -eq 2 ];then
 [[ "$2" == --profile-name=* ]] ||
 { echo RC012_OWNER_PROFILE_ARGUMENT_INVALID >&2;exit 2; }
 profileName="${2#--profile-name=}"
 explicitProfile=1
fi
[[ "$profileName" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] &&
 [ "$profileName" != "." ] && [ "$profileName" != ".." ] ||
 { echo RC012_OWNER_PROFILE_ARGUMENT_INVALID >&2;exit 2; }
uid="$(id -u)"
config="$HOME/.config"
backupParent="$HOME/.local/state/chatgpt-remote-commander/owner-recovery"
# The historical single-Emad capsule keeps its original identity and path.
# Every explicit owner profile uses its own protected capsule; never borrow
# another account's file set or overwrite a legacy owner recovery receipt.
if [ "$explicitProfile" -eq 1 ];then
 target="$backupParent/rc012-native-pair-systemd-creds-$profileName"
else
 target="$backupParent/rc012-native-pair-systemd-creds"
fi
# The credential encryption key name is owner-profile scoped as well as
# the capsule directory. Legacy one-argument archives retain their old name.
credentialName="rc012-native-pair"
if [ "$explicitProfile" -eq 1 ];then
 credentialName="rc012-native-pair-$profileName"
fi
pairName="$profileName"
if [ "$profileName" = chatgpt-remote-commander ] ||
   { [ "$profileName" = Emad ] &&
     [ ! -e "$config/tunnel-client/chatgpt-remote-commander.yaml" ]; };then
 pairName="default"
fi
files="tunnel-client/$profileName.yaml
chatgpt-remote-commander/private-pair/$pairName/ca.crt
chatgpt-remote-commander/private-pair/$pairName/client.crt
chatgpt-remote-commander/private-pair/$pairName/client.key
chatgpt-remote-commander/private-pair/$pairName/server.crt
chatgpt-remote-commander/private-pair/$pairName/server.key"
stage=""
restore=""
clean(){ if [ -n "$restore" ] && [ -d "$restore" ];then rm -rf -- "$restore";fi
 if [ -n "$stage" ] && [ -d "$stage" ];then rm -rf -- "$stage";fi; }
trap clean EXIT
command -v systemd-creds >/dev/null || { echo RC012_USER_CREDS_MISSING >&2;exit 2; }
function safe_dir(){
 local p="$1"
 [ -d "$p" ] && [ ! -L "$p" ] &&
 [ "$(stat -c %u "$p")" = "$uid" ] &&
 [ $((8#$(stat -c %a "$p") & 077)) -eq 0 ] ||
 { echo RC012_USER_CREDS_OWNER_DIRECTORY_UNSAFE >&2;exit 2; }
}
function safe_file(){
 local p="$1"
 [ -f "$p" ] && [ ! -L "$p" ] &&
 [ "$(stat -c %u "$p")" = "$uid" ] &&
 [ $((8#$(stat -c %a "$p") & 077)) -eq 0 ] &&
 [ "$(stat -c %s "$p")" -gt 0 ] &&
 [ "$(stat -c %s "$p")" -le 262144 ] ||
 { echo RC012_USER_CREDS_OWNER_FILE_UNSAFE >&2;exit 2; }
}
function digest_tree(){
 local root="$1" rel total=0
 for rel in $files;do
  safe_file "$root/$rel"
  total=$((total+$(stat -c %s "$root/$rel")))
  [ "$total" -le 524288 ] ||
    { echo RC012_USER_CREDS_SIZE_LIMIT >&2;exit 2; }
 done
 for rel in $files;do
  printf '%s:%s\n' "$rel" "$(sha256sum "$root/$rel"|cut -d' ' -f1)"
 done | sha256sum | cut -d' ' -f1
}
function verify_capsule(){
 local dir="$1" magic baseline cipher expected listing
 safe_dir "$dir"
 safe_file "$dir/owner-pair.cred"
 safe_file "$dir/receipt"
 magic="$(sed -n '1p' "$dir/receipt")"
 baseline="$(sed -n '2p' "$dir/receipt")"
 expected="$(sed -n '3p' "$dir/receipt")"
 [ "$magic" = RC012_USER_CREDS_V1 ] &&
 [[ "$baseline" =~ ^[0-9a-f]{64}$ && "$expected" =~ ^[0-9a-f]{64}$ ]] &&
 [ "$(wc -l < "$dir/receipt")" -eq 3 ] ||
 { echo RC012_USER_CREDS_RECEIPT_INVALID >&2;exit 2; }
 cipher="$(sha256sum "$dir/owner-pair.cred"|cut -d' ' -f1)"
 [ "$cipher" = "$expected" ] ||
 { echo RC012_USER_CREDS_CIPHERTEXT_TAMPERED >&2;exit 2; }
 restore="$(mktemp -d "$backupParent/.dry-restore-XXXXXXXX")"
 chmod 700 "$restore"
 listing="$(systemd-creds decrypt --user --name="$credentialName" \
    "$dir/owner-pair.cred" - 2>/dev/null | tar -tf - | sha256sum | cut -d' ' -f1)" ||
 { echo RC012_USER_CREDS_ARCHIVE_CORRUPT >&2;exit 2; }
 [ "$listing" = "$(printf '%s\n' $files | sha256sum | cut -d' ' -f1)" ] ||
 { echo RC012_USER_CREDS_ARCHIVE_PATH_INVALID >&2;exit 2; }
 systemd-creds decrypt --user --name="$credentialName" \
     "$dir/owner-pair.cred" - 2>/dev/null | tar -xf - -C "$restore"
 [ "$(digest_tree "$restore")" = "$baseline" ] ||
 { echo RC012_USER_CREDS_DRY_RESTORE_MISMATCH >&2;exit 2; }
 rm -rf -- "$restore";restore=""
 printf '%s' "$baseline"
}
if [ "$mode" = Verify ] || [ "$mode" = TestRestore ];then
 verify_capsule "$target" >/dev/null
 if [ "$mode" = Verify ];then
  echo RC012_LINUX_OWNER_CREDS_VERIFY_PASS_files_6
 else
  echo RC012_LINUX_OWNER_CREDS_DRY_RESTORE_PASS_files_6
 fi
 exit 0
fi
safe_dir "$config"
safe_dir "$config/tunnel-client"
safe_dir "$config/chatgpt-remote-commander"
safe_dir "$config/chatgpt-remote-commander/private-pair"
safe_dir "$config/chatgpt-remote-commander/private-pair/$pairName"
baseline="$(digest_tree "$config")"
for d in "$HOME/.local" "$HOME/.local/state" "$HOME/.local/state/chatgpt-remote-commander";do
 safe_dir "$d"
done
if [ ! -e "$backupParent" ];then mkdir -m 700 -- "$backupParent";fi
safe_dir "$backupParent"
if [ -e "$target" ];then
 old="$(verify_capsule "$target")"
 [ "$old" = "$baseline" ] ||
 { echo RC012_USER_CREDS_EXISTING_BASELINE_CHANGED >&2;exit 2; }
 echo RC012_LINUX_OWNER_CREDS_REUSED_files_6
 exit 0
fi
stage="$(mktemp -d "$backupParent/.stage-XXXXXXXX")"
chmod 700 "$stage"
# Plaintext tar stays in the pipe; the only persistent archive is encrypted.
tar -cf - -C "$config" -- $files |
 systemd-creds encrypt --user --with-key=host --name="$credentialName" \
  - "$stage/owner-pair.cred" >/dev/null
chmod 600 "$stage/owner-pair.cred"
cipher="$(sha256sum "$stage/owner-pair.cred"|cut -d' ' -f1)"
printf 'RC012_USER_CREDS_V1\n%s\n%s\n' "$baseline" "$cipher" > "$stage/receipt"
chmod 600 "$stage/receipt"
[ "$(verify_capsule "$stage")" = "$baseline" ] ||
 { echo RC012_USER_CREDS_STAGE_MISMATCH >&2;exit 2; }
mv -- "$stage" "$target"
stage=""
echo RC012_LINUX_OWNER_CREDS_STAGE_PASS_files_6
