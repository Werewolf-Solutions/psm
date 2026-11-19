/**
 * The Agents page: everything that works on this machine's projects, in one
 * list — the executor and the jobs it runs, other executors the hub shows
 * working for this user, psm's AI conversations, the processes psm started
 * (script agents such as website-agent among them) and the MCP clients that
 * call psm.
 *
 * This module only shapes data the server already has; it reads nothing
 * itself, so it can be tested with plain objects. Local cockpit only: it
 * carries commands (credentials in URLs masked), folders and log tails.
 */

import { describeNeeds, type Need } from "./executor/needs.ts";

export type AgentKind = "executor" | "project-agent" | "sub-agent" | "remote-executor" | "ai-session" | "process" | "mcp-client";
export type AgentGroup = "executor" | "project" | "ai" | "process" | "mcp";
export type AgentState = "working" | "waiting" | "idle" | "off" | "error" | "stopped";

export interface AgentConnection {
  kind: "hub" | "model" | "repo" | "mcp" | "capability" | "port" | "sandbox" | "agent" | "project" | "psm";
  label: string;
  detail?: string;
  state?: "ok" | "bad" | "off";
  /** Another agent in the list, so the page can link to it. */
  agentId?: string;
}

export interface AgentSummary {
  id: string;
  kind: AgentKind;
  group: AgentGroup;
  /** `todo-app-agent`, `feedback-hub-planner`, `executor`, a command's name. */
  name: string;
  /** What it is, in a few words: "AI session · Claude", "Executor job · implement". */
  type: string;
  project: string | null;
  projectId: string | null;
  /** Where it runs: this machine and folder, a Docker clone, another executor. */
  where: string;
  state: AgentState;
  activity: string;
  since: number | null;
  queue: number;
  /** Script agents among processes: website-agent, workers, clusters. */
  agentLike?: boolean;
  /**
   * How the page starts and stops it: a runbook unit (`unit`) through
   * /api/units, or a project process (`kind`: run, custom:…) through
   * /api/projects/:name/run|stop. Absent when the page cannot control it.
   */
  control?: { project: string; unit?: string; kind?: string; running: boolean; costs?: boolean };
  parent?: string;
  connections: AgentConnection[];
  /** Other agents on the same project. */
  related: string[];
  /** Project agents: the executor job it runs now, or ran last. */
  jobId?: string;
}

export interface RosterInputs {
  machine: string;
  executor: {
    enabled: boolean;
    executorId: string | null;
    state: string;
    lastClaimAt: number | null;
    lastError: string | null;
    running: string[];
    paused: boolean;
  };
  hub: { target: string; reachable: boolean } | null;
  signedIn: boolean;
  /** The queue is psm's own (executor/local-hub.ts), not the Werewolf hub. */
  localQueue?: boolean;
  jobs: Array<{
    kind: string;
    jobId: string;
    projectId: string;
    projectName: string;
    text: string;
    state: string;
    claimedAt: number;
    finishedAt: number | null;
    error: string | null;
    agentLines?: number;
  }>;
  /** The hub's queue, when it answered: unclaimed items and other executors' claims. */
  queue: Array<{ intakeId: string; projectId: string; status: string; text: string; claim: { executorId: string } | null }> | null;
  /**
   * The hub's implement jobs, when it answered: queued ones (with what they
   * wait for, from psm's own queue) and ones in review become sub-agents of
   * their project agent.
   */
  hubJobs?: Array<{ jobId: string; intakeId: string; projectId: string; status: string; createdAt: string; updatedAt: string; waitingFor?: { jobId: string; status: string; paths: string[] }[]; needs?: Need[]; note?: string | null; scope?: string[] | null }> | null;
  sessions: Array<{
    name: string;
    role: string;
    project: string | null;
    roomId: string | null;
    workspace: boolean;
    engine: string;
    model: string | null;
    actualModel: string | null;
    sessionShort: string;
    busy: boolean;
    open: boolean;
    waiting: boolean;
    queueDepth: number;
    lastActive: number;
    activity: string;
    folder: string;
    extraFolders: string[];
  }>;
  rooms: Array<{ id: string; title: string; projects: string[] }>;
  processes: Array<{
    name: string;
    kind: string;
    command: string;
    folder: string;
    status: string;
    exitCode: number | null;
    startedAt: number;
    port: number | null;
  }>;
  /**
   * Scripts the project runbooks classify as agents, listed even when nothing
   * runs them so the page can start them. `folder` is the base name of the
   * folder the script runs in, as processes report theirs.
   */
  scriptAgents?: Array<{
    project: string; unit: string; title: string; command: string; folder: string; summary: string | null; port: number | null; costs: boolean;
    /** Root scripts that only delegate to it (`cd server && npm run worker`), as command and folder. */
    aliases?: Array<{ command: string; folder: string }>;
  }>;
  mcpClients: Array<{ id: string; name: string; projects: string[] | "all"; revokedAt: number | null; lastUsedAt: number | null; mayRequest?: boolean; recent: Array<{ tool: string; at: number }> }>;
  projects: Array<{
    name: string;
    id?: string | null;
    customCommands?: Array<{ id: string; name: string; directory: string }>;
    attachments?: Array<{ capabilityRef: string; kind: string }>;
  }>;
  now: number;
}

const RUNNING_JOB = new Set(["claimed", "building-context", "asking-claude", "checking-answer", "posting", "preparing", "implementing", "revising"]);
const AGENT_LIKE = /(^|[^a-z])(agent|worker|cluster|bot|runner|daemon|watcher|cron)([^a-z]|$)/i;
const MCP_ACTIVE_MS = 5 * 60_000;

export const agentId = {
  executor: () => "executor",
  project: (name: string) => `project:${encodeURIComponent(name)}`,
  sub: (jobId: string) => `job:${jobId}`,
  remote: (executorId: string) => `remote:${executorId}`,
  session: (name: string) => `ai:${encodeURIComponent(name)}`,
  process: (name: string, kind: string) => `proc:${encodeURIComponent(name)}:${encodeURIComponent(kind)}`,
  mcp: (clientId: string) => `mcp:${clientId}`,
};

const shortId = (id: string) => (id.length > 14 ? `${id.slice(0, 12)}…` : id);
const engineLabel = (engine: string) => (engine === "codex" ? "Codex" : engine === "claude" ? "Claude" : engine);

function executorAgent(input: RosterInputs, waiting: number): AgentSummary {
  const ex = input.executor;
  const running = input.jobs.filter((job) => RUNNING_JOB.has(job.state) && !job.finishedAt);
  let state: AgentState = "idle";
  let activity = "Connected, waiting for tasks.";
  if (!ex.enabled) [state, activity] = ["off", "Off. Switch it on to pick up tasks from the hub."];
  else if (ex.paused) [state, activity] = ["off", "Paused by the kill switch."];
  else if (ex.state === "hub-error") [state, activity] = ["error", /sign in/i.test(ex.lastError || "") ? "Waiting for you to sign in with Werewolf." : `Hub not answering: ${ex.lastError ?? "unknown error"}`];
  else if (running.length) [state, activity] = ["working", `Working on ${running.length} job${running.length === 1 ? "" : "s"}: ${running.map((job) => job.projectName).join(", ")}.`];
  else if (ex.state === "starting") activity = "Starting.";
  const connections: AgentConnection[] = [
    // The local queue lives in this psm: nothing to reach and no account to sign in to.
    ...(input.localQueue
      ? [{ kind: "hub", label: "Queue kept in this psm", detail: "no account needed", state: "ok" } as AgentConnection]
      : [
          { kind: "hub", label: "Werewolf hub", detail: input.hub?.target ?? "not read yet", state: !input.hub ? "off" : input.hub.reachable ? "ok" : "bad" } as AgentConnection,
          { kind: "psm", label: input.signedIn ? "Signed in with Werewolf" : "Not signed in", state: input.signedIn ? "ok" : "bad" } as AgentConnection,
        ]),
    { kind: "sandbox", label: "Implement jobs run in isolated Docker clones", detail: "no network inside the container" },
    ...running.map((job): AgentConnection => (job.kind === "implement"
      ? { kind: "agent", label: `${job.projectName} sub-agent ${job.jobId.replace(/^job_/, "").slice(0, 6)}`, detail: "implement", agentId: agentId.sub(job.jobId) }
      : { kind: "agent", label: `${job.projectName}-agent`, detail: job.kind, agentId: agentId.project(job.projectName) })),
  ];
  return {
    id: agentId.executor(),
    kind: "executor",
    group: "executor",
    name: "executor",
    type: "Executor · triage and implement",
    project: null,
    projectId: null,
    where: `This machine (${input.machine})${ex.executorId ? ` · ${shortId(ex.executorId)}` : ""}`,
    state,
    activity,
    since: ex.lastClaimAt,
    queue: waiting + running.length,
    connections,
    related: [],
  };
}

/**
 * Every project has a project agent: the executor's hands on that project. It
 * stays idle until the executor claims a task for the project, works while
 * that job runs (triage as a tool-less call, implement in a Docker clone),
 * then goes idle again. Nothing runs while it is idle.
 */
const short = (jobId: string) => jobId.replace(/^job_/, "").slice(0, 6);
const oneLine = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

function projectAgents(input: RosterInputs): AgentSummary[] {
  const ex = input.executor;
  const projects = new Map<string, string | null>();
  for (const project of input.projects) projects.set(project.name, project.id ?? null);
  for (const job of input.jobs) if (!projects.has(job.projectName)) projects.set(job.projectName, job.projectId);
  const texts = new Map((input.queue ?? []).map((item) => [item.intakeId, item.text]));
  const executorUp = ex.enabled && !ex.paused;
  const out: AgentSummary[] = [];
  for (const [name, projectId] of projects) {
    const jobs = input.jobs.filter((job) => job.projectName === name).sort((a, b) => b.claimedAt - a.claimedAt);
    const running = jobs.filter((entry) => RUNNING_JOB.has(entry.state) && !entry.finishedAt);
    const triaging = running.filter((entry) => entry.kind !== "implement");
    const implementing = running.filter((entry) => entry.kind === "implement");
    const hubJobs = (input.hubJobs ?? []).filter((job) => job.projectId === projectId);
    const queued = hubJobs.filter((job) => job.status === "queued" && !implementing.some((entry) => entry.jobId === job.jobId));
    const review = hubJobs.filter((job) => job.status === "review");
    const last = jobs[0];
    const parentId = agentId.project(name);

    // Sub-agents: one per implement job on this project, each in its own clone.
    const subs: AgentSummary[] = [];
    for (const job of implementing) {
      subs.push({
        id: agentId.sub(job.jobId), kind: "sub-agent", group: "project", name: `sub-agent ${short(job.jobId)}`, type: "Sub-agent · implement",
        project: name, projectId, where: `Docker clone on this machine (${input.machine})`, state: "working",
        activity: `${job.state.replace(/-/g, " ")}: ${oneLine(job.text, 140)}`, since: job.claimedAt, queue: 0, parent: parentId,
        connections: [
          { kind: "agent", label: `${name}-agent`, detail: "spawned it for this ticket", agentId: parentId },
          { kind: "sandbox", label: "Isolated clone", detail: "branch comes back for review" },
        ],
        related: [], jobId: job.jobId,
      });
    }
    for (const job of queued) {
      const waits = job.waitingFor ?? [];
      const needs = job.needs ?? [];
      // A resume note already says what it waits for; the live list wins over it.
      const why = job.note && !needs.length ? `${job.note} ` : "";
      const activity = needs.length
        ? `${describeNeeds(needs)} ${oneLine(texts.get(job.intakeId) ?? "", 100)}`
        : waits.length
        ? `${why}Waits for ${waits.map((blocker) => `sub-agent ${short(blocker.jobId)} (${blocker.status === "review" ? "in review" : blocker.status === "claimed" ? "working" : "queued"}; ${blocker.paths.slice(0, 2).join(", ")})`).join(", ")}: ${oneLine(texts.get(job.intakeId) ?? "", 100)}`
        : `${why}Queued, starts when a slot is free: ${oneLine(texts.get(job.intakeId) ?? "", 100)}`;
      subs.push({
        id: agentId.sub(job.jobId), kind: "sub-agent", group: "project", name: `sub-agent ${short(job.jobId)}`, type: "Sub-agent · queued",
        project: name, projectId, where: `Queued on this machine (${input.machine})`, state: needs.length ? "waiting" : "idle", activity,
        since: Date.parse(job.createdAt) || null, queue: 0, parent: parentId,
        connections: [
          { kind: "agent", label: `${name}-agent`, detail: "queued it", agentId: parentId },
          ...needs.filter((need) => need.jobId).map((need): AgentConnection => ({ kind: "agent", label: `sub-agent ${short(need.jobId!)}`, detail: `must be merged first: ${need.title}`, agentId: agentId.sub(need.jobId!), state: "off" })),
          ...waits.map((blocker): AgentConnection => ({ kind: "agent", label: `sub-agent ${short(blocker.jobId)}`, detail: `overlaps on ${blocker.paths.slice(0, 3).join(", ")}`, agentId: agentId.sub(blocker.jobId), state: "off" })),
        ],
        related: [], jobId: job.jobId,
      });
    }
    for (const job of review) {
      subs.push({
        id: agentId.sub(job.jobId), kind: "sub-agent", group: "project", name: `sub-agent ${short(job.jobId)}`, type: "Sub-agent · in review",
        project: name, projectId, where: `Branch psm/job/${job.jobId} on this machine`, state: "waiting",
        activity: `${job.note ? `${job.note} ` : ""}Ready for your review: ${oneLine(texts.get(job.intakeId) ?? "", 100)}`,
        since: Date.parse(job.updatedAt) || null, queue: 0, parent: parentId,
        connections: [{ kind: "agent", label: `${name}-agent`, detail: "spawned it for this ticket", agentId: parentId }],
        related: [], jobId: job.jobId,
      });
    }

    let state: AgentState = "idle";
    let activity: string;
    let where = `This machine (${input.machine}) · called by the executor`;
    if (implementing.length || triaging.length) {
      state = "working";
      const parts: string[] = [];
      if (triaging.length) parts.push(`triaging: ${oneLine(triaging[0].text, 80)}`);
      if (implementing.length) parts.push(`${implementing.length} sub-agent${implementing.length === 1 ? "" : "s"} implementing`);
      if (queued.length) parts.push(`${queued.length} queued`);
      if (review.length) parts.push(`${review.length} in review`);
      activity = `Working: ${parts.join(" · ")}`;
      if (!implementing.length) where = `This machine (${input.machine}) · tool-less Claude call`;
    } else if (!projectId) {
      state = "off";
      activity = "Needs a stable project id (assign one on the project card) before the executor can send it tasks.";
    } else if (!executorUp) {
      state = "off";
      activity = "Off while the executor is off.";
    } else if (queued.length || review.length) {
      activity = `Idle: ${[queued.length ? `${queued.length} queued` : "", review.length ? `${review.length} waiting for your review` : ""].filter(Boolean).join(" · ")}.`;
    } else {
      activity = last ? `Idle. Last task (${last.kind}, ${last.error ? "failed" : last.state.replace(/-/g, " ")}): ${oneLine(last.text, 100)}` : "Idle. The executor calls it when a task for this project arrives.";
    }
    out.push({
      id: parentId,
      kind: "project-agent",
      group: "project",
      name: `${name}-agent`,
      type: implementing.length > 1 ? `Project agent · ${implementing.length} in parallel` : "Project agent",
      project: name,
      projectId,
      where,
      state,
      activity,
      since: running[0]?.claimedAt ?? (last ? last.finishedAt ?? last.claimedAt : null),
      queue: queued.length,
      parent: agentId.executor(),
      connections: [
        { kind: "agent", label: "executor", detail: "calls it when a task for this project arrives", agentId: agentId.executor(), state: executorUp ? "ok" : "off" },
        ...subs.map((sub): AgentConnection => ({ kind: "agent", label: sub.name, detail: sub.type.replace(/^Sub-agent · /, ""), agentId: sub.id })),
      ],
      related: [],
      ...(last ? { jobId: (running[0] ?? last).jobId } : {}),
    }, ...subs);
  }
  return out;
}

function remoteAgents(input: RosterInputs, names: Map<string, string>): AgentSummary[] {
  if (!input.queue) return [];
  const mine = input.executor.executorId;
  const byExecutor = new Map<string, typeof input.queue>();
  for (const item of input.queue) {
    const id = item.claim?.executorId;
    if (!id || id === mine || item.status !== "claimed") continue;
    byExecutor.set(id, [...(byExecutor.get(id) ?? []), item]);
  }
  return [...byExecutor].map(([executorId, items]) => {
    const projects = [...new Set(items.map((item) => names.get(item.projectId) ?? item.projectId))];
    return {
      id: agentId.remote(executorId),
      kind: "remote-executor" as const,
      group: "executor" as const,
      name: `executor ${shortId(executorId)}`,
      type: "Executor on another machine",
      project: null,
      projectId: null,
      where: `Another machine · ${shortId(executorId)}`,
      state: "working" as const,
      activity: `Triaging ${items.length} task${items.length === 1 ? "" : "s"}: ${projects.join(", ")}.`,
      since: null,
      queue: items.length,
      connections: [
        { kind: "hub" as const, label: "Werewolf hub", detail: "seen through the hub's queue", state: "ok" as const },
        ...projects.map((project) => ({ kind: "project" as const, label: project })),
      ],
      related: [],
    };
  });
}

function sessionName(session: RosterInputs["sessions"][number], rooms: Map<string, RosterInputs["rooms"][number]>): string {
  if (session.workspace) return "workspace-agent";
  if (session.roomId) return `${rooms.get(session.roomId)?.title ?? session.roomId}-room-agent`;
  // `<project>-agent` is the project agent the executor calls; the chat is `-chat`.
  const suffix = session.role === "agent" ? "chat" : session.role;
  return `${session.project ?? session.name}-${suffix}`;
}

function sessionAgents(input: RosterInputs, rooms: Map<string, RosterInputs["rooms"][number]>, attachments: Map<string, Array<{ capabilityRef: string; kind: string }>>): AgentSummary[] {
  return input.sessions.map((session) => {
    const room = session.roomId ? rooms.get(session.roomId) : undefined;
    const state: AgentState = session.waiting ? "waiting" : session.busy ? "working" : "idle";
    const model = session.actualModel || session.model || "default model";
    const connections: AgentConnection[] = [
      { kind: "model", label: `${engineLabel(session.engine)} · ${model}`, detail: session.sessionShort !== "—" ? `session ${session.sessionShort}` : "no provider session yet" },
      { kind: "repo", label: session.folder, detail: "works in this folder" },
      ...session.extraFolders.map((folder): AgentConnection => ({ kind: "repo", label: folder, detail: "also allowed to work here" })),
      ...(room ? room.projects.map((project): AgentConnection => ({ kind: "project", label: project, detail: "in this workroom" })) : []),
      ...(attachments.get(session.project ?? "") ?? []).map((attachment): AgentConnection => ({
        kind: attachment.kind === "mcp" ? "mcp" : "capability",
        label: attachment.capabilityRef,
        detail: attachment.kind === "mcp" ? "attached MCP server" : `attached ${attachment.kind}`,
      })),
    ];
    const type = session.role === "agent" ? (session.roomId ? "Workroom AI session" : session.workspace ? "Workspace AI session" : "Project AI session") : `Plan ${session.role}`;
    return {
      id: agentId.session(session.name),
      kind: "ai-session" as const,
      group: "ai" as const,
      name: sessionName(session, rooms),
      type: `${type} · ${engineLabel(session.engine)}`,
      project: session.project,
      projectId: null,
      where: `This machine (${input.machine}) · ${session.folder}${session.open ? " · open in a tab" : ""}`,
      state,
      activity: session.activity,
      since: session.lastActive || null,
      queue: session.queueDepth,
      connections,
      related: [],
    };
  });
}

const CONTROLLABLE = /^(run|custom:.+|unit:.+)$/;
type ScriptAgent = NonNullable<RosterInputs["scriptAgents"]>[number];

/** The runbook agent a process runs: started as its unit, or the same command in the same folder. */
function scriptFor(proc: RosterInputs["processes"][number], scripts: ScriptAgent[]): ScriptAgent | undefined {
  const same = (run: { command: string; folder: string }) => proc.command === run.command && proc.folder === run.folder;
  return scripts.find((script) => script.project === proc.name && (proc.kind === `unit:${script.unit}` || same(script) || (script.aliases ?? []).some(same)));
}

function processAgents(input: RosterInputs, customNames: Map<string, string>): AgentSummary[] {
  const scripts = input.scriptAgents ?? [];
  const covered = new Set<ScriptAgent>();
  const agents = input.processes.map((proc): AgentSummary => {
    const script = scriptFor(proc, scripts);
    if (script) covered.add(script);
    const custom = customNames.get(`${proc.name}\0${proc.kind}`);
    const label = custom ?? (proc.kind.startsWith("unit:") ? `${proc.name} ${proc.kind.slice(5)}` : proc.kind === "run" ? `${proc.name} run` : proc.kind.startsWith("deploy:") ? `${proc.name} ${proc.kind.replace(":", " ")}` : proc.kind.startsWith("script:") ? `${proc.name} data script` : `${proc.name} ${proc.kind}`);
    const running = proc.status === "running";
    const state: AgentState = running ? "working" : proc.status === "error" || (proc.exitCode ?? 0) !== 0 ? "error" : "stopped";
    const agentLike = !!script || AGENT_LIKE.test(`${custom ?? ""} ${proc.command}`);
    const control = !CONTROLLABLE.test(proc.kind)
      ? undefined
      : proc.kind.startsWith("unit:")
        ? { project: proc.name, unit: proc.kind.slice(5), running, ...(script?.costs ? { costs: true } : {}) }
        : { project: proc.name, kind: proc.kind, running, ...(script?.costs ? { costs: true } : {}) };
    const connections: AgentConnection[] = [
      { kind: "repo", label: proc.folder, detail: "runs in this folder" },
      ...(proc.port ? [{ kind: "port" as const, label: `localhost:${proc.port}`, state: running ? "ok" as const : "off" as const }] : []),
    ];
    return {
      id: agentId.process(proc.name, proc.kind),
      kind: "process" as const,
      group: "process" as const,
      name: label,
      type: agentLike ? "Script agent" : proc.kind.startsWith("deploy:") ? "Deploy" : "Process",
      project: proc.name,
      projectId: null,
      where: `This machine (${input.machine}) · ${proc.folder}${proc.port ? ` · :${proc.port}` : ""}`,
      state,
      activity: running ? proc.command : `Exited${proc.exitCode != null ? ` with code ${proc.exitCode}` : ""}: ${proc.command}`,
      since: proc.startedAt || null,
      queue: 0,
      agentLike,
      ...(control ? { control } : {}),
      connections,
      related: [],
    };
  });
  // Agents the runbooks know that nothing has run yet: listed off, ready to start.
  for (const script of scripts) {
    if (covered.has(script)) continue;
    agents.push({
      id: agentId.process(script.project, `unit:${script.unit}`),
      kind: "process" as const,
      group: "process" as const,
      name: `${script.project} ${script.unit}`,
      type: "Script agent",
      project: script.project,
      projectId: null,
      where: `This machine (${input.machine}) · ${script.folder}${script.port ? ` · :${script.port}` : ""}`,
      state: "off" as const,
      activity: script.summary ? `Not running. ${script.summary}` : `Not running: ${script.command}`,
      since: null,
      queue: 0,
      agentLike: true,
      control: { project: script.project, unit: script.unit, running: false, ...(script.costs ? { costs: true } : {}) },
      connections: [
        { kind: "repo" as const, label: script.folder, detail: "runs in this folder" },
        ...(script.port ? [{ kind: "port" as const, label: `localhost:${script.port}`, state: "off" as const }] : []),
      ],
      related: [],
    });
  }
  return agents;
}

function mcpAgents(input: RosterInputs, names: Map<string, string>): AgentSummary[] {
  return input.mcpClients
    .filter((client) => client.revokedAt == null)
    .map((client) => {
      const active = client.lastUsedAt != null && input.now - client.lastUsedAt < MCP_ACTIVE_MS;
      const last = client.recent[0];
      const scope = client.projects === "all" ? ["all projects"] : client.projects.map((id) => names.get(id) ?? id);
      return {
        id: agentId.mcp(client.id),
        kind: "mcp-client" as const,
        group: "mcp" as const,
        name: client.name,
        type: "MCP client calling psm",
        project: null,
        projectId: null,
        where: "Outside psm · calls this machine's /mcp",
        state: active ? "working" as const : "idle" as const,
        activity: last ? `Last call: ${last.tool}` : "No calls yet.",
        since: client.lastUsedAt,
        queue: 0,
        connections: [
          { kind: "psm" as const, label: "psm MCP endpoint", detail: client.mayRequest ? "reads, and may send requests for triage" : "read-only tools", state: "ok" as const },
          ...scope.map((label) => ({ kind: "project" as const, label, detail: "in its scope" })),
        ],
        related: [],
      };
    });
}

const ORDER: Record<AgentState, number> = { waiting: 0, working: 1, error: 2, idle: 3, stopped: 4, off: 5 };

export function buildRoster(input: RosterInputs): AgentSummary[] {
  const names = new Map(input.projects.filter((project) => project.id).map((project) => [project.id!, project.name]));
  const rooms = new Map(input.rooms.map((room) => [room.id, room]));
  const attachments = new Map(input.projects.map((project) => [project.name, project.attachments ?? []]));
  const customNames = new Map<string, string>();
  for (const project of input.projects) for (const command of project.customCommands ?? []) customNames.set(`${project.name}\0custom:${command.id}`, command.name);
  const waiting = input.queue?.filter((item) => item.status === "new").length ?? 0;

  const agents = [
    executorAgent(input, waiting),
    ...projectAgents(input),
    ...remoteAgents(input, names),
    ...sessionAgents(input, rooms, attachments),
    ...processAgents(input, customNames),
    ...mcpAgents(input, names),
  ];
  // Fill in project ids and link agents that work on the same project.
  const ids = new Map([...names].map(([id, name]) => [name, id]));
  const byProject = new Map<string, string[]>();
  for (const agent of agents) {
    if (!agent.project) continue;
    agent.projectId ??= ids.get(agent.project) ?? null;
    byProject.set(agent.project, [...(byProject.get(agent.project) ?? []), agent.id]);
  }
  for (const agent of agents) if (agent.project) agent.related = (byProject.get(agent.project) ?? []).filter((id) => id !== agent.id);
  const rank = (agent: AgentSummary) => (agent.kind === "executor" ? -1 : ORDER[agent.state]);
  return agents.sort((a, b) => rank(a) - rank(b) || (b.since ?? 0) - (a.since ?? 0));
}
