import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { taskInputs } from "./agent-task-inputs.ts";
import { browserPreviewProbe } from "./agent-browser-preview.ts";
import { PREVIEW_FIXTURE_FILE, parsePreviewConfig, type PreviewConfig, type PreviewService } from "./agent-preview-fixtures.ts";
import type { RepositoryTools } from "./agent-repository-tools.ts";
import type { PermissionChecker } from "./agent-permissions.ts";
import { statePath } from "../store.ts";

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
  if (!match) {
    const name = decodeURIComponent(url.pathname.split("/-/")[0].replace(/^\//, ""));
    const kind = integrity.split("-")[0] || "no integrity value";
    throw new Error(`Every locked package must have one SHA-512 integrity value; ${name} has ${kind}. Old lockfiles carry SHA-1 hashes: regenerate package-lock.json with a current npm.`);
  }
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
/**
 * Disposable data stores a preview service can ask for; each run starts empty.
 * Mongo's defaults do not fit a 256 MB tmpfs that also counts against the
 * container's memory: three preallocated 100 MB journal files fill it, and the
 * next write (diagnostic capture, an index build) aborts the server. Small
 * unpreallocated journal files, a small cache and no diagnostics keep it ~20 MB.
 */
const STORE_CONTAINERS = {
  mongo: { image: () => process.env.PSM_MONGO_IMAGE || "mongo:7", memory: "512m", tmpfs: ["/data/db", "/data/configdb"], command: ["mongod", "--bind_ip_all", "--quiet", "--setParameter", "diagnosticDataCollectionEnabled=false", "--wiredTigerCacheSizeGB", "0.25", "--wiredTigerEngineConfigString", "log=(file_max=20MB,prealloc=false)"], env: { MONGODB_URI: "mongodb://mongo:27017/psm-preview" } },
  redis: { image: () => process.env.PSM_REDIS_IMAGE || "redis:7-alpine", memory: "128m", tmpfs: ["/data"], command: ["redis-server", "--save", "", "--appendonly", "no"], env: { REDIS_URL: "redis://redis:6379" } },
} as const;
const HARDENED = ["--pull=never", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=512"];

/** Finds another project in the task's scope by its registered name. */
export type ProjectLookup = (name: string) => RepositoryTools | undefined;

const NPM_CI = ["npm", "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps"];

export interface TaskRunnerOptions {
  /** Compiled native addons, kept across jobs. Defaults to psm's state directory. */
  nativeCache?: string;
  /**
   * Also put the installed packages in the checkout's own node_modules. Only
   * for an implement job's clone, whose shell can already write anywhere in
   * it: without them `npm run dev` or `npx vite` in that shell finds nothing.
   */
  checkoutDeps?: boolean;
}

/** A package with a lifecycle script, by its lockfile path and its compiled-output cache key. */
interface NativeAddon { path: string; key: string }

const defaultNativeCache = () => process.env.PSM_NATIVE_CACHE || statePath(".psm-native-cache");

export class ManagedTaskRunner {
  private directory: string | null = null;
  private sourceDigest = "";
  /**
   * Installed package directories: the hash of the real lockfile they were
   * installed from, and the private lockfile pointing at /packages. They
   * survive source edits — a new snapshot keeps them while the lockfile is
   * unchanged — so an agent does not reinstall after every edit.
   */
  private installed = new Map<string, { lockHash: string; privateLock: string; natives: NativeAddon[] }>();
  private get packagesReady(): ReadonlySet<string> { return new Set(this.installed.keys()); }
  private pending: Promise<unknown> = Promise.resolve();
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action);
    this.pending = result.catch(() => {}); return result;
  }
  constructor(private readonly repository: RepositoryTools, private readonly store: PermissionChecker, private readonly signal: AbortSignal,
    private readonly execute: TaskExecutor = dockerTaskExecutor,
    private readonly download: typeof downloadLockedPackage = downloadLockedPackage,
    private readonly findProject: ProjectLookup = () => undefined,
    private readonly options: TaskRunnerOptions = {}) {}
  private snapshot(): string {
    this.store.check(this.repository.snapshot, "repo.read");
    const { digest } = taskInputs(this.repository);
    if (this.directory && digest === this.sourceDigest) return this.directory;
    const previous = this.directory;
    const kept = this.installed;
    this.directory = fs.mkdtempSync(path.join(os.tmpdir(), "psm-task-")); this.sourceDigest = ""; this.installed = new Map();
    fs.mkdirSync(path.join(this.directory, "workspace"));
    // Verified tarballs carry over to the new snapshot; the source does not.
    if (previous && fs.existsSync(path.join(previous, "packages"))) fs.renameSync(path.join(previous, "packages"), path.join(this.directory, "packages"));
    else fs.mkdirSync(path.join(this.directory, "packages"));
    if (previous) fs.rmSync(previous, { recursive: true, force: true });
    // Hash the bytes actually copied, so a concurrent host edit cannot certify
    // different content from the disposable source snapshot.
    this.sourceDigest = taskInputs(this.repository, path.join(this.directory, "workspace")).digest;
    for (const [cwd, install] of kept) {
      const lockFile = this.packageFile(cwd, "package-lock.json");
      let current: string;
      try { current = this.repository.read(lockFile); } catch { continue; }
      if (createHash("sha256").update(current).digest("hex") !== install.lockHash) continue; // changed lockfile: install again
      fs.writeFileSync(path.join(this.directory, "workspace", lockFile), install.privateLock);
      this.installed.set(cwd, install);
    }
    return this.directory;
  }
  private async container(directory: string, command: string[], install = false, cwd = ".", browser = false, extra: { network?: string; env?: Record<string, string>; mounts?: string[] } = {}): Promise<string> {
    if (this.signal.aborted) throw new Error("This turn was stopped.");
    const name = `psm-task-${randomUUID()}`;
    const image = browser ? (process.env.PSM_BROWSER_IMAGE || "psm-task-browser:1.64.0") : (process.env.PSM_TASK_IMAGE || "node:22-bookworm-slim");
    // Lifecycle scripts never run here; compiled addons are copied in from /packages/native instead.
    const installs = install ? [...this.installed].flatMap(([dir, entry]) => [
      { command: NPM_CI, cwd: dir },
      ...entry.natives.map(native => ({ command: ["cp", "-R", `/packages/native/${native.key}/.`, native.path], cwd: dir })),
    ]) : [];
    const bootstrap = `const fs=require('fs'),cp=require('child_process'); fs.cpSync('/source','/workspace',{recursive:true}); const commands=${JSON.stringify([...installs, { command, cwd }])}; for(const {command:[cmd,...args],cwd} of commands){const result=cp.spawnSync(cmd,args,{cwd:require('path').join('/workspace',cwd),stdio:'inherit'});if(result.error||result.status!==0)process.exit(result.status||1);}`;
    try {
      return await this.execute(["run", "--name", name, "--rm", "--pull=never", `--network=${extra.network ?? "none"}`, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=512", "--memory=2g", "--cpus=1", "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m", "--tmpfs", "/workspace:rw,exec,nosuid,nodev,size=1536m,mode=1777", "--mount", `type=bind,source=${directory}/workspace,target=/source,readonly`, "--mount", `type=bind,source=${directory}/packages,target=/packages,readonly`, ...(extra.mounts ?? []).flatMap(mount => ["--mount", mount]), "--shm-size=256m", "--workdir", "/workspace", "--env", "HOME=/tmp", "--env", "npm_config_cache=/tmp/npm-cache", ...Object.entries(extra.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]), image, "node", "-e", bootstrap], this.signal);
    } finally { await this.execute(["rm", "-f", name]).catch(() => {}); }
  }
  tests(script = "test"): Promise<string> { return this.serialize(() => this.runTests(script)); }
  private async runTests(script: string): Promise<string> {
    this.store.check(this.repository.snapshot, "test.run");
    if (script !== "node --test" && !/^test(?::[a-zA-Z0-9_-]+)*$/.test(script)) throw new Error("Choose node --test or a package script named test or test:….");
    const directory = this.snapshot();
    const digest = this.sourceDigest;
    let output: string;
    try {
      output = await this.container(directory, script === "node --test" ? ["node", "--test"] : ["npm", "run", script], this.packagesReady.size > 0);
    } catch (error) {
      if (/^Sandbox task failed/.test((error as Error).message)) this.repository.recordTests(digest, false);
      throw error;
    }
    this.repository.recordTests(digest, true);
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
  preview(script: string, port: number, paths: string[], cwd = ".", signedIn = false): Promise<string> { return this.serialize(() => this.runPreview(script, port, paths, cwd, signedIn)); }
  private async runPreview(script: string, port: number, paths: string[], cwd: string, signedIn: boolean): Promise<string> {
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
    const config = this.previewConfig(cwd);
    if (signedIn && !config.session) throw new Error(`A signed-in check needs a session in ${PREVIEW_FIXTURE_FILE}: a cookie whose value is a secret a service declares, which its seed turns into a real session.`);
    // Generated here rather than per service, so the browser's session cookie and the seed that honours it share one value.
    const secrets = Object.fromEntries(config.services.flatMap(service => service.secrets).map(name => [name, randomBytes(32).toString("hex")]));
    this.repository.invalidateVerification(cwd, "preview");
    const session = signedIn && config.session ? { cookie: config.session.cookie, path: config.session.path, value: secrets[config.session.secret] } : undefined;
    const options = { host: config.host, expected: config.expected, session, services: config.services.map(service => ({ name: service.project, url: `http://${service.alias}:${service.port}${service.ready}` })) };
    const probe = browserPreviewProbe(script, port, wanted, args, typeof scripts.build === "string" && ["preview", "start"].includes(script), config.responses, options);
    const output = config.services.length
      ? await this.withServices(config, secrets, network => this.container(directory, ["node", "-e", probe], this.packagesReady.size > 0, cwd, true, { network, env: config.env }))
      : await this.container(directory, ["node", "-e", probe], this.packagesReady.size > 0, cwd, true, { env: config.env });
    this.store.check(this.repository.snapshot, "script.run");
    // The probe exits nonzero on any page error. A listening server is not a pass.
    // Only a signed-out pass is recorded: a signed-in check is extra evidence, never a substitute for it.
    if (!signedIn) this.repository.recordVerification(cwd, "preview", digest);
    return output;
  }
  /** Read from the checkout the digest covers, so editing a fixture makes an earlier pass stale. */
  private previewConfig(cwd: string): PreviewConfig {
    const file = this.packageFile(cwd, PREVIEW_FIXTURE_FILE);
    return fs.existsSync(this.repository.resolve(file, true)) ? parsePreviewConfig(this.repository.read(file)) : { responses: [], services: [], expected: [], env: {}, host: "127.0.0.1", session: null };
  }
  /**
   * Run declared backend services beside the app on a network with no route
   * out. Each service is another project in the task's scope, needs that
   * project's own repo.read and script.run, and runs from a snapshot that
   * never contains .env files. Stores start empty and secrets are generated
   * per run, so nothing real is reachable. Everything is removed afterwards.
   */
  private async withServices<T>(config: PreviewConfig, secrets: Record<string, string>, run: (network: string) => Promise<T>): Promise<T> {
    const prepared = config.services.map(service => ({ service, repository: this.serviceRepository(service) }));
    const id = randomUUID().slice(0, 12);
    const network = `psm-task-${id}`;
    const containers: string[] = [];
    const directories: string[] = [];
    const uid = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
    await this.execute(["network", "create", "--internal", network], this.signal);
    try {
      for (const store of [...new Set(config.services.flatMap(service => service.stores))]) {
        const spec = STORE_CONTAINERS[store];
        const name = `${network}-${store}`;
        containers.push(name);
        await this.execute(["run", "-d", "--name", name, `--network=${network}`, "--network-alias", store, ...HARDENED, `--memory=${spec.memory}`, "--user", uid,
          ...spec.tmpfs.flatMap(target => ["--tmpfs", `${target}:rw,nosuid,nodev,size=256m,mode=1777`]), "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=1777", spec.image(), ...spec.command], this.signal);
      }
      for (const { service, repository } of prepared) {
        const source = fs.mkdtempSync(path.join(os.tmpdir(), "psm-service-"));
        directories.push(source);
        taskInputs(repository, source, service.directory);
        const modules = path.join(repository.snapshot.project.path, service.directory, "node_modules");
        if (!fs.existsSync(modules)) throw new Error(`${service.project}/${service.directory} has no installed dependencies. Run npm install there on the PSM host, then check again.`);
        const env: Record<string, string> = { ...service.env, PORT: String(service.port), HOME: "/tmp", npm_config_cache: "/tmp/npm-cache" };
        for (const store of service.stores) Object.assign(env, STORE_CONTAINERS[store].env);
        for (const secret of service.secrets) env[secret] = secrets[secret];
        const target = service.directory === "." ? "/workspace" : `/workspace/${service.directory}`;
        // Mounted outside /workspace and linked in: a mount inside it would make Docker create its parents as root.
        const bootstrap = `const fs=require('fs'),cp=require('child_process'); fs.cpSync('/source','/workspace',{recursive:true}); fs.mkdirSync(${JSON.stringify(target)},{recursive:true}); fs.symlinkSync('/deps/node_modules',${JSON.stringify(target + "/node_modules")}); process.chdir(${JSON.stringify(target)}); for (const seed of ${JSON.stringify(service.seed)}) { const r=cp.spawnSync('node',[seed],{stdio:'inherit'}); if (r.error||r.status!==0) { console.error('PSM preview seed failed: '+seed); process.exit(r.status||1); } } const child=cp.spawn('npm',['run',${JSON.stringify(service.script)}],{stdio:'inherit'}); child.on('exit',code=>process.exit(code??1)); for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>child.kill(signal));`;
        const name = `${network}-${service.alias}`;
        containers.push(name);
        await this.execute(["run", "-d", "--name", name, `--network=${network}`, "--network-alias", service.alias, ...HARDENED, "--memory=1g", "--cpus=1", "--user", uid,
          "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777", "--tmpfs", "/workspace:rw,exec,nosuid,nodev,size=1536m,mode=1777",
          "--mount", `type=bind,source=${source},target=/source,readonly`, "--mount", `type=bind,source=${modules},target=/deps/node_modules,readonly`,
          "--workdir", "/workspace", ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
          process.env.PSM_TASK_IMAGE || "node:22-bookworm-slim", "node", "-e", bootstrap], this.signal);
      }
      try { return await run(network); }
      catch (error) {
        const logs: string[] = [];
        const stores = [...new Set(config.services.flatMap(service => service.stores))];
        const sources: Array<[string, string, number]> = [...prepared.map(({ service }): [string, string, number] => [service.project, `${network}-${service.alias}`, 40]), ...stores.map((store): [string, string, number] => [store, `${network}-${store}`, 8])];
        for (const [label, name, lines] of sources) {
          logs.push(`--- ${label} (last lines) ---\n${(await this.execute(["logs", "--tail", String(lines), name]).catch(() => "")).trim()}`);
        }
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.join("\n")}`);
      }
    } finally {
      for (const name of containers) await this.execute(["rm", "-f", name]).catch(() => {});
      await this.execute(["network", "rm", network]).catch(() => {});
      for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  private serviceRepository(service: PreviewService): RepositoryTools {
    const repository = this.findProject(service.project);
    if (!repository) throw new Error(`${PREVIEW_FIXTURE_FILE} needs ${service.project} running beside this app, but ${service.project} is not in this task's scope. Add it to the workroom, then check again.`);
    this.store.check(repository.snapshot, "repo.read");
    this.store.check(repository.snapshot, "script.run");
    if (service.directory !== ".") repository.resolve(service.directory);
    let scripts: Record<string, unknown> = {};
    try { scripts = JSON.parse(repository.read(service.directory === "." ? "package.json" : `${service.directory}/package.json`)).scripts ?? {}; } catch { throw new Error(`${service.project}/${service.directory} has no readable package.json.`); }
    if (typeof scripts[service.script] !== "string") throw new Error(`${service.project}/${service.directory} has no script named ${service.script}.`);
    return repository;
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
    this.installed.delete(cwd);
    const realLock = this.repository.read(lockFile);
    const lock = JSON.parse(realLock);
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
    const privateLock = JSON.stringify(lock);
    fs.writeFileSync(path.join(directory, "workspace", lockFile), privateLock);
    // This private lockfile changes tarball locations only. The real lockfile
    // and checkout are never writable by npm or by package lifecycle scripts.
    const output = await this.container(directory, NPM_CI, false, cwd);
    this.store.check(this.repository.snapshot, "pkg.install");
    const native = await this.nativeAddons(directory, entries, cwd);
    this.installed.set(cwd, { lockHash: createHash("sha256").update(realLock).digest("hex"), privateLock, natives: native.addons });
    const checkout = this.options.checkoutDeps ? await this.installInCheckout(directory, cwd) : "";
    return `Installed dependencies in this turn's sandbox. Tests, scripts and previews keep using them after your edits, until ${lockFile} changes.${checkout}${native.note}\n${output}`;
  }
  /**
   * Packages are installed with lifecycle scripts off, so a native addon
   * (better-sqlite3, sqlite3, bcrypt…) arrives without its compiled binary and
   * the app crashes the moment it loads it. Compile each one once, offline, in
   * the agent image (which has a compiler and Node's headers), and keep the
   * .node files by tarball integrity so later installs — any job, any project —
   * only copy them in. Packages whose script is not a node-gyp build are
   * remembered as such and skipped.
   */
  private async nativeAddons(directory: string, entries: [string, any][], cwd: string): Promise<{ addons: NativeAddon[]; note: string }> {
    const image = process.env.PSM_TASK_IMAGE || "node:22-bookworm-slim";
    const candidates: NativeAddon[] = entries.filter(([name, entry]) => name && entry.hasInstallScript)
      .map(([name, entry]) => ({ path: name, key: createHash("sha256").update(`${entry.integrity}\0${image}`).digest("hex").slice(0, 32) }));
    if (!candidates.length) return { addons: [], note: "" };
    const cache = this.options.nativeCache ?? defaultNativeCache();
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
    const missing = candidates.filter(({ key }) => !fs.existsSync(path.join(cache, key)) && !fs.existsSync(path.join(cache, `${key}.none`)));
    const failed: string[] = [];
    let log = "";
    if (missing.length) {
      const out = fs.mkdtempSync(path.join(directory, "native-"));
      try {
        try { log = await this.compileAddons(directory, out, cwd, missing); }
        catch (error) { log = (error as Error).message; }
        for (const { path: name, key } of missing) {
          if (fs.existsSync(path.join(out, `${key}.none`))) { fs.writeFileSync(path.join(cache, `${key}.none`), ""); continue; }
          if (!fs.existsSync(path.join(out, key))) { failed.push(name.replace(/^.*node_modules\//, "")); continue; }
          const staging = fs.mkdtempSync(path.join(cache, ".staging-"));
          fs.cpSync(path.join(out, key), staging, { recursive: true });
          fs.renameSync(staging, path.join(cache, key));
        }
      } finally { fs.rmSync(out, { recursive: true, force: true }); }
    }
    const addons = candidates.filter(({ key }) => fs.existsSync(path.join(cache, key)));
    for (const { key } of addons) fs.cpSync(path.join(cache, key), path.join(directory, "packages", "native", key), { recursive: true });
    const note = failed.length
      ? `\nCould not compile the native addon${failed.length === 1 ? "" : "s"} ${failed.join(", ")}; code that loads ${failed.length === 1 ? "it" : "them"} will fail in this sandbox. That is a psm sandbox limit, not a fault in the project.\n${log.slice(-3000)}`
      : addons.length ? `\nNative addons ready: ${addons.map(({ path: name }) => name.replace(/^.*node_modules\//, "")).join(", ")}.` : "";
    return { addons, note };
  }
  private async compileAddons(directory: string, out: string, cwd: string, addons: NativeAddon[]): Promise<string> {
    if (this.signal.aborted) throw new Error("This turn was stopped.");
    const name = `psm-native-${randomUUID()}`;
    const script = `const fs=require('fs'),cp=require('child_process'),path=require('path');
fs.cpSync('/source','/workspace',{recursive:true});
const root=path.join('/workspace',${JSON.stringify(cwd)});
const [npm,...args]=${JSON.stringify(NPM_CI)};
const r=cp.spawnSync(npm,args,{cwd:root,stdio:'inherit'}); if(r.error||r.status!==0) process.exit(r.status||1);
const gyp='/usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js';
for (const {path:p,key} of ${JSON.stringify(addons)}) {
  const dir=path.join(root,p);
  if (!fs.existsSync(path.join(dir,'binding.gyp'))) { fs.writeFileSync('/out/'+key+'.none',''); continue; }
  console.log('psm: compiling '+p);
  const b=cp.spawnSync('node',[gyp,'rebuild','--release'],{cwd:dir,stdio:'inherit',env:{...process.env,npm_config_nodedir:'/usr/local'}});
  const release=path.join(dir,'build','Release');
  const built=b.status===0&&fs.existsSync(release)?fs.readdirSync(release).filter(f=>f.endsWith('.node')):[];
  if (!built.length) { console.log('psm: could not compile '+p); continue; }
  fs.mkdirSync('/out/'+key+'/build/Release',{recursive:true});
  for (const f of built) fs.copyFileSync(path.join(release,f),'/out/'+key+'/build/Release/'+f);
}`;
    try {
      return await this.execute(["run", "--name", name, "--rm", ...HARDENED, "--network=none", "--memory=2g", "--cpus=2", "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m", "--tmpfs", "/workspace:rw,exec,nosuid,nodev,size=1536m,mode=1777",
        "--mount", `type=bind,source=${directory}/workspace,target=/source,readonly`, "--mount", `type=bind,source=${directory}/packages,target=/packages,readonly`,
        "--mount", `type=bind,source=${out},target=/out`, "--workdir", "/workspace", "--env", "HOME=/tmp", "--env", "npm_config_cache=/tmp/npm-cache",
        process.env.PSM_AGENT_IMAGE || "psm-agent:1", "node", "-e", script], this.signal);
    } finally { await this.execute(["rm", "-f", name]).catch(() => {}); }
  }
  /** Copy this directory's installed node_modules into the checkout (an implement job's clone), Git-excluded. */
  private async installInCheckout(directory: string, cwd: string): Promise<string> {
    const checkout = fs.realpathSync(this.repository.snapshot.project.path);
    const git = path.join(checkout, ".git");
    if (!fs.existsSync(git) || !fs.lstatSync(git).isDirectory()) return "";
    const exclude = path.join(git, "info", "exclude");
    const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
    if (!/^node_modules\/$/m.test(current)) { fs.mkdirSync(path.dirname(exclude), { recursive: true }); fs.writeFileSync(exclude, `${current}${current && !current.endsWith("\n") ? "\n" : ""}node_modules/\n`); }
    const copy = `const fs=require('fs'),path=require('path');const to=path.join('/checkout',${JSON.stringify(cwd)},'node_modules');fs.rmSync(to,{recursive:true,force:true});fs.cpSync(path.join(process.cwd(),'node_modules'),to,{recursive:true,verbatimSymlinks:true});`;
    try {
      await this.container(directory, ["node", "-e", copy], true, cwd, false, { mounts: [`type=bind,source=${checkout},target=/checkout`] });
      return ` They are also in ${cwd === "." ? "" : `${cwd}/`}node_modules in the job's clone, so sandbox_shell can run them.`;
    } catch (error) {
      return ` They could not be copied into the job's clone for sandbox_shell: ${(error as Error).message.slice(-500)}`;
    }
  }
  close(): void { if (this.directory) fs.rmSync(this.directory, { recursive: true, force: true }); this.directory = null; this.sourceDigest = ""; this.installed.clear(); }
}
