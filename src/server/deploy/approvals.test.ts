import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalIntentRegistry } from "./approvals.ts";

const binding = { planId: "plan", planRevision: 1, planDigest: "sha256:plan", actorSubject: "user", agentId: "agent", origin: "local" as const };

test("approval intents are exact, expiring and one-use", () => {
  const registry = new ApprovalIntentRegistry(5_000);
  const { intent } = registry.mint(binding, 1_000);
  assert.equal(registry.consume(intent, { ...binding, planDigest: "sha256:other" }, 2_000), false);
  assert.equal(registry.consume(intent, binding, 2_000), false, "a mismatched attempt still consumes the nonce");
  const second = registry.mint(binding, 2_000);
  assert.equal(registry.consume(second.intent, binding, 8_000), false);
  const third = registry.mint(binding, 8_000);
  assert.equal(registry.consume(third.intent, binding, 9_000), true);
  assert.equal(registry.consume(third.intent, binding, 9_000), false);
});
