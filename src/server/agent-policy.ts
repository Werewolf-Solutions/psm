/**
 * Agent access policy: Allow / Ask / Deny rules on top of standing grants.
 *
 * A project's standing grants (agent-permissions.ts) are unscoped, permanent
 * Allow rules; existing projects keep exactly the authority they had. Rules
 * add what grants cannot say: scope (an environment, a connection, one
 * attached tool, one task), duration (once, this task, until a time, standing)
 * and the two other effects — Ask, which turns an operation into an operator
 * review, and Deny.
 *
 * The decision is deliberately simple to explain: the most specific matching
 * rule wins; at equal specificity Deny beats Ask beats Allow; a workspace Deny
 * beats everything the project says; with no matching rule the answer is Deny.
 * Every answer names the rule responsible, so "why can't the agent do this?"
 * always has a concrete answer.
 */
import { createHash, randomUUID } from "node:crypto";

export type PolicyEffect = "allow" | "ask" | "deny";

export interface PolicyScope {
  environmentId?: string;
  connectionId?: string;
  /** Attached capability reference, for integration calls. */
  capability?: string;
  /** One tool of that capability. */
  tool?: string;
  /** A managed session (task); a rule scoped to it ends with the task. */
  task?: string;
  /** Digest of one exact operation, for approvals that cover only it. */
  operation?: string;
}

export interface PolicyRule {
  id: string;
  permission: string;
  effect: PolicyEffect;
  scope: PolicyScope;
  /** Epoch ms after which the rule no longer applies; null means standing. */
  expiresAt: number | null;
  /** Remaining uses for "once" rules; null means unlimited. */
  remainingUses: number | null;
  /** Where the rule came from: `preset:<id>@<version>`, `review:<id>`, `custom` or `grant`. */
  source: string;
  actor: string;
  at: number;
}

export interface DecisionContext {
  environmentId?: string;
  connectionId?: string;
  capability?: string;
  tool?: string;
  task?: string;
  operation?: string;
}

export interface Decision {
  effect: PolicyEffect;
  /** The rule that decided, or null for the default deny. */
  rule: PolicyRule | null;
  /** Workspace-level rule, when that is what decided. */
  workspace: boolean;
  reason: string;
}

const SCOPE_KEYS: readonly (keyof PolicyScope)[] = ["environmentId", "connectionId", "capability", "tool", "task", "operation"];
const EFFECT_ORDER: Record<PolicyEffect, number> = { deny: 3, ask: 2, allow: 1 };

function matches(rule: PolicyRule, permission: string, context: DecisionContext, now: number): boolean {
  if (rule.permission !== permission && rule.permission !== "*") return false;
  if (rule.expiresAt !== null && rule.expiresAt <= now) return false;
  if (rule.remainingUses !== null && rule.remainingUses <= 0) return false;
  // A scoped rule applies only when the operation carries that exact value.
  return SCOPE_KEYS.every((key) => rule.scope[key] === undefined || rule.scope[key] === context[key]);
}

function specificity(rule: PolicyRule): number {
  return SCOPE_KEYS.filter((key) => rule.scope[key] !== undefined).length + (rule.permission === "*" ? 0 : 0.5);
}

function strongest(rules: PolicyRule[]): PolicyRule | null {
  return [...rules].sort((a, b) => specificity(b) - specificity(a) || EFFECT_ORDER[b.effect] - EFFECT_ORDER[a.effect])[0] ?? null;
}

function describe(rule: PolicyRule): string {
  const scope = SCOPE_KEYS.filter((key) => rule.scope[key] !== undefined).map((key) => `${key}=${rule.scope[key]}`).join(", ");
  const duration = rule.remainingUses !== null ? `${rule.remainingUses} use(s) left` : rule.expiresAt !== null ? `until ${new Date(rule.expiresAt).toISOString()}` : "standing";
  return `${rule.effect} ${rule.permission}${scope ? ` (${scope})` : ""}, ${duration}, from ${rule.source}`;
}

export function decide(input: { permission: string; context?: DecisionContext; rules: readonly PolicyRule[]; workspaceRules?: readonly PolicyRule[]; now?: number }): Decision {
  const now = input.now ?? Date.now();
  const context = input.context ?? {};
  const workspaceDeny = strongest((input.workspaceRules ?? []).filter((rule) => rule.effect === "deny" && matches(rule, input.permission, context, now)));
  if (workspaceDeny) return { effect: "deny", rule: workspaceDeny, workspace: true, reason: `Denied by workspace policy: ${describe(workspaceDeny)}.` };
  const rule = strongest(input.rules.filter((candidate) => matches(candidate, input.permission, context, now)));
  if (!rule) return { effect: "deny", rule: null, workspace: false, reason: `No rule allows ${input.permission}${context.environmentId ? ` in ${context.environmentId}` : ""}.` };
  const verb = rule.effect === "allow" ? "Allowed" : rule.effect === "ask" ? "Needs operator review" : "Denied";
  return { effect: rule.effect, rule, workspace: false, reason: `${verb} by ${describe(rule)}.` };
}

export type RuleDuration = { kind: "once" } | { kind: "task"; task: string } | { kind: "until"; expiresAt: number } | { kind: "standing" };

export function makeRule(input: { permission: string; effect: PolicyEffect; scope?: PolicyScope; duration?: RuleDuration; source: string; actor: string; now?: number }): PolicyRule {
  const duration = input.duration ?? { kind: "standing" };
  const scope: PolicyScope = { ...(input.scope ?? {}) };
  if (duration.kind === "task") scope.task = duration.task;
  for (const key of Object.keys(scope) as (keyof PolicyScope)[]) {
    const value = scope[key];
    if (value === undefined) delete scope[key];
    else if (typeof value !== "string" || !/^[A-Za-z0-9._:@/+=-]{1,200}$/.test(value)) throw new Error(`Invalid rule scope ${key}.`);
  }
  if (!/^(\*|[a-z]+(\.[a-z-]+)+)$/.test(input.permission)) throw new Error("Invalid rule permission.");
  if (!["allow", "ask", "deny"].includes(input.effect)) throw new Error("Invalid rule effect.");
  if (duration.kind === "until" && !(Number.isSafeInteger(duration.expiresAt) && duration.expiresAt > (input.now ?? Date.now()))) throw new Error("A time-limited rule must end in the future.");
  return {
    id: `rule_${randomUUID()}`,
    permission: input.permission,
    effect: input.effect,
    scope,
    expiresAt: duration.kind === "until" ? duration.expiresAt : null,
    remainingUses: duration.kind === "once" ? 1 : null,
    source: input.source,
    actor: input.actor,
    at: input.now ?? Date.now(),
  };
}

/* ---------- presets ---------- */

type PresetRule = { permission: string; effect: PolicyEffect; scope?: PolicyScope };

export interface Preset {
  id: string;
  version: number;
  title: string;
  summary: string;
  /** Standing unscoped grants the preset turns on. */
  grants: readonly string[];
  /** Scoped or non-allow rules it adds. */
  rules: readonly PresetRule[];
  /** Plain statements of what remains impossible, whatever the preset. */
  limits: readonly string[];
}

const DEVELOP = ["repo.read", "repo.edit", "repo.delete", "git.commit", "git.branch", "git.switch", "git.merge", "git.fetch", "test.run", "script.run", "pkg.install", "mcp.use"] as const;
const COMMON_LIMITS = [
  "No general shell on your computer: the agent works through PSM tools only.",
  "Builds and checks run offline in a disposable container; nothing they produce reaches your checkout.",
];

export const PRESETS: readonly Preset[] = [
  {
    id: "inspect", version: 1, title: "Inspect", summary: "Read the code and its Git history. Nothing changes.",
    grants: ["repo.read"], rules: [], limits: COMMON_LIMITS,
  },
  {
    id: "develop", version: 1, title: "Develop", summary: "Edit, commit, test and install dependencies locally. Pushing and attached tools ask first.",
    grants: DEVELOP,
    rules: [{ permission: "git.push", effect: "ask" }, { permission: "mcp.call", effect: "ask" }],
    limits: [...COMMON_LIMITS, "Nothing runs on servers."],
  },
  {
    id: "operate-staging", version: 1, title: "Operate staging", summary: "Develop, plus push, and run commands on staging servers without asking. Production asks.",
    grants: [...DEVELOP, "git.push"],
    rules: [
      { permission: "mcp.call", effect: "ask" },
      { permission: "machine.command", effect: "allow", scope: { environmentId: "staging" } },
      { permission: "machine.command", effect: "ask" },
      { permission: "deploy.approve", effect: "allow", scope: { environmentId: "staging" } },
    ],
    limits: [...COMMON_LIMITS, "Server commands run as the project's own unprivileged command account.", "Production plans still wait for your review."],
  },
  {
    id: "operate-production", version: 1, title: "Operate production", summary: "Everything in Operate staging, and production server commands too, each one reviewed.",
    grants: [...DEVELOP, "git.push"],
    rules: [
      { permission: "mcp.call", effect: "ask" },
      { permission: "machine.command", effect: "allow", scope: { environmentId: "staging" } },
      { permission: "machine.command", effect: "ask", scope: { environmentId: "production" } },
      { permission: "machine.command", effect: "ask" },
      { permission: "deploy.approve", effect: "allow", scope: { environmentId: "staging" } },
    ],
    limits: [...COMMON_LIMITS, "Server commands run as the project's own unprivileged command account."],
  },
  {
    id: "full", version: 1, title: "Full access to this project",
    summary: "Every operation PSM supports for this project, in every environment, with no per-operation review.",
    grants: [...DEVELOP, "git.push", "mcp.call", "machine.command", "deploy.approve"],
    rules: [],
    limits: [
      ...COMMON_LIMITS,
      "Only this project's checkout, its attached tools and the servers connected to it; never other projects or PSM itself.",
      "Server commands run as the project's command account — not root. Administration of a server is a separate, explicit connection.",
      "Plans that need an acknowledgement, including every production plan, still wait for you unless you add a rule for that environment.",
    ],
  },
];

export function presetRules(preset: Preset, actor: string, now = Date.now()): PolicyRule[] {
  return preset.rules.map((rule) => makeRule({ ...rule, source: `preset:${preset.id}@${preset.version}`, actor, now }));
}

/** A stable, rule-safe key for one managed session, whatever its display name. */
export function taskKey(sessionName: string): string {
  return `task_${createHash("sha256").update(sessionName).digest("hex").slice(0, 24)}`;
}

/** Digest binding a one-time approval to exactly one operation. */
export function operationDigest(permission: string, details: unknown): string {
  return `op_${createHash("sha256").update(JSON.stringify([permission, details])).digest("hex").slice(0, 32)}`;
}
