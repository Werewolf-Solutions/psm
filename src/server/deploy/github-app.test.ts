import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import { SecretBroker, type ConnectionProfile } from "./connections.ts";
import { GitHubAppTokens, githubAppJwt, githubAppRequest, deploymentGitHubToken } from "./github-app.ts";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const now = 1_790_000_000_000;
const profile: ConnectionProfile = {
  connectionId: "app-test", name: "App", kind: "github-actions@1", metadataRevision: 1,
  requiredSecretSlots: ["appPrivateKey"], publicMetadata: { githubApp: { id: "123", installationId: "456", owner: "example", slug: "psm-example" } },
  constraints: { allowedProjectIds: ["project"], allowedEnvironmentIds: ["staging"], maximumAuthorizedRisk: "staging", allowedRepositories: ["example/site", "example/controller"] },
};
const result = (token = "installation-token") => ({ token, expires_at: new Date(now + 3_600_000).toISOString(), repositories: [{ full_name: "example/site" }], permissions: { actions: "read", metadata: "read" } });

test("App JWT is RSA-signed, backdated, short-lived, and names the App", () => {
  const jwt = githubAppJwt("123", pem, now);
  const [header, body, signature] = jwt.split(".");
  assert.equal(verify("RSA-SHA256", Buffer.from(`${header}.${body}`), keys.publicKey, Buffer.from(signature, "base64url")), true);
  assert.deepEqual(JSON.parse(Buffer.from(body, "base64url").toString()), { iat: now / 1000 - 60, exp: now / 1000 + 540, iss: "123" });
});

test("installation token is repository/permission narrowed; cache expires and rotation invalidates it", async () => {
  const broker = new SecretBroker(); await broker.put(profile.connectionId, "appPrivateKey", pem);
  let count = 0; let clock = now;
  const client = new GitHubAppTokens(broker, (async (url, init) => {
    count++;
    assert.equal(String(url), "https://api.github.com/app/installations/456/access_tokens");
    assert.deepEqual(JSON.parse(String(init?.body)), { repositories: ["site"], permissions: { actions: "read" } });
    return Response.json({ ...result(`token-number-${count}`), expires_at: new Date(clock + 3_600_000).toISOString() });
  }) as typeof fetch, () => clock);
  assert.equal(await client.token(profile, "example/site", { actions: "read" }), "token-number-1");
  assert.equal(await client.token(profile, "example/site", { actions: "read" }), "token-number-1");
  await broker.put(profile.connectionId, "appPrivateKey", pem);
  assert.equal(await client.token(profile, "example/site", { actions: "read" }), "token-number-2");
  clock += 3_550_000;
  assert.equal(await client.token(profile, "example/site", { actions: "read" }), "token-number-3");
  await broker.delete(profile.connectionId, "appPrivateKey");
  await assert.rejects(client.token(profile, "example/site", { actions: "read" }));
});

test("out-of-scope repositories are refused before key access or networking", async () => {
  const client = new GitHubAppTokens(new SecretBroker(), (() => { throw new Error("must not fetch"); }) as typeof fetch);
  await assert.rejects(client.token(profile, "other/site", { actions: "read" }), /outside/);
  await assert.rejects(client.token(profile, "example/unapproved", { actions: "read" }), /outside/);
});

test("provider tokens with extra repositories or write permission are rejected", async () => {
  for (const response of [{ ...result(), repositories: [] }, { ...result(), permissions: { actions: "write" } }]) {
    const broker = new SecretBroker(); await broker.put(profile.connectionId, "appPrivateKey", pem);
    const client = new GitHubAppTokens(broker, (async () => Response.json(response)) as typeof fetch, () => now);
    await assert.rejects(client.token(profile, "example/site", { actions: "read" }), /restrict|broader/);
  }
});

test("GitHub error bodies cannot echo secrets and redirects are refused", async () => {
  await assert.rejects(githubAppRequest("/app", "secret-value", "GET", undefined, (async (_url, init) => {
    assert.equal(init?.redirect, "error");
    return new Response("secret-value private-key", { status: 403 });
  }) as typeof fetch), (error: Error) => error.message.includes("HTTP 403") && !error.message.includes("secret-value"));
});

test("existing PAT profiles continue using their broker slot", async () => {
  const broker = new SecretBroker(); await broker.put(profile.connectionId, "apiToken", "old-pat-value");
  assert.equal(await deploymentGitHubToken(broker, { ...profile, publicMetadata: {}, requiredSecretSlots: ["apiToken"] }, { pathname: "/repos/example/site/actions/runs" }), "old-pat-value");
});
