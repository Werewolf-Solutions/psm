import { spawn } from "node:child_process";
import readline from "node:readline";
import {
  query,
  type ModelInfo as ClaudeModelInfo,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AiEngine } from "./ai.ts";

export interface AiModelOption {
  id: string;
  resolvedModel: string | null;
  label: string;
  description: string;
  effortLevels: string[];
  defaultEffort: string | null;
  isDefault: boolean;
}

export interface AiModelCatalog {
  engine: AiEngine;
  models: AiModelOption[];
  effortLevels: string[];
  source: "live" | "fallback";
  updatedAt: number;
  message: string | null;
}

const REQUEST_TIMEOUT_MS = 15_000;
const CLAUDE_FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CODEX_FALLBACK_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter(Boolean))];
}

export function normalizeClaudeModels(models: ClaudeModelInfo[]): AiModelOption[] {
  return models
    .map((model) => ({
      id: String(model.value || "").trim(),
      resolvedModel: model.resolvedModel?.trim() || null,
      label: String(model.displayName || model.value || "").trim(),
      description: String(model.description || "").trim(),
      effortLevels: model.supportsEffort
        ? uniqueStrings(model.supportedEffortLevels || [])
        : [],
      defaultEffort: null,
      isDefault: model.value === "default",
    }))
    .filter((model) => model.id);
}

export function normalizeCodexModels(models: any[]): AiModelOption[] {
  return models
    .map((model) => {
      const efforts = Array.isArray(model?.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts.map((entry: any) =>
          typeof entry === "string" ? entry : entry?.reasoningEffort)
        : [];
      return {
        id: String(model?.model || model?.id || "").trim(),
        resolvedModel: null,
        label: String(model?.displayName || model?.model || model?.id || "").trim(),
        description: String(model?.description || "").trim(),
        effortLevels: uniqueStrings(efforts),
        defaultEffort: typeof model?.defaultReasoningEffort === "string"
          ? model.defaultReasoningEffort.trim() || null
          : null,
        isDefault: !!model?.isDefault,
      };
    })
    .filter((model) => model.id);
}

function fallbackCatalog(engine: AiEngine, error: unknown): AiModelCatalog {
  const effortLevels = engine === "claude" ? CLAUDE_FALLBACK_EFFORTS : CODEX_FALLBACK_EFFORTS;
  const aliases = engine === "claude" ? ["default", "sonnet", "opus", "fable", "haiku"] : [];
  return {
    engine,
    models: aliases.map((id) => ({
      id,
      resolvedModel: null,
      label: id === "default" ? "Default" : id[0].toUpperCase() + id.slice(1),
      description: "",
      effortLevels: id === "haiku" ? [] : effortLevels,
      defaultEffort: null,
      isDefault: id === "default",
    })),
    effortLevels,
    source: "fallback",
    updatedAt: Date.now(),
    message: error instanceof Error ? error.message : "Model discovery failed.",
  };
}

async function discoverClaudeModels(cwd: string): Promise<AiModelOption[]> {
  let releaseInput: () => void = () => {};
  async function* idleInput(): AsyncGenerator<SDKUserMessage, void, unknown> {
    await new Promise<void>((resolve) => { releaseInput = resolve; });
  }
  const abortController = new AbortController();
  const session = query({
    prompt: idleInput(),
    options: {
      abortController,
      cwd,
      pathToClaudeCodeExecutable: "claude",
      settingSources: ["user", "project", "local"],
    },
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Claude model discovery timed out.")), REQUEST_TIMEOUT_MS);
    });
    return normalizeClaudeModels(await Promise.race([session.supportedModels(), timeout]));
  } finally {
    if (timer) clearTimeout(timer);
    releaseInput();
    abortController.abort();
    session.close();
  }
}

function discoverCodexModels(cwd: string): Promise<AiModelOption[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    const lines = readline.createInterface({ input: child.stdout });
    const entries: any[] = [];
    let settled = false;
    let requestId = 2;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(normalizeCodexModels(entries));
    };
    const send = (message: unknown) => {
      if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + "\n");
    };
    const requestPage = (cursor?: string) => {
      send({
        id: requestId,
        method: "model/list",
        params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) },
      });
    };
    const timer = setTimeout(
      () => finish(new Error("Codex model discovery timed out.")),
      REQUEST_TIMEOUT_MS,
    );

    child.on("error", () => finish(new Error("Could not start the Codex app server.")));
    child.on("exit", (code) => {
      if (!settled) finish(new Error(`Codex app server exited with code ${code ?? "unknown"}.`));
    });
    lines.on("line", (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 1) {
        if (message.error) return finish(new Error("Codex app server initialization failed."));
        send({ method: "initialized" });
        requestPage();
        return;
      }
      if (message.id !== requestId) return;
      if (message.error) return finish(new Error("Codex model discovery failed."));
      entries.push(...(Array.isArray(message.result?.data) ? message.result.data : []));
      const cursor = typeof message.result?.nextCursor === "string"
        ? message.result.nextCursor.trim()
        : "";
      if (cursor) {
        requestId += 1;
        requestPage(cursor);
      } else {
        finish();
      }
    });

    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "psm", title: "PSM", version: "0.1.0" } },
    });
  });
}

export async function modelCatalog(engine: AiEngine, cwd: string): Promise<AiModelCatalog> {
  try {
    const models = engine === "claude"
      ? await discoverClaudeModels(cwd)
      : await discoverCodexModels(cwd);
    if (!models.length) throw new Error(`${engine} returned no available models.`);
    return {
      engine,
      models,
      effortLevels: uniqueStrings(models.flatMap((model) => model.effortLevels)),
      source: "live",
      updatedAt: Date.now(),
      message: null,
    };
  } catch (error) {
    return fallbackCatalog(engine, error);
  }
}
