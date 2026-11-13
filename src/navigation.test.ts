import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const project = { id: "prj_todo", name: "todo-app" };
function browser(storage = new Map<string, string>()) {
  const nodes = new Map<string, any>();
  const element = () => ({
    children: [] as any[], hidden: false, value: "", dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    append(...children: any[]) { this.children.push(...children); },
    querySelector() { return element(); },
  });
  const context = vm.createContext({
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    location: { hash: "#/p/prj_todo/deploy" },
    history: { replaceState: (_state: unknown, _unused: string, hash: string) => { context.location.hash = hash; } },
    STATE: { projects: [project], can: { customCommands: false }, sessions: [{ name: "todo-app" }, { kind: "work", id: "room", name: "Prepare staging", projects: ["todo-app"] }] },
    WS: { kind: "project", name: "todo-app", id: null, pane: "plan", recapFetched: true, managedDeploy: {} },
    PLAN: {}, PLANNER: {}, CAPS: {}, NOTES: {},
    $: (key: string) => { if (!nodes.has(key)) nodes.set(key, element()); return nodes.get(key); },
    el: element, esc: (text: string) => text,
    document: { querySelectorAll: () => [], body: element() },
    window: {},
    AGENTS_PAGE: false, URLSearchParams,
    agentsPage: [] as (string | null)[],
  });
  // The Agents page (#/agents) lives further down app.js; the router only opens and closes it.
  context.openAgentsPage = (agent: string, projectId: string | null) => { context.AGENTS_PAGE = true; context.agentsPage.push(projectId ? `${agent}?${projectId}` : agent); };
  context.PsmScripts = { open: () => {}, close: () => {} };
  context.modelsPage = [] as string[];
  context.openModelsPage = (view: string, params: URLSearchParams) => { context.MODELS_PAGE = true; context.modelsPage.push(params.toString() ? `${view}?${params}` : view); };
  context.closeModelsPage = () => { if (context.MODELS_PAGE) context.modelsPage.push("closed"); context.MODELS_PAGE = false; };
  context.closeAgentsPage = () => { if (context.AGENTS_PAGE) context.agentsPage.push("closed"); context.AGENTS_PAGE = false; };
  for (const name of ["clearDeploymentPoll", "clearPreparationPoll", "ensureAiConnected", "disconnectAi", "connectPlanner", "disconnectPlanner", "renderWorkingButton", "renderWebPane", "openDeployPane", "fetchSessionState", "loadChanges", "loadPlan", "loadCapabilities", "loadNotes", "fetchRecap", "fetchLimit", "stashDraft", "emptyPlannerState", "emptyManagedDeploymentState", "usageSelectionChanged", "renderMembers", "renderRoomDependencies", "renderCustomCommands", "clearConsole", "clearAiTranscript", "renderSessionPane", "loadDraft", "syncAiControls", "refreshAiModels", "loadDevNotes", "setWsStatus", "setAiBusy", "connectLogs", "toast", "closeWorkspace", "renderBoard"]) context[name] = () => {};
  context.emptyPlannerState = (project: string) => ({ project });
  context.emptyManagedDeploymentState = () => ({});
  context.aiPaneOpen = () => context.WS.pane === "ai" || context.WS.pane === "session";
  vm.runInContext(source.slice(source.indexOf("function routeKey("), source.indexOf("function relTime(")), context);
  vm.runInContext(source.slice(source.indexOf("function switchPane("), source.indexOf("const webUrl =")), context);
  vm.runInContext(source.slice(source.indexOf("function openWorkspace("), source.indexOf("/* ---------- workrooms:")), context);
  vm.runInContext(source.slice(source.indexOf("async function openWorkroom("), source.indexOf("function aiPaneOpen(")), context);
  vm.runInContext(source.slice(source.indexOf("function routeFromHash("), source.indexOf("/* ---- capability catalog")), context);
  return { context, nodes, storage };
}

test("switching from Deploy to a workroom and back remembers each target's tab", () => {
  const b = browser();
  b.context.switchPane("deploy");
  b.context.WS = { kind: "work", name: "room", id: "room", pane: "ai", recapFetched: true };
  b.context.switchPane("session");
  b.context.renderQuickSwitch();
  const pills = b.nodes.get("#quick-switch").children;
  pills.at(-2).onclick();
  assert.equal(b.context.location.hash, "#/p/prj_todo/deploy");
  b.context.routeFromHash();
  assert.equal(b.context.WS.pane, "deploy", "opening the project restores the selected tab");
  assert.equal(b.context.workroomHash("room"), "#/w/room/session");
});

test("saved panes survive page reload and project renaming; explicit routes win", () => {
  const first = browser();
  first.context.switchPane("deploy");
  first.context.rememberPane("work", "room", "changes");
  const reloaded = browser(first.storage);
  reloaded.context.STATE.projects = [{ ...project, name: "renamed-todo" }];
  assert.equal(reloaded.context.projectHash("prj_todo"), "#/p/prj_todo/deploy");
  assert.equal(reloaded.context.workroomHash("room"), "#/w/room/changes");
  reloaded.context.location.hash = "#/p/prj_todo/notes";
  reloaded.context.routeFromHash();
  assert.equal(reloaded.context.WS.pane, "notes");
  assert.equal(reloaded.context.projectHash("prj_todo"), "#/p/prj_todo/notes");
});

test("workrooms and workspace chat honour explicit Session links instead of forcing AI", async () => {
  const b = browser();
  b.context.agentApi = async () => ({ ok: true, json: async () => ({ workSession: { id: "room", title: "Prepare staging", engine: "claude" } }) });
  b.context.location.hash = "#/w/room/session";
  await b.context.openWorkroom("room", true, "session");
  assert.equal(b.context.WS.pane, "session");
  assert.equal(b.context.location.hash, "#/w/room/session");
  b.context.location.hash = "#/p/__workspace__/session";
  await b.context.openWorkspaceChat(true, "session");
  assert.equal(b.context.WS.pane, "session");
});

test("late room responses cannot replace a project selected while the room loads", async () => {
  const b = browser();
  let resolve: (value: unknown) => void = () => {};
  b.context.agentApi = () => new Promise((done) => { resolve = done; });
  b.context.location.hash = "#/w/room/ai";
  const opening = b.context.openWorkroom("room", true, "ai");
  b.context.location.hash = "#/p/prj_todo/deploy";
  b.context.routeFromHash();
  resolve({ ok: true, json: async () => ({ workSession: { id: "room", title: "Prepare staging" } }) });
  await opening;
  assert.equal(b.context.WS.name, "todo-app");
  assert.equal(b.context.WS.pane, "deploy");
});

test("invalid or unavailable storage falls back safely and target kinds stay separate", () => {
  const b = browser(new Map([["psm.selected-panes.v1", '{"project:prj_todo":"not-a-tab","work:room":"plan"}']]));
  assert.equal(b.context.projectHash("prj_todo"), "#/p/prj_todo/plan");
  assert.equal(b.context.workroomHash("room"), "#/w/room/ai");
  b.context.localStorage.setItem = () => { throw new Error("storage denied"); };
  b.context.rememberPane("project", "room", "deploy");
  assert.equal(b.context.projectHash("room"), "#/p/room/deploy");
  assert.equal(b.context.workroomHash("room"), "#/w/room/ai");
});

test("assigning a stable project id preserves the selected pane", async () => {
  const b = browser();
  const newProject = { name: "new-project" };
  b.context.STATE.projects.push(newProject);
  b.context.rememberPane("project", "new-project", "deploy");
  b.context.agentApi = async () => ({ ok: true, json: async () => ({ id: "prj_new" }) });
  await b.context.assignProjectId(newProject);
  assert.equal(b.context.projectHash("prj_new"), "#/p/prj_new/deploy");
});

test("#/agents opens the Agents page on an agent; #/executor is the executor there; any other route closes it", () => {
  const b = browser();
  b.context.WS = { kind: "project", name: null, id: null, pane: "logs" };
  b.context.location.hash = "#/agents";
  b.context.routeFromHash();
  b.context.location.hash = "#/agents/ai%3Atodo-app";
  b.context.routeFromHash();
  b.context.location.hash = "#/executor?project=prj_todo";
  b.context.routeFromHash();
  assert.deepEqual([...b.context.agentsPage], ["executor", "ai:todo-app", "executor?prj_todo"]);

  b.context.location.hash = "#/p/prj_todo/plan";
  b.context.routeFromHash();
  assert.equal(b.context.agentsPage.at(-1), "closed", "opening a project leaves the Agents page");
  assert.equal(b.context.WS.name, "todo-app");

  b.context.location.hash = "#/agents/executor";
  b.context.routeFromHash();
  b.context.location.hash = "#/";
  b.context.routeFromHash();
  assert.equal(b.context.agentsPage.at(-1), "closed", "home closes it too");
});

test("#/models opens the Models page on a view with its compare selection; any other route closes it", () => {
  const b = browser();
  b.context.WS = { kind: "project", name: null, id: null, pane: "logs" };
  b.context.location.hash = "#/models";
  b.context.routeFromHash();
  b.context.location.hash = "#/models/compare?m=claude%3Aclaude-opus-5-5%2Cgguf%3Aqwen3-1.7b-q8_0&c=reasoning";
  b.context.routeFromHash();
  assert.deepEqual([...b.context.modelsPage], ["models", "compare?m=claude%3Aclaude-opus-5-5%2Cgguf%3Aqwen3-1.7b-q8_0&c=reasoning"]);
  b.context.location.hash = "#/agents";
  b.context.routeFromHash();
  assert.equal(b.context.modelsPage.at(-1), "closed", "the Agents page replaces it");
  b.context.location.hash = "#/models/benchmarks";
  b.context.routeFromHash();
  assert.equal(b.context.agentsPage.at(-1), "closed", "and it replaces the Agents page");
  b.context.location.hash = "#/";
  b.context.routeFromHash();
  assert.equal(b.context.modelsPage.at(-1), "closed", "home closes it");
});
