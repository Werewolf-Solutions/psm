/** Real sandbox runs. Opt in with PSM_RUNNER_DOCKER=1 (needs node:22-bookworm-slim). */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentPermissionStore } from "./agent-permissions.ts";
import { RepositoryTools } from "./agent-repository-tools.ts";
import { ManagedTaskRunner } from "./agent-task-runner.ts";
import { openDatabase } from "./db.ts";

test("scripts and previews run in the real offline sandbox", { skip: process.env.PSM_RUNNER_DOCKER !== "1" && "set PSM_RUNNER_DOCKER=1" }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "psm-sandbox-"));
  const database = openDatabase(":memory:");
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ scripts: {
    build: "node -e \"require('fs').writeFileSync('dist.txt','built'); console.log('built ok')\"",
    serve: "node server.js",
    net: "node -e \"fetch('https://example.com').then(()=>console.log('net=yes'),()=>console.log('net=no'))\"",
  } }));
  fs.writeFileSync(path.join(directory, "server.js"), "require('http').createServer((q,r)=>{ if(q.url==='/') { r.setHeader('content-type','text/html'); r.end('<h1>Todo</h1>'); } else { r.statusCode=404; r.end('missing'); } }).listen(process.env.PORT, '127.0.0.1');\n");
  const store = new AgentPermissionStore(() => database);
  const project = { id: "prj_sandbox", name: "sandbox", path: directory };
  store.changeMany(project, ["repo.read", "script.run"], true, 0, "operator");
  const runner = new ManagedTaskRunner(new RepositoryTools(store.snapshot(project), store), store, new AbortController().signal);
  t.after(() => runner.close());
  assert.match(await runner.script("build"), /built ok/);
  assert.ok(!fs.existsSync(path.join(directory, "dist.txt")), "build output never reaches the checkout");
  assert.match(await runner.script("net"), /net=no/, "no network in the sandbox");
  const output = await runner.preview("serve", 4173, ["/", "/nope"]);
  const preview = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
  assert.equal(preview.listening, true);
  assert.deepEqual(preview.results.map((result: any) => [result.path, result.status]), [["/", 200], ["/nope", 404]]);
  assert.match(preview.results[0].body, /<h1>Todo<\/h1>/);
});
