import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { OBSERVE_COMMAND, OBSERVE_SCRIPT } from "./observe.ts";

test("machine collector returns bounded resource data without process arguments", (t) => {
  if (process.platform !== "linux") return t.skip("Linux collector");
  assert.equal(OBSERVE_COMMAND, "python3 -");
  const result = spawnSync("python3", ["-"], { input: OBSERVE_SCRIPT, encoding: "utf8", timeout: 10_000 });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") return t.skip("Python 3 unavailable");
  assert.equal(result.status, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  assert.ok(snapshot.observedAt > Date.now() - 10_000);
  assert.ok(snapshot.cpuPercent >= 0 && snapshot.cpuPercent <= 100);
  assert.ok(snapshot.memoryTotalBytes > 0);
  assert.ok(snapshot.memoryUsedBytes >= 0 && snapshot.memoryUsedBytes <= snapshot.memoryTotalBytes);
  assert.ok(snapshot.processes.length <= 61);
  assert.ok(snapshot.services.length <= 251);
  assert.ok(snapshot.ports.length <= 151);
  assert.ok(snapshot.users.length <= 51);
  assert.ok(snapshot.processes.every((process: Record<string, unknown>) => !('args' in process) && !('env' in process)));
  assert.ok(snapshot.disks.every((disk: { totalBytes: number; usedBytes: number }) => disk.usedBytes <= disk.totalBytes));
});
