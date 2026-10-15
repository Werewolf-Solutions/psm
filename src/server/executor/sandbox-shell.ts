/** Unrestricted commands for an implement job, confined to its Docker clone. */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_IMAGE = "psm-agent:1";
const MAX_OUTPUT = 64_000;
const MAX_COMMAND_MS = 10 * 60_000;

export type SandboxExecutor = (args: string[], signal: AbortSignal) => Promise<string>;

export const dockerSandboxExecutor: SandboxExecutor = (args, signal) => new Promise((resolve, reject) => {
  execFile("docker", args, {
    signal, timeout: MAX_COMMAND_MS, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: process.env.PATH || "/usr/bin:/bin" }, encoding: "utf8",
  }, (error, stdout, stderr) => {
    const output = `${stdout}\n${stderr}`.slice(-MAX_OUTPUT).trim();
    if (error) reject(new Error(`Sandbox command failed: ${output || error.message}`));
    else resolve(output || "Command completed without output.");
  });
});

/**
 * The sole writable host mount is this job's clone. There is no Docker socket,
 * home directory, provider login or host network in the container. Git config
 * is mounted read-only because host review later reads the resulting branch.
 */
export class JobSandboxShell {
  constructor(private readonly clone: string, private readonly execute: SandboxExecutor = dockerSandboxExecutor) {}

  async run(command: string, signal: AbortSignal, timeoutMs = MAX_COMMAND_MS): Promise<string> {
    if (!command.trim() || command.length > 20_000) throw new Error("Give a shell command of at most 20,000 characters.");
    if (signal.aborted) throw new Error("This job was stopped.");
    const realClone = fs.realpathSync(this.clone);
    const git = path.join(realClone, ".git");
    if (!fs.lstatSync(git).isDirectory() || fs.lstatSync(git).isSymbolicLink()) throw new Error("The job clone is not an ordinary Git checkout.");
    const name = `psm-agent-${randomUUID()}`;
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, Math.min(MAX_COMMAND_MS, Math.max(1000, timeoutMs)));
    const args = ["run", "--name", name, "--rm", "--pull=never", "--network=none", "--read-only", "--cap-drop=ALL",
      "--security-opt=no-new-privileges", "--pids-limit=512", "--memory=2g", "--cpus=2",
      "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m",
      "--mount", `type=bind,source=${realClone},target=/workspace`,
      "--mount", `type=bind,source=${path.join(git, "config")},target=/workspace/.git/config,readonly`,
      "--workdir", "/workspace", "--env", "HOME=/tmp", "--env", "GIT_CONFIG_NOSYSTEM=1", "--env", "GIT_CONFIG_GLOBAL=/dev/null",
      process.env.PSM_AGENT_IMAGE || DEFAULT_IMAGE, "bash", "-lc", command];
    try { return await this.execute(args, controller.signal); }
    finally {
      clearTimeout(timer); signal.removeEventListener("abort", stop);
      await this.execute(["rm", "-f", name], new AbortController().signal).catch(() => {});
    }
  }
}
