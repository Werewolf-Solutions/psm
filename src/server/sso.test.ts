/**
 * "Sign in with Werewolf" — the authorization-code + PKCE flow, checked against
 * a stand-in that enforces the same rules dapp does (single-use codes, PKCE
 * binding, redirect binding), so psm's half of the contract is pinned here.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { setModeForTesting } from "../mode.ts";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "psm-sso-"));
process.env.PSM_SESSION_SECRET = "test-sso-secret";
process.env.PSM_DATA_DIR = sandbox;

const pkceChallenge = (verifier: string) =>
  crypto.createHash("sha256").update(verifier).digest("base64url");

/** Codes dapp has minted: code → what it was bound to. */
const issued = new Map<string, { challenge: string; redirectUri: string }>();
const spent = new Set<string>();
let lastExchange: any = null;

const dapp = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.url === "/apps/psm/auth/exchange") {
      lastExchange = body;
      const deny = () => send(401, { success: false, message: "Invalid or expired authorization code" });
      const record = issued.get(body.code);
      if (!record) return deny();
      if (spent.has(body.code)) return deny(); // single-use
      if (pkceChallenge(String(body.codeVerifier || "")) !== record.challenge) return deny();
      if (body.redirectUri !== record.redirectUri) return deny(); // redirect binding
      spent.add(body.code);
      return send(200, {
        success: true,
        data: {
          user: { id: "user-sso", name: "Ada", email: "ada@example.com" },
          tokens: { accessToken: "sso-access", refreshToken: "sso-refresh", expiresIn: 900 },
        },
      });
    }
    send(404, { success: false, message: "no such route" });
  });
});

await new Promise<void>((resolve) => dapp.listen(0, "127.0.0.1", () => resolve()));
const dappPort = (dapp.address() as any).port;
process.env.WEREWOLF_API_URL = `http://127.0.0.1:${dappPort}`;
process.env.WEREWOLF_WEB_ORIGIN = "https://werewolf.test";
process.env.PORT = "4317";

const { SSO_CALLBACK_PATH, completeSso, pendingCount, ssoAuthorizeUrl, ssoAvailability, ssoRedirectUri, werewolfWebOrigin } =
  await import("./sso.ts");
const { sessionFromRequest, SESSION_COOKIE } = await import("./session.ts");

const req = (query: Record<string, string> = {}, headers: Record<string, string> = {}) =>
  ({ query, headers: { "user-agent": "test", ...headers } }) as any;

/** Play dapp's part: mint a code for a challenge the way authorizeApp would. */
function mintCode(url: URL): string {
  const code = "code-" + crypto.randomBytes(6).toString("hex");
  issued.set(code, {
    challenge: url.searchParams.get("code_challenge")!,
    redirectUri: url.searchParams.get("redirect_uri")!,
  });
  return code;
}

test.before(() => setModeForTesting("dev"));

test.after(() => {
  setModeForTesting(undefined);
  dapp.close();
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.WEREWOLF_WEB_ORIGIN;
});

test("a local instance redirects to the loopback callback dapp allows", () => {
  // dapp's native rule: http, loopback host, this exact path, any port.
  assert.equal(ssoRedirectUri(req()), `http://127.0.0.1:4317${SSO_CALLBACK_PATH}`);
  assert.equal(SSO_CALLBACK_PATH, "/api/cloud/sso/callback");
  assert.equal(ssoAvailability(req()).available, true);
});

test("the authorize URL carries client_id, state and an S256 challenge", async () => {
  const url = new URL(await ssoAuthorizeUrl(req()));
  assert.equal(url.origin + url.pathname, "https://werewolf.test/authorize");
  assert.equal(url.searchParams.get("client_id"), "psm");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("state"));
  assert.match(url.searchParams.get("code_challenge")!, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(url.searchParams.get("redirect_uri"), `http://127.0.0.1:4317${SSO_CALLBACK_PATH}`);
});

test("the verifier never appears in anything the browser is given", async () => {
  const url = await ssoAuthorizeUrl(req());
  assert.ok(!/code_verifier/i.test(url), "PKCE's secret half stays on the server");
});

test("a full round trip opens a psm session", async () => {
  const url = new URL(await ssoAuthorizeUrl(req()));
  const state = url.searchParams.get("state")!;
  const code = mintCode(url);

  const { cookie, user, returnTo } = await completeSso(req({ code, state }));
  assert.equal(user.id, "user-sso");
  assert.equal(returnTo, "/");

  // dapp got the verifier that matches the challenge psm published
  assert.equal(pkceChallenge(lastExchange.codeVerifier), url.searchParams.get("code_challenge"));
  assert.equal(lastExchange.redirectUri, url.searchParams.get("redirect_uri"));

  const resolved = await sessionFromRequest(req({}, { cookie: `${SESSION_COOKIE}=${cookie}` }));
  assert.equal(resolved?.id, "user-sso", "the session works like any other");
});

test("returnTo survives the round trip", async () => {
  const url = new URL(await ssoAuthorizeUrl(req(), "/#/p/prj_123/web"));
  const code = mintCode(url);
  const { returnTo } = await completeSso(req({ code, state: url.searchParams.get("state")! }));
  assert.equal(returnTo, "/#/p/prj_123/web");
});

test("a replayed callback is refused, and cannot spend the verifier twice", async () => {
  const url = new URL(await ssoAuthorizeUrl(req()));
  const state = url.searchParams.get("state")!;
  const code = mintCode(url);

  await completeSso(req({ code, state }));
  await assert.rejects(() => completeSso(req({ code, state })), /did not start here|expired/);
});

test("a code without its state is refused before anything is exchanged", async () => {
  const url = new URL(await ssoAuthorizeUrl(req()));
  const code = mintCode(url);
  await assert.rejects(() => completeSso(req({ code, state: "not-a-real-state" })), /did not start here/);
});

test("a callback with neither code nor state says so", async () => {
  await assert.rejects(() => completeSso(req({})), /missing its code/);
});

test("a declined consent screen reads as declined, not as a crash", async () => {
  await assert.rejects(() => completeSso(req({ error: "access_denied" })), /declined/);
  await assert.rejects(() => completeSso(req({ error: "server_error" })), /server_error/);
});

test("in-flight logins do not accumulate", async () => {
  const before = pendingCount();
  const url = new URL(await ssoAuthorizeUrl(req()));
  assert.equal(pendingCount(), before + 1);
  await completeSso(req({ code: mintCode(url), state: url.searchParams.get("state")! }));
  assert.equal(pendingCount(), before, "a finished login releases its verifier");
});

test("a hosted instance uses its public origin, and says when dapp has not allowed it", () => {
  setModeForTesting("hosted");
  try {
    const hosted = req({}, { host: "psm.werewolf.solutions", "x-forwarded-proto": "https" });
    assert.equal(
      ssoRedirectUri(hosted),
      `https://psm.werewolf.solutions${SSO_CALLBACK_PATH}`,
    );
    const availability = ssoAvailability(hosted);
    assert.equal(availability.available, false, "a public https callback is not a loopback URI");
    assert.match(availability.reason!, /allowlist/);

    // ...and once dapp has registered it, psm stops nagging
    process.env.PSM_SSO_REGISTERED = "1";
    assert.equal(ssoAvailability(hosted).available, true);
    delete process.env.PSM_SSO_REGISTERED;
  } finally {
    setModeForTesting("dev");
  }
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

test("an explicit public origin overrides the guessed one", () => {
  process.env.PSM_PUBLIC_ORIGIN = "https://psm.example.com/";
  try {
    assert.equal(ssoRedirectUri(req()), `https://psm.example.com${SSO_CALLBACK_PATH}`);
  } finally {
    delete process.env.PSM_PUBLIC_ORIGIN;
  }
});
