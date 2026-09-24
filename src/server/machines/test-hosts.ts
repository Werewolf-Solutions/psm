/**
 * Disposable SSH servers for machine-onboarding tests.
 *
 * - `docker`: an unprivileged sshd container on this computer
 *   (scripts/machine-test-host). No systemd, so nothing that installs a service.
 * - `lxd`: an Ubuntu 20.04 LXD system container with real systemd, reached
 *   through an SSH administrator connection to the LXD host and reset from its
 *   `clean` snapshot before each run. See scripts/machine-test-host/LXD.md.
 *
 * Never a privileged or host-cgroup container on a desktop: that took over the
 * host's devices and froze its display session.
 */
import { execFileSync } from "node:child_process";

export interface TestHost {
  kind: "docker" | "lxd";
  address: string;
  port: number;
  systemd: boolean;
  /** Run a command as root inside the test server. */
  exec(...command: string[]): string;
  /** Replace the server's SSH host keys (to test a changed identity). */
  rotateHostKeys(): void;
  close(): void;
}

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

/** A POSIX single-quoted word, for commands that pass through a remote shell. */
function word(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function selectedTestHost(): "docker" | "lxd" | null {
  if (process.env.PSM_MACHINE_LXD === "1") return "lxd";
  if (process.env.PSM_MACHINE_DOCKER === "1") return "docker";
  return null;
}

export function startTestHost(kind: "docker" | "lxd", adminPublicKey: string): TestHost {
  if (kind === "docker") {
    const image = process.env.PSM_MACHINE_IMAGE || "psm-machine-test-host:20.04";
    const container = docker("run", "-d", "--rm", "-p", "127.0.0.1::22", "-e", `PSM_TEST_ADMIN_KEY=${adminPublicKey}`, image);
    const port = Number(docker("port", container, "22/tcp").split("\n")[0].split(":").pop());
    const exec = (...command: string[]) => docker("exec", container, ...command);
    return {
      kind, address: "127.0.0.1", port, systemd: false, exec,
      rotateHostKeys: () => { exec("sh", "-c", "rm -f /etc/ssh/ssh_host_* && ssh-keygen -A >/dev/null && pkill -HUP -x sshd"); },
      close: () => { try { docker("rm", "-f", container); } catch { /* already gone */ } },
    };
  }
  const sshConfig = process.env.PSM_MACHINE_LXD_SSH_CONFIG || "/srv/homelab/ssh/config";
  const sshHost = process.env.PSM_MACHINE_LXD_SSH_HOST || "homelab";
  const hostName = process.env.PSM_MACHINE_LXD_HOSTNAME || "10.42.0.215";
  const instance = process.env.PSM_MACHINE_LXD_INSTANCE || "psm-test";
  const port = Number(process.env.PSM_MACHINE_LXD_PORT || 2222);
  const lxdHost = (remote: string) => execFileSync("ssh", [
    "-F", sshConfig, "-o", "BatchMode=yes", "-o", "IdentityAgent=none", "-o", `HostName=${hostName}`, "-o", "HostKeyAlias=homelab.local", sshHost, remote,
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
  const exec = (...command: string[]) => lxdHost(`/snap/bin/lxc exec ${word(instance)} -- ${command.map(word).join(" ")}`);
  lxdHost(`/snap/bin/lxc restore ${word(instance)} clean`);
  exec("sh", "-c", `for home in /root /home/admin-nopass /home/admin-pass; do printf '%s\\n' ${word(adminPublicKey)} > "$home/.ssh/authorized_keys"; done; systemctl is-active --quiet ssh || systemctl start ssh`);
  return {
    kind, address: hostName, port, systemd: true, exec,
    rotateHostKeys: () => { exec("sh", "-c", "rm -f /etc/ssh/ssh_host_* && ssh-keygen -A >/dev/null && systemctl restart ssh"); },
    close: () => { try { lxdHost(`/snap/bin/lxc restore ${word(instance)} clean`); } catch { /* left for the next run to reset */ } },
  };
}
