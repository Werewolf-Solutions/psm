import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentPermissionStore } from "./agent-permissions.ts";
import { RepositoryTools } from "./agent-repository-tools.ts";
import { ManagedTaskRunner, downloadLockedPackage, type TaskExecutor } from "./agent-task-runner.ts";
import { openDatabase } from "./db.ts";

function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "psm-task-test-"));
  const database = openDatabase(":memory:"); const store = new AgentPermissionStore(() => database);
  const project = { id: "prj_test", name: "test", path: directory };
  for (const permission of ["repo.read", "test.run", "pkg.install"]) store.change(project, permission, true, store.snapshot(project).revision, "operator");
  fs.mkdirSync(path.join(directory, ".claude")); fs.writeFileSync(path.join(directory, ".claude/settings.json"), "secret authority");
  fs.writeFileSync(path.join(directory, ".env"), "SECRET=secret");
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(directory, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/dep": { resolved: "https://registry.npmjs.org/dep/-/dep-1.tgz", integrity: "sha512-test" } } }));
  const repo = new RepositoryTools(store.snapshot(project), store); const abort = new AbortController();
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, project, repo, abort };
}
test("tests execute with offline, bounded, read-only host inputs and no credentials", async (t) => {
  const h = fixture(t); const calls: string[][] = [];
  const executor: TaskExecutor = async (args) => {
    calls.push(args);
    if (args[0] === "run") {
      const source = args.find((arg) => arg.endsWith("target=/source,readonly"))!.split("source=")[1].split(",target=")[0];
      assert.ok(fs.existsSync(path.join(source, "package.json")));
      assert.ok(!fs.existsSync(path.join(source, ".env"))); assert.ok(!fs.existsSync(path.join(source, ".claude")));
      assert.ok(args.includes("--network=none")); assert.ok(args.includes("--read-only")); assert.ok(args.includes("--cap-drop=ALL"));
      assert.ok(args.some((arg) => arg.startsWith("/workspace:rw") && arg.includes("size=")));
    }
    return "passed";
  };
  const runner = new ManagedTaskRunner(h.repo, h.store, h.abort.signal, executor); t.after(() => runner.close());
  assert.equal(await runner.tests("node --test"), "passed");
  assert.equal(calls.at(-1)![0], "rm");
  await assert.rejects(runner.tests("test; curl evil"), /Choose/);
  h.store.change(h.project, "test.run", false, h.store.snapshot(h.project).revision, "operator");
  await assert.rejects(runner.tests(), /permissions changed/);
  assert.equal(calls.length, 2);
});
test("package installation uses verified downloads offline, preserves the checkout and cleans failed containers", async (t) => {
  const h = fixture(t); const original = fs.readFileSync(path.join(h.directory, "package-lock.json"), "utf8");
  let downloaded = 0; const commands: string[] = [];
  const runner = new ManagedTaskRunner(h.repo, h.store, h.abort.signal, async (args) => {
    if (args[0] === "run") commands.push(args.at(-1)!); return "ok";
  }, async () => { downloaded++; return Buffer.from("fake verified tarball"); }); t.after(() => runner.close());
  await runner.install(); await runner.tests();
  assert.equal(downloaded, 1); assert.match(commands[0], /--offline/); assert.match(commands[0], /--ignore-scripts/);
  assert.match(commands[1], /--ignore-scripts/); // dependency workspace recreated within tmpfs
  assert.equal(fs.readFileSync(path.join(h.directory, "package-lock.json"), "utf8"), original);
  const calls: string[][] = [];
  const failing = new ManagedTaskRunner(h.repo, h.store, h.abort.signal, async (args) => { calls.push(args); if (args[0] === "run") throw new Error("sandbox unavailable"); return ""; }); t.after(() => failing.close());
  await assert.rejects(failing.tests(), /sandbox unavailable/); assert.equal(calls.at(-1)![0], "rm");
});
test("package downloads reject credentials, alternate hosts and unverified tarballs before fetching", async () => {
  for (const url of ["http://registry.npmjs.org/a", "https://127.0.0.1/a", "https://registry.npmjs.org.evil/a", "https://secret@registry.npmjs.org/a"]) await assert.rejects(downloadLockedPackage(url, "sha512-AAAA"), /public registry/);
  await assert.rejects(downloadLockedPackage("https://registry.npmjs.org/a", "sha1-bad"), /SHA-512/);
});

test("npm ci can consume rewritten locked tarball paths offline without lifecycle scripts", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-offline-npm-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archiveRoot = path.join(root, "archive"); fs.mkdirSync(path.join(archiveRoot, "package"), { recursive: true });
  fs.writeFileSync(path.join(archiveRoot, "package/package.json"), JSON.stringify({ name: "psm-fixture", version: "1.0.0", scripts: { preinstall: "node -e 'process.exit(99)'" } }));
  fs.writeFileSync(path.join(archiveRoot, "package/index.js"), "module.exports = 42;");
  const tarball = path.join(root, "fixture.tgz"); execFileSync("tar", ["-czf", tarball, "-C", archiveRoot, "package"]);
  const integrity = "sha512-" + createHash("sha512").update(fs.readFileSync(tarball)).digest("base64");
  const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "fixture-app", version: "1.0.0", dependencies: { "psm-fixture": "1.0.0" } }));
  fs.writeFileSync(path.join(workspace, "package-lock.json"), JSON.stringify({ name: "fixture-app", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture-app", version: "1.0.0", dependencies: { "psm-fixture": "1.0.0" } }, "node_modules/psm-fixture": { version: "1.0.0", resolved: `file:${tarball}`, integrity, hasInstallScript: true } } }));
  // Two distinct empty files: npm 10 refuses to load one path as both the user
  // and the global config, so pointing both at /dev/null fails before install.
  const userconfig = path.join(root, "user.npmrc"); const globalconfig = path.join(root, "global.npmrc");
  fs.writeFileSync(userconfig, ""); fs.writeFileSync(globalconfig, "");
  execFileSync("npm", ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: workspace, env: { PATH: process.env.PATH, HOME: root, npm_config_cache: path.join(root, "cache"), npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig }, stdio: "pipe", timeout: 30_000 });
  assert.equal(fs.readFileSync(path.join(workspace, "node_modules/psm-fixture/index.js"), "utf8"), "module.exports = 42;");
});
