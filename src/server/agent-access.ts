/**
 * "What can the agent do here, and if not, why not?"
 *
 * Connecting an account, granting the agent access and having a working tool
 * are three different things, and a permission toggle cannot supply the other
 * two. This lists the things people ask an agent to do and gives each one
 * status with its concrete cause, from the same decision service the tools
 * use — so the Capabilities page, the agent and the tools never disagree.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { AgentPermissionStore, PermissionSnapshot } from "./agent-permissions.ts";
import type { ServerEnvironment } from "./machines/commands.ts";
import type { ProjectDatabase } from "./resources/summary.ts";

export type AccessStatus = "ready" | "needs-review" | "needs-grant" | "needs-connection" | "needs-runner" | "provider-restricted" | "unsupported";

export interface AccessItem {
  id: string;
  title: string;
  status: AccessStatus;
  /** The grant or rule that decides, when a permission is involved. */
  permission: string | null;
  detail: string;
  /** What would change the status, in the operator's terms. */
  action: string | null;
}

export interface AccessInputs {
  snapshot: PermissionSnapshot;
  store: AgentPermissionStore;
  engine: string;
  /** Git remotes configured in the checkout. */
  remotes: string[];
  /** Whether the disposable task runner (Docker + image) is usable. */
  runner: { ok: boolean; detail: string; browser?: { ok: boolean; detail: string } };
  attachedTools: number;
  servers: ServerEnvironment[];
  /** Databases this project's .env files point at, with the level set in Resources. */
  databases?: ProjectDatabase[];
}

const UNSUPPORTED: ReadonlyArray<[string, string, string]> = [
  ["local-shell", "Run arbitrary commands on this computer", "Managed agents have no shell here by design. Use a connected server's command account instead."],
];

export function explainAccess(input: AccessInputs): AccessItem[] {
  const { snapshot, store } = input;
  if (!["claude", "codex"].includes(input.engine)) {
    return [{ id: "engine", title: "Managed tools", status: "provider-restricted", permission: null, detail: `${input.engine} cannot use PSM's managed tools.`, action: "Select Claude or Codex." }];
  }
  const decided = (id: string, title: string, permission: string, context = {}, prerequisites: Array<[boolean, AccessStatus, string, string]> = []): AccessItem => {
    const decision = store.decide(snapshot, permission, context);
    if (decision.effect === "deny") {
      return { id, title, status: "needs-grant", permission, detail: decision.reason, action: decision.workspace ? "A workspace policy denies this; change it at the workspace level." : `Grant ${permission} or apply a preset in Agent permissions.` };
    }
    for (const [ok, status, detail, action] of prerequisites) if (!ok) return { id, title, status, permission, detail, action };
    if (decision.effect === "ask") return { id, title, status: "needs-review", permission, detail: decision.reason, action: "Each use waits for your review, unless you answer a review with 'always'." };
    return { id, title, status: "ready", permission, detail: decision.reason, action: null };
  };
  const hasRemote = input.remotes.length > 0;
  const items: AccessItem[] = [
    decided("read", "Read the code", "repo.read"),
    decided("edit", "Edit files", "repo.edit"),
    decided("delete", "Delete files", "repo.delete"),
    decided("commit", "Commit changes", "git.commit"),
    decided("branches", "Create, switch and merge branches", "git.branch"),
    decided("fetch", "Fetch from remotes", "git.fetch", {}, [[hasRemote, "needs-connection", "This checkout has no Git remote.", "Add a remote to the repository."]]),
    decided("push", "Push branches", "git.push", { connectionId: input.remotes[0] ?? "origin" }, [[hasRemote, "needs-connection", "This checkout has no Git remote.", "Add a remote to the repository."]]),
    decided("tests", "Run tests", "test.run", {}, [[input.runner.ok, "needs-runner", input.runner.detail, "Start Docker for the PSM user and preload the task image."]]),
    decided("build", "Build, typecheck and lint", "script.run", {}, [[input.runner.ok, "needs-runner", input.runner.detail, "Start Docker for the PSM user and preload the task image."]]),
    decided("browser", "Check rendered pages in Chromium", "script.run", {}, [[input.runner.browser?.ok ?? false, "needs-runner", input.runner.browser?.detail ?? "The browser verification image has not been checked.", "Build scripts/task-browser.Dockerfile as psm-task-browser:1.64.0 on the PSM host."]]),
    decided("install", "Install dependencies", "pkg.install", {}, [[input.runner.ok, "needs-runner", input.runner.detail, "Start Docker for the PSM user and preload the task image."]]),
    decided("attached-tools", "Use attached tools", "mcp.use", {}, [[input.attachedTools > 0, "needs-connection", "No tools are attached to this project.", "Attach a capability in Capabilities."]]),
  ];
  if (input.attachedTools > 0 && items.at(-1)!.status === "ready") {
    const calls = store.decide(snapshot, "mcp.call");
    items.push({ id: "attached-calls", title: "Call attached tools", status: calls.effect === "allow" ? "ready" : "needs-review", permission: "mcp.call", detail: calls.effect === "allow" ? calls.reason : "Each call waits for your review unless a rule allows that tool.", action: calls.effect === "allow" ? null : "Answer a call review with 'always', or grant mcp.call." });
  }
  if (!input.servers.length) {
    const decision = store.decide(snapshot, "machine.command");
    items.push({ id: "server-commands", title: "Run commands on a server", status: decision.effect === "deny" ? "needs-grant" : "needs-connection", permission: "machine.command", detail: "No server is connected to this project.", action: "Add a machine and set up command access for an environment." });
  }
  for (const server of input.servers) {
    items.push(decided(`server-commands:${server.environmentId}`, `Run commands on ${server.machine} (${server.environmentId})`, "machine.command", { environmentId: server.environmentId, connectionId: server.connectionId }));
  }
  const byPolicy = (snapshot.rules ?? []).filter((rule) => rule.permission === "deploy.approve" && rule.effect === "allow").map((rule) => rule.scope.environmentId ?? "every environment");
  if (snapshot.grants["deploy.approve"]?.granted) byPolicy.push("every environment");
  items.push({
    id: "deploy", title: "Apply infrastructure plans", status: byPolicy.length ? "ready" : "needs-review", permission: "deploy.approve",
    detail: byPolicy.length
      ? `Preparation applies plans by rule in ${[...new Set(byPolicy)].join(", ")}; plans needing an acknowledgement (every production plan) are covered only by a rule for that exact environment.`
      : "Each infrastructure plan waits for your review in Deploy.",
    action: byPolicy.length ? null : "Add a deploy.approve rule for an environment, or apply Operate staging.",
  });
  // Managed agents run with no network, so no level lets them reach a database
  // directly; the level decides what the project's Data buttons may do instead.
  for (const database of input.databases ?? []) {
    const level = database.level ?? "none";
    items.push({
      id: `database:${database.key}`,
      title: `Change ${database.label}`,
      status: "unsupported",
      permission: null,
      detail: `${database.references.join(", ")}. Access: ${database.level ? level : "not set (treated as none)"}. Managed agents have no network, so they cannot connect to it themselves.`
        + (level === "full" ? " Its scripts can run from the Data card (Preview, then Apply)." : level === "read" ? " Its scripts can be previewed from the Data card; Apply needs Full." : ""),
      action: level === "full" ? null : "Set this database's level in Resources.",
    });
  }
  for (const [id, title, detail] of UNSUPPORTED) items.push({ id, title, status: "unsupported", permission: null, detail, action: null });
  return items;
}

/**
 * Git remotes named in the checkout's config, read without running Git. In a
 * worktree `.git` is a file pointing at its gitdir, whose `commondir` leads to
 * the shared config that holds the remotes.
 */
export function configuredRemotes(checkout: string): string[] {
  try {
    const dotGit = path.join(checkout, ".git");
    let gitDir = dotGit;
    if (fs.statSync(dotGit).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"))?.[1]?.trim();
      if (!pointer) return [];
      gitDir = path.resolve(checkout, pointer);
      const common = path.join(gitDir, "commondir");
      if (fs.existsSync(common)) gitDir = path.resolve(gitDir, fs.readFileSync(common, "utf8").trim());
    }
    const config = fs.readFileSync(path.join(gitDir, "config"), "utf8");
    return [...config.matchAll(/^\[remote "([^"]+)"\]/gm)].map((match) => match[1]);
  } catch { return []; }
}

type RunnerReadiness = { ok: boolean; detail: string; browser: { ok: boolean; detail: string } };
let runnerCache: { at: number; key: string; value: RunnerReadiness } | null = null;

/** Docker reachable and both task images present, cached for a minute. */
export async function taskRunnerStatus(image = process.env.PSM_TASK_IMAGE || "node:22-bookworm-slim"): Promise<RunnerReadiness> {
  const browserImage = process.env.PSM_BROWSER_IMAGE || "psm-task-browser:1.64.0";
  const key = `${image}:${browserImage}`;
  if (runnerCache?.key === key && Date.now() - runnerCache.at < 60_000) return runnerCache.value;
  const inspect = (target: string) => new Promise<{ ok: boolean; detail: string }>(resolve => {
    execFile("docker", ["image", "inspect", "--format", "{{.Id}}", target], { timeout: 10_000 }, (error, _stdout, stderr) => {
      if (!error) resolve({ ok: true, detail: `Docker and ${target} are available.` });
      else if (/permission denied/i.test(stderr)) resolve({ ok: false, detail: "The PSM process cannot reach Docker. If you were just added to the docker group, restart PSM from a new session." });
      else if (/No such image/i.test(stderr)) resolve({ ok: false, detail: `The task image ${target} is not preloaded.` });
      else resolve({ ok: false, detail: "Docker is not available to PSM." });
    });
  });
  const [task, browser] = await Promise.all([inspect(image), inspect(browserImage)]);
  const value = { ...task, browser };
  runnerCache = { at: Date.now(), key, value };
  return value;
}
