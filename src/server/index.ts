import { SourcePublicationController } from "./deploy/source-publication.ts";
import { connectAttachedMcp, ManagedMcpTools, mcpConnectionId } from "./agent-mcp-tools.ts";
import { RepositoryTools } from "./agent-repository-tools.ts";
import os from "node:os";
import { databaseFile, db } from "./db.ts";
import { taskKey } from "./agent-policy.ts";
import { configuredRemotes, explainAccess, taskRunnerStatus } from "./agent-access.ts";
import { OperationReviews } from "./agent-reviews.ts";
import { MachineCommands } from "./machines/commands.ts";
import { AgentPermissionStore, agentPermissionRouter, isPermissionOperatorRequest, reviewAgentPermissions, PREPARATION_OPERATIONS, PermissionError, type PermissionProject, type PermissionSnapshot } from "./agent-permissions.ts";
import { workspaceAgentPolicyRouter } from "./workspace-agent-policy.ts";
import express from "express";
import type { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getProjects as scanProjects, writeMarkdown } from "../index.ts";
import { createProjectCache } from "./project-cache.ts";
import { overridesFile } from "../classify.ts";
import { linksFile } from "../links.ts";
import { loadOverrides, saveOverrides } from "../classify.ts";
import { loadConfig, workspaceRoot } from "../scan.ts";
import { LinkError, addLink, describeLinks, removeLink } from "../links.ts";
import { acceptsPairedOrigins, describeMode, pairsByMode, psmMode, scansImplicitly, usePairingSwitch } from "../mode.ts";
import { loadState as loadWorkspaceState, manageAuthority, projectWorkspaceRef, workspaceRouter } from "./workspaces.ts";
import { machineRouter } from "./machines/api.ts";
import { MachineService } from "./machines/service.ts";
import { SshMachineTransport } from "./machines/ssh.ts";
import { MachineStore } from "./machines/store.ts";
import { ensureProjectId } from "../identity.ts";
import { APP_VERSION } from "../version.ts";
import { STATUS_META } from "../render.ts";
import type { Attachment, Capability, Override, Project } from "../types.ts";
import { MAX_LOG_LINES, activeProcesses, allProcStates, procState, processRoster, processSummaries, restart, start, stop, stopAll, subscribe, transcript, type ProcKind } from "./procs.ts";
import {
  activeSessions,
  sessionQueue,
  sessionRoster,
  pendingQuestions,
  configureManagedAgents,
  stopProjectAgents,
  aiLimit,
  clearLimit,
  aiState,
  answerQuestion as aiAnswerQuestion,
  cancel as aiCancel,
  cancelPlanning,
  parseAiMode,
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
  deleteSession as deleteAiSession,
  subscribeAi,
  selectAi,
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
import { McpClientError, McpClientStore, MCP_TOKEN_ENV } from "./mcp/clients.ts";
import { McpOperations } from "./mcp/operations.ts";
import { MCP_PATH, mcpHandler } from "./mcp/server.ts";
import { McpRequestStore, requestsPerDay } from "./mcp/requests.ts";
import { connectCommand, connectionFile, connectionName, installInto, isDescendantOf, isProviderId, listProviders, removeConnection, snippets, uninstallFrom, writeConnection, type ProviderId } from "./mcp/connect.ts";
import { NOTE_KINDS, NoteNotFoundError, NoteValidationError, noteStore } from "./notes.ts";
import { ensurePreviewProxy } from "./preview.ts";
import { customCommandId, validateCustomCommands } from "./custom-commands.ts";
import { BrowseError, browse } from "./browse.ts";
import { StopError, machineProcesses, stopProcess } from "./machine.ts";
import { resourceRouter } from "./resources/api.ts";
import { modelBenchRouter } from "./model-bench.ts";
import { ResourceStore } from "./resources/store.ts";
import { projectDatabases } from "./resources/summary.ts";
import { BLOCK_START as GUIDANCE_START, guidanceFiles, guidanceRows, keyLabel, publishGuidance, renderGuidance } from "./resources/guidance.ts";
import {
  agentGuard,
  agentIdentity,
  agentSecret,
  hostedOrigins,
  isLoopbackHost,
  isOwnLoopbackOrigin,
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
import { approvedSsoCallback, ssoAvailability, ssoConfig } from "./sso.ts";
import { runWithSession, statePath } from "../store.ts";
import { OperatorCredential, injectOperatorToken, operatorGate } from "./operator.ts";
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
import { refreshWerewolfRuntime, runtimeServices, startRuntimeDiscovery, werewolfApiUrl } from "./runtime.ts";
import { activityLog } from "./executor/activity.ts";
import { agentId, buildRoster, type AgentSummary } from "./agents.ts";
import { projectRunbook, readCurated, validateCurated, writeCurated, type Runbook } from "../runbook.ts";
import { draftDescriptions } from "./runbook-draft.ts";
import { StackError, StackStore, type Stack } from "./stacks.ts";
import { UnitGrantStore } from "./unit-grants.ts";
import { primaryCheckouts } from "./mcp/primary-checkout.ts";
import { activeHub, hubMode, LOCAL_HUB_TARGET } from "./executor/hub.ts";
import { databaseKey, envReferences } from "./resources/discover.ts";
import { claudeEngine as draftEngine } from "./triage/run.ts";
import { isUnitKind, mcpUnitControl, parseTargets, planUnits, portOpen, startUnits, stopUnits, type UnitDeps, type UnitTarget } from "./units.ts";
import { executorActivity, executorForcedByEnv, executorStatus, jobsDirectory, reviewCauses, setExecutorRunning, startExecutorService } from "./executor/service.ts";
import { causeLabel, parseReviewCause } from "./executor/review-causes.ts";
import { clonePath } from "./executor/implement-job.ts";
import { acceptJob, discardClone, dropFetchedBranch, readJobDiff } from "./executor/review.ts";
import { readSwitches, writeSwitches } from "./switches.ts";
import { executorId, hubClient } from "./executor/client.ts";
import { intakeRoutes } from "./executor/intake-routes.ts";
import { createProjectPublisher } from "./executor/publish.ts";
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
import { approveByStandingRule } from "./deploy/standing-approval.ts";
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

/**
 * The workspace scan behind nearly every request, done once and reused.
 *
 * Uncached, each call re-read 60 project folders and ran four git processes
 * per repository, and a single tab switch triggered several calls — so opening
 * a project took seconds of identical work. See ./project-cache.ts for what
 * refreshes it.
 */
const projectCache = createProjectCache({
  scan: scanProjects,
  inputs: () => [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", "psm.config.json"),
    overridesFile(),
    linksFile(),
  ],
});
function getProjects(): ReturnType<typeof scanProjects> {
  return projectCache.get();
}

const app = express();
app.disable("x-powered-by");
// The cockpit can turn pairing on in dev mode too; see server/switches.ts.
usePairingSwitch(() => readSwitches().pairing);
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
/* P02a.2: state-changing requests from this machine need the operator token,
 * which only the cockpit page psm serves carries (see operator.ts). Paired
 * origins already presented the pairing token to agentGuard; MCP has its own. */
const operatorCredential = new OperatorCredential(process.env.PSM_OPERATOR_FILE || statePath(".psm-operator.json"));
operatorCredential.current();
app.use(operatorGate({
  credential: operatorCredential,
  pairedOrigin: (req) => !!req.headers.origin && !isOwnLoopbackOrigin(req),
  ownAuth: [MCP_PATH],
  sensitiveReads: ["/api/agent/token"],
}));
app.use(express.json({ limit: "2mb" }));

/* ---- MCP server for local AI clients (docs/roadmaps/psm-mcp-operations.md) ----
 * Its own credentials, never loopback trust; browser requests are refused.
 * The credential is read by clients from PSM_MCP_TOKEN. psm drops it from its
 * own environment so nothing it starts can inherit it (childEnv strips PSM_*
 * too). */
delete process.env[MCP_TOKEN_ENV];
const mcpClients = new McpClientStore();
const mcpRequests = new McpRequestStore();
const mcpOperations = new McpOperations({
  // One folder per id: a worktree or second clone shares the committed id and must not be picked by accident.
  projects: () => primaryCheckouts(getProjects()),
  plans: { list: (name) => planStore.list(name), get: (name, id) => planStore.get(name, id) },
  processes: processSummaries,
  // `machines` and `projectPublisher` are set further down; these run per call, after startup.
  machines: () => machines.listMachines("personal"),
  hub: async () => {
    const api = hubMode() === "local" ? null : await refreshWerewolfRuntime();
    return {
      api: api ? { target: `${api.source} (${api.activeUrl})`, reachable: api.reachable } : { target: LOCAL_HUB_TARGET, reachable: true },
      queue: hubMode(),
      executor: executorStatus(),
      publishing: projectPublisher?.status() ?? null,
    };
  },
  questions: async () => ((await hubReady()) ? hubForCockpit().listQuestions() : []),
  // Requests over MCP: a hub intake like the Agents page's composer makes, triaged and then waiting for Go.
  requests: {
    signedIn: () => hubReady(),
    create: async (input) => {
      const { intake, created } = await hubForCockpit().createIntake(input);
      return { intakeId: intake.intakeId, status: intake.status, created };
    },
    withdraw: async (intakeId) => void (await hubForCockpit().withdrawIntake(intakeId)),
    queue: () => hubForCockpit().listQueue(),
    jobs: () => hubForCockpit().listJobs(),
    store: mcpRequests,
    perDay: () => requestsPerDay(psmMode()),
  },
  // P18. runbookFor is hoisted; stackStore is read per call, after startup.
  runbook: (name) => runbookFor(name),
  unitStatus: (name, unit) => procState(name, `unit:${unit}`).status,
  stacks: () => stackStore.list().map((stack) => ({ id: stack.id, title: stack.title, units: stack.units.map((target) => ({ ...target, status: procState(target.project, `unit:${target.unit}`).status })) })),
  // The Agents page roster; agentRoster is hoisted and reads per call.
  agents: () => agentRoster(),
  // P18 R6: start/stop over MCP, only for units the operator allowed (unitGrants) on Full resources.
  units: mcpUnitControl({
    deps: () => unitDeps(),
    projectId: (name) => findProject(name)?.id ?? null,
    grant: (projectId, unit) => unitGrants.state(projectId, unit),
    resources: (project, folder) => unitResources(project, folder),
    stack: (id) => stackStore.get(id),
    running: () => runningUnits(),
  }),
});
app.all(MCP_PATH, mcpHandler({ store: mcpClients, operations: mcpOperations, startedByPsm: (pid) => isDescendantOf(pid, process.pid) }));

/* ---- Sign in with Werewolf (authorization code + PKCE) ----
 * The browser runs the flow — the same web/auth.js the hosted page runs, against
 * the one `psm` application row. It comes back to /auth/callback (served by the
 * SPA fallback below) and posts the code here, because dapp hands a web client
 * its refresh credential as a cookie and a page on localhost cannot keep one.
 */
/**
 * While signed in, psm publishes its projects (id, name, archived) to the hub so
 * the Todo `@project` picker can list them. PSM_PUBLISH_PROJECTS=0 turns it off.
 */
let projectPublisher: ReturnType<typeof createProjectPublisher> | null = null;

app.post("/api/auth/exchange", async (req, res) => {
  try {
    const { user } = await exchangeCode({
      code: String(req.body?.code || ""),
      codeVerifier: String(req.body?.codeVerifier || ""),
      /* The page reports the callback it actually used, and dapp exact-matches
       * it against the code it minted. psm checks it here as well, because the
       * Origin it presents to dapp is derived from this URI — forwarding it
       * unchecked would hand the caller that choice. See approvedSsoCallback. */
      redirectUri: approvedSsoCallback(req, String(req.body?.redirectUri || "")),
      device: {
        id: deviceFingerprint(String(req.headers["user-agent"] || "psm")),
        name: "psm",
        platform: String(req.headers["user-agent"] || "web").slice(0, 80),
      },
    });
    res.json({ ok: true, user });
    // Signed in: the picker should not wait for the next tick.
    void projectPublisher?.sync(true);
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
const WEB_ASSETS = ["index.html", "operator.js", "privacy.js", "app.js", "auth.js", "agent.js", "cloud.js", "deployment-connections.js", "machines.js", "resources.js", "executor.js", "agents.js", "scripts.js", "monitoring.js", "external-links.js", "styles.css"];

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
  res.json({ user, provider: "werewolf", sso, dapp, localApprovalWithoutSignIn: localRequest(req) && isLoopbackHost(req.hostname) });
});

/* ---------- MCP clients: minted and revoked only from the local cockpit ---------- */

local.get("/api/mcp/clients", (req, res) => {
  if (!localRequest(req)) return res.status(403).json({ error: "Manage AI clients from the local cockpit." });
  res.json({
    endpoint: `http://127.0.0.1:${PORT}${MCP_PATH}`,
    tokenEnv: MCP_TOKEN_ENV,
    requestsPerDay: requestsPerDay(psmMode()),
    clients: mcpClients.list().map((client) => ({ ...client, mayRequest: client.mayRequest === true, requestsToday: mcpRequests.recentCount(client.id), recent: mcpClients.recent(client.id, 5) })),
  });
});

// The operator's switch for submit_request. Like minting, only the cockpit can set it.
local.put("/api/mcp/clients/:id/requests", (req, res) => {
  if (!isPermissionOperatorRequest(req)) return res.status(403).json({ error: "Allow requests from the local cockpit." });
  if (typeof req.body?.allow !== "boolean") return res.status(400).json({ error: "allow must be true or false." });
  try {
    res.json({ client: mcpClients.setMayRequest(req.params.id, req.body.allow) });
  } catch (error) {
    const status = error instanceof McpClientError ? error.status : 500;
    res.status(status).json({ error: (error as Error).message });
  }
});

local.post("/api/mcp/clients", (req, res) => {
  // Same-origin browser request from the cockpit itself (see agent-permissions.ts).
  if (!isPermissionOperatorRequest(req)) return res.status(403).json({ error: "Mint AI client credentials from the local cockpit." });
  try {
    const { client, token } = mcpClients.mint(req.body ?? {}, `local:${os.userInfo().username}`);
    res.status(201).json({ client, token, endpoint: `http://127.0.0.1:${PORT}${MCP_PATH}`, tokenEnv: MCP_TOKEN_ENV });
  } catch (error) {
    const status = error instanceof McpClientError ? error.status : 500;
    res.status(status).json({ error: (error as Error).message });
  }
});

/* ---- Connect: one click mints a client and adds psm to the host's own MCP config ---- */

/** Undo a connection: delete the credential file and take psm out of the host's config. */
async function disconnectMcpClient(client: { connection?: { provider: string; file: string } }): Promise<void> {
  if (!client.connection) return;
  removeConnection(client.connection.file);
  if (isProviderId(client.connection.provider)) await uninstallFrom(client.connection.provider).catch(() => {});
}

local.get("/api/mcp/connect", (req, res) => {
  if (!localRequest(req)) return res.status(403).json({ error: "Connect AI clients from the local cockpit." });
  const live = mcpClients.list().filter((client) => client.revokedAt == null && client.connection);
  res.json({
    providers: listProviders().map((provider) => ({ ...provider, connectedAs: live.find((client) => client.connection!.provider === provider.id && provider.id !== "other")?.id ?? null })),
  });
});

local.post("/api/mcp/connect", async (req, res) => {
  if (!isPermissionOperatorRequest(req)) return res.status(403).json({ error: "Connect AI clients from the local cockpit." });
  const provider = req.body?.provider;
  if (!isProviderId(provider)) return res.status(400).json({ error: "Unknown provider." });
  let minted;
  try {
    minted = mcpClients.mint({ name: connectionName(provider), projects: req.body?.projects ?? "all" }, `local:${os.userInfo().username}`);
  } catch (error) {
    return res.status(error instanceof McpClientError ? error.status : 500).json({ error: (error as Error).message });
  }
  const { client, token } = minted;
  const file = connectionFile(client.id);
  try {
    writeConnection(file, { url: `http://127.0.0.1:${PORT}${MCP_PATH}`, token });
    const command = connectCommand(file);
    const installed = await installInto(provider, command);
    if (!installed.ok) throw new Error(installed.message);
    // One live connection per host: the new entry replaced the old one in its config.
    if (provider !== "other") {
      for (const earlier of mcpClients.list()) {
        if (earlier.id !== client.id && earlier.revokedAt == null && earlier.connection?.provider === provider) {
          removeConnection(earlier.connection.file);
          mcpClients.revoke(earlier.id);
        }
      }
    }
    let saved = mcpClients.setConnection(client.id, { provider, file });
    if (req.body?.mayRequest === true) saved = mcpClients.setMayRequest(client.id, true);
    res.status(201).json({ client: saved, provider, configured: installed.configured, message: installed.message, snippets: installed.configured ? null : snippets(command) });
  } catch (error) {
    // Nothing half-connected: no file, no live credential.
    removeConnection(file);
    mcpClients.revoke(client.id);
    res.status(502).json({ error: (error as Error).message });
  }
});

local.delete("/api/mcp/clients/:id", async (req, res) => {
  if (!isPermissionOperatorRequest(req)) return res.status(403).json({ error: "Revoke AI clients from the local cockpit." });
  try {
    const client = mcpClients.revoke(req.params.id);
    await disconnectMcpClient(client as { connection?: { provider: ProviderId; file: string } });
    res.json({ client });
  } catch (error) {
    const status = error instanceof McpClientError ? error.status : 500;
    res.status(status).json({ error: (error as Error).message });
  }
});

/* ---------- agent identity + pairing ---------- */

/** True when the caller is the local cockpit rather than a paired remote origin. */
function localRequest(req: express.Request): boolean {
  if (!req.headers.origin) return true; // same-origin navigations send no Origin
  // Another localhost port is not the cockpit: it may be a project's dev server.
  return isOwnLoopbackOrigin(req);
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

// A new operator token: every other open cockpit page must reload. This page gets the new one back.
local.post("/api/operator/rotate", (req, res) => {
  if (!localRequest(req)) return res.status(403).json({ error: "Rotate the operator token from the local cockpit." });
  const secret = operatorCredential.rotate();
  res.json({ ok: true, token: secret.token, createdAt: secret.createdAt });
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
  "customCommands",
  "deployStaging",
  "deployProduction",
  "port",
  "aiEngine",
  "aiModel",
  "aiEffort",
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
    // aiScopeDirs is what a turn actually gets, from the same resolution the
    // spawn uses, so the scope chip cannot promise something else.
    projects: getProjects().map((project) => ({ ...project, aiScopeDirs: extraDirsFor(project) })),
    statusMeta: STATUS_META,
    version: APP_VERSION,
    mode: psmMode(),
    capabilities: { runsCommands: true, scansImplicitly: scansImplicitly(), canLink: true, customCommands: true },
  });
});

/* ---------- linked sources ---------- */

// What psm is looking at. In dev this includes the configured workspace root,
// flagged `implicit` so the UI does not offer to unlink something it cannot.
// A request that adds, removes, renames or re-identifies a project makes the
// cached list stale both before and after it runs. Overrides and links are also
// caught by the cache's file check; a new project folder or identity file is not.
const PROJECT_WRITES = /^\/api\/(?:links(?:\/[^/]+)?|projects\/new|projects\/[^/]+(?:\/id|\/attachments(?:\/[^/]+)?)?)$/;
app.use((req, res, next) => {
  if (req.method === "GET" || !PROJECT_WRITES.test(req.path)) return next();
  projectCache.invalidate();
  res.on("finish", () => projectCache.invalidate());
  next();
});

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

/**
 * Only cloud calls need the Werewolf access token in request context.
 *
 * This used to be global middleware, which meant serving `/`, JavaScript, and
 * every local API call first tried to refresh an expired Werewolf session. If
 * that remote request stalled, the local cockpit could not even reload. Keep
 * remote authentication off the page-serving and machine-control paths.
 */
app.use("/api/cloud", (_req, _res, next) => {
  sessionContext()
    .then(({ accessToken }) => runWithSession(accessToken, next))
    .catch(() => runWithSession(null, next));
});

function cloudError(res: express.Response, err: unknown) {
  const typed = err as Error & { status?: number; code?: string; data?: unknown };
  return res.status(typed.status || 500).json({
    error: typed.message || "PSM Cloud request failed",
    code: typed.code,
    data: typed.data,
  });
}

// Personal/business workspaces. Under /api/cloud so it inherits the session
// context above; personal answers work with no session at all.
app.use("/api/cloud", workspaceRouter({ getProjects }));

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
  if ("customCommands" in req.body) {
    try {
      const next = validateCustomCommands(req.body.customCommands, getProjects());
      for (const saved of current.customCommands ?? []) {
        const updated = next.find((entry) => entry.id === saved.id);
        if (procState(name, `custom:${saved.id}`).status === "running" && JSON.stringify(updated) !== JSON.stringify(saved)) {
          return res.status(409).json({ error: `Stop ${saved.name} before changing it.` });
        }
      }
      req.body.customCommands = next;
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
  }
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
  if (customCommandId(v)) return v as ProcKind;
  if (isUnitKind(v)) return v;
  if (typeof v === "string" && /^script:[0-9a-f]{12}$/.test(v)) return v as ProcKind;
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
  const projects = new Set(getProjects().map((project) => project.name));
  const rooms = new Map(openWorkrooms().map((room) => [room.id, room.title]));
  const questions = pendingQuestions()
    .filter((entry) => entry.roomId ? rooms.has(entry.roomId) : entry.project === WORKSPACE_NAME || projects.has(entry.project))
    .map((entry) => ({ ...entry, label: entry.roomId ? rooms.get(entry.roomId) : entry.project === WORKSPACE_NAME ? "Workspace chat" : entry.project }));
  res.json({ sessions: workingItems(), questions });
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

// the workspace-wide chat target
local.get("/api/workspace", (_req, res) => {
  const o = loadOverrides()[WORKSPACE_NAME] || {};
  res.json({
    name: WORKSPACE_NAME,
    aiEngine: o.aiEngine || "claude",
    aiModel: parseModel(o.aiModel),
    aiEffort: parseEffort(o.aiEffort),
    aiFullAccess: false,
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
  if (typeof req.body?.kind === "string" && req.body.kind.startsWith("custom:") && !customCommandId(req.body.kind)) {
    return res.status(400).json({ error: "invalid custom command ID" });
  }
  const kind = parseKind(req.body?.kind);
  // Database scripts start only through /api/resources/scripts/run, which checks
  // the database's access level; this route would skip that check.
  if (kind.startsWith("script:")) return res.status(400).json({ error: "Run database scripts from the Data card." });
  const proj = findProject(req.params.name);
  if (!proj) return res.status(404).json({ error: "unknown project" });
  const customId = customCommandId(kind);
  if (customId) {
    const saved = proj.customCommands.find((entry) => entry.id === customId);
    if (!saved) return res.status(404).json({ error: "unknown custom command" });
    const directory = findProject(saved.directory);
    if (!directory) return res.status(400).json({ error: `Directory ${saved.directory} is no longer linked.` });
    const p = start(proj.name, kind, saved.command, directory.path);
    return res.json({ ok: true, status: p.status, command: saved.command });
  }
  const command =
    (req.body?.command && String(req.body.command).trim()) || commandForKind(proj, kind);
  if (!command)
    return res.status(400).json({ error: `no ${kind} command set for ${proj.name}` });
  const p = start(proj.name, kind, command, proj.path);
  res.json({ ok: true, status: p.status, command });
});

// stop it
local.post("/api/projects/:name/stop", (req, res) => {
  if (typeof req.body?.kind === "string" && req.body.kind.startsWith("custom:") && !customCommandId(req.body.kind)) {
    return res.status(400).json({ error: "invalid custom command ID" });
  }
  const stopped = stop(req.params.name, parseKind(req.body?.kind));
  res.json({ ok: true, stopped });
});

local.post("/api/projects/:name/restart", async (req, res) => {
  const kind = req.body?.kind ?? "run";
  if (kind !== "run" && !customCommandId(kind)) {
    return res.status(400).json({ error: "only project runs and custom commands can be restarted" });
  }
  const proj = findProject(req.params.name);
  if (!proj) return res.status(404).json({ error: "unknown project" });
  if (kind !== "run" && !proj.customCommands.some((entry) => `custom:${entry.id}` === kind)) {
    return res.status(404).json({ error: "unknown custom command" });
  }
  try {
    const p = await restart(proj.name, kind);
    res.json({ ok: true, status: p.status, command: p.command });
  } catch (error) {
    res.status(409).json({ error: (error as Error).message || "restart failed" });
  }
});

/* ---- runbooks (P18): every script a project has, and its units run one process each ---- */
const runbookCache = new Map<string, { at: number; runbook: Runbook }>();
function runbookFor(name: string): Runbook | null {
  const project = findProject(name);
  if (!project) return null;
  const cached = runbookCache.get(name);
  if (cached && Date.now() - cached.at < 10_000) return cached.runbook;
  try {
    const runbook = projectRunbook(project.path);
    runbookCache.set(name, { at: Date.now(), runbook });
    return runbook;
  } catch {
    return null;
  }
}
const unitDeps = (): UnitDeps => ({
  project: (name) => {
    const project = findProject(name);
    return project ? { name: project.name, path: project.path } : null;
  },
  projects: () => getProjects().filter((project) => !project.archived).map((project) => project.name),
  runbook: runbookFor,
  status: (name, kind) => {
    const state = procState(name, kind);
    return state.status === "idle" ? null : { status: state.status, port: (state as { port?: number | null }).port ?? null };
  },
  start: (name, kind, command, cwd, options) => { start(name, kind, command, cwd, options); },
  stop,
  portOpen,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
const unitGrants = new UnitGrantStore();
/** Databases a unit's folder points at (its .env), with this machine's access level. */
function unitResources(projectName: string, folder: string): Array<{ label: string; level: string | null }> {
  const project = findProject(projectName);
  if (!project) return [];
  const levels = new Map(resourceStore.list().map((setting) => [setting.key, setting.level]));
  const seen = new Map<string, { label: string; level: string | null }>();
  for (const ref of envReferences([{ name: project.name, path: project.path }])) {
    if (ref.directory !== folder) continue;
    const key = databaseKey(ref.target);
    seen.set(key, { label: keyLabel(key), level: levels.get(key) ?? null });
  }
  return [...seen.values()];
}
const runningUnits = (): UnitTarget[] =>
  processRoster().filter((proc) => proc.status === "running" && proc.kind.startsWith("unit:")).map((proc) => ({ project: proc.name, unit: proc.kind.slice("unit:".length) }));

local.get("/api/projects/:name/runbook", (req, res) => {
  const runbook = runbookFor(req.params.name);
  if (!runbook) return res.status(404).json({ error: "unknown project" });
  const projectId = findProject(req.params.name)?.id ?? null;
  const status = Object.fromEntries(runbook.units.map((unit) => {
    const state = procState(req.params.name, `unit:${unit.id}`);
    return [unit.id, {
      status: state.status,
      mcp: projectId ? unitGrants.state(projectId, unit) : "no-project-id",
      resources: unit.kind === "service" || unit.kind === "agent" || unit.kind === "task" ? unitResources(req.params.name, unit.folder) : [],
    }];
  }));
  res.json({ runbook, status, curated: readCurated(findProject(req.params.name)!.path) ?? { version: 1, units: {} } });
});

// The operator's own text for this project's scripts, written to the committed .psm/runbook.json.
local.put("/api/projects/:name/runbook", (req, res) => {
  if (!localRequest(req)) return res.status(403).json({ error: "Edit a project's scripts from the local cockpit." });
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  try {
    writeCurated(project.path, validateCurated(req.body));
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }
  runbookCache.delete(project.name);
  res.json({ ok: true, runbook: runbookFor(project.name) });
});

// One tool-less model call proposes descriptions; the operator accepts or discards them in the pane.
const draftsRunning = new Set<string>();
local.post("/api/projects/:name/runbook/draft", async (req, res) => {
  if (!localRequest(req)) return res.status(403).json({ error: "Draft descriptions from the local cockpit." });
  const project = findProject(req.params.name);
  const runbook = runbookFor(req.params.name);
  if (!project || !runbook) return res.status(404).json({ error: "unknown project" });
  if (draftsRunning.has(project.name)) return res.status(409).json({ error: "A draft for this project is already being written." });
  draftsRunning.add(project.name);
  try {
    const result = await draftDescriptions(draftEngine({ model: "sonnet" }), project.name, project.path, runbook);
    if (!result.ok) return res.status(502).json({ error: result.error });
    res.json(result);
  } finally {
    draftsRunning.delete(project.name);
  }
});

// Let MCP clients start this unit, for its current script (P18 R6). Only the cockpit, behind the operator token.
local.post("/api/projects/:name/unit-grants", (req, res) => {
  if (!localRequest(req)) return res.status(403).json({ error: "Allow units for MCP from the local cockpit." });
  const project = findProject(req.params.name);
  if (!project) return res.status(404).json({ error: "unknown project" });
  if (!project.id) return res.status(400).json({ error: "Give this project a stable id first (assign id on its card); MCP clients address projects by id." });
  const unit = runbookFor(project.name)?.units.find((entry) => entry.id === req.body?.unit);
  if (!unit) return res.status(404).json({ error: "No such script in this project." });
  if (!["service", "agent", "task"].includes(unit.kind)) return res.status(400).json({ error: `${unit.kind} scripts cannot be started over MCP.` });
  if (req.body?.allow === true) unitGrants.grant(project.id, unit);
  else unitGrants.revoke(project.id, unit.id);
  res.json({ ok: true, mcp: unitGrants.state(project.id, unit) });
});

local.post("/api/units/start", async (req, res) => {
  if (!localRequest(req)) return res.status(403).json({ error: "Start units from the local cockpit." });
  let targets: UnitTarget[];
  try {
    targets = parseTargets(req.body?.targets);
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }
  res.json({ results: await startUnits(unitDeps(), targets) });
});

/* Stacks: named sets of units, started together. Local cockpit only. */
const stackStore = new StackStore();
const stackView = (stack: Stack) => ({
  ...stack,
  units: stack.units.map((target) => ({ ...target, status: procState(target.project, `unit:${target.unit}`).status, known: !!runbookFor(target.project)?.units.some((unit) => unit.id === target.unit) })),
});
const stackRoute = (handler: (req: express.Request, res: express.Response) => unknown) => async (req: express.Request, res: express.Response) => {
  if (!localRequest(req)) return res.status(403).json({ error: "Manage stacks from the local cockpit." });
  try {
    await handler(req, res);
  } catch (error) {
    res.status(error instanceof StackError ? error.status : 500).json({ error: (error as Error).message });
  }
};
local.get("/api/stacks", stackRoute((_req, res) => res.json({ stacks: stackStore.list().map(stackView) })));
local.post("/api/stacks", stackRoute((req, res) => res.json({ stack: stackView(stackStore.create(req.body)) })));
local.put("/api/stacks/:id", stackRoute((req, res) => res.json({ stack: stackView(stackStore.update(req.params.id, req.body)) })));
local.delete("/api/stacks/:id", stackRoute((req, res) => {
  if (!stackStore.remove(req.params.id)) throw new StackError("Unknown stack.", 404);
  res.json({ ok: true });
}));
local.post("/api/stacks/:id/start", stackRoute(async (req, res) => {
  const stack = stackStore.get(req.params.id);
  if (!stack) throw new StackError("Unknown stack.", 404);
  res.json({ results: await startUnits(unitDeps(), stack.units) });
}));
local.post("/api/stacks/:id/stop", stackRoute((req, res) => {
  const stack = stackStore.get(req.params.id);
  if (!stack) throw new StackError("Unknown stack.", 404);
  // The stack's units and the dependencies they brought up; stopUnits keeps any
  // of those that something outside the stack still needs.
  const running = runningUnits();
  const isRunning = (target: UnitTarget) => running.some((entry) => entry.project === target.project && entry.unit === target.unit);
  const deps = unitDeps();
  const active = planUnits(deps, stack.units).map(({ project, unit }) => ({ project, unit })).filter(isRunning).reverse(); // dependents first
  res.json({ results: active.length ? stopUnits(deps, active, running, req.body?.force === true) : [] });
}));

local.post("/api/units/stop", (req, res) => {
  if (!localRequest(req)) return res.status(403).json({ error: "Stop units from the local cockpit." });
  let targets: UnitTarget[];
  try {
    targets = parseTargets(req.body?.targets);
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }
  res.json({ results: stopUnits(unitDeps(), targets, runningUnits(), req.body?.force === true) });
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
      aiFullAccess: false,
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
    "plan",
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
      "auto",
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
 * several, or one workspace directory — and in nothing else.
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
 * A workroom uses managed permissions for its selected repositories.
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

  // Discovery uses the same resolved checkout as the conversation, including
  // workrooms. A room id is not a project name.
  local.get(`${base}/ai/models`, async (req, res) => {
    try {
      const target = resolve(req);
      const engine = parseEngine(req.query.engine, target.engine);
      res.setHeader("Cache-Control", "no-store");
      res.json(await modelCatalog(engine, target.path));
    } catch (err) {
      guard(res, err);
    }
  });

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

  // A transcript connection is read-only. Provider/model changes need an
  // explicit picker action so a stale tab cannot interrupt another turn.
  local.post(`${base}/ai/selection`, (req, res) => {
    let t: AiConversation;
    try {
      t = resolve(req);
      const engine = parseEngine(req.body?.engine, t.engine);
      const model = parseModel(req.body?.model, t.model);
      const effort = parseEffort(req.body?.effort, t.effort);
      res.json(selectAi(t.name, t.path, engine, model, effort, t.extraDirs));
    } catch (err) {
      guard(res, err);
    }
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
    const mode = parseAiMode(req.body?.mode);
    const r = aiSend(
      t.name,
      t.path,
      engine,
      model,
      effort,
      String(req.body?.message ?? ""),
      mode,
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
    const mode = parseAiMode(req.body?.mode);
    const r = aiAnswerQuestion(
      t.name,
      t.path,
      String(req.body?.requestId ?? ""),
      answers,
      mode,
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
    res.json({
      members: deploymentEngine.service.deploymentCoverage(room.projects),
      edges: deploymentEngine.service.crossProjectDependencies(room.projects),
    });
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

local.get("/api/work-sessions", (req, res) => {
  try {
    res.json({ workSessions: workSessions.list({ includeArchived: req.query.includeArchived === "true" }).map(workroomView) });
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

local.delete("/api/work-sessions/:id", (req, res) => {
  try {
    const room = workSessions.delete(req.params.id);
    deleteAiSession(workSessionKey(room.id));
    res.json({ ok: true });
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
const sourcePublisher = new SourcePublicationController(deploymentEngine.service, deploymentSecretBroker);
const deploymentArtifactPreparer = new GitHubArtifactPreparer({
  publisher: sourcePublisher,
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
const operationReviews = new OperationReviews(agentPermissions);
// Assigned once the machine store exists, further down; read only per request.
let machineCommands: MachineCommands | undefined;
const psmCodeRoot = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));
function permissionProject(id: string): PermissionProject {
  const project = getProjects().find((entry) => entry.id === id || entry.name === id);
  if (!project) throw new PermissionError("Project is no longer registered.");
  if (!project.id) throw new PermissionError("Assign a project identity before granting agent permissions.");
  return { id: project.id, name: project.name, path: fs.realpathSync(project.path), workspaceId: projectWorkspaceRef(loadWorkspaceState(), project.id) };
}
/** Grants a preparation room needs. These, and only these, are answered in Capabilities. */
function preparationPermissionGap(projectId: string, engine: string | null, workroomId?: string | null): string | null {
  const snapshot = agentPermissions.snapshot(permissionProject(projectId));
  const roomEngine = workroomId ? workSessions.list({ includeArchived: true }).find((room) => room.id === workroomId)?.engine : null;
  return reviewAgentPermissions([snapshot], engine ?? roomEngine ?? getProjects().find((item) => item.id === projectId)?.aiEngine ?? "claude", PREPARATION_OPERATIONS.map((entry) => entry.permission));
}
/**
 * Whether this checkout can take a managed commit at all.
 *
 * No grant fixes what this finds — staged operator work, a detached HEAD, a
 * linked worktree, no identity Git would commit with — so it is reported as a
 * checkout problem and never as a capability to grant.
 */
function preparationCheckoutGap(projectId: string): string | null {
  const project = permissionProject(projectId);
  if (project.path === psmCodeRoot) return "Check the Git checkout — PSM cannot modify its own running permission broker. Use a separate development checkout.";
  try { new RepositoryTools(agentPermissions.snapshot(project), agentPermissions, [psmCodeRoot]).preflightCommit(); }
  catch (error) { return `Check the Git checkout — ${error instanceof PermissionError ? error.message : "Managed Git needs an ordinary checkout with an existing commit and an attached branch."}`; }
  return null;
}
/**
 * Credentials for an attached MCP server, from the secret broker when the
 * operator stored them in the connection `mcp-<hash of ref>` (one slot per
 * required variable); null means fall back to PSM's own environment.
 */
async function mcpCredentials(capability: import("../types.ts").McpCapability): Promise<Record<string, string> | null> {
  const names = [...capability.requiredEnv, ...(capability.mcp.transport === "http" && capability.mcp.bearerTokenEnvVar ? [capability.mcp.bearerTokenEnvVar] : [])];
  if (!names.length) return null;
  const connectionId = mcpConnectionId(capability.ref);
  try { deploymentStore.getConnection(connectionId); } catch { return null; }
  return deploymentSecretBroker.withLease(connectionId, names, (lease) => Object.fromEntries(names.map((name) => [name, lease.useUtf8(name, (value) => value)])));
}
const managedMcp = new ManagedMcpTools(agentPermissions, (snapshot) => {
  const project = getProjects().find((entry) => entry.id === snapshot.project.id && fs.realpathSync(entry.path) === snapshot.project.path);
  if (!project) return [];
  return currentCatalog().filter((capability): capability is import("../types.ts").McpCapability => capability.kind === "mcp" && capability.providerProject !== project.name && project.attachments.some((attachment) => attachment.capabilityRef === capability.ref && attachment.manifestDigest === capability.manifestDigest));
}, undefined, async (capability) => connectAttachedMcp(capability, await mcpCredentials(capability)));
configureManagedAgents((scope) => {
  // Chat runs the CLI directly, like a terminal session, with the mode picked in
  // the chat bar. Only deployment-preparation workrooms go through the broker,
  // because their deploy operations are psm tools that only exist there.
  const preparation = scope.name.startsWith("__psm_work__:")
    && workSessions.get(scope.name.slice("__psm_work__:".length)).permissionProfile === "deployment-preparation";
  if (!preparation) return null;
  const projects = getProjects();
  const snapshots = [scope.cwd, ...scope.extraDirs].map((directory) => {
    const root = fs.realpathSync(directory);
    if (root === psmCodeRoot) throw new PermissionError("PSM cannot modify its own running permission broker. Use a separate development checkout.");
    const project = projects.find((entry) => fs.realpathSync(entry.path) === root);
    if (!project) throw new PermissionError("Every managed agent directory must be a registered project.");
    // Task-scoped rules ("allow for this task") match this session only.
    return { ...agentPermissions.snapshot(permissionProject(project.name)), task: taskKey(scope.name) };
  });
  const gap = reviewAgentPermissions(snapshots, scope.engine, PREPARATION_OPERATIONS.map((entry) => entry.permission));
  if (gap) throw new PermissionError(gap);
  // An attached executable provider cannot also be edited by this managed turn.
  const attachedRefs = new Set(projects.filter((project) => snapshots.some((snapshot) => snapshot.project.id === project.id)).flatMap((project) => project.attachments.map((attachment) => attachment.capabilityRef)));
  const providerRoots = attachedRefs.size ? currentCatalog().filter((capability) => capability.kind === "mcp" && attachedRefs.has(capability.ref) && capability.providerProject).flatMap((capability) => projects.filter((project) => project.name === capability.providerProject).map((project) => fs.realpathSync(project.path))) : [];
  return { store: agentPermissions, snapshots, mcp: managedMcp, reviews: operationReviews, machines: machineCommands, taskNotes: operationReviews.taskNotes(taskKey(scope.name)), explain: (snapshot: PermissionSnapshot) => projectAccess(snapshot, scope.engine), projectBoundaries: projects.map((project) => fs.realpathSync(project.path)), protectedRoots: [psmCodeRoot, ...providerRoots, path.resolve(databaseFile()), path.resolve(databaseFile()) + "-wal", path.resolve(databaseFile()) + "-shm"] };
});
const resourceStore = new ResourceStore(db);
/** The access explanation for one project, as the operator and the agent both see it. */
async function projectAccess(snapshot: PermissionSnapshot, engine: string) {
  const project = getProjects().find((entry) => entry.id === snapshot.project.id);
  return explainAccess({
    snapshot, store: agentPermissions, engine,
    remotes: configuredRemotes(snapshot.project.path),
    runner: await taskRunnerStatus(),
    attachedTools: (project?.attachments ?? []).filter((attachment) => currentCatalog().some((capability) => capability.ref === attachment.capabilityRef && capability.kind === "mcp")).length,
    servers: machineCommands?.environments(snapshot.project.id) ?? [],
    databases: project ? projectDatabases(project, resourceStore) : [],
  });
}
local.get("/api/projects/:id/agent-access", async (req, res) => {
  try {
    const engine = String(req.query.engine || "claude");
    res.json({ engine, items: await projectAccess(agentPermissions.snapshot(permissionProject(req.params.id)), engine) });
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});
local.use(agentPermissionRouter({
  store: agentPermissions, mcp: managedMcp, reviews: operationReviews, project: permissionProject,
  changed: (project, { restrictive }) => {
    // Reduced authority stops running turns; added authority lets them continue.
    if (restrictive) stopProjectAgents(project.path);
    // A preparation stopped only for this project's grants continues as soon as
    // they are enough. `deploymentPreparation` is declared below; this callback
    // runs per request, long after startup.
    const resumed = deploymentPreparation.capabilitiesChanged(project.id);
    return resumed.length ? { resumedPreparations: resumed.map((job) => job.environmentId) } : undefined;
  },
}));

/** Business policy edits require live management authority as well as local operator access. */
function authorizeWorkspaceManagement(ref: string): Promise<Awaited<ReturnType<typeof manageAuthority>>> {
  if (ref === "personal") return manageAuthority(ref);
  return sessionContext()
    .then(({ accessToken }) => new Promise<Awaited<ReturnType<typeof manageAuthority>>>((resolve, reject) => {
      runWithSession(accessToken, () => { manageAuthority(ref).then(resolve, reject); });
    }))
    .catch(() => manageAuthority(ref));
}
local.use(workspaceAgentPolicyRouter({
  store: agentPermissions,
  authorize: authorizeWorkspaceManagement,
  changed: (workspaceId, { restrictive }) => {
    if (!restrictive) return;
    const state = loadWorkspaceState();
    for (const project of getProjects()) {
      if (project.id && projectWorkspaceRef(state, project.id) === workspaceId) stopProjectAgents(project.path);
    }
  },
}));

const deploymentPreparation = new DeploymentPreparationController({
  standingApproval: (input) => approveByStandingRule({
    permissions: agentPermissions, project: permissionProject, store: deploymentEngine.service.store,
    enqueue: (runId) => deploymentEngine.controller.enqueue(runId), agentId: () => agentIdentity().agentId,
  }, input),
  reviewCapabilities: preparationPermissionGap,
  reviewCheckout: preparationCheckoutGap,
  service: deploymentEngine.service,
  preparer: deploymentArtifactPreparer,
  publisher: sourcePublisher,
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
    ai: (roomId) => {
      try {
        const room = workSessions.get(roomId);
        return { engine: room.engine, model: room.model, effort: room.effort };
      } catch (error) {
        if (error instanceof WorkSessionNotFoundError) return null;
        throw error;
      }
    },
    useAi: (roomId, ai) => { workSessions.setEngine(roomId, ai); },
    send: (roomId, message, preparation) => {
      const conversation = workroomConversation(roomId);
      const result = aiSend(
        conversation.name,
        conversation.path,
        conversation.engine,
        conversation.model,
        conversation.effort,
        message,
        "auto",
        conversation.extraContext,
        conversation.extraDirs,
        preparation,
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
// A job blocked on grants or its checkout is rechecked now and every few seconds.
// The first pass corrects a job saved before this start — including one blocked
// under an older rule — and later passes notice a checkout fixed outside psm.
deploymentPreparation.watchBlocked();

local.use(createDeploymentRouter({
  reviewCapabilities: preparationPermissionGap,
  reviewCheckout: preparationCheckoutGap,
  service: deploymentEngine.service,
  currentUser,
  localRequest,
  runner: deploymentEngine.controller,
  preparer: deploymentArtifactPreparer,
  publisher: sourcePublisher,
  controllerCredentials: (unit, context) => deploymentRuntimeAdapters.publishControllerCredentials(unit, context),
  controllerPin: (unit, context, reviewed) => deploymentRuntimeAdapters.pinControllerHead(unit, context, reviewed),
  targetContractPin: (unit, context, reviewed) => deploymentRuntimeAdapters.pinTargetContract(unit, context, reviewed),
  preparation: deploymentPreparation,
  streamTickets: deploymentStreamTickets,
  agentGeneration: () => agentSecret().createdAt,
}));

/* ---------- deployment machines ---------- */

const machineStore = new MachineStore(db);
const machineTransport = new SshMachineTransport({ broker: deploymentSecretBroker });
const machines = new MachineService({
  store: machineStore, deployments: deploymentStore, broker: deploymentSecretBroker, transport: machineTransport,
  hostTarget: (projectId, environmentId) => deploymentEngine.service.hostTarget(projectId, environmentId),
  requireManifestTarget: true,
});
// Managed agents reach connected servers only through this, as each project's command account.
machineCommands = new MachineCommands(machineStore, machineTransport);
// A setup this process was running when it stopped is failed as uncertain; its
// retry re-inspects the server rather than replaying a privileged step.
machines.recoverInterrupted();
local.use(machineRouter({
  service: machines,
  localRequest,
  project: (id) => {
    const project = getProjects().find((entry) => entry.id === id);
    return project?.id ? { id: project.id, name: project.name, workspaceId: projectWorkspaceRef(loadWorkspaceState(), project.id) } : null;
  },
  // Only a business workspace needs the Werewolf session; personal never
  // waits on a remote refresh.
  authorize: authorizeWorkspaceManagement,
  actor: () => `local:${os.userInfo().username}`,
}));

// Resources: databases, containers, servers and folders on this machine, each
// with the access level you chose. Levels gate the database-script buttons.
const resourceProjects = () => getProjects().map((project) => ({ name: project.name, path: project.path, port: project.port ?? null }));
/**
 * Terminal agents (Claude Code, Codex) learn the levels from one marked block in
 * the machine-wide instruction files. Written after a change in Resources; on
 * start only refreshed where the block already exists, so psm never adds it to
 * someone's files before they have used the panel. PSM_AGENT_GUIDANCE=0 turns it off.
 */
const publishResourceGuidance = (onlyExisting = false) => {
  if (process.env.PSM_AGENT_GUIDANCE === "0") return;
  const files = guidanceFiles().filter((file) => !onlyExisting || (fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(GUIDANCE_START)));
  if (!files.length) return;
  publishGuidance(files, renderGuidance(guidanceRows(resourceStore.list(), resourceProjects())));
};
local.use(resourceRouter({
  store: resourceStore,
  projects: resourceProjects,
  localRequest,
  actor: () => `local:${os.userInfo().username}`,
  changed: () => publishResourceGuidance(),
}));
// The Models page (#/models) and the model-bench library beside psm.
local.use(modelBenchRouter({
  catalog: (engine) => modelCatalog(engine, process.cwd()),
  usage: async (engine) => (await subscriptionUsage(engine, null)).providers[0],
  actor: () => `local:${os.userInfo().username}`,
}));
try {
  publishResourceGuidance(true);
} catch (error) {
  console.warn(`[resources] could not refresh agent guidance: ${(error as Error).message}`);
}

// The P14 executor, when PSM_EXECUTOR=1: connected / last claim / jobs running.
local.get("/api/executor", (_req, res) => {
  res.json({ ...executorStatus(), projects: projectPublisher?.status() ?? null });
});

/* ---- switches: executor and pairing, flipped from the cockpit, remembered ---- */
function switchView() {
  const saved = readSwitches();
  return {
    executor: { on: executorStatus().enabled, saved: saved.executor, forcedByEnv: executorForcedByEnv(), status: executorStatus() },
    pairing: { on: acceptsPairedOrigins(), saved: saved.pairing, forcedByMode: pairsByMode(), origins: hostedOrigins() },
  };
}
local.get("/api/switches", (_req, res) => res.json(switchView()));
local.put("/api/switches", async (req, res) => {
  // Both widen what can act on this machine, so only the local cockpit flips them
  // — never the paired page itself.
  if (!localRequest(req)) return res.status(403).json({ error: "Change these from the local cockpit." });
  const { executor, pairing } = req.body ?? {};
  if (executor !== undefined && typeof executor !== "boolean") return res.status(400).json({ error: "executor must be true or false" });
  if (pairing !== undefined && typeof pairing !== "boolean") return res.status(400).json({ error: "pairing must be true or false" });
  try {
    writeSwitches({ executor, pairing });
    if (typeof executor === "boolean") await setExecutorRunning(executor);
    if (pairing === true) console.log(`  → pairing on: ${hostedOrigins().join(", ") || "no origin configured"} may drive this machine with the pairing token`);
    res.json(switchView());
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// What the executor did, job by job: the note, the prompt, Claude's answer, the verdict.
local.get("/api/executor/activity", (_req, res) => {
  const activity = executorActivity();
  res.json({ revision: activity.revision, status: executorStatus(), jobs: activity.list() });
});
local.get("/api/executor/activity/:jobId", (req, res) => {
  const entry = executorActivity().get(req.params.jobId);
  if (!entry) return res.status(404).json({ error: "No such job in the executor's history." });
  res.json(entry);
});
// The same job as plain text to paste into a conversation; ?full=1 adds the prompts.
local.get("/api/executor/activity/:jobId/log", (req, res) => {
  const entry = executorActivity().get(req.params.jobId);
  if (!entry) return res.status(404).type("text/plain").send("No such job in the executor's history.\n");
  res.type("text/plain").send(activityLog(entry, { full: req.query.full === "1" }));
});

// The hub's whole queue for this user: waiting, being triaged (and by which
// executor), and done with its verdict. Read through the Werewolf session.
const hubForCockpit = () => activeHub();
/** Can the queue be used? The local queue always can; the Werewolf hub needs a signed-in session. */
async function hubReady(): Promise<boolean> {
  return hubMode() === "local" || !!(await currentUser().catch(() => null));
}
/**
 * What triage is waiting on you to decide (hub contract C2). Todo items are
 * answered in Todo, so each one comes with a link there; PSM-written ones are
 * answered here by editing them, and either kind can take Go.
 */
async function todoOrigin(): Promise<string> {
  if (process.env.PSM_TODO_URL) return process.env.PSM_TODO_URL.replace(/\/+$/, "");
  const api = await refreshWerewolfRuntime();
  return api.source === "local" ? "http://localhost:5200" : "https://todo.werewolf.solutions";
}
local.get("/api/executor/questions", async (_req, res) => {
  if (!(await hubReady())) return res.json({ signedIn: false, questions: [], todoUrl: null });
  try {
    const names = new Map(primaryCheckouts(getProjects()).filter((project) => project.id).map((project) => [project.id!, project.name]));
    const todoUrl = await todoOrigin();
    const questions = (await hubForCockpit().listQuestions()).map((question) => ({
      ...question,
      projectName: names.get(question.projectId) ?? question.project,
      todoLink: question.kind === "task" && question.date ? `${todoUrl}/?week=${question.date}`
        : question.kind === "note" ? `${todoUrl}/notes${question.project ? `?project=${encodeURIComponent(question.project)}` : ""}`
        : question.kind === "task" ? `${todoUrl}/questions` : null,
    }));
    res.json({ signedIn: true, questions, todoUrl });
  } catch (error) {
    res.status(502).json({ error: `The hub did not answer: ${(error as Error).message}` });
  }
});
local.get("/api/executor/queue", async (_req, res) => {
  if (!(await hubReady())) return res.status(401).json({ error: "Sign in with Werewolf to see the queue." });
  const cockpitHub = hubForCockpit();
  try {
    const names = new Map(primaryCheckouts(getProjects()).filter((project) => project.id).map((project) => [project.id!, project.name]));
    const queue = (await cockpitHub.listQueue()).filter((item) => item.status !== "withdrawn");
    // Requests an MCP client sent: name the client, so the queue says who asked.
    const askedBy = mcpRequests.clientsFor(queue.map((item) => item.intakeId));
    const items = queue.map((item) => {
      const asked = askedBy.get(item.intakeId);
      return {
        ...item,
        projectName: names.get(item.projectId) ?? null,
        mine: item.claim?.executorId === executorStatus().executorId,
        requestedBy: asked ? { clientId: asked.clientId, name: mcpClients.get(asked.clientId)?.name ?? "a removed MCP client", kind: asked.kind } : null,
      };
    });
    res.json({ executorId: executorStatus().executorId, items });
  } catch (error) {
    res.status(502).json({ error: `The hub did not answer: ${(error as Error).message}` });
  }
});

/* ---- the Agents page: everything working on this machine's projects ---- */
// The hub's queue and target are read at most every 15 s, and a slow hub never
// holds the page up for more than 2.5 s: it shows what it had last.
let agentHubCache: { at: number; signedIn: boolean; hub: { target: string; reachable: boolean } | null; queue: Awaited<ReturnType<ReturnType<typeof hubClient>["listQueue"]>> | null; jobs: Awaited<ReturnType<ReturnType<typeof hubClient>["listJobs"]>> | null } | null = null;
let agentHubRefresh: Promise<void> | null = null;
async function agentHubState() {
  // psm's own queue is a local read: fresh enough to follow sub-agents as they queue and start.
  if (agentHubCache && Date.now() - agentHubCache.at < (hubMode() === "local" ? 3_000 : 15_000)) return agentHubCache;
  agentHubRefresh ??= (async () => {
    const signedIn = await hubReady();
    const hub = hubMode() === "local"
      ? { target: LOCAL_HUB_TARGET, reachable: true }
      : await refreshWerewolfRuntime().then((api) => ({ target: `${api.source} (${api.activeUrl})`, reachable: api.reachable })).catch(() => null);
    const queue = signedIn ? await hubForCockpit().listQueue().catch(() => null) : null;
    const jobs = signedIn ? await hubForCockpit().listJobs().catch(() => null) : null;
    agentHubCache = { at: Date.now(), signedIn, hub, queue, jobs };
  })().finally(() => { agentHubRefresh = null; });
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2_500).unref());
  await Promise.race([agentHubRefresh, timeout]);
  return agentHubCache ?? { at: 0, signedIn: false, hub: null, queue: null, jobs: null };
}

const AGENT_HISTORY_MS = 24 * 60 * 60_000;
/** Every project's runbook agents (scripts classified `agent`), main checkouts only. */
function scriptAgentRoster() {
  return primaryCheckouts(getProjects()).flatMap((project) =>
    (runbookFor(project.name)?.units ?? [])
      .filter((unit) => unit.kind === "agent")
      .map((unit) => ({
        project: project.name,
        unit: unit.id,
        title: unit.title,
        command: unit.command,
        folder: path.basename(path.join(project.path, unit.folder)),
        summary: unit.summary,
        port: unit.port,
        costs: unit.costs,
        aliases: unit.aliases.map((alias) => ({ command: alias === "start" ? "npm start" : `npm run ${alias}`, folder: path.basename(project.path) })),
      })));
}
async function agentRoster(): Promise<AgentSummary[]> {
  const hub = await agentHubState();
  return buildRoster({
    machine: os.hostname(),
    executor: executorStatus(),
    hub: hub.hub,
    signedIn: hub.signedIn,
    localQueue: hubMode() === "local",
    jobs: executorActivity().list(),
    queue: hub.queue,
    hubJobs: hub.jobs,
    sessions: sessionRoster(Date.now() - AGENT_HISTORY_MS),
    rooms: openWorkrooms().map((room) => ({ id: room.id, title: room.title, projects: room.projects })),
    processes: processRoster(),
    scriptAgents: scriptAgentRoster(),
    mcpClients: mcpClients.list().map((client) => ({ ...client, recent: mcpClients.recent(client.id, 1) })),
    projects: primaryCheckouts(getProjects()),
    now: Date.now(),
  });
}

local.get("/api/agents", async (req, res) => {
  if (!localRequest(req)) return res.status(403).json({ error: "The Agents page is local to this machine." });
  res.json({ machine: os.hostname(), agents: await agentRoster() });
});

/** One agent with what it is doing: its transcript, queue, log tail or calls. */
local.get("/api/agents/:id", async (req, res) => {
  if (!localRequest(req)) return res.status(403).json({ error: "The Agents page is local to this machine." });
  const id = req.params.id;
  const agent = (await agentRoster()).find((entry) => entry.id === id);
  if (!agent) return res.status(404).json({ error: "That agent is not running any more." });
  let detail: Record<string, unknown> = {};
  if (agent.kind === "project-agent" || agent.kind === "sub-agent") {
    const entry = agent.jobId ? executorActivity().get(agent.jobId) : null;
    if (entry) detail = { jobId: entry.jobId, jobKind: entry.kind, text: entry.text, attempt: entry.attempt, timeline: entry.timeline.slice(-30), lines: entry.agent.slice(-40), error: entry.error };
    // What the queue knows about a sub-agent's job: what it is expected to touch and what it waits for.
    const queued = agent.kind === "sub-agent" ? agentHubCache?.jobs?.find((job) => job.jobId === agent.jobId) : null;
    if (queued) {
      const intake = agentHubCache?.queue?.find((item) => item.intakeId === queued.intakeId);
      detail = { ...detail, jobId: queued.jobId, text: (detail.text as string | undefined) ?? intake?.text ?? "", status: queued.status, scope: queued.scope ?? intake?.scope ?? null, waitingFor: queued.waitingFor ?? [], needs: queued.needs ?? [], note: queued.note ?? null };
    }
  } else if (agent.kind === "remote-executor") {
    const executor = id.slice("remote:".length);
    const names = new Map(primaryCheckouts(getProjects()).filter((project) => project.id).map((project) => [project.id!, project.name]));
    detail = { items: (agentHubCache?.queue ?? []).filter((item) => item.claim?.executorId === executor).map((item) => ({ intakeId: item.intakeId, project: names.get(item.projectId) ?? item.projectId, text: item.text.slice(0, 400), status: item.status, updatedAt: item.updatedAt })) };
  } else if (agent.kind === "ai-session") {
    const name = decodeURIComponent(id.slice("ai:".length));
    const state = aiState(name);
    detail = {
      session: { name, sessionId: state.sessionId, engine: state.engine, model: state.model, actualModel: state.actualModel, effort: state.effort, messages: state.messages, busy: state.busy },
      question: state.question,
      queue: sessionQueue(name),
      recent: state.recent.filter((event) => event.role !== "system" || /^→\s+/.test(event.text)).slice(-30).map((event) => ({ t: event.t, role: event.role, text: event.text.slice(0, 800) })),
    };
  } else if (agent.kind === "process") {
    const proc = processRoster(40).find((entry) => agentId.process(entry.name, entry.kind) === id);
    if (proc) detail = { command: proc.command, folder: proc.folder, pid: proc.pid, exitCode: proc.exitCode, kind: proc.kind, log: proc.log };
    else if (agent.control?.unit) {
      // A runbook agent nothing has started yet: what Start would run.
      const unit = runbookFor(agent.control.project)?.units.find((entry) => entry.id === agent.control!.unit);
      if (unit) detail = { command: unit.command, folder: unit.folder || ".", script: unit.scriptText, summary: unit.summary, whenToUse: unit.whenToUse, costs: unit.costs };
    }
  } else if (agent.kind === "mcp-client") {
    const client = mcpClients.get(id.slice("mcp:".length));
    if (client) detail = { createdAt: client.createdAt, createdBy: client.createdBy, calls: mcpClients.recent(client.id, 30) };
  }
  res.json({ agent, detail });
});

/* ---- implement jobs (P14 phase E): Go, and review where the branch lives ---- */
// By id, the main checkout: a linked worktree carries the same committed id.
const projectById = (id: string) => primaryCheckouts(getProjects()).find((project) => project.id === id) ?? null;
/** The clone of a job this machine ran, or null. */
const localClone = (job: { jobId: string; projectId: string }) => {
  const project = projectById(job.projectId);
  if (!project) return null;
  const dir = clonePath(jobsDirectory(), project.name, job.jobId);
  return fs.existsSync(dir) ? { project, dir } : null;
};
const jobRoute = (handler: (req: express.Request, res: express.Response) => Promise<unknown>) => async (req: express.Request, res: express.Response) => {
  if (!localRequest(req)) return res.status(403).json({ error: "Review implement jobs from the local cockpit." });
  if (!(await hubReady())) return res.status(401).json({ error: "Sign in with Werewolf first." });
  try {
    await handler(req, res);
  } catch (error) {
    const status = (error as { status?: number }).status;
    res.status(status && status >= 400 && status < 500 ? status : 502).json({ error: (error as Error).message });
  }
};
const findJob = async (jobId: string) => (await hubForCockpit().listJobs()).find((job) => job.jobId === jobId) ?? null;

local.get("/api/executor/jobs", jobRoute(async (_req, res) => {
  const me = executorStatus().executorId ?? executorId();
  const jobs = (await hubForCockpit().listJobs()).map((job) => ({
    ...job,
    projectName: projectById(job.projectId)?.name ?? null,
    // Only the machine holding the branch can review it.
    reviewHere: job.status === "review" && job.pinnedExecutor === me && !!localClone(job),
    // A stalled or failed job whose copy is still here can continue where it stopped.
    resumeHere: (job.status === "stalled" || job.status === "failed") && !!localClone(job),
  }));
  res.json({ executorId: me, jobs });
}));
local.post("/api/executor/jobs", jobRoute(async (req, res) => {
  const selection = req.body?.selection ?? { mode: "auto" };
  if (!selection || selection.mode !== "auto" && selection.mode !== "manual") return res.status(400).json({ error: "Choose Auto or a provider and model." });
  if (selection.mode === "manual" && (selection.engine !== "claude" && selection.engine !== "codex" || selection.model != null && (typeof selection.model !== "string" || selection.model.length > 120) || selection.effort != null && (typeof selection.effort !== "string" || selection.effort.length > 30))) {
    return res.status(400).json({ error: "Invalid provider, model or effort." });
  }
  res.status(201).json({ job: await hubForCockpit().goJob(String(req.body?.intakeId || ""), selection.mode === "auto" ? { mode: "auto" } : { mode: "manual", engine: selection.engine, model: selection.model || null, effort: selection.effort || null }) });
}));
local.get("/api/executor/job-models", jobRoute(async (req, res) => {
  const engine = req.query.engine;
  const project = projectById(String(req.query.projectId ?? ""));
  if ((engine !== "claude" && engine !== "codex") || !project) return res.status(400).json({ error: "Choose a local project and provider." });
  res.json(await modelCatalog(engine, project.path));
}));
local.get("/api/executor/jobs/:jobId/diff", jobRoute(async (req, res) => {
  const job = await findJob(req.params.jobId);
  const clone = job && localClone(job);
  if (!job || !clone) return res.status(404).json({ error: "This machine does not hold that job's branch." });
  // Earlier "the project made this easy" causes, so a repeat shows while reviewing.
  res.json({ job, diff: readJobDiff(clone.dir, job.jobId), projectCauses: reviewCauses().projectCauses(job.projectId).slice(0, 10) });
}));
local.post("/api/executor/jobs/:jobId/accept", jobRoute(async (req, res) => {
  const job = await findJob(req.params.jobId);
  const clone = job && localClone(job);
  if (!job || !clone) return res.status(404).json({ error: "This machine does not hold that job's branch." });
  if (job.status !== "review") return res.status(409).json({ error: `This job is ${job.status}, not waiting for review.` });
  const subject = job.result?.commits?.[0]?.subject || "implement job";
  const merged = acceptJob(clone.project.path, clone.dir, job.jobId, `Merge ${job.result?.branch ?? job.jobId}: ${subject}`);
  if (!merged.ok) {
    // A project that runs overlapping jobs side by side redoes a conflicting one from the merged code.
    const hub = hubForCockpit();
    if (merged.conflicted && hub.overlapModes?.()[job.projectId] === "conflict") {
      const redone = hub.redoAfterConflict?.(job.jobId);
      if (redone) {
        executorActivity().reviewed(job.jobId, "revise", "Accept conflicted with what was merged meanwhile; it starts again from the merged code");
        dropFetchedBranch(clone.project.path, job.jobId);
        discardClone(clone.dir);
        return res.json({ job: redone, redone: true, message: "It conflicted with what was merged meanwhile, so it starts again from the merged code. Your checkout is unchanged." });
      }
    }
    return res.status(409).json({ error: merged.reason, branchKept: merged.branchKept });
  }
  // Recorded before telling the hub: the merge happened whatever the hub says.
  executorActivity().reviewed(job.jobId, "accept", `${merged.into} (${merged.mergeCommit.slice(0, 8)})`);
  const saved = await hubForCockpit().reviewJob(job.jobId, "accept");
  discardClone(clone.dir);
  res.json({ job: saved, merged });
}));
local.post("/api/executor/jobs/:jobId/reject", jobRoute(async (req, res) => {
  const job = await findJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "No such job." });
  const why = parseReviewCause(req.body);
  if ("error" in why) return res.status(400).json({ error: why.error });
  const saved = await hubForCockpit().reviewJob(job.jobId, "reject");
  reviewCauses().record({ jobId: job.jobId, projectId: job.projectId, action: "reject", ...why, task: executorActivity().get(job.jobId)?.text ?? "" });
  executorActivity().reviewed(job.jobId, "reject", causeLabel(why.cause, why.note));
  const clone = localClone(job);
  if (clone) discardClone(clone.dir);
  res.json({ job: saved });
}));
local.post("/api/executor/jobs/:jobId/revise", jobRoute(async (req, res) => {
  const comment = String(req.body?.comment || "").trim();
  if (!comment) return res.status(400).json({ error: "Say what to change." });
  const why = parseReviewCause(req.body, comment);
  if ("error" in why) return res.status(400).json({ error: why.error });
  const saved = await hubForCockpit().reviewJob(req.params.jobId, "revise", comment);
  reviewCauses().record({ jobId: saved.jobId, projectId: saved.projectId, action: "revise", ...why, task: executorActivity().get(saved.jobId)?.text ?? "" });
  executorActivity().reviewed(req.params.jobId, "revise", `${comment.slice(0, 300)} (${causeLabel(why.cause, why.note)})`);
  res.json({ job: saved });
}));
// How overlapping jobs on each project are scheduled: one after another, or side by side.
local.get("/api/executor/overlap", jobRoute(async (_req, res) => {
  res.json({ modes: hubForCockpit().overlapModes?.() ?? null });
}));
local.post("/api/executor/overlap/:projectId", jobRoute(async (req, res) => {
  const hub = hubForCockpit();
  if (!hub.setOverlapMode) return res.status(409).json({ error: "Only psm's own queue can run overlapping jobs side by side." });
  res.json({ projectId: req.params.projectId, mode: hub.setOverlapMode(req.params.projectId, req.body?.mode) });
}));

// A stalled or failed job, again: a fresh job for the same ticket, with the same model choice.
local.post("/api/executor/jobs/:jobId/retry", jobRoute(async (req, res) => {
  const job = await findJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "No such job." });
  if (job.status !== "stalled" && job.status !== "failed") return res.status(409).json({ error: `This job is ${job.status}; only a stalled or failed job can be retried.` });
  const hub = hubForCockpit();
  await hub.cancelJob(job.jobId);
  const clone = localClone(job);
  if (clone) discardClone(clone.dir);
  res.status(201).json({ job: await hub.goJob(job.intakeId, job.selection) });
}));

// Continue a stalled or failed job where it stopped, in the copy it already has.
local.post("/api/executor/jobs/:jobId/resume", jobRoute(async (req, res) => {
  const job = await findJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "No such job." });
  if (!localClone(job)) return res.status(409).json({ error: "This job's copy is not on this machine any more. Use Retry to start it again." });
  res.json({ job: await hubForCockpit().resumeJob(job.jobId) });
}));

// Back through triage: for a ticket that failed triage, did not fit, or whose job stalled or failed.
local.post("/api/executor/intake/:intakeId/retriage", jobRoute(async (req, res) => {
  const hub = hubForCockpit();
  const jobs = (await hub.listJobs()).filter((job) => job.intakeId === req.params.intakeId);
  for (const job of jobs.filter((entry) => entry.status === "stalled" || entry.status === "failed")) {
    await hub.cancelJob(job.jobId);
    const clone = localClone(job);
    if (clone) discardClone(clone.dir);
  }
  res.json({ intake: await hub.retriageIntake(req.params.intakeId) });
}));

local.post("/api/executor/jobs/:jobId/cancel", jobRoute(async (req, res) => {
  const job = await hubForCockpit().cancelJob(req.params.jobId);
  const clone = localClone(job);
  if (clone) discardClone(clone.dir);
  res.json({ job });
}));

// Tasks written in PSM itself (P17): the Executor page's composer, Edit and Withdraw.
local.use(intakeRoutes({
  isLocal: localRequest,
  signedIn: () => hubReady(),
  hub: hubForCockpit,
  projects: getProjects,
  executorId: () => executorStatus().executorId ?? executorId(),
}));

// The hub's project registry, which the Todo `@project` picker reads.
local.get("/api/hub/projects", (_req, res) => {
  res.json(projectPublisher?.status() ?? { enabled: false, state: "off", count: 0, lastPublishedAt: null, lastError: null });
});
local.post("/api/hub/projects/publish", async (_req, res) => {
  if (!projectPublisher) return res.status(409).json({ error: "Publishing is off (PSM_PUBLISH_PROJECTS=0)." });
  const status = await projectPublisher.sync(true);
  if (status.state === "signed-out") return res.status(401).json({ ...status, error: "Sign in with Werewolf first." });
  if (status.state === "error") return res.status(502).json({ ...status, error: status.lastError });
  res.json(status);
});

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

/** The cockpit page, carrying this install's operator token. Never cached: a rotated token must reach the next load. */
function sendCockpit(res: express.Response) {
  let html: string;
  try {
    html = fs.readFileSync(path.join(WEB_DIR, "index.html"), "utf8");
  } catch {
    return res.status(500).type("text/plain").send("psm could not read its page.");
  }
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(injectOperatorToken(html, operatorCredential.current().token));
}
app.get(["/", "/index.html"], (_req, res) => sendCockpit(res));

app.use(express.static(WEB_DIR, { index: false }));

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
  sendCockpit(res);
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
startExecutorService(readSwitches().executor); // off unless PSM_EXECUTOR=1 or switched on in the cockpit
if (process.env.PSM_PUBLISH_PROJECTS !== "0") {
  projectPublisher = createProjectPublisher({
    hub: hubClient({ apiUrl: () => werewolfApiUrl(), token: async () => (await sessionContext()).accessToken, executorId: executorId() }),
    projects: () => getProjects().map((project) => ({ id: project.id, name: project.name, archived: project.archived })),
    signedIn: async () => !!(await currentUser()),
    log: (line) => console.log(`  → ${line}`),
  });
  projectPublisher.start();
}
setTimeout(() => runDueBackups(getProjects()), 30_000).unref();
setInterval(() => runDueBackups(getProjects()), 60 * 60 * 1000).unref();
