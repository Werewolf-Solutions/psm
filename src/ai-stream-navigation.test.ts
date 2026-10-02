import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");

test("late AI stream events cannot change another project's provider or question", () => {
  const streams: Array<{ handlers: Record<string, (event: { data: string }) => void>; close(): void; addEventListener(type: string, handler: (event: { data: string }) => void): void }> = [];
  const context = vm.createContext({
    URLSearchParams,
    WS: { kind: "project", id: null, name: "todo", engine: "claude", model: "opus", effort: "medium", aiEs: null, question: null, pane: "ai", pending: [] },
    aiBase: (name: string) => `/api/projects/${name}`,
    conversationKey: () => context.WS.name,
    agentStream: () => {
      const stream = {
        handlers: {} as Record<string, (event: { data: string }) => void>,
        close() {},
        addEventListener(type: string, handler: (event: { data: string }) => void) { this.handlers[type] = handler; },
      };
      streams.push(stream);
      return stream;
    },
    $: () => ({ innerHTML: "", textContent: "" }),
    appendAiEvent() {}, syncAiControls() {}, usageSelectionChanged() {}, renderSessionPane() {},
    openQuestion() {}, clearQuestion() {}, setAiBusy() {}, setRecap() {}, setAiLimit() {},
    refreshComposer() {}, renderWorkingButton() {}, fetchSessions() {},
  });
  vm.runInContext(source.slice(source.indexOf("function connectAi(name)"), source.indexOf("/*\n * \"Where we left off\"")), context);
  context.connectAi("todo");
  const todoStream = streams[0];
  context.WS.name = "another-project";
  context.WS.engine = "codex";
  context.WS.model = "gpt-6";
  context.WS.aiEs = null;
  todoStream.handlers.status({ data: JSON.stringify({ engine: "claude", model: "opus", effort: "medium", question: { id: "old" } }) });
  todoStream.handlers.question({ data: JSON.stringify({ id: "old" }) });
  assert.equal(context.WS.engine, "codex");
  assert.equal(context.WS.model, "gpt-6");
  assert.equal(context.WS.question, null);

  context.connectAi("another-project");
  todoStream.handlers.status({ data: JSON.stringify({ engine: "claude", model: "opus" }) });
  assert.equal(context.WS.engine, "codex", "a replaced stream cannot update the new project either");
});
