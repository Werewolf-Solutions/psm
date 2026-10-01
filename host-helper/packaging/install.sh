#!/bin/sh
set -eu

usage() {
  echo "usage: install.sh [--dry-run] <linux-amd64-or-arm64-binary>" >&2
  exit 64
}

dry_run=false
if [ "${1:-}" = "--dry-run" ]; then
  dry_run=true
  shift
fi
[ "$#" -eq 1 ] || usage
binary=$1
[ -f "$binary" ] || { echo "install.sh: helper binary not found" >&2; exit 66; }
[ "$(id -u)" -eq 0 ] || { echo "install.sh: root is required" >&2; exit 77; }

run() {
  description=$1
  shift
  if [ "$dry_run" = true ]; then
    printf '%s:' "$description"
    for argument in "$@"; do printf ' %s' "$argument"; done
    printf '\n'
  else
    "$@"
  fi
}

run "create system group" groupadd --system --force psm-deploy
# A fresh Ubuntu 24.04 has no /usr/local/libexec.
run "create libexec directory" install -d -o root -g root -m 0755 /usr/local/libexec /etc/psm-deploy
# Every ReadWritePaths entry without "-" must exist, or the helper's sandbox refuses to start
# (the same directories psm's Machines setup creates).
run "create web and certificate directories" install -d -o root -g root -m 0755 /var/www /var/www/certbot /etc/letsencrypt /var/lib/letsencrypt /var/log/letsencrypt
run "install helper binary" install -o root -g root -m 0755 "$binary" /usr/local/libexec/psm-host-helper
run "install forced-command client" install -o root -g root -m 0755 packaging/psm-host-helper-client.sh /usr/local/libexec/psm-host-helper-client
run "install systemd unit" install -o root -g root -m 0644 packaging/psm-host-helper.service /etc/systemd/system/psm-host-helper.service
run "create target contracts directory" install -d -o root -g psm-deploy -m 0750 /etc/psm-deploy/targets
run "create helper state directory" install -d -o root -g psm-deploy -m 0750 /var/lib/psm-deploy
run "create service environment directory" install -d -o root -g root -m 0700 /etc/psm-deploy/services
run "reload systemd" systemctl daemon-reload
run "enable and start helper" systemctl enable --now psm-host-helper.service
