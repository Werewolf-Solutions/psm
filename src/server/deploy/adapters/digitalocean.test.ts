import assert from "node:assert/strict";
import test from "node:test";

import { DigitalOceanClient, DigitalOceanError, dnsMatches } from "./digitalocean.ts";
import type { DigitalOceanDnsResource } from "../types.ts";

const resource: DigitalOceanDnsResource = {
  id: "dns",
  kind: "digitalocean-dns-record@1",
  connection: "dns",
  desired: { zone: "werewolf.solutions", type: "A", name: "todo", valueFrom: { connection: "host", field: "address" }, ttl: 300 },
};

function replies(values: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    const next = values.shift()!;
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

test("DigitalOcean discovery binds account identity and exact A records", async () => {
  const fake = replies([
    { body: { account: { uuid: "account-1234" } } },
    { body: { domain_records: [{ id: 44, type: "A", name: "todo", data: "192.0.2.4", ttl: 300 }] } },
  ]);
  const observed = await new DigitalOceanClient({ token: "do-secret-token", fetch: fake.fetch }).observeDns(resource);
  assert.equal(observed.accountId, "account-1234");
  assert.equal(observed.records[0].id, "44");
  assert.ok(dnsMatches(observed.records[0], resource, "192.0.2.4"));
});

test("DigitalOcean mutations send only typed DNS fields", async () => {
  const fake = replies([{ status: 201, body: { domain_record: { id: 45, type: "A", name: "todo", data: "192.0.2.5", ttl: 300 } } }]);
  await new DigitalOceanClient({ token: "do-secret-token", fetch: fake.fetch }).createDns(resource, "192.0.2.5");
  assert.deepEqual(fake.calls[0].body, { type: "A", name: "todo", data: "192.0.2.5", ttl: 300 });
});

test("DigitalOcean errors never include credential response content", async () => {
  const fake = replies([{ status: 401, body: { message: "do-secret-token was rejected" } }]);
  await assert.rejects(
    () => new DigitalOceanClient({ token: "do-secret-token", fetch: fake.fetch }).accountId(),
    (error: DigitalOceanError) => error.status === 401 && !error.message.includes("do-secret-token"),
  );
});
