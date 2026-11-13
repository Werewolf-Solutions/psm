import assert from "node:assert/strict";
import test from "node:test";

import type { Runbook, RunbookUnit } from "../runbook.ts";
import { parseTargets, planUnits, startUnits, stopUnits, unitKind, type UnitDeps } from "./units.ts";

const unit = (id: string, change: Partial<RunbookUnit> = {}): RunbookUnit => ({
  id, title: id, folder: id.includes("/") ? id.split("/")[0] : "", script: id.split("/").pop()!, command: `npm run ${id.split("/").pop()}`,
  scriptText: "", kind: "service", summary: null, whenToUse: null, port: null, dependsOn: [], env: [], costs: false, aliases: [], sources: {}, ...change,
});
const book = (units: RunbookUnit[], change: Partial<Runbook> = {}): Runbook => ({ units, composites: [], defaultUnits: [], proxies: [], curated: false, warnings: [], ...change });

function world(open: number[] = []) {
  const books: Record<string, Runbook> = {
    "werewolf-dapp": book([
      unit("server/dev", { port: 3000 }),
      unit("client/dev", { port: 5173, dependsOn: [{ unit: "server/dev" }] }),
      unit("server/website-agent", { kind: "agent", dependsOn: [{ unit: "server/dev" }] }),
      unit("server/bootstrap:todo", { kind: "data" }),
    ], { defaultUnits: ["server/dev", "client/dev"] }),
    "todo-app": book([unit("client/dev", { port: 5200 })], { proxies: [{ unit: "client/dev", port: 3000 }] }),
    "feedback-hub": book([unit("dev", { port: 4400 })]),
  };
  const ports = new Set(open);
  const running = new Map<string, { status: string; port: number | null }>();
  const started: string[] = [];
  const stopped: string[] = [];
  const deps: UnitDeps = {
    project: (name) => (books[name] ? { name, path: `/p/${name}` } : null),
    projects: () => Object.keys(books),
    runbook: (name) => books[name] ?? null,
    status: (name, kind) => running.get(`${name} ${kind}`) ?? null,
    start: (name, kind, command, cwd) => {
      started.push(`${name} ${kind} ${cwd}`);
      running.set(`${name} ${kind}`, { status: "running", port: null });
      const port = books[name].units.find((entry) => unitKind(entry.id) === kind)?.port;
      if (port) ports.add(port);
    },
    stop: (name, kind) => {
      stopped.push(`${name} ${kind}`);
      return running.delete(`${name} ${kind}`);
    },
    portOpen: async (port) => ports.has(port),
    sleep: async () => {},
    readyTimeoutMs: 1_000,
  };
  return { deps, started, stopped, running, ports, books };
}

test("dependencies start first and once; a todo-app client pulls in the server it proxies to", async () => {
  const w = world();
  const plan = planUnits(w.deps, [{ project: "todo-app", unit: "client/dev" }, { project: "werewolf-dapp", unit: "client/dev" }]);
  assert.deepEqual(plan.map((step) => `${step.project} ${step.unit}`), ["werewolf-dapp server/dev", "todo-app client/dev", "werewolf-dapp client/dev"]);
  assert.equal(plan[0].reason, "needed by todo-app client/dev");

  const results = await startUnits(w.deps, [{ project: "todo-app", unit: "client/dev" }, { project: "werewolf-dapp", unit: "client/dev" }]);
  assert.deepEqual(results.map((result) => result.outcome), ["started", "started", "started"]);
  assert.deepEqual(w.started, [
    "werewolf-dapp unit:server/dev /p/werewolf-dapp/server",
    "todo-app unit:client/dev /p/todo-app/client",
    "werewolf-dapp unit:client/dev /p/werewolf-dapp/client",
  ]);
});

test("a running unit is reused; a dependency someone else serves is external; a taken port blocks the unit itself", async () => {
  const w = world([3000]);
  const results = await startUnits(w.deps, [{ project: "werewolf-dapp", unit: "client/dev" }]);
  assert.equal(results[0].outcome, "external", "werewolf-dapp's own `npm run dev` already serves :3000");
  assert.equal(results[1].outcome, "started");
  const again = await startUnits(w.deps, [{ project: "werewolf-dapp", unit: "client/dev" }]);
  assert.equal(again[1].outcome, "reused");

  const blocked = await startUnits(world([3000]).deps, [{ project: "werewolf-dapp", unit: "server/dev" }]);
  assert.equal(blocked[0].outcome, "blocked");
  assert.match(blocked[0].message!, /:3000 is in use/);
});

test("data scripts never start; unknown units and projects are named; a failed dependency skips its dependents", async () => {
  const w = world();
  const results = await startUnits(w.deps, [
    { project: "werewolf-dapp", unit: "server/bootstrap:todo" },
    { project: "werewolf-dapp", unit: "nope" },
    { project: "ghost", unit: "dev" },
  ]);
  assert.deepEqual(results.map((result) => result.outcome), ["not-startable", "unknown", "unknown"]);
  assert.equal(w.started.length, 0);

  const failing = world();
  failing.deps.start = (name, kind) => failing.running.set(`${name} ${kind}`, { status: "error", port: null });
  const chain = await startUnits(failing.deps, [{ project: "werewolf-dapp", unit: "server/website-agent" }]);
  assert.deepEqual(chain.map((result) => result.outcome), ["failed", "skipped"]);
});

test("a server that never opens its port fails with a reason", async () => {
  const w = world();
  w.deps.start = (name, kind) => w.running.set(`${name} ${kind}`, { status: "running", port: null });
  const [result] = await startUnits(w.deps, [{ project: "feedback-hub", unit: "dev" }]);
  assert.equal(result.outcome, "failed");
  assert.match(result.message!, /nothing answered on :4400/);
});

test("stopping keeps a unit another running unit needs, unless forced", () => {
  const w = world();
  const running = [{ project: "werewolf-dapp", unit: "server/dev" }, { project: "todo-app", unit: "client/dev" }];
  const kept = stopUnits(w.deps, [{ project: "werewolf-dapp", unit: "server/dev" }], running);
  assert.deepEqual(kept, [{ project: "werewolf-dapp", unit: "server/dev", stopped: false, keptFor: ["todo-app client/dev"] }]);
  assert.equal(w.stopped.length, 0);
  stopUnits(w.deps, [{ project: "werewolf-dapp", unit: "server/dev" }], running, true);
  assert.deepEqual(w.stopped, ["todo-app unit:client/dev", "werewolf-dapp unit:server/dev"]);
});

test("parseTargets", () => {
  assert.deepEqual(parseTargets([{ project: "a", unit: "server/dev" }]), [{ project: "a", unit: "server/dev" }]);
  assert.throws(() => parseTargets([]), /1-30/);
  assert.throws(() => parseTargets([{ project: "a", unit: "x::y" }]), /Invalid unit/);
});
