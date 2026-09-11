import assert from "node:assert/strict";
import test from "node:test";
import { connectionDiagnostics } from "./connection-diagnostics.ts";

test("one SSH key loading failure groups three dependents despite temporary paths", () => {
  const diagnostics = connectionDiagnostics({ ready: true, detail: "credentials present", resources: ["directory", "ingress", "certificate"].map((id) => ({ id, state: "blocked", detail: `SSH helper exited 255: Load key "/tmp/${id}/identity": error in libcrypto\npsm-infra@46.101.29.222: Permission denied (publickey)` })) });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "ssh-key-load-failed");
  assert.deepEqual(diagnostics[0].dependents, ["directory", "ingress", "certificate"]);
  assert.match(diagnostics[0].detail, /error in libcrypto/);
  assert.doesNotMatch(diagnostics[0].detail, /\/tmp/);
});

test("key rejection and a non-ready provider profile keep different causes", () => {
  const diagnostics = connectionDiagnostics({ ready: false, detail: "con_do_dns is not a ready digitalocean-api@1 profile", resources: [{ id: "host", state: "blocked", detail: "Permission denied (publickey)" }] });
  assert.equal(diagnostics[0].code, "connection-profile-not-ready");
  assert.equal(diagnostics[1].code, "ssh-key-rejected");
  assert.match(diagnostics[0].detail, /con_do_dns/);
});

test("a replacement credential cannot inherit an old connection's failure", async () => {
  const { sameObservedConnection } = await import("./connection-diagnostics.ts");
  const connection = { slot: "host", kind: "ssh", connectionId: "host", metadataRevision: 1, bindingRevision: 1, secretGeneration: 1, scopeFingerprint: "scope", profile: "ssh@1", principal: "infra", ready: true, detail: "present" };
  assert.equal(sameObservedConnection(connection, { ...connection }), true);
  for (const change of [{ connectionId: "replacement" }, { secretGeneration: 2 }, { bindingRevision: 2 }, { metadataRevision: 2 }, { scopeFingerprint: "another" }]) assert.equal(sameObservedConnection(connection, { ...connection, ...change }), false);
});
