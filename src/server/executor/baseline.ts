/**
 * The project's tests at the job's starting commit, run by psm itself before
 * any agent starts.
 *
 * An implement job can only end in review with passing checks, so a project
 * whose tests are already red (or that has none psm can run) can never get
 * there. Finding that out first costs one sandbox run instead of an agent
 * session that edits, commits and then stalls on failures it did not cause —
 * and the owner hears the real problem: "fix these tests first".
 */
import type { PermissionChecker } from "../agent-permissions.ts";
import type { RepositoryTools } from "../agent-repository-tools.ts";
import { ManagedTaskRunner, agentImage, type TaskExecutor } from "../agent-task-runner.ts";

export type Baseline =
  | { status: "pass"; summary: string }
  /** Tests ran and something failed (or they could not run at all). */
  | { status: "fail"; stage: "install" | "tests"; summary: string; failing: string[]; output: string }
  /** Nothing psm can run: no package.json, no test script, or zero tests. */
  | { status: "no-tests"; summary: string }
  /** psm's own sandbox is missing; not the project's fault. */
  | { status: "unavailable"; summary: string };

/** npm init's placeholder, which only ever fails. */
const PLACEHOLDER = /no test specified/i;

/** Counts and failing test names from node --test (TAP), Jest/Vitest or Mocha output. */
export function readTestOutput(output: string): { total: number | null; passed: number | null; failed: number | null; failing: string[] } {
  const num = (pattern: RegExp) => {
    const match = output.match(pattern);
    return match ? Number(match[1]) : null;
  };
  let total = num(/^# tests (\d+)/m);
  let passed = num(/^# pass (\d+)/m);
  let failed = num(/^# fail (\d+)/m);
  if (total == null) {
    const jest = output.match(/^Tests:\s+(.*)$/m)?.[1];
    if (jest) {
      failed = Number(jest.match(/(\d+) failed/)?.[1] ?? 0);
      passed = Number(jest.match(/(\d+) passed/)?.[1] ?? 0);
      total = Number(jest.match(/(\d+) total/)?.[1] ?? failed + passed);
    } else {
      passed = num(/^\s*(\d+) passing\b/m) ?? passed;
      failed = num(/^\s*(\d+) failing\b/m) ?? failed;
      if (passed != null || failed != null) total = (passed ?? 0) + (failed ?? 0);
    }
  }
  // Top-level TAP failures only: a failing subtest also fails its parent, which is named already.
  const failing = [...output.matchAll(/^not ok \d+ - (.+)$/gm), ...output.matchAll(/^\s*● (.+?)(?: › .*)?$/gm)].map((match) => match[1].trim());
  return { total, passed, failed, failing: [...new Set(failing)] };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export async function runBaseline(
  repository: RepositoryTools,
  checker: PermissionChecker,
  signal: AbortSignal,
  execute?: TaskExecutor,
): Promise<Baseline> {
  let pkg: { scripts?: Record<string, unknown> };
  try {
    pkg = JSON.parse(repository.read("package.json"));
  } catch {
    return { status: "no-tests", summary: "The project has no package.json, so psm has no tests it can run to check a change." };
  }
  const script = pkg.scripts?.test;
  if (typeof script !== "string" || !script.trim() || PLACEHOLDER.test(script)) {
    return { status: "no-tests", summary: "package.json has no test script, so psm cannot check a change. Add tests (or a \"test\" script) first." };
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  // Installing into the clone too means the agent's shell starts with the project's packages.
  const runner = new ManagedTaskRunner(repository, checker, controller.signal, execute, undefined, undefined, { checkoutDeps: true, taskImage: agentImage() });
  try {
    let hasLock = false;
    try { repository.read("package-lock.json"); hasLock = true; } catch { /* nothing to install */ }
    if (hasLock) {
      try {
        await runner.install(".");
      } catch (error) {
        const message = (error as Error).message;
        if (/sandbox is unavailable|docker/i.test(message) && !/Sandbox task failed/.test(message)) return { status: "unavailable", summary: message };
        return { status: "fail", stage: "install", summary: message.split("\n")[0].slice(0, 300), failing: [], output: message.slice(-8000) };
      }
    }
    let output: string;
    let ok = true;
    try {
      output = await runner.tests("test");
    } catch (error) {
      output = (error as Error).message;
      if (!/^Sandbox task failed/.test(output)) return { status: "unavailable", summary: output };
      ok = false;
    }
    const counts = readTestOutput(output);
    if (ok && counts.total === 0) return { status: "no-tests", summary: `"npm test" runs (${script}) but finds no tests, so psm cannot check a change.` };
    if (ok) return { status: "pass", summary: counts.total != null ? `${plural(counts.passed ?? counts.total, "test")} pass` : "the test script passes" };
    const summary = counts.failed != null
      ? `${plural(counts.failed, "test")} failing${counts.passed != null ? `, ${counts.passed} passing` : ""}`
      : "the test script exits with an error";
    return { status: "fail", stage: "tests", summary, failing: counts.failing.slice(0, 20), output: output.slice(-8000) };
  } finally {
    signal.removeEventListener("abort", onAbort);
    runner.close();
  }
}

const TEST_WORD = String.raw`\b(?:tests?|specs?|test suite)\b`;
const FIX_WORD = String.raw`\b(?:fix(?:es|ing)?|repair|failing|fails?|failed|broken|red|green|pass(?:es|ing)?)\b`;
/** A fix word and a test word within a few words of each other, either order. */
const FIXING_TESTS = new RegExp(`${FIX_WORD}(?:\\W+\\w+){0,3}?\\W+${TEST_WORD}|${TEST_WORD}(?:\\W+\\w+){0,3}?\\W+${FIX_WORD}`, "i");

/**
 * A task whose point is to make failing tests pass can start from red tests.
 * Read from the owner's note only, never the triage rationale, which mentions
 * tests in passing ("run tests before and after the change"). It needs a test
 * word next to a fix or failure word: "fix the dashboard test", "tests are red".
 */
export function fixesTests(note: string): boolean {
  return FIXING_TESTS.test(note);
}

/** The stall reason the owner reads when the starting point is not usable. */
export function baselineProblem(baseline: Baseline, projectName: string): string | null {
  if (baseline.status === "pass") return null;
  if (baseline.status === "unavailable") return `psm could not check ${projectName}'s tests before starting: ${baseline.summary}`;
  if (baseline.status === "no-tests") return `${baseline.summary} Nothing was changed; the agent was not started.`;
  if (baseline.stage === "install") return `psm could not install ${projectName}'s packages to run its tests: ${baseline.summary} Nothing was changed; the agent was not started.`;
  const names = baseline.failing.length ? ` Failing: ${baseline.failing.slice(0, 5).join("; ")}${baseline.failing.length > 5 ? `; and ${baseline.failing.length - 5} more` : ""}.` : "";
  return `${projectName}'s tests already fail before any change (${baseline.summary}).${names} Fix them first — a job can only reach review with passing tests. Nothing was changed; the agent was not started.`;
}
