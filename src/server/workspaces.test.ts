/**
 * psm's personal/business workspaces.
 *
 * The rules under test: personal works signed out; a business workspace exists
 * only when the Werewolf API lists it for the signed-in account; the selection
 * is a preference that is re-validated (never a grant); a project's workspace is
 * keyed by its stable id, not its directory; and a business assignment needs
 * real membership. The dapp is a stub that lists memberships and records the
 * workspace header it is sent.
 */
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const BIZ_A = "business:66b5f0a1c2d3e4f5a6b7c8d9";
const BIZ_B = "business:66b5f0a1c2d3e4f5a6b7c8da";
const BIZ_VIEW = "business:66b5f0a1c2d3e4f5a6b7c8db";

let member: Array<Record<string, unknown>> = [];
/** Set to make the account API fail, so membership cannot be verified. */
let listStatus = 200;
const seenHeaders: Array<{ path: string; workspace: string | undefined }> = [];

const dapp = http.createServer((req, res) => {
  seenHeaders.push({ path: req.url || "", workspace: req.headers["x-werewolf-workspace"] as string | undefined });
  if ((req.url || "").startsWith("/apps/psm/workspaces")) {
    if (listStatus !== 200) {
      res.writeHead(listStatus, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ success: false, message: "membership service unavailable" }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ success: true, data: member }));
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: true, data: { project: "x", tasks: [{ id: "t1", text: "task" }] } }));
});
await new Promise<void>((resolve) => dapp.listen(0, "127.0.0.1", () => resolve()));
process.env.WEREWOLF_API_URL = `http://127.0.0.1:${(dapp.address() as any).port}`;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "psm-workspaces-"));
process.env.PSM_WORKSPACES_FILE = path.join(scratch, "workspaces.json");
process.env.PSM_CLOUD_DEVICE_FILE = path.join(scratch, "device.json");

const { workspaceRouter, loadState, manageAuthority } = await import("./workspaces.ts");
const { runWithSession } = await import("../store.ts");

const entry = (ref: string, name: string, role: string) => ({
  ref, kind: "business", businessId: ref.slice(9), name, role,
  canWrite: role !== "viewer", canManage: role === "owner" || role === "admin",
});

function makeProject(name: string) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  return { name, path: dir, id: null } as any;
}
const projects = [makeProject("alpha"), makeProject("beta")];

const app = express();
app.use(express.json());
// Mirrors index.ts: the token for the request is put in context by a middleware.
app.use((req, _res, next) => {
  const token = req.headers["x-test-token"] ? String(req.headers["x-test-token"]) : null;
  runWithSession(token, next);
});
app.use("/api/cloud", workspaceRouter({ getProjects: () => projects }));
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as any).port}/api/cloud`;

const call = async (method: string, url: string, opts: { signedIn?: boolean; body?: unknown } = {}) => {
  const res = await fetch(base + url, {
    method,
    headers: { "Content-Type": "application/json", ...(opts.signedIn ? { "x-test-token": "tok" } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

test.beforeEach(() => {
  member = [entry(BIZ_A, "Acme", "member"), entry(BIZ_VIEW, "Viewer Co", "viewer")];
  listStatus = 200;
  seenHeaders.length = 0;
  fs.rmSync(process.env.PSM_WORKSPACES_FILE!, { force: true });
});
test.after(() => {
  server.close();
  dapp.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

test("workspace management verifies current owner/admin role and fails closed on membership outages", async () => {
  const manage = (ref: string, token: string | null) => new Promise<Awaited<ReturnType<typeof manageAuthority>>>((resolve, reject) => {
    runWithSession(token, () => { manageAuthority(ref).then(resolve, reject); });
  });
  assert.equal((await manage("personal", null)).ok, true);
  assert.deepEqual(await manage("bad-ref", "tok"), { ok: false, status: 400, error: "Unknown workspace" });
  assert.equal((await manage(BIZ_A, null)).ok, false);
  for (const role of ["owner", "admin", "member", "viewer"]) {
    member = [entry(BIZ_A, "Acme", role)];
    assert.equal((await manage(BIZ_A.toUpperCase(), "tok")).ok, role === "owner" || role === "admin", role);
  }
  member = [entry(BIZ_A, "Acme", "owner")];
  assert.equal((await manage(BIZ_A, "tok")).ok, true);
  listStatus = 503;
  const unavailable = await manage(BIZ_A, "tok");
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.equal(unavailable.status, 503);
});

test("personal works with no login and no network to the account", async () => {
  const listed = await call("GET", "/workspaces");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.signedIn, false);
  assert.deepEqual(listed.body.workspaces.map((w: any) => w.ref), ["personal"]);
  assert.equal(listed.body.current.ref, "personal");
  assert.equal((await call("PUT", "/workspaces/selected", { body: { ref: "personal" } })).status, 200);
  assert.equal(seenHeaders.length, 0, "signed out never calls the account API");
});

test("a business workspace needs a real, current membership", async () => {
  // Signed out: refused as unauthenticated.
  assert.equal((await call("PUT", "/workspaces/selected", { body: { ref: BIZ_A } })).status, 401);
  // Signed in but not a member of B, or a made-up id, or junk.
  assert.equal((await call("PUT", "/workspaces/selected", { signedIn: true, body: { ref: BIZ_B } })).status, 403);
  assert.equal((await call("PUT", "/workspaces/selected", { signedIn: true, body: { ref: "business:nope" } })).status, 400);
  assert.equal(loadState().selected, "personal", "nothing was remembered from refused attempts");
  // A member of A may.
  const ok = await call("PUT", "/workspaces/selected", { signedIn: true, body: { ref: BIZ_A } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.current.role, "member");
});

test("the remembered selection is re-validated: signed out or removed falls back to personal, and returns when valid", async () => {
  await call("PUT", "/workspaces/selected", { signedIn: true, body: { ref: BIZ_A } });
  assert.equal((await call("GET", "/workspaces", { signedIn: true })).body.current.ref, BIZ_A);

  const out = await call("GET", "/workspaces");
  assert.equal(out.body.current.ref, "personal");
  assert.equal(out.body.pending, BIZ_A, "explains what is waiting for sign-in");

  member = [];
  const removed = await call("GET", "/workspaces", { signedIn: true });
  assert.equal(removed.body.current.ref, "personal", "membership revoked: no longer effective");

  member = [entry(BIZ_A, "Acme", "member")];
  assert.equal((await call("GET", "/workspaces", { signedIn: true })).body.current.ref, BIZ_A);
  assert.equal(fs.readFileSync(process.env.PSM_WORKSPACES_FILE!, "utf8").match(/token|tok\b/i), null, "no credential is stored");
});

test("a project belongs to a workspace by its stable id, not its directory", async () => {
  const assigned = await call("PUT", "/workspaces/projects/alpha", { signedIn: true, body: { ref: BIZ_A } });
  assert.equal(assigned.status, 200);
  const identity = JSON.parse(fs.readFileSync(path.join(projects[0].path, ".psm", "identity.json"), "utf8"));
  const state = JSON.parse(fs.readFileSync(process.env.PSM_WORKSPACES_FILE!, "utf8"));
  assert.deepEqual(state.assignments, { [identity.id]: BIZ_A });
  assert.ok(!JSON.stringify(state).includes(scratch), "no filesystem path is stored");

  // The same project cloned elsewhere (same identity file, different directory) is the same project.
  const clone = makeProject("alpha-clone");
  fs.mkdirSync(path.join(clone.path, ".psm"));
  fs.copyFileSync(path.join(projects[0].path, ".psm", "identity.json"), path.join(clone.path, ".psm", "identity.json"));
  projects.push(clone);
  const view = await call("GET", "/workspaces/projects", { signedIn: true });
  assert.equal(view.body.projects.find((p: any) => p.name === "alpha-clone").workspace, BIZ_A);
  projects.pop();
});

test("assignment is refused without membership or write access; unassigned projects are personal", async () => {
  assert.equal((await call("PUT", "/workspaces/projects/alpha", { body: { ref: BIZ_A } })).status, 401);
  assert.equal((await call("PUT", "/workspaces/projects/alpha", { signedIn: true, body: { ref: BIZ_B } })).status, 403);
  assert.equal((await call("PUT", "/workspaces/projects/alpha", { signedIn: true, body: { ref: BIZ_VIEW } })).status, 403, "viewer");
  assert.equal((await call("PUT", "/workspaces/projects/ghost", { signedIn: true, body: { ref: BIZ_A } })).status, 404);
  assert.equal(fs.existsSync(path.join(projects[1].path, ".psm")), false, "refusals write nothing into the project");

  const view = await call("GET", "/workspaces/projects", { signedIn: true });
  assert.ok(view.body.projects.every((p: any) => p.workspace === "personal" && p.visible));
});

test("switching the view hides other workspaces' projects without moving them", async () => {
  await call("PUT", "/workspaces/projects/alpha", { signedIn: true, body: { ref: BIZ_A } });
  await call("PUT", "/workspaces/selected", { signedIn: true, body: { ref: BIZ_A } });
  const inBiz = (await call("GET", "/workspaces/projects", { signedIn: true })).body.projects;
  assert.deepEqual(inBiz.filter((p: any) => p.visible).map((p: any) => p.name), ["alpha"]);
  await call("PUT", "/workspaces/selected", { signedIn: true, body: { ref: "personal" } });
  const inPersonal = (await call("GET", "/workspaces/projects", { signedIn: true })).body.projects;
  assert.deepEqual(inPersonal.filter((p: any) => p.visible).map((p: any) => p.name), ["beta"]);
  assert.equal(inPersonal.find((p: any) => p.name === "alpha").workspace, BIZ_A, "ownership unchanged by the view");
});

test("Todo tasks are fetched from the project's own workspace, and need a session", async () => {
  await call("PUT", "/workspaces/projects/alpha", { signedIn: true, body: { ref: BIZ_A } });
  assert.equal((await call("GET", "/workspaces/todos?project=alpha")).status, 401);

  seenHeaders.length = 0;
  const own = await call("GET", "/workspaces/todos?project=alpha", { signedIn: true });
  assert.equal(own.status, 200);
  assert.equal(own.body.workspace, BIZ_A);
  assert.equal(seenHeaders.find((h) => h.path.startsWith("/apps/psm/todos"))?.workspace, BIZ_A);

  seenHeaders.length = 0;
  await call("GET", "/workspaces/todos?project=beta", { signedIn: true });
  assert.equal(seenHeaders.find((h) => h.path.startsWith("/apps/psm/todos"))?.workspace, "personal");
  assert.equal((await call("GET", "/workspaces/todos?project=ghost", { signedIn: true })).status, 404);
});

test("a damaged state file degrades to personal instead of failing", async () => {
  fs.writeFileSync(process.env.PSM_WORKSPACES_FILE!, "{not json");
  assert.equal((await call("GET", "/workspaces", { signedIn: true })).body.current.ref, "personal");
  fs.writeFileSync(process.env.PSM_WORKSPACES_FILE!, JSON.stringify({ selected: "../../etc", assignments: { "../x": BIZ_A } }));
  assert.equal(loadState().selected, "personal");
  assert.deepEqual(loadState().assignments, {});
});

test("the cockpit loads the workspace script and the board filters by it", () => {
  const web = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "web");
  const html = fs.readFileSync(path.join(web, "index.html"), "utf8");
  assert.ok(html.includes('src="/workspaces.js"'), "absolute path, like every other asset");
  assert.ok(html.indexOf('"/workspaces.js"') < html.indexOf('"/app.js"'));
  assert.ok(html.includes('id="workspace-select"') && html.includes('id="ws-workspace"'));
  assert.ok(fs.readFileSync(path.join(web, "app.js"), "utf8").includes("PsmWorkspaces?.hides"));
  assert.doesNotMatch(fs.readFileSync(path.join(web, "workspaces.js"), "utf8"), /localStorage|sessionStorage/, "no browser-side selection store: the agent owns it");
});

/**
 * Moving a project between workspaces needs write authority on **both ends**.
 *
 * The bug these cover: the handler checked only the destination, and personal is
 * always an available, writable destination — so anyone who could reach the API
 * (signed out, or with membership since revoked) could pull a business project
 * out of its business by assigning it to `personal`. A move is a write to the
 * workspace it leaves as much as the one it joins.
 */

/** Put alpha in BIZ_A as a legitimate member, and return its stable id. */
async function alphaInBizA() {
  const ok = await call("PUT", "/workspaces/projects/alpha", { signedIn: true, body: { ref: BIZ_A } });
  assert.equal(ok.status, 200, "setup: a member may place the project");
  return JSON.parse(fs.readFileSync(path.join(projects[0].path, ".psm", "identity.json"), "utf8")).id as string;
}

/** The whole persisted state plus the project's identity file, to prove nothing moved. */
const snapshot = () => ({
  state: fs.readFileSync(process.env.PSM_WORKSPACES_FILE!, "utf8"),
  identity: fs.readFileSync(path.join(projects[0].path, ".psm", "identity.json"), "utf8"),
});

test("a signed-out request cannot move a business project to personal", async () => {
  const id = await alphaInBizA();
  const before = snapshot();

  const out = await call("PUT", "/workspaces/projects/alpha", { body: { ref: "personal" } });
  assert.equal(out.status, 401, "signed out cannot write to the business it would leave");
  assert.equal(loadState().assignments[id], BIZ_A, "the assignment survived");
  assert.deepEqual(snapshot(), before, "no state or identity write happened");
});

test("a revoked member cannot move the project out of the business, to personal or elsewhere", async () => {
  const id = await alphaInBizA();
  member = [entry(BIZ_B, "Other Co", "owner")]; // membership of A revoked; owner of B
  const before = snapshot();

  const toPersonal = await call("PUT", "/workspaces/projects/alpha", { signedIn: true, body: { ref: "personal" } });
  assert.equal(toPersonal.status, 403, "no longer a member of the source");

  const toOther = await call("PUT", "/workspaces/projects/alpha", { signedIn: true, body: { ref: BIZ_B } });
  assert.equal(toOther.status, 403, "writable destination does not excuse an unauthorised source");

  assert.equal(loadState().assignments[id], BIZ_A);
  assert.deepEqual(snapshot(), before, "both refusals left everything untouched");
});

test("a viewer of the source cannot move the project, and an unauthorised destination still fails", async () => {
  const id = await alphaInBizA();
  member = [entry(BIZ_A, "Acme", "viewer"), entry(BIZ_B, "Other Co", "member")];
  const before = snapshot();

  assert.equal(
    (await call("PUT", "/workspaces/projects/alpha", { signedIn: true, body: { ref: "personal" } })).status,
    403,
    "read-only in the source",
  );
  assert.equal(
    (await call("PUT", "/workspaces/projects/alpha", { signedIn: true, body: { ref: BIZ_B } })).status,
    403,
  );

  // Source writable again, destination not a membership: still refused.
  member = [entry(BIZ_A, "Acme", "member")];
  assert.equal(
    (await call("PUT", "/workspaces/projects/alpha", { signedIn: true, body: { ref: BIZ_B } })).status,
    403,
    "unauthorised destination",
  );
  assert.equal(loadState().assignments[id], BIZ_A);
  assert.deepEqual(snapshot(), before);
});

test("a writable source and a writable destination may move the project", async () => {
  const id = await alphaInBizA();
  member = [entry(BIZ_A, "Acme", "member"), entry(BIZ_B, "Other Co", "admin")];

  const moved = await call("PUT", "/workspaces/projects/alpha", { signedIn: true, body: { ref: BIZ_B } });
  assert.equal(moved.status, 200);
  assert.equal(loadState().assignments[id], BIZ_B);
  assert.equal(moved.body.from, BIZ_A, "the response names both ends of the move");
  assert.equal(moved.body.workspace, BIZ_B);
  assert.equal(moved.body.cloudDataMoved, false, "local metadata only — cloud ownership is not silently changed");

  // And back out to personal, which is the user's own and always writable.
  const home = await call("PUT", "/workspaces/projects/alpha", { signedIn: true, body: { ref: "personal" } });
  assert.equal(home.status, 200);
  assert.equal(loadState().assignments[id], undefined, "personal is the absence of an assignment");
});

test("membership that cannot be verified fails closed, and never by moving work to personal", async () => {
  const id = await alphaInBizA();
  listStatus = 503; // the account API is down: membership is unknown, not absent
  const before = snapshot();

  const out = await call("PUT", "/workspaces/projects/alpha", { signedIn: true, body: { ref: "personal" } });
  assert.equal(out.status, 503, "unknown membership is not 'no membership'");
  assert.match(out.body.error, /could not|unavailable|verif/i, "says why, so it can be retried");
  assert.equal(loadState().assignments[id], BIZ_A);
  assert.deepEqual(snapshot(), before);

  // A business destination is refused the same way rather than reported as non-membership.
  assert.equal(
    (await call("PUT", "/workspaces/projects/beta", { signedIn: true, body: { ref: BIZ_A } })).status,
    503,
  );
  assert.equal(fs.existsSync(path.join(projects[1].path, ".psm")), false, "nothing written into the project");
});

test("personal-to-personal still works offline, signed out, and writes nothing new", async () => {
  // beta is unassigned, so this is a personal-to-personal no-op.
  const same = await call("PUT", "/workspaces/projects/beta", { body: { ref: "personal" } });
  assert.equal(same.status, 200, "your own work, no account needed");
  assert.equal(same.body.from, "personal");
  assert.equal(same.body.workspace, "personal");
  assert.deepEqual(loadState().assignments, {}, "personal is still the absence of an assignment");
  assert.equal(fs.existsSync(path.join(projects[1].path, ".psm")), false, "no id minted for personal");
  assert.equal(seenHeaders.length, 0, "the account API was never called");
});

test("re-asserting a business project's own workspace needs that workspace, and is idempotent", async () => {
  const id = await alphaInBizA();
  const before = snapshot();

  // Same source and destination: still a write to that business, so still checked.
  member = [];
  assert.equal(
    (await call("PUT", "/workspaces/projects/alpha", { signedIn: true, body: { ref: BIZ_A } })).status,
    403,
  );
  assert.deepEqual(snapshot(), before);

  member = [entry(BIZ_A, "Acme", "member")];
  const again = await call("PUT", "/workspaces/projects/alpha", { signedIn: true, body: { ref: BIZ_A } });
  assert.equal(again.status, 200);
  assert.equal(loadState().assignments[id], BIZ_A, "unchanged");
});

test("a reference differing only in case is the same workspace, not a way past the source check", async () => {
  const id = await alphaInBizA();
  member = [entry(BIZ_B, "Other Co", "owner")];
  // Upper-cased source id must not read as "unassigned" and slip through.
  assert.equal(
    (await call("PUT", "/workspaces/projects/alpha", { signedIn: true, body: { ref: BIZ_A.toUpperCase() } })).status,
    403,
  );
  assert.equal(loadState().assignments[id], BIZ_A);
});
