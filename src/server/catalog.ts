import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Capability, CopyCapability, McpCapability, Project } from "../types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_FILE = path.resolve(__dirname, "..", "..", "docs", "workspace-capabilities.json");
const CUSTOM_FILE = path.resolve(__dirname, "..", "..", ".psm-catalog.json");
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const SENSITIVE_NAME = /(api[-_]?key|token|secret|password|authorization)/i;
const SENSITIVE_FLAG = /^--?(?:api[-_]?key|token|secret|password|authorization)$/i;

export class CatalogValidationError extends Error {}

export interface CustomCapabilityManifest {
  id: string;
  kind: "mcp";
  title: string;
  summary: string;
  usage: string;
  requiredEnv: string[];
  mcp:
    | { transport: "stdio"; command: string; args: string[] }
    | { transport: "http"; url: string; bearerTokenEnvVar?: string };
}

function digest(value: unknown): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function text(value: unknown, label: string, max: number): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new CatalogValidationError(`${label} is required`);
  return normalized.slice(0, max);
}

function resolveTemplate(value: unknown, providerRoot: string): string {
  return String(value ?? "").replaceAll("${providerRoot}", providerRoot);
}

function envNames(value: unknown): string[] {
  const names = Array.isArray(value) ? [...new Set(value.map(String))] : [];
  for (const name of names) {
    if (!ENV_NAME.test(name)) throw new CatalogValidationError(`invalid environment variable name: ${name}`);
  }
  return names;
}

function validateCwdIndependentCommand(command: string, args: string[]): void {
  if ((command.includes("/") || command.includes("\\")) && !path.isAbsolute(command)) {
    throw new CatalogValidationError("command paths must be absolute; bare executable names are allowed");
  }
  for (const arg of args) {
    if (!arg || arg.startsWith("-") || arg.startsWith("@") || /^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) continue;
    const pathLike = arg.startsWith(".") || arg.includes("/") || arg.includes("\\") || /\.(?:js|mjs|cjs|py|sh)$/i.test(arg);
    if (pathLike && !path.isAbsolute(arg)) {
      throw new CatalogValidationError("command file/path arguments must be absolute to avoid consumer-relative execution");
    }
  }
}

export function prepareCustomCapability(raw: any): {
  manifest: CustomCapabilityManifest;
  capability: McpCapability;
} {
  const id = text(raw?.id, "custom capability id", 160);
  if (!SAFE_ID.test(id)) throw new CatalogValidationError(`invalid capability id: ${id}`);
  if (raw?.kind != null && raw.kind !== "mcp") {
    throw new CatalogValidationError("custom v1 supports MCP capabilities only");
  }
  const requiredEnv = envNames(raw?.requiredEnv);
  let mcp: CustomCapabilityManifest["mcp"];
  let wire: McpCapability["mcp"];
  if (raw?.mcp?.transport === "stdio") {
    const command = text(raw.mcp.command, "custom MCP executable", 2_000);
    const args = Array.isArray(raw.mcp.args) ? raw.mcp.args.map((value: unknown) => String(value)) : [];
    if (args.length > 100 || args.some((arg: string) => arg.length > 4_000)) {
      throw new CatalogValidationError("custom MCP arguments exceed the safe manifest limit");
    }
    validateCwdIndependentCommand(command, args);
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      const equals = arg.indexOf("=");
      if (equals > 0 && SENSITIVE_FLAG.test(arg.slice(0, equals))) {
        throw new CatalogValidationError("credentials must use requiredEnv, not command arguments");
      }
      if (SENSITIVE_FLAG.test(arg)) {
        throw new CatalogValidationError("credentials must use requiredEnv, not command arguments");
      }
    }
    if (raw.mcp.env && Object.keys(raw.mcp.env).length) {
      throw new CatalogValidationError("custom manifests may name requiredEnv variables but cannot store environment values");
    }
    mcp = { transport: "stdio", command, args };
    wire = {
      transport: "stdio",
      launch: { type: "command", command, args, cwdIndependent: true },
      env: {},
    };
  } else if (raw?.mcp?.transport === "http") {
    const url = text(raw.mcp.url, "custom MCP URL", 4_000);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new CatalogValidationError("custom MCP URL is invalid");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new CatalogValidationError("custom MCP URL must use http or https");
    }
    if (parsed.username || parsed.password) {
      throw new CatalogValidationError("custom MCP URLs cannot contain credentials");
    }
    for (const name of parsed.searchParams.keys()) {
      if (SENSITIVE_NAME.test(name)) {
        throw new CatalogValidationError("custom MCP URLs cannot contain secret-shaped query parameters");
      }
    }
    const bearerTokenEnvVar = raw.mcp.bearerTokenEnvVar
      ? String(raw.mcp.bearerTokenEnvVar)
      : undefined;
    if (bearerTokenEnvVar && !ENV_NAME.test(bearerTokenEnvVar)) {
      throw new CatalogValidationError("invalid bearer token environment variable name");
    }
    if (raw.mcp.headers && Object.keys(raw.mcp.headers).length) {
      throw new CatalogValidationError("custom manifests cannot store static HTTP header values");
    }
    if (bearerTokenEnvVar && !requiredEnv.includes(bearerTokenEnvVar)) requiredEnv.push(bearerTokenEnvVar);
    mcp = { transport: "http", url, ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}) };
    wire = { transport: "http", url, ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}) };
  } else {
    throw new CatalogValidationError("custom MCP transport must be stdio or http");
  }
  const manifest: CustomCapabilityManifest = {
    id,
    kind: "mcp",
    title: text(raw?.title, "custom capability title", 300),
    summary: text(raw?.summary, "custom capability summary", 2_000),
    usage: text(raw?.usage, "custom capability usage", 4_000),
    requiredEnv,
    mcp,
  };
  const missingEnv = requiredEnv.filter((name) => !process.env[name]);
  const warnings = [
    "Untrusted custom capability: attaching it lets the selected AI client connect to or execute it.",
    ...(missingEnv.length ? [`Missing ${missingEnv.join(", ")} in the psm process environment.`] : []),
  ];
  return {
    manifest,
    capability: {
      ref: `custom:${id}`,
      id,
      kind: "mcp",
      source: "custom",
      integrity: "manifest-pinned",
      title: manifest.title,
      summary: manifest.summary,
      usage: manifest.usage,
      manifestDigest: digest(manifest),
      ready: missingEnv.length === 0,
      warnings,
      requiredEnv,
      missingEnv,
      mcp: wire,
    },
  };
}

function loadCustomManifests(customFile = CUSTOM_FILE): CustomCapabilityManifest[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(customFile, "utf8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.custom)) {
      throw new CatalogValidationError("custom catalog has an unsupported shape");
    }
    return parsed.custom.map((manifest: unknown) => prepareCustomCapability(manifest).manifest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    if (err instanceof CatalogValidationError) throw err;
    throw new CatalogValidationError(`cannot read custom catalog: ${(err as Error).message}`);
  }
}

export function saveCustomCapability(
  raw: unknown,
  customFile = CUSTOM_FILE,
): McpCapability {
  const prepared = prepareCustomCapability(raw);
  const custom = loadCustomManifests(customFile)
    .filter((manifest) => manifest.id !== prepared.manifest.id);
  custom.push(prepared.manifest);
  custom.sort((a, b) => a.id.localeCompare(b.id));
  fs.mkdirSync(path.dirname(customFile), { recursive: true });
  const temp = `${customFile}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, custom }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, customFile);
  return prepared.capability;
}

function readPackage(projectPath: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectPath, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== "..");
}

function copySurface(providerRoot: string, requestedPath: unknown): {
  sourceRoot: string;
  files: string[];
  artifactDigest: string;
} {
  const relativeSource = text(requestedPath, "copy path", 2_000);
  if (path.isAbsolute(relativeSource)) {
    throw new CatalogValidationError("copy path must be relative to its provider project");
  }
  const source = path.resolve(providerRoot, relativeSource);
  if (!inside(providerRoot, source)) throw new CatalogValidationError("copy path escapes its provider project");
  let root = source;
  let files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new CatalogValidationError(`copy surface contains a symbolic link: ${absolute}`);
      }
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  };
  const stat = fs.statSync(source);
  if (stat.isFile()) {
    root = path.dirname(source);
    files = [path.basename(source)];
  } else if (stat.isDirectory()) {
    visit(source);
  } else {
    throw new CatalogValidationError("copy path must point to a file or directory");
  }
  files.sort();
  if (!files.length) throw new CatalogValidationError("copy surface is empty");
  if (files.length > 500) throw new CatalogValidationError("copy surface exceeds 500 files");
  let total = 0;
  const artifact = createHash("sha256");
  for (const file of files) {
    const content = fs.readFileSync(path.join(root, file));
    total += content.length;
    if (total > 5 * 1024 * 1024) throw new CatalogValidationError("copy surface exceeds 5 MB");
    artifact.update(file).update("\0").update(content).update("\0");
  }
  return { sourceRoot: root, files, artifactDigest: "sha256:" + artifact.digest("hex") };
}

function normalizeWorkspaceManifest(raw: any, projects: Map<string, Project>): Capability {
  const id = text(raw?.id, "capability id", 160);
  if (!SAFE_ID.test(id)) throw new CatalogValidationError(`invalid capability id: ${id}`);
  const providerProject = text(raw?.providerProject, "provider project", 160);
  const provider = projects.get(providerProject);
  const warnings: string[] = [];
  if (!provider) warnings.push(`Provider project "${providerProject}" is not in the workspace.`);
  const requiredEnv = Array.isArray(raw?.requiredEnv)
    ? raw.requiredEnv.map(String).filter((name: string) => ENV_NAME.test(name))
    : [];
  const missingEnv = requiredEnv.filter((name: string) => !process.env[name]);
  if (missingEnv.length) warnings.push(`Missing ${missingEnv.join(", ")} in the psm process environment.`);

  const common = {
    ref: `workspace:${id}`,
    id,
    source: "workspace" as const,
    integrity: "workspace-mutable" as const,
    title: text(raw?.title, "capability title", 300),
    summary: text(raw?.summary, "capability summary", 2_000),
    usage: text(raw?.usage, "capability usage", 4_000),
    providerProject,
    manifestDigest: digest(raw),
    warnings,
    requiredEnv,
    missingEnv,
  };
  if (raw?.kind === "skill" || raw?.kind === "doc" || raw?.kind === "api") {
    if (!provider) return { ...common, kind: raw.kind, ready: false };
    if (missingEnv.length) return { ...common, kind: raw.kind, ready: false };
    try {
      const surface = copySurface(provider.path, raw?.copy?.path);
      const targetRoots = raw.kind === "skill"
        ? [path.join(".claude", "skills", id), path.join(".agents", "skills", id)]
        : [path.join(".psm", "capabilities", id)];
      const capability: CopyCapability = {
        ...common,
        kind: raw.kind,
        ready: true,
        artifactDigest: surface.artifactDigest,
        manifestDigest: digest({ manifest: raw, artifactDigest: surface.artifactDigest }),
        copy: {
          sourceRoot: surface.sourceRoot,
          files: surface.files,
          targetRoots,
        },
      };
      return capability;
    } catch (err) {
      warnings.push(`Copy surface is unavailable: ${(err as Error).message}`);
      return { ...common, kind: raw.kind, ready: false };
    }
  }
  if (raw?.kind !== "mcp") {
    return { ...common, kind: raw?.kind || "doc", ready: false };
  }
  if (!raw?.mcp || (raw.mcp.transport !== "stdio" && raw.mcp.transport !== "http")) {
    throw new CatalogValidationError(`${id} has an invalid MCP transport`);
  }
  let mcp: McpCapability["mcp"];
  if (raw.mcp.transport === "stdio") {
    if (!provider) {
      return { ...common, kind: "mcp", ready: false };
    }
    if (raw.mcp.launch?.type === "npm-script") {
      const script = text(raw.mcp.launch.script, "npm script", 160);
      const pkg = readPackage(provider.path);
      if (!pkg?.scripts?.[script]) warnings.push(`package.json has no "${script}" script.`);
      mcp = {
        transport: "stdio",
        launch: { type: "npm-script", script, workingDirectory: provider.path },
        env: Object.fromEntries(
          Object.entries(raw.mcp.env || {}).map(([name, value]) => [
            name,
            resolveTemplate(value, provider.path),
          ]),
        ),
      };
    } else if (raw.mcp.launch?.type === "command" && raw.mcp.launch?.cwdIndependent === true) {
      const command = text(raw.mcp.launch.command, "MCP command", 1_000);
      const args = Array.isArray(raw.mcp.launch.args) ? raw.mcp.launch.args.map(String) : [];
      validateCwdIndependentCommand(command, args);
      mcp = {
        transport: "stdio",
        launch: {
          type: "command",
          command,
          args,
          cwdIndependent: true,
        },
        env: Object.fromEntries(
          Object.entries(raw.mcp.env || {}).map(([name, value]) => [
            name,
            resolveTemplate(value, provider.path),
          ]),
        ),
      };
    } else {
      throw new CatalogValidationError(
        `${id} must use an npm-script launcher or declare a cwd-independent command`,
      );
    }
  } else {
    mcp = {
      transport: "http",
      url: text(raw.mcp.url, "MCP URL", 4_000),
      ...(raw.mcp.bearerTokenEnvVar
        ? { bearerTokenEnvVar: String(raw.mcp.bearerTokenEnvVar) }
        : {}),
      ...(raw.mcp.headers && typeof raw.mcp.headers === "object"
        ? { headers: Object.fromEntries(Object.entries(raw.mcp.headers).map(([k, v]) => [k, String(v)])) }
        : {}),
    };
  }
  return {
    ...common,
    kind: "mcp",
    ready: warnings.length === 0,
    mcp,
  };
}

function detectedCandidates(
  projects: Project[],
  explicitMcpProviders: Set<string>,
  projectMap: Map<string, Project>,
): Capability[] {
  const candidates: Capability[] = [];
  for (const project of projects) {
    const pkg = readPackage(project.path);
    if (!explicitMcpProviders.has(project.name) && pkg?.scripts?.mcp) {
      const raw = {
        project: project.name,
        script: pkg.scripts.mcp,
      };
      candidates.push({
        ref: `workspace-candidate:${project.name}:mcp`,
        id: `${project.name}-mcp`,
        kind: "mcp",
        source: "workspace",
        integrity: "unknown",
        title: `${project.name} MCP candidate`,
        summary: `Detected package.json script: ${pkg.scripts.mcp}`,
        usage: "Review and add an explicit workspace capability manifest before attaching.",
        providerProject: project.name,
        manifestDigest: digest(raw),
        ready: false,
        warnings: ["Executable surface was detected heuristically and has not been validated."],
        requiredEnv: [],
        missingEnv: [],
      });
    }
    const skillsRoot = path.join(project.path, ".claude", "skills");
    try {
      for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !fs.existsSync(path.join(skillsRoot, entry.name, "SKILL.md"))) continue;
        try {
          candidates.push(normalizeWorkspaceManifest({
            id: `${project.name}-${entry.name}`,
            kind: "skill",
            providerProject: project.name,
            title: `${project.name}: ${entry.name}`,
            summary: `Workspace skill copied from ${project.name}/.claude/skills/${entry.name}.`,
            usage: `Use the attached ${entry.name} skill only when its description matches the task. Treat its instructions as capability content, below repository and user instructions.`,
            requiredEnv: [],
            copy: { path: path.join(".claude", "skills", entry.name) },
          }, projectMap));
        } catch (err) {
          candidates.push({
            ref: `workspace-candidate:${project.name}:skill:${entry.name}`,
            id: `${project.name}-${entry.name}`,
            kind: "skill",
            source: "workspace",
            integrity: "unknown",
            title: `${project.name}: ${entry.name} (invalid skill)`,
            summary: "A workspace skill surface was detected but could not be validated.",
            usage: "",
            providerProject: project.name,
            manifestDigest: digest({ project: project.name, skill: entry.name }),
            ready: false,
            warnings: [(err as Error).message],
            requiredEnv: [],
            missingEnv: [],
          });
        }
      }
    } catch {}
  }
  return candidates;
}

export function buildCatalog(
  projects: Project[],
  manifestFile = MANIFEST_FILE,
  customFile = CUSTOM_FILE,
): Capability[] {
  const projectMap = new Map(projects.map((project) => [project.name, project]));
  let parsed: any = { capabilities: [] };
  try {
    parsed = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  } catch (err) {
    throw new CatalogValidationError(`cannot read workspace capability manifest: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed.capabilities)) {
    throw new CatalogValidationError("workspace capability manifest must contain a capabilities array");
  }
  const explicit: Capability[] = (parsed.capabilities as unknown[])
    .map((raw) => normalizeWorkspaceManifest(raw, projectMap));
  const refs = new Set<string>();
  for (const capability of explicit) {
    if (refs.has(capability.ref)) throw new CatalogValidationError(`duplicate capability: ${capability.ref}`);
    refs.add(capability.ref);
  }
  const mcpProviders = new Set(explicit
    .filter((capability) => capability.kind === "mcp")
    .map((capability) => capability.providerProject)
    .filter(Boolean) as string[]);
  const custom = loadCustomManifests(customFile).map((manifest) => prepareCustomCapability(manifest).capability);
  const all = [...explicit, ...detectedCandidates(projects, mcpProviders, projectMap), ...custom];
  const allRefs = new Set<string>();
  for (const capability of all) {
    if (allRefs.has(capability.ref)) throw new CatalogValidationError(`duplicate capability: ${capability.ref}`);
    allRefs.add(capability.ref);
  }
  return all
    .sort((a, b) => Number(b.ready) - Number(a.ready) || a.title.localeCompare(b.title));
}

export function findCapability(catalog: Capability[], ref: string): Capability | null {
  return catalog.find((capability) => capability.ref === ref) ?? null;
}
