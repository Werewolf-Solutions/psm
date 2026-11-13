import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const serviceSource = fs.readFileSync(new URL("./server/deploy/service.ts", import.meta.url), "utf8");
const releasePresenter = serviceSource.slice(serviceSource.indexOf("function releaseView("), serviceSource.indexOf("function runTerminal("));
const loader = source.slice(source.indexOf("async function loadManagedDeploy("), source.indexOf("function offerProjectId("));
const readinessRenderer = source.slice(source.indexOf("function renderDeploymentReadiness()"), source.indexOf("/** A deploy-page element, only while it is on screen. */"));
const preparationFocus = source.slice(source.indexOf("/** Follow a preparation handoff once"), source.indexOf("function scheduleDeploymentPreparationPoll("));
const decisionFocus = source.slice(source.indexOf("function focusDeploymentDecision()"), source.indexOf("/** Follow a preparation handoff once"));
const failureDetailSource = source.slice(source.indexOf("function deploymentFailureDetail("), source.indexOf("/** Everything the operator has to do"));

function view(request: () => Promise<unknown>) {
  const nodes = new Map<string, { hidden: boolean; textContent: string }>();
  const state = { data: null, deployLoadRetries: 1 };
  const context = vm.createContext({
    WS: { name: "handymanservices", kind: "project", pane: "deploy" },
    $: (selector: string) => {
      if (!nodes.has(selector)) nodes.set(selector, { hidden: true, textContent: "" });
      return nodes.get(selector);
    },
    deploymentRequestScope: () => ({ state, projectKey: "handymanservices" }),
    deploymentRequestIsCurrent: () => true,
    deploymentBase: () => "/api/projects/handymanservices/deployments",
    agentApi: request,
    renderManagedDeploy: () => {},
    renderDeploymentSetup: () => {},
    renderDeployControls: () => {},
    connectDeployLogs: () => {},
    setTimeout: () => {},
  });
  vm.runInContext(loader, context);
  return { context, nodes };
}

test("a failed managed deployment read does not become an unmanaged deployment", async () => {
  const { context, nodes } = view(async () => { throw new Error("connection reset"); });
  await vm.runInContext("loadManagedDeploy()", context);
  assert.equal(nodes.get("#ws-deploy-legacy")?.hidden, true);
  assert.equal(nodes.get("#ws-deploy-load-error")?.hidden, false);
  assert.match(nodes.get("#dep-load-error-message")?.textContent || "", /connection reset/);
});

test("a confirmed missing manifest still offers deployment setup", async () => {
  const { context, nodes } = view(async (url?: string) => url?.endsWith("/deployments")
    ? { ok: false, json: async () => ({ code: "manifest-missing" }) }
    : { ok: true, json: async () => ({ artifacts: [] }) });
  await vm.runInContext("loadManagedDeploy()", context);
  assert.equal(nodes.get("#ws-deploy-setup")?.hidden, false);
  assert.equal(nodes.get("#ws-deploy-load-error")?.hidden, true);
});

test("deployment readiness renders before any preparation job exists", () => {
  const nodes = new Map<string, { children: unknown[]; replaceChildren: () => void; append: () => void; classList: { add: () => void }; textContent: string; hidden: boolean; disabled: boolean; value: string; title: string }>();
  const state = { environment: "production", readinessEnvironment: null, readiness: null, loading: false, preparation: null, preparationActivity: null, error: null, run: null, plan: null };
  const context = vm.createContext({
    WS: { name: "handymanservices", pane: "deploy", managedDeploy: state },
    $: (selector: string) => {
      if (!nodes.has(selector)) nodes.set(selector, { children: [], replaceChildren() {}, append() {}, classList: { add() {} }, textContent: "", hidden: false, disabled: false, value: "", title: "" });
      return nodes.get(selector);
    },
    scheduleDeploymentTodo() {}, depRows() {}, renderActivityTimes() {}, depText: (_tag: string, _class: string, value: string) => ({ textContent: value }),
    deploymentReadinessControls: () => ({ busy: false, preparing: false, resumable: false, showPreparation: false }),
    preparationSuperseded: () => false, deploymentReleaseComplete: () => false,
    deploymentEnvironment: () => null,
    preparationEngine: () => "codex", preparationModel: () => "", preparationEffort: () => "",
    renderEffortOptions() {}, deploymentReadyToApprove: () => false,
  });
  vm.runInContext(readinessRenderer, context);
  vm.runInContext("renderDeploymentReadiness()", context);
  assert.match(nodes.get("#dep-status")?.textContent || "", /Check readiness/);
});

test("a failed public health check names the failed JSON expectation", () => {
  const context = vm.createContext({});
  vm.runInContext(failureDetailSource, context);
  const detail = vm.runInContext("deploymentFailureDetail", context) as (run: unknown) => string;
  const run = { state: "failed", events: [{ type: "action-check-failed", message: "Read-only action did not pass", data: { result: { data: { probes: [{ id: "health", state: "blocked", detail: "$.ok did not equal the expected value" }] } } } }] };
  assert.equal(detail(run), "health: $.ok did not equal the expected value");
});

test("preparation moves to a newly available publication review only once", () => {
  const focused: string[] = [];
  const job = { id: "prep_1", state: "awaiting-approval", phase: "publish" };
  const state = { preparation: job, preparationPublication: { id: "pub_1" }, preparationPlan: null, preparationFocusedStep: null };
  const scope = { state };
  const context = vm.createContext({
    WS: { pane: "deploy" },
    deploymentRequestIsCurrent: () => true,
    requestAnimationFrame: (callback: () => void) => callback(),
    preparationStep: (value: typeof job) => `${value.state}:${value.phase}`,
    shownDeployControl: (selector: string) => selector,
    showMe: (selector: string) => { focused.push(selector); return true; },
    scope, job,
  });
  vm.runInContext(preparationFocus, context);
  vm.runInContext("focusPreparationNextStep(scope, job, false)", context);
  vm.runInContext("focusPreparationNextStep(scope, job, false)", context);
  assert.deepEqual(focused, ["#dep-preparation"]);
  state.preparationPublication = { id: "pub_2" };
  vm.runInContext("focusPreparationNextStep(scope, job, false)", context);
  assert.deepEqual(focused, ["#dep-preparation", "#dep-preparation"], "a renewed review gets attention again");
});

test("completed preparation follows the final review and its confirm action", () => {
  const focused: string[] = [];
  const controls = new Map<string, { id: string; disabled?: boolean }>([
    ["#dep-confirm", { id: "confirm", disabled: true }],
    ["#dep-plan-section", { id: "review" }],
    ["#dep-approve", { id: "plan" }],
  ]);
  const job = { id: "prep_2", state: "succeeded", phase: "build" };
  const state = { preparation: job, preparationFocusedStep: null };
  const scope = { state };
  const context = vm.createContext({
    WS: { pane: "deploy" }, deploymentRequestIsCurrent: () => true,
    shownDeployControl: (selector: string) => controls.get(selector),
    showMe: (node: { id: string }) => { focused.push(node.id); return true; },
    requestAnimationFrame: (callback: () => void) => callback(),
    preparationStep: (value: typeof job) => `${value.state}:${value.phase}`,
    scope, job,
  });
  vm.runInContext(decisionFocus + preparationFocus, context);
  vm.runInContext("focusPreparationNextStep(scope, job, true)", context);
  assert.deepEqual(focused, ["review"]);
  state.preparationFocusedStep = null;
  controls.get("#dep-confirm")!.disabled = false;
  vm.runInContext("focusPreparationNextStep(scope, job, true)", context);
  assert.deepEqual(focused, ["review", "confirm"]);
});

test("an active release without a successful receipt is exposed as unverified", () => {
  const context = vm.createContext({ object: (value: unknown) => value });
  vm.runInContext(releasePresenter.replace(/release: DeploymentRelease, activeReleaseId: string \| null\): Record<string, unknown>/, "release, activeReleaseId)"), context);
  const releaseView = vm.runInContext("releaseView", context) as (release: unknown, activeReleaseId: string) => { verified: boolean };
  const release = {
    releaseId: "release_1", artifactId: "artifact_1", activatedAt: 1,
    tombstonedAt: null, provenance: "managed",
    receipt: { version: "1.1.0", commit: "625ff222", verified: false },
  };
  assert.equal(releaseView(release, "release_1").verified, false);
  release.receipt.verified = true;
  assert.equal(releaseView(release, "release_1").verified, true);
});
