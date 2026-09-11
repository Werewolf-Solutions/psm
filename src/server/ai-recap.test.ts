import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AiEvent } from "./ai.ts";

// ai.ts loads saved sessions on import; point it at an empty file first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-recap-"));
process.env.PSM_SESSIONS_FILE = path.join(dir, "sessions.json");
const { conversationTurns, recapIsCurrent } = await import("./ai.ts");
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const said = (role: "user" | "assistant", text: string) => ({ t: 0, role, text });
const system = (text: string) => ({ t: 0, role: "system" as const, text });

test("system lines do not make a recap stale", () => {
  const log: AiEvent[] = [said("user", "fix the deploy"), said("assistant", "done")];
  const s = { summary: "- fixed the deploy", summaryAt: log.length, summaryTurns: conversationTurns(log), log };
  log.push(system("— switched to codex; starting a new conversation —"), system("→ Read(app.ts)"));
  assert.equal(recapIsCurrent(s), true, "an engine switch or a tool echo is not a reason to spend an AI call");
  log.push(said("user", "now the banner"));
  assert.equal(recapIsCurrent(s), false, "a new message is");
});

test("a recap saved before turns were counted keeps the old rule until regenerated", () => {
  const log: AiEvent[] = [said("user", "a"), said("assistant", "b"), system("c")];
  assert.equal(recapIsCurrent({ summary: "- a", summaryAt: 3, log }), true);
  assert.equal(recapIsCurrent({ summary: "- a", summaryAt: 2, log }), false);
});

test("no summary is never current", () => {
  assert.equal(recapIsCurrent({ summary: null, summaryAt: 99, summaryTurns: 99, log: [] }), false);
});
