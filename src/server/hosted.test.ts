/**
 * The hosted invariant, tested against a real server process.
 *
 * docs/hosted-psm-plan.md calls for the shell-out routes to be *absent* from the
 * hosted build rather than guarded by a flag, because a flag is one bad refactor
 * away from being bypassed. The only honest way to check "absent" is to boot the
 * thing and knock on the doors.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, "index.ts");
const SECRET = "hosted-test-secret";

function b64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

function session(sub: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 600 }));
  const signature = crypto.createHmac("sha256", SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

async function waitForServer(port: number, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})`);
    try {
      await fetch(`http://127.0.0.1:${port}/api/projects`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error("server did not start");
}

let child: ChildProcess;
let port = 0;
let dataDir = "";

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-hosted-"));
  port = 4400 + Math.floor(Math.random() * 400);
  child = spawn(process.execPath, ["--import", "tsx", SERVER], {
    env: {
      ...process.env,
      PSM_MODE: "hosted",
      PSM_AUTH_SECRET: SECRET,
      PSM_DATA_DIR: dataDir,
      PSM_BIND: "127.0.0.1",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer(port, child);
});

test.after(() => {
  child?.kill("SIGKILL");
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = (route: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${port}${route}`, {
    ...init,
    headers: { authorization: `Bearer ${session("user-a")}`, ...(init.headers || {}) },
  });

test("every route that shells out is absent, not merely refused", async () => {
  const shellRoutes: [string, RequestInit][] = [
    ["/api/projects/psm/run", { method: "POST" }],
    ["/api/projects/psm/stop", { method: "POST" }],
    ["/api/projects/psm/ai", { method: "POST" }],
    ["/api/projects/psm/ai/cancel", { method: "POST" }],
    ["/api/projects/psm/planner/start", { method: "POST" }],
    ["/api/projects/psm/logs/stream", {}],
    ["/api/projects/psm/preview", {}],
    ["/api/procs", {}],
    ["/api/fs/browse", {}],
    ["/api/skills-usage", {}],
    ["/api/export", { method: "POST" }],
    ["/api/projects/new", { method: "POST" }],
  ];
  for (const [route, init] of shellRoutes) {
    const response = await call(route, init);
    assert.equal(response.status, 404, `${route} should not exist in a hosted build`);
  }
});

test("the agent's pairing endpoints do not exist hosted either", async () => {
  for (const route of ["/api/agent", "/api/agent/token"]) {
    assert.equal((await call(route)).status, 404, route);
  }
});

test("hosted still serves its own surfaces", async () => {
  const response = await call("/api/projects");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "hosted");
  assert.equal(body.capabilities.runsCommands, false);
  assert.equal(body.capabilities.canLink, false);
  assert.deepEqual(body.projects, [], "a hosted psm has no disk to scan");
});

test("an unauthenticated request gets nothing", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/projects`);
  assert.equal(response.status, 401);
});

test("a forged session is rejected", async () => {
  const forged = session("user-a").slice(0, -3) + "aaa";
  const response = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    headers: { authorization: `Bearer ${forged}` },
  });
  assert.equal(response.status, 401);
});

test("two accounts get separate state directories", async () => {
  // touching a project override is the cheapest write that proves the split
  for (const user of ["user-a", "user-b"]) {
    const response = await fetch(`http://127.0.0.1:${port}/api/projects/shared-name`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${session(user)}`, "content-type": "application/json" },
      body: JSON.stringify({ note: `${user} was here` }),
    });
    // the route is local-only, so hosted should not have it at all
    assert.equal(response.status, 404, "override writes are a local-mode route");
  }

  // the store still lays out per-user directories for the state hosted does keep
  const { runAsUser, stateDir } = await import("../store.ts");
  const { setModeForTesting } = await import("../mode.ts");
  setModeForTesting("hosted");
  process.env.PSM_DATA_DIR = dataDir;
  try {
    const a = runAsUser("user-a", () => stateDir());
    const b = runAsUser("user-b", () => stateDir());
    assert.notEqual(a, b, "one directory per account");
    assert.ok(a.startsWith(dataDir) && b.startsWith(dataDir));
  } finally {
    setModeForTesting(undefined);
  }
});

test("an exotic user id cannot escape its directory", async () => {
  const { runAsUser, stateDir } = await import("../store.ts");
  const { setModeForTesting } = await import("../mode.ts");
  setModeForTesting("hosted");
  process.env.PSM_DATA_DIR = dataDir;
  try {
    const escaped = runAsUser("../../etc", () => stateDir());
    assert.ok(escaped.startsWith(path.join(dataDir, "users")), `traversal escaped to ${escaped}`);
  } finally {
    setModeForTesting(undefined);
  }
});
