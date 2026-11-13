import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

import { openDatabase } from "../db.ts";
import { procState, transcript } from "../procs.ts";
import { resourceRouter } from "./api.ts";
import { assemble, envReferences } from "./discover.ts";
import { ResourceStore } from "./store.ts";

const SECRET_URI = "mongodb://admin:hunter2-secret@localhost:27017/werewolf?authSource=admin";
const MONGO = "db:mongodb:localhost:27017";

/** A project shaped like werewolf-dapp: server/.env, server/scripts/<script>.js. */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-res-api-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = path.join(root, "server");
  fs.mkdirSync(path.join(server, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(server, "package.json"), "{}");
  fs.writeFileSync(path.join(server, ".env"), `MONGODB_URI=${SECRET_URI}\nJWT_SECRET=hunter2-secret\n`);
  fs.writeFileSync(path.join(server, "scripts", "migrate-owner.js"), [
    "/**",
    " * P14 B0: give every app an explicit owner.",
    " *   node scripts/migrate-owner.js --apply",
    " */",
    "const uri = process.env.MONGODB_URI;",
    "console.log(`inherited:${uri ? 'yes' : 'no'}`);",
    "console.log(process.argv.includes('--apply') ? 'APPLIED' : 'REPORT');",
  ].join("\n"));
  fs.writeFileSync(path.join(server, "scripts", "plain.js"), "console.log('no apply flag here')\n");
  fs.writeFileSync(path.join(server, "package-lock.json"), "{\"lockfileVersion\":3}\n");
  fs.writeFileSync(path.join(root, ".gitignore"), ".env\n");
  // Committed, as a real project's script is: Preview on a Read target runs committed code only (P02a.4).
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  return { root, server, git };
}

async function harness(t: test.TestContext, options: { local?: boolean } = {}) {
  const { root, server, git } = fixture(t);
  const database = openDatabase(":memory:");
  const store = new ResourceStore(() => database);
  const projects = () => [{ name: "dapp", path: root }];
  const app = express();
  app.use(express.json());
  app.use(resourceRouter({
    store,
    projects,
    localRequest: () => options.local ?? true,
    actor: () => "local:test",
    discover: () => assemble({
      sockets: [{ address: "127.0.0.1", port: 27017, pid: null }],
      table: new Map(),
      docker: { available: false, reason: "Docker is not installed.", containers: [] },
      env: envReferences(projects()),
      servers: [],
      folders: store.folders(),
    }),
  }));
  const listener = app.listen(0);
  t.after(() => { listener.close(); database.close(); });
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const call = async (method: string, url: string, body?: unknown) => {
    const response = await fetch(`${base}${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as any };
  };
  return { call, root, server, store, git };
}

async function finished(project: string, kind: string) {
  for (let i = 0; i < 100; i++) {
    const state = procState(project, kind as never);
    if (state.status !== "running") return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("script did not finish");
}

test("the resource list links the dev database to its project and leaks no credential", async (t) => {
  const { call } = await harness(t);
  const list = await call("GET", "/api/resources");
  assert.equal(list.status, 200);
  assert.ok(!list.text.includes("hunter2"), "a password reached the page");
  assert.ok(!list.text.includes("authSource"));
  const mongo = list.body.resources.find((row: any) => row.key === MONGO);
  assert.equal(mongo.level, null, "anything new starts unset");
  assert.equal(mongo.suggestion.level, "full");
  assert.deepEqual(mongo.usedBy.map((use: any) => `${use.project}/${use.directory}:${use.variable}`), ["dapp/server:MONGODB_URI"]);
  assert.equal(list.body.docker.available, false);
});

test("only --apply scripts are detected, with a resolved target and no credential", async (t) => {
  const { call } = await harness(t);
  const { body, text } = await call("GET", "/api/resources/scripts?project=dapp");
  assert.equal(body.scripts.length, 1);
  const [script] = body.scripts;
  assert.equal(script.path, "server/scripts/migrate-owner.js");
  assert.equal(script.title, "give every app an explicit owner.");
  assert.equal(script.target.key, MONGO);
  assert.equal(script.target.database, "werewolf");
  assert.deepEqual(script.allowed, { preview: false, apply: false, why: script.allowed.why });
  assert.ok(!text.includes("hunter2"));
});

test("levels gate the buttons on the server: none refuses, read previews, full applies after a clean preview", async (t) => {
  const { call } = await harness(t);
  const [script] = (await call("GET", "/api/resources/scripts?project=dapp")).body.scripts;
  const run = (mode: string) => call("POST", "/api/resources/scripts/run", { project: "dapp", id: script.id, mode });

  assert.equal((await run("preview")).status, 403, "unset is none");

  await call("PUT", "/api/resources/level", { key: MONGO, level: "read", revision: 0 });
  assert.equal((await run("apply")).status, 403, "read never applies");
  process.env.MONGODB_URI = "mongodb://somewhere-else:27017/wrong";
  t.after(() => { delete process.env.MONGODB_URI; });
  const preview = await run("preview");
  assert.equal(preview.status, 200);
  assert.equal(preview.body.command, "node scripts/migrate-owner.js");
  await finished("dapp", script.kind);
  const log = transcript("dapp", script.kind)!.text;
  assert.match(log, /REPORT/);
  assert.match(log, /inherited:no/, "an exported MONGODB_URI must not reach the script");

  assert.equal((await run("apply")).status, 403, "still read");
  await call("PUT", "/api/resources/level", { key: MONGO, level: "full", revision: 1 });
  const apply = await run("apply");
  assert.equal(apply.status, 200, JSON.stringify(apply.body));
  assert.equal(apply.body.command, "node scripts/migrate-owner.js --apply");
  await finished("dapp", script.kind);
  assert.match(transcript("dapp", script.kind)!.text, /APPLIED/);

  assert.equal((await run("apply")).status, 409, "each apply needs its own fresh preview");
});

test("apply re-resolves the target: an .env pointed elsewhere after the preview is refused", async (t) => {
  const { call, server } = await harness(t);
  const [script] = (await call("GET", "/api/resources/scripts?project=dapp")).body.scripts;
  await call("PUT", "/api/resources/level", { key: MONGO, level: "full", revision: 0 });
  assert.equal((await call("POST", "/api/resources/scripts/run", { project: "dapp", id: script.id, mode: "preview" })).status, 200);
  await finished("dapp", script.kind);
  fs.writeFileSync(path.join(server, ".env"), "MONGODB_URI=mongodb://u:p@prod.example.com:27017/werewolf\n");
  const apply = await call("POST", "/api/resources/scripts/run", { project: "dapp", id: script.id, mode: "apply" });
  assert.equal(apply.status, 403, "the remote database has no level, so it is none");
});

test("only detected scripts run: unknown ids, other projects and bad modes are refused", async (t) => {
  const { call } = await harness(t);
  await call("PUT", "/api/resources/level", { key: MONGO, level: "full", revision: 0 });
  assert.equal((await call("POST", "/api/resources/scripts/run", { project: "dapp", id: "../../etc/passwd", mode: "preview" })).status, 404);
  assert.equal((await call("POST", "/api/resources/scripts/run", { project: "nope", id: "abc", mode: "preview" })).status, 404);
  assert.equal((await call("POST", "/api/resources/scripts/run", { project: "dapp", id: "abc", mode: "rm -rf" })).status, 400);
});

test("changes need the local cockpit", async (t) => {
  const { call } = await harness(t, { local: false });
  assert.equal((await call("PUT", "/api/resources/level", { key: MONGO, level: "full", revision: 0 })).status, 403);
  assert.equal((await call("POST", "/api/resources/folders", { path: os.tmpdir() })).status, 403);
});

test("a folder is listed by name only until it is Read or Full", async (t) => {
  const { call, root } = await harness(t);
  const added = await call("POST", "/api/resources/folders", { path: root });
  assert.equal(added.status, 200);
  const unset = (await call("GET", "/api/resources")).body.resources.find((row: any) => row.kind === "folder");
  assert.equal(unset.summary, undefined, "no counting at None");
  await call("PUT", "/api/resources/level", { key: unset.key, level: "read", revision: unset.revision });
  const read = (await call("GET", "/api/resources")).body.resources.find((row: any) => row.kind === "folder");
  assert.equal(read.summary.items, fs.readdirSync(root).length, "server/, plus the fixture's .git and .gitignore");
});

test("P02a.4: Apply runs only what was previewed; an edited script or lockfile needs a new Preview", async (t) => {
  const { call, server } = await harness(t);
  const [script] = (await call("GET", "/api/resources/scripts?project=dapp")).body.scripts;
  const run = (mode: string) => call("POST", "/api/resources/scripts/run", { project: "dapp", id: script.id, mode });
  await call("PUT", "/api/resources/level", { key: MONGO, level: "full", revision: 0 });

  assert.equal((await run("preview")).status, 200);
  await finished("dapp", script.kind);
  const file = path.join(server, "scripts", "migrate-owner.js");
  fs.appendFileSync(file, "\nconsole.log('added after the preview');\n");
  const stale = await run("apply");
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "preview-stale");
  assert.equal((await run("apply")).body.code, "preview-required", "a stale preview is spent");

  assert.equal((await run("preview")).status, 200, "Full previews uncommitted code");
  await finished("dapp", script.kind);
  fs.writeFileSync(path.join(server, "package-lock.json"), "{\"lockfileVersion\":3,\"packages\":{\"evil\":{}}}\n");
  assert.equal((await run("apply")).body.code, "preview-stale", "a changed lockfile changes what runs");

  assert.equal((await run("preview")).status, 200);
  await finished("dapp", script.kind);
  assert.equal((await run("apply")).status, 200, "unchanged since the preview");
  await finished("dapp", script.kind);
});

test("P02a.4: on a Read database, Preview runs committed code only", async (t) => {
  const { call, server, git } = await harness(t);
  const list = async () => (await call("GET", "/api/resources/scripts?project=dapp")).body.scripts[0];
  const [script] = (await call("GET", "/api/resources/scripts?project=dapp")).body.scripts;
  const run = (mode: string) => call("POST", "/api/resources/scripts/run", { project: "dapp", id: script.id, mode });
  await call("PUT", "/api/resources/level", { key: MONGO, level: "read", revision: 0 });
  assert.equal((await list()).git, "committed");

  fs.appendFileSync(path.join(server, "scripts", "migrate-owner.js"), "\n// edited\n");
  const view = await list();
  assert.equal(view.git, "modified");
  assert.equal(view.allowed.preview, false, "the Data card says so before the click");
  assert.match(view.allowed.why, /committed code only; this script has uncommitted changes/);
  const refused = await run("preview");
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "uncommitted-script");

  git("commit", "-q", "-am", "reviewed");
  assert.equal((await run("preview")).status, 200, "once committed it previews");
  await finished("dapp", script.kind);
});
