import assert from "node:assert/strict";
import test from "node:test";
import { DeploymentStreamTicketRegistry } from "./stream-tickets.ts";

test("stream tickets bind run, origin, agent generation and expiry", () => {
  const registry = new DeploymentStreamTicketRegistry(5_000);
  const minted = registry.mint({ runId: "run_a", origin: "https://psm.example", agentGeneration: 4 }, 1_000);
  assert.equal(registry.validate({ ticket: minted.ticket, runId: "run_b", origin: "https://psm.example", agentGeneration: 4 }, 2_000), false);
  assert.equal(registry.validate({ ticket: minted.ticket, runId: "run_a", origin: "https://other.example", agentGeneration: 4 }, 2_000), false);
  assert.equal(registry.validate({ ticket: minted.ticket, runId: "run_a", origin: "https://psm.example", agentGeneration: 5 }, 2_000), false);
  assert.equal(registry.validate({ ticket: minted.ticket, runId: "run_a", origin: "https://psm.example", agentGeneration: 4 }, 2_000), true);
  assert.equal(registry.validate({ ticket: minted.ticket, runId: "run_a", origin: "https://psm.example", agentGeneration: 4 }, 7_000), false);
});
