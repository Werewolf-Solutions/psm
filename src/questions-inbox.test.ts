import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

class Element {
  children: Element[] = [];
  textContent = "";
  hidden = true;
  isConnected = true;
  attributes: Record<string, string> = {};
  onclick?: () => void;
  constructor(readonly tag = "div") {}
  set innerHTML(_value: string) { this.children = []; }
  append(...children: Element[]) { this.children.push(...children); }
  querySelector() { return null; }
  focus() {}
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
}

const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
function browser() {
  const nodes = new Map<string, Element>();
  const node = (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, new Element());
    return nodes.get(selector)!;
  };
  const context = vm.createContext({
    $: node,
    el: (tag: string) => new Element(tag),
    document: { activeElement: new Element("button") },
    requestAnimationFrame: (callback: () => void) => callback(),
    formatDateTime: () => "today",
    compactText: (text: string) => text,
    WS: { kind: "work", id: "room-1", name: "A room title", question: null },
    refreshComposer() {}, renderWorkingButton() {}, fetchSessions() {},
    openModal: (selector: string) => { node(selector).hidden = false; },
  });
  vm.runInContext(source.slice(source.indexOf("let ACTIVE_QUESTION = null;"), source.indexOf("function collectQuestionAnswers(")), context);
  // The form controls have their own behavior; these tests cover the inbox and
  // whether user action (rather than SSE/reload) is required to open the form.
  context.renderQuestionField = () => new Element("fieldset");
  return { context, node };
}

function entry(project = "work:room-1", id = "question-1", scope = "ai", role: string | null = null) {
  return {
    project, scope, role, label: "A room title",
    request: { id, engine: "claude", askedAt: 1, questions: [{ id: "q", question: "Which option?", options: [] }] },
  };
}

test("pending questions survive reload without any automatic popup", () => {
  const questions = [entry(), entry("project-2", "question-2")];
  for (let reload = 0; reload < 2; reload++) {
    const b = browser();
    b.context.syncPendingQuestions([], questions);
    assert.equal(b.node("#questions-count").textContent, "2");
    assert.equal(b.node("#question-modal").hidden, true);
    b.context.openQuestions();
    assert.equal(b.node("#questions-list").children.length, 2);
    assert.equal(b.node("#question-modal").hidden, true);
    b.node("#questions-list").children[0].children[3].onclick!();
    assert.equal(b.node("#question-modal").hidden, false);
    b.context.closeQuestion();
    b.context.syncPendingQuestions([], questions);
    assert.equal(b.node("#question-modal").hidden, true, "closing and polling never reopens it");
    assert.equal(b.node("#questions-count").textContent, "2", "closing is not an answer");
  }
});

test("incoming SSE questions only update the list, and answering does not open the next one", () => {
  const b = browser();
  const first = entry();
  b.context.openQuestion(first.project, first.request, false, first.scope, first.role, first.label);
  b.context.openQuestion("project-2", entry("project-2", "second").request);
  assert.equal(b.node("#questions-count").textContent, "2");
  assert.equal(b.node("#question-modal").hidden, true);
  b.context.openQuestion(first.project, first.request, true);
  assert.equal(b.context.questionBase(vm.runInContext("ACTIVE_QUESTION.project", b.context)), "/api/work-sessions/room-1");
  b.context.clearQuestion(first.project, first.request.id);
  assert.equal(b.node("#question-modal").hidden, true);
  assert.equal(b.node("#questions-count").textContent, "1");
});

test("planner, reviewer, workspace and room questions remain separate", () => {
  const b = browser();
  b.context.syncPendingQuestions([], [entry("__workspace__"), entry(), entry("todo", "same-id", "planner", "planner"), entry("todo", "same-id", "planner", "reviewer")]);
  assert.equal(b.node("#questions-count").textContent, "4");
  b.context.clearQuestion("todo", "same-id", "planner", "planner");
  assert.equal(b.node("#questions-count").textContent, "3");
  assert.equal(b.context.questionBase("todo"), "/api/projects/todo");
  b.context.syncPendingQuestions([], []);
  assert.equal(b.node("#questions-count").hidden, true);
});

test("ordinary polling preserves an open question form and list controls", () => {
  const b = browser();
  const pending = entry();
  b.context.syncPendingQuestions([], [pending]);
  b.context.openQuestions();
  b.context.openQuestion(pending.project, pending.request, true, pending.scope, pending.role, pending.label);
  const form = b.node("#question-body").children[0];
  const row = b.node("#questions-list").children[0];
  b.context.syncPendingQuestions([], [pending]);
  assert.equal(b.node("#question-body").children[0], form);
  assert.equal(b.node("#questions-list").children[0], row);
  b.context.syncPendingQuestions([], []);
  assert.equal(b.node("#question-modal").hidden, true, "an answer in another tab clears the dialog");
});

test("newer question events win over an older in-flight session poll", async () => {
  const b = browser();
  let finish: (value: unknown) => void = () => {};
  b.context.agentApi = () => new Promise((resolve) => { finish = resolve; });
  b.context.STATE = {};
  b.context.renderBoard = () => {};
  b.context.renderQuickSwitch = () => {};
  vm.runInContext(source.slice(source.indexOf("let sessionsFetchSequence = 0;"), source.indexOf("/**", source.indexOf("let sessionsFetchSequence = 0;"))), b.context);
  const request = b.context.fetchSessions();
  const pending = entry();
  b.context.openQuestion(pending.project, pending.request);
  finish({ ok: true, json: async () => ({ sessions: [], questions: [] }) });
  await request;
  assert.equal(b.node("#questions-count").textContent, "1");
  assert.equal(b.node("#question-modal").hidden, true);
});
