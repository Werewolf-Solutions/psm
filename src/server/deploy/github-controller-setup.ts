import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { GitHubActionsAdapter, type GitHubActionsConnectionMetadata } from "./adapters/github.ts";
import { COLLABORATOR_PERMISSIONS, githubAppIdentity, githubAppPages, githubAppRequest, GitHubAppTokens, type GitHubPermissions } from "./github-app.ts";
import { validateConnectionScope, type ConnectionProfile } from "./connections.ts";
import { deploymentConnectionProfile } from "./runtime-adapters.ts";
import type { DeploymentService } from "./service.ts";
import type { JsonValue } from "./store.ts";

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonValue;
const object = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
export const gitBlobSha = (text: string) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");

/** Same execution protocol; only the workflow's source credential delivery changes. */
export function appControllerBundle(target: Record<string, unknown>): Record<string, string> {
  const base = new URL("../../../docs/deploy/controller/", import.meta.url);
  const legacy = fs.readFileSync(new URL("release-static.yml", base), "utf8");
  const start = legacy.indexOf("      # Actions-read on the allowed source repositories only.");
  const end = legacy.indexOf("      - name: Download and identify", start);
  if (start < 0 || end < 0) throw new Error("Controller template no longer matches its reviewed source-token step");
  const workflow = (legacy.slice(0, start) + "      # PSM publishes a fresh, source-only installation token before this dispatch.\n" + legacy.slice(end))
    .replaceAll("${{ steps.source_token.outputs.token }}", "${{ secrets.PSM_SOURCE_READ_TOKEN }}");
  const targetId = String(target.targetId);
  if (!/^[A-Za-z0-9_:@./-]+$/.test(targetId) || targetId.includes("..")) throw new Error("Invalid controller target ID");
  return {
    ".github/workflows/release-static.yml": workflow,
    "scripts/psm_controller.py": fs.readFileSync(new URL("scripts/psm_controller.py", base), "utf8"),
    [`targets/${targetId.replace(/[:/]/g, "__")}.json`]: `${JSON.stringify(target, null, 2)}\n`,
  };
}

interface SetupPlan {
  expires: number; projectId: string; environmentId: string; repository: string; branch: string; githubEnvironment: string;
  head: string | null; repositoryMissing: boolean; files: Record<string, string>; connectionId: string; metadataRevision: number; secretGeneration: number;
  hostConnectionId: string; hostRevision: number; ciConnectionId: string; ciRevision: number; ciGeneration: number;
  contextDigest: string;
  previousSettings: string;
  /** Who can push to the controller, reviewed in place of branch protection the GitHub plan does not offer. */
  writers: string[] | null;
}

/** GitHub's reason for a 403 that a paid plan, not a permission, would lift. */
const planLimited = (error: unknown) => object(error).status === 403
  && /upgrade|make this repository public/i.test(String(object(error).reason ?? ""));

/** Plans are read-only. Apply consumes a reviewed plan and rechecks all authority snapshots. */
export class GitHubControllerSetup {
  readonly #plans = new Map<string, SetupPlan>();
  readonly #busy = new Set<string>();
  readonly #tokens: GitHubAppTokens;
  constructor(readonly service: DeploymentService, readonly fetcher = fetch, readonly now = Date.now) {
    this.#tokens = new GitHubAppTokens(service.secretBroker, fetcher, now);
  }

  #context(projectId: string, environmentId: string) {
    const context = this.service.releaseControllerUnit(projectId, environmentId);
    const bound = (slot: string) => deploymentConnectionProfile(this.service.store.getConnection(this.service.store.getConnectionBinding(context.checkoutId, environmentId, slot).connectionId));
    const github = bound(context.unit.executor.connection);
    if (!githubAppIdentity(github)) throw new Error("Connect and check a GitHub App before setting up its controller");
    const host = bound(context.unit.target.observerConnection);
    const ci = this.service.store.listConnections().filter((record) => record.readiness === "ready").map(deploymentConnectionProfile).find((profile) =>
      profile.kind === "ssh-host-helper@1" && profile.publicMetadata?.role === "ci"
      && profile.constraints.allowedProjectIds.includes(context.projectId) && profile.constraints.allowedEnvironmentIds.includes(environmentId)
      && profile.constraints.allowedTargetIds?.includes(context.unit.target.targetId)
      && profile.constraints.ssh?.host === host.constraints.ssh?.host
      && profile.constraints.ssh?.hostKeyFingerprint === host.constraints.ssh?.hostKeyFingerprint);
    if (!ci) throw new Error("Add this target's CI release key in Machines first");
    for (const profile of [host, ci]) {
      const checked = validateConnectionScope(profile, "ssh-host-helper@1", { projectId: context.projectId, environmentId,
        risk: context.environment.risk, targetId: context.unit.target.targetId, targetRoot: context.unit.target.root });
      if (!checked.ok) throw new Error(checked.issues[0].message);
    }
    if (typeof ci.publicMetadata?.knownHost !== "string" || !ci.publicMetadata.knownHost) throw new Error("CI release connection has no verified known-host entry");
    return { ...context, github, host, ci };
  }

  async #request(profile: ConnectionProfile, repository: string, suffix: string, permissions: GitHubPermissions, method = "GET", body?: unknown) {
    const token = await this.#tokens.token(profile, repository, permissions);
    return githubAppRequest(`/repos/${repository}${suffix}`, token, method, body, this.fetcher);
  }

  #previousController(github: ConnectionProfile, repository: string, targetId: string, projectId: string, environmentId: string) {
    const bound = (github.publicMetadata?.releaseControllers as Array<Record<string, any>> || [])
      .find((entry) => entry.repository === repository && entry.targetId === targetId);
    if (bound) return bound;
    const candidates = this.service.store.listConnections().filter((record) => record.kind === "github-actions@1")
      .map(deploymentConnectionProfile)
      .filter((profile) => profile.constraints.allowedProjectIds.includes(projectId)
        && profile.constraints.allowedEnvironmentIds.includes(environmentId)
        && profile.constraints.allowedRepositories?.includes(repository))
      .flatMap((profile) => (profile.publicMetadata?.releaseControllers as Array<Record<string, any>> || []))
      .filter((entry) => entry.repository === repository && entry.targetId === targetId);
    if (new Set(candidates.map((entry) => this.#settings(entry))).size > 1)
      throw new Error("Existing controller connections disagree on the branch or environment; resolve their settings before migration");
    return candidates[0];
  }

  #settings(controller: Record<string, any> | undefined): string {
    return JSON.stringify(controller ? { ref: controller.ref, githubEnvironment: controller.githubEnvironment,
      workflow: controller.workflow, workflowPath: controller.workflowPath } : null);
  }

  #appPages(profile: ConnectionProfile) {
    return githubAppPages(profile);
  }

  #accessError(profile: ConnectionProfile, repository: string): Error {
    return new Error(`The GitHub App cannot access ${repository}. Open Manage App repositories, add this repository and save, then review controller setup again. An inaccessible repository is not a missing repository. Add it at ${this.#appPages(profile).installation}`);
  }

  /**
   * The branch's protection, or `unavailable` when the repository's GitHub plan has none
   * to offer (a private repository on GitHub Free). Then the reviewed commit pin and the
   * reviewed set of people who can push stand in for it.
   */
  async #protection(profile: ConnectionProfile, repository: string, branch: string): Promise<{ protection: Record<string, any> | null; unavailable: boolean }> {
    let protection: Record<string, any> | null = null;
    try { protection = await this.#request(profile, repository, `/branches/${encodeURIComponent(branch)}/protection`, { administration: "read" }); }
    catch (error) {
      // GitHub answers 403 both for a plan without branch protection and for a missing permission; its reason tells them apart.
      if (planLimited(error)) return { protection: null, unavailable: true };
      if (object(error).status === 403) {
        const pages = this.#appPages(profile);
        throw new Error(`GitHub refused the App access to branch protection on ${repository}${object(error).reason ? ` (GitHub: "${String(object(error).reason)}")` : ""}. Grant Administration: Read and write at ${pages.permissions}, accept the new permission at ${pages.installation}, then review controller setup again.`);
      }
      if (object(error).status !== 404) throw error;
    }
    if (protection && (!protection.enforce_admins?.enabled || protection.allow_force_pushes?.enabled || protection.allow_deletions?.enabled))
      throw new Error("Existing branch protection needs review: enforce administrators and disable force pushes/deletion; PSM preserves your existing rules");
    return { protection, unavailable: false };
  }

  /**
   * Everyone who can push to the repository, directly, through a team or as an
   * organization owner. A repository always has someone who can push, so an
   * empty answer means the App cannot see them; that is refused, never recorded.
   */
  async #writers(profile: ConnectionProfile, repository: string): Promise<string[]> {
    const pages = this.#appPages(profile);
    const grant = `Grant the App Organization permissions → Members: Read at ${pages.permissions}, accept the new permission at ${pages.installation}, then review controller setup again.`;
    let people: unknown;
    try { people = await this.#request(profile, repository, "/collaborators?affiliation=all&per_page=100", COLLABORATOR_PERMISSIONS); }
    catch (error) {
      if (/not granted|permission/i.test(error instanceof Error ? error.message : String(error)) || [403, 422].includes(Number(object(error).status))) {
        throw new Error(`The GitHub App cannot list who can push to ${repository}. ${grant}`);
      }
      throw error;
    }
    if (!Array.isArray(people)) throw new Error("GitHub returned no collaborator list for the controller");
    if (people.length >= 100) throw new Error("The controller repository has too many collaborators to review; give it a smaller audience first");
    const writers = people.filter((person: any) => person?.permissions?.push === true).map((person: any) => String(person.login)).sort();
    if (!writers.length) throw new Error(`GitHub showed the App nobody who can push to ${repository}, which means it cannot see the organization's members. ${grant}`);
    return writers;
  }

  async #head(profile: ConnectionProfile, repository: string, branch: string): Promise<string | null> {
    try {
      const result = await this.#request(profile, repository, `/git/ref/heads/${encodeURIComponent(branch)}`, { contents: "read" });
      if (!/^[a-f0-9]{40}$/.test(result.object?.sha)) throw new Error("GitHub returned no controller branch commit");
      return result.object.sha;
    } catch (error) {
      if ([404, 422].includes(Number(object(error).status))) return null;
      throw error;
    }
  }

  async #tree(profile: ConnectionProfile, repository: string, head: string) {
    const result = await this.#request(profile, repository, `/git/trees/${head}?recursive=1`, { contents: "read" });
    if (result.truncated || !Array.isArray(result.tree)) throw new Error("Controller tree cannot be verified completely");
    return result.tree as Array<{ path: string; sha: string; mode: string; type: string }>;
  }

  async preview(projectId: string, environmentId: string) {
    const context = this.#context(projectId, environmentId);
    const { github, host, ci, unit } = context;
    const setup = object(github.publicMetadata?.githubAppSetup);
    const repository = String(setup.controllerRepository || "");
    if (!github.constraints.allowedRepositories?.includes(repository) || repository === unit.executor.sourceRepository) throw new Error("The controller must be a separate approved repository");
    const otherTargets = this.service.store.listConnections().filter((record) => record.kind === "github-actions@1")
      .flatMap((record) => (deploymentConnectionProfile(record).publicMetadata?.releaseControllers as Array<Record<string, any>> | undefined) || [])
      .filter((entry) => entry.repository === repository && entry.targetId !== unit.target.targetId);
    if (otherTargets.length) throw new Error("This controller repository also serves another target. Give this target a dedicated controller repository before changing its workflow");
    const previous = this.#previousController(github, repository, unit.target.targetId, context.projectId, environmentId);
    let repositoryInfo: Record<string, any> = {};
    let repositoryMissing = false;
    try { repositoryInfo = await this.#request(github, repository, "", { metadata: "read" }); }
    catch (error) {
      if (previous && [403, 404, 422].includes(Number(object(error).status))) throw this.#accessError(github, repository);
      if (![404, 422].includes(Number(object(error).status))) throw error;
      // An installation scoped to the source cannot mint a controller token yet.
      // A source-only token can distinguish a public existing repository from a
      // missing one; private inaccessible repositories remain a safe create conflict.
      const token = await this.#tokens.token(github, unit.executor.sourceRepository, { metadata: "read" });
      try { repositoryInfo = await githubAppRequest(`/repos/${repository}`, token, "GET", undefined, this.fetcher); }
      catch (checkError) {
        if (object(checkError).status !== 404) throw checkError;
        repositoryMissing = true;
      }
    }
    if (!repositoryMissing && !repositoryInfo.default_branch) throw new Error("Install the App on the controller repository and review again");
    const branch = previous?.ref?.replace(/^refs\/heads\//, "") || repositoryInfo.default_branch || "main";
    if (!/^[A-Za-z0-9_-]+$/.test(branch)) throw new Error("Use a simple controller branch name");
    const githubEnvironment = previous?.githubEnvironment || unit.target.targetId.replace(/[:/]/g, "-");
    const contract = object(object(host.publicMetadata?.targetContracts)[unit.target.targetId]);
    if (!contract.revision || !/^sha256:[a-f0-9]{64}$/.test(contract.fingerprint) || !ci.constraints.ssh) throw new Error("Enroll and pin the host target first");
    const files = appControllerBundle({ schema: "psm.werewolf.solutions/control-target/v1", targetId: unit.target.targetId,
      contractRevision: contract.revision, githubEnvironment, sshHost: ci.constraints.ssh.host, sshUser: ci.constraints.ssh.user,
      sshPort: ci.constraints.ssh.port, hostKeyFingerprint: ci.constraints.ssh.hostKeyFingerprint, canonicalRoot: unit.target.root,
      helperProtocol: "psm.werewolf.solutions/host-helper-request/v1" });
    const head = repositoryMissing ? null : await this.#head(github, repository, branch);
    if (!repositoryMissing && !head) throw new Error("The controller branch is missing; review its repository before setup");
    const unprotectable = head ? (await this.#protection(github, repository, branch)).unavailable : false;
    const writers = unprotectable ? await this.#writers(github, repository) : null;
    const tree = head ? await this.#tree(github, repository, head) : [];
    if (tree.some((entry) => entry.path.startsWith(".github/workflows/") && entry.type === "blob" && entry.path !== ".github/workflows/release-static.yml")) throw new Error("The controller has additional workflows. Review/remove them before giving this repository deployment credentials.");
    const changes = [];
    for (const [name, after] of Object.entries(files)) {
      const entry = tree.find((item) => item.path === name);
      if (entry?.sha === gitBlobSha(after) && entry.mode === "100644") continue;
      let before: string | null = null;
      if (entry) {
        if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) throw new Error(`Unexpected controller entry ${name}`);
        const blob = await this.#request(github, repository, `/git/blobs/${entry.sha}`, { contents: "read" });
        if (blob.encoding !== "base64" || typeof blob.content !== "string") throw new Error("Cannot read controller file for review");
        before = Buffer.from(blob.content, "base64").toString("utf8");
      }
      changes.push({ path: name, before, after, sha: gitBlobSha(after) });
    }
    for (const [id, value] of this.#plans) if (value.expires <= this.now()) this.#plans.delete(id);
    if (this.#plans.size >= 32) throw new Error("Too many setup previews; wait for an earlier preview to expire");
    const id = randomBytes(24).toString("hex");
    this.#plans.set(id, { expires: this.now() + 600_000, projectId: context.projectId, environmentId, repository, branch, githubEnvironment, head, repositoryMissing, files,
      connectionId: github.connectionId, metadataRevision: Number(github.metadataRevision), secretGeneration: this.service.store.getConnection(github.connectionId).secretGeneration,
      hostConnectionId: host.connectionId, hostRevision: Number(host.metadataRevision), ciConnectionId: ci.connectionId, ciRevision: Number(ci.metadataRevision),
      ciGeneration: this.service.store.getConnection(ci.connectionId).secretGeneration,
      previousSettings: this.#settings(previous), writers,
      contextDigest: createHash("sha256").update(JSON.stringify([context.unit, context.environment.risk, context.environment.releasePolicy])).digest("hex") });
    const guard = writers
      ? [`Branch protection is not part of ${repository}'s GitHub plan, so PSM guards it instead: releases run only at the commit pinned here, and are refused if anyone other than ${writers.join(", ") || "nobody"} can push to it`,
        "Restrict the target environment to this branch where the plan allows it"]
      : ["Protect the controller branch", "Restrict the target environment to this branch"];
    return { id, repository, branch, githubEnvironment, head, changes, expiresAt: this.now() + 600_000, writers,
      actions: [head ? "Update reviewed controller files" : "Repository is unavailable to this App; attempt to create it only if absent (an existing private repository must be added to the App)", ...guard, "Publish the CI release key and known host", "Verify the complete bundle and pin its commit"] };
  }

  async apply(id: string, projectId: string, environmentId: string) {
    const plan = this.#plans.get(id);
    if (!plan || plan.expires <= this.now() || plan.projectId !== this.service.resolveProject(projectId).id || plan.environmentId !== environmentId) throw new Error("Controller setup preview expired; review again");
    if (this.#busy.has(plan.repository)) throw new Error("Controller setup is already running");
    this.#busy.add(plan.repository); this.#plans.delete(id);
    try {
      const context = this.#context(projectId, environmentId);
      const { github, host, ci, unit } = context;
      if (plan.previousSettings !== this.#settings(this.#previousController(github, plan.repository, unit.target.targetId, context.projectId, environmentId)))
        throw new Error("Existing controller settings changed; review setup again");
      if (plan.contextDigest !== createHash("sha256").update(JSON.stringify([context.unit, context.environment.risk, context.environment.releasePolicy])).digest("hex")) throw new Error("Deployment settings changed; review controller setup again");
      if (github.connectionId !== plan.connectionId || github.metadataRevision !== plan.metadataRevision || host.connectionId !== plan.hostConnectionId || host.metadataRevision !== plan.hostRevision
        || ci.connectionId !== plan.ciConnectionId || ci.metadataRevision !== plan.ciRevision
        || this.service.store.getConnection(ci.connectionId).secretGeneration !== plan.ciGeneration
        || this.service.store.getConnection(github.connectionId).secretGeneration !== plan.secretGeneration) throw new Error("Connections changed; review controller setup again");
      let head: string | null;
      if (plan.repositoryMissing) {
        const token = await this.#tokens.token(github, unit.executor.sourceRepository, { metadata: "read" });
        try { await githubAppRequest(`/repos/${plan.repository}`, token, "GET", undefined, this.fetcher); throw new Error("Controller repository appeared; review setup again"); }
        catch (error) { if (object(error).status !== 404) throw error; }
        head = null;
      } else {
        head = await this.#head(github, plan.repository, plan.branch);
        if (head !== plan.head) throw new Error("Controller branch changed; review setup again");
      }
      if (plan.repositoryMissing) {
        const setup = object(github.publicMetadata?.githubAppSetup);
        if (setup.accountKind !== "organization") throw new Error("Personal accounts must create an empty controller repository on GitHub and install the App on it first");
        const token = await this.#tokens.token(github, unit.executor.sourceRepository, { administration: "write" });
        let createdRepo: Record<string, any>;
        try {
          createdRepo = await githubAppRequest(`/orgs/${githubAppIdentity(github)!.owner}/repos`, token, "POST", { name: plan.repository.split("/")[1], private: true, auto_init: true, description: "PSM reviewed release controller" }, this.fetcher);
        } catch (error) {
          if (object(error).status === 422) throw new Error(`GitHub refused to create ${plan.repository} (HTTP 422). It may already exist without App access. Open Manage App repositories and add it if present, or check the organisation's repository creation rules, then review again.`);
          throw error;
        }
        if (createdRepo.default_branch && createdRepo.default_branch !== plan.branch) {
          const defaultHead = await this.#head(github, plan.repository, createdRepo.default_branch);
          if (!defaultHead) throw new Error("Repository created; install the App on it and review controller setup again");
          await this.#request(github, plan.repository, "/git/refs", { contents: "write" }, "POST", { ref: `refs/heads/${plan.branch}`, sha: defaultHead });
        }
        try { head = await this.#head(github, plan.repository, plan.branch); }
        catch (error) {
          if ([403, 404, 422].includes(Number(object(error).status))) throw new Error("Repository created. Install the App on the controller repository, then review setup again.");
          throw error;
        }
        if (!head) throw new Error("Repository created. Install the App on the controller repository and ensure its default branch is main, then review setup again.");
      }
      if (!head) throw new Error("Controller branch is unavailable; review setup again");
      // Check permissions and existing protection before changing the controller files.
      const { protection, unavailable: unprotectable } = await this.#protection(github, plan.repository, plan.branch);
      const writers = unprotectable ? await this.#writers(github, plan.repository) : null;
      // The people who can push were part of what was reviewed; a change since then needs a new review.
      // A repository created during apply had nobody to review yet; its writers are recorded as found.
      if (plan.head && JSON.stringify(writers) !== JSON.stringify(plan.writers))
        throw new Error(`Push access to ${plan.repository} changed since review (now: ${writers?.join(", ") || "branch protection available"}). Review controller setup again.`);
      const currentTree = await this.#tree(github, plan.repository, head);
      if (currentTree.some((entry) => entry.path.startsWith(".github/workflows/") && entry.type === "blob" && entry.path !== ".github/workflows/release-static.yml")) throw new Error("Unexpected workflow appeared; review the controller");
      const needsCommit = Object.entries(plan.files).some(([name, text]) => !currentTree.some((entry) => entry.path === name && entry.sha === gitBlobSha(text) && entry.mode === "100644"));
      if (needsCommit) {
        const commit = await this.#request(github, plan.repository, `/git/commits/${head}`, { contents: "read" });
        const tree = await this.#request(github, plan.repository, "/git/trees", { contents: "write", workflows: "write" }, "POST", {
          base_tree: commit.tree.sha, tree: Object.entries(plan.files).map(([name, content]) => ({ path: name, mode: "100644", type: "blob", content })) });
        const created = await this.#request(github, plan.repository, "/git/commits", { contents: "write", workflows: "write" }, "POST", { message: "Update reviewed PSM controller bundle", tree: tree.sha, parents: [head] });
        await this.#request(github, plan.repository, `/git/refs/heads/${encodeURIComponent(plan.branch)}`, { contents: "write", workflows: "write" }, "PATCH", { sha: created.sha, force: false });
        head = String(created.sha);
      }
      const protectionPath = `/branches/${encodeURIComponent(plan.branch)}/protection`;
      if (!protection && !unprotectable) {
        await this.#request(github, plan.repository, protectionPath, { administration: "write" }, "PUT", {
          required_status_checks: null, enforce_admins: true, required_pull_request_reviews: null, restrictions: null, allow_force_pushes: false, allow_deletions: false });
      }
      const envPath = `/environments/${encodeURIComponent(plan.githubEnvironment)}`;
      let currentEnvironment: Record<string, any> = {};
      // GitHub files reading an environment and its branch policies under Actions, not Environments (secrets and variables only).
      try { currentEnvironment = await this.#request(github, plan.repository, envPath, { actions: "read" }); } catch (error) { if (object(error).status !== 404) throw error; }
      const rules = Array.isArray(currentEnvironment.protection_rules) ? currentEnvironment.protection_rules : [];
      if (rules.some((rule: any) => !["required_reviewers", "wait_timer", "branch_policy"].includes(rule.type)))
        throw new Error("The controller environment has protection rules PSM cannot preserve; review them on GitHub first");
      if (currentEnvironment.deployment_branch_policy?.custom_branch_policies) {
        const existing = await this.#request(github, plan.repository, `${envPath}/deployment-branch-policies`, { actions: "read" });
        if (!Array.isArray(existing.branch_policies) || existing.branch_policies.some((item: any) => item.name !== plan.branch || item.type !== "branch"))
          throw new Error("Environment allows other refs; review its branch policies before applying setup");
      }
      const reviewers = rules.find((rule: any) => rule.type === "required_reviewers");
      const environmentSettings = {
        can_admins_bypass: currentEnvironment.can_admins_bypass ?? false,
        ...(reviewers ? { reviewers: reviewers.reviewers.map((entry: any) => ({ type: entry.type, id: entry.reviewer.id })), prevent_self_review: reviewers.prevent_self_review } : {}),
        ...(rules.find((rule: any) => rule.type === "wait_timer") ? { wait_timer: rules.find((rule: any) => rule.type === "wait_timer").wait_timer } : {}),
      };
      let branchRestricted = true;
      try {
        await this.#request(github, plan.repository, envPath, { administration: "write" }, "PUT", {
          deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }, ...environmentSettings });
      } catch (error) {
        // Without branch protection the plan has no deployment branch rules either; the
        // reviewed writers check covers the same ground, so the environment is kept as is.
        if (!unprotectable || ![403, 422].includes(Number(object(error).status))) throw error;
        branchRestricted = false;
        await this.#request(github, plan.repository, envPath, { administration: "write" }, "PUT", environmentSettings);
      }
      if (branchRestricted) {
        const policies = await this.#request(github, plan.repository, `${envPath}/deployment-branch-policies`, { actions: "read" });
        const branches = policies.branch_policies || [];
        if (branches.some((item: any) => item.name !== plan.branch || item.type !== "branch")) throw new Error("Environment allows other refs; review its branch policies before pinning");
        if (!branches.length) await this.#request(github, plan.repository, `${envPath}/deployment-branch-policies`, { administration: "write" }, "POST", { name: plan.branch, type: "branch" });
      }
      const verifiedTree = await this.#tree(github, plan.repository, head);
      for (const [name, text] of Object.entries(plan.files)) if (!verifiedTree.some((entry) => entry.path === name && entry.mode === "100644" && entry.sha === gitBlobSha(text))) throw new Error(`Controller file verification failed: ${name}`);
      if (await this.#head(github, plan.repository, plan.branch) !== head) throw new Error("Controller branch moved before pinning");
      const controller = { controller: "werewolf-static@1", sourceAuthorization: "installation-token", targetId: unit.target.targetId, repository: plan.repository,
        workflow: "release-static.yml", workflowPath: ".github/workflows/release-static.yml", ref: `refs/heads/${plan.branch}`, expectedHeadSha: head,
        expectedWorkflowBlobSha: gitBlobSha(plan.files[".github/workflows/release-static.yml"]), githubEnvironment: plan.githubEnvironment, allowedSourceRepositories: [unit.executor.sourceRepository],
        ...(writers ? { branchProtection: "unavailable-on-plan", reviewedWriters: writers } : {}) };
      const publicMetadata = { ...github.publicMetadata, releaseControllers: [...(github.publicMetadata?.releaseControllers as any[] || []).filter((entry) => entry.targetId !== unit.target.targetId), controller] };
      const adapter = new GitHubActionsAdapter({ metadata: publicMetadata as unknown as GitHubActionsConnectionMetadata, fetch: this.fetcher,
        token: () => this.#tokens.token(github, plan.repository, { environments: "write" }) });
      await this.service.secretBroker.withLease(ci.connectionId, ["privateKey"], (lease) => lease.useUtf8("privateKey", (key) =>
        adapter.publishEnvironmentSecrets(unit.target.targetId, { PSM_TARGET_SSH_PRIVATE_KEY: key, PSM_TARGET_KNOWN_HOSTS: `${ci.publicMetadata?.knownHost}\n` })));
      const record = this.service.store.getConnection(github.connectionId);
      this.service.store.updateConnection({ connectionId: record.connectionId, expectedMetadataRevision: plan.metadataRevision, label: record.label,
        metadata: json({ ...object(record.metadata), publicMetadata }), constraints: record.constraints, readiness: record.readiness,
        secretGeneration: record.secretGeneration, updatedAt: this.now() });
      return { repository: plan.repository, headSha: head, githubEnvironment: plan.githubEnvironment, pinned: true };
    } finally { this.#busy.delete(plan.repository); }
  }
}
