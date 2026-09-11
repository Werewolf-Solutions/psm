import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../db.ts";
import { SourcePublicationController, type PublicationTransport } from "./source-publication.ts";
import type { DeploymentService } from "./service.ts";
import type { SecretBroker } from "./connections.ts";

function harness(t: test.TestContext) {
  const database = openDatabase(":memory:"); t.after(() => database.close());
  let remote = "a".repeat(40), commit = "b".repeat(40), generation = 1, pushes = 0, remoteCalls = 0;
  const context = () => ({ project: { id: "prj_test", path: "/checkout" }, source: { checkoutId: "checkout", commit, manifestDigest: "manifest", identityDigest: "identity", subject: "repair" }, unit: { id: "web", executor: { sourceRepository: "owner/repo" } }, environment: { releasePolicy: { allowedBranch: "main" } }, connection: { connectionId: "github", metadataRevision: 1 }, policy: { planTtlSeconds: 600, approval: "local-operator" } });
  const service = { sourcePublicationContext: async () => context() } as unknown as DeploymentService;
  const broker = { status: async () => ({ generation, missingSlots: [] }), withLease: async (_id: string, _slots: string[], action: any) => action({ useUtf8: (_slot: string, callback: any) => callback("secret-token") }) } as unknown as SecretBroker;
  const transport: PublicationTransport = {
    remote: async () => { remoteCalls++; return remote; },
    contains: (_root, ancestor, descendant) => ancestor === "a".repeat(40) && descendant === "b".repeat(40),
    describe: () => ({ changes: "app.ts | 2 +-", commits: "bbbbbbb repair" }),
    push: async (_context, plan) => { assert.equal(plan.previousCommit, remote); remote = plan.commit; pushes++; },
  };
  const publisher = new SourcePublicationController(service, broker, () => database, transport);
  return { publisher, pushes: () => pushes, remoteCalls: () => remoteCalls, remote: (value: string) => { remote = value; }, source: (value: string) => { commit = value; }, rotate: () => { generation++; }, database };
}
test("publication reviews exact source, requires approval, persists audit, and cannot replay", async (t) => {
  const h = harness(t); const plan = (await h.publisher.review("prj_test", "staging"))!;
  assert.equal(h.pushes(), 0); assert.equal(plan.branch, "main"); assert.match(plan.changes, /app.ts/);
  await assert.rejects(h.publisher.approve(plan.id, "forged", "operator"), /stale/);
  const result = await h.publisher.approve(plan.id, plan.digest, "operator");
  assert.equal(result.state, "succeeded"); assert.equal(h.pushes(), 1); assert.equal(result.events[1].actor, "operator");
  await assert.rejects(h.publisher.approve(plan.id, plan.digest, "operator"), /consumed/);
  assert.equal(await h.publisher.review("prj_test", "staging"), null);
});
test("changed source, credential or remote branch invalidates approval without pushing", async (t) => {
  for (const change of ["source", "credential", "remote"]) {
    const h = harness(t); const plan = (await h.publisher.review("prj_test", "staging"))!;
    if (change === "source") h.source("c".repeat(40)); else if (change === "credential") h.rotate(); else h.remote("c".repeat(40));
    assert.equal((await h.publisher.approve(plan.id, plan.digest, "operator")).state, "failed");
    assert.equal(h.pushes(), 0);
  }
});
test("expired, cancelled and concurrent publication approvals fail closed", async (t) => {
  const h = harness(t); const plan = (await h.publisher.review("prj_test", "staging"))!;
  h.publisher.cancel(plan.id); await assert.rejects(h.publisher.approve(plan.id, plan.digest, "operator"), /consumed/);
  const fresh = (await h.publisher.review("prj_test", "staging"))!;
  const replies = await Promise.allSettled([h.publisher.approve(fresh.id, fresh.digest, "operator"), h.publisher.approve(fresh.id, fresh.digest, "operator")]);
  assert.equal(replies.filter((reply) => reply.status === "fulfilled").length, 1); assert.equal(h.pushes(), 1);
  const other = harness(t); const expired = (await other.publisher.review("prj_test", "staging"))!;
  expired.expiresAt = 0; other.database.prepare("UPDATE source_publication_plans SET document=? WHERE id=?").run(JSON.stringify(expired), expired.id);
  await assert.rejects(other.publisher.approve(expired.id, expired.digest, "operator"), /stale/); assert.equal(other.pushes(), 0);
});

test("checking whether source needs publication records no review", async (t) => {
  const h = harness(t);
  assert.equal(await h.publisher.needsPublication("prj_test", "staging"), true);
  const { count } = h.database.prepare("SELECT COUNT(*) AS count FROM source_publication_plans").get() as { count: number };
  assert.equal(count, 0, "a refused build must not leave a pending review that nothing will show");
});
test("a remote just verified to hold the source is not fetched again", async (t) => {
  const h = harness(t);
  h.remote("b".repeat(40)); // GitHub already has the local commit
  assert.equal(await h.publisher.review("prj_test", "staging"), null);
  assert.equal(await h.publisher.needsPublication("prj_test", "staging"), false);
  assert.equal(h.remoteCalls(), 1, "make ready's check and the build's check share one GitHub round trip");
  h.source("c".repeat(40)); // a new commit is a new question
  await h.publisher.needsPublication("prj_test", "staging").catch(() => {});
  assert.equal(h.remoteCalls(), 2);
});
test("the build after an approved publication does not ask GitHub again", async (t) => {
  const h = harness(t); const plan = (await h.publisher.review("prj_test", "staging"))!;
  assert.equal((await h.publisher.approve(plan.id, plan.digest, "operator")).state, "succeeded");
  const before = h.remoteCalls();
  assert.equal(await h.publisher.needsPublication("prj_test", "staging"), false);
  assert.equal(h.remoteCalls(), before);
});
