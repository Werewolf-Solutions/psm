/**
 * An implement job's current step, in a few words, for Todo.
 *
 * psm sends the step to the hub on a heartbeat whenever it changes; the hub
 * pushes it to the note, so the owner sees "Running the tests" rather than a
 * bare "implementing…" for the whole run. Only steps are sent — never file
 * names, commands or output, which stay in psm's local activity.
 */
import type { AgentLine } from "./activity.ts";
import { toolName } from "./stop-rules.ts";

/** The step an agent tool call means, or null when it does not change the step. */
export function stepForTool(text: string): string | null {
  const [raw = "", ...rest] = text.trim().split(/\s+/);
  const name = toolName(raw);
  const arg = rest.join(" ");
  switch (name) {
    case "files":
    case "read":
    case "search":
    case "git_read":
      return "Reading the code";
    case "write":
    case "edit":
      return "Making the change";
    case "install_packages":
      return "Installing packages";
    case "run_tests":
      return "Running the tests";
    case "run_script":
      return /^build\b/.test(arg) ? "Building" : `Running ${arg.split(" ")[0] || "a script"}`;
    case "preview_check":
      return "Checking the app in a browser";
    case "git_commit":
      return "Committing";
    case "sandbox_shell":
      return /\bgit\s+commit\b/.test(arg) ? "Committing" : "Making the change";
    default:
      return null;
  }
}

export function stepForLine(line: Pick<AgentLine, "type" | "text">): string | null {
  return line.type === "tool" ? stepForTool(line.text) : null;
}

/**
 * Sends a job's step only when it changes. Never throws and never waits: a
 * hub that does not answer costs the owner a stale line in Todo, not the job.
 */
export function stepReporter(send: (jobId: string, step: string) => Promise<unknown>, log: (message: string) => void = () => {}) {
  const last = new Map<string, string>();
  return {
    report(jobId: string, step: string | null): void {
      if (!step || last.get(jobId) === step) return;
      last.set(jobId, step);
      send(jobId, step).catch((error) => log(`executor: could not report the step for ${jobId}: ${(error as Error).message}`));
    },
    forget(jobId: string): void {
      last.delete(jobId);
    },
  };
}
