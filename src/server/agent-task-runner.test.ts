import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentPermissionStore } from "./agent-permissions.ts";
import { RepositoryTools } from "./agent-repository-tools.ts";
import { ManagedTaskRunner, describeDockerConnectionFailure, downloadLockedPackage, type TaskExecutor } from "./agent-task-runner.ts";
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
test("task snapshots exclude Git-ignored runtime output", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const h = fixture(t); const calls: string[][] = [];
  execFileSync("git", ["init"], { cwd: h.directory, stdio: "ignore" });
  fs.writeFileSync(path.join(h.directory, ".gitignore"), "logs/\n");
  fs.mkdirSync(path.join(h.directory, "logs"));
  fs.writeFileSync(path.join(h.directory, "logs/server.log"), "runtime output");
  fs.writeFileSync(path.join(h.directory, "new-test.js"), "export {};\n");
  const runner = new ManagedTaskRunner(h.repo, h.store, h.abort.signal, async (args) => {
    calls.push(args);
    if (args[0] === "run") {
      const source = args.find((arg) => arg.endsWith("target=/source,readonly"))!.split("source=")[1].split(",target=")[0];
      assert.equal(fs.existsSync(path.join(source, "logs/server.log")), false);
      assert.equal(fs.existsSync(path.join(source, "new-test.js")), true);
    }
    return "passed";
  });
  t.after(() => runner.close());
  assert.equal(await runner.tests(), "passed");
  assert.equal(calls.at(-1)![0], "rm");
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

/* ---- telling an unreachable daemon apart from a failing test ----
 *
 * Both arrive here as "docker exited non-zero with output on stderr". Reading a
 * permission error as a test failure sent someone looking at the project's code
 * for a fault that was in the PSM host's group membership, so the two are
 * separated deliberately and the message says what to do.
 */

test("a socket permission error explains the group, and that a restart is the fix", () => {
  // The docker CLI's exact wording, captured from the CLI on 2026-09-21.
  const message = describeDockerConnectionFailure(
    "\npermission denied while trying to connect to the docker API at unix:///var/run/docker.sock",
  );
  assert.ok(message, "a permission failure must be recognised");
  assert.match(message!, /permission denied on the Docker socket/);
  // The non-obvious half: a running process never picks up a new group.
  assert.match(message!, /group list it started with/);
  assert.match(message!, /restart psm/i);
  assert.doesNotMatch(message!, /Sandbox task failed/, "it must not read as a failing test");
});

test("an absent daemon is a different message with a different fix", () => {
  const message = describeDockerConnectionFailure(
    "\nfailed to connect to the docker API at unix:///var/run/docker.sock; check if the path is "
    + "correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory",
  );
  assert.ok(message);
  assert.match(message!, /nothing is listening/);
  assert.match(message!, /systemctl start docker/);
  assert.doesNotMatch(message!, /group/, "a missing daemon is not a permissions problem");
});

test("a genuine test failure is passed through untouched", () => {
  for (const output of [
    "1..3\nnot ok 2 - the thing under test\n# fail 1",
    "Error: expected 3 to equal 4",
    "npm ERR! missing script: test",
    "",
  ]) {
    assert.equal(
      describeDockerConnectionFailure(output),
      null,
      `"${output.slice(0, 30)}" is the project's failure, not the host's`,
    );
  }
});

test("project scripts need script.run, must exist in package.json, and run offline in the sandbox", async (t) => {
  const h = fixture(t);
  fs.writeFileSync(path.join(h.directory, "package.json"), JSON.stringify({ scripts: { test: "node --test", build: "node build.js", "type:check": "tsc --noEmit" } }));
  const calls: string[][] = [];
  const executor: TaskExecutor = async (args) => { calls.push(args); return "built"; };
  const runner = new ManagedTaskRunner(new RepositoryTools(h.store.snapshot(h.project), h.store), h.store, h.abort.signal, executor);
  t.after(() => runner.close());
  await assert.rejects(runner.script("build"), /has not granted script.run/);
  h.store.change(h.project, "script.run", true, h.store.snapshot(h.project).revision, "operator");
  const granted = new ManagedTaskRunner(new RepositoryTools(h.store.snapshot(h.project), h.store), h.store, h.abort.signal, executor);
  t.after(() => granted.close());
  assert.match(await granted.script("build"), /run install_packages first[\s\S]*built/);
  const run = calls.find((args) => args[0] === "run")!;
  assert.ok(run.includes("--network=none") && run.includes("--read-only"));
  assert.match(run.at(-1)!, /\["npm","run","build"\]/);
  assert.match(await granted.script("type:check"), /built/);
  await assert.rejects(granted.script("deploy"), /no script named deploy. Available: test, build, type:check/);
  await assert.rejects(granted.script("build; rm -rf /"), /name of a script/);
});

test("large photos survive snapshots while oversized source gets an actionable rejection", async (t) => {
  const h = fixture(t);
  fs.writeFileSync(path.join(h.directory, "work.jpg"), Buffer.alloc(10 * 1024 * 1024, 7));
  const runner = new ManagedTaskRunner(h.repo, h.store, h.abort.signal, async args => {
    if (args[0] === "run") {
      const source = args.find(arg => arg.endsWith("target=/source,readonly"))!.split("source=")[1].split(",target=")[0];
      assert.equal(fs.statSync(path.join(source, "work.jpg")).size, 10 * 1024 * 1024);
    }
    return "passed";
  });
  t.after(() => runner.close());
  await runner.tests();
  fs.writeFileSync(path.join(h.directory, "huge.ts"), Buffer.alloc(9 * 1024 * 1024));
  await assert.rejects(runner.tests(), /huge.ts.*9437184 bytes.*8388608 bytes.*Verification has not run/);
  fs.unlinkSync(path.join(h.directory, "huge.ts"));
  fs.writeFileSync(path.join(h.directory, "work.jpg"), Buffer.alloc(33 * 1024 * 1024));
  await assert.rejects(runner.tests(), /work.jpg.*33554432 bytes/);
});

test("nested installs coexist and their builds record verification only on success", async (t) => {
  const h = fixture(t);
  h.store.change(h.project, "script.run", true, h.store.snapshot(h.project).revision, "operator");
  fs.mkdirSync(path.join(h.directory, "client"));
  fs.writeFileSync(path.join(h.directory, "client/package.json"), JSON.stringify({ scripts: { build: "node build.js" } }));
  fs.copyFileSync(path.join(h.directory, "package-lock.json"), path.join(h.directory, "client/package-lock.json"));
  const repo = new RepositoryTools(h.store.snapshot(h.project), h.store);
  let fail = false;
  const calls: string[][] = [];
  const runner = new ManagedTaskRunner(repo, h.store, h.abort.signal, async args => {
    calls.push(args);
    if (fail && args[0] === "run") throw new Error("Unterminated template");
    return "passed";
  }, async () => Buffer.from("verified tarball"));
  t.after(() => runner.close());
  await runner.install(); await runner.install("client");
  await runner.script("build", "client");
  assert.equal(repo.verificationStatus().verified, true);
  const bootstrap = calls.filter(args => args[0] === "run").at(-1)!.at(-1)!;
  assert.match(bootstrap, /"cwd":"\."/);
  assert.match(bootstrap, /"cwd":"client"/);
  fail = true;
  await assert.rejects(runner.script("build", "client"), /Unterminated template/);
  assert.equal(repo.verificationStatus().verified, false);
  await assert.rejects(runner.install("../outside"), /repository-relative|protected/);
});

test("preview services run on an internal network from .env-free snapshots, with fresh stores and secrets, and are always removed", async (t) => {
  const h = fixture(t);
  h.store.change(h.project, "script.run", true, h.store.snapshot(h.project).revision, "operator");
  fs.writeFileSync(path.join(h.directory, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
  fs.writeFileSync(path.join(h.directory, "psm-preview.json"), JSON.stringify({
    schema: "psm.werewolf.solutions/preview/v2", host: "localhost", env: { VITE_API_TARGET: "http://api:3000" },
    services: [{ project: "api", directory: "server", script: "dev", port: 3000, alias: "api", stores: ["mongo"], secrets: ["JWT_SECRET"], env: { NODE_ENV: "development" }, seed: ["scripts/seed.js"] }],
    expected: [{ method: "POST", path: "/api/refresh", status: 401 }],
  }));
  const apiDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "psm-task-api-"));
  t.after(() => fs.rmSync(apiDirectory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(apiDirectory, "server/node_modules/dep"), { recursive: true });
  fs.mkdirSync(path.join(apiDirectory, "server/scripts"));
  fs.writeFileSync(path.join(apiDirectory, "server/package.json"), JSON.stringify({ scripts: { dev: "node index.js" } }));
  fs.writeFileSync(path.join(apiDirectory, "server/index.js"), "");
  fs.writeFileSync(path.join(apiDirectory, "server/scripts/seed.js"), "");
  fs.writeFileSync(path.join(apiDirectory, "server/.env"), "MONGODB_URI=mongodb://real/prod");
  fs.writeFileSync(path.join(apiDirectory, "server/.env.local"), "JWT_SECRET=real");
  fs.writeFileSync(path.join(apiDirectory, "client.js"), "outside the service directory");
  const apiProject = { id: "prj_api", name: "api", path: apiDirectory };
  const apiRepo = new RepositoryTools(h.store.snapshot(apiProject), h.store);
  const calls: string[][] = [];
  let failProbe = false;
  const executor: TaskExecutor = async (args) => {
    calls.push(args);
    if (args[0] === "run" && args.includes("api")) {
      const source = args.find((arg) => arg.endsWith("target=/source,readonly"))!.split("source=")[1].split(",target=")[0];
      assert.ok(fs.existsSync(path.join(source, "server/index.js")));
      for (const secret of ["server/.env", "server/.env.local", "client.js"]) assert.ok(!fs.existsSync(path.join(source, secret)), `${secret} never reaches a service`);
    }
    if (args[0] === "run" && args.includes("--rm") && failProbe) throw new Error("Sandbox task failed: probe");
    if (args[0] === "logs") return "api log line";
    return "{\"verified\": true}";
  };
  const runner = new ManagedTaskRunner(h.repo, h.store, h.abort.signal, executor, undefined, (name) => name === "api" ? apiRepo : undefined);
  t.after(() => runner.close());

  await assert.rejects(runner.preview("dev", 5200, ["/"]), /not allowed|permission/i, "the service project needs its own grants");
  assert.equal(calls.length, 0, "nothing starts before every service is authorised");
  for (const permission of ["repo.read", "script.run"]) h.store.change(apiProject, permission, true, h.store.snapshot(apiProject).revision, "operator");
  const apiRepoGranted = new RepositoryTools(h.store.snapshot(apiProject), h.store);
  const granted = new ManagedTaskRunner(h.repo, h.store, h.abort.signal, executor, undefined, (name) => name === "api" ? apiRepoGranted : undefined);
  t.after(() => granted.close());

  await granted.preview("dev", 5200, ["/"]);
  const network = calls[0];
  assert.deepEqual(network.slice(0, 3), ["network", "create", "--internal"]);
  const name = network[3];
  const runs = calls.filter((args) => args[0] === "run");
  assert.equal(runs.length, 3, "mongo, the api and the browser");
  for (const args of runs) {
    assert.ok(args.includes(`--network=${name}`));
    for (const flag of ["--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges"]) assert.ok(args.includes(flag), flag);
  }
  const [mongo, api, browser] = runs;
  assert.ok(mongo.includes("mongo") && mongo.some((arg) => arg.startsWith("/data/db:")));
  const env = (args: string[]) => Object.fromEntries(args.flatMap((arg, i) => args[i - 1] === "--env" ? [arg.split(/=(.*)/s).slice(0, 2)] : []));
  const apiEnv = env(api);
  assert.equal(apiEnv.PORT, "3000");
  assert.equal(apiEnv.MONGODB_URI, "mongodb://mongo:27017/psm-preview");
  assert.equal(apiEnv.NODE_ENV, "development");
  assert.match(apiEnv.JWT_SECRET, /^[0-9a-f]{64}$/);
  assert.ok(api.some((arg) => arg === `type=bind,source=${path.join(apiDirectory, "server/node_modules")},target=/deps/node_modules,readonly`));
  assert.match(api.at(-1)!, /scripts\/seed\.js/);
  assert.match(api.at(-1)!, /symlinkSync\('\/deps\/node_modules',"\/workspace\/server\/node_modules"\)/);
  assert.equal(env(browser).VITE_API_TARGET, "http://api:3000");
  assert.match(browser.at(-1)!, /const origin = 'http:\/\/localhost:5200'/);
  assert.match(browser.at(-1)!, /http:\/\/api:3000\//);
  const removed = (from: number) => calls.slice(from).filter((args) => args[0] === "rm").map((args) => args[2]);
  assert.deepEqual(removed(0).filter((entry) => entry.startsWith(name)).sort(), [`${name}-api`, `${name}-mongo`]);
  assert.deepEqual(calls.at(-1), ["network", "rm", name]);

  const first = calls.length;
  await granted.preview("dev", 5200, ["/"]);
  assert.notEqual(env(calls.slice(first).filter((args) => args[0] === "run")[1]).JWT_SECRET, apiEnv.JWT_SECRET, "secrets are new every run");

  const before = calls.length;
  failProbe = true;
  await assert.rejects(granted.preview("dev", 5200, ["/"]), /probe[\s\S]*api log line/, "a failure carries the service's last log lines");
  const failed = calls.slice(before);
  assert.equal(failed.filter((args) => args[0] === "rm" && args[2].startsWith(failed[0][3])).length, 2);
  assert.deepEqual(failed.at(-1)!.slice(0, 2), ["network", "rm"]);
});

test("a preview service outside the task's scope is refused before anything starts", async (t) => {
  const h = fixture(t); const calls: string[][] = [];
  h.store.change(h.project, "script.run", true, h.store.snapshot(h.project).revision, "operator");
  fs.writeFileSync(path.join(h.directory, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
  fs.writeFileSync(path.join(h.directory, "psm-preview.json"), JSON.stringify({ schema: "psm.werewolf.solutions/preview/v2", services: [{ project: "werewolf-dapp", script: "dev", port: 3000 }] }));
  const runner = new ManagedTaskRunner(h.repo, h.store, h.abort.signal, async (args) => { calls.push(args); return ""; });
  t.after(() => runner.close());
  await assert.rejects(runner.preview("dev", 5200, ["/"]), /werewolf-dapp is not in this task's scope/);
  assert.equal(calls.length, 0);
});

test("a signed-in preview hands the browser the same generated secret the seed received, and never records verification", async (t) => {
  const h = fixture(t);
  h.store.change(h.project, "script.run", true, h.store.snapshot(h.project).revision, "operator");
  fs.writeFileSync(path.join(h.directory, "package.json"), JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "7" } }));
  const declaration = (session: boolean) => fs.writeFileSync(path.join(h.directory, "psm-preview.json"), JSON.stringify({
    schema: "psm.werewolf.solutions/preview/v2", host: "localhost",
    services: [{ project: "api", script: "dev", port: 3000, secrets: ["PREVIEW_SESSION_TOKEN"] }],
    ...(session ? { session: { cookie: "ws_app_rt_todo", path: "/api/v1/apps/todo/auth", secret: "PREVIEW_SESSION_TOKEN" } } : {}),
  }));
  const apiDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "psm-task-api-"));
  t.after(() => fs.rmSync(apiDirectory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(apiDirectory, "node_modules"));
  fs.writeFileSync(path.join(apiDirectory, "package.json"), JSON.stringify({ scripts: { dev: "node index.js" } }));
  const apiProject = { id: "prj_api", name: "api", path: apiDirectory };
  for (const permission of ["repo.read", "script.run"]) h.store.change(apiProject, permission, true, h.store.snapshot(apiProject).revision, "operator");
  const apiRepo = new RepositoryTools(h.store.snapshot(apiProject), h.store);
  const calls: string[][] = [];
  const runner = new ManagedTaskRunner(h.repo, h.store, h.abort.signal, async (args) => { calls.push(args); return "{\"verified\": true}"; }, undefined, (name) => name === "api" ? apiRepo : undefined);
  t.after(() => runner.close());
  declaration(false);
  await assert.rejects(runner.preview("dev", 5200, ["/"], ".", true), /needs a session/);
  assert.equal(calls.length, 0);
  declaration(true);
  await runner.preview("dev", 5200, ["/"], ".", true);
  const runs = calls.filter((args) => args[0] === "run");
  const token = runs[0].find((arg) => arg.startsWith("PREVIEW_SESSION_TOKEN="))!.split("=")[1];
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.ok(runs[1].at(-1)!.includes(token), "the browser's cookie is the seed's secret");
  assert.ok(runs[1].at(-1)!.includes("ws_app_rt_todo"));
  assert.equal(h.repo.verificationStatus().verified, false, "a signed-in pass is extra evidence, not the recorded verification");
  await runner.preview("dev", 5200, ["/"]);
  assert.ok(!calls.filter((args) => args[0] === "run").at(-1)!.at(-1)!.includes(token), "a signed-out check gets no session");
  assert.equal(h.repo.verificationStatus().verified, true, "the signed-out pass is the one recorded");
});
