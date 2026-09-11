import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { openDatabase } from "../db.ts";
import type { PsmSessionUser } from "../session.ts";
import { createDeploymentRouter } from "./api.ts";
import { DeploymentPreparationController, PreparationRepository } from "./make-ready.ts";
import { SecretBroker } from "./connections.ts";
import { DeploymentService } from "./service.ts";
import { DeploymentStore } from "./store.ts";

const PLAN_DIGEST = "sha256:plan-1";
const LOCK_KEY = "target/werewolf:todo-production-web";

const OPERATOR: PsmSessionUser = { id: "usr_operator" } as PsmSessionUser;

function policyDocument(approval = "authenticated-local-operator", risk = "production") {
  return {
    risk,
    planTtlSeconds: 600,
    maxWatchAgeSeconds: null,
    requiredChecks: [],
    allowedSourceRefs: null,
    approval,
    requireFreshWatchBeforeRelease: false,
    authority: { delete: false, automaticRollback: true, pairedApproval: false, breakGlass: false },
    inputRevisions: [],
  };
}

interface HarnessOptions {
  user?: PsmSessionUser | null;
  local?: boolean;
  withRunner?: boolean;
  approval?: string;
  risk?: string;
}

async function harness(options: HarnessOptions = {}) {
  const store = new DeploymentStore(openDatabase(":memory:"));
  const enqueued: string[] = [];
  const cancelled: string[] = [];

  store.createPlan({
    planId: "plan_todo_production",
    revision: 1,
    digest: PLAN_DIGEST,
    projectId: "prj_todo",
    checkoutId: "checkout_todo",
    environmentId: "production",
    operation: "deploy",
    risk: (options.risk ?? "production") as "production",
    manifestDigest: "sha256:manifest",
    artifactId: null,
    requiredAcknowledgementIds: [],
    blocked: false,
    document: { schema: "deployment-plan@1", lockKeys: [LOCK_KEY], policy: policyDocument(options.approval, options.risk) },
    createdAt: 40,
    expiresAt: Date.now() + 600_000,
    actions: [{
      actionId: "web-staged",
      actionDigest: "sha256:web-staged",
      kind: "stage-static-release@1",
      phase: "release",
      sideEffecting: true,
      preconditions: {},
      document: { ownerRef: "unit:web" },
    }],
  });

  const service = new DeploymentService({
    store,
    secretBroker: new SecretBroker({
      generations: { readGeneration: async () => 0, writeGeneration: async () => {} },
      fingerprintKey: new Uint8Array(32),
    }),
    projects: () => [{ id: "prj_todo", name: "todo-app", path: "/nonexistent/todo-app" }] as never,
  });

  const app = express();
  app.use(express.json());
  app.use(createDeploymentRouter({
    service,
    currentUser: async () => (options.user === undefined ? OPERATOR : options.user),
    localRequest: () => options.local ?? true,
    ...(options.withRunner === false ? {} : {
      runner: {
        enqueue: (runId: string) => { enqueued.push(runId); },
        cancel: (runId: string) => { cancelled.push(runId); return store.requestCancellation(runId, Date.now()); },
      },
    }),
  }));

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  // The one header that proves the request came from the page psm itself serves.
  const cockpit = { origin: base, host: base.replace("http://", "") };

  return { store, call, cockpit, enqueued, cancelled, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function mintIntent(kit: Awaited<ReturnType<typeof harness>>): Promise<string> {
  const minted = await kit.call("POST", "/api/deployment-plans/plan_todo_production/approval-intents", {}, {
    origin: kit.cockpit.origin,
  });
  assert.equal(minted.status, 200, JSON.stringify(minted.body));
  return String(minted.body.intent);
}

test("a production approval requires the exact local cockpit origin", async (t) => {
  const kit = await harness();
  t.after(kit.close);

  // No Origin at all: a curl, a script, anything that is not the page.
  const bare = await kit.call("POST", "/api/deployment-plans/plan_todo_production/approve", {
    revision: 1, digest: PLAN_DIGEST, intent: "anything",
  });
  assert.equal(bare.status, 403);
  assert.equal(bare.body.code, "approval-required");

  // A different origin that merely claims to be local.
  const foreign = await kit.call("POST", "/api/deployment-plans/plan_todo_production/approve", {
    revision: 1, digest: PLAN_DIGEST, intent: "anything",
  }, { origin: "http://127.0.0.1:1" });
  assert.equal(foreign.status, 403);

  // A public origin is not made local by saying so.
  const evil = await kit.call("POST", "/api/deployment-plans/plan_todo_production/approve", {
    revision: 1, digest: PLAN_DIGEST, intent: "anything",
  }, { origin: "https://psm.werewolf.solutions" });
  assert.equal(evil.status, 403);
  assert.equal(kit.enqueued.length, 0);
});

test("approval without a matching one-use intent is refused", async (t) => {
  const kit = await harness();
  t.after(kit.close);

  const missing = await kit.call("POST", "/api/deployment-plans/plan_todo_production/approve", {
    revision: 1, digest: PLAN_DIGEST,
  }, { origin: kit.cockpit.origin });
  assert.equal(missing.status, 403);
  assert.equal(missing.body.code, "approval-required");

  const forged = await kit.call("POST", "/api/deployment-plans/plan_todo_production/approve", {
    revision: 1, digest: PLAN_DIGEST, intent: "not-a-real-intent",
  }, { origin: kit.cockpit.origin });
  assert.equal(forged.status, 403);
  assert.equal(kit.enqueued.length, 0);
});

test("an intent is consumed once and cannot approve a second time", async (t) => {
  const kit = await harness();
  t.after(kit.close);
  const intent = await mintIntent(kit);

  const first = await kit.call("POST", "/api/deployment-plans/plan_todo_production/approve", {
    revision: 1, digest: PLAN_DIGEST, intent,
  }, { origin: kit.cockpit.origin });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.deepEqual(kit.enqueued, [String((first.body.run as { id: string }).id)]);

  const replayed = await kit.call("POST", "/api/deployment-plans/plan_todo_production/approve", {
    revision: 1, digest: PLAN_DIGEST, intent,
  }, { origin: kit.cockpit.origin });
  assert.equal(replayed.status, 403);
  assert.equal(kit.enqueued.length, 1, "a replayed intent must not queue a second run");
});

test("approving a digest the operator did not review is a conflict", async (t) => {
  const kit = await harness();
  t.after(kit.close);
  const intent = await mintIntent(kit);

  const stale = await kit.call("POST", "/api/deployment-plans/plan_todo_production/approve", {
    revision: 1, digest: "sha256:something-else", intent,
  }, { origin: kit.cockpit.origin });
  assert.equal(stale.status, 409);
  assert.equal(kit.enqueued.length, 0);
});

test("an unauthenticated operator cannot approve a plan whose policy requires one", async (t) => {
  const kit = await harness({ user: null });
  t.after(kit.close);

  const intent = await kit.call("POST", "/api/deployment-plans/plan_todo_production/approval-intents", {}, {
    origin: kit.cockpit.origin,
  });
  assert.equal(intent.status, 403);
  assert.match(String(intent.body.error), /authenticated/);
});

test("a paired (non-local) request cannot approve a local-operator plan", async (t) => {
  const kit = await harness({ local: false });
  t.after(kit.close);

  const response = await kit.call("POST", "/api/deployment-plans/plan_todo_production/approve", {
    revision: 1, digest: PLAN_DIGEST, intent: "anything",
  }, { origin: kit.cockpit.origin });
  assert.equal(response.status, 403);
  assert.match(String(response.body.error), /local/);
});

test("preparing an artifact with no executor configured says so instead of pretending", async (t) => {
  const kit = await harness();
  t.after(kit.close);

  const response = await kit.call("POST", "/api/projects/prj_todo/deployment-artifacts/prepare", {
    environment: "production",
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "connection-missing");
  assert.match(String(response.body.error), /not configured/);
});

test("cancelling a production run requires the authenticated local cockpit", async (t) => {
  const kit = await harness();
  t.after(kit.close);
  const intent = await mintIntent(kit);
  const approved = await kit.call("POST", "/api/deployment-plans/plan_todo_production/approve", {
    revision: 1, digest: PLAN_DIGEST, intent,
  }, { origin: kit.cockpit.origin });
  const runId = String((approved.body.run as { id: string }).id);

  const bare = await kit.call("POST", `/api/deployment-runs/${runId}/cancel`);
  assert.equal(bare.status, 403);
  assert.equal(kit.cancelled.length, 0);

  const authorized = await kit.call("POST", `/api/deployment-runs/${runId}/cancel`, undefined, {
    origin: kit.cockpit.origin,
  });
  assert.equal(authorized.status, 202, JSON.stringify(authorized.body));
  assert.deepEqual(kit.cancelled, [runId]);
});

test("changing deployment authority is refused from a paired origin", async (t) => {
  const kit = await harness({ local: false });
  t.after(kit.close);

  for (const [method, path, body] of [
    ["PUT", "/api/projects/prj_todo/deployments/production/connection-bindings/github", { connectionId: "conn_1" }],
    ["PUT", "/api/deployment-policies/global", { minimumRisk: "production" }],
  ] as const) {
    const response = await kit.call(method, path, body, { origin: kit.cockpit.origin });
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.equal(response.body.code, "local-authority-required");
  }
});

test("a project with no manifest is unmanaged, not a filesystem error", async (t) => {
  const kit = await harness();
  t.after(kit.close);

  // The harness project has no checkout at all, which is the same answer as a checkout
  // without `.psm/deployments.json`: unmanaged. It must never surface as a 500 quoting a path.
  for (const path of [
    "/api/projects/prj_todo/deployments/production/resources/public-dns/adoption-plans",
    "/api/projects/prj_todo/deployment-plans",
  ]) {
    const response = await kit.call("POST", path, { environment: "production" });
    assert.equal(response.status, 404, `${path}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.code, "manifest-missing");
    assert.ok(!String(response.body.error).includes("/nonexistent"), "the answer must not quote a path");
  }
});

test("an unknown run is a 404 in JSON, never an HTML error page", async (t) => {
  const kit = await harness();
  t.after(kit.close);

  const response = await kit.call("GET", "/api/deployment-runs/run_does_not_exist");
  assert.equal(response.status, 404);
  assert.equal(response.body.code, "not-found");
});

test("without a runner, approval still records durable intent and does not claim execution", async (t) => {
  const kit = await harness({ withRunner: false });
  t.after(kit.close);
  const intent = await mintIntent(kit);

  const approved = await kit.call("POST", "/api/deployment-plans/plan_todo_production/approve", {
    revision: 1, digest: PLAN_DIGEST, intent,
  }, { origin: kit.cockpit.origin });
  assert.equal(approved.status, 202);
  const run = approved.body.run as { state: string; terminal: boolean };
  // Queued, not running and certainly not succeeded.
  assert.equal(run.state, "queued");
  assert.equal(run.terminal, false);
});

/**
 * "Make ready" is the one button that spends something on the operator's
 * behalf, so its guards are tested against a stubbed service: what matters here
 * is what the route does with a readiness answer, not how that answer was
 * derived.
 */
async function makeReadyHarness(readiness: { ready: boolean; canMakeReady: boolean }) {
  const store = new DeploymentStore(openDatabase(":memory:"));
  const prepared: string[] = [];
  const service = {
    resolveProject: () => ({ id: "prj_todo", name: "todo-app", path: "/nonexistent/todo-app" }),
    store,
    checkReadiness: async () => ({ readiness: { ...readiness, items: [] }, plan: {}, environment: {} }),
    runView: (runId: string) => ({ id: runId, terminal: false, state: "running" }),
  } as unknown as DeploymentService;

  const app = express();
  app.use(express.json());
  app.use(createDeploymentRouter({
    service,
    currentUser: async () => OPERATOR,
    localRequest: () => true,
    preparer: {
      prepare: async () => {
        prepared.push("run");
        // A real dispatch is a network round trip; overlap the requests here.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { runId: `run_prepare_${prepared.length}` };
      },
    },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const makeReady = () => fetch(`${base}/api/projects/prj_todo/deployments/production/make-ready`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }).then(async (response) => ({ status: response.status, body: await response.json() as Record<string, unknown> }));
  return { makeReady, prepared, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("make ready does not start a build for work only the operator can do", async (t) => {
  const kit = await makeReadyHarness({ ready: false, canMakeReady: false });
  t.after(kit.close);

  const response = await kit.makeReady();
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.steps, []);
  assert.match(String(response.body.message), /Complete the listed connection, source, or provider tasks/);
  assert.deepEqual(kit.prepared, [], "a connection psm cannot supply is not a reason to spend a build");
});

test("two clicks on make ready are one build, not two", async (t) => {
  // The button stays live while the dispatch is in flight, and a build is a
  // real CI run against a real repository.
  const kit = await makeReadyHarness({ ready: false, canMakeReady: true });
  t.after(kit.close);

  const [first, second] = await Promise.all([kit.makeReady(), kit.makeReady()]);
  assert.equal(kit.prepared.length, 1, "the second request must join the first, not dispatch again");
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(asRun(first.body).id, asRun(second.body).id);
});

function asRun(body: Record<string, unknown>): { id?: string } {
  return (body.run ?? {}) as { id?: string };
}

/**
 * The whole "Make ready to deploy" flow, behind the one route the button calls.
 *
 * The coordinator is real here — only what it drives is stubbed — because the
 * things worth protecting are its boundaries: one job per deployment however
 * many times the button is pressed, a status read that costs nothing, and a
 * stop that only the local cockpit can ask for.
 */
async function preparationHarness(options: { local?: boolean } = {}) {
  const database = openDatabase(":memory:");
  const store = new DeploymentStore(database);
  let items: { title: string; detail: string; status: string; action: string | null }[] = [
    { title: "Commit deployment inputs", detail: "inputs differ from committed HEAD", status: "blocked", action: "review-source" },
  ];
  const briefs: string[] = [];
  const builds: string[] = [];
  const engines: (string | null)[] = [];
  let stopped = 0;
  let refuse: string | null = null;
  const service = {
    resolveProject: () => ({ id: "prj_todo", name: "todo-app", path: "/nonexistent/todo-app" }),
    store,
    checkReadiness: async () => ({
      readiness: { ready: !items.length, canMakeReady: false, items, artifactId: null },
      plan: {}, environment: {},
    }),
    runView: (runId: string) => ({ id: runId, terminal: false, state: "running" }),
  } as unknown as DeploymentService;

  const preparation = new DeploymentPreparationController({
    service,
    background: false, // the test drives the steps; no wall clock in here
    repository: new PreparationRepository(() => database),
    preparer: { prepare: async () => { builds.push("build"); return { runId: "run_build" }; } },
    runner: { enqueue: () => { throw new Error("preparation must not queue infrastructure"); }, cancel: async () => {} },
    repairs: {
      start: async (job, checked) => {
        engines.push(job.engine);
        if (refuse) throw new Error(refuse);
        briefs.push(checked.readiness.items.map((item) => item.title).join(", "));
        return "wrk_room";
      },
      status: () => ({ busy: true, question: false }),
      stop: () => { stopped++; },
    },
  });

  const app = express();
  app.use(express.json());
  app.use(createDeploymentRouter({
    service,
    currentUser: async () => OPERATOR,
    localRequest: () => options.local ?? true,
    preparation,
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/prj_todo/deployments/staging`;
  const call = (path: string, method = "POST", payload: unknown = {}) => fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(payload) } : {}),
  }).then(async (response) => ({ status: response.status, body: await response.json() as Record<string, unknown> }));
  return {
    briefs, builds, engines,
    counts: () => ({ briefs: briefs.length, builds: builds.length, stopped }),
    ready: () => { items = []; },
    refuse: (message: string | null) => { refuse = message; },
    makeReady: (payload: unknown = {}) => call("/make-ready", "POST", payload),
    status: () => call("/preparation", "GET"),
    cancel: () => call("/preparation/cancel"),
    close: () => new Promise((resolve) => { server.close(resolve); database.close(); }),
  };
}

const asJob = (body: Record<string, unknown>) => body.preparation as Record<string, unknown>;

test("make ready starts the whole preparation, not just a build", async (t) => {
  const kit = await preparationHarness();
  t.after(kit.close);

  const response = await kit.makeReady();
  assert.equal(response.status, 202, "preparation is still running when the request answers");
  assert.equal(asJob(response.body).state, "running");
  assert.equal(asJob(response.body).phase, "repair");
  assert.equal(asJob(response.body).workroomId, "wrk_room");
  assert.deepEqual(kit.counts(), { briefs: 1, builds: 0, stopped: 0 },
    "committed source is the operator's repository to fix, and no reason to spend a build");
  assert.deepEqual(kit.briefs, ["Commit deployment inputs"]);
});

test("pressing make ready twice continues one preparation", async (t) => {
  const kit = await preparationHarness();
  t.after(kit.close);

  const first = await kit.makeReady();
  const second = await kit.makeReady();
  assert.equal(asJob(second.body).id, asJob(first.body).id);
  assert.equal(kit.counts().briefs, 1, "the second click joins the room the first one opened");
});

test("preparation status answers without rebuilding anything", async (t) => {
  const kit = await preparationHarness();
  t.after(kit.close);

  const before = await kit.status();
  assert.equal(before.status, 200);
  assert.equal(before.body.preparation, null, "nothing has been started yet");

  const started = await kit.makeReady();
  const after = await kit.status();
  assert.equal(asJob(after.body).id, asJob(started.body).id);
  assert.equal(asJob(after.body).active, true);
  assert.equal(kit.counts().briefs, 1, "reading the status is not a step");
});

test("stopping preparation stops the session it opened", async (t) => {
  const kit = await preparationHarness();
  t.after(kit.close);

  await kit.makeReady();
  const cancelled = await kit.cancel();
  assert.equal(cancelled.status, 200);
  assert.equal(asJob(cancelled.body).state, "cancelled");
  assert.equal(asJob(cancelled.body).active, false);
  assert.equal(kit.counts().stopped, 1, "the AI keeps working unless it is told to stop");

  const after = await kit.status();
  assert.equal(asJob(after.body).state, "cancelled");
});

test("a paired browser cannot start or stop preparation on this machine", async (t) => {
  const kit = await preparationHarness({ local: false });
  t.after(kit.close);

  assert.equal((await kit.makeReady()).status, 403);
  assert.equal((await kit.cancel()).status, 403);
  assert.deepEqual(kit.counts(), { briefs: 0, builds: 0, stopped: 0 });
});

/**
 * The provider a preparation runs on is a choice, remade on every press.
 *
 * Reported from a real run: preparation was opened on codex, codex hit its usage
 * window, and there was no way to move it to claude — the room's engine was
 * fixed at creation and the button re-used the room as it was.
 */
test("a preparation stopped by a usage limit resumes on the other provider", async (t) => {
  const kit = await preparationHarness();
  t.after(kit.close);

  kit.refuse("codex: You've hit your usage limit. Choose a different AI for preparation, then resume.");
  const limited = await kit.makeReady({ engine: "codex" });
  assert.equal(asJob(limited.body).state, "blocked");
  assert.match(String(asJob(limited.body).message), /usage limit/);
  assert.equal(asJob(limited.body).engine, "codex", "the panel can name the provider that refused");

  // The operator picks the other one and presses again.
  kit.refuse(null);
  const resumed = await kit.makeReady({ engine: "claude" });
  assert.equal(resumed.status, 202);
  assert.equal(asJob(resumed.body).state, "running");
  assert.equal(asJob(resumed.body).engine, "claude");
  assert.deepEqual(kit.engines, ["codex", "claude"], "the repair is attempted on what was chosen, not on what it opened with");
  assert.equal(kit.counts().briefs, 1);
});

test("a resumed preparation keeps the room and the engine it was last given", async (t) => {
  const kit = await preparationHarness();
  t.after(kit.close);

  await kit.makeReady({ engine: "claude" });
  await kit.cancel();
  // No engine this time: the last choice stands rather than silently reverting.
  const again = await kit.makeReady();
  assert.equal(asJob(again.body).engine, "claude");
  assert.equal(asJob(again.body).workroomId, "wrk_room", "the transcript carries across the stop");
});
