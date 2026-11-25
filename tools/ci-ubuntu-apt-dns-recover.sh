#!/usr/bin/env bash
# Disposable GitHub-hosted Ubuntu CI only: recover apt name resolution.
# Official Ubuntu apt signatures remain mandatory. No host-owner routes, keys,
# credentials or release/promotion authorization are modified by this script.
set -euo pipefail
if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_ENVIRONMENT:-}" != github-hosted ||
      "${RUNNER_OS:-}" != Linux ]]; then
  echo 'RC_CI_DNS_REFUSED_NON_GITHUB_HOSTED_RUNNER' >&2
  exit 3
fi
if ! grep -q '^ID=ubuntu$' /etc/os-release; then
  echo 'RC_CI_DNS_REFUSED_NON_UBUNTU' >&2
  exit 3
fi
dns_ok(){
  timeout 8s getent ahostsv4 archive.ubuntu.com >/dev/null 2>&1 &&
  timeout 8s getent ahostsv4 security.ubuntu.com >/dev/null 2>&1
}
if dns_ok; then echo 'RC_CI_DNS_DEFAULT_PASS'; exit 0; fi

# First prefer the official Azure platform DNS of GitHub's disposable Azure VM.
if command -v resolvectl >/dev/null && command -v ip >/dev/null; then
  dev="$(ip -4 route get 168.63.129.16 | awk '{
    for(i=1;i<=NF;i++)if($i=="dev"){print $(i+1);exit}
  }')"
  if [[ "$dev" =~ ^[A-Za-z0-9_.:-]{1,32}$ ]]; then
    sudo resolvectl dns "$dev" 168.63.129.16
    sudo resolvectl domain "$dev" '~.'
    sudo resolvectl flush-caches
    if dns_ok; then echo 'RC_CI_DNS_AZURE_PLATFORM_PASS'; exit 0; fi
  fi
fi

# The Azure resolver has failed in hosted CI. Bootstrap *only* public Ubuntu
# apt hostnames with an authenticated, bounded HTTPS DNS query. --resolve
# pins Cloudflare DoH endpoint reachability independently of the broken DNS.
# The TLS server identity is still validated (never --insecure). Apt package
# and repository signatures remain enforced by the unmodified distro sources.
command -v curl >/dev/null
command -v python3 >/dev/null
hosts="$(mktemp)"
trap 'rm -f "$hosts"' EXIT
for host in azure.archive.ubuntu.com archive.ubuntu.com security.ubuntu.com github.com nodejs.org; do
  json="$(curl --noproxy '*' --fail --silent --show-error --connect-timeout 3 \
    --max-time 9 --resolve cloudflare-dns.com:443:1.1.1.1 \
    --header 'accept: application/dns-json' \
    "https://cloudflare-dns.com/dns-query?name=$host&type=A")"
  ip="$(printf '%s' "$json" | python3 -c '
import sys,json,ipaddress
canon=lambda s:s.lower().rstrip(".")+"."
name=canon(sys.argv[1])
doc=json.load(sys.stdin)
assert doc.get("Status")==0 and doc.get("TC") is False
questions=doc.get("Question",[])
assert len(questions)==1 and canon(questions[0].get("name",""))==name
assert questions[0].get("type")==1
chain={name}
records=doc.get("Answer",[])
assert isinstance(records,list) and len(records)<=32
for record in records:
    if record.get("type")==5 and canon(record.get("name","")) in chain:
        chain.add(canon(record["data"]))
ips=[]
for record in records:
    if record.get("type")==1 and canon(record.get("name","")) in chain:
        ip=ipaddress.IPv4Address(record["data"])
        if ip.is_global: ips.append(str(ip))
assert ips, "RC_CI_DOH_NO_PUBLIC_SIGNED_UBUNTU_MIRROR_IP"
print(sorted(set(ips))[0])
' "$host")"
  [[ "$ip" =~ ^[0-9.]{7,15}$ ]] || exit 4
  printf '%s %s\n' "$ip" "$host" >> "$hosts"
done
sudo sh -c 'cat "$1" >> /etc/hosts' sh "$hosts"
if ! dns_ok; then
  echo 'RC_CI_DOH_UBUNTU_HOSTS_RECOVERY_FAILED' >&2
  exit 4
fi
echo 'RC_CI_DOH_UBUNTU_HOSTS_RECOVERY_PASS'
