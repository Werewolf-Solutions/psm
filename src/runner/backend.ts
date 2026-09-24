/**
 * Where a job actually runs. The Docker backend gives every job its own
 * containers and its own directory, and nothing else:
 *
 * - never --privileged, no host namespaces, no Docker socket, no host paths
 *   except the job's own work directory;
 * - all capabilities dropped, no-new-privileges, read-only root, tmpfs /tmp,
 *   bounded pids / memory / CPU, the runner's unprivileged uid;
 * - no network unless the job asked for egress (a checkout gets egress for the
 *   clone only);
 * - secrets through a 0600 env file that is deleted with the job, never argv.
 *
 * Containers carry the runner's label, so a restarted runner can find and
 * stop anything a crash left behind.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CHECKOUT_IMAGE, type JobSpec } from "../control/service.ts";

export interface JobOutput {
  (kind: "stdout" | "stderr" | "status", text: string): void;
}

export interface JobExecution {
  jobId: string;
  spec: JobSpec;
  env: Record<string, string>;
  output: JobOutput;
  signal: AbortSignal;
}

export interface RunnerBackend {
  readonly name: string;
  /** Returns the exit code of the last step that ran (null when it never ran). */
  run(execution: JobExecution): Promise<{ exitCode: number | null; detail: string }>;
  /** Stop containers a previous run of this runner left behind. */
  cleanup(): Promise<number>;
}

export { CHECKOUT_IMAGE };

function docker(args: string[], options: { onLine?: (stream: "stdout" | "stderr", line: string) => void; signal?: AbortSignal } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const buffers = { stdout: "", stderr: "" };
    const feed = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stream === "stdout") stdout = (stdout + text).slice(-64 * 1024); else stderr = (stderr + text).slice(-64 * 1024);
      if (!options.onLine) return;
      buffers[stream] += text;
      let index: number;
      while ((index = buffers[stream].indexOf("\n")) >= 0) {
        options.onLine(stream, buffers[stream].slice(0, index));
        buffers[stream] = buffers[stream].slice(index + 1);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => feed("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => feed("stderr", chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (options.onLine) for (const stream of ["stdout", "stderr"] as const) if (buffers[stream]) options.onLine(stream, buffers[stream]);
      resolve({ code, stdout, stderr });
    });
  });
}

export class DockerBackend implements RunnerBackend {
  readonly name = "docker";

  constructor(private readonly options: { runnerId: string; workRoot: string; memory?: string; cpus?: string }) {}

  /** The hardening every job container gets; callers add only their name, network and mounts. */
  #hardened(jobId: string, name: string): string[] {
    const uid = process.getuid?.() ?? 65534;
    const gid = process.getgid?.() ?? 65534;
    return [
      "--rm", "--name", name,
      "--label", `psm.runner=${this.options.runnerId}`, "--label", `psm.job=${jobId}`,
      "--user", `${uid}:${gid}`,
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m",
      "--pids-limit", "512", "--memory", this.options.memory ?? "2g", "--cpus", this.options.cpus ?? "2",
      "--env", "HOME=/tmp",
    ];
  }

  async run(execution: JobExecution): Promise<{ exitCode: number | null; detail: string }> {
    const { jobId, spec, env, output, signal } = execution;
    const directory = fs.mkdtempSync(path.join(this.options.workRoot, `${jobId}-`));
    fs.chmodSync(directory, 0o700);
    const work = path.join(directory, "work");
    fs.mkdirSync(work, { mode: 0o700 });
    const envFile = path.join(directory, "env");
    const secretValues = Object.values(env).filter((value) => value.length >= 4);
    const redact = (text: string) => secretValues.reduce((line, value) => line.split(value).join("[redacted]"), text);
    const running: string[] = [];
    const kill = () => { for (const name of running) void docker(["kill", name]).catch(() => undefined); };
    signal.addEventListener("abort", kill, { once: true });
    try {
      const jobEnv = Object.entries(env).filter(([name]) => name !== "PSM_CHECKOUT_TOKEN");
      fs.writeFileSync(envFile, jobEnv.map(([name, value]) => `${name}=${value.replace(/\n/g, "\\n")}`).join("\n") + "\n", { mode: 0o600 });
      let workdir = "/work";
      if (spec.checkout) {
        output("status", `Checking out ${spec.checkout.repository} at ${spec.checkout.ref}…`);
        const checkoutEnv = path.join(directory, "checkout.env");
        const lines = [`PSM_REPOSITORY=${spec.checkout.repository}`, `PSM_REF=${spec.checkout.ref}`];
        if (env.PSM_CHECKOUT_TOKEN) lines.push(`PSM_CHECKOUT_TOKEN=${env.PSM_CHECKOUT_TOKEN}`);
        fs.writeFileSync(checkoutEnv, lines.join("\n") + "\n", { mode: 0o600 });
        const name = `psm-job-${jobId}-checkout`;
        running.push(name);
        // The token goes into a header built inside the container, never a URL or argv.
        const script = [
          "set -e",
          "git init -q /work/src && cd /work/src",
          "git remote add origin \"$PSM_REPOSITORY\"",
          "if [ -n \"${PSM_CHECKOUT_TOKEN:-}\" ]; then AUTH=\"Authorization: Basic $(printf 'x-access-token:%s' \"$PSM_CHECKOUT_TOKEN\" | base64 | tr -d '\\n')\"; else AUTH=''; fi",
          "git -c credential.helper= ${AUTH:+-c \"http.extraHeader=$AUTH\"} fetch -q --depth 1 origin \"$PSM_REF\"",
          "git checkout -q FETCH_HEAD",
          "git log -1 --format='checked out %H'",
        ].join("\n");
        const cloned = await docker(["run", ...this.#hardened(jobId, name), "--network", "bridge", "--env-file", checkoutEnv, "-v", `${work}:/work`, "--pull", "never", "--entrypoint", "sh", CHECKOUT_IMAGE, "-c", script], {
          onLine: (stream, line) => output(stream, redact(line)), signal,
        });
        fs.rmSync(checkoutEnv, { force: true });
        if (signal.aborted) return { exitCode: null, detail: "cancelled" };
        if (cloned.code !== 0) return { exitCode: cloned.code, detail: "checkout failed" };
        workdir = "/work/src";
      }
      const name = `psm-job-${jobId}-run`;
      running.push(name);
      const script = spec.steps.map((step, index) => `echo "::step ${index + 1}/${spec.steps.length}"\n${step}`).join("\n");
      output("status", `Running ${spec.steps.length} step(s) in ${spec.image}, network ${spec.network}.`);
      const result = await docker([
        "run", ...this.#hardened(jobId, name),
        "--network", spec.network === "egress" ? "bridge" : "none",
        "--env-file", envFile, "-v", `${work}:/work`, "-w", workdir,
        "--pull", "never", "--entrypoint", "sh", spec.image, "-e", "-c", script,
      ], { onLine: (stream, line) => output(stream, redact(line)), signal });
      if (signal.aborted) return { exitCode: null, detail: "cancelled" };
      return { exitCode: result.code, detail: result.code === 0 ? "" : `a step exited ${result.code}` };
    } finally {
      signal.removeEventListener("abort", kill);
      kill();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  async cleanup(): Promise<number> {
    const listed = await docker(["ps", "-q", "--filter", `label=psm.runner=${this.options.runnerId}`]);
    const ids = listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    if (ids.length) await docker(["kill", ...ids]);
    return ids.length;
  }
}

export function defaultWorkRoot(): string {
  const root = path.join(os.homedir(), ".cache", "psm", "runner-work");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}
