import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf("const DEPLOYMENT_TERMINAL_STATES ="), source.indexOf("/**\n * Managed requests")), context);
vm.runInContext(source.slice(source.indexOf("function deploymentReadinessControls("), source.indexOf("function renderDeploymentReadiness()")), context);

type Controls = { busy: boolean; resumable: boolean; showPreparation: boolean };
const controls = (state: object, readiness: object | null = null): Controls =>
  context.deploymentReadinessControls(state, readiness, false);

test("a held deployment permits a readiness check and exposes interrupted preparation without saved readiness", () => {
  const result = controls({ loading: false, preparationRunId: null, run: { state: "recovery-required" }, preparation: { state: "blocked", active: false } });
  assert.equal(result.busy, false);
  assert.equal(result.resumable, true);
  assert.equal(result.showPreparation, true);
});

test("a running deployment still blocks a new readiness check", () => {
  const result = controls({ loading: false, preparationRunId: null, run: { state: "running" }, preparation: null });
  assert.equal(result.busy, true);
  assert.equal(result.showPreparation, false);
});

test("readiness can offer preparation when there is no interrupted job", () => {
  const result = controls({ loading: false, preparationRunId: null, run: null, preparation: null }, { ready: false });
  assert.equal(result.busy, false);
  assert.equal(result.showPreparation, true);
});
