/**
 * The boundary around the coding CLI psm shells out to.
 *
 * Not what it says back — that is the provider's business — but what psm hands
 * it: how much authority the turn runs with, which of psm's own variables travel
 * into it, and how the transcript it produces is stored.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "psm-ai-"));
const sessionsFile = path.join(sandbox, "sessions.json");
process.env.PSM_SESSIONS_FILE = sessionsFile;

const {
  buildCommand,
  parseAiMode,
  planningSessionKey,
  parseWorkroomProposal,
  resolveExtraDirs,
  restoreCachedRecap,
  resultIsLimit,
  limitAppliesTo,
  limitWindowLabel,
  writableRootArgs,
  WORKSPACE_NAME,
  aiState,
  selectAi,
  subscribeAi,
} = await import("./ai.ts");
type TurnSpec = Parameters<typeof buildCommand>[0];

test("a workroom handoff keeps the source project first and needs a concrete objective", () => {
  assert.deepEqual(
    parseWorkroomProposal("todo-app", {
      projects: ["other-app", "todo-app", "other-app"],
      title: "Shared change",
      objective: "Update the API and its caller",
    }),
    { projects: ["todo-app", "other-app"], title: "Shared change", objective: "Update the API and its caller" },
  );
  assert.throws(() => parseWorkroomProposal("todo-app", { projects: ["todo-app"], objective: "One project" }));
  assert.throws(() => parseWorkroomProposal("todo-app", { projects: ["other-app"], objective: "" }));
});

test("reconnecting with stale picker values does not switch the active provider", () => {
  const name = `stream-selection-${Date.now()}`;
  const cwd = repo("stream-selection");
  const subscribe = (engine: "claude" | "codex") => {
    const response = Object.assign(new EventEmitter(), {
      chunks: [] as string[],
      setHeader() {}, flushHeaders() {},
      write(chunk: string) { this.chunks.push(chunk); },
    });
    subscribeAi(response as unknown as Parameters<typeof subscribeAi>[0], name, cwd, engine, null, null);
    response.emit("close");
  };
  subscribe("claude");
  subscribe("codex");
  assert.equal(aiState(name).engine, "claude", "a passive stale stream cannot reset a session");
  selectAi(name, cwd, "codex", null, null);
  assert.equal(aiState(name).engine, "codex", "an explicit picker action can change it");
  subscribe("claude");
  assert.equal(aiState(name).engine, "codex", "reopening the old tab still cannot switch it back");
});

/** A turn as psm would describe it, with only what a case cares about spelled out. */
function spec(over: Partial<TurnSpec> = {}): TurnSpec {
  return {
    name: "consumer",
    cwd: path.join(sandbox, "consumer"),
    engine: "claude",
    model: null,
    effort: null,
    sessionId: null,
    extraDirs: [],
    ...over,
  };
}

/** A directory that exists, since resolution is done against the real filesystem. */
function repo(name: string): string {
  const dir = path.join(sandbox, name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

/* ---------- how much authority one turn runs with ---------- */

test("an unknown or missing chat mode falls back to the CLI's own default", () => {
  for (const requested of [undefined, null, true, "bypassPermissions", "acceptEdits", {}]) {
    assert.equal(parseAiMode(requested), "default");
  }
  assert.equal(parseAiMode("plan"), "plan");
  assert.equal(parseAiMode("auto"), "auto");
});

/* ---------- what psm hands the CLI ---------- */

test("psm's own variables do not reach the CLI", async () => {
  const { childEnv } = await import("./procs.ts");
  const saved = { port: process.env.PORT, mode: process.env.PSM_MODE };
  process.env.PORT = "4317"; // psm's own listening port
  process.env.PSM_MODE = "dev";
  try {
    const env = childEnv();
    assert.equal(env.PORT, undefined, "the CLI starts dev servers; psm's port must not be their default");
    assert.equal(env.PSM_MODE, undefined, "psm's configuration is psm's business");
    assert.equal(
      env.PSM_SESSIONS_FILE,
      undefined,
      "the CLI has no reason to know where psm keeps its transcripts",
    );
    assert.ok(env.PATH, "scrubbing psm's variables must not leave the CLI unable to find anything");
  } finally {
    if (saved.port === undefined) delete process.env.PORT;
    else process.env.PORT = saved.port;
    if (saved.mode === undefined) delete process.env.PSM_MODE;
    else process.env.PSM_MODE = saved.mode;
  }
});

/* ---------- how the transcript is stored ---------- */

test("the session store is written private, and whole", async () => {
  restoreCachedRecap("psm-ai-test", "where we left off");
  // the save is debounced, so give the timer room
  await new Promise((resolve) => setTimeout(resolve, 800));

  assert.ok(fs.existsSync(sessionsFile), "a save should have landed");
  assert.equal(
    fs.statSync(sessionsFile).mode & 0o777,
    0o600,
    "transcripts and provider session ids are not for every account on the machine",
  );

  // Parsing at all is the point: this file used to be truncated and refilled in
  // place, so a crash mid-write left a document the loader silently dropped.
  const parsed = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
  assert.equal(typeof parsed.sessions, "object");
  assert.equal(typeof parsed.limits, "object");

  assert.deepEqual(
    fs.readdirSync(sandbox).filter((entry) => entry.endsWith(".tmp")),
    [],
    "a temp file left beside the store means the rename did not happen",
  );
});

/* ---------- which directories are in scope ---------- */

test("a missing checkout drops out of scope rather than being passed on", () => {
  const primary = repo("primary");
  const gone = path.join(sandbox, "deleted-since");
  assert.deepEqual(
    resolveExtraDirs(primary, [gone]),
    [],
    "a path that no longer resolves must not reach the CLI",
  );
});

test("a symlink is resolved to what it actually points at", () => {
  const primary = repo("sym-primary");
  const real = repo("sym-target");
  const link = path.join(sandbox, "sym-link");
  fs.symlinkSync(real, link);
  assert.deepEqual(
    resolveExtraDirs(primary, [link]),
    [real],
    "scope is decided on the real path, or a link out of the workspace would widen it silently",
  );
});

test("a directory already inside the project is not listed again", () => {
  const primary = repo("nest-primary");
  const inside = repo(path.join("nest-primary", "packages"));
  assert.deepEqual(
    resolveExtraDirs(primary, [inside]),
    [],
    "the scope shown to the user must match what is actually widened",
  );
});

test("one extra root swallows another nested inside it", () => {
  const primary = repo("outer-primary");
  const outer = repo("outer");
  const inner = repo(path.join("outer", "inner"));
  assert.deepEqual(resolveExtraDirs(primary, [inner, outer]), [outer]);
});

test("the same set in a different order is the same scope", () => {
  const primary = repo("order-primary");
  const a = repo("order-a");
  const b = repo("order-b");
  assert.deepEqual(
    resolveExtraDirs(primary, [b, a]),
    resolveExtraDirs(primary, [a, b]),
    "order must not decide whether a conversation is forked",
  );
});

test("duplicates collapse", () => {
  const primary = repo("dup-primary");
  const other = repo("dup-other");
  assert.deepEqual(resolveExtraDirs(primary, [other, other]), [other]);
});

/* ---------- what each CLI is actually told ---------- */

test("each directory becomes its own --add-dir", () => {
  assert.deepEqual(
    writableRootArgs(["/w/a", "/w/b"]),
    ["--add-dir", "/w/a", "--add-dir", "/w/b"],
    "both CLIs take the flag repeated, not a joined list",
  );
});

test("no extra directories means no extra flags", () => {
  assert.deepEqual(writableRootArgs([]), []);
});

/* ---------- the command line psm actually spawns ---------- */

test("claude is given each extra repository, and the default mode adds no permission flag", () => {
  const { cmd, args } = buildCommand(
    spec({ extraDirs: ["/w/provider"] }),
    "do the thing",
    "default",
  );
  assert.equal(cmd, "claude");
  assert.deepEqual(
    args.slice(args.indexOf("--add-dir"), args.indexOf("--add-dir") + 2),
    ["--add-dir", "/w/provider"],
  );
  assert.ok(!args.includes("--permission-mode"), "default leaves the CLI's own setting in charge");
  assert.equal(args.at(-1), "do the thing", "the prompt is an argument, never a shell string");
});

test("codex is given the same directories, and the default mode adds no sandbox flag", () => {
  const { cmd, args } = buildCommand(
    spec({ engine: "codex", extraDirs: ["/w/provider"] }),
    "do the thing",
    "default",
  );
  assert.equal(cmd, "codex");
  assert.deepEqual(args.slice(0, 2), ["exec", "--json"]);
  assert.ok(!args.includes("-s"), "default leaves config.toml in charge");
  assert.ok(args.includes("--add-dir") && args.includes("/w/provider"));
});

test("plan and auto map onto each CLI's own flags", () => {
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
  assert.equal(flag(buildCommand(spec(), "go", "plan").args, "--permission-mode"), "plan");
  assert.equal(flag(buildCommand(spec(), "go", "auto").args, "--permission-mode"), "auto");
  assert.equal(flag(buildCommand(spec({ engine: "codex" }), "go", "plan").args, "-s"), "read-only");
  assert.equal(flag(buildCommand(spec({ engine: "codex" }), "go", "auto").args, "-s"), "workspace-write");
  assert.equal(flag(buildCommand(spec({ name: WORKSPACE_NAME }), "go", "auto").args, "--permission-mode"), "auto");
});

test("a planner may read the other repository but not write anywhere", () => {
  const { args } = buildCommand(
    spec({ name: planningSessionKey("consumer", "planner"), extraDirs: ["/w/provider"] }),
    "plan it",
    "auto", // even when the chat bar says auto
  );
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan", "a planner stays a planner");
  const codex = buildCommand(spec({ name: planningSessionKey("consumer", "reviewer"), engine: "codex" }), "review", "default");
  assert.equal(codex.args[codex.args.indexOf("-s") + 1], "read-only");
  assert.ok(args.includes("--add-dir"), "it still has to be able to read the other side");
});

test("the scope the AI is told matches the scope it is given", () => {
  const { args } = buildCommand(spec({ extraDirs: ["/w/provider"] }), "go", "default");
  const prompt = args[args.indexOf("--append-system-prompt") + 1];
  assert.match(prompt, /\/w\/provider/, "the directory in the argv has to be the one named in the prompt");
  assert.match(prompt, /Nothing outside them is writable/);
});

test("one project on its own gets no scope section and no extra flags", () => {
  const { args } = buildCommand(spec(), "go", "default");
  assert.ok(!args.includes("--add-dir"), "the common case must stay exactly as it was");
  const prompt = args[args.indexOf("--append-system-prompt") + 1] ?? "";
  assert.ok(!prompt.includes("## Scope"), "nothing to say when there is nothing else in scope");
});

test("resuming carries the scope flags too, not just the session id", () => {
  const { args } = buildCommand(
    spec({ sessionId: "abc-123", extraDirs: ["/w/provider"] }),
    "carry on",
    "default",
  );
  assert.equal(args[args.indexOf("--resume") + 1], "abc-123");
  assert.ok(
    args.includes("--add-dir"),
    "a resumed turn is still a turn — the directories have to be passed again",
  );
});

test("every turn asks for diagrams as rendered figures, not ASCII art", () => {
  // The transcript renders a ```html block inline (web/app.js renderAiText); box
  // art drawn in a text fence is unreadable in a proportional bubble, so the ask
  // has to reach the model on every turn, resumed turns included.
  const { args } = buildCommand(spec({ sessionId: "abc-123" }), "explain the architecture", "default");
  const prompt = args[args.indexOf("--append-system-prompt") + 1];
  assert.match(prompt, /```psm-figure/, "the fence psm renders is the one the model is told to write");
  assert.match(prompt, /do not draw it as ASCII or box art/);
  assert.match(prompt, /```html block is not a figure/, "showing markup must stay showing markup");
});

test("codex hears the same figure rule when it resumes", () => {
  // codex has no system-prompt flag: on resume only INTERACTION_RULES rides
  // along, which is exactly why the rule lives there and not in the house rules.
  const { args } = buildCommand(
    spec({ engine: "codex", sessionId: "abc-123" }),
    "explain the architecture",
    "default",
  );
  assert.match(String(args.at(-1)), /```psm-figure/);
});

/* ---------- reading a limit out of what came back ---------- */

test("a turn that merely talks about usage limits is not a usage limit", () => {
  // `result` on a successful turn is the assistant's own reply. Treating its
  // words as a provider verdict paused the whole engine for fifteen minutes
  // whenever the AI was asked about usage — including while building this pane.
  for (const reply of [
    "The usage limit banner now clears itself after the window passes.",
    "Retry on 429 with backoff.",
    "I checked your quota and it looks fine.",
  ]) {
    assert.equal(resultIsLimit({ is_error: false, result: reply }), false, reply);
  }
});

test("a failed turn that says it was limited is a usage limit", () => {
  assert.equal(
    resultIsLimit({ is_error: true, result: "Claude usage limit reached; try again at 5pm" }),
    true,
  );
});

test("a failure for some other reason is not a usage limit", () => {
  assert.equal(resultIsLimit({ is_error: true, result: "the command exited with code 1" }), false);
  assert.equal(resultIsLimit({ is_error: true }), false);
});

/* ---------- which model a usage limit actually governs ---------- */

test("a spent weekly Opus window does not block a Sonnet turn", () => {
  // The provider says which window it rejected. Ignoring that turned one
  // model's exhausted weekly allowance into "you are out of Claude" for a week.
  assert.equal(limitAppliesTo("seven_day_opus", "claude-sonnet-4-5"), false);
  assert.equal(limitAppliesTo("seven_day_sonnet", "claude-opus-4-5"), false);
});

test("a window that governs the model in use does block it", () => {
  assert.equal(limitAppliesTo("seven_day_opus", "opus"), true);
  assert.equal(limitAppliesTo("seven_day_sonnet", "claude-sonnet-4-5"), true);
});

test("windows that cover every model always apply", () => {
  for (const scope of ["five_hour", "seven_day", "overage", null]) {
    assert.equal(limitAppliesTo(scope, "claude-sonnet-4-5"), true, String(scope));
  }
});

test("a model-specific window is not assumed to bind an unknown model", () => {
  // Nothing is configured and the session has not reported one yet: blocking on
  // a guess is worse than letting the turn run and hearing the real verdict.
  assert.equal(limitAppliesTo("seven_day_opus", null), false);
});

test("a limit says which window it came from", () => {
  assert.equal(limitWindowLabel("seven_day_opus"), "7-day Opus");
  assert.equal(limitWindowLabel("five_hour"), "5-hour");
  assert.equal(limitWindowLabel("something_new"), null);
});

test("running out of credits for one model does not block the others", () => {
  // Observed: on model `opus` Claude returned "You're out of usage credits.
  // Switch to another model" while the account sat at 24% of its 5-hour window.
  // psm recorded that as an engine-wide limit and paused every Claude chat for a
  // week — including the default model the provider was pointing the user at.
  assert.equal(limitAppliesTo("model:opus", "opus"), true);
  assert.equal(limitAppliesTo("model:opus", "claude-sonnet-4-5"), false);
  assert.equal(limitAppliesTo("model:opus", null), false);
});

test("a model-scoped limit matches regardless of case or padding", () => {
  assert.equal(limitAppliesTo("model:opus", "  Opus  "), true);
});
