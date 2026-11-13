import assert from "node:assert/strict";
import test from "node:test";
import { firewallPlan } from "./security.ts";

test("firewall plan preserves the SSH port and arms rollback before enabling UFW", () => {
  const plan = firewallPlan(2222);
  assert.match(plan.script, /ufw allow 2222\/tcp/);
  assert.match(plan.script, /ufw allow 80\/tcp/);
  assert.match(plan.script, /ufw allow 443\/tcp/);
  assert.ok(plan.script.indexOf("systemd-run --unit=psm-firewall-rollback") < plan.script.indexOf("ufw --force enable"));
  assert.match(plan.script, /Existing UFW rules need separate review/);
  assert.throws(() => firewallPlan(0), /Invalid SSH port/);
});
