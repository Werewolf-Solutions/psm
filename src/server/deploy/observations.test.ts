import assert from "node:assert/strict";
import test from "node:test";
import { observeDependency, observeResource } from "./observations.ts";
import type { EnvironmentManifest } from "./types.ts";

test("unsupported authoritative assertions block instead of being guessed", async () => {
  const result = await observeDependency({
    id: "backup",
    kind: "werewolf-backup-policy@1",
    connection: "werewolf",
    projectId: "prj_11111111111111111111",
    environment: "production",
    expect: { scheduled: true, lastSuccessMaxAgeHours: 26 },
  });
  assert.equal(result.state, "blocked");
  assert.match(result.detail, /No werewolf-backup-policy@1 observation adapter/);
});

test("resource discovery never assumes absent adapters mean create", async () => {
  const environment = {
    id: "production",
    resources: [],
  } as unknown as EnvironmentManifest;
  const result = await observeResource("prj_11111111111111111111", environment, {
    id: "directory",
    kind: "host-release-directory@1",
    connection: "host",
    desired: { root: "/var/www/example", retainReleases: 5 },
  });
  assert.equal(result.state, "blocked");
  assert.match(result.detail, /read-only/);
});

test("resource adapters return only normalized evidence", async () => {
  const environment = { id: "staging", resources: [] } as unknown as EnvironmentManifest;
  const result = await observeResource("prj_11111111111111111111", environment, {
    id: "directory",
    kind: "host-release-directory@1",
    connection: "host",
    desired: { root: "/var/www/example", retainReleases: 5 },
  }, {
    discoverResource: async () => ({ state: "in-sync", detail: "owned and current", observed: { mode: "0755" } }),
  });
  assert.equal(result.state, "in-sync");
  assert.deepEqual(result.evidence?.observed, { mode: "0755" });
  assert.match(result.fingerprint, /^sha256:/);
});
