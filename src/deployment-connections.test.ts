import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { validateConnectionProfile, validateConnectionScope, type ConnectionProfile } from "./server/deploy/connections.ts";
import { GitHubActionsAdapter } from "./server/deploy/adapters/github.ts";
import { knownHostFingerprint } from "./server/deploy/adapters/host-helper.ts";

// Exercise the shipped script's handlers without adding a browser dependency.
class Element {
  [key: string]: any;
  children: Element[] = [];
  dataset = {};
  attributes: Record<string, string> = {};
  value = "";
  textContent = "";
  disabled = false;
  required = false;
  constructor(readonly tag: string) {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  querySelectorAll(selector: string): Element[] {
    const selectors = selector.split(",").map((part) => part.trim());
    return this.children.flatMap((child) => [
      ...(selectors.some((part) => part.startsWith(".") ? child.className?.split(" ").includes(part.slice(1)) : child.tag === part) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}

function ui() {
  const context = vm.createContext({ window: {}, document: { createElement: (tag: string) => new Element(tag) }, crypto: { randomUUID } });
  vm.runInContext(fs.readFileSync(new URL("../web/deployment-connections.js", import.meta.url), "utf8"), context);
  return context.window.PsmDeploymentConnections;
}

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const environment = { projectId: "prj_example", id: "production", risk: "production", releasePolicy: { allowedBranch: "main" } };
const hostSetup = { targets: [{ id: "example:web", root: "/srv/example" }] };
const hostKey = `example.com ssh-ed25519 ${Buffer.alloc(32, 1).toString("base64")}`;
const hostValues = { host: "example.com", user: "deploy", port: "22", address: "192.0.2.1", knownHost: hostKey, hostKeyFingerprint: knownHostFingerprint(hostKey), fingerprint0: `sha256:${"a".repeat(64)}`, revision0: "1" };
// The release workflow, its ref and its hashes reach the form as discovered defaults; only the
// release repository and the Environment name are answerable by a person.
const controllerPins = { controllerRepository: "example/releases", controllerWorkflow: "release.yml", controllerRef: "main", controllerSha: "a".repeat(40), workflowSha: "b".repeat(40) };
const githubWorkflows = [{ repository: "example/site", workflow: "build.yml", targetId: "example:web" }];
const githubSetup = { workflows: githubWorkflows, defaults: { values: controllerPins, sources: {} } };
const githubValues = { githubEnvironment0: "production" };

function build(kind: string, setup: unknown, overrides: Record<string, string> = {}) {
  const form = ui().setupForm({ kind, setup }, environment);
  return plain(form.build({ ...Object.fromEntries(form.fields.map((field: any) => [field.key, field.value])), ...overrides }, "con_test"));
}

function validated(profile: any): ConnectionProfile {
  const candidate = { ...profile, name: profile.label, metadataRevision: 1 };
  assert.deepEqual(validateConnectionProfile(candidate), { ok: true, issues: [] });
  assert.deepEqual(candidate.constraints.allowedProjectIds, [environment.projectId]);
  assert.deepEqual(candidate.constraints.allowedEnvironmentIds, [environment.id]);
  return candidate;
}

test("guided host settings satisfy the host profile and target scope contracts", () => {
  const profile = validated(build("ssh-host-helper@1", hostSetup, hostValues));
  assert.equal(profile.constraints.ssh?.hostKeyFingerprint, knownHostFingerprint(String(profile.publicMetadata?.knownHost)));
  assert.deepEqual(profile.requiredSecretSlots, ["privateKey"]);
  assert.equal(validateConnectionScope(profile, profile.kind, { projectId: environment.projectId, environmentId: environment.id, risk: "production", targetId: "example:web", targetRoot: "/srv/example/current" }).ok, true);
  assert.throws(() => build("ssh-host-helper@1", hostSetup, { ...hostValues, port: "65536" }), /SSH port/);
  assert.throws(() => build("ssh-host-helper@1", hostSetup, { ...hostValues, host: "different.example.com" }), /verified SSH host key/);
});

test("guided GitHub settings configure the real adapter and deduplicate shared build workflows", () => {
  const profile = validated(build("github-actions@1", { ...githubSetup, workflows: [...githubWorkflows, ...githubWorkflows] }, githubValues));
  assert.deepEqual(profile.requiredSecretSlots, ["apiToken"]);
  assert.doesNotThrow(() => new GitHubActionsAdapter({ metadata: profile.publicMetadata as never, token: () => "unused-test-token" }));
  assert.equal((profile.publicMetadata?.prepareWorkflows as unknown[]).length, 1);
  const controllers = profile.publicMetadata?.releaseControllers as Record<string, unknown>[];
  assert.equal(controllers.length, 1);
  assert.deepEqual([controllers[0].expectedHeadSha, controllers[0].expectedWorkflowBlobSha], [controllerPins.controllerSha, controllerPins.workflowSha]);
  assert.equal(validateConnectionScope(profile, profile.kind, { projectId: environment.projectId, environmentId: environment.id, risk: "production", repository: "example/site", sourceRef: "main" }).ok, true);
});

test("an unpinned release controller defers the release instead of demanding hashes by hand", () => {
  const setup = { workflows: githubWorkflows, defaults: { values: { controllerRepository: "example/releases" }, sources: {} } };
  const form = ui().setupForm({ kind: "github-actions@1", setup }, environment);
  assert.equal(form.controller.pinned, false);
  // Nothing on the form asks a person for a commit or blob hash.
  assert.equal(form.fields.filter((field: any) => /Sha$|controllerRef|controllerWorkflow/.test(field.key)).length, 0);
  const profile = validated(plain(form.build(Object.fromEntries(form.fields.map((field: any) => [field.key, field.value])), "con_test")));
  assert.deepEqual(profile.publicMetadata?.releaseControllers, []);
  assert.doesNotThrow(() => new GitHubActionsAdapter({ metadata: profile.publicMetadata as never, token: () => "unused-test-token" }));
  assert.equal((profile.publicMetadata?.prepareWorkflows as unknown[]).length, 1);
});

test("pins are never carried onto a release repository they were not read from", () => {
  const moved = build("github-actions@1", githubSetup, { ...githubValues, controllerRepository: "example/other-releases" });
  assert.deepEqual(moved.publicMetadata?.releaseControllers, []);
  assert.equal((build("github-actions@1", githubSetup, githubValues).publicMetadata?.releaseControllers as unknown[]).length, 1);
});

test("DNS and monitoring forms use declared scope and the runtime's secret and provider names", () => {
  const dns = validated(build("digitalocean-api@1", { zones: ["example.com"] }));
  assert.deepEqual(dns.constraints.allowedZones, ["example.com"]);
  assert.deepEqual(dns.requiredSecretSlots, ["apiToken"]);
  const monitor = validated(build("external-monitor@1", { monitorIds: ["1234"] }, {provider:"better-stack@1"}));
  assert.deepEqual(monitor.constraints.allowedMonitorIds, ["1234"]);
  assert.equal(monitor.publicMetadata?.provider, "better-stack@1");
  assert.equal(ui().setupForm({ kind: "custom@1" }, environment), null);
});

const submit = (form: Element) => form.onsubmit({ preventDefault() {} });

async function rendered(options: { kind?: string; setup?: unknown; canManage?: boolean; failBinding?: boolean } = {}) {
  const module = ui();
  const container = new Element("div");
  const connection = { slot: "test", kind: options.kind || "digitalocean-api@1", setup: options.setup || { zones: ["example.com"] } };
  const profiles: any[] = [];
  const calls: { path: string; method: string; body?: any }[] = [];
  let failBinding = options.failBinding;
  const api = async (path: string, init: any = {}) => {
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    if (method === "GET") return { ok: true, json: async () => ({ connections: profiles }) };
    if (path === "/api/connections") profiles.push({ ...body, missingSecretSlots: body.requiredSecretSlots });
    if (method === "PUT" && failBinding) {
      failBinding = false;
      return { ok: false, json: async () => ({ error: "temporary binding failure" }) };
    }
    if (path.endsWith("/secrets")) profiles[0].missingSecretSlots = [];
    return { ok: true, json: async () => ({ binding: { bindingRevision: 1 } }) };
  };
  const renderOptions = { projectKey: environment.projectId, environment: { ...environment, connections: [connection] }, api, canManage: options.canManage ?? true };
  const refresh = () => module.render(container, renderOptions);
  await refresh();
  return { container, calls, profiles, refresh };
}

test("guided create binds the profile and exposes a working credential form; JSON starts collapsed", async () => {
  const { container, calls } = await rendered();
  assert.equal(container.querySelectorAll(".dep-connection-advanced")[0].open, false);
  await submit(container.querySelectorAll(".dep-connection-guided")[0]);
  const writes = calls.filter((call) => call.method !== "GET");
  assert.equal(writes[0].path, "/api/connections");
  assert.equal(writes[1].method, "PUT");
  assert.equal(writes[1].body.connectionId, writes[0].body.connectionId);
  const secret = container.querySelectorAll(".dep-connection-secret")[0];
  const input = secret.querySelectorAll("input")[0];
  input.value = "dummy-api-token";
  input.oninput();
  await submit(secret);
  assert.deepEqual(calls.at(-2)?.body, { slot: "apiToken", value: "dummy-api-token" });
  assert.equal(input.value, "");
  const replacement = container.querySelectorAll(".dep-connection-secret")[0];
  assert.equal(replacement.querySelectorAll("button")[0].textContent, "Replace credential");
  const replacementInput = replacement.querySelectorAll("input")[0];
  replacementInput.value = "replacement-api-token";
  replacementInput.oninput();
  await submit(replacement);
  assert.deepEqual(calls.at(-2)?.body, { slot: "apiToken", value: "replacement-api-token" });
});

test("retrying a failed binding does not create another profile", async () => {
  const { container, calls } = await rendered({ failBinding: true });
  const form = container.querySelectorAll(".dep-connection-guided")[0];
  await submit(form);
  assert.match(container.querySelectorAll(".dep-connection-status")[0].textContent, /Connection saved, but/);
  await submit(form);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(calls.filter((call) => call.method === "PUT").length, 2);
});

test("read-only connection setup cannot create profiles", async () => {
  const { container, calls } = await rendered({ canManage: false });
  const form = container.querySelectorAll(".dep-connection-guided")[0];
  assert.ok(form.querySelectorAll("input, button").every((input) => input.disabled));
  await submit(form);
  assert.equal(calls.length, 1);
});

test("discovered defaults are editable and public edits survive background refreshes", async () => {
  const { container, refresh } = await rendered({ setup: { zones: ["example.com"], defaults: { values: { label: "Detected DNS" }, sources: { label: "Saved connection" } } } });
  const form = container.querySelectorAll(".dep-connection-guided")[0];
  const name = form.querySelectorAll("input")[0];
  assert.equal(name.value, "Detected DNS");
  assert.equal(name.disabled, false);
  name.value = "My custom DNS";
  name.oninput();
  const zones = form.querySelectorAll("input")[1];
  zones.value = "";
  zones.oninput();
  await refresh();
  const restored = container.querySelectorAll(".dep-connection-guided")[0].querySelectorAll("input");
  assert.equal(restored[0].value, "My custom DNS");
  assert.equal(restored[1].value, "", "intentionally cleared values must not be refilled");
});

test("advanced JSON import still creates a custom profile without changing its scope", async () => {
  const { container, calls } = await rendered();
  const advanced = container.querySelectorAll(".dep-connection-advanced")[0];
  const profile = build("digitalocean-api@1", { zones: ["example.com"] });
  profile.constraints.allowedEnvironmentIds.push("staging");
  const textarea = advanced.querySelectorAll("textarea")[0];
  textarea.value = JSON.stringify(profile);
  textarea.oninput();
  await submit(advanced.querySelectorAll("form")[0]);
  assert.deepEqual(calls.find((call) => call.method === "POST")?.body, profile);
  assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
});

test("choosing a private key file satisfies the credential form without a typed password", async () => {
  const { container, calls } = await rendered({ kind: "ssh-host-helper@1", setup: hostSetup });
  const guided = container.querySelectorAll(".dep-connection-guided")[0];
  const schema = ui().setupForm({ kind: "ssh-host-helper@1", setup: hostSetup }, environment);
  guided.querySelectorAll("input").forEach((input, i) => { input.value = (hostValues as Record<string, string>)[schema.fields[i].key] || input.value; });
  await submit(guided);
  const secret = container.querySelectorAll(".dep-connection-secret")[0];
  const password = secret.querySelectorAll("input")[0];
  const file = secret.querySelectorAll(".dep-connection-keyfile")[0];
  file.files = [{ size: 12, text: async () => "dummy-private-key" }];
  await file.onchange();
  assert.equal(password.required, false);
  assert.equal(secret.querySelectorAll("button")[0].disabled, false);
  await submit(secret);
  assert.deepEqual(calls.at(-2)?.body, { slot: "privateKey", value: "dummy-private-key" });
});

test('Werewolf monitoring defaults to a pinned SSH reader and needs no API token', () => {
  const profile=build('external-monitor@1',{monitorIds:['todo-staging-web']},{...hostValues,user:'psm-watch-read'});
  validated(profile);
  assert.equal(profile.publicMetadata.provider,'werewolf-watch@1');
  assert.deepEqual(profile.requiredSecretSlots,['privateKey']);
  assert.equal(profile.constraints.ssh.user,'psm-watch-read');
  assert.deepEqual(profile.constraints.allowedMonitorIds,['todo-staging-web']);
  assert.throws(()=>build('external-monitor@1',{monitorIds:['todo-staging-web']}),/requires host/);
});
