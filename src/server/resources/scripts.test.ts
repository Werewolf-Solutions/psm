import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { redactCredentials } from "../procs.ts";
import { detectScripts, envNamesRead, resolveTarget, scriptCommand, scriptTitle } from "./scripts.ts";

/** werewolf-dapp's real shape: the script connects through config/database.js. */
const DATABASE_JS = `
module.exports = async () => {
  let url;
  if (process.env.NODE_ENV === 'production') {
    const MONGO_HOSTNAME = process.env.MONGO_HOSTNAME;
    const MONGO_PASSWORD = process.env.MONGO_PASSWORD;
    url = \`mongodb://\${process.env.MONGO_USERNAME}:\${MONGO_PASSWORD}@\${MONGO_HOSTNAME}/x\`;
  } else {
    url = process.env.MONGODB_URI || 'mongodb://localhost:27017/werewolf-solutions';
  }
};`;
const SCRIPT_JS = `/**\n * P14 B0: give every app an owner.\n *   node scripts/m.js --apply\n */\nrequire('dotenv').config();\nawait require('../config/database')();\n`;

function project(t: test.TestContext, env: string | null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-scripts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = path.join(root, "server");
  fs.mkdirSync(path.join(server, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(server, "config"));
  fs.writeFileSync(path.join(server, "package.json"), "{}");
  fs.writeFileSync(path.join(server, "config", "database.js"), DATABASE_JS);
  fs.writeFileSync(path.join(server, "scripts", "m.js"), SCRIPT_JS);
  if (env !== null) fs.writeFileSync(path.join(server, ".env"), env);
  fs.writeFileSync(path.join(server, "scripts", "m.test.js"), "// runs m.js --apply against a fixture\n");
  return detectScripts({ name: "dapp", path: root });
}

test("the target is followed through a required config file", (t) => {
  const scripts = project(t, "NODE_ENV=development\nMONGODB_URI=mongodb://u:hunter2@127.0.0.1:27017/werewolf\n");
  assert.deepEqual(scripts.map((entry) => entry.path), ["server/scripts/m.js"], "a .test.js file is not a script");
  const [script] = scripts;
  assert.equal(script.target?.key, "db:mongodb:localhost:27017");
  assert.equal(script.target?.database, "werewolf");
  assert.deepEqual(script.target?.variables, ["MONGODB_URI"]);
  assert.ok(script.unset.includes("MONGODB_URI") && script.unset.includes("MONGO_HOSTNAME") && script.unset.includes("NODE_ENV"));
  assert.ok(!JSON.stringify(script).includes("hunter2"));
});

test("a host set on its own in .env is refused: the connection may be built another way", (t) => {
  const [script] = project(t, "NODE_ENV=production\nMONGO_HOSTNAME=prod.example.com\nMONGODB_URI=mongodb://localhost:27017/werewolf\n");
  assert.equal(script.target, null);
  assert.match(script.reason!, /MONGO_HOSTNAME/);
});

test("with no variable set, the hard-coded fallback in the code is the target", (t) => {
  const [script] = project(t, "NODE_ENV=development\n");
  assert.equal(script.target?.key, "db:mongodb:localhost:27017");
  assert.equal(script.target?.database, "werewolf-solutions");
  assert.deepEqual(script.target?.variables, []);
});

test("no .env, no target", (t) => {
  const [script] = project(t, null);
  assert.equal(script.target, null);
});

test("two different databases are refused", () => {
  const { target } = resolveTarget(["process.env.A_URI; process.env.B_URI"], "A_URI=mongodb://localhost/a\nB_URI=mongodb://other.example/b\n");
  assert.equal(target, null);
});

test("env names are read in every common spelling", () => {
  assert.deepEqual([...envNamesRead("process.env.A; process.env['B']; const { C, D: d } = process.env;")].sort(), ["A", "B", "C", "D"]);
});

test("titles come from the first doc comment line, and commands only from the detected path", (t) => {
  assert.equal(scriptTitle("/**\n * P14 B0: give every app an owner.\n */", "x"), "give every app an owner.");
  assert.equal(scriptTitle("/**\n * Prepares a database for workspaces. Deliberate and\n * idempotent.\n *\n *   node x.js --apply\n */", "x"), "Prepares a database for workspaces.");
  assert.equal(scriptTitle("/**\n * Repairs the registration — wrapped over\n * two lines.\n */", "x"), "Repairs the registration — wrapped over two lines.");
  const [script] = project(t, "MONGODB_URI=mongodb://localhost/w\n");
  assert.equal(scriptCommand(script, "preview"), "node scripts/m.js");
  assert.equal(scriptCommand(script, "apply"), "node scripts/m.js --apply");
  assert.throws(() => scriptCommand({ ...script, path: "server/scripts/$(rm -rf ~).js" }, "preview"));
});

test("credentials printed by a script are masked", () => {
  assert.equal(redactCredentials("Using local MongoDB: mongodb://app:hunter2@localhost:27017/w"), "Using local MongoDB: mongodb://app:***@localhost:27017/w");
  assert.equal(redactCredentials("mongodb://localhost:27017/w"), "mongodb://localhost:27017/w");
});
