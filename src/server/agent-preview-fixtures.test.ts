import assert from "node:assert/strict";
import test from "node:test";
import { PREVIEW_FIXTURE_SCHEMA, parsePreviewFixtures } from "./agent-preview-fixtures.ts";
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
