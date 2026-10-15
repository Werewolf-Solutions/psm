import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Which of the operator's own SSH keys can already reach a machine.
 *
 * Adding a machine used to start with "paste a setup command" or "paste a
 * private key". Most operators already have a key the server accepts, so PSM
 * looks first: it lists the public keys in ~/.ssh, then tries each one on its
 * own against the pinned host key. Only the public half and a verdict leave
 * this module; a working personal key is used once to install PSM's own
 * access and is never copied into PSM's credential store.
 *
 * Each key is tried with the agent switched off. With the agent on, ssh offers
 * every loaded identity, so a refused key can look like it works.
 */

export interface LocalKey {
  name: string;
  privatePath: string;
  type: string;
  bits: number;
  fingerprint: string;
  comment: string;
  /** A passphrase-protected key cannot be used unattended. */
  encrypted: boolean;
}

export type KeyOutcome = "works" | "refused" | "passphrase" | "unreachable" | "host-key-mismatch" | "error";
export interface KeyTest { key: string; fingerprint: string; user: string; outcome: KeyOutcome; sudo: boolean; detail: string }

export type Run = (file: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;

const run: Run = (file, args, timeoutMs) => new Promise(resolve => {
  execFile(file, args, { timeout: timeoutMs, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, encoding: "utf8", maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
    resolve({ code: error ? (typeof error.code === "number" ? error.code : 255) : 0, stdout, stderr });
  });
});

/** The operator's key pairs in ~/.ssh: a .pub file with its private half beside it. */
export async function discoverKeys(directory = path.join(os.homedir(), ".ssh"), exec: Run = run): Promise<LocalKey[]> {
  let names: string[];
  try { names = await fs.readdir(directory); } catch { return []; }
  const keys: LocalKey[] = [];
  for (const file of names.filter(name => name.endsWith(".pub")).sort()) {
    const privatePath = path.join(directory, file.slice(0, -4));
    try { if (!(await fs.stat(privatePath)).isFile()) continue; } catch { continue; }
    const listed = await exec("ssh-keygen", ["-l", "-f", path.join(directory, file)], 10_000);
    const match = /^(\d+) (SHA256:\S+) (.*) \((\w+)\)$/.exec(listed.stdout.trim());
    if (listed.code !== 0 || !match) continue;
    // Deriving the public key with an empty passphrase fails only for an encrypted key.
    const derived = await exec("ssh-keygen", ["-y", "-P", "", "-f", privatePath], 10_000);
    keys.push({ name: file.slice(0, -4), privatePath, bits: Number(match[1]), fingerprint: match[2], comment: match[3], type: match[4], encrypted: derived.code !== 0 });
  }
  return keys;
}

/** Try each key on its own, for each user, against host keys the operator already accepted. */
export async function testKeys(input: { host: string; port?: number; knownHosts: string; users: string[]; keys: LocalKey[] }, exec: Run = run): Promise<KeyTest[]> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "psm-keytest-"));
  try {
    const hostsPath = path.join(temporary, "known_hosts");
    await fs.writeFile(hostsPath, `${input.knownHosts.trim()}\n`, { mode: 0o600, flag: "wx" });
    const results: KeyTest[] = [];
    for (const key of input.keys) {
      for (const user of input.users) {
        if (key.encrypted) { results.push({ key: key.name, fingerprint: key.fingerprint, user, outcome: "passphrase", sudo: false, detail: "This key has a passphrase, so PSM cannot use it unattended." }); continue; }
        const answer = await exec("ssh", [
          "-F", "/dev/null", "-n",
          "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
          "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
          "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${hostsPath}`, "-o", "GlobalKnownHostsFile=/dev/null",
          "-o", "ConnectTimeout=8", "-o", "RequestTTY=no", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes",
          "-p", String(input.port ?? 22), "-i", key.privatePath, "--", `${user}@${input.host}`,
          "echo psm-key-ok; sudo -n true 2>/dev/null && echo psm-sudo-ok",
        ], 20_000);
        results.push({ key: key.name, fingerprint: key.fingerprint, user, ...classify(answer) });
        if (results.at(-1)!.outcome === "unreachable" || results.at(-1)!.outcome === "host-key-mismatch") return results;
      }
    }
    return results;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

function classify(answer: { code: number; stdout: string; stderr: string }): Pick<KeyTest, "outcome" | "sudo" | "detail"> {
  if (answer.code === 0 && answer.stdout.includes("psm-key-ok")) {
    const sudo = answer.stdout.includes("psm-sudo-ok");
    return { outcome: "works", sudo, detail: sudo ? "Logs in and has passwordless sudo." : "Logs in, but sudo asks for a password." };
  }
  const stderr = answer.stderr.trim();
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .* host key is known/i.test(stderr)) return { outcome: "host-key-mismatch", sudo: false, detail: "The server's host key does not match the one accepted. Stop and check it before trying keys." };
  if (/Permission denied/i.test(stderr)) return { outcome: "refused", sudo: false, detail: "The server does not accept this key for this user." };
  if (/timed out|Connection refused|No route to host|Could not resolve|Network is unreachable/i.test(stderr)) return { outcome: "unreachable", sudo: false, detail: stderr.split("\n").at(-1)!.slice(0, 200) };
  return { outcome: "error", sudo: false, detail: stderr.split("\n").at(-1)?.slice(0, 200) || `ssh exited ${answer.code}` };
}

/** What the page says next, so "no key works" always ends in a concrete step. */
export function nextStep(results: KeyTest[]): { kind: "use-key" | "needs-sudo" | "create-key" | "fix-host-key" | "unreachable"; key?: string; user?: string } {
  if (results.some(result => result.outcome === "host-key-mismatch")) return { kind: "fix-host-key" };
  if (results.length && results.every(result => result.outcome === "unreachable")) return { kind: "unreachable" };
  const admin = results.find(result => result.outcome === "works" && result.sudo);
  if (admin) return { kind: "use-key", key: admin.key, user: admin.user };
  const login = results.find(result => result.outcome === "works");
  if (login) return { kind: "needs-sudo", key: login.key, user: login.user };
  return { kind: "create-key" };
}
