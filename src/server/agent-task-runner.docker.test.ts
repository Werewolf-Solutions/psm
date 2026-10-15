/** Real sandbox runs. Opt in with PSM_RUNNER_DOCKER=1 (needs node:22-bookworm-slim and psm-task-browser:1.64.0). */
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
    exec: "node exec.js",
    net: "node -e \"fetch('https://example.com').then(()=>console.log('net=yes'),()=>console.log('net=no'))\"",
  } }));
  fs.writeFileSync(path.join(directory, "server.js"), "require('http').createServer((q,r)=>{ if(q.url==='/') { r.setHeader('content-type','text/html'); r.end('<h1>Todo</h1>'); } else { r.statusCode=404; r.end('missing'); } }).listen(process.env.PORT, '127.0.0.1');\n");
  fs.writeFileSync(path.join(directory, "exec.js"), "const fs=require('fs'),cp=require('child_process');fs.writeFileSync('/workspace/bin-check', '#!/bin/sh\\necho executable-ok\\n', {mode:0o755});console.log(cp.execFileSync('/workspace/bin-check', {encoding:'utf8'}));");
  const store = new AgentPermissionStore(() => database);
  const project = { id: "prj_sandbox", name: "sandbox", path: directory };
  store.changeMany(project, ["repo.read", "script.run"], true, 0, "operator");
  const repository = new RepositoryTools(store.snapshot(project), store);
  const runner = new ManagedTaskRunner(repository, store, new AbortController().signal);
  t.after(() => runner.close());
  assert.match(await runner.script("build"), /built ok/);
  assert.ok(!fs.existsSync(path.join(directory, "dist.txt")), "build output never reaches the checkout");
  assert.match(await runner.script("exec"), /executable-ok/, "installed npm executables must be runnable in the workspace");
  assert.match(await runner.script("net"), /net=no/, "no network in the sandbox");
  const output = await runner.preview("serve", 4173, ["/"]);
  const preview = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
  assert.equal(preview.listening, true);
  assert.deepEqual(preview.results.map((result: any) => [result.path, result.status]), [["/", 200]]);
  assert.match(preview.results[0].body, /Todo/);
  assert.equal(preview.verified, true);
  await assert.rejects(runner.preview("serve", 4173, ["/nope"]), /HTTP 404|Page navigation failed/);
});


test("browser checks reject runtime errors, module syntax failures, overlays and blank apps", { skip: process.env.PSM_RUNNER_DOCKER !== "1" && "set PSM_RUNNER_DOCKER=1" }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "psm-browser-errors-"));
  const database = openDatabase(":memory:");
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ scripts: { dev: "node server.js" }, dependencies: { react: "19" } }));
  fs.writeFileSync(path.join(directory, "server.js"), `
    const pages = {
      '/runtime': '<div id="root">Hello</div><script>throw new Error("broken React component")</script>',
      '/syntax': '<div id="root">Hello</div><script type="module">const broken = ;</script>',
      '/overlay': '<div id="root">Hello</div><vite-error-overlay>Unterminated template</vite-error-overlay>',
      '/blank': '<div id="root"></div>',
      '/': '<div id="root">Working app</div>'
    };
    require('http').createServer((q,r) => { r.setHeader('content-type', 'text/html'); r.end(pages[q.url] || pages['/']); }).listen(process.env.PORT, '127.0.0.1');
  `);
  const store = new AgentPermissionStore(() => database);
  const project = { id: "prj_browser", name: "browser", path: directory };
  store.changeMany(project, ["repo.read", "script.run"], true, 0, "operator");
  const repository = new RepositoryTools(store.snapshot(project), store);
  const runner = new ManagedTaskRunner(repository, store, new AbortController().signal);
  t.after(() => runner.close());
  for (const [route, message] of [
    ["/runtime", /broken React component/], ["/syntax", /Unexpected token/],
    ["/overlay", /Unterminated template/], ["/blank", /no visible content/]
  ] as const) await assert.rejects(runner.preview("dev", 4173, [route]), message);
  assert.equal(repository.verificationStatus().verified, false);
  assert.match(await runner.preview("dev", 4173, ["/"]), /"verified": true/);
  assert.equal(repository.verificationStatus().verified, true);
  await assert.rejects(runner.preview("dev", 4173, ["/runtime"]), /broken React component/);
  assert.equal(repository.verificationStatus().verified, false);
});

test("a declared preview fixture answers the app's own API call and nothing else", { skip: process.env.PSM_RUNNER_DOCKER !== "1" && "set PSM_RUNNER_DOCKER=1" }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "psm-browser-fixtures-"));
  const database = openDatabase(":memory:");
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ scripts: { dev: "node server.js" }, dependencies: { react: "19" } }));
  fs.writeFileSync(path.join(directory, "server.js"), `
    const page = '<div id="root">loading</div><script>fetch("/api/session", { method: "POST" }).then(r => { document.getElementById("root").textContent = r.status === 401 ? "signed out" : "status " + r.status; })</script>';
    require('http').createServer((q,r) => {
      if (q.url.startsWith('/api/')) { r.statusCode = 502; return r.end('no backend'); }
      r.setHeader('content-type', 'text/html'); r.end(page);
    }).listen(process.env.PORT, '127.0.0.1');
  `);
  const store = new AgentPermissionStore(() => database);
  const project = { id: "prj_fixtures", name: "fixtures", path: directory };
  store.changeMany(project, ["repo.read", "script.run"], true, 0, "operator");
  const repository = new RepositoryTools(store.snapshot(project), store);
  const runner = new ManagedTaskRunner(repository, store, new AbortController().signal);
  t.after(() => runner.close());
  await assert.rejects(runner.preview("dev", 4173, ["/home"]), /HTTP 502/);
  const fixture = (responses: unknown) => fs.writeFileSync(path.join(directory, "psm-preview.json"), JSON.stringify({ schema: "psm.werewolf.solutions/preview-fixtures/v1", responses }));
  fixture([{ method: "GET", path: "/api/session", status: 401 }]);
  await assert.rejects(runner.preview("dev", 4173, ["/home"]), /HTTP 502/, "another method is not answered");
  fixture([{ method: "POST", path: "/api/session", status: 401, json: { error: "signed out" } }, { path: "/home", status: 200, text: "replaced page" }]);
  const output = await runner.preview("dev", 4173, ["/home"]);
  const report = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
  assert.equal(report.verified, true);
  assert.equal(report.results[0].body, "signed out", "the real page ran; the document fixture was not used");
  assert.deepEqual(report.results[0].fixtures, ["POST /api/session -> 401"]);
  assert.equal(repository.verificationStatus().verified, true);
  fixture([{ method: "POST", path: "/api/session", status: 200 }]);
  assert.equal(repository.verificationStatus().verified, false, "editing the fixture makes the earlier pass stale");
  fs.writeFileSync(path.join(directory, "psm-preview.json"), "{");
  await assert.rejects(runner.preview("dev", 4173, ["/home"]), /psm-preview\.json is invalid/);
});

test("a declared backend service answers the app for real, on a network with no way out", { skip: process.env.PSM_RUNNER_DOCKER !== "1" && "set PSM_RUNNER_DOCKER=1" }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-browser-services-"));
  const database = openDatabase(":memory:");
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const app = path.join(root, "app"); const api = path.join(root, "api");
  fs.mkdirSync(app); fs.mkdirSync(path.join(api, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ scripts: { dev: "node server.js" }, dependencies: { react: "19" } }));
  // The app proxies /api the way Vite does, to the target the declaration hands it.
  fs.writeFileSync(path.join(app, "server.js"), `
    const http = require('http');
    const page = '<div id="root">loading</div><script>fetch("/api/session", { method: "POST" }).then(r => r.json()).then(j => { document.getElementById("root").textContent = j.answer; })</script>';
    http.createServer((q, r) => {
      if (!q.url.startsWith('/api/')) { r.setHeader('content-type', 'text/html'); return r.end(page); }
      const upstream = http.request(process.env.API_TARGET + q.url, { method: q.method }, u => { r.writeHead(u.statusCode, u.headers); u.pipe(r); });
      upstream.on('error', () => { r.statusCode = 502; r.end('{}'); }); q.pipe(upstream);
    }).listen(process.env.PORT, '127.0.0.1');
  `);
  fs.writeFileSync(path.join(api, "package.json"), JSON.stringify({ scripts: { serve: "node index.js" } }));
  fs.writeFileSync(path.join(api, "seed.js"), "require('fs').writeFileSync('seeded', 'yes');");
  fs.writeFileSync(path.join(api, ".env"), "SECRET=real-secret");
  fs.writeFileSync(path.join(api, "index.js"), `
    const fs = require('fs');
    let egress = 'unknown';
    fetch('https://example.com', { signal: AbortSignal.timeout(3000) }).then(() => egress = 'open', () => egress = 'blocked');
    require('http').createServer((q, r) => {
      if (q.url === '/ready') return r.end('ok');
      r.statusCode = 401; r.setHeader('content-type', 'application/json');
      r.end(JSON.stringify({ answer: [fs.existsSync('seeded') ? 'seeded' : 'unseeded', fs.existsSync('.env') ? 'env-copied' : 'no-env', process.env.TOKEN?.length === 64 ? 'secret' : 'no-secret', process.env.REDIS_URL, 'egress=' + egress].join(' ') }));
    }).listen(process.env.PORT);
  `);
  const store = new AgentPermissionStore(() => database);
  const appProject = { id: "prj_app", name: "app", path: app }; const apiProject = { id: "prj_api", name: "api", path: api };
  store.changeMany(appProject, ["repo.read", "script.run"], true, 0, "operator");
  store.changeMany(apiProject, ["repo.read", "script.run"], true, 0, "operator");
  fs.writeFileSync(path.join(app, "psm-preview.json"), JSON.stringify({
    schema: "psm.werewolf.solutions/preview/v2", host: "localhost", env: { API_TARGET: "http://api:4100" },
    services: [{ project: "api", script: "serve", port: 4100, ready: "/ready", secrets: ["TOKEN"], stores: ["redis"], seed: ["seed.js"] }],
    expected: [{ method: "POST", path: "/api/session", status: 401 }],
  }));
  const apiRepo = new RepositoryTools(store.snapshot(apiProject), store);
  const repository = new RepositoryTools(store.snapshot(appProject), store);
  const runner = new ManagedTaskRunner(repository, store, new AbortController().signal, undefined, undefined, name => name === "api" ? apiRepo : undefined);
  t.after(() => runner.close());
  const output = await runner.preview("dev", 5200, ["/"]);
  const report = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
  assert.equal(report.verified, true);
  assert.equal(report.services[0].ready, true);
  assert.equal(report.results[0].body, "seeded no-env secret redis://redis:6379 egress=blocked");
  assert.deepEqual(report.results[0].fixtures, ["expected POST /api/session -> 401"]);
  const { execFileSync } = await import("node:child_process");
  assert.doesNotMatch(execFileSync("docker", ["ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8" }), /psm-task-/, "no task containers remain");
  assert.doesNotMatch(execFileSync("docker", ["network", "ls", "--format", "{{.Name}}"], { encoding: "utf8" }), /psm-task-/, "no task networks remain");
});
