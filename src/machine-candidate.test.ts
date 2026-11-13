import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const context = vm.createContext({ window: {} as Record<string, unknown> });
vm.runInContext(fs.readFileSync(path.join(process.cwd(), "web/machines.js"), "utf8"), context);
const candidate = (context.window as { PsmMachines: { deployCandidate: (machine: unknown, target: unknown) => { access: unknown; reason: string } } }).PsmMachines.deployCandidate;
const target = { projectId: "prj_a", environmentId: "production", targetId: "a:production-web" };
const machine = { trusted: true, helper: { sha256: "abc" }, helperOutdated: false, access: [
  { role: "deploy", state: "ready", projectId: "prj_a", environmentId: "staging", plan: { target: { targetId: "a:staging-web" } } },
  { role: "deploy", state: "ready", projectId: "prj_a", environmentId: "production", plan: { target: { targetId: "a:production-web" } } },
] };

test("machine can be selected only for the exact project, environment and target", () => {
  assert.equal(candidate(machine, target).access, machine.access[1]);
  assert.equal(candidate(machine, { ...target, projectId: "prj_b" }).access, null);
  assert.equal(candidate(machine, { ...target, targetId: "a:other-web" }).access, null);
  assert.equal(candidate({ ...machine, helperOutdated: true }, target).access, null);
  assert.equal(candidate({ ...machine, trusted: false }, target).access, null);
});
