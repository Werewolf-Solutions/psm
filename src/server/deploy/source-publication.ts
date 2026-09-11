import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { db } from "../db.ts";
import { canonicalDigest } from "./canonical.ts";
import type { SecretBroker } from "./connections.ts";
import type { ArtifactPreparationContext, DeploymentService } from "./service.ts";
import type { EffectiveDeploymentPolicy } from "./policy.ts";

export interface PublicationPlan {
  id: string; projectId: string; environmentId: string; unitId: string;
  repository: string; branch: string; commit: string; previousCommit: string;
  subject: string; changes: string; commits: string; contextDigest: string;
  policy: EffectiveDeploymentPolicy; digest: string; expiresAt: number;
  state: "pending" | "publishing" | "succeeded" | "failed" | "cancelled";
  events: { at: number; actor: string; state: string; message: string }[];
}
export interface PublicationTransport {
  remote(context: ArtifactPreparationContext, token: string): Promise<string>;
  contains(root: string, ancestor: string, descendant: string): boolean;
  describe(root: string, previous: string, commit: string): { changes: string; commits: string };
  push(context: ArtifactPreparationContext, plan: PublicationPlan, token: string): Promise<void>;
}
const gitEnv = (): NodeJS.ProcessEnv => ({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" });
function git(root: string, args: string[], env = gitEnv()): string {
  return execFileSync("/usr/bin/git", ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, maxBuffer: 1024 * 1024 }).trim();
}
async function gitAsync(root: string, args: string[], env = gitEnv()): Promise<void> {
  await promisify(execFile)("/usr/bin/git", ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], { env, encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 });
}
export const githubPublicationTransport: PublicationTransport = {
  async remote(context, token) {
    const response = await fetch(`https://api.github.com/repos/${context.unit.executor.sourceRepository}/git/ref/heads/${encodeURIComponent(context.environment.releasePolicy.allowedBranch)}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Cannot inspect the GitHub source branch (${response.status}). Verify the connection's repository access and that the branch exists.`);
    const body = await response.json() as { object?: { sha?: string } };
    if (!/^[a-f0-9]{40}$/.test(body.object?.sha ?? "")) throw new Error("GitHub returned an invalid source revision.");
    return body.object!.sha!;
  },
  contains(root, ancestor, descendant) { try { git(root, ["merge-base", "--is-ancestor", ancestor, descendant]); return true; } catch { return false; } },
  describe(root, previous, commit) { return { changes: git(root, ["diff", "--stat", "--no-ext-diff", "--no-textconv", previous, commit]), commits: git(root, ["log", "--format=%h %s", `${previous}..${commit}`]) }; },
  async push(context, plan, token) {
    // Push from a disposable bare repository. No project remotes, credential
    // helpers, URL rewrites, hooks or signing configuration reaches this process.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "psm-publish-"));
    try {
      const bundle = path.join(directory, "source.bundle");
      await gitAsync(context.project.path, ["bundle", "create", bundle, "HEAD"]);
      const bare = path.join(directory, "source.git");
      await gitAsync(directory, ["init", "--bare", bare]);
      await gitAsync(bare, ["fetch", "--no-tags", bundle, "HEAD"]);
      if (!githubPublicationTransport.contains(bare, plan.previousCommit, plan.commit)) throw new Error("Publication must fast-forward the reviewed remote commit.");
      // Exact compare-and-swap prevents a race with a remote writer. The ancestry
      // check above makes this lease a fast-forward-only publication, never a reset.
      const env = { ...gitEnv(), GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`, GIT_CONFIG_KEY_1: "http.followRedirects", GIT_CONFIG_VALUE_1: "false" };
      await gitAsync(bare, ["push", "--porcelain", `--force-with-lease=refs/heads/${plan.branch}:${plan.previousCommit}`, `https://github.com/${plan.repository}.git`, `${plan.commit}:refs/heads/${plan.branch}`], env);
    } catch { throw new Error("GitHub publication failed. Check Contents: write permission (and Workflows: write when changing workflows), branch protection and whether the remote branch changed. Nothing will retry without a new review."); }
    finally { fs.rmSync(directory, { recursive: true, force: true }); }
  },
};

export class SourcePublicationController {
  constructor(private readonly service: DeploymentService, private readonly broker: SecretBroker,
    private readonly database: () => DatabaseSync = db, private readonly transport: PublicationTransport = githubPublicationTransport) {}
  private async context(projectId: string, environmentId: string, unitId?: string) {
    const context = await this.service.sourcePublicationContext(projectId, environmentId, unitId);
    const repository = context.unit.executor.sourceRepository;
    const branch = context.environment.releasePolicy.allowedBranch;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) || branch.includes("..") || branch.endsWith("/")) throw new Error("Invalid publishing repository or branch.");
    const status = await this.broker.status(context.connection.connectionId, ["apiToken"]);
    if (status.missingSlots.length) throw new Error("The GitHub publishing credential is missing.");
    const digest = canonicalDigest("psm-source-publication-context:v1", { checkout: context.source.checkoutId, commit: context.source.commit, manifest: context.source.manifestDigest, identity: context.source.identityDigest, connection: context.connection, secretGeneration: status.generation, policy: context.policy, repository, branch });
    return { context, digest };
  }
  private save(plan: PublicationPlan): void { this.database().prepare("INSERT INTO source_publication_plans(id, document) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET document=excluded.document").run(plan.id, JSON.stringify(plan)); }
  get(id: string): PublicationPlan {
    const row = this.database().prepare("SELECT document FROM source_publication_plans WHERE id=?").get(id) as { document: string } | undefined;
    if (!row) throw new Error("Source publication review not found."); return JSON.parse(row.document);
  }
  async review(projectId: string, environmentId: string, unitId?: string): Promise<PublicationPlan | null> {
    const { context, digest } = await this.context(projectId, environmentId, unitId);
    const previousCommit = await this.broker.withLease(context.connection.connectionId, ["apiToken"], (lease) => lease.useUtf8("apiToken", (token) => this.transport.remote(context, token)));
    if (previousCommit === context.source.commit || this.transport.contains(context.project.path, context.source.commit, previousCommit)) return null;
    if (!this.transport.contains(context.project.path, previousCommit, context.source.commit)) throw new Error("The local source does not fast-forward the GitHub branch. Fetch and reconcile the branch, then review publication again.");
    const now = Date.now();
    const plan = {
      id: `pub_${randomUUID()}`, projectId: context.project.id, environmentId, unitId: context.unit.id,
      repository: context.unit.executor.sourceRepository, branch: context.environment.releasePolicy.allowedBranch,
      commit: context.source.commit, previousCommit, subject: context.source.subject,
      ...this.transport.describe(context.project.path, previousCommit, context.source.commit),
      contextDigest: digest, policy: context.policy, expiresAt: now + Math.min(context.policy.planTtlSeconds ?? 600, 600) * 1000,
      state: "pending" as const, events: [{ at: now, actor: "psm", state: "pending", message: "Publication prepared for operator review." }],
    };
    const complete = { ...plan, digest: canonicalDigest("psm-source-publication-plan:v1", plan) };
    this.save(complete); return complete;
  }
  cancel(id: string): void {
    const plan = this.get(id);
    if (plan.state !== "pending") return;
    plan.state = "cancelled"; plan.events.push({ at: Date.now(), actor: "local-operator", state: plan.state, message: "Preparation cancelled before publication." }); this.save(plan);
  }
  async approve(id: string, digest: string, actor: string): Promise<PublicationPlan> {
    const plan = this.get(id);
    if (plan.digest !== digest || plan.expiresAt <= Date.now() || plan.state !== "pending") throw new Error("Source publication review is stale or already consumed.");
    // Claim synchronously so concurrent approval requests cannot execute twice.
    plan.state = "publishing"; plan.events.push({ at: Date.now(), actor, state: plan.state, message: "Operator approved this exact publication." }); this.save(plan);
    try {
      const current = await this.context(plan.projectId, plan.environmentId, plan.unitId);
      if (current.digest !== plan.contextDigest) throw new Error("Source, connection or policy changed. Review a new publication plan.");
      await this.broker.withLease(current.context.connection.connectionId, ["apiToken"], (lease) => lease.useUtf8("apiToken", async (token) => {
        const remote = await this.transport.remote(current.context, token);
        if (remote !== plan.previousCommit) throw new Error("GitHub branch changed. Review a new publication plan.");
        await this.transport.push(current.context, plan, token);
        if (await this.transport.remote(current.context, token) !== plan.commit) throw new Error("Publication could not be verified. Inspect the remote branch before another review.");
      }));
      plan.state = "succeeded"; plan.events.push({ at: Date.now(), actor, state: plan.state, message: "The exact source commit is published and verified on GitHub." });
    } catch (error) {
      plan.state = "failed"; plan.events.push({ at: Date.now(), actor, state: plan.state, message: error instanceof Error && !("stderr" in error) ? error.message : "Publication failed. Review source and GitHub access before retrying." });
    }
    this.save(plan); return plan;
  }
}
