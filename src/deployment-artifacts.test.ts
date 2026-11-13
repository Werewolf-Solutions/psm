import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
function completedReleaseBrowser() {
  const env: any = { source: { commit: "abcdef012345", committed: true, inputsDirty: false },
    activeRelease: { commit: "abcdef012345", psmArtifactId: "built" },
    latestRun: { operation: "deploy", state: "succeeded", createdAt: 1 } };
  const state: any = { environment: "staging", artifactId: "built", run: env.latestRun,
    readinessEnvironment: "staging", readiness: { ready: true, items: [], expiresAt: Date.now() + 60000, artifactId: "built" },
    planEnvironment: "staging", plan: { id: "plan", digest: "digest", operation: "deploy", expiresAt: Date.now() + 60000 } };
  const context = vm.createContext({ WS: { managedDeploy: state }, deploymentEnvironment: () => env,
    $: () => ({ children: [], checked: false, disabled: false, textContent: "Confirm & deploy" }),
    shownDeployControl: () => null, preparationSuperseded: () => false,
    DEPLOYMENT_TERMINAL_STATES: new Set(["succeeded", "failed", "interrupted", "cancelled"]),
  });
  vm.runInContext(source.slice(source.indexOf("function deploymentUpToDate("), source.indexOf("function preparationSuperseded(")), context);
  vm.runInContext(source.slice(source.indexOf("function deploymentReadyToApprove("), source.indexOf("function deploymentReadinessControls(")), context);
  vm.runInContext(source.slice(source.indexOf("function deploymentTodoItems("), source.indexOf("/** Rebuilt once after any deploy-page render")), context);
  return { env, state, context };
}

test("a successful active release has no remaining deploy todo or approval", () => {
  const { context } = completedReleaseBrowser();
  assert.equal(context.deploymentReleaseComplete(), true);
  assert.equal(context.deploymentReadyToApprove(), false);
  assert.equal(context.deploymentTodoItems().length, 0);
});

test("completed release still permits reviewing and approving rollback", () => {
  const { state, context } = completedReleaseBrowser();
  state.plan.operation = "rollback";
  assert.equal(context.deploymentReadyToApprove(), true);
  assert.equal(context.deploymentTodoItems().length, 1);
});

test("new source, local changes, another artifact and failed verification still need attention", () => {
  const { env, state, context } = completedReleaseBrowser();
  env.source.inputsDirty = true; assert.equal(context.deploymentReleaseComplete(), false);
  env.source.inputsDirty = false;
  env.source.commit = "newabcdef0123"; assert.equal(context.deploymentReleaseComplete(), false);
  env.source.commit = env.activeRelease.commit;
  state.artifactId = "rebuilt"; assert.equal(context.deploymentReleaseComplete(), false);
  state.artifactId = "built";
  state.run = { operation: "deploy", state: "failed", createdAt: 2 };
  assert.equal(context.deploymentReleaseComplete(), false);
  assert.equal(context.deploymentReadyToApprove(), true, "verification retry stays available");
});
test("dirty source action starts preparation rather than navigating to Changes", () => {
  const buttons: any[] = [];
  const calls: boolean[] = [];
  const context = vm.createContext({
    item: { code: "source-dirty" }, index: 0, state: { loading: false, preparation: { active: false } },
    depText: (_tag: string, _class: string, text: string) => ({ text }),
    $: () => ({ children: [{ append: (button: any) => buttons.push(button) }] }),
    checkDeploymentReadiness: (makeReady: boolean) => calls.push(makeReady),
  });
  const start = source.indexOf('    if (item.code === "source-dirty") {');
  const end = source.indexOf('    const button = depText', start);
  vm.runInContext(`for (let once = 0; once < 1; once++) { ${source.slice(start, end)} }`, context);
  assert.equal(buttons[0].text, "Commit and prepare build");
  buttons[0].onclick();
  assert.deepEqual(calls, [true]);
});

test("Check readiness opens the checklist before starting each check", async () => {
  const nodes: Record<string, any> = {};
  const order: string[] = [];
  let checks = 0;
  const state = { readiness: { ready: false } };
  const context = vm.createContext({ WS: { managedDeploy: state },
    $: (id: string) => nodes[id] ??= { hidden: false },
    openDeploymentGuide: () => order.push("guide"),
    checkDeploymentReadiness: async () => { checks++; order.push("check"); },
  });
  const start = source.indexOf('$("#dep-discover").onclick =');
  const end = source.indexOf('$("#dep-make-ready").onclick', start);
  vm.runInContext(source.slice(start, end), context);
  await nodes["#dep-discover"].onclick();
  state.readiness.ready = true;
  await nodes["#dep-discover"].onclick();
  assert.equal(checks, 2);
  assert.deepEqual(order, ["guide", "check", "guide", "check"]);
});

test("the build button uses the same commit/publication preparation coordinator", async () => {
  const calls: boolean[] = [];
  const context = vm.createContext({ deploymentEnvironment: () => ({}),
    checkDeploymentReadiness: async (makeReady: boolean) => calls.push(makeReady) });
  const start = source.indexOf("async function prepareDeploymentArtifact(");
  const end = source.indexOf("async function restoreDeploymentReadiness", start);
  vm.runInContext(source.slice(start, end), context);
  await context.prepareDeploymentArtifact();
  assert.deepEqual(calls, [true]);
});
const environment = { source: { commit: "new", version: "0.6.1" }, units: [{ sourceRepository: "org/app", buildProfileDigest: "staging" }] };
const artifact = (artifactId: string, commitSha: string, buildProfileDigest = "staging") => ({ artifactId, commitSha, buildProfileDigest,
  sourceRepository: "org/app", retainedUntil: Date.now() + 60_000, tombstonedAt: null });
test("Deploy previews a higher version while preserving the committed source version", () => {
  const cards: Array<{ label: string; value: string; detail: string }> = [];
  const context = vm.createContext({
    $: () => ({ replaceChildren() { cards.length = 0; }, append() {} }),
    depCard: (label: string, value: string, detail: string) => { cards.push({ label, value, detail }); return { children: [{}, { append() {} }] }; },
    document: {createTextNode: (s: string) => s}, depText: () => ({}),
    relTime: () => "now",
  });
  vm.runInContext(source.slice(source.indexOf("function renderManagedSummary("), source.indexOf("function renderManagedConnections(")), context);
  context.renderManagedSummary({ source: { version: "0.6.4", workingTreeVersion: "0.6.5", inputsDirty: true, committed: true } });
  assert.equal(cards[0].label, "Proposed next version"); assert.equal(cards[0].value, "0.6.5");
  assert.match(cards[0].detail, /provisional/);
  assert.equal(cards[1].label, "Committed source"); assert.equal(cards[1].value, "0.6.4");
  context.renderManagedSummary({ source: { version: "1.0.4", workingTreeVersion: "1.0.4", inputsDirty: true, committed: true } });
  assert.equal(cards[0].value, "1.0.5");
  context.renderManagedSummary({ source: { version: "1.0.4", workingTreeVersion: "1.0.4", proposedVersion: "2.0.0", inputsDirty: true, committed: true } });
  assert.equal(cards[0].value, "2.0.0");
  context.renderManagedSummary({ source: { version: "0.6.5", workingTreeVersion: "0.6.5", inputsDirty: false, committed: true } });
  assert.equal(cards[0].label, "Committed source"); assert.equal(cards[0].value, "0.6.5");
});
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
    refreshDeploymentWatch() {}, loadDeploymentConnectionSetup() {}, renderDeploymentPlan() {},
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

test("controller readiness opens the complete bundle review without attempting a rejected manual pin", () => {
  const buttons: any[] = [];
  const target = { id: "controller-review" };
  const context = vm.createContext({ item: { status: "blocked", action: "review-controller", slot: "github" }, index: 0,
    depText: (_tag: string, _class: string, text: string) => ({ text }),
    $: () => ({ children: [{ append: (button: any) => buttons.push(button) }] }),
    deploymentControllerSetupTarget: (slot: string) => { assert.equal(slot, "github"); return target; },
    showMe: (resolve: () => any) => { assert.equal(resolve(), target); },
    agentApi: () => { throw new Error("Must not attempt manual pinning or credential publication"); },
  });
  const start = source.indexOf('    if (item.status !== "ready" && item.action === "review-controller") {');
  const end = source.indexOf("    // The release controller's GitHub Environment", start);
  vm.runInContext(`for (let once = 0; once < 1; once++) { ${source.slice(start, end)} }`, context);
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].text, "Review controller setup / update");
  buttons[0].onclick();
});

test("the task list combines pin, target and credentials into one controller review", () => {
  const { state, context } = completedReleaseBrowser();
  state.readiness.items = ["pin", "target", "credentials"].map((part) => ({ id: `controller-${part}`, status: "blocked",
    action: "review-controller", automatic: false, slot: "github" }));
  state.readiness.ready = false;
  const target = { id: "controller-review" };
  context.deploymentControllerSetupTarget = () => target;
  const items = context.deploymentTodoItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Review the release controller setup");
  assert.equal(items[0].target(), target);
});
