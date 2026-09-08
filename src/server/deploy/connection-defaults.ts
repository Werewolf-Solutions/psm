import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { validateConnectionScope, type ConnectionProfile } from "./connections.ts";
import type { EnvironmentManifest } from "./types.ts";

const run = promisify(execFile);
interface ProjectLocation { id?: string | null; name: string; path: string }
export interface ConnectionDefaults {
  values: Record<string, string>;
  sources: Record<string, string>;
  notes: string[];
}

/**
 * `status` says why a pin is absent, so the form can name the obstacle instead of
 * teaching git commands for a repository the operator may not even have yet.
 */
export interface GitHubDefaults {
  ref?: string;
  commit?: string;
  blob?: string;
  environments?: readonly string[];
  status?: "ok" | "repository-missing" | "workflow-missing" | "unreadable";
}
const githubCache = new Map<string, { expires: number; result: Promise<GitHubDefaults> }>();
const objectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Use the operator's existing GitHub CLI login for read-only metadata, when available. */
export function readGitHubDefaults(repo: string, workflow: string, ref?: string): Promise<GitHubDefaults> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo) || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/.test(workflow)) return Promise.resolve({});
  const key = JSON.stringify([repo, workflow, ref]);
  const cached = githubCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.result;
  const api = async (endpoint: string, projection: string) => {
    try {
      const response = await run("gh", ["api", "--hostname", "github.com", endpoint, "--jq", projection], {
        timeout: 4_000, maxBuffer: 64 * 1024, encoding: "utf8",
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" },
      });
      return { ok: true, absent: false, value: response.stdout.trim() };
    } catch (error) {
      const reported = `${(error as { stderr?: unknown }).stderr ?? ""}`;
      return { ok: false, absent: /HTTP 404/.test(reported), value: "" };
    }
  };
  const result = (async (): Promise<GitHubDefaults> => {
    const found = await api(`repos/${repo}`, ".default_branch");
    if (!found.ok) return { status: found.absent ? "repository-missing" : "unreadable" };
    const selectedRef = ref || found.value;
    if (!selectedRef || selectedRef === "null") return { status: "unreadable" };
    // The environment list is independent of the pins, so one round trip serves both.
    const [head, environmentNames] = await Promise.all([
      api(`repos/${repo}/commits/${encodeURIComponent(selectedRef)}`, ".sha"),
      api(`repos/${repo}/environments`, ".environments[]?.name"),
    ]);
    const environments = environmentNames.value.split("\n").map((name) => name.trim()).filter(Boolean);
    if (!objectId.test(head.value)) return { status: "unreadable", environments };
    const file = await api(`repos/${repo}/contents/.github/workflows/${encodeURIComponent(workflow)}?ref=${head.value}`, '. | select(.type == "file") | .sha');
    if (!objectId.test(file.value)) {
      return { status: file.absent ? "workflow-missing" : "unreadable", ref: selectedRef, commit: head.value, environments };
    }
    return { status: "ok", ref: selectedRef, commit: head.value, blob: file.value, environments };
  })();
  if (githubCache.size >= 64) githubCache.delete(githubCache.keys().next().value!);
  githubCache.set(key, { expires: Date.now() + 60_000, result });
  return result;
}

async function git(root: string, args: string[]): Promise<string> {
  try {
    const result = await run("git", ["-C", root, ...args], { timeout: 2_000, maxBuffer: 64 * 1024, encoding: "utf8" });
    return result.stdout.trim();
  } catch { return ""; }
}

function repository(remote: string): string {
  const match = remote.match(/^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return match?.[1].toLowerCase() ?? "";
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Suggestions are public settings only. Nothing is saved or authorized during discovery. */
export async function discoverConnectionDefaults(input: {
  project: ProjectLocation & { id: string };
  projects: readonly ProjectLocation[];
  environment: EnvironmentManifest;
  slot: string;
  profiles: readonly ConnectionProfile[];
  boundConnectionId?: string | null;
  github?: (repo: string, workflow: string, ref?: string) => Promise<GitHubDefaults>;
}): Promise<ConnectionDefaults> {
  const { environment, slot } = input;
  const kind = environment.connections[slot].kind;
  const result: ConnectionDefaults = { values: {}, sources: {}, notes: [] };
  const set = (key: string, value: unknown, source: string) => {
    if ((typeof value === "string" && value) || typeof value === "number") {
      result.values[key] = String(value);
      result.sources[key] = source;
    }
  };
  set("label", `${input.project.name} · ${environment.id} · ${slot}`, "Project and deployment environment");
  const targets = [...new Map(environment.units.filter((unit) => unit.target.observerConnection === slot).map((unit) => [unit.target.targetId, unit.target])).values()];
  const scopes = [{ projectId: input.project.id, environmentId: environment.id, risk: environment.risk }];
  const compatible = input.profiles.filter((profile) => scopes.every((scope) => validateConnectionScope(profile, kind, scope).ok));
  const bound = compatible.find((profile) => profile.connectionId === input.boundConnectionId);
  const candidates = compatible.filter((profile) => targets.every((target) => profile.constraints.allowedTargetIds?.includes(target.targetId)));
  const saved = bound ?? (candidates.length === 1 ? candidates[0] : undefined);
  const savedSource = saved ? `Saved connection: ${saved.name}` : "";

  if (kind === "ssh-host-helper@1" && saved) {
    for (const key of ["host", "user", "port", "hostKeyFingerprint"] as const) set(key, saved.constraints.ssh?.[key], savedSource);
    set("address", saved.publicMetadata?.address, savedSource);
    set("knownHost", saved.publicMetadata?.knownHost, savedSource);
    const contracts = object(saved.publicMetadata?.targetContracts);
    targets.forEach((target, i) => {
      const contract = object(contracts[target.targetId]);
      set(`fingerprint${i}`, contract.fingerprint, savedSource);
      set(`revision${i}`, contract.revision, savedSource);
    });
  }
  if (kind !== "github-actions@1") return result;

  const units = environment.units.filter((unit) => unit.executor.connection === slot);
  const targetIds = [...new Set(units.map((unit) => unit.target.targetId))];
  const configured = Array.isArray(saved?.publicMetadata?.releaseControllers) ? saved.publicMetadata.releaseControllers.map(object) : [];
  const controllers = targetIds.map((targetId) => configured.find((controller) => controller.targetId === targetId));
  const first = controllers.find((controller) => controller);
  const common = first && controllers.filter(Boolean).every((controller) => ["repository", "workflow", "ref", "expectedHeadSha", "expectedWorkflowBlobSha"].every((key) => controller?.[key] === first[key]));
  if (first && !common) {
    result.notes.push("The saved profile uses different release workflows for these targets. Use Advanced JSON to retain that configuration.");
    return result;
  }
  // The documented werewolf-static@1 mapping, editable before the profile is created.
  set("controllerRepository", "Werewolf-Solutions/deployment-control", "PSM static release controller default");
  set("controllerWorkflow", "release-static.yml", "PSM static release controller default");
  targetIds.forEach((targetId, i) => {
    set(`githubEnvironment${i}`, targetId.startsWith("werewolf:") ? targetId.slice("werewolf:".length) : environment.id, "Suggested from the deployment target; change if your GitHub Environment has a different name");
    set(`githubEnvironment${i}`, controllers[i]?.githubEnvironment, savedSource);
  });
  if (first) {
    for (const [field, key] of Object.entries({ controllerRepository: "repository", controllerWorkflow: "workflow", controllerRef: "ref", controllerSha: "expectedHeadSha", workflowSha: "expectedWorkflowBlobSha" })) set(field, first[key], savedSource);
  }

  const repo = result.values.controllerRepository;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo)) {
    result.notes.push("Check the saved release repository: it must use owner/repository format.");
    return result;
  }
  const repoName = repo.split("/")[1].toLowerCase();
  const locations = input.projects.filter((project) => project.name.toLowerCase() === repoName || path.basename(project.path).toLowerCase() === repoName);
  const matches = await Promise.all(locations.map(async (project) => repository(await git(project.path, ["config", "--get", "remote.origin.url"])) === repo.toLowerCase() ? project : null));
  const checkouts = matches.filter((project): project is ProjectLocation => project !== null);
  const checkout = checkouts.length === 1 ? checkouts[0] : null;
  if (checkout && (!result.values.controllerSha || !result.values.workflowSha)) {
    const source = `Local checkout of ${repo}; review before saving`;
    if (!result.values.controllerRef) {
      const tags = (await git(checkout.path, ["tag", "--points-at", "HEAD"])).split("\n").filter(Boolean);
      const ref = tags.length === 1 ? `refs/tags/${tags[0]}` : await git(checkout.path, ["symbolic-ref", "--quiet", "HEAD"]);
      set("controllerRef", ref, source);
    }
    const ref = result.values.controllerRef;
    const workflow = result.values.controllerWorkflow;
    if (ref && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) && !ref.includes("..") && /^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/.test(workflow)) {
      const commit = await git(checkout.path, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
      if (objectId.test(commit)) {
        const entry = await git(checkout.path, ["ls-tree", commit, "--", `.github/workflows/${workflow}`]);
        const blob = entry.match(/^100644 blob ([0-9a-f]{40}|[0-9a-f]{64})\t/);
        if (blob) {
          // Preserve reviewed pins from saved profiles even if the local branch has moved.
          if (!result.values.controllerSha) set("controllerSha", commit, source);
          if (!result.values.workflowSha && (!result.values.controllerSha || result.values.controllerSha === commit)) set("workflowSha", blob[1], source);
        } else result.notes.push(`The release workflow ${workflow} was not found at ${ref} in the local controller checkout.`);
      }
    }
  }

  // GitHub completes whatever is still unknown, and is the only source of Environment names.
  const needsPins = !result.values.controllerSha || !result.values.workflowSha;
  const unnamed = targetIds.filter((_, i) => !controllers[i]?.githubEnvironment);
  const remote = needsPins || unnamed.length
    ? await (input.github ?? readGitHubDefaults)(repo, result.values.controllerWorkflow, result.values.controllerRef)
    : {};
  if (needsPins) {
    const source = `GitHub: ${repo}; review before saving`;
    if (!result.values.controllerRef) set("controllerRef", remote.ref, source);
    if (!result.values.controllerSha) set("controllerSha", remote.commit, source);
    if (!result.values.workflowSha && result.values.controllerSha === remote.commit) set("workflowSha", remote.blob, source);
  }
  const known = remote.environments ?? [];
  if (known.length) {
    targetIds.forEach((targetId, i) => {
      if (controllers[i]?.githubEnvironment) return;
      const derived = result.values[`githubEnvironment${i}`];
      const verified = known.includes(derived) ? derived : known.length === 1 ? known[0] : "";
      if (verified) set(`githubEnvironment${i}`, verified, `GitHub: Environment configured in ${repo}`);
      else result.notes.push(`${repo} has no Environment named ${derived}. It configures: ${known.join(", ")}.`);
    });
  }
  if (!result.values.controllerSha || !result.values.workflowSha) {
    // Name the obstacle. PSM pins the controller itself; the operator never computes a hash.
    result.notes.push({
      "repository-missing": `The release controller repository ${repo} does not exist yet. Create it, or name a different release repository, and PSM will pin its release ref and hashes for you.`,
      "workflow-missing": `${repo} has no .github/workflows/${result.values.controllerWorkflow} at its release ref, so there is nothing to pin yet.`,
      "ok": `PSM could not pin every release setting from ${repo}. Refresh to try again.`,
      "unreadable": `PSM could not read ${repo}. Sign in with "gh auth login", or make a local checkout of it available, then refresh.`,
    }[remote.status ?? "unreadable"]);
  }
  result.notes = [...new Set(result.notes)];
  return result;
}
