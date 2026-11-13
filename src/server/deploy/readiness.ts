import { connectionDiagnostics } from "./connection-diagnostics.ts";
import type { DeploymentPlanDocument, PlanBlocker } from "./planner.ts";

export interface DeploymentReadinessItem {
  id: string;
  code: string;
  title: string;
  detail: string;
  status: "ready" | "action-required" | "blocked" | "preparing";
  action: "review-capabilities" | "prepare-artifact" | "connect" | "review-source" | "resolve-dependency" | "review-resource" | "configure-provider" | "review-controller" | "review-policy" | null;
  automatic: boolean;
  slot?: string;
  connectionId?: string;
  ownerProjectId?: string;
  ownerProjectName?: string;
  repairScope?: "repository" | "external" | "infrastructure" | "build";
}

export interface DeploymentReadiness {
  checkedAt: number;
  expiresAt: number;
  environmentId: string;
  ready: boolean;
  canMakeReady: boolean;
  artifactId: string | null;
  items: DeploymentReadinessItem[];
  guide: DeploymentGuideStep[];
}

export interface DeploymentGuideStep {
  id: "project" | "machine" | "connections" | "secrets" | "source" | "recovery" | "approval";
  title: string;
  status: "ready" | "action-required" | "blocked";
  detail: string;
  target: "setup" | "machine" | "connections" | "secrets" | "source" | "monitoring" | "plan";
}

/** Present the planner's evidence in a stable operator order. This is a guide,
 * never a second authorization decision. */
export function deploymentGuide(readiness: Pick<DeploymentReadiness, "items" | "ready" | "expiresAt">): DeploymentGuideStep[] {
  const groups: Array<[DeploymentGuideStep["id"], string, DeploymentGuideStep["target"], (item: DeploymentReadinessItem) => boolean]> = [
    ["project", "Project setup", "setup", (i) => i.code === "manifest-missing" || i.code === "checkout-not-ready"],
    ["machine", "Machine access", "machine", (i) => i.slot === "host" || /host|target-contract/.test(i.id)],
    ["connections", "Provider connections", "connections", (i) => i.slot !== "host" && (i.action === "connect" || i.action === "configure-provider" || i.action === "review-controller")],
    ["secrets", "Runtime secrets", "secrets", (i) => /secret|credential/.test(`${i.code} ${i.id}`)],
    ["source", "Source and artifact", "source", (i) => i.action === "review-source" || i.action === "prepare-artifact" || i.action === "review-capabilities"],
    ["recovery", "Recovery evidence", "monitoring", (i) => /backup|restore|monitor|recovery/.test(`${i.code} ${i.id}`)],
  ];
  const steps: DeploymentGuideStep[] = groups.map(([id, title, target, matches]) => {
    const outstanding = readiness.items.filter((item) => item.status !== "ready" && matches(item));
    const host = id === "machine" ? readiness.items.find((item) => item.id === "connection:host" && item.status === "ready") : null;
    return { id, title, target, status: outstanding.length ? "blocked" : "ready", detail: outstanding[0]?.detail ?? (host ? host.detail : "No blocker reported by the latest check.") } satisfies DeploymentGuideStep;
  });
  const expired = readiness.expiresAt <= Date.now();
  steps.push({ id: "approval", title: "Plan approval", target: "plan", status: readiness.ready && !expired ? "action-required" : "blocked", detail: expired ? "Readiness expired. Check again before reviewing a plan." : readiness.ready ? "Review and approve the exact deployment plan." : "Complete the steps above and check readiness again." });
  return steps;
}

export interface DeploymentReadinessOptions {
  /** Whether psm can run the deployment build itself, on this operator's behalf. */
  canPrepare: boolean;
  preparing?: boolean;
  /** Why preparation is unavailable, when the reason is known and concrete. */
  preparationDetail?: string;
}

function requiredItem(blocker: PlanBlocker, options: DeploymentReadinessOptions, document: DeploymentPlanDocument): DeploymentReadinessItem {
  let action: DeploymentReadinessItem["action"] = "review-policy";
  let detail = blocker.message;
  let title = blocker.title;
  let slot = blocker.ownerRef?.startsWith("connection:") ? blocker.ownerRef.slice("connection:".length) : undefined;
  if (blocker.code === "connection-missing") {
    action = "connect";
    title = `Connect ${slot ?? "deployment provider"}`;
    detail += ". Choose a scoped local connection and supply its required credentials in Connections.";
  } else if (["artifact-missing", "artifact-expired", "artifact-source-mismatch", "artifact-build-profile-mismatch", "artifact-repository-mismatch"].includes(blocker.code)) {
    action = "prepare-artifact";
    title = "Prepare the deployment build";
    detail = options.canPrepare
      ? "Build the committed source with the configured GitHub Actions workflow and verify the immutable artifact."
      : options.preparationDetail
        ?? "Connect the build provider, configure its workflow, and commit the deployment inputs before preparing a build.";
  } else if (blocker.code.startsWith("source-") || blocker.code === "version-not-increased") {
    action = "review-source";
    title = blocker.code === "source-dirty" ? "Commit local changes" : "Review the release source";
  } else if (blocker.code === "dependency-failed") {
    action = "resolve-dependency";
    title = `Resolve ${blocker.ownerRef?.replace(/^dependency:/, "") ?? "the dependency"}`;
  } else if (blocker.code.startsWith("resource-") || blocker.code === "action-blocked") {
    action = "review-resource";
    title = `Review ${blocker.ownerRef?.replace(/^resource:/, "") ?? "the target resource"}`;
  } else if (blocker.code === "executor-missing" || blocker.code === "executor-not-ready" || blocker.code === "monitor-stale") {
    action = "configure-provider";
    title = blocker.code === "monitor-stale" ? "Restore fresh external monitoring" : "Configure the deployment provider";
  }
  const environment = document.manifest.environments.find((entry) => entry.id === document.environmentId);
  if (blocker.code === "executor-not-ready" && /controller-/.test(blocker.ownerRef ?? "") && detail.includes("Review controller setup / update")) {
    action = "review-controller";
    title = "Review the release controller setup";
    const unitId = /^executor:([^:]+):/.exec(blocker.ownerRef ?? "")?.[1];
    slot = environment?.units.find((entry) => entry.id === unitId)?.executor.connection ?? "github";
  }
  const resourceId = /^resource:([^/#]+)/.exec(blocker.ownerRef ?? "")?.[1];
  const resource = environment?.resources.find((entry) => entry.id === resourceId);
  slot ??= resource?.connection;
  const dependencyId = /^dependency:(.+)$/.exec(blocker.ownerRef ?? "")?.[1];
  const dependency = environment?.dependencies.find((entry) => entry.id === dependencyId);
  const ownerProjectId = dependency && "projectId" in dependency ? dependency.projectId : undefined;
  const connectionId = document.connections.find((entry) => entry.slot === slot)?.connectionId;
  if (resource && blocker.code === "resource-observation-failed") {
    const diagnostic = connectionDiagnostics({ ready: true, detail: "", resources: [{ id: resource.id, state: "blocked", detail }] })[0];
    if (diagnostic && diagnostic.code !== "connection-check-failed") {
      action = "connect"; title = `Connect ${slot}`; detail = diagnostic.detail;
    }
  }
  const repairScope: DeploymentReadinessItem["repairScope"] = action === "review-source" ? "repository"
    : action === "prepare-artifact" ? "build" : blocker.code === "resource-drift" ? "infrastructure" : "external";
  const automatic = action === "prepare-artifact" && options.canPrepare;
  return { id: blocker.id, code: blocker.code, title, detail, status: automatic ? "action-required" : "blocked", action, automatic, ...(slot ? { slot } : {}), ...(connectionId ? { connectionId } : {}), ...(ownerProjectId ? { ownerProjectId } : {}), repairScope };
}

/** A readiness report is derived from the same fresh plan the deploy button approves. */
export function deploymentReadiness(document: DeploymentPlanDocument, options: DeploymentReadinessOptions): DeploymentReadiness {
  const preparing = options.preparing ?? false;
  const blockers = document.blockers.filter((item) => item.code !== "action-blocked"
    || !document.blockers.some((other) => other.code !== "action-blocked" && other.ownerRef === item.ownerRef));
  const items = blockers.map((item) => requiredItem(item, options, document));
  for (const connection of document.connections.filter((item) => item.ready)) {
    items.push({ id: `connection:${connection.slot}`, code: "connection-ready", title: `${connection.slot} connected`, detail: `${connection.profile}: credentials present and permitted for this environment.`, status: "ready", action: null, automatic: false, slot: connection.slot });
  }
  if (!document.source.inputsDirty && document.source.reachableFromAllowedBranch) {
    items.push({ id: "source-ready", code: "source-ready", title: "Committed source ready", detail: `${document.source.version} · ${document.source.commit.slice(0, 12)}`, status: "ready", action: null, automatic: false });
  }
  if (document.artifact && !blockers.some((item) => item.ownerRef === "artifact")) {
    items.push({ id: "artifact-ready", code: "artifact-ready", title: "Deployment build ready", detail: document.artifact.artifactId, status: "ready", action: null, automatic: false });
  }
  if (preparing) {
    for (const item of items.filter((item) => item.action === "prepare-artifact")) {
      item.status = "preparing";
      item.automatic = false;
      item.detail = "The build is running. Readiness will be checked again after it finishes.";
    }
  }
  const readiness: DeploymentReadiness = {
    checkedAt: document.createdAt,
    expiresAt: document.expiresAt,
    environmentId: document.environmentId,
    ready: !document.blocked && !preparing && document.expiresAt > Date.now(),
    canMakeReady: !preparing && items.some((item) => item.automatic),
    artifactId: document.artifact?.artifactId ?? null,
    items,
    guide: [],
  };
  readiness.guide = deploymentGuide(readiness);
  return readiness;
}

/** Only source defects belong to a repository repair room. Runtime dependency
 * failures do not prove the manifest is wrong and must not invite weaker checks. */
export function repositoryRepairItems(readiness: DeploymentReadiness): DeploymentReadinessItem[] {
  return readiness.items.filter((item) => item.status !== "ready" && (item.repairScope === "repository" || !item.repairScope && item.action === "review-source"));
}
export function externalPreparationItems(readiness: DeploymentReadiness): DeploymentReadinessItem[] {
  return readiness.items.filter((item) => item.status !== "ready" && item.repairScope !== "repository" && item.repairScope !== "infrastructure" && item.action !== "review-source" && item.action !== "prepare-artifact");
}
export function externalPreparationMessage(items: DeploymentReadinessItem[]): string {
  const groups = new Map<string, DeploymentReadinessItem[]>();
  for (const item of items) {
    const key = item.ownerProjectId ? `Project ${item.ownerProjectName ?? item.ownerProjectId}` : item.connectionId ? `Connection ${item.slot ?? item.connectionId} (${item.connectionId})` : item.title;
    const group = groups.get(key) ?? []; group.push(item); groups.set(key, group);
  }
  const lines = [...groups].map(([name, group]) => {
    const diagnostics = connectionDiagnostics({ ready: true, detail: "", resources: group.map((item) => ({ id: item.title, state: "blocked", detail: item.detail })) });
    return `${name}: ${diagnostics.map((item) => item.detail.trim()).join("; ")}`;
  });
  return `Preparation needs external setup. These checks will not use a repository repair attempt. ${lines.join("\n")}\nResolve these in the owning project or Deployment connections, then resume preparation.`;
}
