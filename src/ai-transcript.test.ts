import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

class Element {
  children: Element[] = [];
  parent: Element | null = null;
  textContent = "";
  scrollHeight = 0;
  scrollTop = 0;
  clientHeight = 0;
  aiConversation = false;
  classList: { add: (name: string) => void };
  constructor(readonly tag: string, readonly className = "") {
    this.classList = { add: () => {} };
  }
  append(...nodes: Element[]) {
    for (const node of nodes) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      node.parent = this;
      this.children.push(node);
    }
  }
  prepend(node: Element) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = this;
    this.children.unshift(node);
  }
  set innerHTML(value: string) {
    assert.equal(value, "");
    this.children = [];
  }
}

function transcriptRenderer() {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const transcript = new Element("div");
  const context = vm.createContext({
    WS: { pending: [], aiBusy: false, aiToolGroup: null, aiOlder: null },
    $: () => transcript,
    el: (tag: string, cls: string) => new Element(tag, cls),
    eventTimeNode: () => new Element("time", "ai-time"),
    renderAiText: (node: Element, value: string) => { node.textContent = value; return false; },
    scheduleSessionRefresh: () => {},
    setAiActivity: () => {},
  });
  vm.runInContext(source.slice(source.indexOf("function preparationEntryLabel("), source.indexOf("function setAiBusy(")), context);
  return { transcript, context };
}

test("tool calls collapse together while the current call stays visible", () => {
  const { transcript, context } = transcriptRenderer();
  context.appendAiEvent({ role: "user", text: "Inspect the project" });
  context.appendAiEvent({ role: "system", text: "● session abc · model" });
  context.appendAiEvent({ role: "system", text: "→ psm_files(project)" });
  context.appendAiEvent({ role: "system", text: "→ psm_read(notes.txt)" });
  assert.equal(transcript.children.length, 2);
  const group = transcript.children[1] as Element & { aiSummary: Element; aiList: Element };
  assert.equal(group.tag, "details");
  assert.equal(group.aiSummary.textContent, "Using psm_read(notes.txt)");
  assert.equal(group.aiList.children.length, 3);
  context.appendAiEvent({ role: "assistant", text: "The notes say hello." });
  assert.equal(group.aiSummary.textContent, "2 tool calls");
  assert.equal(transcript.children[2].textContent, "The notes say hello.");
});

test("earlier conversation is expandable while the latest twelve messages stay visible", () => {
  const { transcript, context } = transcriptRenderer();
  for (let index = 1; index <= 16; index++) {
    context.appendAiEvent({ role: "user", text: `message ${index}` });
    context.appendAiEvent({ role: "system", text: `→ psm_read(file-${index})` });
  }
  const older = transcript.children[0] as Element & { aiSummary: Element; aiList: Element; aiCount: number };
  assert.equal(older.tag, "details");
  assert.equal(older.aiSummary.textContent, "Earlier messages (4)");
  assert.equal(older.aiList.children.length, 8, "older messages keep their tool groups for inspection");
  assert.equal(transcript.children.filter((node) => node.aiConversation).length, 12);
  assert.equal(context.WS.aiToolGroup.aiSummary.textContent, "Using psm_read(file-16)");
});
