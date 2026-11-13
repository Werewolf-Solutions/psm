import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { classify, concurrentParts, delegation, detectRunbook, headerSummary, mergeRunbook, projectRunbook, readmeScripts, validateCurated, writeCurated } from "./runbook.ts";

function fixture(files: Record<string, string | object>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-runbook-"));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  }
  return root;
}

/** Shaped like werewolf-dapp: root delegates to server/ and client/, `dev` runs both. */
const dapp = () => fixture({
  "package.json": { scripts: {
    dev: 'concurrently "npm run server" "npm run client"',
    server: "cd server && npm run dev",
    client: "cd client && npm run dev",
    start: "cd server && npm start",
    "website-agent": "cd server && npm run website-agent",
    "dev-install": 'concurrently "cd client && npm install" "cd server && npm install"',
    "test:all": 'concurrently "cd server && npm test" "cd client && npm test"',
    "start:prod": "cd server && NODE_ENV=production npm start",
    mcp: "node mcp/werewolf-mcp.mjs",
  } },
  "README.md": "# dapp\n\n## Scripts\n\n- `npm run client` - Run only the frontend\n- `npm run server` - Run only the backend\n",
  "server/package.json": { scripts: {
    start: "node ./bin/www",
    dev: "nodemon ./bin/www",
    worker: "node ./bin/worker",
    "website-agent": "node scripts/website-agent.js run",
    "website-agent:create": "node scripts/website-agent.js create",
    "bootstrap:todo": "node scripts/bootstrap-todo.js",
    "rotate:psm-backup-kek": "node scripts/rotate.js",
    test: "node --test test/*.test.js",
  } },
  "server/bin/www": "#!/usr/bin/env node\n/**\n * Module dependencies.\n */\nvar port = normalizePort(process.env.PORT || \"3001\");\n",
  "server/bin/worker": "#!/usr/bin/env node\n\n/**\n * Standalone worker process. Used when the deploy splits web and worker.\n */\n",
  "server/scripts/website-agent.js": "#!/usr/bin/env node\n/**\n * Local website agent — builds website drafts from owner briefs. See todo.md for the spec.\n */\nconst { Anthropic } = require('@anthropic-ai/sdk');\n",
  "server/.env": "MONGODB_URI=mongodb://user:secret@localhost/db\nPORT=3000\n",
  "server/.env.example": "MONGODB_URI=\nREDIS_URL=\n# WEBSITE_AGENT=local\n",
  "client/package.json": { scripts: { dev: "vite", build: "tsc -b && vite build", preview: "vite preview", test: "vitest run" } },
  "client/vite.config.ts": "export default { server: { port: 5173, proxy: { '/api': { target: 'http://localhost:3000' } } } }",
  "client/node_modules/x/package.json": { scripts: { dev: "never read" } },
});

test("follows root delegation to nested packages and records the aliases", () => {
  const rb = detectRunbook(dapp());
  const ids = rb.units.map((unit) => unit.id);
  assert.ok(ids.includes("server/dev") && ids.includes("client/dev"));
  assert.ok(!ids.includes("server") && !ids.includes("client"), "pure delegations are aliases, not units");
  assert.ok(!ids.some((id) => id.includes("node_modules")));
  const server = rb.units.find((unit) => unit.id === "server/dev")!;
  assert.deepEqual(server.aliases, ["npm run server"]);
  assert.equal(server.summary, "Run only the backend", "the root README documents the alias");
  assert.equal(server.sources.summary, "readme");
  assert.equal(rb.units.find((unit) => unit.id === "server/start")!.aliases[0], "npm start");
  assert.ok(ids.includes("start:prod"), "a delegation with extra env is its own unit");
});

test("concurrently scripts become composites; the root dev composite is the default run", () => {
  const rb = detectRunbook(dapp());
  const dev = rb.composites.find((composite) => composite.id === "dev")!;
  assert.deepEqual(dev.units, ["server/dev", "client/dev"]);
  assert.deepEqual(rb.defaultUnits, ["server/dev", "client/dev"]);
  assert.deepEqual(rb.composites.find((composite) => composite.id === "test:all")!.units, ["server/test", "client/test"]);
  const install = rb.composites.find((composite) => composite.id === "dev-install")!;
  assert.equal(install.units.length, 0);
  assert.equal(install.unresolved.length, 2);
});

test("kinds, ports, env names and costs", () => {
  const rb = detectRunbook(dapp());
  const unit = (id: string) => rb.units.find((entry) => entry.id === id)!;
  assert.equal(unit("server/dev").kind, "service");
  assert.equal(unit("server/dev").port, 3000, ".env PORT wins over the entry file's default");
  assert.equal(unit("client/dev").port, 5173);
  assert.equal(unit("client/preview").port, 4173);
  assert.equal(unit("server/worker").kind, "agent");
  assert.equal(unit("server/worker").port, null, "an agent does not inherit the server's PORT");
  assert.equal(unit("server/website-agent").kind, "agent");
  assert.equal(unit("server/website-agent").costs, true);
  assert.equal(unit("server/website-agent:create").kind, "data");
  assert.equal(unit("server/bootstrap:todo").kind, "data");
  assert.equal(unit("server/rotate:psm-backup-kek").kind, "data");
  assert.equal(unit("start:prod").kind, "deploy");
  assert.equal(unit("mcp").kind, "mcp");
  assert.equal(unit("server/test").kind, "task");
  assert.deepEqual(unit("server/dev").env, ["MONGODB_URI", "REDIS_URL", "WEBSITE_AGENT"], "names from .env.example only");
  assert.ok(!JSON.stringify(rb).includes("secret"), "no .env value other than PORT is read into the runbook");
});

test("summaries come from script headers, skipping boilerplate; a client depends on the server it proxies to", () => {
  const rb = detectRunbook(dapp());
  const unit = (id: string) => rb.units.find((entry) => entry.id === id)!;
  assert.equal(unit("server/worker").summary, "Standalone worker process. Used when the deploy splits web and worker.");
  assert.equal(unit("server/website-agent").summary, "Local website agent — builds website drafts from owner briefs. See todo.md for the spec.");
  assert.equal(unit("server/start").sources.summary, undefined, "\"Module dependencies.\" is not a summary");
  assert.match(unit("server/start").summary!, /Long-running server on :3000/);
  assert.ok(unit("client/dev").dependsOn.some((ref) => ref.unit === "server/dev" || ref.unit === "server/start"));
  assert.deepEqual(rb.proxies, [{ unit: "client/dev", port: 3000 }]);
});

test("curated text in .psm/runbook.json wins field by field, and stale entries are reported", () => {
  const root = dapp();
  writeCurated(root, validateCurated({
    units: {
      "server/website-agent": { summary: "Builds drafts locally.", whenToUse: "Testing the website flow.", costs: true },
      "gone/script": { summary: "x" },
    },
    defaultUnits: ["server/dev"],
  }));
  const rb = projectRunbook(root);
  const agent = rb.units.find((unit) => unit.id === "server/website-agent")!;
  assert.equal(agent.summary, "Builds drafts locally.");
  assert.equal(agent.sources.summary, "curated");
  assert.equal(agent.whenToUse, "Testing the website flow.");
  assert.equal(agent.kind, "agent", "fields it does not set stay detected");
  assert.deepEqual(rb.defaultUnits, ["server/dev"]);
  assert.ok(rb.curated);
  assert.ok(rb.warnings.some((warning) => warning.includes("gone/script")));
  assert.deepEqual(mergeRunbook(detectRunbook(root), null).defaultUnits, ["server/dev", "client/dev"]);
});

test("validateCurated refuses bad shapes", () => {
  assert.throws(() => validateCurated({ units: { "a::b": {} } }), /Invalid unit id/);
  assert.throws(() => validateCurated({ units: { dev: { kind: "root" } } }), /kind must be/);
  assert.throws(() => validateCurated({ units: { dev: { port: 70000 } } }), /port/);
  assert.throws(() => validateCurated({ units: { dev: { dependsOn: [{ unit: "" }] } } }), /invalid unit/);
  assert.deepEqual(validateCurated({ units: { dev: { dependsOn: ["server/dev", { project: "werewolf-dapp", unit: "server/dev" }] } } }).units.dev.dependsOn,
    [{ unit: "server/dev" }, { project: "werewolf-dapp", unit: "server/dev" }]);
});

test("small parsers", () => {
  assert.deepEqual(delegation("cd server && npm run dev"), { folder: "server", script: "dev" });
  assert.deepEqual(delegation("cd ./client/ && npm test"), { folder: "client", script: "test" });
  assert.equal(delegation("cd server && NODE_ENV=production npm start"), null);
  assert.equal(delegation("cd ../other && npm run dev"), null, "never outside the project");
  assert.deepEqual(concurrentParts(`concurrently -k "npm run a" 'npm run b'`), ["npm run a", "npm run b"]);
  assert.equal(classify("next-week:dry", "node bin/write-next-week.js --dry-run"), "task");
  assert.equal(classify("cluster", "node lib/cluster.js --run"), "agent");
  assert.equal(classify("serve", "http-server ."), "service");
  assert.equal(headerSummary("/**\n * Module dependencies.\n */"), null);
  assert.deepEqual([...readmeScripts("- `npm start` — Run the API\n* `yarn build`: Build it")], [["start", "Run the API"], ["build", "Build it"]]);
});
