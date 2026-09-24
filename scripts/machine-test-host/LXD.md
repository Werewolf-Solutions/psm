# Systemd test host on the homelab (LXD)

Tests that install services need real systemd. Never get it from a privileged
or host-cgroup Docker container on the desktop: on 2026-09-23 that took over the
host's devices and froze the display session twice. Use an LXD system container
on the homelab instead: unprivileged, isolated from the desktop, with systemd
as PID 1.

Set up on 2026-09-24 over the direct Ethernet link (`/srv/homelab/start-connection.sh`,
homelab at `10.42.0.215`):

- LXD 5.21 snap, initialised by the `homelab` user (member of `lxd`, no sudo):
  `dir` storage pool `default`, NAT bridge `lxdbr0` on `10.77.0.1/24`, IPv6 off.
- Instance `psm-test`: `ubuntu:20.04` (the release on the first real target),
  with `openssh-server`, `sudo`, and two sudo users mirroring the Docker image:
  `admin-nopass` (NOPASSWD) and `admin-pass` (password required).
- Proxy device `ssh2222`: `10.42.0.215:2222` → the container's port 22.
- Snapshot `clean`: restored at the start and end of every test run.

Run the real-server suite there:

```sh
PSM_MACHINE_LXD=1 npx tsx --test src/server/machines/real-host.test.ts
```

Overrides: `PSM_MACHINE_LXD_SSH_CONFIG`, `PSM_MACHINE_LXD_SSH_HOST`,
`PSM_MACHINE_LXD_HOSTNAME`, `PSM_MACHINE_LXD_INSTANCE`, `PSM_MACHINE_LXD_PORT`.

Remove it all with `lxc delete --force psm-test` and, if LXD is no longer wanted,
`sudo snap remove lxd` on the homelab.
