/**
 * The server's half of "Sign in with Werewolf": where dapp's consent screen is,
 * which callback this page will be returned to, and whether signing in can work
 * at all before the browser is sent anywhere.
 *
 * The flow itself is in the browser now (web/auth.js) and the code exchange is in
 * session.ts, which is where the cookie transport is pinned. What used to live
 * here — a second, server-side PKCE flow against a separate `native` row — went
 * away when psm collapsed to one application.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { setModeForTesting } from "../mode.ts";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "psm-sso-"));
process.env.PSM_SESSION_SECRET = "test-sso-secret";
process.env.PSM_DATA_DIR = sandbox;

/** What dapp knows about psm, flipped per test. */
let registration: "web" | "native" | "missing" = "web";
let allowedRedirect = "http://localhost:4317/auth/callback";
let publicCalls = 0;

const dapp = http.createServer((req, res) => {
  const send = (status: number, payload: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  if (req.url?.startsWith("/apps/psm/public")) {
    publicCalls += 1;
    if (registration === "missing") {
      // dapp's controller maps app_not_configured to 404 on this route.
      return send(404, { success: false, code: "app_not_configured", message: "Application not found" });
    }
    const redirectUri = new URL(req.url, "http://x").searchParams.get("redirectUri");
    return send(200, {
      success: true,
      data: {
        key: "psm",
        name: "PSM",
        clientType: registration,
        scopes: ["psm:profile"],
        // A web client is exact-matched — that is the rule the pinned ports exist for.
        redirectAllowed: registration === "web" && redirectUri === allowedRedirect,
      },
    });
  }
  send(404, { success: false, message: "no such route" });
});

await new Promise<void>((resolve) => dapp.listen(0, "127.0.0.1", () => resolve()));
const dappPort = (dapp.address() as any).port;
process.env.WEREWOLF_API_URL = `http://127.0.0.1:${dappPort}`;
process.env.WEREWOLF_WEB_ORIGIN = "https://werewolf.test";
process.env.PORT = "4317";

const {
  SSO_CALLBACK_PATH,
  approvedSsoCallback,
  resetSsoAvailability,
  ssoAvailability,
  ssoConfig,
  ssoOriginForCallback,
  ssoRedirectUri,
  werewolfWebOrigin,
} = await import("./sso.ts");

/** A request as express hands it over: the page's own origin is in the headers. */
const req = (headers: Record<string, string> = {}) => ({ headers, query: {} }) as any;

test.before(() => setModeForTesting("dev"));

test.beforeEach(() => {
  registration = "web";
  allowedRedirect = "http://localhost:4317/auth/callback";
  publicCalls = 0;
  resetSsoAvailability();
});

test.after(() => {
  setModeForTesting(undefined);
  dapp.close();
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.WEREWOLF_WEB_ORIGIN;
});

test("the callback is one path, whoever served the page", () => {
  assert.equal(SSO_CALLBACK_PATH, "/auth/callback");
  // Whatever origin the page came from is the origin it goes back to, because a
  // web client is exact-matched and the browser cannot be sent somewhere else.
  assert.equal(
    ssoRedirectUri(req({ origin: "https://psm.werewolf.solutions" })),
    "https://psm.werewolf.solutions/auth/callback",
  );
  // Same-origin GETs send no Origin header at all; Host is the answer there.
  assert.equal(ssoRedirectUri(req({ host: "localhost:4317" })), "http://localhost:4317/auth/callback");
});

test("a psm behind a proxy can be told its own public origin", () => {
  process.env.PSM_PUBLIC_ORIGIN = "https://psm.example.com/";
  try {
    assert.equal(ssoRedirectUri(req({ host: "localhost:4317" })), "https://psm.example.com/auth/callback");
  } finally {
    delete process.env.PSM_PUBLIC_ORIGIN;
  }
});

test("a registered web client that accepts this callback is available", async () => {
  const availability = await ssoAvailability(req({ host: "localhost:4317" }));
  assert.deepEqual(availability, { available: true });
});

test("an unregistered psm is reported as such, before the browser is sent anywhere", async () => {
  registration = "missing";
  const availability = await ssoAvailability(req({ host: "localhost:4317" }));
  assert.equal(availability.available, false);
  // The reason has to name what is wrong and what fixes it: this exact state is
  // what production looked like, and "sign-in is broken" was all anyone saw.
  assert.match(availability.reason!, /not registered with Werewolf/);
  assert.match(availability.reason!, /clientType `web`/);
});

test("a row still registered as native says so, and names the migration", async () => {
  // The state every existing dapp is in until the two rows are collapsed into
  // one: psm is there, but as the native client the old flow used.
  registration = "native";
  const availability = await ssoAvailability(req({ host: "localhost:4317" }));
  assert.equal(availability.available, false);
  assert.match(availability.reason!, /registered as a native client/);
  assert.match(availability.reason!, /redirectUris/);
});

test("an unlisted callback is refused with the URI that has to be registered", async () => {
  // psm on a non-default port, which a web client cannot improvise around.
  const availability = await ssoAvailability(req({ host: "localhost:9999" }));
  assert.equal(availability.available, false);
  assert.match(availability.reason!, /will not accept this page's callback/);
  assert.match(availability.reason!, /http:\/\/localhost:9999\/auth\/callback/);
});

test("the registration answer is cached per callback, not globally", async () => {
  await ssoAvailability(req({ host: "localhost:4317" }));
  await ssoAvailability(req({ host: "localhost:4317" }));
  assert.equal(publicCalls, 1, "asking twice about the same page costs one call");

  // A different origin is a different question, and must not read a cached "yes".
  const other = await ssoAvailability(req({ origin: "https://psm.werewolf.solutions" }));
  assert.equal(publicCalls, 2);
  assert.equal(other.available, false);
});

test("the page is told which dapp to sign in against", async () => {
  const config = await ssoConfig(req({ host: "localhost:4317" }));
  assert.equal(config.appKey, "psm", "one application row, one client_id");
  assert.equal(config.apiBase, `http://127.0.0.1:${dappPort}`);
  assert.equal(config.webOrigin, "https://werewolf.test");
  assert.equal(config.redirectUri, "http://localhost:4317/auth/callback");
});

test("the consent screen origin follows the API, except locally", () => {
  const previous = process.env.WEREWOLF_WEB_ORIGIN;
  delete process.env.WEREWOLF_WEB_ORIGIN;
  try {
    // Production serves the consent screen alongside the API.
    assert.equal(werewolfWebOrigin("https://werewolf.solutions/api/v1"), "https://werewolf.solutions");

    // A local dapp does not: its API is on 3000, but 3000 serves a *built* client
    // that may be stale, so the dev server is the right target. Either a running
    // dapp Vite was found, or we fall back to Vite's default port.
    const local = werewolfWebOrigin("http://127.0.0.1:3000/api/v1");
    assert.match(local, /^http:\/\/localhost:\d+$/, `expected a Vite origin, got ${local}`);
    assert.notEqual(local, "http://127.0.0.1:3000", "3000 is the API, not the client");
  } finally {
    if (previous === undefined) delete process.env.WEREWOLF_WEB_ORIGIN;
    else process.env.WEREWOLF_WEB_ORIGIN = previous;
  }
});

test("an explicit web origin beats anything discovered", () => {
  const previous = process.env.WEREWOLF_WEB_ORIGIN;
  process.env.WEREWOLF_WEB_ORIGIN = "http://localhost:9999/";
  try {
    assert.equal(werewolfWebOrigin("http://127.0.0.1:3000/api/v1"), "http://localhost:9999");
    assert.equal(werewolfWebOrigin("https://werewolf.solutions/api/v1"), "http://localhost:9999");
  } finally {
    if (previous === undefined) delete process.env.WEREWOLF_WEB_ORIGIN;
    else process.env.WEREWOLF_WEB_ORIGIN = previous;
  }
});

/* ---- which callback psm will sign an exchange for ----
 *
 * These matter more than they look. psm derives the `Origin` it presents to
 * dapp from this URI (server/session.ts), so "whatever the body said" would let
 * the caller pick the origin psm asserts. The reference is the callback psm
 * itself issues for the same request, which agentGuard has already pinned to
 * loopback or the one paired origin.
 */

test("the callback psm issues is the callback psm will redeem", () => {
  const request = req({ origin: "http://localhost:4317" });
  // The page reports what it used, and it matches — this is the normal path.
  assert.equal(
    approvedSsoCallback(request, "http://localhost:4317/auth/callback"),
    "http://localhost:4317/auth/callback",
  );
  // Nothing claimed at all: psm's own answer stands in.
  assert.equal(approvedSsoCallback(request, ""), "http://localhost:4317/auth/callback");
});

test("a callback psm does not issue is refused before dapp is asked", () => {
  const request = req({ origin: "http://localhost:4317" });
  for (const claimed of [
    "https://attacker.example/auth/callback",          // a foreign origin outright
    "http://127.0.0.1:4317/auth/callback",             // registered, but not this page's
    "http://localhost:4317/auth/callback/../evil",     // path games on the right origin
    "http://localhost:4317@attacker.example/callback", // the userinfo trick
    "http://localhost:9999/auth/callback",             // an unregistered port
    "javascript:alert(1)",
  ]) {
    assert.throws(
      () => approvedSsoCallback(request, claimed),
      /psm issues/,
      `${claimed} should not be redeemable here`,
    );
  }
});

test("a pinned public origin is the only callback that psm then accepts", () => {
  process.env.PSM_PUBLIC_ORIGIN = "https://psm.example.com";
  try {
    // Behind a proxy the browser's own origin is the public one, so the page
    // reports that and nothing else is accepted — including the local host it
    // is actually being served on.
    const request = req({ origin: "http://localhost:4317" });
    assert.equal(
      approvedSsoCallback(request, "https://psm.example.com/auth/callback"),
      "https://psm.example.com/auth/callback",
    );
    assert.throws(() => approvedSsoCallback(request, "http://localhost:4317/auth/callback"), /psm issues/);
  } finally {
    delete process.env.PSM_PUBLIC_ORIGIN;
  }
});

test("the origin psm presents is the callback's own, and nothing else", () => {
  assert.equal(ssoOriginForCallback("http://localhost:4317/auth/callback"), "http://localhost:4317");
  assert.equal(
    ssoOriginForCallback("https://psm.werewolf.solutions/auth/callback"),
    "https://psm.werewolf.solutions",
  );
  // localhost and 127.0.0.1 are different strings to dapp's exact match, and so
  // they are different origins here too.
  assert.equal(ssoOriginForCallback("http://127.0.0.1:4317/auth/callback"), "http://127.0.0.1:4317");

  for (const bad of ["", "not-a-url", "javascript:alert(1)", "file:///auth/callback"]) {
    assert.throws(() => ssoOriginForCallback(bad), /not a usable callback URL|is an http\(s\) URL/);
  }
});
