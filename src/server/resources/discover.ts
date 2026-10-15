/**
 * What psm can see on this machine that a project might touch: databases,
 * Docker containers, node servers, and folders you added by hand.
 *
 * Discovery is live and stores nothing. The only durable state is the access
 * level you chose for each resource (store.ts); everything here is recomputed
 * on every read, so a database you stopped simply stops being "running".
 *
 * Credentials never get past `parseDatabaseUri`. A connection string from a
 * project's `.env` is reduced to engine, host, port and database name at parse
 * time; the user, password and query string are not kept in any variable that
 * outlives the call. Tests hold this module to that.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ListeningSocket, MachineProcess, PsRow } from "../machine.ts";

export type Engine = "mongodb" | "postgres" | "redis" | "mysql";
export type ResourceKind = "database" | "container" | "server" | "folder";

export const ENGINE_LABEL: Record<Engine, string> = {
  mongodb: "MongoDB",
  postgres: "PostgreSQL",
  redis: "Redis",
  mysql: "MySQL",
};

const DEFAULT_PORT: Record<Engine, number> = { mongodb: 27017, postgres: 5432, redis: 6379, mysql: 3306 };

const SCHEMES: Record<string, Engine> = {
  mongodb: "mongodb",
  "mongodb+srv": "mongodb",
  postgres: "postgres",
  postgresql: "postgres",
  redis: "redis",
  rediss: "redis",
  mysql: "mysql",
  mariadb: "mysql",
};

/** A connection string with everything secret already gone. */
export interface DatabaseTarget {
  engine: Engine;
  /** Normalised: every loopback spelling is `localhost`. */
  host: string;
  /** null for `mongodb+srv`, which resolves its port through DNS. */
  port: number | null;
  database: string | null;
  /** On this machine (loopback or this host's own name). */
  local: boolean;
  /** Further hosts of a replica set, by name only. */
  moreHosts: number;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "::", "*", "ip6-localhost"]);

export function normalizeHost(host: string): string {
  const bare = host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (LOOPBACK.has(bare) || /^127\./.test(bare)) return "localhost";
  return bare;
}

export function isLocalHost(host: string): boolean {
  const normal = normalizeHost(host);
  return normal === "localhost" || normal === os.hostname().toLowerCase();
}

/**
 * `mongodb://user:pass@host:27017/db?authSource=admin` → `{ mongodb, host, 27017, db }`.
 *
 * Parsed by hand rather than with `URL` on purpose: `URL` would hold the
 * password in `.password` for as long as the object lives, and replica-set
 * host lists (`a:1,b:2`) are not valid URLs anyway.
 */
export function parseDatabaseUri(value: string): DatabaseTarget | null {
  const match = /^\s*([a-z][a-z0-9+]*):\/\/(?:[^@/?#]*@)?([^/?#]+)(?:\/([^?#]*))?/i.exec(value);
  if (!match) return null;
  const engine = SCHEMES[match[1].toLowerCase()];
  if (!engine) return null;
  const hosts = match[2].split(",").filter(Boolean);
  if (!hosts.length) return null;
  const first = hosts[0];
  // [::1]:27017, host:27017, host
  const hostPort = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(first);
  if (!hostPort) return null;
  const srv = match[1].toLowerCase() === "mongodb+srv";
  const port = hostPort[2] ? Number(hostPort[2]) : srv ? null : DEFAULT_PORT[engine];
  if (port !== null && (!Number.isInteger(port) || port <= 0 || port > 65535)) return null;
  let database: string | null = null;
  const rawDb = (match[3] || "").split("/")[0];
  if (rawDb) {
    try {
      database = decodeURIComponent(rawDb);
    } catch {
      database = rawDb;
    }
  }
  const host = normalizeHost(hostPort[1]);
  return { engine, host, port, database, local: isLocalHost(host), moreHosts: hosts.length - 1 };
}

/** Stable identity for a database endpoint; the level is stored against it. */
export function databaseKey(target: Pick<DatabaseTarget, "engine" | "host" | "port">): string {
  return `db:${target.engine}:${normalizeHost(target.host)}:${target.port ?? "srv"}`;
}

/* ---------------------------------------------------------------- .env files */

/** One database a project's `.env` points at — the variable's name, never its value. */
export interface EnvReference {
  project: string;
  /** Directory of the `.env`, relative to the project ("" for the root). */
  directory: string;
  file: string;
  variable: string;
  target: DatabaseTarget;
}

/** Same rule the agent sandbox uses to keep secrets out: examples are not secrets. */
const ENV_FILE = /^\.env(?:\.(?!example$|sample$|template$)[^/]*)?$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".psm-data", ".psm-logs"]);

/** `.env` files at the root and up to two directories down. */
export function envFiles(root: string, depth = 2): string[] {
  const found: string[] = [];
  const walk = (dir: string, level: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && ENV_FILE.test(entry.name)) found.push(full);
      else if (entry.isDirectory() && level < depth && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) walk(full, level + 1);
    }
  };
  walk(root, 0);
  return found.sort();
}

/**
 * The database targets in one `.env` text. Values are parsed and dropped on the
 * spot; only the variable name and the credential-free target come back.
 */
export function databaseVariables(text: string): Array<{ variable: string; target: DatabaseTarget }> {
  const out: Array<{ variable: string; target: DatabaseTarget }> = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const target = parseDatabaseUri(match[2].trim().replace(/^(['"])(.*)\1$/, "$2"));
    if (target) out.push({ variable: match[1], target });
  }
  return out;
}

export function envReferences(projects: Array<{ name: string; path: string }>): EnvReference[] {
  const refs: EnvReference[] = [];
  for (const project of projects) {
    for (const file of envFiles(project.path)) {
      let text: string;
      try {
        if (fs.statSync(file).size > 256 * 1024) continue;
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const directory = path.relative(project.path, path.dirname(file));
      for (const { variable, target } of databaseVariables(text)) {
        refs.push({ project: project.name, directory, file: path.basename(file), variable, target });
      }
    }
  }
  return refs;
}

/* ---------------------------------------------------------------- Docker */

export interface ContainerPort {
  hostPort: number;
  containerPort: number;
}

export interface Container {
  name: string;
  image: string;
  state: string;
  status: string;
  ports: ContainerPort[];
}

export interface DockerView {
  available: boolean;
  /** Why the list is empty when Docker could not be asked. */
  reason: string | null;
  containers: Container[];
}

/** "0.0.0.0:27018->27017/tcp, :::27018->27017/tcp" → [{27018, 27017}] */
export function parseDockerPorts(value: string): ContainerPort[] {
  const ports = new Map<string, ContainerPort>();
  for (const match of value.matchAll(/:(\d+)->(\d+)\/tcp/g)) {
    const port = { hostPort: Number(match[1]), containerPort: Number(match[2]) };
    ports.set(`${port.hostPort}:${port.containerPort}`, port);
  }
  return [...ports.values()];
}

export function parseDockerPs(output: string): Container[] {
  const containers: Container[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      containers.push({
        name: String(row.Names || row.ID || "?").split(",")[0],
        image: String(row.Image || ""),
        state: String(row.State || ""),
        status: String(row.Status || ""),
        ports: parseDockerPorts(String(row.Ports || "")),
      });
    } catch {
      /* a line that is not JSON is not a container */
    }
  }
  return containers;
}

export function dockerView(): DockerView {
  try {
    const output = execFileSync("docker", ["ps", "--format", "{{json .}}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 4000,
    });
    return { available: true, reason: null, containers: parseDockerPs(output) };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    const stderr = String(err.stderr || "");
    const reason =
      err.code === "ENOENT"
        ? "Docker is not installed."
        : /permission denied/i.test(stderr)
          ? "Docker is installed, but this user may not talk to the Docker daemon (permission denied)."
          : /Cannot connect|Is the docker daemon running/i.test(stderr)
            ? "Docker is installed, but nothing is listening on its socket. Start the Docker daemon."
            : "Docker did not answer.";
    return { available: false, reason, containers: [] };
  }
}

/** Database engine a container image runs, judged by the image's name. */
export function engineOfImage(image: string): Engine | null {
  const name = image.split("@")[0].split(":")[0].split("/").pop() || "";
  if (/^mongo(db)?(-.*)?$/.test(name)) return "mongodb";
  if (/^(postgres|postgis|timescaledb)(-.*)?$/.test(name)) return "postgres";
  if (/^(redis|valkey|redis-stack(-server)?)$/.test(name)) return "redis";
  if (/^(mysql|mariadb|percona)(-.*)?$/.test(name)) return "mysql";
  return null;
}

/** Database engine a process runs, judged by its executable. */
export function engineOfProcess(args: string): Engine | null {
  const exe = (args.trim().split(/\s+/)[0] || "").split("/").pop() || "";
  if (exe === "mongod" || exe === "mongos") return "mongodb";
  if (exe === "postgres" || exe === "postmaster") return "postgres";
  if (exe === "redis-server" || exe === "valkey-server") return "redis";
  if (exe === "mysqld" || exe === "mariadbd") return "mysql";
  return null;
}

function engineOfPort(port: number): Engine | null {
  for (const [engine, known] of Object.entries(DEFAULT_PORT)) if (known === port) return engine as Engine;
  return null;
}

/* ---------------------------------------------------------------- assembly */

export interface Resource {
  key: string;
  kind: ResourceKind;
  name: string;
  /** One line on where it runs: "system service", "container mongo-dev", "remote". */
  where: string;
  running: boolean;
  local: boolean;
  engine?: Engine;
  host?: string;
  port?: number | null;
  /** Databases: which project `.env` files point at it. */
  usedBy?: Array<{ project: string; directory: string; file: string; variable: string; database: string | null }>;
  /** Containers: image and published ports. Databases: the container serving it. */
  image?: string;
  container?: string | null;
  ports?: number[];
  /** Servers: the project it belongs to. */
  project?: string | null;
  pid?: number | null;
  /** Folders: the absolute path. */
  path?: string;
}

export interface DiscoveryInput {
  sockets: ListeningSocket[];
  table: Map<number, PsRow>;
  docker: DockerView;
  env: EnvReference[];
  servers: MachineProcess[];
  folders: string[];
}

export interface Discovery {
  resources: Resource[];
  docker: { available: boolean; reason: string | null };
}

/** Put the live inputs together into one list. Pure, so it is testable. */
export function assemble(input: DiscoveryInput): Discovery {
  const databases = new Map<string, Resource>();
  const database = (engine: Engine, host: string, port: number | null, local: boolean): Resource => {
    const key = databaseKey({ engine, host, port });
    let row = databases.get(key);
    if (!row) {
      row = {
        key,
        kind: "database",
        name: local ? `${ENGINE_LABEL[engine]} :${port ?? "srv"}` : `${ENGINE_LABEL[engine]} · ${host}`,
        where: local ? "this machine" : "remote",
        running: !local, // a remote one is not ours to probe; say nothing false about it
        local,
        engine,
        host,
        port,
        usedBy: [],
        container: null,
      };
      databases.set(key, row);
    }
    return row;
  };

  // Containers first, so a database on a published port can name its container.
  const publishedBy = new Map<number, Container>();
  for (const container of input.docker.containers) for (const port of container.ports) publishedBy.set(port.hostPort, container);

  for (const socket of input.sockets) {
    const proc = socket.pid ? input.table.get(socket.pid) : undefined;
    const container = publishedBy.get(socket.port);
    const fromProcess = proc ? engineOfProcess(proc.args) : null;
    const fromImage = container ? engineOfImage(container.image) : null;
    // A process we can see that is not a database is not one, whatever its port.
    const engine = fromProcess || fromImage || (proc && !container ? null : engineOfPort(socket.port));
    if (!engine) continue;
    const row = database(engine, "localhost", socket.port, true);
    row.running = true;
    if (container) {
      row.container = container.name;
      row.where = `container ${container.name}`;
    } else if (!proc) {
      row.where = "system service";
    } else {
      row.where = `process ${proc.args.split(/\s+/)[0].split("/").pop()}`;
      row.pid = proc.pid;
    }
  }

  // A database container whose port is not published still exists; it just is
  // not reachable from the host.
  for (const container of input.docker.containers) {
    const engine = engineOfImage(container.image);
    if (!engine || container.ports.length) continue;
    const key = `db:${engine}:container:${container.name}`;
    databases.set(key, {
      key,
      kind: "database",
      name: `${ENGINE_LABEL[engine]} in ${container.name}`,
      where: `container ${container.name}, no published port`,
      running: container.state === "running",
      local: true,
      engine,
      host: container.name,
      port: null,
      usedBy: [],
      container: container.name,
    });
  }

  for (const ref of input.env) {
    const row = database(ref.target.engine, ref.target.host, ref.target.port, ref.target.local);
    if (ref.target.local && !row.running) row.where = "this machine, not running";
    row.usedBy!.push({ project: ref.project, directory: ref.directory, file: ref.file, variable: ref.variable, database: ref.target.database });
  }

  const containers: Resource[] = input.docker.containers.map((container) => ({
    key: `container:${container.name}`,
    kind: "container",
    name: container.name,
    where: container.status || container.state,
    running: container.state === "running",
    local: true,
    image: container.image,
    ports: container.ports.map((port) => port.hostPort),
  }));

  const servers: Resource[] = input.servers
    .filter((proc) => !proc.self && proc.ports.length > 0)
    .map((proc) => ({
      key: `server:${proc.pid}`,
      kind: "server",
      name: proc.label,
      where: proc.project ? proc.project : proc.cwd || "unknown folder",
      running: true,
      local: true,
      project: proc.project,
      pid: proc.pid,
      ports: proc.ports,
    }));

  const folders: Resource[] = input.folders.map((folder) => ({
    key: folderKey(folder),
    kind: "folder",
    name: path.basename(folder) || folder,
    where: folder.replace(os.homedir(), "~"),
    running: fs.existsSync(folder),
    local: true,
    path: folder,
  }));

  const byName = (a: Resource, b: Resource) => a.name.localeCompare(b.name);
  return {
    resources: [...[...databases.values()].sort(byName), ...containers.sort(byName), ...servers.sort(byName), ...folders.sort(byName)],
    docker: { available: input.docker.available, reason: input.docker.reason },
  };
}

export function folderKey(folder: string): string {
  return `folder:${path.resolve(folder)}`;
}

/** Item count and size of a folder; only asked for at Read or Full. */
export function folderSummary(folder: string): { items: number | null; bytes: number | null } {
  let items: number | null = null;
  try {
    items = fs.readdirSync(folder).length;
  } catch {
    /* gone, or not ours */
  }
  let bytes: number | null = null;
  try {
    const out = execFileSync("du", ["-sk", folder], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
    const kib = Number(out.trim().split(/\s+/)[0]);
    bytes = Number.isFinite(kib) ? kib * 1024 : null;
  } catch {
    /* too big to measure in time, or unreadable */
  }
  return { items, bytes };
}
