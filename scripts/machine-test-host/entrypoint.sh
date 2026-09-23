#!/bin/sh
# Authorize the test's administrator key for root and both sudo users, then run sshd.
set -eu
if [ -n "${PSM_TEST_ADMIN_KEY:-}" ]; then
  for home in /root /home/admin-nopass /home/admin-pass; do
    user=$(stat -c %U "$home")
    mkdir -p "$home/.ssh"
    printf '%s\n' "$PSM_TEST_ADMIN_KEY" > "$home/.ssh/authorized_keys"
    chown -R "$user:$user" "$home/.ssh"
    chmod 700 "$home/.ssh"; chmod 600 "$home/.ssh/authorized_keys"
  done
fi
exec /usr/sbin/sshd -D -e
