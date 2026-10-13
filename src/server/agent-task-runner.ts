import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { taskInputs } from "./agent-task-inputs.ts";
import { browserPreviewProbe } from "./agent-browser-preview.ts";
import type { RepositoryTools } from "./agent-repository-tools.ts";
import type { AgentPermissionStore } from "./agent-permissions.ts";

export type TaskExecutor = (args: string[], signal?: AbortSignal) => Promise<string>;

/**
 * Turn the docker CLI's connection failures into something the operator can act
 * on, because the two that matter look identical from here and have completely
 * different fixes.
 *
 * **Permission denied on the socket is usually not a missing group.** The socket
 * is `root:docker` mode 0660, so a process needs the `docker` group — and a
 * process's supplementary groups are fixed when it starts and never re-read.
 * Adding the PSM user to the group therefore does nothing at all for a psm that
 * was already running: `id` in a new terminal shows the group, `/proc/<psm
 * pid>/status` still does not, and the socket keeps refusing it. Restarting psm
 * from a session that has the group is the whole fix, and it is not a fix anyone
 * guesses from `permission denied`.
 *
 * Returns null when the output is not a connection failure, so a genuine test
 * failure is passed through untouched.
 */
export function describeDockerConnectionFailure(output: string): string | null {
  if (/permission denied while trying to connect to the docker/i.test(output)) {
    return (
      "The managed task sandbox could not reach the Docker daemon: permission denied on the "
      + "Docker socket. The socket is owned by the `docker` group, and a process keeps the "
      + "group list it started with — so if the PSM user was added to that group after psm "
      + "started, psm still does not have it. Check with "
      + "`grep Groups /proc/$(pgrep -f 'src/server/index.ts' | head -1)/status` against "
      + "`getent group docker`, then restart psm from a session that has the group."
    );
  }
  if (/failed to connect to the docker|cannot connect to the docker daemon|is the docker daemon running/i.test(output)) {
    return (
      "The managed task sandbox could not reach the Docker daemon: nothing is listening on the "
      + "socket. Start the daemon on the PSM host (`systemctl start docker`), or point "
      + "DOCKER_HOST at the right socket."
    );
  }
  return null;
}

export const dockerTaskExecutor: TaskExecutor = (args, signal) => new Promise((resolve, reject) => {
  execFile("docker", args, { signal, timeout: 300_000, maxBuffer: 512 * 1024, env: { PATH: process.env.PATH }, encoding: "utf8" }, (error, stdout, stderr) => {
    if (error && !stdout && !stderr) { reject(new Error("The managed task sandbox is unavailable. Configure Docker and preload the Node sandbox image on the PSM host.")); return; }
    const output = `${stdout}\n${stderr}`.slice(-64_000);
    if (error) {
      /* A daemon psm cannot reach is an operator problem, not a failing test, and
       * saying so here stops it being read as "the project's tests broke". */
      const connection = describeDockerConnectionFailure(output);
      reject(new Error(connection ?? `Sandbox task failed: ${output}`));
      return;
    }
    resolve(output);
  });
});

/** Downloads are brokered; repository code never receives a network namespace. */
export async function downloadLockedPackage(resolved: string, integrity: string, signal?: AbortSignal): Promise<Buffer> {
  const url = new URL(resolved);
  if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org" || url.port || url.username || url.password || url.search || url.hash) throw new Error("Managed installs require public registry.npmjs.org tarballs in package-lock.json.");
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  if (!match) throw new Error("Every locked package must have one SHA-512 integrity value.");
  const response = await fetch(url, { redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error(`Package download failed (${response.status}).`);
  const parts: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 64 * 1024 * 1024) throw new Error("Package exceeds the managed download limit.");
    parts.push(chunk);
  }
  const bytes = Buffer.concat(parts);
  if (createHash("sha512").update(bytes).digest("base64") !== match[1]) throw new Error("Locked package integrity verification failed.");
  return bytes;
}

/** One disposable dependency workspace per project and turn. No output is copied
 * back to the checkout; edits and lockfile changes still use repository tools. */
export class ManagedTaskRunner {
  private directory: string | null = null;
  private sourceDigest = "";
  private packagesReady = new Set<string>();
  private pending: Promise<unknown> = Promise.resolve();
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action);
    this.pending = result.catch(() => {}); return result;
  }
  constructor(private readonly repository: RepositoryTools, private readonly store: AgentPermissionStore, private readonly signal: AbortSignal,
    private readonly execute: TaskExecutor = dockerTaskExecutor,
    private readonly download: typeof downloadLockedPackage = downloadLockedPackage) {}
  private snapshot(): string {
    this.store.check(this.repository.snapshot, "repo.read");
    const { digest } = taskInputs(this.repository);
    if (this.directory && digest === this.sourceDigest) return this.directory;
    this.close(); this.directory = fs.mkdtempSync(path.join(os.tmpdir(), "psm-task-")); this.sourceDigest = "";
    fs.mkdirSync(path.join(this.directory, "workspace")); fs.mkdirSync(path.join(this.directory, "packages"));
    // Hash the bytes actually copied, so a concurrent host edit cannot certify
    // different content from the disposable source snapshot.
    this.sourceDigest = taskInputs(this.repository, path.join(this.directory, "workspace")).digest;
    return this.directory;
  }
  private async container(directory: string, command: string[], install = false, cwd = ".", browser = false): Promise<string> {
    if (this.signal.aborted) throw new Error("This turn was stopped.");
    const name = `psm-task-${randomUUID()}`;
    const image = browser ? (process.env.PSM_BROWSER_IMAGE || "psm-task-browser:1.64.0") : (process.env.PSM_TASK_IMAGE || "node:22-bookworm-slim");
    const installs = install ? [...this.packagesReady].map(dir => ({ command: ["npm", "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps"], cwd: dir })) : [];
    const bootstrap = `const fs=require('fs'),cp=require('child_process'); fs.cpSync('/source','/workspace',{recursive:true}); const commands=${JSON.stringify([...installs, { command, cwd }])}; for(const {command:[cmd,...args],cwd} of commands){const result=cp.spawnSync(cmd,args,{cwd:require('path').join('/workspace',cwd),stdio:'inherit'});if(result.error||result.status!==0)process.exit(result.status||1);}`;
    try {
      return await this.execute(["run", "--name", name, "--rm", "--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=512", "--memory=2g", "--cpus=1", "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m", "--tmpfs", "/workspace:rw,exec,nosuid,nodev,size=1536m,mode=1777", "--mount", `type=bind,source=${directory}/workspace,target=/source,readonly`, "--mount", `type=bind,source=${directory}/packages,target=/packages,readonly`, "--shm-size=256m", "--workdir", "/workspace", "--env", "HOME=/tmp", "--env", "npm_config_cache=/tmp/npm-cache", image, "node", "-e", bootstrap], this.signal);
    } finally { await this.execute(["rm", "-f", name]).catch(() => {}); }
  }
  tests(script = "test"): Promise<string> { return this.serialize(() => this.runTests(script)); }
  private async runTests(script: string): Promise<string> {
    this.store.check(this.repository.snapshot, "test.run");
    if (script !== "node --test" && !/^test(?::[a-zA-Z0-9_-]+)*$/.test(script)) throw new Error("Choose node --test or a package script named test or test:….");
    const directory = this.snapshot();
    const output = await this.container(directory, script === "node --test" ? ["node", "--test"] : ["npm", "run", script], this.packagesReady.size > 0);
    this.store.check(this.repository.snapshot, "test.run"); return output;
  }
  /** Any package.json script — build, typecheck, lint — in the same offline sandbox. */
  script(name: string, cwd = "."): Promise<string> { return this.serialize(() => this.runScript(name, cwd)); }
  private async runScript(name: string, cwd: string): Promise<string> {
    this.store.check(this.repository.snapshot, "script.run");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,99}$/.test(name)) throw new Error("Give the name of a script in package.json.");
    let scripts: Record<string, unknown> = {};
    try { scripts = JSON.parse(this.repository.read(this.packageFile(cwd, "package.json"))).scripts ?? {}; } catch { throw new Error("This project has no readable package.json."); }
    if (typeof scripts[name] !== "string") throw new Error(`package.json has no script named ${name}. Available: ${Object.keys(scripts).join(", ") || "none"}.`);
    const directory = this.snapshot();
    const digest = this.sourceDigest;
    if (name === "build") this.repository.invalidateVerification(cwd, "build");
    const output = await this.container(directory, ["npm", "run", name], this.packagesReady.size > 0, cwd);
    this.store.check(this.repository.snapshot, "script.run");
    if (name === "build") this.repository.recordVerification(cwd, "build", digest);
    return `${this.packagesReady.has(cwd) ? "" : "Dependencies were not installed in this sandbox; if the script needs them, run install_packages first.\n"}${output}`;
  }
  /**
   * Start a project script (a dev or preview server) inside the same offline
   * sandbox, execute app JavaScript and inspect each route inside the
   * container, then stop it. Nothing listens outside the container.
   */
  preview(script: string, port: number, paths: string[], cwd = "."): Promise<string> { return this.serialize(() => this.runPreview(script, port, paths, cwd)); }
  private async runPreview(script: string, port: number, paths: string[], cwd: string): Promise<string> {
    this.store.check(this.repository.snapshot, "script.run");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,99}$/.test(script)) throw new Error("Give the name of a script in package.json.");
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Give the port the script listens on (1024–65535).");
    const wanted = (paths.length ? paths : ["/"]).slice(0, 10);
    if (wanted.some(entry => !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]{0,300}$/.test(entry))) throw new Error("Paths start with / and contain no spaces.");
    const scripts = JSON.parse(this.repository.read(this.packageFile(cwd, "package.json"))).scripts ?? {};
    if (typeof scripts[script] !== "string") throw new Error(`package.json has no script named ${script}.`);
    const directory = this.snapshot();
    const digest = this.sourceDigest;
    const args = /(?:^|\s)vite(?:\s|$)/.test(scripts[script]) ? ["--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"] : [];
    this.repository.invalidateVerification(cwd, "preview");
    const probe = browserPreviewProbe(script, port, wanted, args, typeof scripts.build === "string" && ["preview", "start"].includes(script));
    const output = await this.container(directory, ["node", "-e", probe], this.packagesReady.size > 0, cwd, true);
    this.store.check(this.repository.snapshot, "script.run");
    // The probe exits nonzero on any page error. A listening server is not a pass.
    this.repository.recordVerification(cwd, "preview", digest);
    return output;
  }
  private packageFile(cwd: string, name: string): string {
    if (cwd === ".") return name;
    this.repository.resolve(cwd);
    return `${cwd}/${name}`;
  }
  install(cwd = "."): Promise<string> { return this.serialize(() => this.installPackages(cwd)); }
  private async installPackages(cwd: string): Promise<string> {
    this.store.check(this.repository.snapshot, "pkg.install");
    const lockFile = this.packageFile(cwd, "package-lock.json");
    const directory = this.snapshot();
    this.packagesReady.delete(cwd);
    const lock = JSON.parse(this.repository.read(lockFile));
    if (![2, 3].includes(lock.lockfileVersion) || !lock.packages) throw new Error("Managed installs require package-lock.json version 2 or 3.");
    const entries = Object.entries(lock.packages) as [string, any][];
    if (entries.length > 2000) throw new Error("Lockfile exceeds the managed package limit.");
    let total = 0;
    const deadline = Date.now() + 300_000;
    for (const [name, entry] of entries) {
      if (!name) continue;
      this.store.check(this.repository.snapshot, "pkg.install");
      if (this.signal.aborted) throw new Error("This turn was stopped.");
      if (entry.link || typeof entry.resolved !== "string" || typeof entry.integrity !== "string") throw new Error("Managed installs require registry packages with integrity; workspace, Git and local dependencies are unsupported.");
      if (Date.now() >= deadline) throw new Error("Managed dependency downloads exceeded five minutes.");
      const bytes = await this.download(entry.resolved, entry.integrity, this.signal);
      total += bytes.length;
      if (total > 256 * 1024 * 1024) throw new Error("Dependencies exceed the managed download limit.");
      const filename = createHash("sha256").update(bytes).digest("hex") + ".tgz";
      fs.writeFileSync(path.join(directory, "packages", filename), bytes);
      entry.resolved = `file:/packages/${filename}`;
    }
    fs.writeFileSync(path.join(directory, "workspace", lockFile), JSON.stringify(lock));
    // This private lockfile changes tarball locations only. The real lockfile
    // and checkout are never writable by npm or by package lifecycle scripts.
    const output = await this.container(directory, ["npm", "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps"], false, cwd);
    this.store.check(this.repository.snapshot, "pkg.install");
    this.packagesReady.add(cwd);
    return `Installed dependencies in this turn's sandbox. Tests can use them until repository inputs change.\n${output}`;
  }
  close(): void { if (this.directory) fs.rmSync(this.directory, { recursive: true, force: true }); this.directory = null; this.sourceDigest = ""; this.packagesReady.clear(); }
}
