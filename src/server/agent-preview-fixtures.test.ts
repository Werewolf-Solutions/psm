import assert from "node:assert/strict";
import test from "node:test";
import { PREVIEW_FIXTURE_SCHEMA, PREVIEW_SCHEMA, parsePreviewConfig, parsePreviewFixtures } from "./agent-preview-fixtures.ts";
import { browserPreviewProbe } from "./agent-browser-preview.ts";

const file = (responses: unknown, extra: object = {}) => JSON.stringify({ schema: PREVIEW_FIXTURE_SCHEMA, responses, ...extra });

test("preview fixtures normalise an exact method, pathname, status and body", () => {
  assert.deepEqual(parsePreviewFixtures(file([
    { method: "POST", path: "/api/v1/auth/refresh", status: 401, json: { error: "signed out" } },
    { path: "/api/v1/health", status: 200, text: "ok" },
  ])), [
    { method: "POST", path: "/api/v1/auth/refresh", status: 401, contentType: "application/json", body: "{\"error\":\"signed out\"}" },
    { method: "GET", path: "/api/v1/health", status: 200, contentType: "text/plain", body: "ok" },
  ]);
});

test("an invalid fixture file stops the check instead of being ignored", () => {
  for (const [text, message] of [
    ["{", /not JSON/],
    [JSON.stringify({ responses: [] }), /schema must be/],
    [file([], { allowAll: true }), /only schema and responses/],
    [file([{ path: "/api/x?y=1", status: 200 }]), /exact pathname/],
    [file([{ path: "api/x", status: 200 }]), /exact pathname/],
    [file([{ path: "/api/x", status: 302 }]), /status must be/],
    [file([{ path: "/api/x", status: 200, method: "OPTIONS" }]), /method must be/],
    [file([{ path: "/api/x", status: 200, json: {}, text: "" }]), /json or text/],
    [file([{ path: "/api/x", status: 200, headers: {} }]), /unknown field/],
    [file([{ path: "/api/x", status: 200 }, { path: "/api/x", status: 500 }]), /declared twice/],
    [file([{ path: "/api/x", status: 200, text: "x".repeat(70_000) }]), /exceed 65536 bytes/],
    [file(Array.from({ length: 41 }, (_, index) => ({ path: `/api/${index}`, status: 200 }))), /at most 40/],
  ] as const) assert.throws(() => parsePreviewFixtures(text), message);
});

test("the browser probe embeds fixtures as data and answers only fetch and XHR requests", () => {
  const probe = browserPreviewProbe("dev", 4173, ["/"], [], false, parsePreviewFixtures(file([{ path: "/api/x", status: 200, text: "'); process.exit(0); ('" }])));
  assert.doesNotThrow(() => new Function("require", "process", probe));
  assert.match(probe, /\['fetch', 'xhr'\]\.includes/);
  assert.match(browserPreviewProbe("dev", 4173, ["/"], []), /const fixtures = \[\];/);
});

const v2 = (extra: object) => JSON.stringify({ schema: PREVIEW_SCHEMA, ...extra });
const api = { project: "werewolf-dapp", directory: "server", script: "dev", port: 3000 };

test("a v2 file declares a real backend service with stores, generated secrets and expected answers", () => {
  const config = parsePreviewConfig(v2({
    host: "localhost",
    env: { VITE_API_TARGET: "http://werewolf-dapp:3000" },
    services: [{ ...api, env: { NODE_ENV: "development" }, secrets: ["JWT_SECRET"], stores: ["mongo", "redis"], seed: ["scripts/preview-seed.js"] }],
    expected: [{ method: "POST", path: "/api/v1/apps/todo/auth/refresh", status: 401 }],
  }));
  assert.equal(config.host, "localhost");
  assert.deepEqual(config.services, [{ ...api, alias: "werewolf-dapp", ready: "/", env: { NODE_ENV: "development" }, secrets: ["JWT_SECRET"], stores: ["mongo", "redis"], seed: ["scripts/preview-seed.js"] }]);
  assert.deepEqual(config.expected, [{ method: "POST", path: "/api/v1/apps/todo/auth/refresh", status: 401 }]);
  assert.deepEqual(parsePreviewConfig(file([])), { responses: [], services: [], expected: [], env: {}, host: "127.0.0.1", session: null, port: null }, "v1 files keep working");
});

test("a v2 file cannot reach real data, reserved variables or paths outside the service", () => {
  for (const [text, message] of [
    [v2({ services: [{ ...api, env: { MONGODB_URI: "mongodb://real-host/prod" } }] }), /MONGODB_URI is set by PSM/],
    [v2({ services: [{ ...api, env: { PORT: "4317" } }] }), /PORT is set by PSM/],
    [v2({ env: { REDIS_URL: "redis://real" } }), /REDIS_URL is set by PSM/],
    [v2({ services: [{ ...api, stores: ["postgres"] }] }), /stores may only list/],
    [v2({ services: [{ ...api, directory: "../other" }] }), /relative package directory/],
    [v2({ services: [{ ...api, seed: ["../../escape.js"] }] }), /seed must list/],
    [v2({ services: [{ ...api, alias: "mongo" }] }), /alias mongo is used twice/],
    [v2({ services: [{ ...api, image: "evil" }] }), /unknown field/],
    [v2({ services: [api], expected: [{ path: "/api/x", status: 500 }] }), /a 5xx is never expected/],
    [v2({ expected: [{ path: "/api/x", status: 401 }] }), /expected needs a service/],
    [v2({ host: "evil.example" }), /host must be/],
  ] as const) assert.throws(() => parsePreviewConfig(text), message);
});

test("the probe loads the app by the declared host and waits for services before any page", () => {
  const probe = browserPreviewProbe("dev", 5200, ["/"], [], false, [], { host: "localhost", services: [{ name: "werewolf-dapp", url: "http://werewolf-dapp:3000/" }], expected: [{ method: "POST", path: "/api/x", status: 401 }] });
  assert.doesNotThrow(() => new Function("require", "process", probe));
  assert.match(probe, /const origin = 'http:\/\/localhost:5200';/);
  assert.match(probe, /const local = 'http:\/\/127\.0\.0\.1:5200';/);
  assert.ok(probe.indexOf("for (const service of services)") < probe.indexOf("chromium.launch"));
});

test("a signed-in session cookie can only carry a secret PSM generates for a declared service", () => {
  const withSecret = { ...api, secrets: ["PREVIEW_SESSION_TOKEN"] };
  assert.deepEqual(parsePreviewConfig(v2({ services: [withSecret], session: { cookie: "ws_app_rt_todo", path: "/api/v1/apps/todo/auth", secret: "PREVIEW_SESSION_TOKEN" } })).session,
    { cookie: "ws_app_rt_todo", path: "/api/v1/apps/todo/auth", secret: "PREVIEW_SESSION_TOKEN" });
  for (const [text, message] of [
    [v2({ services: [api], session: { cookie: "rt", secret: "PREVIEW_SESSION_TOKEN" } }), /secret one of the services declares/],
    [v2({ services: [withSecret], session: { cookie: "rt", secret: "PREVIEW_SESSION_TOKEN", value: "real-token" } }), /session takes cookie, path and secret/],
    [v2({ services: [withSecret], session: { cookie: "a b", secret: "PREVIEW_SESSION_TOKEN" } }), /cookie name/],
  ] as const) assert.throws(() => parsePreviewConfig(text), message);
});

test("a v2 preview can pin the port its sign-in origin is registered with", () => {
  const v2 = (extra: object) => JSON.stringify({ schema: "psm.werewolf.solutions/preview/v2", host: "localhost", ...extra });
  assert.equal(parsePreviewConfig(v2({ port: 5200 })).port, 5200);
  assert.equal(parsePreviewConfig(v2({})).port, null);
  assert.throws(() => parsePreviewConfig(v2({ port: 80 })), /port must be 1024-65535/);
  assert.throws(() => parsePreviewConfig(v2({ port: "5200" })), /port must be 1024-65535/);
});
