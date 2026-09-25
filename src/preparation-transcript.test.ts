import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Exercise the actual browser renderer with a small DOM surface. No server or
// provider session is needed to check the persisted/replayed event contract.
class Element {
  children: Element[] = [];
  textContent = "";
  scrollHeight = 0;
  scrollTop = 0;
  clientHeight = 0;
  classList = { add: () => {} };
  constructor(readonly tag: string, readonly className = "") {}
  append(...children: Element[]) { this.children.push(...children); }
}

function renderer() {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const transcript = new Element("div");
  const context = vm.createContext({
    $: () => transcript,
    el: (tag: string, cls: string) => new Element(tag, cls),
    renderAiText: (node: Element, text: string) => { node.textContent = text; return false; },
  });
  vm.runInContext(source.slice(source.indexOf("function preparationEntryLabel("), source.indexOf("function appendAiEvent(")), context);
  return (event: unknown): Element => context.renderAiBubble(event);
}

test("preparation turns replay as expandable attempt entries with their full brief intact", () => {
  const render = renderer();
  const event = { role: "user", text: "Full repair instructions <script>unsafe()</script>", preparation: {
    jobId: "prep-1", environmentId: "staging", purpose: "repair", attempt: 2, maximumAttempts: 3,
  } };
  const node = render(JSON.parse(JSON.stringify(event)));
  assert.equal(node.tag, "details");
  assert.equal(node.children[0].tag, "summary");
  assert.equal(node.children[0].textContent, "PSM · staging · Repair attempt 2 of 3");
  assert.equal(node.children[1].textContent, event.text, "the brief remains inspectable as text");
  const first = render({ ...event, preparation: { ...event.preparation, attempt: 1 } });
  assert.match(first.children[0].textContent, /Preparation started/);
  const external = render({ ...event, preparation: { ...event.preparation, purpose: "diagnose-external" } });
  assert.match(external.children[0].textContent, /External checks/);
  assert.doesNotMatch(external.children[0].textContent, /attempt/);
});

test("legacy preparation briefs collapse without hiding ordinary user or assistant messages", () => {
  const render = renderer();
  const brief = 'psm is preparing this project for deployment to "staging" and these readiness checks are not passing.\nThis is attempt 3 of 3. Read what this room already tried before repeating it.';
  const node = render({ role: "user", text: brief });
  assert.equal(node.tag, "details");
  assert.match(node.children[0].textContent, /Repair attempt 3 of 3/);
  assert.equal(node.children[1].textContent, brief);
  for (const role of ["user", "assistant"]) {
    const ordinary = render({ role, text: "Please fix this build" });
    assert.equal(ordinary.tag, "div");
    assert.equal(ordinary.textContent, "Please fix this build");
  }
  assert.equal(render({ role: "assistant", text: brief }).tag, "div");
});
