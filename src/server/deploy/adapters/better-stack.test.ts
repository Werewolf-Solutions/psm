import assert from "node:assert/strict";
import test from "node:test";

import { BetterStackClient, BetterStackError } from "./better-stack.ts";
import type { ExternalHttpWatch } from "../types.ts";

const definition: ExternalHttpWatch = {
  id: "public",
  kind: "external-http-monitor@1",
  connection: "monitor",
  unit: "web",
  monitorKey: "123",
  hostname: "todo.werewolf.solutions",
  maxObservationAgeSeconds: 300,
};

function reply(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function client(responses: Response[], now = Date.parse("2026-08-26T12:02:00Z")) {
  return new BetterStackClient({
    token: "token-value",
    now: () => now,
    fetch: async () => responses.shift()!,
  });
}

function monitor(overrides: Record<string, unknown> = {}) {
  return reply({ data: { id: "123", type: "monitor", attributes: {
    url: "https://todo.werewolf.solutions/",
    status: "up",
    last_checked_at: "2026-08-26T12:01:00Z",
    verify_ssl: true,
    ssl_expiration: 14,
    ...overrides,
  } } });
}

test("a fresh matching Better Stack monitor normalizes to healthy", async () => {
  const result = await client([monitor(), reply({ data: [] })]).observe(definition);
  assert.equal(result.effectiveState, "healthy");
  assert.equal(result.providerState, "up");
  assert.equal(result.evidence?.providerMonitorId, "123");
});

test("provider down, recovery and stale states never render healthy", async () => {
  assert.equal((await client([monitor({ status: "down" }), reply({ data: [] })]).observe(definition)).effectiveState, "down");
  assert.equal((await client([monitor({ status: "validating" }), reply({ data: [] })]).observe(definition)).effectiveState, "degraded");
  const late = Date.parse("2026-08-26T12:20:00Z");
  assert.equal((await client([monitor(), reply({ data: [] })], late).observe(definition)).effectiveState, "stale");
});

test("a certificate incident carries the provider expiry and degrades Watch", async () => {
  const incident = { id: "77", type: "incident", attributes: {
    status: "Started",
    cause: "Certificate expires soon",
    ssl_certificate_expires_at: "2026-09-01T00:00:00Z",
  } };
  const result = await client([monitor(), reply({ data: [incident] })]).observe(definition);
  assert.equal(result.effectiveState, "degraded");
  assert.equal(result.evidence?.tlsExpiresAt, Date.parse("2026-09-01T00:00:00Z"));
});

test("a mismatched hostname or disabled TLS monitoring fails closed", async () => {
  await assert.rejects(() => client([monitor({ url: "https://evil.example/" })]).observe(definition), BetterStackError);
  await assert.rejects(() => client([monitor({ verify_ssl: false })]).observe(definition), /not enforcing TLS/);
});

test("tokens never appear in provider errors", async () => {
  const result = client([reply({ errors: "token-value invalid" }, 401)]).observe(definition);
  await assert.rejects(result, (error: BetterStackError) => !error.message.includes("token-value"));
});
