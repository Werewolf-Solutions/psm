import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

// Exercise the real route registration without starting the server's background
// services or a provider. The resolver supplies the conversation's live scope.
function routes() {
  const handlers = new Map<string, any>();
  const discoveries: { engine: string; path: string }[] = [];
  const context = vm.createContext({
    local: {
      get: (path: string, handler: any) => handlers.set(path, handler),
      post() {},
    },
    parseEngine: (value: string, fallback: string) => value || fallback,
    modelCatalog: async (engine: string, path: string) => {
      discoveries.push({ engine, path });
      return { engine, models: [{ id: `${engine}-model` }] };
    },
  });
  const source = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const errors = source.slice(source.indexOf("class AiTargetError"), source.indexOf("function projectConversation"));
  const mount = source.slice(source.indexOf("function mountAiRoutes("), source.indexOf('\nmountAiRoutes("'));
  vm.runInContext(ts.transpileModule(errors + mount, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, context);
  return { handlers, discoveries, context, run: (code: string) => vm.runInContext(code, context) };
}

function response() {
  return {
    code: 200, body: null as any, headers: {} as Record<string, string>,
    status(code: number) { this.code = code; return this; },
    json(body: any) { this.body = body; },
    setHeader(name: string, value: string) { this.headers[name] = value; },
  };
}

for (const base of ["/api/projects/:name", "/api/work-sessions/:id"]) {
  test(`${base} model discovery uses the chosen provider and resolved checkout`, async () => {
    const r = routes();
    r.context.base = base;
    r.run('mountAiRoutes(base, () => ({ engine: "claude", path: "/workspace/primary" }))');
    const handler = r.handlers.get(`${base}/ai/models`);
    assert.ok(handler, "every conversation needs a model discovery endpoint");
    for (const engine of ["codex", "claude"]) {
      const res = response();
      await handler({ query: { engine } }, res);
      assert.equal(res.code, 200);
      assert.equal(res.body.engine, engine);
      assert.equal(res.body.models[0].id, `${engine}-model`);
      assert.equal(res.headers["Cache-Control"], "no-store");
    }
    assert.deepEqual(r.discoveries, [
      { engine: "codex", path: "/workspace/primary" },
      { engine: "claude", path: "/workspace/primary" },
    ]);
  });
}

test("unresolved workroom scope prevents provider discovery", async () => {
  const r = routes();
  r.run('mountAiRoutes("/api/work-sessions/:id", () => { throw new AiTargetError("member missing", 409); })');
  const res = response();
  await r.handlers.get("/api/work-sessions/:id/ai/models")({ query: { engine: "codex" } }, res);
  assert.equal(res.code, 409);
  assert.equal(res.body.error, "member missing");
  assert.deepEqual(r.discoveries, []);
});
