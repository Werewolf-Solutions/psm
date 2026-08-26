/**
 * Pure deployment-policy composition.
 *
 * Callers select the policy layers that apply to a deployment target, then pass
 * them here.  The merge is deliberately monotonic: adding a layer can increase
 * risk or approval requirements, shorten time limits, add required checks,
 * narrow source refs, or remove authority.  It cannot make a plan less strict.
 */

export type RiskClass = "development" | "staging" | "production";

export type ApprovalMode =
  | "none"
  | "operator"
  | "local-operator"
  | "authenticated-operator"
  | "authenticated-local-operator";

export type PolicySource = "manifest" | "local" | "target" | "connection";

export type PolicyScopeKind =
  | "global"
  | "risk"
  | "project"
  | "environment"
  | "target"
  | "connection"
  | "manifest";

export interface PolicyScope {
  kind: PolicyScopeKind;
  id: string;
}

/** A check is identified by all three fields, not its display name alone. */
export interface RequiredCheck {
  context: string;
  publisherKind: "app" | "user" | "unknown";
  publisherId: string;
}

export interface PolicyAuthority {
  delete: boolean;
  automaticRollback: boolean;
  breakGlass: boolean;
  pairedApproval: boolean;
}

/**
 * One already-selected policy input. Server-owned layers should be read from
 * local storage; repository content is represented only by `source: manifest`.
 *
 * Authority fields are grants. For a server-owned layer, an omitted grant is a
 * denial. A manifest may veto a grant with `false`, but `true` cannot create
 * authority that local policy did not grant.
 */
export interface DeploymentPolicyLayer {
  id: string;
  revision: string | number;
  source: PolicySource;
  scope: PolicyScope;
  minimumRisk?: RiskClass;
  maximumAuthorizedRisk?: RiskClass;
  planTtlSeconds?: number;
  maxWatchAgeSeconds?: number;
  requiredChecks?: readonly RequiredCheck[];
  allowedSourceRefs?: readonly string[];
  approval?: ApprovalMode;
  requireFreshWatchBeforeRelease?: boolean;
  authority?: Partial<PolicyAuthority>;
}

export interface PolicyInputRevision {
  id: string;
  revision: string | number;
  source: PolicySource;
  scope: PolicyScope;
}

export interface EffectiveDeploymentPolicy {
  risk: RiskClass;
  planTtlSeconds: number | null;
  maxWatchAgeSeconds: number | null;
  requiredChecks: RequiredCheck[];
  /** `null` means that no applicable layer constrained refs. */
  allowedSourceRefs: string[] | null;
  approval: ApprovalMode;
  requireFreshWatchBeforeRelease: boolean;
  authority: PolicyAuthority;
  inputRevisions: PolicyInputRevision[];
}

export type PolicyBlockerCode =
  | "invalid-policy"
  | "production-policy-missing"
  | "connection-risk-exceeded"
  | "source-ref-empty";

export interface PolicyBlocker {
  code: PolicyBlockerCode;
  message: string;
  layerId?: string;
}

export interface ComposedDeploymentPolicy {
  policy: EffectiveDeploymentPolicy;
  blockers: PolicyBlocker[];
  ok: boolean;
}

const RISK_RANK: Record<RiskClass, number> = {
  development: 0,
  staging: 1,
  production: 2,
};

const RISK_CLASSES = new Set<RiskClass>(["development", "staging", "production"]);
const APPROVAL_MODES = new Set<ApprovalMode>([
  "none",
  "operator",
  "local-operator",
  "authenticated-operator",
  "authenticated-local-operator",
]);
const POLICY_SOURCES = new Set<PolicySource>(["manifest", "local", "target", "connection"]);
const POLICY_SCOPES = new Set<PolicyScopeKind>([
  "global",
  "risk",
  "project",
  "environment",
  "target",
  "connection",
  "manifest",
]);

interface ApprovalRequirements {
  operator: boolean;
  local: boolean;
  authenticated: boolean;
}

const APPROVAL_REQUIREMENTS: Record<ApprovalMode, ApprovalRequirements> = {
  none: { operator: false, local: false, authenticated: false },
  operator: { operator: true, local: false, authenticated: false },
  "local-operator": { operator: true, local: true, authenticated: false },
  "authenticated-operator": { operator: true, local: false, authenticated: true },
  "authenticated-local-operator": { operator: true, local: true, authenticated: true },
};

const AUTHORITY_KEYS: Array<keyof PolicyAuthority> = [
  "delete",
  "automaticRollback",
  "breakGlass",
  "pairedApproval",
];

export function compareRisk(left: RiskClass, right: RiskClass): number {
  return RISK_RANK[left] - RISK_RANK[right];
}

export function strictestRisk(risks: readonly RiskClass[]): RiskClass {
  return risks.reduce<RiskClass>(
    (strictest, risk) => compareRisk(risk, strictest) > 0 ? risk : strictest,
    "development",
  );
}

function approvalFromRequirements(requirements: ApprovalRequirements): ApprovalMode {
  if (requirements.local && requirements.authenticated) {
    return "authenticated-local-operator";
  }
  if (requirements.local) return "local-operator";
  if (requirements.authenticated) return "authenticated-operator";
  return requirements.operator ? "operator" : "none";
}

export function strictestApproval(modes: readonly ApprovalMode[]): ApprovalMode {
  const requirements = modes.reduce<ApprovalRequirements>(
    (combined, mode) => ({
      operator: combined.operator || APPROVAL_REQUIREMENTS[mode].operator,
      local: combined.local || APPROVAL_REQUIREMENTS[mode].local,
      authenticated: combined.authenticated || APPROVAL_REQUIREMENTS[mode].authenticated,
    }),
    { operator: false, local: false, authenticated: false },
  );
  return approvalFromRequirements(requirements);
}

function finitePositive(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function boundedText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field} must be non-empty, bounded text without control characters`);
  }
  return normalized;
}

function normalizedCheck(check: RequiredCheck): RequiredCheck {
  return {
    context: boundedText(check.context, "check context"),
    publisherKind: check.publisherKind,
    publisherId: boundedText(check.publisherId, "check publisher ID"),
  };
}

function checkKey(check: RequiredCheck): string {
  return `${check.context.length}:${check.context}${check.publisherKind.length}:${check.publisherKind}${check.publisherId.length}:${check.publisherId}`;
}

function intersectRefs(refSets: readonly (readonly string[])[]): string[] | null {
  if (!refSets.length) return null;
  const normalizedSets = refSets.map((refs) => new Set(
    refs.map((ref) => boundedText(ref, "allowed source ref")),
  ));
  return [...normalizedSets[0]].filter((ref) => normalizedSets.every((set) => set.has(ref))).sort();
}

function composeAuthority(layers: readonly DeploymentPolicyLayer[]): PolicyAuthority {
  const serverOwned = layers.filter((layer) => layer.source !== "manifest");
  const manifest = layers.filter((layer) => layer.source === "manifest");
  return Object.fromEntries(AUTHORITY_KEYS.map((key) => {
    const grantedLocally = serverOwned.length > 0
      && serverOwned.every((layer) => layer.authority?.[key] === true);
    const vetoedByManifest = manifest.some((layer) => layer.authority?.[key] === false);
    return [key, grantedLocally && !vetoedByManifest];
  })) as unknown as PolicyAuthority;
}

function validateLayer(layer: DeploymentPolicyLayer): string[] {
  const errors: string[] = [];
  try {
    boundedText(layer.id, "policy ID");
    boundedText(String(layer.revision), "policy revision");
    boundedText(layer.scope.id, "policy scope ID");
  } catch (error) {
    errors.push((error as Error).message);
  }
  if (typeof layer.revision === "number" && !Number.isFinite(layer.revision)) {
    errors.push("policy revision must be finite");
  }
  if (!POLICY_SOURCES.has(layer.source)) errors.push("policy source is not recognized");
  if (!POLICY_SCOPES.has(layer.scope.kind)) errors.push("policy scope is not recognized");
  if (layer.minimumRisk !== undefined && !RISK_CLASSES.has(layer.minimumRisk)) {
    errors.push("minimum risk is not recognized");
  }
  if (
    layer.maximumAuthorizedRisk !== undefined
    && !RISK_CLASSES.has(layer.maximumAuthorizedRisk)
  ) {
    errors.push("maximum-authorized risk is not recognized");
  }
  if (layer.approval !== undefined && !APPROVAL_MODES.has(layer.approval)) {
    errors.push("approval mode is not recognized");
  }
  if (layer.planTtlSeconds !== undefined && !finitePositive(layer.planTtlSeconds)) {
    errors.push("plan TTL must be a positive finite number");
  }
  if (layer.maxWatchAgeSeconds !== undefined && !finitePositive(layer.maxWatchAgeSeconds)) {
    errors.push("maximum Watch age must be a positive finite number");
  }
  try {
    layer.requiredChecks?.forEach((check) => {
      if (!new Set(["app", "user", "unknown"]).has(check.publisherKind)) {
        throw new Error("check publisher kind is not recognized");
      }
      normalizedCheck(check);
    });
    layer.allowedSourceRefs?.forEach((ref) => boundedText(ref, "allowed source ref"));
  } catch (error) {
    errors.push((error as Error).message);
  }
  if (
    layer.minimumRisk
    && layer.maximumAuthorizedRisk
    && compareRisk(layer.minimumRisk, layer.maximumAuthorizedRisk) > 0
  ) {
    errors.push("minimum risk exceeds maximum-authorized risk");
  }
  return errors;
}

/**
 * Compose an environment's manifest risk with every applicable server-owned
 * layer. Invalid inputs become blockers instead of being silently ignored.
 */
export function composeDeploymentPolicy(
  manifestRisk: RiskClass,
  layers: readonly DeploymentPolicyLayer[],
): ComposedDeploymentPolicy {
  const blockers: PolicyBlocker[] = [];
  const manifestRiskValid = RISK_CLASSES.has(manifestRisk);
  if (!manifestRiskValid) {
    blockers.push({ code: "invalid-policy", message: "manifest risk is not recognized" });
  }
  const seenLayerIds = new Set<string>();
  for (const layer of layers) {
    if (seenLayerIds.has(layer.id)) {
      blockers.push({
        code: "invalid-policy",
        message: `duplicate applicable policy layer ${layer.id}`,
        layerId: layer.id,
      });
    }
    seenLayerIds.add(layer.id);
    for (const message of validateLayer(layer)) {
      blockers.push({ code: "invalid-policy", message, layerId: layer.id });
    }
  }

  const risk = strictestRisk([
    manifestRiskValid ? manifestRisk : "production",
    ...layers.flatMap((layer) =>
      layer.minimumRisk && RISK_CLASSES.has(layer.minimumRisk) ? [layer.minimumRisk] : []
    ),
  ]);

  for (const layer of layers) {
    if (
      layer.maximumAuthorizedRisk
      && RISK_CLASSES.has(layer.maximumAuthorizedRisk)
      && compareRisk(risk, layer.maximumAuthorizedRisk) > 0
    ) {
      blockers.push({
        code: "connection-risk-exceeded",
        layerId: layer.id,
        message: `${layer.id} authorizes at most ${layer.maximumAuthorizedRisk}, not ${risk}`,
      });
    }
  }

  const productionTargetPolicies = layers.filter((layer) =>
    layer.source === "local"
    && layer.scope.kind === "target"
    && layer.minimumRisk === "production"
    && layer.approval !== undefined
    && APPROVAL_MODES.has(layer.approval)
  );
  if (risk === "production" && productionTargetPolicies.length === 0) {
    blockers.push({
      code: "production-policy-missing",
      message: "Production requires a target-scoped local risk classification and approval mode",
    });
  }

  const ttlValues = layers.flatMap((layer) =>
    finitePositive(layer.planTtlSeconds) ? [layer.planTtlSeconds] : []
  );
  const watchAgeValues = layers.flatMap((layer) =>
    finitePositive(layer.maxWatchAgeSeconds) ? [layer.maxWatchAgeSeconds] : []
  );

  const checks = new Map<string, RequiredCheck>();
  for (const layer of layers) {
    for (const check of layer.requiredChecks ?? []) {
      try {
        const normalized = normalizedCheck(check);
        checks.set(checkKey(normalized), normalized);
      } catch {
        // validateLayer already emitted the blocker; do not let bad display data through.
      }
    }
  }

  let allowedSourceRefs: string[] | null = null;
  try {
    allowedSourceRefs = intersectRefs(
      layers.flatMap((layer) => layer.allowedSourceRefs === undefined ? [] : [layer.allowedSourceRefs]),
    );
  } catch {
    // validateLayer already emitted the blocker.
  }
  if (allowedSourceRefs?.length === 0) {
    blockers.push({
      code: "source-ref-empty",
      message: "Applicable policies have no source ref in common",
    });
  }

  const approvalModes = layers.flatMap((layer) =>
    layer.approval && APPROVAL_MODES.has(layer.approval) ? [layer.approval] : []
  );
  if (risk === "production") approvalModes.push("authenticated-local-operator");

  const policy: EffectiveDeploymentPolicy = {
    risk,
    planTtlSeconds: ttlValues.length ? Math.min(...ttlValues) : null,
    maxWatchAgeSeconds: watchAgeValues.length ? Math.min(...watchAgeValues) : null,
    requiredChecks: [...checks.values()].sort((left, right) =>
      left.context.localeCompare(right.context)
      || left.publisherKind.localeCompare(right.publisherKind)
      || left.publisherId.localeCompare(right.publisherId)
    ),
    allowedSourceRefs,
    approval: strictestApproval(approvalModes),
    requireFreshWatchBeforeRelease: layers.some(
      (layer) => layer.requireFreshWatchBeforeRelease === true,
    ),
    authority: composeAuthority(layers),
    inputRevisions: layers.map((layer) => ({
      id: layer.id,
      revision: layer.revision,
      source: layer.source,
      scope: { ...layer.scope },
    })),
  };

  return { policy, blockers, ok: blockers.length === 0 };
}

export type DeploymentAuthorityAction =
  | "approve"
  | "cancel-production"
  | "mutate-connection"
  | "bind-connection"
  | "mutate-secret"
  | "mutate-policy"
  | "enroll-helper"
  | "delete-resource"
  | "automatic-rollback"
  | "break-glass";

export interface DeploymentAuthorityContext {
  action: DeploymentAuthorityAction;
  origin: "local" | "paired";
  authenticated: boolean;
}

export interface DeploymentAuthorityDecision {
  allowed: boolean;
  reasons: string[];
}

const LOCAL_ONLY_ACTIONS = new Set<DeploymentAuthorityAction>([
  "cancel-production",
  "mutate-connection",
  "bind-connection",
  "mutate-secret",
  "mutate-policy",
  "enroll-helper",
  "break-glass",
]);

/** A small pure guard for API routes; authentication/session checks remain I/O. */
export function authorizeDeploymentAction(
  policy: EffectiveDeploymentPolicy,
  context: DeploymentAuthorityContext,
): DeploymentAuthorityDecision {
  const reasons: string[] = [];
  if (LOCAL_ONLY_ACTIONS.has(context.action) && context.origin !== "local") {
    reasons.push(`${context.action} is local-only`);
  }

  if (context.action === "approve") {
    const required = APPROVAL_REQUIREMENTS[policy.approval];
    if (required.local && context.origin !== "local") reasons.push("approval requires local origin");
    if (required.authenticated && !context.authenticated) {
      reasons.push("approval requires an authenticated operator");
    }
    if (context.origin === "paired" && !policy.authority.pairedApproval) {
      reasons.push("paired approval is not authorized");
    }
  }

  if (context.action === "cancel-production") {
    if (policy.risk !== "production") reasons.push("production cancellation policy is not applicable");
    if (!context.authenticated) reasons.push("production cancellation requires authentication");
  }
  if (context.action === "delete-resource" && !policy.authority.delete) {
    reasons.push("resource deletion is not authorized");
  }
  if (context.action === "automatic-rollback" && !policy.authority.automaticRollback) {
    reasons.push("automatic rollback is not authorized");
  }
  if (context.action === "break-glass" && !policy.authority.breakGlass) {
    reasons.push("break-glass is not authorized");
  }

  return { allowed: reasons.length === 0, reasons };
}
