import type { DeploymentPlanDocument, PlanBlocker } from "./planner.ts";

export interface DeploymentReadinessItem {
  id: string;
  code: string;
  title: string;
  detail: string;
  status: "ready" | "action-required" | "blocked" | "preparing";
  action: "prepare-artifact" | "connect" | "review-source" | "resolve-dependency" | "review-resource" | "configure-provider" | "review-policy" | null;
  automatic: boolean;
  slot?: string;
}

export interface DeploymentReadiness {
  checkedAt: number;
  expiresAt: number;
  environmentId: string;
  ready: boolean;
  canMakeReady: boolean;
  artifactId: string | null;
  items: DeploymentReadinessItem[];
}

function requiredItem(blocker: PlanBlocker, canPrepare: boolean): DeploymentReadinessItem {
  let action: DeploymentReadinessItem["action"] = "review-policy";
  let detail = blocker.message;
  let title = blocker.title;
  const slot = blocker.ownerRef?.startsWith("connection:") ? blocker.ownerRef.slice("connection:".length) : undefined;
  if (blocker.code === "connection-missing") {
    action = "connect";
    title = `Connect ${slot ?? "deployment provider"}`;
    detail += ". Choose a scoped local connection and supply its required credentials in Connections.";
  } else if (["artifact-missing", "artifact-expired", "artifact-source-mismatch", "artifact-build-profile-mismatch", "artifact-repository-mismatch"].includes(blocker.code)) {
    action = "prepare-artifact";
    title = "Prepare the deployment build";
    detail = canPrepare ? "Build the committed source with the configured GitHub Actions workflow and verify the immutable artifact." : "Connect the build provider, configure its workflow, and commit the deployment inputs before preparing a build.";
  } else if (blocker.code.startsWith("source-") || blocker.code === "version-not-increased") {
    action = "review-source";
    title = blocker.code === "source-dirty" ? "Commit deployment inputs" : "Review the release source";
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
  const automatic = action === "prepare-artifact" && canPrepare;
  return { id: blocker.id, code: blocker.code, title, detail, status: automatic ? "action-required" : "blocked", action, automatic, ...(slot ? { slot } : {}) };
}

/** A readiness report is derived from the same fresh plan the deploy button approves. */
export function deploymentReadiness(document: DeploymentPlanDocument, canPrepare: boolean, preparing = false): DeploymentReadiness {
  const blockers = document.blockers.filter((item) => item.code !== "action-blocked"
    || !document.blockers.some((other) => other.code !== "action-blocked" && other.ownerRef === item.ownerRef));
  const items = blockers.map((item) => requiredItem(item, canPrepare));
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
  return {
    checkedAt: document.createdAt,
    expiresAt: document.expiresAt,
    environmentId: document.environmentId,
    ready: !document.blocked && !preparing && document.expiresAt > Date.now(),
    canMakeReady: !preparing && items.some((item) => item.automatic),
    artifactId: document.artifact?.artifactId ?? null,
    items,
  };
}
