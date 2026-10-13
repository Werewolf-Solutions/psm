import assert from "node:assert/strict";
import test from "node:test";

import { approvedReleaseActiveOnTarget, deploymentWatchReceipt, helperData, ingressObservationTls, missingReceiptReleaseAbsent, newlyCreatedDnsStillPending, preDispatchContractFailure, releaseStateOnTarget, rollbackAuthorization } from "./runtime-adapters.ts";
import { HOST_HELPER_RESPONSE_SCHEMA } from "./adapters/host-helper.ts";
import type { ReleaseControllerDispatch } from "./adapters/executor-contract.ts";
import type { DeploymentResourceBinding, DeploymentRunStep } from "./store.ts";

test("deployment Watch receipt stays below the durable result limit with a full monitoring history", () => {
  const history = { checks: Array.from({ length: 169 }, (_, at) => ({ at: 1791900000000 + at * 3600000, checks: 60, healthy: 60, degraded: 0, down: 0, latencyMs: 12.4 })),
    host: Array.from({ length: 169 }, (_, at) => ({ at: 1791900000000 + at * 3600000, cpuPercent: 20,
      memoryUsedBytes: 123456789, memoryTotalBytes: 234567890, diskUsedBytes: 123456789,
      diskTotalBytes: 234567890, load1: 0.25 })) };
  const observed = { monitorId: "public-web", providerState: "healthy", effectiveState: "healthy" as const,
    observedAt: Date.now(), detail: "HTTP 200; TLS verified", evidence: { provider: "werewolf-watch@1",
      providerMonitorId: "public-web", status: 200, tlsExpiresAt: Date.now() + 86400000, history } };
  assert.ok(JSON.stringify(observed).length > 32 * 1024);
  const receipt = deploymentWatchReceipt(observed);
  assert.ok(JSON.stringify(receipt).length < 32 * 1024);
  assert.deepEqual(receipt, { monitorId: "public-web", providerState: "healthy", effectiveState: "healthy",
    observedAt: observed.observedAt, detail: "HTTP 200; TLS verified", evidence: {
      provider: "werewolf-watch@1", providerMonitorId: "public-web", observer: null, failureDomain: null,
      status: 200, durationMs: null, tlsExpiresAt: observed.evidence.tlsExpiresAt,
    } });
});

test("only a DNS record created by this submission gets a bounded visibility grace", () => {
  const submittedAt = 1_000_000;
  const step = { submittedAt } as DeploymentRunStep;
  const fresh = { boundAt: submittedAt + 10 } as DeploymentResourceBinding;
  const old = { boundAt: submittedAt - 10 } as DeploymentResourceBinding;
  const missing = { state: "conflict", detail: "The owned DNS record no longer exists" } as const;

  assert.equal(newlyCreatedDnsStillPending(missing, fresh, step, submittedAt + 29_999), true);
  assert.equal(newlyCreatedDnsStillPending(missing, fresh, step, submittedAt + 30_000), false);
  assert.equal(newlyCreatedDnsStillPending(missing, old, step, submittedAt + 10), false);
  assert.equal(newlyCreatedDnsStillPending({ state: "conflict", detail: "Another account owns the record" }, fresh, step, submittedAt + 10), false);
});

test("failed host-helper observations retain the helper's bounded diagnostic", () => {
  assert.throws(() => helperData({
    schema: HOST_HELPER_RESPONSE_SCHEMA,
    requestId: "req_test",
    targetId: "werewolf:test",
    operation: "snapshot-pm2",
    outcome: "failed",
    code: "helper-invalid",
    detail: "pm2 snapshot failed: permission denied",
    observedAt: new Date().toISOString(),
  }), /pm2 snapshot failed: permission denied/);
});

test("a noop http-ready accepts the live TLS ingress it was planned from", () => {
  assert.equal(ingressObservationTls("reconcile-ingress-http@1", "noop"), undefined);
  assert.equal(ingressObservationTls("reconcile-ingress-http@1", "create"), false);
  assert.equal(ingressObservationTls("reconcile-ingress-http@1", "update"), false);
  assert.equal(ingressObservationTls("reconcile-ingress-tls@1", "update"), undefined);
});

test("the target says whether a release is absent, staged or active, or that it cannot tell", () => {
  const id = "release_artifact_917da4d6407541cf9105feeb";
  const receipt = (releaseId: string) => ({ releaseId, stagedAt: "2026-09-28T15:29:22Z" });
  assert.deepEqual(releaseStateOnTarget({ layout: "ready", active: null, releases: [] }, id), { state: "absent", active: null });
  assert.deepEqual(releaseStateOnTarget({ layout: "missing", active: null, releases: [] }, id), { state: "absent", active: null });
  assert.deepEqual(releaseStateOnTarget({ layout: "ready", active: receipt("release_old"), releases: [receipt("release_old"), receipt(id)] }, id), { state: "staged", active: "release_old" });
  // Observed 2026-09-28 (run_c9cd1a9be0404bd0): activated, then every probe got nginx 403.
  assert.deepEqual(releaseStateOnTarget({ layout: "ready", active: receipt(id), releases: [receipt(id)] }, id), { state: "active", active: id });
  assert.equal(releaseStateOnTarget({ layout: "ready", active: {}, releases: [] }, id).state, "unreadable");
  assert.equal(releaseStateOnTarget({ active: null }, id).state, "unreadable");
});

test("a missing receipt closes only when the exact target retained its prior release", () => {
  const targetId = "werewolf:todo-staging-web";
  const targetDigest = `sha256:${"6".repeat(64)}`;
  const dispatch = { targetId, releaseId: "release_new", executionContract: {
    target: { fingerprint: targetDigest }, expectedCurrentRelease: { releaseId: "release_old" },
  } } as ReleaseControllerDispatch;
  const observed = { layout: "ready", targetId, targetDigest,
    active: { releaseId: "release_old" }, releases: [{ releaseId: "release_old" }] };
  assert.equal(missingReceiptReleaseAbsent(observed, dispatch), true);
  for (const change of [
    { targetId: "other" }, { targetDigest: `sha256:${"7".repeat(64)}` },
    { active: { releaseId: "release_other" } },
    { releases: [...observed.releases, { releaseId: "release_new" }] },
    { layout: "unreadable" },
  ]) assert.equal(missingReceiptReleaseAbsent({ ...observed, ...change }, dispatch), false);
});

test("only the exact approved release, active on the approved target, is recorded after a failed controller", () => {
  const targetId = "werewolf:todo-staging-web";
  const fingerprint = `sha256:${"6".repeat(64)}`;
  const dispatch = {
    targetId,
    releaseId: "release_artifact_917da4d6407541cf9105feeb",
    artifact: { psmArtifactId: "artifact_917da4d6407541cf9105feeb", payloadAlgorithm: "psm-static-tree-sha256@1", payloadDigest: `sha256:${"4".repeat(64)}`, archiveDigest: `sha256:${"0".repeat(63)}2`, commitSha: "9450ccedb9ba08493a6461ab930467ad0ea07625", version: "0.6.0" },
    executionContract: { target: { fingerprint } },
  } as unknown as ReleaseControllerDispatch;
  const active = {
    schema: "psm.werewolf.solutions/target-release/v1", targetId, targetDigest: fingerprint,
    releaseId: dispatch.releaseId, artifactId: dispatch.artifact.psmArtifactId,
    payloadAlgorithm: dispatch.artifact.payloadAlgorithm, payloadDigest: dispatch.artifact.payloadDigest,
    archiveDigest: dispatch.artifact.archiveDigest, commitSha: dispatch.artifact.commitSha,
    version: dispatch.artifact.version, stagedAt: "2026-09-28T18:11:10Z",
  };
  const observed = { layout: "ready", targetId, targetDigest: fingerprint, active, releases: [active] };
  assert.deepEqual(approvedReleaseActiveOnTarget(observed, dispatch), active);
  for (const change of [
    { schema: "unknown" }, { targetId: "werewolf:another-target" }, { payloadAlgorithm: "unknown" },
    { releaseId: "release_other" }, { artifactId: "artifact_other" }, { commitSha: "a".repeat(40) },
    { version: "0.5.9" }, { archiveDigest: `sha256:${"1".repeat(64)}` },
    { payloadDigest: `sha256:${"0".repeat(64)}` }, { targetDigest: `sha256:${"0".repeat(64)}` },
  ]) {
    assert.equal(approvedReleaseActiveOnTarget({ ...observed, active: { ...active, ...change } }, dispatch), null);
  }
  // An old receipt alone cannot prove the current host contract still matches.
  for (const change of [{ layout: "missing" }, { targetId: "werewolf:another-target" }, { targetDigest: `sha256:${"c".repeat(64)}` }, { active: null }]) {
    assert.equal(approvedReleaseActiveOnTarget({ ...observed, ...change }, dispatch), null);
  }
});

test("retrying the active release cannot authorize a rollback to itself", () => {
  assert.deepEqual(rollbackAuthorization(false, true, "release_same", "release_same"), { allowed: false, previousReleaseId: null });
  assert.deepEqual(rollbackAuthorization(false, true, "release_previous", "release_next"), { allowed: true, previousReleaseId: "release_previous" });
  assert.deepEqual(rollbackAuthorization(false, false, "release_previous", "release_next"), { allowed: false, previousReleaseId: null });
  assert.deepEqual(rollbackAuthorization(true, true, "release_previous", "release_next"), { allowed: false, previousReleaseId: null });
});

test("only a saved pre-dispatch contract error closes a release with no provider receipt", () => {
  const actionId = "unit:web#staged";
  const event = { type: "submission-response-lost", data: { actionId, errorType: "ExecutorContractError" } };
  assert.equal(preDispatchContractFailure([event], actionId), true);
  assert.equal(preDispatchContractFailure([event], "unit:other#staged"), false);
  assert.equal(preDispatchContractFailure([{ ...event, data: { actionId, errorType: "GitHubExecutorError" } }], actionId), false);
  assert.equal(preDispatchContractFailure([{ ...event, type: "action-checked" }], actionId), false);
});
