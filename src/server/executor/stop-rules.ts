/**
 * The stop rules for an implement job (P14 E2), enforced by the executor from
 * the agent's own tool calls — never left to the prompt:
 *
 *   - the same failing check three times (same tool, same failure once
 *     timings, ports and ids are blanked out);
 *   - no progress: a check fails the same way twice in a row while the clone
 *     has not changed in between (same HEAD, same diff, same new files);
 *   - a backstop on the number of tool calls.
 *
 * The 60-minute limit is a timer in implement-job.ts. A stop is final: the job
 * ends `stalled` with the reason, it does not retry silently.
 */

/** Tools whose result is a verdict on the work: a failure here is a "failing check". */
export const CHECK_TOOLS: ReadonlySet<string> = new Set(["run_tests", "run_script", "preview_check"]);

export interface StopVerdict {
  reason: string;
}

/** Claude MCP and Codex dynamic-tool names both reduce to the same PSM name. */
export function toolName(raw: string): string {
  return raw.replace(/^(?:mcp__psm__|psm_)/, "");
}

/**
 * The failure with what changes run to run blanked out, so "the same failure"
 * means the same thing failing, not byte-identical logs.
 */
export function failureSignature(tool: string, text: string): string {
  const tail = text.slice(-4000);
  const normalized = tail
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, "<time>")
    .replace(/\b[0-9a-f]{7,64}\b/gi, "<id>")
    .replace(/psm-task-[0-9a-f-]+/g, "<container>")
    .replace(/\d+(\.\d+)?\s*(ms|s|m)\b/g, "<duration>")
    .replace(/:\d{2,5}\b/g, ":<port>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
  return `${tool}\0${normalized}`;
}

export interface StopRuleOptions {
  /** Identity of the clone's state: HEAD, the diff, new files. */
  treeState: () => string;
  maxSameFailure?: number;
  maxToolCalls?: number;
}

export class StopRules {
  readonly #pending = new Map<string, string>();
  readonly #failures = new Map<string, number>();
  readonly #maxSameFailure: number;
  readonly #maxToolCalls: number;
  #calls = 0;
  #lastCheck: { signature: string | null; tree: string } | null = null;
  /** Latest outcome per check, e.g. `run_tests:test` → ok. Reported with the result. */
  readonly checks = new Map<string, boolean>();

  constructor(private readonly options: StopRuleOptions) {
    this.#maxSameFailure = options.maxSameFailure ?? 3;
    this.#maxToolCalls = options.maxToolCalls ?? 400;
  }

  /** The agent called a tool. `label` names the check, e.g. the script. */
  toolUse(id: string, rawName: string, label = ""): StopVerdict | null {
    this.#calls++;
    const name = toolName(rawName);
    this.#pending.set(id, label ? `${name}:${label}` : name);
    if (this.#calls > this.#maxToolCalls) {
      return { reason: `Stopped after ${this.#maxToolCalls} tool calls without finishing.` };
    }
    return null;
  }

  /** A tool answered. Only checks can stop the job here. */
  toolResult(id: string, isError: boolean, text: string): StopVerdict | null {
    const key = this.#pending.get(id);
    this.#pending.delete(id);
    if (!key) return null;
    const name = key.split(":")[0];
    if (!CHECK_TOOLS.has(name)) return null;
    this.checks.set(key, !isError);

    const tree = this.options.treeState();
    const signature = isError ? failureSignature(key, text) : null;
    const previous = this.#lastCheck;
    this.#lastCheck = { signature, tree };
    if (!signature) return null;

    const count = (this.#failures.get(signature) ?? 0) + 1;
    this.#failures.set(signature, count);
    if (count >= this.#maxSameFailure) {
      return { reason: `The same check failed ${count} times (${key.replace(":", " ")}). Stopped rather than trying again.` };
    }
    if (previous && previous.signature === signature && previous.tree === tree) {
      return { reason: `No progress: ${key.replace(":", " ")} failed the same way twice with nothing changed in between.` };
    }
    return null;
  }
}
