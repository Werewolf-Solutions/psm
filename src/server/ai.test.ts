/**
 * The boundary around the coding CLI psm shells out to.
 *
 * Not what it says back — that is the provider's business — but what psm hands
 * it: how much authority the turn runs with, which of psm's own variables travel
 * into it, and how the transcript it produces is stored.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "psm-ai-"));
const sessionsFile = path.join(sandbox, "sessions.json");
process.env.PSM_SESSIONS_FILE = sessionsFile;

const { permittedFullAccess, restoreCachedRecap } = await import("./ai.ts");

/* ---------- how much authority one turn runs with ---------- */

test("a request cannot grant itself access the project does not have", () => {
  assert.equal(
    permittedFullAccess(false, true),
    false,
    "a POST asking for full access on a sandboxed project must not get it — " +
      "that flag is --dangerously-bypass-approvals-and-sandbox",
  );
});

test("a request can ask for less than the project allows", () => {
  assert.equal(
    permittedFullAccess(true, false),
    false,
    "turning the toggle off has to take effect on the next send, before its PATCH lands",
  );
});

test("saying nothing means the project's saved setting", () => {
  assert.equal(permittedFullAccess(true, undefined), true);
  assert.equal(permittedFullAccess(false, undefined), false);
});

test("only an explicit false is a downgrade — nothing else is an upgrade", () => {
  for (const requested of [null, 0, "", "false", "no", NaN, {}]) {
    assert.equal(
      permittedFullAccess(false, requested),
      false,
      `${JSON.stringify(requested)} must not raise a sandboxed project's authority`,
    );
    assert.equal(
      permittedFullAccess(true, requested),
      true,
      `${JSON.stringify(requested)} is not the explicit opt-out, so the saved setting stands`,
    );
  }
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
