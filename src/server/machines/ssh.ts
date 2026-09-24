/**
 * SSH for machine setup: run a generated script as an administrator, run a
 * fixed verification command as the account it created, discover a host key,
 * and mint the key pair a new account will use.
 *
 * Same rules as the host-helper transport: one pinned known_hosts line per
 * call, no agent, no config files, no password prompts, a minimal environment,
 * and the private key only ever written to a 0600 file inside a directory that
 * is removed when the call ends. The key is read through a bounded broker
 * lease, never held by this module.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { collect } from "../deploy/adapters/host-helper.ts";
import { minimalEnvironment, type SecretBroker } from "../deploy/connections.ts";

export interface SshEndpoint {
  host: string;
  port: number;
  user: string;
  knownHost: string;
  /** Deployment connection whose `privateKey` slot authenticates this user. */
  connectionId: string;
}

export interface SshResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export class MachineTransportError extends Error {
  constructor(message: string, readonly code: "transport-failed" | "host-key-mismatch" | "auth-failed" | "timeout" | "unreachable") {
    super(message);
    this.name = "MachineTransportError";
  }
}

/** What the setup service needs from SSH. Tests substitute a fake. */
export interface MachineTransport {
  run(endpoint: SshEndpoint, remoteCommand: string, input?: string | Buffer, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<SshResult>;
  scanHostKeys(host: string, port: number): Promise<string[]>;
  generateKeyPair(comment: string): Promise<{ privateKey: Buffer; publicKey: string }>;
}

const MAX_OUTPUT_BYTES = 256 * 1024;

function classify(stderr: string): MachineTransportError["code"] {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .* host key is known/i.test(stderr)) return "host-key-mismatch";
  if (/Permission denied|Too many authentication failures/i.test(stderr)) return "auth-failed";
  if (/timed out|Connection timed out/i.test(stderr)) return "timeout";
  if (/Could not resolve|No route to host|Connection refused|Network is unreachable/i.test(stderr)) return "unreachable";
  return "transport-failed";
}

export class SshMachineTransport implements MachineTransport {
  readonly #broker: SecretBroker;
  readonly #ssh: string;

  constructor(options: { broker: SecretBroker; sshPath?: string }) {
    this.#broker = options.broker;
    this.#ssh = options.sshPath ?? "ssh";
  }

  async run(endpoint: SshEndpoint, remoteCommand: string, input: string | Buffer = "", options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<SshResult> {
    const timeoutMs = Math.min(290_000, Math.max(1_000, options.timeoutMs ?? 120_000));
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "psm-machine-"));
    try {
      const keyPath = path.join(temporary, "identity");
      const hostsPath = path.join(temporary, "known_hosts");
      await fs.writeFile(hostsPath, `${endpoint.knownHost.trim()}\n`, { mode: 0o600, flag: "wx" });
      return await this.#broker.withLease(endpoint.connectionId, ["privateKey"], async (lease) => {
        lease.useBytes("privateKey", (key) => writeFileSync(keyPath, key, { mode: 0o600, flag: "wx" }));
        const controller = new AbortController();
        const abort = () => controller.abort(options.signal?.reason);
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener("abort", abort, { once: true });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(new Error("SSH command timed out")); }, timeoutMs);
        try {
          const child = spawn(this.#ssh, [
            "-F", "/dev/null",
            "-o", "BatchMode=yes",
            "-o", "IdentitiesOnly=yes",
            "-o", "IdentityAgent=none",
            "-o", "PasswordAuthentication=no",
            "-o", "KbdInteractiveAuthentication=no",
            "-o", "StrictHostKeyChecking=yes",
            "-o", `UserKnownHostsFile=${hostsPath}`,
            "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", "ConnectTimeout=15",
            "-o", "RequestTTY=no",
            "-o", "ForwardAgent=no",
            "-o", "ClearAllForwardings=yes",
            "-p", String(endpoint.port),
            "-i", keyPath,
            "--", `${endpoint.user}@${endpoint.host}`,
            remoteCommand,
          ], { env: minimalEnvironment(), stdio: ["pipe", "pipe", "pipe"], signal: controller.signal, windowsHide: true });
          child.stdin.on("error", () => undefined);
          child.stdin.end(input);
          let result: Awaited<ReturnType<typeof collect>>;
          try {
            result = await collect(child, MAX_OUTPUT_BYTES, controller.signal);
          } catch (error) {
            if (timedOut) throw new MachineTransportError("The server did not answer in time.", "timeout");
            throw error;
          }
          if (timedOut) throw new MachineTransportError("The server did not answer in time.", "timeout");
          // 255 is ssh's own failure; anything else is the remote command's exit code.
          if (result.code === 255) throw new MachineTransportError(result.stderr || "SSH failed without a diagnostic.", classify(result.stderr));
          return { code: result.code, stdout: result.stdout.toString("utf8"), stderr: result.stderr };
        } finally {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
        }
      }, timeoutMs + 5_000);
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }

  /**
   * Keys the network offered for this endpoint. These are candidates only: a
   * key learned over the same network it will protect proves nothing until an
   * operator compares its fingerprint with one from a trusted source.
   */
  async scanHostKeys(host: string, port: number): Promise<string[]> {
    const child = spawn("ssh-keyscan", ["-T", "8", "-t", "ed25519,ecdsa,rsa", "-p", String(port), "--", host], { env: minimalEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    const result = await collect(child, 64 * 1024);
    const lines = result.stdout.toString("utf8").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    if (!lines.length) throw new MachineTransportError(result.stderr || `No SSH server answered at ${host}:${port}.`, "unreachable");
    return lines;
  }

  async generateKeyPair(comment: string): Promise<{ privateKey: Buffer; publicKey: string }> {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "psm-keygen-"));
    try {
      const file = path.join(temporary, "key");
      const child = spawn("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", file], { env: minimalEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
      const result = await collect(child, 16 * 1024);
      if (result.code !== 0) throw new MachineTransportError(`ssh-keygen failed: ${result.stderr}`, "transport-failed");
      const [privateKey, publicKey] = await Promise.all([fs.readFile(file), fs.readFile(`${file}.pub`, "utf8")]);
      return { privateKey, publicKey: publicKey.trim() };
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
}
