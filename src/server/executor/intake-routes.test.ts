/**
 * The Executor page's task routes (P17b), over HTTP with a stubbed hub.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";

import { HubError, type QueueItem } from "./client.ts";
import { intakeKey, intakeRoutes } from "./intake-routes.ts";

const EXECUTOR = "psm-test-0000aaaa";
const INTAKE_ID = "int_0123456789abcdef01234567";
const PROJECTS = [
  { id: "prj_todoapp", name: "todo-app" },
  { id: null, name: "no-id-yet" },
];

const row = (over: Partial<QueueItem> = {}): QueueItem => ({
  intakeId: INTAKE_ID, projectId: "prj_todoapp", source: "psm", sourceRef: { kind: "psm", key: "pst_000000000000000000000000" },
  text: "Fix it", status: "new", claim: null, attempts: 0, verdict: null, error: null,
  createdAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z", ...over,
});

async function serve(over: { signedIn?: boolean; hubError?: HubError } = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const seen = new Set<string>();
  const fail = () => { if (over.hubError) throw over.hubError; };
  const app = express();
  app.use(express.json());
  app.use(intakeRoutes({
    // The same rule index.ts applies: a request with a foreign Origin is not the cockpit.
    isLocal: (req) => !req.headers.origin,
    signedIn: async () => over.signedIn ?? true,
    projects: () => PROJECTS,
    executorId: () => EXECUTOR,
    hub: () => ({
      async createIntake(input) {
        calls.push({ method: "create", args: [input] });
        fail();
        const created = !seen.has(input.key);
        seen.add(input.key);
        return { intake: row({ text: input.text, projectId: input.projectId, sourceRef: { kind: "psm", key: input.key } }), created };
      },
      async updateIntake(intakeId, change) {
        calls.push({ method: "update", args: [intakeId, change] });
        fail();
        return row({ ...change });
      },
      async withdrawIntake(intakeId) {
        calls.push({ method: "withdraw", args: [intakeId] });
        fail();
        return row({ status: "withdrawn" });
      },
    }),
  }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  return { calls, call, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const NEW = { projectId: "prj_todoapp", text: "  Fix the first task of a new week  ", nonce: "nonce-0001" };

test("a paired origin cannot add, change or withdraw a task", async () => {
  const app = await serve();
  try {
    const foreign = { Origin: "https://psm.werewolf.solutions" };
    assert.equal((await app.call("POST", "/api/executor/intake", NEW, foreign)).status, 403);
    assert.equal((await app.call("PATCH", `/api/executor/intake/${INTAKE_ID}`, { text: "x" }, foreign)).status, 403);
    assert.equal((await app.call("DELETE", `/api/executor/intake/${INTAKE_ID}`, undefined, foreign)).status, 403);
    assert.deepEqual(app.calls, [], "nothing reached the hub");
  } finally {
    await app.close();
  }
});

test("signed out is a 401 before anything reaches the hub", async () => {
  const app = await serve({ signedIn: false });
  try {
    assert.equal((await app.call("POST", "/api/executor/intake", NEW)).status, 401);
    assert.equal((await app.call("PATCH", `/api/executor/intake/${INTAKE_ID}`, { text: "x" })).status, 401);
    assert.equal((await app.call("DELETE", `/api/executor/intake/${INTAKE_ID}`)).status, 401);
    assert.deepEqual(app.calls, []);
  } finally {
    await app.close();
  }
});

test("a task needs a known project with an id, some text and a nonce", async () => {
  const app = await serve();
  try {
    const unknown = await app.call("POST", "/api/executor/intake", { ...NEW, projectId: "prj_elsewhere" });
    assert.equal(unknown.status, 404);
    const noId = await app.call("POST", "/api/executor/intake", { ...NEW, projectId: undefined, project: "no-id-yet" });
    assert.equal(noId.status, 409);
    assert.match(noId.body.error, /no project id yet/);
    assert.equal((await app.call("POST", "/api/executor/intake", { ...NEW, projectId: "" })).status, 400);
    assert.equal((await app.call("POST", "/api/executor/intake", { ...NEW, text: "   " })).status, 400);
    assert.equal((await app.call("POST", "/api/executor/intake", { ...NEW, text: "x".repeat(20_001) })).status, 400);
    assert.equal((await app.call("POST", "/api/executor/intake", { ...NEW, nonce: "short" })).status, 400);
    assert.equal((await app.call("POST", "/api/executor/intake", { ...NEW, nonce: undefined })).status, 400);
    assert.deepEqual(app.calls, [], "none of these is a hub call");
  } finally {
    await app.close();
  }
});

test("a new task goes to the hub trimmed, and a double click is the same intake", async () => {
  const app = await serve();
  try {
    const first = await app.call("POST", "/api/executor/intake", NEW);
    assert.equal(first.status, 201);
    assert.equal(first.body.created, true);
    const key = intakeKey(EXECUTOR, NEW.nonce);
    assert.match(key, /^pst_[0-9a-f]{24}$/);
    assert.deepEqual(app.calls[0], { method: "create", args: [{ projectId: "prj_todoapp", text: "Fix the first task of a new week", key }] });

    const again = await app.call("POST", "/api/executor/intake", NEW);
    assert.equal(again.status, 200, "the same nonce is the same key, so the hub answers with the first intake");
    assert.deepEqual(app.calls[1].args, app.calls[0].args);

    const other = await app.call("POST", "/api/executor/intake", { ...NEW, nonce: "nonce-0002", projectId: undefined, project: "todo-app" });
    assert.equal(other.status, 201, "a project can be named by its folder too");
    assert.notEqual((app.calls[2].args[0] as { key: string }).key, key);
    assert.notEqual(intakeKey("psm-other-1111bbbb", NEW.nonce), key, "another machine's nonce is another key");
  } finally {
    await app.close();
  }
});

test("edit and withdraw pass through to the hub", async () => {
  const app = await serve();
  try {
    const edited = await app.call("PATCH", `/api/executor/intake/${INTAKE_ID}`, { text: "  Better wording " });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.intake.text, "Better wording");
    assert.deepEqual(app.calls[0], { method: "update", args: [INTAKE_ID, { text: "Better wording" }] });

    assert.equal((await app.call("PATCH", `/api/executor/intake/${INTAKE_ID}`, { projectId: "todo-app" })).status, 200);
    assert.deepEqual(app.calls[1].args, [INTAKE_ID, { projectId: "prj_todoapp" }]);
    assert.equal((await app.call("PATCH", `/api/executor/intake/${INTAKE_ID}`, {})).status, 400);
    assert.equal((await app.call("PATCH", `/api/executor/intake/${INTAKE_ID}`, { projectId: "prj_elsewhere" })).status, 404);
    assert.equal((await app.call("PATCH", "/api/executor/intake/not-an-id", { text: "x" })).status, 404);

    const gone = await app.call("DELETE", `/api/executor/intake/${INTAKE_ID}`);
    assert.equal(gone.status, 200);
    assert.equal(gone.body.intake.status, "withdrawn");
    assert.equal(app.calls.length, 3);
  } finally {
    await app.close();
  }
});

test("the hub's refusal reaches the page with its status; an unreachable hub is a 502", async () => {
  const busy = await serve({ hubError: new HubError("This task has a job under way. Cancel or finish the job first.", 409, "job_active") });
  try {
    const refused = await busy.call("PATCH", `/api/executor/intake/${INTAKE_ID}`, { text: "x" });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /job under way/);
  } finally {
    await busy.close();
  }
  const down = await serve({ hubError: new HubError("Could not reach the hub: connect ECONNREFUSED", 0, "unreachable") });
  try {
    assert.equal((await down.call("POST", "/api/executor/intake", NEW)).status, 502);
  } finally {
    await down.close();
  }
});
