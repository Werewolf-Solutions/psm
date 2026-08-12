/**
 * PSM Cloud calls after the auth collapse.
 *
 * There used to be two sessions here — an identity one and a cloud one, each
 * with its own login and refresh. Now there is one: whatever token the request
 * context is carrying, put there once by src/server/session.ts. These tests pin
 * that, and that being signed out is a clear refusal rather than a stray call.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

const calls: Array<{ path: string; authorization: string; method: string; body: any }> = [];
let nextStatus = 200;

const dapp = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  calls.push({
    path: req.url || "",
    authorization: String(req.headers.authorization || ""),
    method: req.method || "",
    body: text ? JSON.parse(text) : null,
  });

  res.writeHead(nextStatus, { "Content-Type": "application/json" });
  if (nextStatus >= 400) {
    return res.end(JSON.stringify({ success: false, message: "Device limit reached", code: "device_limit" }));
  }
  res.end(
    JSON.stringify({
      success: true,
      data: {
        user: { id: "scoped-user", email: "person@example.com" },
        entitlement: { plan: "pro", canSync: true },
        revision: 7,
      },
    }),
  );
});

await new Promise<void>((resolve) => dapp.listen(0, "127.0.0.1", () => resolve()));
process.env.WEREWOLF_API_URL = `http://127.0.0.1:${(dapp.address() as any).port}`;

const { account, cloudAvailable, cloudRequest, devices, pullSync } = await import("./cloud.ts");
const { runAsUser } = await import("../store.ts");

const signedIn = <T>(fn: () => T) => runAsUser("user-1", fn, "cloud-access");
const signedOut = <T>(fn: () => T) => runAsUser("local", fn, null);

/** runtime.ts probes /auth/me to report reachability; that is not a cloud call. */
const cloudCalls = () => calls.filter((call) => call.path !== "/auth/me");

test.beforeEach(() => {
  calls.length = 0;
  nextStatus = 200;
});

test.after(() => dapp.close());

test("a cloud call carries the session's token to the psm app surface", async () => {
  await signedIn(() => cloudRequest("/devices"));
  assert.equal(cloudCalls()[0].path, "/apps/psm/devices", "everything is scoped under /apps/psm");
  assert.equal(cloudCalls()[0].authorization, "Bearer cloud-access", "the token comes from the request context");
});

test("signed out, cloud calls refuse instead of calling dapp anonymously", async () => {
  await assert.rejects(
    () => signedOut(() => cloudRequest("/devices")),
    (err: Error & { status?: number; code?: string }) => {
      assert.equal(err.status, 401);
      assert.equal(err.code, "unauthenticated");
      assert.match(err.message, /Sign in with Werewolf/);
      return true;
    },
  );
  assert.equal(cloudCalls().length, 0, "nothing should have gone over the wire");
});

test("cloudAvailable follows the session, not a stored credential", () => {
  assert.equal(signedIn(() => cloudAvailable()), true);
  assert.equal(signedOut(() => cloudAvailable()), false);
});

test("account reports the service payload and which API answered", async () => {
  const view = await signedIn(() => account());
  assert.equal(cloudCalls()[0].path, "/apps/psm/me");
  assert.equal(view.cloudReady, true);
  assert.equal(view.entitlement.plan, "pro");
  assert.ok(view.apiUrl, "the panel shows which API this is");
  assert.ok(view.apiSource);
});

test("dapp's error status and code survive the trip", async () => {
  nextStatus = 402;
  await assert.rejects(
    () => signedIn(() => devices()),
    (err: Error & { status?: number; code?: string }) => {
      assert.equal(err.status, 402);
      assert.equal(err.code, "device_limit");
      assert.match(err.message, /Device limit reached/);
      return true;
    },
  );
});

test("sync tracks the revision dapp reports", async () => {
  const data = await signedIn(() => pullSync());
  assert.equal(data.revision, 7);
  assert.equal(cloudCalls()[0].method, "GET");
  assert.equal(cloudCalls()[0].path, "/apps/psm/sync");
});
