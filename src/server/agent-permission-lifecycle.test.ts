import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "./db.ts";
import { AgentPermissionStore, PREPARATION_OPERATIONS, reviewAgentPermissions } from "./agent-permissions.ts";
import { ManagedResumeUnavailableError } from "./agent-session-errors.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-permission-lifecycle-"));
process.env.PSM_SESSIONS_FILE = path.join(root, "transcript.json");
const ai = await import("./ai.ts");
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("revocation aborts the managed turn, clears its queue and blocks resume before spawn", async (t) => {
  const database = openDatabase(":memory:");
  const store = new AgentPermissionStore(() => database);
  const project = { id: "prj_test", name: "test", path: root };
  for (const operation of PREPARATION_OPERATIONS) store.change(project, operation.permission, true, store.snapshot(project).revision, "operator");
  const running: AbortController[] = [];
  ai.configureManagedAgents((scope) => {
    const snapshot = store.snapshot(project);
    const gap = reviewAgentPermissions([snapshot], scope.engine, PREPARATION_OPERATIONS.map((entry) => entry.permission));
    if (gap) throw new Error(gap);
    return { store, snapshots: [snapshot], protectedRoots: [] };
  }, async (input) => {
    running.push(input.signal);
    await new Promise<void>((resolve) => input.signal.signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  t.after(() => { ai.stopSession("test"); ai.configureManagedAgents(null); database.close(); });
  const send = () => ai.send("test", root, "claude", null, null, "continue", "auto");
  assert.equal(send().ok, true);
  assert.equal(running.length, 1, "auto mode cannot bypass the managed runner");
  assert.equal(send().queued, true);
  store.change(project, "git.commit", false, store.snapshot(project).revision, "operator");
  ai.stopProjectAgents(root);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(running[0].signal.aborted, true);
  assert.equal(ai.aiState("test").busy, false);
  assert.equal(ai.aiState("test").queueDepth, 0);
  assert.match(send().error!, /requires git.commit/);
  assert.equal(running.length, 1, "neither queued nor resumed work was spawned");
});

test("a managed Claude session resumes while its authority is unchanged, and restarts after a reduction", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "psm-resume-"));
  const database = openDatabase(":memory:");
  const store = new AgentPermissionStore(() => database);
  const project = { id: "prj_resume", name: "resume", path: directory };
  store.changeMany(project, ["repo.read", "repo.edit", "git.commit"], true, 0, "operator");
  const calls: Array<{ resume: string | null; context: string }> = [];
  let failResume = false;
  ai.configureManagedAgents(() => ({ store, snapshots: [store.snapshot(project)], protectedRoots: [], taskNotes: "Operator decisions in this task: none yet" }), async (input) => {
    calls.push({ resume: input.resume ?? null, context: input.context });
    if (input.resume && failResume) throw new Error("No conversation found with session ID");
    input.event({ type: "system", subtype: "init", session_id: `session-${calls.length}` });
  });
  t.after(() => { ai.stopSession("resume"); ai.configureManagedAgents(null); database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const turn = async (message: string) => {
    assert.equal(ai.send("resume", directory, "claude", null, null, message, "default").ok, true);
    for (let i = 0; i < 50 && ai.aiState("resume").busy; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  await turn("first");
  assert.equal(calls[0].resume, null);
  assert.match(calls[0].context, /Recent conversation/);
  assert.match(calls[0].context, /Operator decisions in this task/);
  await turn("second");
  assert.equal(calls[1].resume, "session-1", "same authority: resume the provider's own session");
  assert.doesNotMatch(calls[1].context, /Recent conversation/, "a resumed session already has it");
  // An added grant does not change the authority key's restriction revision.
  store.changeMany(project, ["repo.delete"], true, store.snapshot(project).revision, "operator");
  await turn("third");
  assert.equal(calls[2].resume, "session-2");
  // A reduction does.
  store.changeMany(project, ["repo.delete"], false, store.snapshot(project).revision, "operator");
  await turn("fourth");
  assert.equal(calls[3].resume, null, "authority was reduced: start fresh from the replay");
  // A resume that fails falls back within the same turn.
  failResume = true;
  await turn("fifth");
  assert.equal(calls[4].resume, "session-4");
  assert.equal(calls[5].resume, null);
  assert.match(calls[5].context, /Recent conversation/);
});

test("managed Codex continuity carries its tool digest, fences authority changes and never replays an active-turn failure", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "psm-codex-lifecycle-"));
  const database = openDatabase(":memory:"); const store = new AgentPermissionStore(() => database);
  const project = { id: "prj_codex_resume", name: "codex-resume", path: directory };
  store.change(project, "repo.read", true, 0, "operator");
  const calls: Array<{ resume: string | null; digest: string | null; context: string }> = [];
  let failure: "missing" | "active" | null = null;
  ai.configureManagedAgents(() => ({ store, snapshots: [store.snapshot(project)], protectedRoots: [] }), async (input) => {
    calls.push({ resume: input.resume ?? null, digest: input.resumeToolsDigest ?? null, context: input.context });
    if (input.resume && failure === "missing") throw new ManagedResumeUnavailableError("Thread is unavailable");
    if (input.resume && failure === "active") throw new Error("Turn failed after a broker action");
    input.event({ type: "system", subtype: "init", session_id: `codex-session-${calls.length}`, psm_tools_digest: "digest" });
  });
  t.after(() => { ai.stopSession("codex-resume"); ai.configureManagedAgents(null); database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const turn = async (model: string | null = null) => {
    assert.equal(ai.send("codex-resume", directory, "codex", model, null, "continue", "default").ok, true);
    for (let i = 0; i < 50 && ai.aiState("codex-resume").busy; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  await turn(); await turn();
  assert.equal(calls[1].resume, "codex-session-1"); assert.equal(calls[1].digest, "digest");
  assert.doesNotMatch(calls[1].context, /Recent conversation/);
  store.change(project, "repo.edit", true, 1, "operator"); await turn();
  assert.equal(calls[2].resume, "codex-session-2", "added authority preserves context");
  const restriction = store.addWorkspaceRule("personal", { permission: "git.push", effect: "deny", source: "custom", actor: "operator" }, 0);
  await turn(); assert.equal(calls[3].resume, null);
  store.removeWorkspaceRule("personal", restriction.rules[0].id, restriction.revision, "operator");
  failure = "missing";
  await turn(); assert.equal(calls[4].resume, "codex-session-4"); assert.equal(calls[5].resume, null);
  assert.match(calls[5].context, /Recent conversation/);
  failure = "active";
  await turn(); assert.equal(calls.length, 7, "an active turn failure is never retried as a fresh prompt");
  assert.equal(calls[6].resume, "codex-session-6");
  const saved = JSON.parse(fs.readFileSync(process.env.PSM_SESSIONS_FILE!, "utf8"));
  assert.equal(saved.sessions["codex-resume"].managedResume.toolsDigest, "digest");
  assert.equal(saved.sessions["codex-resume"].sessionId, null, "managed ids stay separate from CLI state");
  failure = null;
  await turn("chosen-model"); assert.equal(calls[7].resume, null, "a changed selection starts with current provider settings");
  await turn(); assert.equal(calls[8].resume, null, "returning to the provider default cannot keep the previous model override");
});

test("workspace restriction changes break provider resume even after a restriction is removed", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "psm-workspace-resume-"));
  const database = openDatabase(":memory:");
  const store = new AgentPermissionStore(() => database);
  const project = { id: "prj_workspace_resume", name: "workspace-resume", path: directory, workspaceId: "personal" };
  store.change(project, "repo.read", true, 0, "operator");
  const resumes: Array<string | null> = [];
  ai.configureManagedAgents(() => ({ store, snapshots: [store.snapshot(project)], protectedRoots: [] }), async (input) => {
    resumes.push(input.resume ?? null);
    input.event({ type: "system", subtype: "init", session_id: `workspace-session-${resumes.length}` });
  });
  t.after(() => { ai.stopSession("workspace-resume"); ai.configureManagedAgents(null); database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const turn = async () => {
    assert.equal(ai.send("workspace-resume", directory, "claude", null, null, "continue", "default").ok, true);
    for (let i = 0; i < 50 && ai.aiState("workspace-resume").busy; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  await turn(); await turn();
  const restriction = store.addWorkspaceRule("personal", { permission: "git.push", effect: "deny", source: "custom", actor: "operator" }, 0);
  store.removeWorkspaceRule("personal", restriction.rules[0].id, restriction.revision, "operator");
  await turn(); await turn();
  assert.deepEqual(resumes, [null, "workspace-session-1", null, "workspace-session-3"]);
  assert.equal(store.snapshot(project).revision, 1, "a workspace policy edit has its own revision");
});

test("preparation attempt metadata persists while the provider receives the full repair brief", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "psm-preparation-turn-"));
  const database = openDatabase(":memory:");
  const store = new AgentPermissionStore(() => database);
  const project = { id: "prj_preparation", name: "preparation", path: directory };
  store.changeMany(project, ["repo.read"], true, 0, "operator");
  const received: string[] = [];
  ai.configureManagedAgents(() => ({ store, snapshots: [store.snapshot(project)], protectedRoots: [] }), async (input) => {
    received.push(input.message);
  });
  t.after(() => { ai.stopSession("preparation"); ai.configureManagedAgents(null); database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const preparation = { jobId: "prep-1", environmentId: "staging", purpose: "repair" as const, attempt: 2, maximumAttempts: 3 };
  const message = "Full repair instructions and failing checks";
  assert.equal(ai.send("preparation", directory, "claude", null, null, message, "default", "", [], preparation).ok, true);
  for (let i = 0; i < 50 && ai.aiState("preparation").busy; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(received, [message]);
  const saved = JSON.parse(fs.readFileSync(process.env.PSM_SESSIONS_FILE!, "utf8"));
  const session = saved.sessions.preparation;
  const event = session.log.find((entry: { text: string }) => entry.text === message);
  assert.deepEqual(event.preparation, preparation);
  assert.equal(event.role, "user", "the provider's conversation semantics are unchanged");
});
