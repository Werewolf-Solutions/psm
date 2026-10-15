import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { memoryTriageCache, type EngineRequest, type TriageEngine } from "../triage/run.ts";
import {
  HubError,
  backoffDelay,
  executorId,
  executorPaused,
  hubClient,
  runExecutor,
  setExecutorPaused,
  type ExecutorEvent,
  type ExecutorJob,
  type JobOutcome,
} from "./client.ts";
import { triageJobRunner } from "./triage-job.ts";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "psm-executor-"));
const EXECUTOR = "psm-test-0001";
const TOKEN = "test-access-token";

const VERDICT = {
  verdict: "fits",
  size: "S",
  dependsOn: ["P01 inbox"],
  conflictsWith: [],
  queue: { after: ["P01 inbox"], note: "right after the inbox" },
  questions: [],
  rationale: "Small and squarely in scope.",
};

/* ---------- a fake hub, per the contract ---------- */

interface FakeHub {
  url: string;
  jobs: ExecutorJob[];
  claims: number;
  heartbeats: string[];
  results: Array<{ jobId: string; body: any }>;
  headers: Array<Record<string, string | undefined>>;
  intake: any[];
  failClaims: number;
  leaseLost: Set<string>;
  close: () => Promise<void>;
}

async function fakeHub(): Promise<FakeHub> {
  const hub = {
    jobs: [] as ExecutorJob[],
    claims: 0,
    heartbeats: [] as string[],
    results: [] as Array<{ jobId: string; body: any }>,
    headers: [] as Array<Record<string, string | undefined>>,
    intake: [] as any[],
    failClaims: 0,
    leaseLost: new Set<string>(),
  } as FakeHub;
  const held = new Set<string>();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    hub.headers.push({ authorization: req.get("authorization"), executor: req.get("x-psm-executor") });
    if (req.get("authorization") !== `Bearer ${TOKEN}`) {
      return res.status(401).json({ success: false, code: "unauthenticated", message: "Not signed in" });
    }
    if (!/^[a-z0-9-]{1,64}$/.test(req.get("x-psm-executor") || "")) {
      return res.status(400).json({ success: false, message: "X-PSM-Executor required" });
    }
    next();
  });
  app.post("/api/v1/psm/executor/claim", (req, res) => {
    hub.claims++;
    if (hub.failClaims > 0) {
      hub.failClaims--;
      return res.status(503).json({ success: false, message: "hub warming up" });
    }
    const job = hub.jobs.shift();
    // A short stand-in for the 25 s long-poll.
    if (!job) return setTimeout(() => res.status(204).end(), 20);
    held.add(job.jobId);
    res.json({ success: true, data: { job } });
  });
  app.post("/api/v1/psm/executor/jobs/:jobId/heartbeat", (req, res) => {
    const { jobId } = req.params;
    if (!held.has(jobId) || hub.leaseLost.has(jobId)) {
      return res.status(409).json({ success: false, code: "not_held", message: "Lease not held" });
    }
    hub.heartbeats.push(jobId);
    res.json({ success: true, data: { leaseUntil: new Date(Date.now() + 120_000).toISOString() } });
  });
  app.post("/api/v1/psm/executor/jobs/:jobId/result", (req, res) => {
    const { jobId } = req.params;
    if (!held.has(jobId) || hub.leaseLost.has(jobId)) {
      return res.status(409).json({ success: false, code: "not_held", message: "Lease not held" });
    }
    held.delete(jobId);
    hub.results.push({ jobId, body: req.body });
    res.json({ success: true, data: { status: req.body.status } });
  });
  app.get("/api/v1/psm/intake", (req, res) => {
    res.json({ success: true, data: { intake: hub.intake.filter((item) => item.projectId === req.query.projectId) } });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  hub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  hub.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return hub;
}

function job(overrides: Partial<ExecutorJob> = {}): ExecutorJob {
  const id = overrides.jobId || `int_${Math.random().toString(16).slice(2).padEnd(24, "0").slice(0, 24)}`;
  return {
    jobId: id,
    kind: "triage",
    intakeId: id,
    projectId: "prj_00000000000000000001",
    projectName: "demo",
    text: "Add an inbox view",
    attempt: 1,
    leaseUntil: new Date(Date.now() + 120_000).toISOString(),
    ...overrides,
  };
}

function client(hub: FakeHub, token: string | null = TOKEN) {
  return hubClient({ apiUrl: () => hub.url, token: () => token, executorId: EXECUTOR });
}

/** Resolves once `predicate` holds, polling quickly; fails the test after `ms`. */
async function until(predicate: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function demoRepo(): string {
  const dir = fs.mkdtempSync(path.join(sandbox, "repo-"));
  fs.writeFileSync(path.join(dir, "README.md"), "# Demo\n\nThe demo project.\n");
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  return dir;
}

function engineAnswering(answer: string | ((req: EngineRequest) => Promise<string> | string)) {
  const calls: EngineRequest[] = [];
  const engine: TriageEngine = async (req) => {
    calls.push(req);
    return { ok: true, text: typeof answer === "function" ? await answer(req) : answer };
  };
  return { engine, calls };
}

/* ---------- identity, kill switch, backoff ---------- */

test("the executor id is minted once, valid for the contract, and kept", () => {
  const file = path.join(sandbox, "executor.json");
  const id = executorId(file);
  assert.match(id, /^[a-z0-9-]{1,64}$/);
  assert.match(id, /^psm-/);
  assert.equal(executorId(file), id);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  assert.equal(executorPaused(file), false);
  setExecutorPaused(true, file);
  assert.equal(executorPaused(file), true);
  assert.equal(executorId(file), id, "pausing keeps the id");
  setExecutorPaused(false, file);
  assert.equal(executorPaused(file), false);
});

test("backoff doubles from the base and caps at sixty seconds", () => {
  assert.deepEqual([1, 2, 3, 4].map((n) => backoffDelay(n)), [1_000, 2_000, 4_000, 8_000]);
  assert.equal(backoffDelay(7), 60_000);
  assert.equal(backoffDelay(50), 60_000);
});

/* ---------- the hub client ---------- */

test("the client sends the session and executor id and reads the envelope", async () => {
  const hub = await fakeHub();
  try {
    const api = client(hub);
    assert.equal(await api.claim(["triage"]), null, "204 means no job");
    const queued = job({ jobId: "int_aaaaaaaaaaaaaaaaaaaaaaaa" });
    hub.jobs.push(queued);
    assert.deepEqual(await api.claim(["triage"]), queued);
    assert.match((await api.heartbeat(queued.jobId)).leaseUntil, /^\d{4}-/);
    await api.result(queued.jobId, { status: "failed", error: "x" });
    assert.deepEqual(hub.results, [{ jobId: queued.jobId, body: { status: "failed", error: "x" } }]);
    assert.ok(hub.headers.every((h) => h.authorization === `Bearer ${TOKEN}` && h.executor === EXECUTOR));

    await assert.rejects(api.heartbeat(queued.jobId), (err: HubError) => err.status === 409);
    await assert.rejects(client(hub, null).claim(["triage"]), (err: HubError) => err.status === 401);
    await assert.rejects(client(hub, "wrong").claim(["triage"]), (err: HubError) => err.status === 401 && /Not signed in/.test(err.message));
    assert.throws(() => hubClient({ apiUrl: () => "x", token: () => TOKEN, executorId: "Bad Id" }), /invalid executor id/);

    hub.intake.push({ intakeId: "int_x", projectId: "prj_a", text: "other", status: "new" }, { intakeId: "int_y", projectId: "prj_b", text: "elsewhere" });
    assert.deepEqual(await api.listIntake("prj_a"), [{ intakeId: "int_x", text: "other", status: "new", verdict: null }]);
  } finally {
    await hub.close();
  }
});

test("an unreachable hub is a HubError the loop can back off from", async () => {
  const api = hubClient({ apiUrl: () => "http://127.0.0.1:1/api/v1", token: () => TOKEN, executorId: EXECUTOR });
  await assert.rejects(api.claim(["triage"]), (err: HubError) => err instanceof HubError && err.code === "unreachable");
});

/* ---------- end to end: fake hub, real loop, fake engine ---------- */

async function runUntil(
  hub: FakeHub,
  run: (job: ExecutorJob, signal: AbortSignal) => Promise<JobOutcome>,
  done: (events: ExecutorEvent[]) => boolean,
  extra: Partial<Parameters<typeof runExecutor>[0]> = {},
) {
  const controller = new AbortController();
  const events: ExecutorEvent[] = [];
  const loop = runExecutor({
    hub: client(hub),
    run,
    signal: controller.signal,
    heartbeatMs: 20,
    backoffBaseMs: 10,
    killSwitchPollMs: 10,
    onEvent: (event) => events.push(event),
    ...extra,
  });
  try {
    await until(() => done(events));
  } finally {
    controller.abort();
    await loop;
  }
  return events;
}

test("e2e: a fenced valid verdict is posted as triaged, with heartbeats while it runs", async () => {
  const hub = await fakeHub();
  try {
    const repo = demoRepo();
    const queued = job();
    hub.jobs.push(queued);
    hub.intake.push({ intakeId: "int_other", projectId: queued.projectId, text: "Dark mode", status: "new" });
    const { engine, calls } = engineAnswering(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120)); // long enough for several 20 ms heartbeats
      return "```json\n" + JSON.stringify(VERDICT, null, 2) + "\n```";
    });
    const run = triageJobRunner({
      findProject: (id) => (id === queued.projectId ? { name: "demo", path: repo } : null),
      listIntake: (id) => client(hub).listIntake(id),
      recap: () => "- was sketching the inbox",
      engine,
      cache: memoryTriageCache(),
    });
    const events = await runUntil(hub, run, () => hub.results.length === 1);

    assert.deepEqual(hub.results[0], { jobId: queued.jobId, body: { status: "triaged", verdict: VERDICT } });
    assert.ok(hub.heartbeats.filter((id) => id === queued.jobId).length >= 2, `heartbeats: ${hub.heartbeats.length}`);
    assert.ok(events.some((event) => event.type === "heartbeat"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cwd, repo);
    assert.match(calls[0].prompt, /The demo project\./);
    assert.match(calls[0].prompt, /int_other \[new\] Dark mode/);
    assert.match(calls[0].prompt, /was sketching the inbox/);
    assert.match(calls[0].prompt, /<intake>\nAdd an inbox view\n<\/intake>/);
  } finally {
    await hub.close();
  }
});

test("e2e: a verdict with a date is posted as failed with the reason", async () => {
  const hub = await fakeHub();
  try {
    const repo = demoRepo();
    const queued = job();
    hub.jobs.push(queued);
    const { engine } = engineAnswering("```json\n" + JSON.stringify({ ...VERDICT, queue: { after: [], note: "ship by Oct 30" } }) + "\n```");
    const run = triageJobRunner({ findProject: () => ({ name: "demo", path: repo }), engine });
    await runUntil(hub, run, () => hub.results.length === 1);

    const [{ jobId, body }] = hub.results;
    assert.equal(jobId, queued.jobId);
    assert.equal(body.status, "failed");
    assert.match(body.error, /queue\.note contains a calendar date \(month and day: "Oct 30"\)/);
    assert.equal(body.verdict, undefined);
  } finally {
    await hub.close();
  }
});

test("e2e: a project that is not on this executor fails with a reason", async () => {
  const hub = await fakeHub();
  try {
    hub.jobs.push(job({ projectName: "elsewhere" }));
    const run = triageJobRunner({ findProject: () => null, engine: engineAnswering("{}").engine });
    await runUntil(hub, run, () => hub.results.length === 1);
    assert.match(hub.results[0].body.error, /\(elsewhere\) is not on this executor/);
  } finally {
    await hub.close();
  }
});

test("abort stops the loop, abandons the running job and posts nothing", async () => {
  const hub = await fakeHub();
  try {
    hub.jobs.push(job());
    let sawAbort = false;
    const controller = new AbortController();
    const events: ExecutorEvent[] = [];
    const loop = runExecutor({
      hub: client(hub),
      signal: controller.signal,
      heartbeatMs: 20,
      onEvent: (event) => events.push(event),
      run: (_job, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            sawAbort = true;
            resolve({ status: "failed", error: "aborted" });
          });
        }),
    });
    await until(() => events.some((event) => event.type === "claimed"));
    controller.abort();
    await loop;
    assert.ok(sawAbort, "the job saw the abort");
    assert.deepEqual(hub.results, []);
    assert.ok(events.some((event) => event.type === "abandoned" && event.reason === "executor stopped"));
    assert.equal(events.at(-1)?.type, "stopped");
    const claims = hub.claims;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(hub.claims, claims, "no claims after stopping");
  } finally {
    await hub.close();
  }
});

test("a job past its timeout is stopped and posted as failed", async () => {
  const hub = await fakeHub();
  try {
    hub.jobs.push(job());
    let aborted = false;
    await runUntil(
      hub,
      (_job, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ status: "triaged", verdict: VERDICT as any }); // too late to count
          });
        }),
      () => hub.results.length === 1,
      { timeoutsMs: { triage: 50 } },
    );
    assert.ok(aborted);
    assert.equal(hub.results[0].body.status, "failed");
    assert.match(hub.results[0].body.error, /timed out/);
  } finally {
    await hub.close();
  }
});

test("a lost lease abandons the job without posting a result", async () => {
  const hub = await fakeHub();
  try {
    const queued = job();
    hub.jobs.push(queued);
    hub.leaseLost.add(queued.jobId);
    const events = await runUntil(
      hub,
      (_job, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ status: "failed", error: "x" }))),
      (seen) => seen.some((event) => event.type === "abandoned"),
    );
    assert.ok(events.some((event) => event.type === "abandoned" && event.reason === "lease lost"));
    assert.deepEqual(hub.results, []);
  } finally {
    await hub.close();
  }
});

test("hub errors back off exponentially and the loop recovers", async () => {
  const hub = await fakeHub();
  try {
    hub.failClaims = 3;
    hub.jobs.push(job());
    const events = await runUntil(
      hub,
      async () => ({ status: "failed", error: "nothing to do" }),
      () => hub.results.length === 1,
    );
    const delays = events.filter((event) => event.type === "hub-error").map((event) => (event as any).retryInMs);
    assert.deepEqual(delays, [10, 20, 40]);
  } finally {
    await hub.close();
  }
});

test("backoff is capped", async () => {
  const hub = await fakeHub();
  try {
    hub.failClaims = 6;
    const events = await runUntil(
      hub,
      async () => ({ status: "failed", error: "x" }),
      (seen) => seen.filter((event) => event.type === "hub-error").length >= 6,
      { backoffBaseMs: 5, backoffMaxMs: 20 },
    );
    const delays = events.filter((event) => event.type === "hub-error").map((event) => (event as any).retryInMs);
    assert.deepEqual(delays.slice(0, 6), [5, 10, 20, 20, 20, 20]);
  } finally {
    await hub.close();
  }
});

test("never two jobs at once for one project, even with a pool of two", async () => {
  const hub = await fakeHub();
  try {
    const a1 = job({ projectId: "prj_aaaaaaaaaaaaaaaaaaaa" });
    const a2 = job({ projectId: "prj_aaaaaaaaaaaaaaaaaaaa" });
    const b1 = job({ projectId: "prj_bbbbbbbbbbbbbbbbbbbb" });
    hub.jobs.push(a1, a2, b1);
    const running = new Map<string, number>();
    let maxPerProject = 0;
    let maxOverall = 0;
    await runUntil(
      hub,
      async (claimed) => {
        running.set(claimed.projectId, (running.get(claimed.projectId) || 0) + 1);
        maxPerProject = Math.max(maxPerProject, ...running.values());
        maxOverall = Math.max(maxOverall, [...running.values()].reduce((a, b) => a + b, 0));
        await new Promise((resolve) => setTimeout(resolve, 40));
        running.set(claimed.projectId, running.get(claimed.projectId)! - 1);
        return { status: "failed", error: "done" };
      },
      () => hub.results.length === 3,
      { concurrency: 2 },
    );
    assert.equal(maxPerProject, 1);
    assert.equal(maxOverall, 2, "different projects do run side by side");
  } finally {
    await hub.close();
  }
});

test("the kill switch stops claiming and abandons a running job", async () => {
  const hub = await fakeHub();
  try {
    let killed = true;
    hub.jobs.push(job());
    const controller = new AbortController();
    const events: ExecutorEvent[] = [];
    const loop = runExecutor({
      hub: client(hub),
      signal: controller.signal,
      killSwitch: () => killed,
      killSwitchPollMs: 10,
      heartbeatMs: 20,
      onEvent: (event) => events.push(event),
      run: (_job, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ status: "failed", error: "x" }))),
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(hub.claims, 0, "paused: nothing claimed");
    assert.ok(events.some((event) => event.type === "paused"));

    killed = false;
    await until(() => events.some((event) => event.type === "claimed"));
    killed = true;
    await until(() => events.some((event) => event.type === "abandoned"));
    assert.ok(events.some((event) => event.type === "abandoned" && event.reason === "kill switch"));
    assert.deepEqual(hub.results, []);
    controller.abort();
    await loop;
  } finally {
    await hub.close();
  }
});
