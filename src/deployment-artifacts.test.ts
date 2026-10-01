import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const environment = { source: { commit: "new", version: "0.6.1" }, units: [{ sourceRepository: "org/app", buildProfileDigest: "staging" }] };
const artifact = (artifactId: string, commitSha: string, buildProfileDigest = "staging") => ({ artifactId, commitSha, buildProfileDigest,
  sourceRepository: "org/app", retainedUntil: Date.now() + 60_000, tombstonedAt: null });
function browser(artifacts: unknown[], artifactId: string | null) {
  const state = { artifacts, artifactId };
  let invalidated = 0;
  const context = vm.createContext({ WS: { managedDeploy: state }, invalidateDeploymentReadiness: () => { invalidated++; } });
  vm.runInContext(source.slice(source.indexOf("function usableDeploymentArtifacts("), source.indexOf("function renderDeploymentArtifacts(")), context);
  return { state, select: () => context.selectDeploymentArtifact(environment), invalidated: () => invalidated };
}
test("a stale artifact is cleared when source advances and no matching build exists", () => {
  const ui = browser([artifact("old", "old")], "old");
  assert.equal(ui.select().length, 0); assert.equal(ui.state.artifactId, null);
  assert.equal(ui.invalidated(), 1);
  ui.select(); assert.equal(ui.invalidated(), 1, "rendering an empty selector must not erase the new readiness answer");
});
test("new source automatically selects its own build and excludes other environment inputs", () => {
  const ui = browser([artifact("prod", "new", "production"), artifact("new-build", "new"), artifact("old", "old")], "old");
  assert.equal(ui.select().length, 1); assert.equal(ui.state.artifactId, "new-build");
});
test("a still-valid explicitly selected build is retained", () => {
  const ui = browser([artifact("latest", "new"), artifact("selected", "new")], "selected");
  ui.select(); assert.equal(ui.state.artifactId, "selected"); assert.equal(ui.invalidated(), 0);
});

test("readiness refreshes the artifact list when preparation completes while the page is open", async () => {
  const build = artifact("built", "new");
  const env = { ...environment, id: "staging" };
  const state: any = { artifacts: [artifact("old", "old")], artifactId: null, loading: false, data: { environments: [env] } };
  const scope = { state, environmentId: "staging", projectKey: "project" };
  const requests: string[] = [];
  const context = vm.createContext({ WS: { managedDeploy: state },
    deploymentRequestScope: () => scope, deploymentRequestIsCurrent: () => true,
    deploymentBase: () => "/api/projects/project/deployments",
    invalidateDeploymentReadiness: () => { state.readiness = null; },
    loadDeploymentConnectionSetup() {}, renderDeploymentPlan() {},
    agentApi: async (url: string) => {
      requests.push(url);
      return { ok: true, json: async () => url.endsWith("/deployment-artifacts") ? { artifacts: [build] }
        : { readiness: { artifactId: "built", ready: true }, environment: env, plan: {} } };
    },
  });
  vm.runInContext(source.slice(source.indexOf("function usableDeploymentArtifacts("), source.indexOf("function renderDeploymentArtifacts(")), context);
  context.renderManagedDeploy = () => context.selectDeploymentArtifact(env);
  vm.runInContext(source.slice(source.indexOf("async function checkDeploymentReadiness("), source.indexOf('/**\n * "Make ready to deploy"')), context);
  await context.checkDeploymentReadiness();
  assert.equal(state.artifactId, "built");
  assert.equal(state.readiness.ready, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[1], "/api/projects/project/deployment-artifacts");
});
