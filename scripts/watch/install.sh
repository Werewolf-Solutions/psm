#!/bin/bash
set -euo pipefail
# Reviewed root installation; no existing app, route or deployment account is changed.
[[ $(id -u) == 0 ]] || { echo 'Run as root'; exit 1; }
[[ -f ./watch.mjs && -f ./monitors.json && -f ./reader.pub ]] || { echo 'Supply watch.mjs, monitors.json and reader.pub'; exit 1; }
[[ -n ${WATCH_NODE_SOURCE:-} && -x $WATCH_NODE_SOURCE ]] || { echo 'Set WATCH_NODE_SOURCE to a trusted Node 22 binary'; exit 1; }
[[ -n ${WATCH_FAILURE_DOMAIN:-} ]] || { echo 'Set WATCH_FAILURE_DOMAIN to same-host or independent-host'; exit 1; }
case $WATCH_FAILURE_DOMAIN in same-host|independent-host) ;; *) exit 1;; esac
[[ $($WATCH_NODE_SOURCE -p 'Number(process.versions.node.split(".")[0])') -ge 22 ]] || exit 1
[[ $(wc -l < reader.pub) -eq 1 ]] && [[ $(cat reader.pub) =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ .*)?$ ]] || exit 1
if [[ ! -d /opt/psm-watch ]]; then
  for account in psm-watch psm-watch-read; do ! getent passwd "$account" >/dev/null || { echo "Account already exists: $account"; exit 1; }; done
else
  [[ -f /opt/psm-watch/owned-by-psm ]] || { echo 'Unowned installation'; exit 1; }
fi
id psm-watch >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /var/lib/psm-watch --shell /usr/sbin/nologin psm-watch
id psm-watch-read >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/psm-watch-reader --shell /bin/sh psm-watch-read
usermod -a -G psm-watch psm-watch-read
install -d -o root -g root -m 755 /opt/psm-watch /opt/psm-watch/bin /etc/psm-watch
install -d -o psm-watch -g psm-watch -m 750 /var/lib/psm-watch /var/lib/psm-watch/snapshots
install -m 755 "$WATCH_NODE_SOURCE" /opt/psm-watch/bin/node.new
mv /opt/psm-watch/bin/node.new /opt/psm-watch/bin/node
install -m 644 watch.mjs /opt/psm-watch/watch.mjs
install -o root -g psm-watch -m 640 monitors.json /etc/psm-watch/monitors.json
touch /opt/psm-watch/owned-by-psm
install -d -o psm-watch-read -g psm-watch-read -m 700 /var/lib/psm-watch-reader/.ssh
printf 'command="/opt/psm-watch/bin/node --disable-warning=ExperimentalWarning /opt/psm-watch/watch.mjs read",restrict %s\n' "$(cat reader.pub)" > /var/lib/psm-watch-reader/.ssh/authorized_keys
chown psm-watch-read:psm-watch-read /var/lib/psm-watch-reader/.ssh/authorized_keys
chmod 600 /var/lib/psm-watch-reader/.ssh/authorized_keys
cat > /etc/systemd/system/psm-watch.service <<UNIT
[Unit]
Description=Werewolf Watch public HTTPS monitoring
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=psm-watch
Group=psm-watch
ExecStart=/opt/psm-watch/bin/node --disable-warning=ExperimentalWarning /opt/psm-watch/watch.mjs
Environment=WEREWOLF_WATCH_FAILURE_DOMAIN=$WATCH_FAILURE_DOMAIN
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ReadWritePaths=/var/lib/psm-watch
MemoryMax=96M
CPUQuota=15%
TasksMax=32
UMask=0027
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable psm-watch.service
systemctl restart psm-watch.service
