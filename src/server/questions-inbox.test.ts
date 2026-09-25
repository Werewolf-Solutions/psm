import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-pending-questions-"));
process.env.PSM_SESSIONS_FILE = path.join(root, "sessions.json");
const saved = (id: string, askedAt: number) => ({
  engine: "claude", log: [], question: {
    id, engine: "claude", askedAt,
    questions: [{ id: "one", header: "Question", question: "Choose an option", options: [], multiSelect: false, isSecret: false }],
  },
});
fs.writeFileSync(process.env.PSM_SESSIONS_FILE, JSON.stringify({ sessions: {
  "todo": saved("project-question", 5),
  "__psm_work__:room-1": saved("workroom-question", 4),
  "__workspace__": saved("workspace-question", 3),
  "__psm_planning__:planner:project%20with%20spaces": saved("planner-question", 2),
  "__psm_planning__:reviewer:project%20with%20spaces": saved("reviewer-question", 1),
  "idle": { engine: "claude", log: [], question: null },
} }));
const ai = await import("./ai.ts");
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("the inbox restores all pending question types without opening or running their sessions", () => {
  const entries = ai.pendingQuestions();
  assert.deepEqual(entries.map(({ project, scope, role, roomId }) => ({ project, scope, role, roomId })), [
    { project: "project with spaces", scope: "planner", role: "reviewer", roomId: null },
    { project: "project with spaces", scope: "planner", role: "planner", roomId: null },
    { project: "__workspace__", scope: "ai", role: null, roomId: null },
    { project: "work:room-1", scope: "ai", role: null, roomId: "room-1" },
    { project: "todo", scope: "ai", role: null, roomId: null },
  ]);
  assert.equal(ai.aiState("todo").busy, false);
  assert.equal(ai.aiState("todo").queueDepth, 0);
  ai.stopSession("todo");
  assert.equal(ai.pendingQuestions().length, 4, "resolved/stopped requests leave the inbox");
});
