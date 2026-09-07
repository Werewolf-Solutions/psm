import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

// Execute the actual picker functions with a small DOM facade. No network or
// provider processes are needed to exercise delayed responses and scoping.
function picker() {
  const nodes = new Map<string, any>();
  function node(id = "") {
    const n: any = {
      id, dataset: {}, children: [], value: "", textContent: "",
      append(child: any) { this.children.push(child); },
      after(child: any) { if (child.id) nodes.set(child.id, child); },
      setAttribute() {},
      set innerHTML(_value: string) { this.children = []; },
    };
    if (id) nodes.set(id, n);
    return n;
  }
  for (const prefix of ["ws", "web", "d"]) {
    node(`${prefix}-model`);
    node(`${prefix}-effort`);
  }
  const requests: ((response: any) => void)[] = [];
  const context = vm.createContext({
    document: { getElementById: (id: string) => nodes.get(id), createElement: () => node() },
    agentApi: () => new Promise((resolve) => requests.push(resolve)),
    Date, Event,
  });
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  vm.runInContext(source.slice(source.indexOf("const MODEL_CATALOGS"), source.indexOf("async function load()")), context);
  return { nodes, requests, context, run: (code: string) => vm.runInContext(code, context) };
}

const catalog = (engine: string, id: string, levels: string[]) => ({
  engine, source: "live", updatedAt: Date.now(),
  models: [{ id, label: id, effortLevels: levels }], effortLevels: levels,
});

test("effort choices belong to the selected model and project", () => {
  const p = picker();
  p.context.catalog = catalog("codex", "new-model", ["future-effort"]);
  p.run('MODEL_CATALOGS.set(modelCatalogKey("one", "codex"), catalog)');
  p.run('renderEffortOptions(document.getElementById("ws-effort"), "codex", "new-model", "", "one")');
  assert.deepEqual(p.nodes.get("ws-effort").children.map((n: any) => n.value), ["", "future-effort"]);
  p.run('renderEffortOptions(document.getElementById("ws-effort"), "codex", "", "", "one")');
  assert.deepEqual(p.nodes.get("ws-effort").children.map((n: any) => n.value), [""]);
  p.run('renderEffortOptions(document.getElementById("d-effort"), "codex", "new-model", "", "two")');
  assert.deepEqual(p.nodes.get("d-effort").children.map((n: any) => n.value), [""]);
});

test("late discovery cannot replace a switched provider or newer selection", async () => {
  const p = picker();
  p.context.selection = { model: "", effort: "" };
  const first = p.run('refreshModelCatalog("one", "claude", () => selection, document.getElementById("ws-effort"))');
  const second = p.run('refreshModelCatalog("one", "codex", () => selection, document.getElementById("ws-effort"))');
  p.context.selection = { model: "future", effort: "deep" };
  p.requests[1]({ ok: true, json: async () => catalog("codex", "future", ["deep"]) });
  await second;
  p.requests[0]({ ok: true, json: async () => catalog("claude", "old", ["low"]) });
  await first;
  assert.equal(p.nodes.get("ws-model").value, "future");
  assert.equal(p.nodes.get("ws-effort").value, "deep");
  assert.equal(p.run('MODEL_CATALOGS.has(modelCatalogKey("one", "claude"))'), false);
});

test("failed refresh clears offered choices and displays a retry state", async () => {
  const p = picker();
  p.context.catalog = catalog("codex", "old", ["high"]);
  p.run('MODEL_CATALOGS.set(modelCatalogKey("one", "codex"), catalog)');
  const request = p.run('refreshModelCatalog("one", "codex", () => ({model: "", effort: ""}), document.getElementById("ws-effort"))');
  p.requests[0]({ ok: false, json: async () => ({ error: "offline" }) });
  await request;
  assert.equal(p.nodes.get("ws-model").children.length, 0);
  assert.match(p.nodes.get("ws-effort-status").textContent, /unavailable/);
});
