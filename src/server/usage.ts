import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import readline from "node:readline";
import { promisify } from "node:util";

export type UsageStatus = "available" | "unavailable" | "error";
export type UsageSeverity = "normal" | "warning" | "critical";

export interface SubscriptionUsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: number | null;
  durationMinutes: number | null;
  severity: UsageSeverity;
}

export interface SubscriptionUsageMetric {
  label: string;
  value: string;
}

export interface SubscriptionUsageProvider {
  id: "claude" | "codex";
  name: string;
  status: UsageStatus;
  plan: string | null;
  windows: SubscriptionUsageWindow[];
  metrics: SubscriptionUsageMetric[];
  credits: {
    balance: string | null;
    unlimited: boolean;
  } | null;
  updatedAt: number;
  message: string | null;
}

export interface SubscriptionUsageSnapshot {
  providers: SubscriptionUsageProvider[];
  updatedAt: number;
  scope: {
    engine: SubscriptionUsageProvider["id"];
    model: string | null;
  };
}

const execFileAsync = promisify(execFile);
const CACHE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 12_000;
const cached: Partial<Record<SubscriptionUsageProvider["id"], SubscriptionUsageProvider>> = {};
const inFlight: Partial<Record<SubscriptionUsageProvider["id"], Promise<SubscriptionUsageProvider>>> = {};

function titleCase(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (text === "apiKey") return "API key";
  return text
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function severity(percent: number): UsageSeverity {
  if (percent >= 100) return "critical";
  if (percent >= 80) return "warning";
  return "normal";
}

function usageWindow(
  id: string,
  label: string,
  percent: unknown,
  resetsAt: number | null,
  durationMinutes: number | null,
): SubscriptionUsageWindow | null {
  const usedPercent = Number(percent);
  if (!Number.isFinite(usedPercent)) return null;
  return {
    id,
    label,
    usedPercent: Math.max(0, usedPercent),
    resetsAt,
    durationMinutes,
    severity: severity(usedPercent),
  };
}

function unavailable(
  id: SubscriptionUsageProvider["id"],
  name: string,
  status: UsageStatus,
  message: string,
  plan: string | null = null,
): SubscriptionUsageProvider {
  return {
    id,
    name,
    status,
    plan,
    windows: [],
    metrics: [],
    credits: null,
    updatedAt: Date.now(),
    message,
  };
}

async function runJson(command: string, args: string[]): Promise<any> {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    timeout: REQUEST_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(String(result.stdout));
}

function claudeCredentialsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(configDir, ".credentials.json");
}

function dateMillis(value: unknown): number | null {
  const millis = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(millis) ? millis : null;
}

async function claudeUsage(): Promise<SubscriptionUsageProvider> {
  let auth: any;
  try {
    auth = await runJson("claude", ["auth", "status", "--json"]);
  } catch {
    return unavailable("claude", "Claude", "error", "Could not read Claude account status.");
  }

  const plan = titleCase(auth?.subscriptionType);
  if (!auth?.loggedIn) {
    return unavailable("claude", "Claude", "unavailable", "Claude is not signed in.", plan);
  }

  let token: string;
  try {
    const credentials = JSON.parse(fs.readFileSync(claudeCredentialsPath(), "utf8"));
    token = String(credentials?.claudeAiOauth?.accessToken || "");
  } catch {
    return unavailable(
      "claude",
      "Claude",
      "unavailable",
      "Claude usage windows are unavailable for this authentication method.",
      plan,
    );
  }
  if (!token) {
    return unavailable(
      "claude",
      "Claude",
      "unavailable",
      "Claude usage windows are unavailable for this authentication method.",
      plan,
    );
  }

  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "user-agent": "psm/0.1.0",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      return unavailable("claude", "Claude", "error", "Claude usage could not be refreshed.", plan);
    }
    const raw: any = await response.json();
    const definitions: Array<[string, string, number]> = [
      ["five_hour", "5 hour", 300],
      ["seven_day", "7 day", 10_080],
      ["seven_day_opus", "7 day - Opus", 10_080],
      ["seven_day_sonnet", "7 day - Sonnet", 10_080],
      ["seven_day_oauth_apps", "7 day - OAuth apps", 10_080],
    ];
    const windows = definitions
      .map(([key, label, duration]) => {
        const value = raw?.[key];
        return value
          ? usageWindow(key, label, value.utilization, dateMillis(value.resets_at), duration)
          : null;
      })
      .filter((window): window is SubscriptionUsageWindow => !!window);

    const spend = raw?.spend;
    const metrics: SubscriptionUsageMetric[] = [
      {
        label: "Extra usage",
        value: spend?.enabled
          ? spend?.percent != null
            ? `${Number(spend.percent).toFixed(0)}%`
            : "On"
          : "Off",
      },
    ];

    return {
      id: "claude",
      name: "Claude",
      status: windows.length ? "available" : "unavailable",
      plan,
      windows,
      metrics,
      credits: null,
      updatedAt: Date.now(),
      message: windows.length ? null : "Claude did not return any usage windows.",
    };
  } catch {
    return unavailable("claude", "Claude", "error", "Claude usage could not be refreshed.", plan);
  }
}

interface CodexRpcSnapshot {
  account: any;
  rateLimits: any;
  usage: any;
}

function codexRpcSnapshot(): Promise<CodexRpcSnapshot> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    const responses = new Map<number, any>();
    let settled = false;
    let initialized = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.kill("SIGTERM");
      if (error) {
        reject(error);
      } else {
        resolve({
          account: responses.get(2)?.result ?? null,
          rateLimits: responses.get(3)?.result ?? null,
          usage: responses.get(4)?.result ?? null,
        });
      }
    };
    const send = (message: unknown) => {
      if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + "\n");
    };
    const timer = setTimeout(
      () => finish(new Error("Codex usage request timed out")),
      REQUEST_TIMEOUT_MS,
    );
    const lines = readline.createInterface({ input: child.stdout });

    child.on("error", () => finish(new Error("Could not start Codex app server")));
    child.on("exit", (code) => {
      if (!settled) finish(new Error(`Codex app server exited with code ${code ?? "unknown"}`));
    });
    lines.on("line", (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }

      if (message.id === 1) {
        if (message.error) return finish(new Error("Codex app server initialization failed"));
        if (initialized) return;
        initialized = true;
        send({ method: "initialized" });
        send({ id: 2, method: "account/read", params: { refreshToken: false } });
        send({ id: 3, method: "account/rateLimits/read", params: null });
        send({ id: 4, method: "account/usage/read", params: null });
        return;
      }

      if (message.id === 2 || message.id === 3 || message.id === 4) {
        responses.set(message.id, message);
        if (responses.size === 3) finish();
      }
    });

    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "psm", title: "PSM", version: "0.1.0" },
      },
    });
  });
}

function durationLabel(minutes: number | null): string {
  if (minutes === 300) return "5 hour";
  if (minutes === 10_080) return "7 day";
  if (minutes === 43_200) return "30 day";
  if (!minutes) return "Usage window";
  if (minutes % 1440 === 0) return `${minutes / 1440} day`;
  if (minutes % 60 === 0) return `${minutes / 60} hour`;
  return `${minutes} minute`;
}

function codexWindows(rateResult: any): {
  windows: SubscriptionUsageWindow[];
  plan: string | null;
  credits: SubscriptionUsageProvider["credits"];
} {
  const byId = rateResult?.rateLimitsByLimitId;
  const snapshots: any[] =
    byId && typeof byId === "object" && Object.keys(byId).length
      ? Object.values(byId)
      : rateResult?.rateLimits
        ? [rateResult.rateLimits]
        : [];

  const windows: SubscriptionUsageWindow[] = [];
  let plan: string | null = null;
  let credits: SubscriptionUsageProvider["credits"] = null;
  for (const snapshot of snapshots) {
    plan ||= titleCase(snapshot?.planType);
    if (!credits && snapshot?.credits) {
      credits = {
        balance: snapshot.credits.balance == null ? null : String(snapshot.credits.balance),
        unlimited: !!snapshot.credits.unlimited,
      };
    }
    for (const slot of ["primary", "secondary"] as const) {
      const value = snapshot?.[slot];
      if (!value) continue;
      const duration = Number.isFinite(Number(value.windowDurationMins))
        ? Number(value.windowDurationMins)
        : null;
      const prefix = snapshots.length > 1 && snapshot.limitName
        ? `${snapshot.limitName} - `
        : "";
      const window = usageWindow(
        `${snapshot?.limitId || "codex"}-${slot}`,
        prefix + durationLabel(duration),
        value.usedPercent,
        value.resetsAt ? Number(value.resetsAt) * 1000 : null,
        duration,
      );
      if (window) windows.push(window);
    }
  }
  return { windows, plan, credits };
}

async function codexUsage(): Promise<SubscriptionUsageProvider> {
  try {
    const raw = await codexRpcSnapshot();
    const normalized = codexWindows(raw.rateLimits);
    const accountPlan = titleCase(raw.account?.account?.planType);
    const summary = raw.usage?.summary || {};
    const metrics: SubscriptionUsageMetric[] = [];
    if (summary.lifetimeTokens != null) {
      metrics.push({ label: "Lifetime tokens", value: Number(summary.lifetimeTokens).toLocaleString("en-US") });
    }
    if (summary.peakDailyTokens != null) {
      metrics.push({ label: "Peak daily tokens", value: Number(summary.peakDailyTokens).toLocaleString("en-US") });
    }
    const resetCredits = raw.rateLimits?.rateLimitResetCredits?.availableCount;
    if (Number(resetCredits) > 0) {
      metrics.push({ label: "Reset credits", value: String(resetCredits) });
    }

    return {
      id: "codex",
      name: "Codex",
      status: normalized.windows.length ? "available" : "unavailable",
      plan: normalized.plan || accountPlan,
      windows: normalized.windows,
      metrics,
      credits: normalized.credits,
      updatedAt: Date.now(),
      message: normalized.windows.length ? null : "Codex did not return any usage windows.",
    };
  } catch {
    return unavailable("codex", "Codex", "error", "Codex usage could not be refreshed.");
  }
}

function selectedWindows(
  provider: SubscriptionUsageProvider,
  model: string | null,
): SubscriptionUsageWindow[] {
  const selected = model?.trim().toLowerCase() || "";
  if (!selected) return provider.windows;
  if (provider.id === "claude") {
    if (selected.includes("opus")) {
      return provider.windows.filter((window) => window.id !== "seven_day_sonnet");
    }
    if (selected.includes("sonnet")) {
      return provider.windows.filter((window) => window.id !== "seven_day_opus");
    }
    return provider.windows;
  }

  const normalized = selected.replace(/[^a-z0-9]/g, "");
  if (!normalized) return provider.windows;
  const matches = provider.windows.filter((window) =>
    `${window.id} ${window.label}`.toLowerCase().replace(/[^a-z0-9]/g, "").includes(normalized),
  );
  return matches.length ? matches : provider.windows;
}

async function providerUsage(
  engine: SubscriptionUsageProvider["id"],
  force: boolean,
): Promise<SubscriptionUsageProvider> {
  const previous = cached[engine];
  if (!force && previous && Date.now() - previous.updatedAt < CACHE_MS) return previous;
  if (inFlight[engine]) return inFlight[engine];
  const request = (engine === "claude" ? claudeUsage() : codexUsage())
    .then((provider) => {
      cached[engine] = provider;
      return provider;
    })
    .finally(() => {
      delete inFlight[engine];
    });
  inFlight[engine] = request;
  return request;
}

export async function subscriptionUsage(
  engine: SubscriptionUsageProvider["id"],
  model: string | null,
  force = false,
): Promise<SubscriptionUsageSnapshot> {
  const provider = await providerUsage(engine, force);
  const scoped = { ...provider, windows: selectedWindows(provider, model) };
  return {
    providers: [scoped],
    updatedAt: provider.updatedAt,
    scope: { engine, model: model?.trim() || null },
  };
}
