import assert from "node:assert/strict";
import test from "node:test";
import {
  ConnectionValidationError,
  InMemorySecretBackend,
  SecretBroker,
  SecretLeaseExpiredError,
  SecretUnavailableError,
  connectionReadinessView,
  isWithinAllowedRoot,
  minimalEnvironment,
  resolveConnectionBinding,
  validateConnectionProfile,
  validateConnectionScope,
  type ConnectionProfile,
  type SecretLease,
} from "./connections.ts";

const profile = (overrides: Partial<ConnectionProfile> = {}): ConnectionProfile => ({
  connectionId: "conn_todo_ssh",
  name: "ssh:todo-production",
  kind: "ssh-host-helper@1",
  metadataRevision: 3,
  publicMetadata: { provider: "ssh", helperProtocol: "psm-host-helper@1" },
  credentialIdentity: { kind: "public-key", value: "SHA256:public-key-fingerprint" },
  requiredSecretSlots: ["privateKey"],
  constraints: {
    allowedProjectIds: ["prj_todo"],
    allowedEnvironmentIds: ["production"],
    minimumRequiredRisk: "production",
    maximumAuthorizedRisk: "production",
    allowedTargetIds: ["werewolf:todo-production-web"],
    allowedTargetRootPrefixes: ["/srv/www/todo"],
    ssh: {
      host: "203.0.113.8",
      user: "todo-release",
      port: 22,
      hostKeyFingerprint: "SHA256:host-key",
    },
  },
  ...overrides,
});

const scope = {
  projectId: "prj_todo",
  environmentId: "production",
  risk: "production" as const,
  targetId: "werewolf:todo-production-web",
  targetRoot: "/srv/www/todo/releases",
  ssh: {
    host: "203.0.113.8",
    user: "todo-release",
    port: 22,
    hostKeyFingerprint: "SHA256:host-key",
  },
};

test("connection metadata validates and secret-looking public fields fail closed", () => {
  assert.equal(validateConnectionProfile(profile()).ok, true);
  const invalid = validateConnectionProfile(profile({
    publicMetadata: { api_token: "this must be in the broker" },
  }));
  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.some((issue) => issue.field === "publicMetadata.api_token"));
});

test("connection scope pins kind, risk, project, target root, and SSH identity", () => {
  assert.equal(validateConnectionScope(profile(), "ssh-host-helper@1", scope).ok, true);
  assert.equal(isWithinAllowedRoot("/srv/www/todo/releases", "/srv/www/todo"), true);
  assert.equal(isWithinAllowedRoot("/srv/www/todo2", "/srv/www/todo"), false);
  assert.equal(isWithinAllowedRoot("/srv/www/todo/../other", "/srv/www/todo"), false);

  const rejected = validateConnectionScope(profile(), "ssh-release-directory@1", {
    ...scope,
    projectId: "prj_other",
    targetRoot: "/srv/www/todo2",
    ssh: { ...scope.ssh, hostKeyFingerprint: "SHA256:attacker" },
  });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.issues.some((issue) => issue.code === "connection-kind-mismatch"));
  assert.ok(rejected.issues.some((issue) => issue.field === "projectId"));
  assert.ok(rejected.issues.some((issue) => issue.field === "targetRoot"));
  assert.ok(rejected.issues.some((issue) => issue.field === "ssh"));
});

test("local connection binding cannot change checkout, environment, slot, or profile", () => {
  const bound = resolveConnectionBinding(
    { slot: "infrastructure", kind: "ssh-host-helper@1" },
    {
      checkoutId: "checkout_todo",
      environmentId: "production",
      slot: "infrastructure",
      connectionId: "conn_todo_ssh",
      bindingRevision: 2,
    },
    profile(),
    { checkoutId: "checkout_todo", environmentId: "production" },
    scope,
  );
  assert.equal(bound.connectionId, "conn_todo_ssh");

  assert.throws(() => resolveConnectionBinding(
    { slot: "infrastructure", kind: "ssh-host-helper@1" },
    {
      checkoutId: "another-clone",
      environmentId: "production",
      slot: "infrastructure",
      connectionId: "conn_todo_ssh",
      bindingRevision: 2,
    },
    profile(),
    { checkoutId: "checkout_todo", environmentId: "production" },
    scope,
  ), ConnectionValidationError);
});

test("in-memory broker reports only readiness, generation, and a keyed fingerprint", async () => {
  const broker = new SecretBroker({ fingerprintKey: new Uint8Array(32).fill(7) });
  const before = await broker.status("conn_todo_ssh", ["privateKey"]);
  assert.deepEqual(before, {
    ready: false,
    generation: 0,
    availableSlots: [],
    missingSlots: ["privateKey"],
    credentialFingerprint: null,
    fingerprintKind: null,
  });

  assert.equal(await broker.put("conn_todo_ssh", "privateKey", "super-secret-value"), 1);
  const after = await broker.status("conn_todo_ssh", ["privateKey"]);
  assert.equal(after.ready, true);
  assert.equal(after.generation, 1);
  assert.equal(after.fingerprintKind, "keyed-hmac");
  assert.match(after.credentialFingerprint!, /^hmac-sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(after.credentialFingerprint!, /super-secret-value/);

  await broker.put("conn_todo_ssh", "privateKey", "super-secret-value");
  const rotated = await broker.status("conn_todo_ssh", ["privateKey"]);
  assert.equal(rotated.generation, 2);
  assert.notEqual(rotated.credentialFingerprint, after.credentialFingerprint);

  const view = await connectionReadinessView(profile(), broker);
  assert.equal(view.ready, true);
  assert.equal(view.secretGeneration, 2);
  assert.equal(view.credentialFingerprint, "public-key:SHA256:public-key-fingerprint");
  assert.equal("secret" in view, false);
});

test("secret leases are bounded to the adapter callback and expire afterward", async () => {
  const broker = new SecretBroker({ fingerprintKey: new Uint8Array(32).fill(9) });
  await broker.put("conn", "token", "lease-only-token");
  let escapedLease: SecretLease | null = null;
  const observed = await broker.withLease("conn", ["token"], (lease) => {
    escapedLease = lease;
    return lease.useUtf8("token", (value) => value.replace("token", "[used]"));
  });
  assert.equal(observed, "lease-only-[used]");
  assert.throws(
    () => escapedLease!.useUtf8("token", (value) => value),
    SecretLeaseExpiredError,
  );

  await assert.rejects(
    broker.withLease("conn", ["missing"], () => undefined),
    SecretUnavailableError,
  );
});

test("the default backend copies values and deletes them from process memory", async () => {
  const backend = new InMemorySecretBackend();
  const original = new Uint8Array([1, 2, 3]);
  await backend.write("conn", "token", original);
  original.fill(9);
  const firstRead = await backend.read("conn", "token");
  assert.deepEqual([...firstRead!], [1, 2, 3]);
  firstRead!.fill(8);
  assert.deepEqual([...(await backend.read("conn", "token"))!], [1, 2, 3]);
  assert.equal(await backend.delete("conn", "token"), true);
  assert.equal(await backend.read("conn", "token"), null);
});

test("minimal adapter environments inherit only explicitly allowed names", () => {
  const environment = minimalEnvironment({
    inherit: ["PATH", "LANG"],
    source: {
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      DOP_TOKEN: "ambient-secret",
      PSM_SESSION_SECRET: "psm-secret",
    },
    values: { NO_COLOR: "1" },
  });
  assert.deepEqual({ ...environment }, {
    PATH: "/usr/bin",
    LANG: "C.UTF-8",
    NO_COLOR: "1",
  });
  assert.equal(Object.getPrototypeOf(environment), null);
});

test("Buffer secrets are copied, not viewed, so zeroing never wipes a stored or caller-owned value", async () => {
  const broker = new SecretBroker();
  const original = Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n");
  const caller = Buffer.from(original);
  await broker.put("buffer-copy", "privateKey", caller);
  assert.deepEqual(caller, original, "the caller's buffer is untouched by put");
  for (let use = 0; use < 2; use++) {
    const seen = await broker.withLease("buffer-copy", ["privateKey"], (lease) => lease.useBytes("privateKey", (value) => Buffer.from(value).toString()));
    assert.equal(seen, original.toString(), `lease use ${use + 1} still sees the secret`);
  }
});
