import express from "express";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getProjects, writeMarkdown } from "../index.ts";
import { loadOverrides, saveOverrides } from "../classify.ts";
import { loadConfig, workspaceRoot } from "../scan.ts";
import { STATUS_META } from "../render.ts";
import type { Attachment, Capability, Override, Project } from "../types.ts";
import { activeProcesses, allProcStates, procState, start, stop, stopAll, subscribe, type ProcKind } from "./procs.ts";
import {
  activeSessions,
  aiLimit,
  aiState,
  answerQuestion as aiAnswerQuestion,
  cancel as aiCancel,
  cancelPlanning,
  planningOverview,
  planningSessionKey,
  queuePlanReview,
  cachedRecap,
  recap as aiRecap,
  restoreCachedRecap,
  send as aiSend,
  sendPlanningMessage,
  startFreshAgentSession,
  startPlanningLoop,
  stopSession as stopAiSession,
  subscribeAi,
  WORKSPACE_NAME,
  type AiEngine,
} from "./ai.ts";
import { attachmentManager, WiringConflictError, WiringValidationError } from "./attach.ts";
import {
  buildCatalog,
  CatalogValidationError,
  findCapability,
  prepareCustomCapability,
  saveCustomCapability,
} from "./catalog.ts";
import { PlanConflictError, PlanNotFoundError, PlanValidationError, planStore } from "./plans.ts";
import { subscriptionUsage } from "./usage.ts";
import {
  applyManagedRegion,
  PRACTICES,
  readGlobalRules,
  readProfile,
  readProjectRules,
  suggestPractices,
  writeGlobalRules,
  writeProfile,
  writeProjectRules,
} from "./rules.ts";
import { collectSkillUsage } from "./skills.ts";
import { runtimeServices, startRuntimeDiscovery } from "./runtime.ts";
import {
  account as cloudAccount,
  authenticate as cloudAuthenticate,
  billingPortal as cloudBillingPortal,
  checkout as cloudCheckout,
  cloudAvailable,
  devices as cloudDevices,
  logout as cloudLogout,
  pullSync,
  pushSync,
  revokeDevice as cloudRevokeDevice,
} from "./cloud.ts";
import {
  backupProject,
  cloudSettings,
  deleteSnapshot,
  restoreSnapshot,
  runDueBackups,
  setBackupEnabled,
  snapshots,
} from "./backups.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "..", "..", "web");
const PORT = Number(process.env.PORT || 4317);

const app = express();
app.disable("x-powered-by");
const isLoopback = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
app.use((req, res, next) => {
  try {
    const host = new URL(`http://${req.headers.host || "invalid"}`).hostname;
    if (!isLoopback(host)) return res.status(403).json({ error: "psm only accepts loopback requests" });
    const origin = req.headers.origin;
    if (origin && !isLoopback(new URL(origin).hostname)) {
      return res.status(403).json({ error: "cross-origin requests are not allowed" });
    }
    next();
  } catch {
    return res.status(400).json({ error: "invalid Host or Origin header" });
  }
});
app.use(express.json({ limit: "2mb" }));

const OVERRIDE_KEYS: (keyof Override)[] = [
  "status",
  "category",
  "description",
  "stack",
  "next",
  "priority",
  "pinned",
  "workingOn",
  "archived",
  "note",
  "runCommand",
  "deployStaging",
  "deployProduction",
  "port",
  "aiEngine",
  "aiModel",
  "aiFullAccess",
];

app.get("/api/projects", (_req, res) => {
  res.json({ projects: getProjects(), statusMeta: STATUS_META });
});

app.get("/api/runtime/services", async (req, res) => {
  try {
    res.json({ services: await runtimeServices(req.query.refresh === "1") });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message || "runtime discovery failed" });
  }
});

/* ---------- Werewolf-hosted PSM Cloud ---------- */

function cloudError(res: express.Response, err: unknown) {
  const typed = err as Error & { status?: number; code?: string; data?: unknown };
  return res.status(typed.status || 500).json({
    error: typed.message || "PSM Cloud request failed",
    code: typed.code,
    data: typed.data,
  });
}

app.get("/api/cloud/status", async (_req, res) => {
  const runtime = (await runtimeServices()).werewolf;
  try {
    if (!cloudAvailable()) return res.json({ signedIn: false, runtime });
    res.json({ signedIn: true, account: await cloudAccount(true), settings: cloudSettings(), runtime });
  } catch (err) {
    const typed = err as Error & { status?: number };
    res.json({ signedIn: false, runtime, authError: typed.message || "Werewolf session could not be verified" });
  }
});

app.post("/api/cloud/:action(login|register)", async (req, res) => {
  try {
    const action = req.params.action as "login" | "register";
    const email = String(req.body?.email || "").trim();
    const password = String(req.body?.password || "");
    const name = String(req.body?.name || "").trim();
    if (!email || !password) return res.status(400).json({ error: "email and password are required" });
    const value = await cloudAuthenticate(action, { email, password, ...(name ? { name } : {}) });
    res.status(action === "register" ? 201 : 200).json({ signedIn: true, account: value, settings: cloudSettings() });
  } catch (err) {
    cloudError(res, err);
  }
});

app.post("/api/cloud/logout", async (_req, res) => {
  try {
    await cloudLogout();
    res.json({ ok: true });
  } catch (err) {
    cloudError(res, err);
  }
});

app.post("/api/cloud/billing/:action(checkout|portal)", async (req, res) => {
  try {
    const url = req.params.action === "portal"
      ? await cloudBillingPortal()
      : await cloudCheckout(req.body?.interval === "year" ? "year" : "month");
    res.json({ url });
  } catch (err) {
    cloudError(res, err);
  }
});

app.get("/api/cloud/devices", async (_req, res) => {
  try { res.json({ devices: await cloudDevices() }); }
  catch (err) { cloudError(res, err); }
});

app.delete("/api/cloud/devices/:id", async (req, res) => {
  try { res.json(await cloudRevokeDevice(req.params.id)); }
  catch (err) { cloudError(res, err); }
});

const CLOUD_OVERRIDE_KEYS: (keyof Override)[] = [
  "status", "category", "description", "stack", "next", "priority", "pinned",
  "workingOn", "workingOnAt", "archived", "note", "port", "aiEngine", "aiModel",
];

function safeCloudState() {
  const projects = getProjects();
  const overrides = loadOverrides();
  return {
    version: 1,
    updatedAt: Date.now(),
    projects: Object.fromEntries(projects.map((project) => {
      const source = overrides[project.name] || {};
      const safe = Object.fromEntries(
        CLOUD_OVERRIDE_KEYS
          .filter((key) => source[key] !== undefined)
          .map((key) => [key, source[key]]),
      );
      return [project.name, {
        override: safe,
        attachments: project.attachments,
        latestPlan: planStore.latest(project.name),
        recap: cachedRecap(project.name),
      }];
    })),
    backupProjects: cloudSettings().backupProjects,
  };
}

app.get("/api/cloud/sync", async (_req, res) => {
  try { res.json(await pullSync()); }
  catch (err) { cloudError(res, err); }
});

app.post("/api/cloud/sync", async (req, res) => {
  try {
    const revision = req.body?.revision == null ? undefined : Number(req.body.revision);
    res.json(await pushSync(safeCloudState(), revision));
  } catch (err) {
    cloudError(res, err);
  }
});

app.post("/api/cloud/sync/apply", (req, res) => {
  const remote = req.body?.state;
  if (remote?.version !== 1 || !remote.projects || typeof remote.projects !== "object") {
    return res.status(400).json({ error: "unsupported cloud sync state" });
  }
  const known = new Set(getProjects().map((project) => project.name));
  const all = loadOverrides();
  const planConflicts: { project: string; message: string }[] = [];
  for (const [name, value] of Object.entries(remote.projects as Record<string, any>)) {
    if (!known.has(name) || !value?.override || typeof value.override !== "object") continue;
    const current = all[name] || {};
    for (const key of CLOUD_OVERRIDE_KEYS) {
      if (value.override[key] !== undefined) (current as any)[key] = value.override[key];
    }
    if (Array.isArray(value.attachments)) {
      current.attachments = value.attachments.slice(0, 100).filter((attachment: unknown) => {
        if (!attachment || typeof attachment !== "object") return false;
        const item = attachment as Record<string, unknown>;
        return typeof item.capabilityRef === "string"
          && ["mcp", "skill", "doc", "api", "project"].includes(String(item.kind))
          && ["workspace", "registry", "custom"].includes(String(item.source))
          && ["reference", "copy"].includes(String(item.mode))
          && typeof item.manifestDigest === "string";
      });
    }
    all[name] = current;
    if (value.latestPlan) {
      try { planStore.importSnapshot(name, value.latestPlan); }
      catch (err) {
        planConflicts.push({ project: name, message: (err as Error).message });
      }
    }
    restoreCachedRecap(name, value.recap);
  }
  saveOverrides(all);
  res.json({ ok: true, projects: getProjects(), planConflicts });
});

app.get("/api/cloud/backups", async (req, res) => {
  try {
    res.json({
      snapshots: await snapshots(typeof req.query.project === "string" ? req.query.project : undefined),
      settings: cloudSettings(),
    });
  } catch (err) {
    cloudError(res, err);
  }
});

app.put("/api/cloud/backups/:name", (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  res.json({ settings: setBackupEnabled(project.name, !!req.body?.enabled) });
});

app.post("/api/cloud/backups/:name/now", async (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  try { res.json({ backup: await backupProject(project), settings: cloudSettings() }); }
  catch (err) { cloudError(res, err); }
});

app.post("/api/cloud/backups/:snapshotId/restore", async (req, res) => {
  try {
    const destination = String(req.body?.destination || "").trim();
    if (!destination) return res.status(400).json({ error: "restore destination is required" });
    res.json(await restoreSnapshot(req.params.snapshotId, destination));
  } catch (err) {
    cloudError(res, err);
  }
});

app.delete("/api/cloud/backups/:snapshotId", async (req, res) => {
  try {
    await deleteSnapshot(req.params.snapshotId);
    res.json({ ok: true });
  } catch (err) {
    cloudError(res, err);
  }
});

/* ---------- capability catalog and attachments ---------- */

function capabilityError(res: express.Response, err: unknown) {
  if (
    err instanceof WiringValidationError ||
    err instanceof CatalogValidationError
  ) return res.status(400).json({ error: err.message });
  if (err instanceof WiringConflictError) return res.status(409).json({ error: err.message });
  console.error("capability operation failed", err);
  return res.status(500).json({ error: "capability operation failed" });
}

function currentCatalog(): Capability[] {
  return buildCatalog(getProjects());
}

function customCatalogToken(manifest: unknown): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function attachmentPreviewToken(
  project: Project,
  action: "attach" | "detach",
  capabilityRef: string,
  preview: ReturnType<typeof attachmentManager.publicPlan>,
  attachments: Attachment[],
): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify({
    project: project.path,
    action,
    capabilityRef,
    preview,
    attachments: attachments.map(({ attachedAt: _attachedAt, ...attachment }) => attachment),
  })).digest("hex");
}

function requestedAttachmentChange(body: any): {
  action: "attach" | "detach";
  capabilityRef: string;
  change: { add: string } | { remove: string };
} {
  const add = typeof body?.add === "string" && body.add ? body.add : null;
  const remove = typeof body?.remove === "string" && body.remove ? body.remove : null;
  if (Number(!!add) + Number(!!remove) !== 1) {
    throw new WiringValidationError("request exactly one capability to attach or detach");
  }
  return add
    ? { action: "attach", capabilityRef: add, change: { add } }
    : { action: "detach", capabilityRef: remove!, change: { remove: remove! } };
}

function desiredAttachmentChange(
  project: Project,
  body: any,
): { capabilities: Capability[]; attachments: Attachment[] } {
  const catalog = currentCatalog();
  const refs = project.attachments.map((attachment) => attachment.capabilityRef);
  const add = typeof body?.add === "string" ? body.add : null;
  const remove = typeof body?.remove === "string" ? body.remove : null;
  let desiredRefs = refs;
  if (add && !desiredRefs.includes(add)) desiredRefs = [...desiredRefs, add];
  if (remove) desiredRefs = desiredRefs.filter((ref) => ref !== remove);
  const capabilities = desiredRefs.map((ref) => {
    const capability = findCapability(catalog, ref);
    if (!capability) throw new WiringValidationError(`unknown capability: ${ref}`);
    if (!capability.ready) {
      throw new WiringValidationError(
        `${capability.title} is not ready: ${capability.warnings.join(" ") || "manifest needs review"}`,
      );
    }
    return capability;
  });
  const previous = new Map(project.attachments.map((attachment) => [attachment.capabilityRef, attachment]));
  for (const capability of capabilities) {
    const existing = previous.get(capability.ref);
    if (existing && existing.manifestDigest !== capability.manifestDigest) {
      throw new WiringConflictError(
        `${capability.title} changed since it was attached; detach it and review a fresh attachment before updating`,
      );
    }
  }
  const attachments = capabilities.map((capability): Attachment => {
    const existing = previous.get(capability.ref);
    return existing && existing.manifestDigest === capability.manifestDigest
      ? existing
      : {
          capabilityRef: capability.ref,
          kind: capability.kind,
          source: capability.source,
          mode: capability.kind === "mcp" ? "reference" : "copy",
          manifestDigest: capability.manifestDigest,
          attachedAt: Date.now(),
        };
  });
  return { capabilities, attachments };
}

app.get("/api/catalog", (_req, res) => {
  try {
    const projects = getProjects();
    const attachments = new Map(
      projects.flatMap((project) =>
        project.attachments.map((attachment) => [
          `${project.name}\0${attachment.capabilityRef}`,
          attachment,
        ] as const),
      ),
    );
    const workspaceCatalog = buildCatalog(projects);
    const capabilities = workspaceCatalog.map((capability) => ({
      ...capability,
      attachedTo: projects
        .filter((project) => attachments.has(`${project.name}\0${capability.ref}`))
        .map((project) => project.name),
      updateAvailable: projects.some((project) => {
        const attachment = attachments.get(`${project.name}\0${capability.ref}`);
        return !!attachment && attachment.manifestDigest !== capability.manifestDigest;
      }),
    }));
    const knownRefs = new Set(workspaceCatalog.map((capability) => capability.ref));
    const broken = new Map<string, any>();
    for (const project of projects) {
      for (const attachment of project.attachments) {
        if (knownRefs.has(attachment.capabilityRef)) continue;
        const existing = broken.get(attachment.capabilityRef);
        if (existing) {
          existing.attachedTo.push(project.name);
          continue;
        }
        broken.set(attachment.capabilityRef, {
          ref: attachment.capabilityRef,
          id: attachment.capabilityRef.replace(/^[^:]+:/, ""),
          kind: attachment.kind,
          source: attachment.source,
          integrity: "unknown",
          title: `${attachment.capabilityRef} (missing)`,
          summary: "The attached manifest or provider is no longer present in the catalog.",
          usage: "",
          manifestDigest: attachment.manifestDigest,
          ready: false,
          broken: true,
          warnings: ["Broken attachment. Restore its source or detach it; psm will never remove it automatically."],
          requiredEnv: [],
          missingEnv: [],
          attachedTo: [project.name],
          updateAvailable: false,
        });
      }
    }
    res.json({ capabilities: [...capabilities, ...broken.values()], refreshedAt: Date.now(), source: "workspace" });
  } catch (err) {
    capabilityError(res, err);
  }
});

app.post("/api/catalog/custom/preview", (req, res) => {
  try {
    const { manifest, capability } = prepareCustomCapability(req.body);
    const command = manifest.mcp.transport === "stdio"
      ? {
          capabilityRef: capability.ref,
          transport: "stdio" as const,
          command: manifest.mcp.command,
          args: manifest.mcp.args,
          environmentNames: capability.requiredEnv,
        }
      : {
          capabilityRef: capability.ref,
          transport: "http" as const,
          url: manifest.mcp.url,
          environmentNames: capability.requiredEnv,
        };
    res.json({
      manifest,
      capability,
      previewToken: customCatalogToken(manifest),
      preview: {
        capabilityRefs: [capability.ref],
        operations: [{
          file: ".psm-catalog.json",
          action: "update",
          beforeDigest: null,
          afterDigest: capability.manifestDigest,
        }],
        commands: [command],
        warnings: capability.warnings,
        missingEnv: capability.missingEnv,
        restartRequired: false,
      },
    });
  } catch (err) {
    capabilityError(res, err);
  }
});

app.post("/api/catalog/custom", (req, res) => {
  if (req.body?.confirmed !== true) {
    return res.status(400).json({ error: "custom capabilities require an explicit confirmed preview" });
  }
  try {
    const { manifest } = prepareCustomCapability(req.body?.manifest);
    if (req.body?.previewToken !== customCatalogToken(manifest)) {
      return res.status(409).json({ error: "custom capability preview changed; review it again" });
    }
    const capability = saveCustomCapability(manifest);
    res.json({ ok: true, capability });
  } catch (err) {
    capabilityError(res, err);
  }
});

app.post("/api/projects/:name/attachments/preview", (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  try {
    const requested = requestedAttachmentChange(req.body);
    const desired = desiredAttachmentChange(project, requested.change);
    const wiring = attachmentManager.plan(project.path, desired.capabilities);
    const preview = attachmentManager.publicPlan(wiring);
    res.json({
      preview,
      previewToken: attachmentPreviewToken(
        project,
        requested.action,
        requested.capabilityRef,
        preview,
        desired.attachments,
      ),
      attachments: desired.attachments,
    });
  } catch (err) {
    capabilityError(res, err);
  }
});

app.post("/api/projects/:name/attachments", (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  if (req.body?.confirmed !== true) {
    return res.status(400).json({ error: "attachment requires an explicit confirmed preview" });
  }
  try {
    const desired = desiredAttachmentChange(project, { add: req.body?.capabilityRef });
    const wiring = attachmentManager.plan(project.path, desired.capabilities);
    const preview = attachmentManager.publicPlan(wiring);
    if (req.body?.previewToken !== attachmentPreviewToken(
      project,
      "attach",
      String(req.body?.capabilityRef || ""),
      preview,
      desired.attachments,
    )) {
      return res.status(409).json({ error: "attachment preview changed; review it again" });
    }
    const all = loadOverrides();
    all[project.name] = { ...(all[project.name] || {}), attachments: desired.attachments };
    attachmentManager.apply(wiring, () => saveOverrides(all));
    res.json({ ok: true, attachments: desired.attachments, restartRequired: true });
  } catch (err) {
    capabilityError(res, err);
  }
});

app.delete("/api/projects/:name/attachments/:ref", (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  if (req.body?.confirmed !== true) {
    return res.status(400).json({ error: "detach requires an explicit confirmed preview" });
  }
  try {
    const desired = desiredAttachmentChange(project, { remove: req.params.ref });
    const wiring = attachmentManager.plan(project.path, desired.capabilities);
    const preview = attachmentManager.publicPlan(wiring);
    if (req.body?.previewToken !== attachmentPreviewToken(
      project,
      "detach",
      req.params.ref,
      preview,
      desired.attachments,
    )) {
      return res.status(409).json({ error: "detach preview changed; review it again" });
    }
    const all = loadOverrides();
    const next = { ...(all[project.name] || {}) };
    if (desired.attachments.length) next.attachments = desired.attachments;
    else delete next.attachments;
    if (Object.keys(next).length) all[project.name] = next;
    else delete all[project.name];
    attachmentManager.apply(wiring, () => saveOverrides(all));
    res.json({ ok: true, attachments: desired.attachments, restartRequired: true });
  } catch (err) {
    capabilityError(res, err);
  }
});

// Update the human-curated override for one project.
app.patch("/api/projects/:name", (req, res) => {
  const name = req.params.name;
  const all = loadOverrides();
  const current: Override = all[name] || {};
  for (const key of OVERRIDE_KEYS) {
    if (!(key in req.body)) continue;
    const val = req.body[key];
    if (key === "workingOn") {
      if (val === true) {
        current.workingOn = true;
        current.workingOnAt ??= Date.now();
      } else {
        delete current.workingOn;
        delete current.workingOnAt;
      }
      continue;
    }
    // empty string / null clears the override for that field
    if (val === "" || val === null) delete (current as any)[key];
    else (current as any)[key] = val;
  }
  if (Object.keys(current).length) all[name] = current;
  else delete all[name];
  saveOverrides(all);
  res.json({ ok: true, override: all[name] || null });
});

// Regenerate PROJECTS.md from the current merged state.
app.post("/api/export", (_req, res) => {
  const file = writeMarkdown();
  res.json({ ok: true, file });
});

/* ---------- house rules (workspace-wide AI system prompt baseline) ---------- */

app.get("/api/house-rules", (_req, res) => {
  res.json({ content: readGlobalRules() });
});

app.put("/api/house-rules", (req, res) => {
  writeGlobalRules(String(req.body?.content ?? ""));
  res.json({ ok: true });
});

/* the practices catalog (static reference for the UI) */
app.get("/api/practices", (_req, res) => {
  res.json({ practices: PRACTICES });
});

/* per-project rules overlay + adopted practices */
app.get("/api/projects/:name/rules", (req, res) => {
  const project = findProject(String(req.params.name));
  if (!project) return res.status(404).json({ error: "unknown project" });
  const profile = readProfile(project.path);
  res.json({
    rules: readProjectRules(project.path),
    practices: profile.practices,
    suggested: suggestPractices(project.stack ? [project.stack] : []),
    catalog: PRACTICES,
  });
});

app.put("/api/projects/:name/rules", (req, res) => {
  const project = findProject(String(req.params.name));
  if (!project) return res.status(404).json({ error: "unknown project" });
  try {
    writeProjectRules(project.path, String(req.body?.rules ?? ""));
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.put("/api/projects/:name/practices", (req, res) => {
  const project = findProject(String(req.params.name));
  if (!project) return res.status(404).json({ error: "unknown project" });
  const requested = Array.isArray(req.body?.practices) ? req.body.practices.map(String) : [];
  const valid = requested.filter((id: string) => PRACTICES.some((p) => p.id === id));
  try {
    const profile = writeProfile(project.path, valid);
    res.json({ ok: true, practices: profile.practices });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/* ---------- skills used by the agents (mined from Claude Code transcripts) ---------- */

app.get("/api/skills-usage", (req, res) => {
  const name = req.query.project ? String(req.query.project) : "";
  let dir: string | undefined;
  if (name) {
    const project = findProject(name);
    if (!project) return res.status(404).json({ error: "unknown project" });
    dir = project.path;
  }
  res.json({ skills: collectSkillUsage(dir) });
});

/* ---------- create a new project ---------- */

app.post("/api/projects/new", (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  // folder-safe: starts alphanumeric, then letters/digits/._- ; no slashes/traversal
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
    return res.status(400).json({ error: "use letters, digits, dashes or underscores" });

  const root = workspaceRoot(loadConfig());
  const dir = path.join(root, name);
  if (!dir.startsWith(root + path.sep))
    return res.status(400).json({ error: "invalid name" });
  if (fs.existsSync(dir))
    return res.status(409).json({ error: "a folder with that name already exists" });

  fs.mkdirSync(dir, { recursive: true });

  const description = String(req.body?.description ?? "").trim();
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n\n${description || "New project."}\n`);

  // adopt any selected practices (writes .psm/profile.json + scaffolds starter files)
  const requestedPractices = Array.isArray(req.body?.practices)
    ? req.body.practices.map(String).filter((id: string) => PRACTICES.some((p) => p.id === id))
    : [];
  if (requestedPractices.length) {
    try {
      writeProfile(dir, requestedPractices);
    } catch {
      /* scaffolding is best-effort */
    }
  }

  // write the psm-managed house-rules region into CLAUDE.md / AGENTS.md
  if (req.body?.applyHouseRules !== false) {
    try {
      applyManagedRegion(dir);
    } catch {
      /* no rules yet — skip */
    }
  }

  if (req.body?.gitInit !== false) {
    try {
      execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
    } catch {
      /* git not available — the folder is still created */
    }
  }

  if (description) {
    const all = loadOverrides();
    all[name] = { ...(all[name] || {}), description };
    saveOverrides(all);
  }

  res.json({ ok: true, name });
});

/* ---------- cockpit: run a project & stream its logs ---------- */

function findProject(name: string) {
  return getProjects().find((p) => p.name === name);
}

function parseKind(v: unknown): ProcKind {
  return v === "deploy:staging" || v === "deploy:production" ? v : "run";
}

// the command a given process kind should run for a project
function commandForKind(proj: ReturnType<typeof findProject> & {}, kind: ProcKind): string | null {
  if (kind === "deploy:staging") return proj.deployStaging;
  if (kind === "deploy:production") return proj.deployProduction;
  return proj.runCommand;
}

// live status of every managed process (for dashboard "running" dots)
app.get("/api/procs", (_req, res) => {
  res.json({ procs: allProcStates() });
});

function upsertWorkingItem(items: Map<string, any>, name: string) {
  let item = items.get(name);
  if (!item) {
    item = {
      name,
      reasons: [],
      busy: false,
      waiting: false,
      question: null,
      running: false,
      manual: false,
      open: false,
      queueDepth: 0,
      messages: 0,
      lastActive: 0,
      snippet: "",
      engine: null,
      model: null,
      actualModel: null,
    };
    items.set(name, item);
  }
  return item;
}

function workingItems() {
  const items = new Map<string, any>();
  for (const ai of activeSessions()) {
    const item = upsertWorkingItem(items, ai.name);
    Object.assign(item, {
      busy: ai.busy,
      waiting: ai.waiting,
      question: ai.question,
      open: ai.open,
      queueDepth: ai.queueDepth,
      messages: ai.messages,
      lastActive: Math.max(item.lastActive, ai.lastActive || 0),
      snippet: ai.snippet || item.snippet,
      engine: ai.engine,
      model: ai.model,
      actualModel: ai.actualModel,
    });
    if (ai.waiting) item.reasons.push("Needs answer");
    if (ai.busy) item.reasons.push("AI working");
    else if (ai.queueDepth) item.reasons.push("AI queued");
    else if (ai.open) item.reasons.push("AI open");
  }

  for (const proc of activeProcesses()) {
    if (proc.name === WORKSPACE_NAME) continue;
    const item = upsertWorkingItem(items, proc.name);
    item.running = true;
    item.lastActive = Math.max(item.lastActive, proc.startedAt || 0);
    item.snippet ||= proc.command;
    item.reasons.push(proc.kind === "run" ? "running" : proc.kind.replace(":", " "));
  }

  const overrides = loadOverrides();
  for (const [name, o] of Object.entries(overrides)) {
    if (name === WORKSPACE_NAME || !o.workingOn) continue;
    const item = upsertWorkingItem(items, name);
    item.manual = true;
    item.lastActive = Math.max(item.lastActive, o.workingOnAt || 0);
    item.reasons.push("marked");
  }

  return [...items.values()]
    .map((item) => ({ ...item, reasons: [...new Set(item.reasons)] }))
    .sort((a, b) => Number(b.waiting) - Number(a.waiting) || Number(b.busy) - Number(a.busy) || Number(b.running) - Number(a.running) || b.lastActive - a.lastActive || a.name.localeCompare(b.name));
}

// projects currently being worked on — live AI, running process, or manual mark
app.get("/api/sessions", (_req, res) => {
  res.json({ sessions: workingItems() });
});

// Leave the Working on lane completely: clear the human mark and stop live work.
app.post("/api/projects/:name/working/stop", (req, res) => {
  const name = req.params.name;
  const all = loadOverrides();
  const current = all[name];
  const manualCleared = !!current?.workingOn;
  const hasManualOverride = !!current && ("workingOn" in current || "workingOnAt" in current);
  if (current && hasManualOverride) {
    delete current.workingOn;
    delete current.workingOnAt;
    if (Object.keys(current).length) all[name] = current;
    else delete all[name];
    saveOverrides(all);
  }

  const ai = stopAiSession(name);
  const processesStopped = stopAll(name);
  res.json({ ok: true, manualCleared, ai, processesStopped });
});

// current provider usage limit for an engine (so the AI pane can warn upfront)
app.get("/api/ai/limit", (req, res) => {
  res.json({ limit: aiLimit(parseEngine(req.query.engine, "claude")) });
});

app.get("/api/projects/:name/ai/usage", async (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  const force = req.query.refresh === "1";
  const engine = parseEngine(req.query.engine, project.aiEngine);
  const model = typeof req.query.model === "string"
    ? parseModel(req.query.model)
    : project.aiModel;
  res.json(await subscriptionUsage(engine, model, force));
});

// the workspace-wide chat target (its saved engine / full-access defaults)
app.get("/api/workspace", (_req, res) => {
  const o = loadOverrides()[WORKSPACE_NAME] || {};
  res.json({
    name: WORKSPACE_NAME,
    aiEngine: o.aiEngine || "claude",
    aiModel: parseModel(o.aiModel),
    aiFullAccess: !!o.aiFullAccess,
  });
});

// snapshot status for one project+kind
app.get("/api/projects/:name/proc", (req, res) => {
  res.json(procState(req.params.name, parseKind(req.query.kind)));
});

// start the project's run (or deploy) command
app.post("/api/projects/:name/run", (req, res) => {
  const kind = parseKind(req.body?.kind);
  const proj = findProject(req.params.name);
  if (!proj) return res.status(404).json({ error: "unknown project" });
  const command =
    (req.body?.command && String(req.body.command).trim()) || commandForKind(proj, kind);
  if (!command)
    return res.status(400).json({ error: `no ${kind} command set for ${proj.name}` });
  const p = start(proj.name, kind, command, proj.path);
  res.json({ ok: true, status: p.status, command });
});

// stop it
app.post("/api/projects/:name/stop", (req, res) => {
  const stopped = stop(req.params.name, parseKind(req.body?.kind));
  res.json({ ok: true, stopped });
});

// SSE log stream (replays buffer, then live)
app.get("/api/projects/:name/logs/stream", (req, res) => {
  subscribe(res, req.params.name, parseKind(req.query.kind));
});

/* ---------- cockpit: AI pane ---------- */

function parseEngine(v: unknown, fallback: AiEngine): AiEngine {
  return v === "codex" || v === "claude" ? v : fallback;
}

function parseModel(v: unknown, fallback: string | null = null): string | null {
  const model = typeof v === "string" ? v.trim() : "";
  return model || fallback || null;
}

// The AI target: a real project, or the workspace-wide chat (cwd = workspace root).
function aiTarget(name: string) {
  if (name === WORKSPACE_NAME) {
    const o = loadOverrides()[WORKSPACE_NAME] || {};
    return {
      name: WORKSPACE_NAME,
      path: workspaceRoot(loadConfig()),
      aiEngine: (o.aiEngine as AiEngine) || "claude",
      aiModel: parseModel(o.aiModel),
      aiFullAccess: !!o.aiFullAccess,
    };
  }
  return findProject(name);
}

// a compact rundown of every project, so the workspace chat knows what exists
function capabilityRundown(projects: Project[]): string {
  let capabilities: Capability[] = [];
  try {
    capabilities = buildCatalog(projects);
  } catch (err) {
    return (
      "\n\nWorkspace capabilities:\n" +
      `- Catalog unavailable: ${(err as Error).message}`
    );
  }
  if (!capabilities.length) {
    return "\n\nWorkspace capabilities:\n- No reusable capability manifests or candidates found yet.";
  }
  const lines = capabilities.map((capability) => {
    const state = capability.ready ? "ready" : "needs review";
    const provider = capability.providerProject ? `, from ${capability.providerProject}` : "";
    const warnings = capability.warnings.length ? ` Warnings: ${capability.warnings.join(" ")}` : "";
    return `- ${capability.ref} [${capability.kind}, ${capability.source}, ${state}${provider}] — ${capability.summary}${warnings}`;
  });
  return "\n\nWorkspace capabilities:\n" + lines.join("\n");
}

function workspaceRundown(): string {
  const projects = getProjects();
  const lines = projects
    .filter((p) => !p.archived)
    .map(
      (p) =>
        `- ${p.name} [${p.status}${p.stack && p.stack !== "—" ? `, ${p.stack}` : ""}] — ${p.description}`,
    );
  return (
    "You are the workspace-wide assistant for this folder of projects. Each project below is a " +
    "subdirectory you can read and edit. The psm tool (in ./psm) tracks them all and generates " +
    "psm/PROJECTS.md from psm/overrides.json — regenerate it with `npm run build:md` in ./psm " +
    "after anything that changes a project's description or status.\n\nProjects:\n" +
    lines.join("\n") +
    capabilityRundown(projects) +
    "\n\nNew-project brainstorming protocol:\n" +
    "- First check whether the idea belongs inside an existing project or should become a new folder.\n" +
    "- Call out overlapping projects so the user can avoid duplicate apps, APIs, dashboards, or libraries.\n" +
    "- Name reusable workspace pieces: packages, MCP servers, docs, APIs, UI patterns, data stores, run/deploy commands, and attachable capabilities.\n" +
    "- Recommend the smallest scaffold and any psm capability attachments that should be applied after creation.\n" +
    "- Do not create a project or edit files until the user clearly confirms that step."
  );
}

/* ---------- structured implementation plans ---------- */

function planError(res: express.Response, err: unknown) {
  if (err instanceof PlanNotFoundError) return res.status(404).json({ error: err.message });
  if (err instanceof PlanConflictError) return res.status(409).json({ error: err.message });
  if (err instanceof PlanValidationError) return res.status(400).json({ error: err.message });
  console.error("plan operation failed", err);
  return res.status(500).json({ error: "plan operation failed" });
}

function kickoffPrompt(plan: ReturnType<typeof planStore.get> & {}) {
  return (
    "[psm confirmed implementation plan]\n" +
    "Implement this confirmed plan phase by phase. Treat the revision as immutable. Report " +
    "progress using the documented <psm-plan-progress> marker with these exact step ids. Stop " +
    "and ask before materially changing scope.\n\n" +
    JSON.stringify(plan, null, 2)
  );
}

function planningRole(value: unknown): "planner" | "reviewer" {
  return value === "reviewer" ? "reviewer" : "planner";
}

app.get("/api/projects/:name/planner/state", (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  res.json(planningOverview(project.name, project.aiEngine, project.aiModel));
});

app.get("/api/projects/:name/planner/stream", (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).end();
  const role = planningRole(req.query.role);
  const overview = planningOverview(project.name, project.aiEngine, project.aiModel);
  const participant = overview[role];
  subscribeAi(
    res,
    planningSessionKey(project.name, role),
    project.path,
    participant.engine,
    participant.model,
  );
});

app.post("/api/projects/:name/planner/start", (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  const engine = parseEngine(req.body?.engine, project.aiEngine);
  const model = parseModel(req.body?.model, engine === project.aiEngine ? project.aiModel : null);
  const result = startPlanningLoop(
    project.name,
    project.path,
    engine,
    model,
    String(req.body?.brief ?? ""),
  );
  res.status(result.ok ? 202 : 409).json(result);
});

app.post("/api/projects/:name/planner/message", (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  const engine = parseEngine(req.body?.engine, project.aiEngine);
  const model = parseModel(req.body?.model, engine === project.aiEngine ? project.aiModel : null);
  const result = sendPlanningMessage(
    project.name,
    project.path,
    engine,
    model,
    String(req.body?.message ?? ""),
  );
  res.status(result.ok ? 202 : 409).json(result);
});

app.post("/api/projects/:name/planner/question", (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  const role = planningRole(req.body?.role);
  const answers = req.body?.answers && typeof req.body.answers === "object" ? req.body.answers : {};
  const result = aiAnswerQuestion(
    planningSessionKey(project.name, role),
    project.path,
    String(req.body?.requestId ?? ""),
    answers,
    false,
  );
  res.status(result.ok ? 200 : 409).json(result);
});

app.post("/api/projects/:name/planner/cancel", (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  res.json({ ok: true, cancelled: cancelPlanning(project.name) });
});

app.get("/api/projects/:name/plans", (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  try {
    let plans = planStore.list(project.name);
    const overview = planningOverview(project.name, project.aiEngine, project.aiModel);
    if (plans[0]?.status === "reviewing" && !overview.state && !overview.reviewer.busy) {
      planStore.markReviewUnavailable(project.name, plans[0].id, plans[0].revision);
      plans = planStore.list(project.name);
    }
    res.json({ plans, latest: plans[0] ?? null });
  } catch (err) {
    planError(res, err);
  }
});

app.get("/api/projects/:name/plans/:id", (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  try {
    const plan = planStore.get(project.name, req.params.id);
    if (!plan) return res.status(404).json({ error: "plan not found" });
    res.json({ plan });
  } catch (err) {
    planError(res, err);
  }
});

app.put("/api/projects/:name/plans/:id", (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  try {
    const requestReview = req.body?.review !== false;
    let plan = planStore.saveEdited(
      project.name,
      req.params.id,
      req.body?.plan,
      Number(req.body?.expectedRevision),
      requestReview,
    );
    let reviewQueued = false;
    let ai: ReturnType<typeof queuePlanReview> | null = null;
    if (requestReview) {
      ai = queuePlanReview(
        project.name,
        project.path,
        project.aiEngine,
        project.aiModel,
        plan,
      );
      reviewQueued = ai.ok;
      plan = planStore.get(project.name, plan.id) ?? plan;
    }
    res.json({ ok: true, plan, reviewQueued, ai });
  } catch (err) {
    planError(res, err);
  }
});

app.post("/api/projects/:name/plans/:id/confirm", (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  try {
    let plan = planStore.confirm(
      project.name,
      req.params.id,
      Number(req.body?.expectedRevision),
    );
    cancelPlanning(project.name);
    const ai = startFreshAgentSession(
      project.name,
      project.path,
      project.aiEngine,
      project.aiModel,
      kickoffPrompt(plan),
      project.aiFullAccess,
    );
    if (ai.ok) plan = planStore.markStarted(project.name, plan.id);
    res.status(ai.ok ? 200 : 409).json({
      ok: ai.ok,
      plan,
      ai,
      handoff: ai.ok ? { pane: "ai", freshSession: true, engine: project.aiEngine } : null,
    });
  } catch (err) {
    planError(res, err);
  }
});

// transcript stream (replays history, then live)
app.get("/api/projects/:name/ai/stream", (req, res) => {
  const t = aiTarget(req.params.name);
  if (!t) return res.status(404).end();
  const engine = parseEngine(req.query.engine, t.aiEngine);
  subscribeAi(res, t.name, t.path, engine, parseModel(req.query.model, t.aiModel));
});

// send one message to the project's (or workspace's) AI
app.post("/api/projects/:name/ai", (req, res) => {
  const t = aiTarget(req.params.name);
  if (!t) return res.status(404).json({ error: "unknown project" });
  const engine = parseEngine(req.body?.engine, t.aiEngine);
  const model = parseModel(req.body?.model, t.aiModel);
  const fullAccess = req.body?.fullAccess ?? t.aiFullAccess;
  const extra = t.name === WORKSPACE_NAME ? workspaceRundown() : "";
  const r = aiSend(t.name, t.path, engine, model, String(req.body?.message ?? ""), !!fullAccess, extra);
  res.status(r.ok ? 200 : 409).json(r);
});

// answer a structured question and resume the same provider session
app.post("/api/projects/:name/ai/question", (req, res) => {
  const t = aiTarget(req.params.name);
  if (!t) return res.status(404).json({ error: "unknown project" });
  const answers = req.body?.answers && typeof req.body.answers === "object" ? req.body.answers : {};
  const fullAccess = req.body?.fullAccess ?? t.aiFullAccess;
  const extra = t.name === WORKSPACE_NAME ? workspaceRundown() : "";
  const r = aiAnswerQuestion(
    t.name,
    t.path,
    String(req.body?.requestId ?? ""),
    answers,
    !!fullAccess,
    extra,
  );
  res.status(r.ok ? 200 : 409).json(r);
});

// cancel the in-flight turn
app.post("/api/projects/:name/ai/cancel", (req, res) => {
  res.json({ ok: true, cancelled: aiCancel(req.params.name) });
});

app.get("/api/projects/:name/ai/state", (req, res) => {
  const t = aiTarget(req.params.name);
  if (!t) return res.status(404).json({ error: "unknown project" });
  res.json(aiState(t.name, t.aiEngine, t.aiModel));
});

// "where we left off" recap — regenerated only when the transcript has grown
app.get("/api/projects/:name/ai/recap", async (req, res) => {
  try {
    res.json({ summary: await aiRecap(req.params.name) });
  } catch {
    res.json({ summary: null });
  }
});

app.use(express.static(WEB_DIR));

app.listen(PORT, "127.0.0.1", () => {
  console.log(`psm dashboard → http://localhost:${PORT}`);
});

startRuntimeDiscovery();
setTimeout(() => runDueBackups(getProjects()), 30_000).unref();
setInterval(() => runDueBackups(getProjects()), 60 * 60 * 1000).unref();
