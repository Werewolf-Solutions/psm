import { RepositoryTools } from "./agent-repository-tools.ts";
import { databaseFile } from "./db.ts";
import { AgentPermissionStore, agentPermissionRouter, reviewAgentPermissions, PREPARATION_OPERATIONS, PermissionError, type PermissionProject } from "./agent-permissions.ts";
import express from "express";
import type { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getProjects, writeMarkdown } from "../index.ts";
import { loadOverrides, saveOverrides } from "../classify.ts";
import { loadConfig, workspaceRoot } from "../scan.ts";
import { LinkError, addLink, describeLinks, removeLink } from "../links.ts";
import { acceptsPairedOrigins, describeMode, psmMode, scansImplicitly } from "../mode.ts";
import { ensureProjectId } from "../identity.ts";
import { APP_VERSION } from "../version.ts";
import { STATUS_META } from "../render.ts";
import type { Attachment, Capability, Override, Project } from "../types.ts";
import { MAX_LOG_LINES, activeProcesses, allProcStates, procState, start, stop, stopAll, subscribe, transcript, type ProcKind } from "./procs.ts";
import {
  activeSessions,
  configureManagedAgents,
  stopProjectAgents,
  aiLimit,
  clearLimit,
  aiState,
  answerQuestion as aiAnswerQuestion,
  cancel as aiCancel,
  cancelPlanning,
  permittedFullAccess,
  resolveExtraDirs,
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
import { repoStatus, repoStatuses } from "./git.ts";
import {
  WorkSessionNotFoundError,
  WorkSessionValidationError,
  workSessionKey,
  workSessions,
  type WorkSession,
} from "./work-sessions.ts";
import {
  buildCatalog,
  CatalogValidationError,
  findCapability,
  prepareCustomCapability,
  saveCustomCapability,
} from "./catalog.ts";
import { PlanConflictError, PlanNotFoundError, PlanValidationError, planStore } from "./plans.ts";
import { NOTE_KINDS, NoteNotFoundError, NoteValidationError, noteStore } from "./notes.ts";
import { ensurePreviewProxy } from "./preview.ts";
import { BrowseError, browse } from "./browse.ts";
import { StopError, machineProcesses, stopProcess } from "./machine.ts";
import {
  agentGuard,
  agentIdentity,
  agentSecret,
  hostedOrigins,
  isLoopbackHost,
  rotateAgentToken,
} from "./agent.ts";
import {
  AuthError,
  currentUser,
  deviceFingerprint,
  exchangeCode,
  sessionContext,
  signOut,
} from "./session.ts";
import { ssoAvailability, ssoConfig, ssoRedirectUri } from "./sso.ts";
import { runWithSession } from "../store.ts";
import { subscriptionUsage } from "./usage.ts";
import { modelCatalog } from "./models.ts";
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
  billingPortal as cloudBillingPortal,
  checkout as cloudCheckout,
  cloudAvailable,
  devices as cloudDevices,
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
import { createDeploymentRouter } from "./deploy/api.ts";
import { GitHubArtifactPreparer } from "./deploy/artifact-preparer.ts";
import { SecretBroker } from "./deploy/connections.ts";
import { createDeploymentEngine } from "./deploy/engine.ts";
import { defaultDeploymentAdapters } from "./deploy/executors.ts";
import { defaultDeploymentSecretBackend } from "./deploy/keyring.ts";
import { DeploymentPreparationController } from "./deploy/make-ready.ts";
import { WorkroomPreparationRepairer } from "./deploy/repair-sessions.ts";
import { DeploymentRuntimeAdapters } from "./deploy/runtime-adapters.ts";
import { deploymentFingerprintKey, DeploymentSecretGenerationStore } from "./deploy/secrets.ts";
import { deploymentStore } from "./deploy/store.ts";
import { DeploymentStreamTicketRegistry } from "./deploy/stream-tickets.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "..", "..", "web");
const PORT = Number(process.env.PORT || 4317);

const app = express();
app.disable("x-powered-by");
const deploymentStreamTickets = new DeploymentStreamTicketRegistry();

/**
 * The whole API. psm always has a machine under it now — the hosted posture was
 * retired in favour of a static site (src/mode.ts) — so there is no longer a
 * build of psm that must not reach a shell, and everything is mounted.
 *
 * What guards the shell is the boundary in server/agent.ts: loopback is trusted,
 * and exactly one paired origin may cross it with a token.
 */
const local = express.Router();

app.use(agentGuard({
  publicPaths: ["/api/agent"],
  shortLivedQueryTicket: (request) => deploymentStreamTickets.validateRequest(request, agentSecret().createdAt),
}));
app.use(express.json({ limit: "2mb" }));

// Resolve the signed-in session once per request and carry its Werewolf token,
// so cloud calls act on the owner's behalf without keeping a session of their own.
app.use((_req, _res, next) => {
  sessionContext()
    .then(({ accessToken }) => runWithSession(accessToken, next))
    .catch(() => runWithSession(null, next));
});

/* ---- Sign in with Werewolf (authorization code + PKCE) ----
 * The browser runs the flow — the same web/auth.js the hosted page runs, against
 * the one `psm` application row. It comes back to /auth/callback (served by the
 * SPA fallback below) and posts the code here, because dapp hands a web client
 * its refresh credential as a cookie and a page on localhost cannot keep one.
 */
app.post("/api/auth/exchange", async (req, res) => {
  try {
    const { user } = await exchangeCode({
      code: String(req.body?.code || ""),
      codeVerifier: String(req.body?.codeVerifier || ""),
      // The page reports the callback it actually used; dapp exact-matches it
      // against the code it minted, so a mismatch is refused there.
      redirectUri: String(req.body?.redirectUri || ssoRedirectUri(req)),
      device: {
        id: deviceFingerprint(String(req.headers["user-agent"] || "psm")),
        name: "psm",
        platform: String(req.headers["user-agent"] || "web").slice(0, 80),
      },
    });
    res.json({ ok: true, user });
  } catch (err) {
    const error = err as AuthError;
    res.status(error.status || 400).json({ error: error.message || "Sign-in failed" });
  }
});

app.post("/api/auth/logout", async (_req, res) => {
  await signOut().catch(() => undefined);
  res.json({ ok: true });
});

/**
 * What this psm is, and what it is currently serving as the page.
 *
 * `web/` has no build step and no hashed filenames, so a cockpit left open in a
 * tab keeps running whatever JavaScript it loaded — across restarts, across
 * upgrades, across an edit made thirty seconds ago. That page then calls routes
 * this build may no longer have. The fingerprint is a stat of the files served,
 * so the page can notice it has gone stale and offer a reload rather than
 * failing at whichever button is pressed first.
 */
const WEB_ASSETS = ["index.html", "app.js", "auth.js", "agent.js", "cloud.js", "deployment-connections.js", "styles.css"];

function webAssetVersion(): string {
  const parts: string[] = [];
  for (const name of WEB_ASSETS) {
    try {
      const stat = fs.statSync(path.join(WEB_DIR, name));
      parts.push(`${name}:${stat.size}:${Math.round(stat.mtimeMs)}`);
    } catch {
      parts.push(`${name}:missing`);
    }
  }
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

app.get("/api/version", (_req, res) => {
  res.json({ version: APP_VERSION, assets: webAssetVersion() });
});

/**
 * Who am I — the cockpit asks this on load, and it doubles as the page's sign-in
 * configuration. The page cannot work out where a *local* dapp's consent screen
 * is (Vite's port moves), so the machine tells it.
 */
app.get("/api/auth/session", async (req, res) => {
  // Never 401s: "nobody" is a valid answer, and the usual one for a fresh cockpit.
  const user = await currentUser().catch(() => null);
  // Signed in, the handoff is moot; signed out, the panel needs to know whether
  // offering it would only lead to a dead end, and say why if it would.
  const sso = user
    ? { available: true }
    : await ssoAvailability(req).catch(() => ({ available: false, reason: "Could not reach Werewolf." }));
  const dapp = await ssoConfig(req).catch(() => null);
  res.json({ user, provider: "werewolf", sso, dapp });
});

/* ---------- agent identity + pairing ---------- */

/** True when the caller is the local cockpit rather than a paired remote origin. */
function localRequest(req: express.Request): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin navigations send no Origin
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

// Discovery: a hosted page fetches this to find out whether an agent is running
// on this machine. Public by design, and deliberately says nothing about
// projects — only that psm is here and what version it is.
local.get("/api/agent", (_req, res) => {
  res.json({ ...agentIdentity(), pairingRequired: acceptsPairedOrigins() });
});

// The token itself is loopback-only: the local cockpit shows it so the user can
// paste it into the hosted page. A paired origin can never read it back.
local.get("/api/agent/token", (req, res) => {
  if (!localRequest(req)) return res.status(403).json({ error: "read the pairing token from the local cockpit" });
  const secret = agentSecret();
  res.json({ token: secret.token, createdAt: secret.createdAt, origins: hostedOrigins() });
});

local.post("/api/agent/token/rotate", (req, res) => {
  if (!localRequest(req)) return res.status(403).json({ error: "rotate the pairing token from the local cockpit" });
  const secret = rotateAgentToken();
  res.json({ ok: true, token: secret.token, createdAt: secret.createdAt });
});

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
  "aiEffort",
  "aiFullAccess",
  "aiExtraProjects",
];

/** How many other projects one AI may be pointed at. A guard, not a design. */
const MAX_EXTRA_PROJECTS = 8;

app.get("/api/projects", (_req, res) => {
  // version rides along on the dashboard's bootstrap payload — psm has no build
  // step, so the footer reads it from here rather than from a baked-in constant.
  // The mode rides along too: the dashboard shows a different empty state when
  // nothing is scanned implicitly, and hides what this posture cannot do.
  res.json({
    projects: getProjects(),
    statusMeta: STATUS_META,
    version: APP_VERSION,
    mode: psmMode(),
    capabilities: { runsCommands: true, scansImplicitly: scansImplicitly(), canLink: true },
  });
});

/* ---------- linked sources ---------- */

// What psm is looking at. In dev this includes the configured workspace root,
// flagged `implicit` so the UI does not offer to unlink something it cannot.
app.get("/api/links", (_req, res) => {
  res.json({ mode: psmMode(), canLink: true, links: describeLinks(loadConfig()) });
});

app.post("/api/links", (req, res) => {
  const kind = String(req.body?.kind ?? "");
  if (kind !== "workspace" && kind !== "project")
    return res.status(400).json({ error: "kind must be 'workspace' or 'project'" });
  try {
    const link = addLink(kind, String(req.body?.path ?? ""), req.body?.label);
    res.json({ ok: true, link, links: describeLinks(loadConfig()) });
  } catch (err) {
    if (err instanceof LinkError) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: (err as Error).message || "could not link that folder" });
  }
});

app.delete("/api/links/:id", (req, res) => {
  const removed = removeLink(req.params.id);
  res.status(removed ? 200 : 404).json({
    ok: removed,
    ...(removed ? { links: describeLinks(loadConfig()) } : { error: "no such link" }),
  });
});

/* ---------- what is running on this machine ----------
 * psm knows about the processes it started; this is about the ones it did not —
 * yesterday's dev server still holding 5173 so today's climbs to 5176. Local
 * modes only: a hosted psm has no machine to look at.
 * -------------------------------------------------------------------------- */

// project roots, so a process's cwd can be named rather than just shown
const machineRoots = () =>
  getProjects().map((project) => ({
    name: project.name,
    path: project.path,
    // so a dead dev server can still say which port it was meant to serve
    port: project.port ?? null,
  }));

local.get("/api/machine/processes", (_req, res) => {
  try {
    res.json({ processes: machineProcesses({ roots: machineRoots() }) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message || "could not read the process list" });
  }
});

local.post("/api/machine/processes/:pid/stop", (req, res) => {
  try {
    res.json(stopProcess(Number(req.params.pid), req.body?.force === true));
  } catch (err) {
    if (err instanceof StopError) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: (err as Error).message || "could not stop that process" });
  }
});

// Read-only directory listing for the link picker.
local.get("/api/fs/browse", (req, res) => {
  try {
    res.json(browse(typeof req.query.path === "string" ? req.query.path : undefined));
  } catch (err) {
    if (err instanceof BrowseError) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: (err as Error).message || "could not read that folder" });
  }
});

local.get("/api/runtime/services", async (req, res) => {
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
  "workingOn", "workingOnAt", "archived", "note", "port", "aiEngine", "aiModel", "aiEffort",
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

local.get("/api/catalog", (_req, res) => {
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

local.post("/api/catalog/custom/preview", (req, res) => {
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

local.post("/api/catalog/custom", (req, res) => {
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

local.post("/api/projects/:name/attachments/preview", (req, res) => {
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

local.post("/api/projects/:name/attachments", (req, res) => {
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

local.delete("/api/projects/:name/attachments/:ref", (req, res) => {
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
local.patch("/api/projects/:name", (req, res) => {
  const name = req.params.name;
  // An override only means something for a target that exists. Without this a
  // caller that PATCHes an unset name writes a permanent entry — one called
  // "null" turned up in overrides.json this way — that no project ever claims
  // and nothing ever cleans up. `__workspace__` is not a scanned project but is
  // a real target: it holds the workspace chat's engine settings.
  if (name !== WORKSPACE_NAME && !findProject(name)) {
    return res.status(404).json({ error: `no project named ${name}` });
  }
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
    if (key === "aiExtraProjects") {
      // Names of other projects, never paths: psm resolves them itself before
      // every turn. An unknown name is dropped here rather than saved and
      // silently ignored later, so what the drawer shows back is what is real.
      const known = new Set(getProjects().map((project) => project.name));
      const chosen = (Array.isArray(val) ? val : [])
        .map((entry: unknown) => String(entry ?? "").trim())
        .filter((entry: string) => entry && entry !== name && known.has(entry));
      const unique = [...new Set(chosen)].slice(0, MAX_EXTRA_PROJECTS);
      if (unique.length) current.aiExtraProjects = unique;
      else delete current.aiExtraProjects;
      continue;
    }
    // empty string / null clears the override for that field
    if (val === "" || val === null) delete (current as any)[key];
    else (current as any)[key] = val;
  }
  if (Object.keys(current).length) all[name] = current;
  else delete all[name];
  saveOverrides(all);
  if (req.body?.aiExtraProjects !== undefined || req.body?.aiEngine !== undefined) stopAiSession(name);
  res.json({ ok: true, override: all[name] || null });
});

// Assign a stable id to a project (writes <project>/.psm/identity.json). Idempotent:
// a project that already has an id keeps it.
local.post("/api/projects/:name/id", (req, res) => {
  const project = findProject(String(req.params.name));
  if (!project) return res.status(404).json({ error: "unknown project" });
  try {
    const identity = ensureProjectId(project.path, project.name);
    res.json({ ok: true, id: identity.id, createdAt: identity.createdAt });
  } catch (err) {
    res.status(500).json({ error: `could not assign an id: ${(err as Error).message}` });
  }
});

// Regenerate PROJECTS.md from the current merged state.
local.post("/api/export", (_req, res) => {
  const file = writeMarkdown();
  res.json({ ok: true, file });
});

/* ---------- house rules (workspace-wide AI system prompt baseline) ---------- */

local.get("/api/house-rules", (_req, res) => {
  res.json({ content: readGlobalRules() });
});

local.put("/api/house-rules", (req, res) => {
  writeGlobalRules(String(req.body?.content ?? ""));
  res.json({ ok: true });
});

/* the practices catalog (static reference for the UI) */
local.get("/api/practices", (_req, res) => {
  res.json({ practices: PRACTICES });
});

/* per-project rules overlay + adopted practices */
local.get("/api/projects/:name/rules", (req, res) => {
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

local.put("/api/projects/:name/rules", (req, res) => {
  const project = findProject(String(req.params.name));
  if (!project) return res.status(404).json({ error: "unknown project" });
  try {
    writeProjectRules(project.path, String(req.body?.rules ?? ""));
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

local.put("/api/projects/:name/practices", (req, res) => {
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

local.get("/api/skills-usage", (req, res) => {
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

/**
 * Where a new project folder goes. Dev has the configured workspace root; agent
 * mode has only what was linked, so a directory-of-projects link is required —
 * a single-project link is not somewhere new projects can be created.
 */
function newProjectRoot(linkId?: unknown): string {
  const links = describeLinks(loadConfig()).filter((link) => link.kind === "workspace" && link.exists);
  if (linkId) {
    const chosen = links.find((link) => link.id === String(linkId));
    if (!chosen) throw new Error("that linked folder is not available");
    return chosen.path;
  }
  if (scansImplicitly()) return workspaceRoot(loadConfig());
  if (!links.length)
    throw new Error("link a directory of projects first — new projects need somewhere to live");
  return links[0].path;
}

local.post("/api/projects/new", (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  // folder-safe: starts alphanumeric, then letters/digits/._- ; no slashes/traversal
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
    return res.status(400).json({ error: "use letters, digits, dashes or underscores" });

  let root: string;
  try {
    root = newProjectRoot(req.body?.linkId);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
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
local.get("/api/procs", (_req, res) => {
  res.json({ procs: allProcStates() });
});

function upsertWorkingItem(items: Map<string, any>, name: string) {
  let item = items.get(name);
  if (!item) {
    item = {
      name,
      kind: "project" as "project" | "work",
      id: null as string | null,
      projects: [] as string[],
      ready: true,
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
      effort: null,
      actualModel: null,
    };
    items.set(name, item);
  }
  return item;
}

/** Open workrooms, or none if the database cannot be read — the lane still renders. */
function openWorkrooms(): WorkSession[] {
  try {
    return workSessions.list();
  } catch {
    return [];
  }
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
      effort: ai.effort,
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

  // Every open workroom, whether or not its AI is mid-turn. A room is not a
  // project and has no card on the board, so this lane is the only place it
  // appears — leaving it out until it was busy meant closing one lost it behind
  // a dialog, which is exactly what a room is not for.
  for (const room of openWorkrooms()) {
    const key = workSessionKey(room.id);
    const ai = aiState(key, parseEngine(room.engine, "claude"), room.model, room.effort);
    const item = upsertWorkingItem(items, `work:${room.id}`);
    const missing = room.projects.filter((project) => !findProject(project));
    Object.assign(item, {
      kind: "work",
      id: room.id,
      name: room.title,
      projects: room.projects,
      ready: !missing.length,
      busy: ai.busy,
      waiting: !!ai.question,
      question: ai.question,
      queueDepth: ai.queueDepth,
      messages: ai.messages,
      lastActive: Math.max(ai.lastActive || 0, room.updatedAt),
      snippet: ai.lastUser || room.objective || room.projects.join(" · "),
      engine: ai.engine,
      model: ai.model,
      effort: ai.effort,
      actualModel: ai.actualModel,
    });
    if (missing.length) item.reasons.push(`missing ${missing.join(", ")}`);
    if (ai.question) item.reasons.push("Needs answer");
    if (ai.busy) item.reasons.push("AI working");
    else if (ai.queueDepth) item.reasons.push("AI queued");
    else item.reasons.push(`${room.projects.length} projects`);
  }

  return [...items.values()]
    .map((item) => ({ ...item, reasons: [...new Set(item.reasons)] }))
    .sort((a, b) => Number(b.waiting) - Number(a.waiting) || Number(b.busy) - Number(a.busy) || Number(b.running) - Number(a.running) || b.lastActive - a.lastActive || a.name.localeCompare(b.name));
}

// projects currently being worked on — live AI, running process, or manual mark
local.get("/api/sessions", (_req, res) => {
  res.json({ sessions: workingItems() });
});

// Leave the Working on lane completely: clear the human mark and stop live work.
local.post("/api/projects/:name/working/stop", (req, res) => {
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
// let the user dismiss a limit psm recorded — see clearLimit()
local.delete("/api/ai/limit", (req, res) => {
  const engine = parseEngine(req.query.engine, "claude");
  res.json({ ok: true, cleared: clearLimit(engine) });
});

local.get("/api/ai/limit", (req, res) => {
  // the model matters: a limit on a window that does not govern it is advisory
  const engine = parseEngine(req.query.engine, "claude");
  res.json({ limit: aiLimit(engine, parseModel(req.query.model)) });
});

local.get("/api/projects/:name/ai/usage", async (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  const force = req.query.refresh === "1";
  const engine = parseEngine(req.query.engine, project.aiEngine);
  const model = typeof req.query.model === "string"
    ? parseModel(req.query.model)
    : project.aiModel;
  res.json(await subscriptionUsage(engine, model, force));
});

// Always ask the installed CLI for its current catalog. Model availability can
// change independently of psm releases and may be scoped by account or policy.
local.get("/api/projects/:name/ai/models", async (req, res) => {
  const target = aiTarget(req.params.name);
  if (!target) return res.status(404).json({ error: "unknown project" });
  const engine = parseEngine(req.query.engine, target.aiEngine);
  res.setHeader("Cache-Control", "no-store");
  res.json(await modelCatalog(engine, target.path));
});

// the workspace-wide chat target (its saved engine / full-access defaults)
local.get("/api/workspace", (_req, res) => {
  const o = loadOverrides()[WORKSPACE_NAME] || {};
  res.json({
    name: WORKSPACE_NAME,
    aiEngine: o.aiEngine || "claude",
    aiModel: parseModel(o.aiModel),
    aiEffort: parseEffort(o.aiEffort),
    aiFullAccess: !!o.aiFullAccess,
  });
});

// Dev mode: hand back a loopback port that mirrors the project's dev server with
// the inspector injected, so clicks inside the preview can be turned into notes.
local.get("/api/projects/:name/preview", async (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  const port = Number(req.query.port) || project.port;
  if (!port) return res.status(400).json({ error: `no web port set for ${project.name}` });
  try {
    const proxyPort = await ensurePreviewProxy(port);
    res.json({ ok: true, target: port, port: proxyPort, url: `http://localhost:${proxyPort}/` });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message || "could not start the preview proxy" });
  }
});

// snapshot status for one project+kind
local.get("/api/projects/:name/proc", (req, res) => {
  res.json(procState(req.params.name, parseKind(req.query.kind)));
});

// start the project's run (or deploy) command
local.post("/api/projects/:name/run", (req, res) => {
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
local.post("/api/projects/:name/stop", (req, res) => {
  const stopped = stop(req.params.name, parseKind(req.body?.kind));
  res.json({ ok: true, stopped });
});

// SSE log stream (replays buffer, then live)
local.get("/api/projects/:name/logs/stream", (req, res) => {
  subscribe(res, req.params.name, parseKind(req.query.kind));
});

/* The whole transcript since the process started, as a file. The console shows
 * a window of the most recent lines; this is how you get the rest — the boot
 * output a chatty dev server has long since pushed out of view. */
local.get("/api/projects/:name/logs/download", (req, res) => {
  const kind = parseKind(req.query.kind);
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  const log = transcript(project.name, kind);
  if (!log) return res.status(404).json({ error: `no ${kind} log for ${project.name} yet` });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = `${project.name}-${kind.replace(":", "-")}-${stamp}.log`;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${file}"`);
  // Says so when the transcript is the capped in-memory buffer rather than the
  // file, so nobody reads a truncated log as a complete one.
  res.send(
    log.complete
      ? log.text
      : `[psm] older lines are not available — this is the last ${MAX_LOG_LINES} buffered lines\n${log.text}`,
  );
});

/* ---------- cockpit: AI pane ---------- */

function parseEngine(v: unknown, fallback: AiEngine): AiEngine {
  return v === "codex" || v === "claude" ? v : fallback;
}

// A supplied-but-empty model/effort means "use the provider's default", which is
// a real choice and not the same as saying nothing. Only an absent field (not a
// string at all) falls back to what the project last saved — otherwise clearing
// the model when switching engines would silently re-inherit the old one.
function parseModel(v: unknown, fallback: string | null = null): string | null {
  if (typeof v !== "string") return fallback || null;
  return v.trim() || null;
}

function parseEffort(v: unknown, fallback: string | null = null): string | null {
  if (typeof v !== "string") return fallback || null;
  const effort = v.trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,31}$/.test(effort) ? effort : null;
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
      aiEffort: parseEffort(o.aiEffort),
      aiFullAccess: !!o.aiFullAccess,
      aiExtraProjects: [] as string[], // the workspace chat already sees everything
    };
  }
  return findProject(name);
}

/**
 * The other directories this target's AI may work in.
 *
 * The browser chooses projects by name; the paths are looked up here, on every
 * turn, from the current scan. A project that has been renamed, unlinked or
 * deleted since the choice was made simply is not found, so the scope narrows
 * on its own rather than pointing the CLI at whatever now sits at a
 * remembered path. `resolveExtraDirs` then has the last word on symlinks,
 * nesting and duplicates.
 */
function extraDirsFor(target: { name: string; path: string; aiExtraProjects?: string[] }): string[] {
  const names = target.aiExtraProjects ?? [];
  if (!names.length) return [];
  const paths = names
    .map((projectName) => findProject(projectName)?.path)
    .filter((dir): dir is string => !!dir);
  return resolveExtraDirs(target.path, paths);
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

local.get("/api/projects/:name/planner/state", (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  res.json(planningOverview(project.name, project.aiEngine, project.aiModel, project.aiEffort));
});

local.get("/api/projects/:name/planner/stream", (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).end();
  const role = planningRole(req.query.role);
  const overview = planningOverview(project.name, project.aiEngine, project.aiModel, project.aiEffort);
  const participant = overview[role];
  subscribeAi(
    res,
    planningSessionKey(project.name, role),
    project.path,
    participant.engine,
    participant.model,
    participant.effort,
  );
});

local.post("/api/projects/:name/planner/start", (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  const engine = parseEngine(req.body?.engine, project.aiEngine);
  const model = parseModel(req.body?.model, engine === project.aiEngine ? project.aiModel : null);
  const effort = parseEffort(req.body?.effort, engine === project.aiEngine ? project.aiEffort : null);
  const result = startPlanningLoop(
    project.name,
    project.path,
    engine,
    model,
    effort,
    String(req.body?.brief ?? ""),
  );
  res.status(result.ok ? 202 : 409).json(result);
});

local.post("/api/projects/:name/planner/message", (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  const engine = parseEngine(req.body?.engine, project.aiEngine);
  const model = parseModel(req.body?.model, engine === project.aiEngine ? project.aiModel : null);
  const effort = parseEffort(req.body?.effort, engine === project.aiEngine ? project.aiEffort : null);
  const result = sendPlanningMessage(
    project.name,
    project.path,
    engine,
    model,
    effort,
    String(req.body?.message ?? ""),
  );
  res.status(result.ok ? 202 : 409).json(result);
});

local.post("/api/projects/:name/planner/question", (req, res) => {
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

local.post("/api/projects/:name/planner/cancel", (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  res.json({ ok: true, cancelled: cancelPlanning(project.name) });
});

/* ---------- project notes ----------
 * The scratchpad beside each project: bugs and todos, features, ideas. Local
 * files, so writing one never waits on a network or a cloud session.
 */
function noteError(res: express.Response, err: unknown) {
  if (err instanceof NoteNotFoundError) return res.status(404).json({ error: err.message });
  if (err instanceof NoteValidationError) return res.status(400).json({ error: err.message });
  console.error("note operation failed", err);
  return res.status(500).json({ error: "note operation failed" });
}

local.get("/api/projects/:name/notes", (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  try {
    res.json({ project: project.name, kinds: NOTE_KINDS, notes: noteStore.list(project.name) });
  } catch (err) {
    noteError(res, err);
  }
});

local.post("/api/projects/:name/notes", (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  try {
    res.status(201).json({ ok: true, note: noteStore.create(project.name, req.body) });
  } catch (err) {
    noteError(res, err);
  }
});

local.patch("/api/projects/:name/notes/:id", (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  try {
    res.json({ ok: true, note: noteStore.update(project.name, req.params.id, req.body) });
  } catch (err) {
    noteError(res, err);
  }
});

local.delete("/api/projects/:name/notes/:id", (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  try {
    noteStore.remove(project.name, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    noteError(res, err);
  }
});

local.get("/api/projects/:name/plans", (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  try {
    let plans = planStore.list(project.name);
    const overview = planningOverview(project.name, project.aiEngine, project.aiModel, project.aiEffort);
    if (plans[0]?.status === "reviewing" && !overview.state && !overview.reviewer.busy) {
      planStore.markReviewUnavailable(project.name, plans[0].id, plans[0].revision);
      plans = planStore.list(project.name);
    }
    res.json({ plans, latest: plans[0] ?? null });
  } catch (err) {
    planError(res, err);
  }
});

local.get("/api/projects/:name/plans/:id", (req, res) => {
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

local.put("/api/projects/:name/plans/:id", (req, res) => {
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
        project.aiEffort,
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

local.post("/api/projects/:name/plans/:id/confirm", (req, res) => {
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
      project.aiEffort,
      kickoffPrompt(plan),
      project.aiFullAccess,
      extraDirsFor(project),
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

/**
 * One AI conversation, described in the terms the AI module needs.
 *
 * A project and a workroom differ in what they resolve to — one directory or
 * several, a saved full-access setting or none at all — and in nothing else.
 * Describing both as this lets the six AI endpoints be written once instead of
 * twice, which matters more than it sounds: they are where authority is decided,
 * and a second copy is a second place for the two to drift apart.
 */
interface AiConversation {
  name: string; // session key
  path: string; // where the CLI starts
  engine: AiEngine;
  model: string | null;
  effort: string | null;
  fullAccess: boolean; // the ceiling, before the request is allowed to lower it
  extraDirs: string[];
  extraContext: string;
  onTurn?: () => void;
}

class AiTargetError extends Error {
  constructor(message: string, readonly status = 404) {
    super(message);
  }
}

function projectConversation(name: string): AiConversation {
  const t = aiTarget(name);
  if (!t) throw new AiTargetError("unknown project");
  return {
    name: t.name,
    path: t.path,
    engine: t.aiEngine,
    model: t.aiModel,
    effort: t.aiEffort,
    fullAccess: !!t.aiFullAccess,
    extraDirs: extraDirsFor(t),
    extraContext: t.name === WORKSPACE_NAME ? workspaceRundown() : "",
  };
}

/**
 * A workroom's conversation.
 *
 * Every member is resolved from the current scan on every turn. A member that
 * has gone — renamed, unlinked, deleted — stops the room rather than quietly
 * shrinking its scope, because the whole point of the room is that the change
 * lands on both sides: half of it is worse than none.
 *
 * Full access is not offered. A workroom's promise is that these repositories
 * and no others are writable, and the flag that turns the sandbox off would make
 * that promise false.
 */
function workroomConversation(id: string): AiConversation {
  const room = workSessions.get(id);
  const missing = room.projects.filter((project) => !findProject(project));
  if (missing.length) {
    throw new AiTargetError(
      `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} no longer in the workspace — ` +
        "this workroom cannot run until it is back",
      409,
    );
  }
  const paths = room.projects.map((project) => findProject(project)!.path);
  return {
    name: workSessionKey(room.id),
    path: paths[0],
    engine: parseEngine(room.engine, "claude"),
    model: room.model,
    effort: room.effort,
    fullAccess: false,
    extraDirs: resolveExtraDirs(paths[0], paths.slice(1)),
    extraContext: workroomContext(room),
    onTurn: () => workSessions.touch(room.id),
  };
}

/** What the room is for, and who is in it — said once, at the top of the thread. */
function workroomContext(room: WorkSession): string {
  const lines = [
    `You are working in a psm workroom: "${room.title}".`,
    "",
    "It spans these projects, and the first is where you start:",
    ...room.projects.map((project, index) => {
      const found = findProject(project);
      const role = index === 0 ? "primary" : "member";
      return `- ${project} (${role}) — ${found?.path ?? "path unresolved"}${
        found?.description ? `\n  ${found.description}` : ""
      }`;
    }),
  ];
  if (room.objective) lines.push("", `The objective: ${room.objective}`);
  lines.push(
    "",
    "Treat them as one piece of work. A change to an interface on one side needs the other " +
      "side changed in the same turn, and each repository's own checks run inside that " +
      "repository. Do not report the work as done while one side is left inconsistent.",
  );
  return lines.join("\n");
}

/**
 * The AI endpoints, mounted once per kind of conversation.
 *
 * `resolve` is given the request and returns the conversation it is about, or
 * throws an `AiTargetError` explaining why there is not one.
 */
function mountAiRoutes(base: string, resolve: (req: Request) => AiConversation): void {
  const guard = (res: Response, err: unknown): void => {
    if (err instanceof AiTargetError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err instanceof WorkSessionNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    res.status(400).json({ error: (err as Error).message || "could not resolve that AI target" });
  };

  // transcript stream (replays history, then live)
  local.get(`${base}/ai/stream`, (req, res) => {
    let t: AiConversation;
    try {
      t = resolve(req);
    } catch {
      return res.status(404).end();
    }
    const engine = parseEngine(req.query.engine, t.engine);
    const model = parseModel(req.query.model, t.model);
    const effort = parseEffort(req.query.effort, t.effort);
    subscribeAi(res, t.name, t.path, engine, model, effort, t.extraDirs);
  });

  // send one message
  local.post(`${base}/ai`, (req, res) => {
    let t: AiConversation;
    try {
      t = resolve(req);
    } catch (err) {
      return guard(res, err);
    }
    const engine = parseEngine(req.body?.engine, t.engine);
    const model = parseModel(req.body?.model, t.model);
    const effort = parseEffort(req.body?.effort, t.effort);
    const fullAccess = permittedFullAccess(t.fullAccess, req.body?.fullAccess);
    const r = aiSend(
      t.name,
      t.path,
      engine,
      model,
      effort,
      String(req.body?.message ?? ""),
      fullAccess,
      t.extraContext,
      t.extraDirs,
    );
    if (r.ok) t.onTurn?.();
    res.status(r.ok ? 200 : 409).json(r);
  });

  // answer a structured question and resume the same provider session
  local.post(`${base}/ai/question`, (req, res) => {
    let t: AiConversation;
    try {
      t = resolve(req);
    } catch (err) {
      return guard(res, err);
    }
    const answers = req.body?.answers && typeof req.body.answers === "object" ? req.body.answers : {};
    const fullAccess = permittedFullAccess(t.fullAccess, req.body?.fullAccess);
    const r = aiAnswerQuestion(
      t.name,
      t.path,
      String(req.body?.requestId ?? ""),
      answers,
      fullAccess,
      t.extraContext,
    );
    res.status(r.ok ? 200 : 409).json(r);
  });

  // cancel the in-flight turn
  local.post(`${base}/ai/cancel`, (req, res) => {
    let t: AiConversation;
    try {
      t = resolve(req);
    } catch (err) {
      return guard(res, err);
    }
    res.json({ ok: true, cancelled: aiCancel(t.name) });
  });

  local.get(`${base}/ai/state`, (req, res) => {
    let t: AiConversation;
    try {
      t = resolve(req);
    } catch (err) {
      return guard(res, err);
    }
    res.json(aiState(t.name, t.engine, t.model, t.effort));
  });

  // "where we left off" recap — regenerated only when the transcript has grown
  local.get(`${base}/ai/recap`, async (req, res) => {
    let t: AiConversation;
    try {
      t = resolve(req);
    } catch (err) {
      return guard(res, err);
    }
    try {
      res.json({ summary: await aiRecap(t.name) });
    } catch {
      res.json({ summary: null });
    }
  });
}

mountAiRoutes("/api/projects/:name", (req) => projectConversation(req.params.name));
mountAiRoutes("/api/work-sessions/:id", (req) => workroomConversation(req.params.id));

/* ---------- git: what has changed, per repository ---------- */

// One project's checkout.
local.get("/api/projects/:name/git", async (req, res) => {
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  res.json({ repos: [await repoStatus(project.name, project.path)] });
});

// Every member of a workroom, in the room's own order — the primary first, so
// the pane reads the way the room does. A member psm can no longer find is
// reported as absent rather than skipped: a room missing a repository is
// something to see here, since it is also why sending is blocked.
local.get("/api/work-sessions/:id/git", async (req, res) => {
  try {
    const room = workSessions.get(req.params.id);
    const repos = room.projects.map((name) => ({ name, project: findProject(name) }));
    res.json({
      repos: await repoStatuses(
        repos.map((entry) => ({ project: entry.name, path: entry.project?.path ?? "" })),
      ),
    });
  } catch (err) {
    workroomError(res, err);
  }
});

// The managed dependency edges between this room's projects that are not passing.
// A room is where a cross-project break is actually coordinated, so it is worth
// seeing next to the conversation rather than one project's Deploy pane at a time.
// Recorded observations only: opening a room must not probe anybody's endpoints.
local.get("/api/work-sessions/:id/deployments", (req, res) => {
  try {
    const room = workSessions.get(req.params.id);
    res.json({ edges: deploymentEngine.service.crossProjectDependencies(room.projects) });
  } catch (err) {
    workroomError(res, err);
  }
});

/* ---------- workrooms: several projects, one conversation ---------- */

function workroomError(res: Response, err: unknown): void {
  if (err instanceof WorkSessionNotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof WorkSessionValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: (err as Error).message || "could not read workrooms" });
}

/** A room, plus what the cockpit needs to draw it without a second round trip. */
function workroomView(room: WorkSession) {
  const members = room.projects.map((name) => {
    const project = findProject(name);
    return {
      name,
      present: !!project,
      path: project?.path ?? null,
      description: project?.description ?? null,
      status: project?.status ?? null,
      gitBranch: project?.gitBranch ?? null,
      runCommand: project?.runCommand ?? null,
    };
  });
  return { ...room, members, ready: members.every((member) => member.present) };
}

local.get("/api/work-sessions", (_req, res) => {
  try {
    res.json({ workSessions: workSessions.list().map(workroomView) });
  } catch (err) {
    workroomError(res, err);
  }
});

local.post("/api/work-sessions", (req, res) => {
  try {
    const known = new Set(getProjects().map((project) => project.name));
    res.json({ ok: true, workSession: workroomView(workSessions.create(req.body, known)) });
  } catch (err) {
    workroomError(res, err);
  }
});

local.get("/api/work-sessions/:id", (req, res) => {
  try {
    res.json({ workSession: workroomView(workSessions.get(req.params.id)) });
  } catch (err) {
    workroomError(res, err);
  }
});

// Changing membership stops the old scope immediately and starts fresh next turn.
local.patch("/api/work-sessions/:id", (req, res) => {
  try {
    let room = workSessions.get(req.params.id);
    if (req.body?.projects !== undefined) {
      const known = new Set(getProjects().map((project) => project.name));
      room = workSessions.setProjects(req.params.id, req.body.projects, known);
      stopAiSession(workSessionKey(room.id));
    }
    // The AI a room runs is a setting on the room, not a fact about the moment
    // it was created — a conversation outlives any one provider's usage window.
    if (req.body?.engine !== undefined || req.body?.model !== undefined || req.body?.effort !== undefined) {
      const previousEngine = room.engine;
      room = workSessions.setEngine(req.params.id, req.body);
      if (room.engine !== previousEngine) stopAiSession(workSessionKey(room.id));
    }
    res.json({ ok: true, workSession: workroomView(room) });
  } catch (err) {
    workroomError(res, err);
  }
});

local.post("/api/work-sessions/:id/archive", (req, res) => {
  try {
    const room = workSessions.archive(req.params.id);
    stopAiSession(workSessionKey(room.id));
    res.json({ ok: true, workSession: workroomView(room) });
  } catch (err) {
    workroomError(res, err);
  }
});

/* ---------- managed deployments ---------- */

const deploymentSecretBroker = new SecretBroker({
  backend: defaultDeploymentSecretBackend(),
  generations: new DeploymentSecretGenerationStore(deploymentStore),
  fingerprintKey: deploymentFingerprintKey(),
});
const deploymentRuntimeAdapters = new DeploymentRuntimeAdapters({
  store: deploymentStore,
  broker: deploymentSecretBroker,
});
const deploymentEngine = createDeploymentEngine({
  store: deploymentStore,
  secretBroker: deploymentSecretBroker,
  projects: getProjects,
  observations: deploymentRuntimeAdapters.observations,
  adapters: [
    ...defaultDeploymentAdapters(deploymentRuntimeAdapters.observations),
    ...deploymentRuntimeAdapters.actionAdapters(),
  ],
  artifactPreparationAvailable: true,
});
const deploymentArtifactPreparer = new GitHubArtifactPreparer({
  service: deploymentEngine.service,
  store: deploymentStore,
  broker: deploymentSecretBroker,
});
/**
 * "Make ready to deploy", end to end.
 *
 * The coordinator drives the parts psm can do on the operator's behalf — repair,
 * build, recheck — through the machinery that already exists for each, so none
 * of it gains authority by being called from here. Repairs are an ordinary
 * workroom in the ordinary sandbox; the build is the same GitHub Actions
 * preparer the Prepare artifact button uses; and infrastructure is not touched
 * at all, only offered to the operator as the exact plan they already approve.
 */
const agentPermissions = new AgentPermissionStore();
const psmCodeRoot = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));
function permissionProject(id: string): PermissionProject {
  const project = getProjects().find((entry) => entry.id === id || entry.name === id);
  if (!project) throw new PermissionError("Project is no longer registered.");
  if (!project.id) throw new PermissionError("Assign a project identity before granting agent permissions.");
  return { id: project.id, name: project.name, path: fs.realpathSync(project.path) };
}
function preparationPermissionGap(projectId: string, engine: string | null, workroomId?: string | null): string | null {
  const project = permissionProject(projectId);
  if (project.path === psmCodeRoot) return "Review capabilities — PSM cannot modify its own running permission broker. Use a separate development checkout.";
  const snapshot = agentPermissions.snapshot(project);
  const gap = reviewAgentPermissions([snapshot], engine ?? (workroomId ? workSessions.get(workroomId).engine : null) ?? getProjects().find((item) => item.id === projectId)?.aiEngine ?? "claude", PREPARATION_OPERATIONS.map((entry) => entry.permission));
  if (gap) return gap;
  try { new RepositoryTools(snapshot, agentPermissions, [psmCodeRoot]).preflightCommit(); }
  catch (error) { return `Review capabilities — ${error instanceof PermissionError ? error.message : "Managed Git needs an ordinary checkout with an existing commit, an attached branch and a configured Git author."}`; }
  return null;
}
configureManagedAgents((scope) => {
  const projects = getProjects();
  const snapshots = [scope.cwd, ...scope.extraDirs].map((directory) => {
    const root = fs.realpathSync(directory);
    if (root === psmCodeRoot) throw new PermissionError("PSM cannot modify its own running permission broker. Use a separate development checkout.");
    const project = projects.find((entry) => fs.realpathSync(entry.path) === root);
    if (!project) throw new PermissionError("Every managed agent directory must be a registered project.");
    return agentPermissions.snapshot(permissionProject(project.name));
  });
  const preparation = scope.name.startsWith("__psm_work__:")
    && workSessions.get(scope.name.slice("__psm_work__:".length)).permissionProfile === "deployment-preparation";
  const gap = reviewAgentPermissions(snapshots, scope.engine, preparation ? PREPARATION_OPERATIONS.map((entry) => entry.permission) : ["repo.read"]);
  if (gap) throw new PermissionError(gap);
  return { store: agentPermissions, snapshots, projectBoundaries: projects.map((project) => fs.realpathSync(project.path)), protectedRoots: [psmCodeRoot, path.resolve(databaseFile()), path.resolve(databaseFile()) + "-wal", path.resolve(databaseFile()) + "-shm"] };
});
local.use(agentPermissionRouter({ store: agentPermissions, project: permissionProject, changed: (project) => stopProjectAgents(project.path) }));

const deploymentPreparation = new DeploymentPreparationController({
  reviewCapabilities: preparationPermissionGap,
  service: deploymentEngine.service,
  preparer: deploymentArtifactPreparer,
  runner: deploymentEngine.controller,
  repairs: new WorkroomPreparationRepairer({
    open: ({ projectId, title, objective, ai }) => {
      const projects = getProjects();
      const project = projects.find((item) => item.id === projectId);
      if (!project) throw new Error("psm can no longer see this project");
      const known = new Set(projects.map((item) => item.name));
      // One member, not two: the room exists to fix this project's own
      // deployment, and `preparation` is what lets a room be that small.
      // With no explicit choice it inherits the project's own engine, so the
      // repair reads like the rest of that project's AI work.
      return workSessions.create(
        {
          title,
          objective,
          projects: [project.name],
          engine: ai.engine ?? project.aiEngine,
          model: ai.engine ? ai.model ?? null : ai.model ?? project.aiModel,
          effort: ai.engine ? ai.effort ?? null : ai.effort ?? project.aiEffort,
        },
        known,
        { preparation: true },
      ).id;
    },
    engine: (roomId) => {
      try { return workSessions.get(roomId).engine; } catch { return null; }
    },
    useAi: (roomId, ai) => { workSessions.setEngine(roomId, ai); },
    send: (roomId, message) => {
      const conversation = workroomConversation(roomId);
      const result = aiSend(
        conversation.name,
        conversation.path,
        conversation.engine,
        conversation.model,
        conversation.effort,
        message,
        false, // a preparation room is never handed the sandbox-off flag
        conversation.extraContext,
        conversation.extraDirs,
      );
      if (result.ok) conversation.onTurn?.();
      return result;
    },
    // A queued turn is still work in flight: preparation must not read the gap
    // between two turns as "the repair finished".
    state: (roomId) => {
      const state = aiState(workSessionKey(roomId));
      return { busy: !!state.busy || state.queueDepth > 0, question: !!state.question };
    },
    stop: (roomId) => { stopAiSession(workSessionKey(roomId)); },
  }),
});
// A restarted agent has no in-flight turns to resume, so every job that was
// running when it stopped waits for the operator to press the button again.
deploymentPreparation.recover();

local.use(createDeploymentRouter({
  reviewCapabilities: preparationPermissionGap,
  service: deploymentEngine.service,
  currentUser,
  localRequest,
  runner: deploymentEngine.controller,
  preparer: deploymentArtifactPreparer,
  preparation: deploymentPreparation,
  streamTickets: deploymentStreamTickets,
  agentGeneration: () => agentSecret().createdAt,
}));

// The one line that decides whether this process can touch the machine.
app.use(local);

/**
 * An unknown API path is an error in JSON, not Express's HTML "Cannot GET".
 *
 * Every caller here is a `fetch` that will try to parse the body, and a page
 * left open across a psm upgrade *will* call a route that has since been
 * removed — which is exactly how a stale tab reported "Cannot GET
 * /api/cloud/sso/start" instead of anything a person could act on.
 */
app.use("/api", (req, res) => {
  res.status(404).json({ error: `unknown API route: ${req.method} /api${req.path}`, code: "unknown_route" });
});

app.use(express.static(WEB_DIR));

/**
 * SPA fallback. The cockpit is a single page, and sign-in returns the browser to
 * `/auth/callback` — a route the page owns and the filesystem knows nothing
 * about, so without this the consent screen would hand back to a 404.
 *
 * `/api/*` is excluded deliberately: an unknown API path must stay a 404, not
 * become HTML that a fetch() would try to parse as JSON. That mistake is how the
 * hosted page's asset paths broke once already (src/web-assets.test.ts).
 */
app.get(/^(?!\/api\/).*/, (req, res, next) => {
  if (req.method !== "GET" || req.path.includes(".")) return next();
  res.sendFile(path.join(WEB_DIR, "index.html"));
});

// psm never leaves loopback. The public face is a static site; see src/mode.ts.
const HOST = "127.0.0.1";

const server = app.listen(PORT, HOST, () => {
  console.log(`psm ${describeMode()}`);
  console.log(`  → http://${HOST}:${PORT}`);
  if (acceptsPairedOrigins()) {
    console.log(`  → pairing token: ${agentSecret().token}`);
    console.log(`  → paired origins: ${hostedOrigins().join(", ") || "none"}`);
  }
  // Durable deployment work outlives the process that started it. Resuming is
  // deliberately not automatic for every run: a run that died after submitting
  // a side effect is held for a person, because only an operator can say what
  // the target actually received.
  for (const recovered of deploymentEngine.start()) {
    if (recovered.disposition === "resumed") continue;
    console.log(`  → deployment run ${recovered.runId} (${recovered.state}) needs attention: ${recovered.disposition}`);
  }
});

/**
 * Stop taking deployment work before the process goes away.
 *
 * Without this, Ctrl-C during a run leaves its target lock held until the lease
 * expires and leaves the run's last durable state as whatever it happened to
 * reach — the runner's own shutdown path records `interrupted` instead, which
 * is the difference between "we do not know" and a plausible-looking lie.
 */
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close();
    deploymentPreparation.close();
    deploymentEngine.shutdown().finally(() => process.exit(0));
  });
}

startRuntimeDiscovery();
setTimeout(() => runDueBackups(getProjects()), 30_000).unref();
setInterval(() => runDueBackups(getProjects()), 60 * 60 * 1000).unref();
