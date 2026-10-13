import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
function browser(signedIn = false) {
  const publication = { id: "pub_review", commit: "a".repeat(40), repository: "example/site", branch: "dev", digest: "sha256:review",
    policy: { approval: "authenticated-local-operator" } };
  const state: any = { preparationPublication: publication };
  const requests: Array<{ url: string; options: any }> = [], authMessages: string[] = [];
  let confirmations = 0;
  const AUTH: any = { user: signedIn ? { id: "operator" } : null };
  const context = vm.createContext({ AUTH, deploymentRequestScope: () => ({ state }), deploymentRequestIsCurrent: () => true,
    loadSession: async () => AUTH.user, openAuth: (message: string) => authMessages.push(message), renderAccount() {},
    confirmInApp: async () => { confirmations++; return true; }, $: () => ({}),
    agentApi: async (url: string, options: any) => { requests.push({ url, options }); return { ok: true,
      json: async () => url.endsWith("approval-intents") ? { intent: "one-use" } : { publication: { state: "succeeded" } } }; },
    scheduleDeploymentPreparationPoll() {}, renderManagedDeploy() {},
  });
  const start = source.indexOf("function deploymentApprovalNeedsSignIn(");
  const end = source.indexOf("/**\n * A stopped preparation", start);
  vm.runInContext(source.slice(start, end), context);
  return { context, AUTH, state, requests, authMessages, confirmations: () => confirmations };
}

test("signed-out production publication opens sign-in without approval requests or consuming the pending review", async () => {
  const ui = browser();
  const publication = ui.state.preparationPublication;
  await ui.context.approvePreparationPublication();
  assert.equal(ui.requests.length, 0);
  assert.equal(ui.confirmations(), 0);
  assert.equal(ui.state.preparationPublication, publication);
  assert.match(ui.authMessages[0], /Sign in with your Werewolf account to approve source publication/);
});

test("sign-in permits a fresh explicit publication approval bound to the displayed digest", async () => {
  const ui = browser();
  await ui.context.approvePreparationPublication();
  ui.AUTH.user = { id: "operator" };
  assert.equal(ui.requests.length, 0, "signing in alone cannot publish");
  await ui.context.approvePreparationPublication();
  assert.deepEqual(ui.requests.map((r) => r.url), ["/api/source-publications/pub_review/approval-intents", "/api/source-publications/pub_review/approve"]);
  assert.deepEqual(JSON.parse(ui.requests[1].options.body), { digest: "sha256:review", intent: "one-use" });
});

test("local-operator publication policies continue to permit signed-out review", async () => {
  const ui = browser();
  ui.state.preparationPublication.policy.approval = "local-operator";
  await ui.context.approvePreparationPublication();
  assert.equal(ui.authMessages.length, 0);
  assert.equal(ui.requests.length, 2);
});

test("an expired server session opens sign-in and explains how to retry", () => {
  const ui = browser(true);
  const error = ui.context.deploymentApprovalError("approval requires an authenticated operator", "approve this deployment");
  assert.equal(ui.AUTH.user, null);
  assert.match(error.message, /Sign in with your Werewolf account, then approve the pending review/);
  assert.match(ui.authMessages[0], /approve this deployment/);
});

test("local cockpit publishes reviewed source without sign-in even for production policy", async () => {
  const ui = browser();
  ui.AUTH.localApprovalWithoutSignIn = true;
  await ui.context.approvePreparationPublication();
  assert.equal(ui.authMessages.length, 0);
  assert.equal(ui.confirmations(), 1);
  assert.equal(ui.requests.length, 2);
});

test("session refresh recognizes local operator authority before opening sign-in", async () => {
  const ui = browser();
  ui.context.loadSession = async () => { ui.AUTH.localApprovalWithoutSignIn = true; return null; };
  await ui.context.approvePreparationPublication();
  assert.equal(ui.authMessages.length, 0);
  assert.equal(ui.requests.length, 2);
});
