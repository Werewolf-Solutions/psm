import { digest } from "./plan.ts";

/** The port is validated by the machine registry before this is called. */
export function firewallPlan(port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SSH port");
  const script = `#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ $(id -u) == 0 ]] || { echo 'root access required' >&2; exit 77; }
[[ -d /run/systemd/system ]] && command -v systemd-run >/dev/null || { echo 'systemd rollback timer required' >&2; exit 65; }
if systemctl is-active --quiet docker 2>/dev/null; then echo 'Docker firewall rules need separate review' >&2; exit 65; fi
if ! command -v ufw >/dev/null; then
  [[ \${1:-} == --apply ]] || { echo 'ufw needs installation'; exit 0; }
  command -v apt-get >/dev/null || { echo 'apt-get required to install ufw' >&2; exit 65; }
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ufw
fi
status=$(ufw status | head -1)
[[ "$status" == 'Status: inactive' ]] || { echo "Existing firewall status: $status; review it separately" >&2; exit 65; }
if ufw show added | grep -q '^ufw '; then echo 'Existing UFW rules need separate review' >&2; exit 65; fi
if [[ \${1:-} == --inspect ]]; then echo 'Fresh inactive UFW firewall'; exit 0; fi
[[ \${1:-} == --apply ]] || exit 64
ufw default deny incoming
ufw default allow outgoing
ufw allow ${port}/tcp comment 'PSM SSH'
ufw allow 80/tcp comment 'PSM HTTP'
ufw allow 443/tcp comment 'PSM HTTPS'
systemd-run --unit=psm-firewall-rollback --on-active=120s /usr/sbin/ufw disable >/dev/null
ufw --force enable
ufw status verbose
`;
  return {
    script,
    digest: digest(script),
    operations: ["Require a verified administrator SSH key and a fresh Ubuntu host with inactive UFW and no existing rules.", "Install UFW if absent; deny incoming traffic while allowing outgoing traffic.", `Allow TCP ${port} for SSH and TCP 80/443 for web traffic.`, "Arm a two-minute automatic firewall disable, enable UFW, reconnect over SSH, then cancel the timer only after verification."],
  };
}
