import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

/** Exercise the shipped UI's request and lifecycle behavior without a browser dependency. */
class Element {
  [key: string]: any;
  children: Element[] = [];
  parent: Element | null = null;
  root = false;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  value = "";
  textContent = "";
  className = "";
  disabled = false;
  constructor(readonly tag: string) {}
  get isConnected(): boolean { return this.root || !!this.parent?.isConnected; }
  get selectedOptions() { return this.children.filter((child) => child.value === this.value); }
  append(...children: Element[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children: Element[]) { for (const child of this.children) child.parent = null; this.children = []; this.append(...children); }
  insertBefore(child: Element, sibling: Element) { child.parent = this; this.children.splice(this.children.indexOf(sibling), 0, child); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector: string): Element[] {
    const selectors = selector.split(",").map((part) => part.trim());
    return this.children.flatMap((child) => [
      ...(selectors.some((part) => part.startsWith(".") ? child.className.split(" ").includes(part.slice(1)) : child.tag === part) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}
const BUSINESS = "business:0123456789abcdef01234567";
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
async function fixture(options: { denied?: boolean; stale?: boolean } = {}) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const confirmations: string[] = [];
  let revision = 0;
  let rules: any[] = [];
  const policy = () => ({ workspaceId: BUSINESS, revision, rules, history: [], permissions: [{ id: "git.push", title: "Push branches", supported: true }] });
  const api = async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (path.includes("/agent-policy")) {
      if (options.denied) return { ok: false, json: async () => ({ error: "Your role cannot manage workspace policy" }) };
      if (init?.method && options.stale) {
        options.stale = false; revision = 2;
        return { ok: false, json: async () => ({ error: "Workspace policy changed since this view was loaded. Refresh and review again." }) };
      }
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        rules = [{ ...body, id: "rule_1", source: "custom", expiresAt: null, remainingUses: null }]; revision++;
      }
      if (init?.method === "DELETE") { rules = []; revision++; }
      return { ok: true, json: async () => policy() };
    }
    if (path.endsWith("/agent-permissions")) return { ok: true, json: async () => ({ project: { workspaceId: BUSINESS }, revision: 0, grants: {}, rules: [], workspaceRules: rules, history: [], permissions: policy().permissions, categories: [{ id: "git-remote", title: "Remote Git" }], presets: [] }) };
    if (path.endsWith("/deployments")) return { ok: true, json: async () => ({ environments: [] }) };
    if (path.endsWith("/agent-access")) return { ok: true, json: async () => ({ engine: "claude", items: [] }) };
    if (path.endsWith("/agent-reviews")) return { ok: true, json: async () => ({ reviews: [] }) };
    return { ok: true, json: async () => ({ requests: [] }) };
  };
  const context = vm.createContext({ window: { psmConfirm: async (message: string) => { confirmations.push(message); return true; } }, document: { createElement: (tag: string) => new Element(tag) } });
  vm.runInContext(fs.readFileSync(new URL("../web/agent-permissions.js", import.meta.url), "utf8"), context);
  const container = new Element("main"); container.root = true;
  const connections = new Element("aside"); connections.root = true;
  const render = () => context.window.PsmAgentPermissions.render(container, connections, { api, project: { id: "prj_test", name: "test" }, onDeploy: () => {} });
  await render(); await flush();
  const section = () => container.querySelector(".permission-workspace-policy")!;
  const button = (label: string) => section().querySelectorAll("button").find((item) => item.textContent === label)!;
  const submit = () => {
    const form = section().querySelector("form")!;
    const selects = form.querySelectorAll("select"); selects[0].value = "git.push"; selects[1].value = "standing";
    form.querySelectorAll("input")[0].value = "production";
    form.onsubmit({ preventDefault() {} });
  };
  return { calls, confirmations, container, section, button, submit, render };
}

test("workspace UI saves scoped restrictions with revision, refreshes inherited policy and removes them explicitly", async () => {
  const ui = await fixture();
  ui.submit(); await flush();
  const post = ui.calls.find((call) => call.init?.method === "POST")!;
  assert.equal(post.path, `/api/workspaces/${encodeURIComponent(BUSINESS)}/agent-policy/rules`);
  assert.deepEqual(JSON.parse(String(post.init?.body)), { permission: "git.push", effect: "deny", scope: { environmentId: "production" }, duration: { kind: "standing" }, revision: 0 });
  assert.match(ui.confirmations[0], /every project/);
  assert.match(ui.confirmations[0], /production/);
  assert.ok(ui.calls.filter((call) => call.path.endsWith("/agent-permissions")).length >= 2, "refresh inherited project rules after saving");
  ui.button("Remove restriction").onclick(); await flush();
  const removal = ui.calls.find((call) => call.init?.method === "DELETE")!;
  assert.equal(removal.path, `${post.path}/rule_1`);
  assert.deepEqual(JSON.parse(String(removal.init?.body)), { revision: 1 });
  assert.ok(ui.section().querySelectorAll("p").some((item) => item.textContent === "No workspace restrictions."));
  assert.ok(!ui.container.querySelectorAll("p").some((item) => String(item.textContent).startsWith("Workspace: DENY")), "removed restrictions must not linger in the project rules");
});

test("stale workspace saves leave controls usable and require refreshed revision before retry", async () => {
  const ui = await fixture({ stale: true });
  ui.submit(); await flush();
  assert.match(ui.section().querySelector(".permission-status")!.textContent, /changed since/);
  assert.ok(ui.section().querySelectorAll("button, select, input").every((item) => !item.disabled));
  await ui.button("Refresh policy").onclick();
  ui.submit(); await flush();
  const posts = ui.calls.filter((call) => call.init?.method === "POST");
  assert.deepEqual(posts.map((call) => JSON.parse(String(call.init?.body)).revision), [0, 2]);
});

test("a role denied management sees the cause without editable workspace controls", async () => {
  const ui = await fixture({ denied: true });
  assert.match(ui.section().querySelector("p")!.textContent, /role cannot manage/);
  assert.equal(ui.section().querySelector("form"), null);
  assert.equal(ui.section().querySelectorAll("button").length, 0);
});
