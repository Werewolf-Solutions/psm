import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { openDatabase } from "../db.ts";
import type { PsmSessionUser } from "../session.ts";
import { createDeploymentRouter } from "./api.ts";
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
