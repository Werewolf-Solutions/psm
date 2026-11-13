import { execFile } from "node:child_process";
import { isIP } from "node:net";

export type AuditStatus = "pass" | "attention" | "unknown" | "unavailable" | "info";
export interface AuditCheck { id: string; title: string; status: AuditStatus; detail: string }
export interface MachineAuditReport {
  machineId: string;
  machineName: string;
  address: string;
  observedAt: number;
  scope: "internal" | "agent-external";
  vantage: string;
  checks: AuditCheck[];
}

export interface AuditCommandResult { code: number | null; stdout: string; stderr: string; error?: string }
export type AuditCommandRunner = (file: string, args: string[], timeoutMs: number) => Promise<AuditCommandResult>;

/** No shell and bounded output: a registered machine address is still untrusted input. */
export const runAuditCommand: AuditCommandRunner = (file, args, timeoutMs) => new Promise((resolve) => {
  execFile(file, args, { timeout: timeoutMs, maxBuffer: 128 * 1024, encoding: "utf8", env: { PATH: process.env.PATH || "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" } }, (error, stdout, stderr) => {
    resolve({ code: error ? (typeof error.code === "number" ? error.code : null) : 0, stdout, stderr,
      ...(error ? { error: String(error.code) === "ENOENT" ? `${file} is not installed on this PSM agent.` : error.killed ? `${file} exceeded its time limit.` : error.message } : {}) });
  });
});

export const INTERNAL_AUDIT_SCRIPT = `import json, shutil, subprocess

def run(args, timeout=12):
    if not shutil.which(args[0]): return {'available': False, 'detail': args[0] + ' is not installed'}
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
        return {'available': True, 'code': result.returncode, 'out': result.stdout[:16000], 'error': result.stderr[:1000]}
    except subprocess.TimeoutExpired:
        return {'available': False, 'detail': args[0] + ' timed out'}

result = {
    'sshd': run(['sshd', '-T']),
    'firewall': run(['ufw', 'status', 'verbose']),
    'listeners': run(['ss', '-H', '-lntu']),
    'updates': run(['systemctl', 'is-enabled', 'unattended-upgrades.service']),
    'lynis': run(['lynis', 'audit', 'system', '--quick', '--no-colors'], 90),
}
print(json.dumps(result, separators=(',', ':')))
`;

type CommandObservation = { available: boolean; code?: number; out?: string; error?: string; detail?: string };
export function internalAuditChecks(observed: Record<string, CommandObservation>, sshPort: number): AuditCheck[] {
  const checks: AuditCheck[] = [];
  const unavailable = (id: string, title: string, item?: CommandObservation) => checks.push({ id, title, status: "unavailable", detail: item?.detail || item?.error || "No observation" });
  const sshd = observed.sshd;
  if (!sshd?.available || sshd.code !== 0) unavailable("ssh", "Effective SSH settings", sshd);
  else {
    const settings = Object.fromEntries((sshd.out || "").split("\n").map((line) => line.trim().split(/\s+/, 2)).filter((parts) => parts.length === 2));
    const password = settings.passwordauthentication;
    const keyboard = settings.kbdinteractiveauthentication;
    const root = settings.permitrootlogin;
    const publicKey = settings.pubkeyauthentication;
    const pass = password === "no" && keyboard === "no" && root === "no" && publicKey === "yes";
    checks.push({ id: "ssh", title: "Effective SSH settings", status: pass ? "pass" : "attention",
      detail: `Password ${password || "unknown"}; keyboard interactive ${keyboard || "unknown"}; root login ${root || "unknown"}; public key ${publicKey || "unknown"}. Values are the default sshd context; Match rules need separate review.` });
  }
  const firewall = observed.firewall;
  if (!firewall?.available || firewall.code !== 0) unavailable("firewall", "Host firewall", firewall);
  else {
    const output = firewall.out || "";
    const active = /^Status:\s+active/m.test(output);
    const deny = /Default:\s+deny\s*\(incoming\)/i.test(output);
    const ssh = new RegExp(`^${sshPort}\\/tcp\\s+ALLOW IN`, "m").test(output);
    checks.push({ id: "firewall", title: "Host firewall", status: active && deny && ssh ? "pass" : "attention",
      detail: `UFW ${active ? "active" : "inactive"}; incoming default ${deny ? "deny" : "not confirmed deny"}; SSH ${sshPort}/tcp ${ssh ? "allowed" : "not confirmed"}.` });
  }
  const listeners = observed.listeners;
  if (!listeners?.available || listeners.code !== 0) unavailable("listeners", "Listening sockets", listeners);
  else {
    const lines = (listeners.out || "").split("\n").filter(Boolean);
    const publicSockets = lines.filter((line) => /(?:0\.0\.0\.0|\[?::\]?|\*)[:.]\d+\s/.test(`${line} `));
    checks.push({ id: "listeners", title: "Listening sockets", status: "info", detail: `${lines.length} TCP/UDP listeners observed; ${publicSockets.length} appear bound to all interfaces. Review the machine snapshot and external scan for exposure.` });
  }
  const updates = observed.updates;
  checks.push({ id: "updates", title: "Unattended updates", status: !updates?.available ? "unavailable" : updates.code === 0 && (updates.out || "").trim() === "enabled" ? "pass" : "attention",
    detail: !updates?.available ? updates?.detail || "systemctl unavailable" : `unattended-upgrades.service: ${(updates.out || updates.error || "unknown").trim().slice(0, 100)}.` });
  const lynis = observed.lynis;
  if (!lynis?.available) unavailable("lynis", "Lynis audit", lynis);
  else {
    const output = lynis.out || "";
    const score = /Hardening index\s*:\s*(\d+)/i.exec(output)?.[1];
    checks.push({ id: "lynis", title: "Lynis audit", status: lynis.code === 0 ? "info" : "attention",
      detail: `Audit exited ${lynis.code ?? "unknown"}${score ? `; hardening index ${score}` : ""}. Review Lynis findings on the host; a score alone is not a release gate.` });
  }
  return checks;
}

export async function externalAuditChecks(host: string, sshPort: number, runner: AuditCommandRunner = runAuditCommand): Promise<AuditCheck[]> {
  const checks: AuditCheck[] = [];
  const ip6 = isIP(host) === 6 ? ["-6"] : [];
  const tcp = await runner("nmap", [...ip6, "-Pn", "-n", "-p-", "--open", "--host-timeout", "150s", host], 160_000);
  if (tcp.error || tcp.code !== 0 || /host timed out/i.test(tcp.stdout) || !/Nmap done:.*\(1 host up\)/i.test(tcp.stdout)) checks.push({ id: "tcp", title: "All TCP ports", status: "unavailable", detail: tcp.error || tcp.stderr.trim() || "Nmap did not confirm a completed scan with the host reachable." });
  else {
    const ports = [...tcp.stdout.matchAll(/^(\d+)\/tcp\s+open\s+/gm)].map((match) => Number(match[1]));
    const unexpected = ports.filter((port) => ![sshPort, 80, 443].includes(port));
    checks.push({ id: "tcp", title: "All TCP ports", status: !ports.includes(sshPort) || unexpected.length ? "attention" : "pass",
      detail: `Open TCP: ${ports.join(", ") || "none"}. ${unexpected.length ? `Unexpected: ${unexpected.join(", ")}.` : "No unexpected open TCP port observed."} Expected web ports depend on deployment stage.` });
  }
  const udp = await runner("nmap", [...ip6, "-sU", "--top-ports", "100", "-Pn", "-n", "--open", "--host-timeout", "60s", host], 70_000);
  if (udp.error || udp.code !== 0 || /host timed out/i.test(udp.stdout) || !/Nmap done:.*\(1 host up\)/i.test(udp.stdout)) checks.push({ id: "udp", title: "Top 100 UDP ports", status: "unavailable", detail: udp.error || udp.stderr.trim() || "Nmap did not confirm a completed scan with the host reachable." });
  else {
    const open = [...udp.stdout.matchAll(/^(\d+)\/udp\s+open\s+/gm)].map((match) => Number(match[1]));
    const ambiguous = [...udp.stdout.matchAll(/^(\d+)\/udp\s+open\|filtered\s+/gm)].map((match) => Number(match[1]));
    checks.push({ id: "udp", title: "Top 100 UDP ports", status: open.length ? "attention" : ambiguous.length ? "unknown" : "pass",
      detail: `${open.length} confirmed open; ${ambiguous.length} open|filtered (inconclusive).${open.length ? ` Open: ${open.join(", ")}.` : ""}` });
  }
  const ssh = await runner("ssh-audit", ["-j", "-p", String(sshPort), host], 30_000);
  checks.push({ id: "ssh-audit", title: "External SSH algorithms", status: ssh.error ? "unavailable" : ssh.code === 0 ? "info" : "attention",
    detail: ssh.error || `ssh-audit exited ${ssh.code}. Its JSON findings need review; exit status alone does not prove that algorithms are safe. ${(ssh.stdout || ssh.stderr).slice(0, 2000)}` });
  return checks;
}
