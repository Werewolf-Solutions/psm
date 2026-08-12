import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { StopError, machineProcesses, stopProcess } from "./machine.ts";

test("the list is shaped the way the panel expects", () => {
  const list = machineProcesses();
  assert.ok(Array.isArray(list));
  for (const proc of list) {
    assert.equal(typeof proc.pid, "number");
    assert.ok(proc.pid > 0);
    assert.equal(typeof proc.label, "string");
    assert.ok(proc.label.length > 0, "every row needs something readable in it");
    assert.ok(Array.isArray(proc.ports));
    for (const port of proc.ports) assert.ok(port > 0 && port < 65536, `odd port ${port}`);
    assert.ok(proc.ageSeconds >= 0);
    assert.ok(proc.rssBytes >= 0);
    assert.equal(typeof proc.self, "boolean");
  }
});

test("psm never offers to stop itself", () => {
  const list = machineProcesses();
  const me = list.find((proc) => proc.pid === process.pid);
  // it may not be listed at all (no port, not a dev-server name); if it is, it
  // must be flagged, because the panel hides the stop button on that flag alone
  if (me) assert.equal(me.self, true);
  assert.throws(() => stopProcess(process.pid), StopError);
});

test("system and nonsense pids are refused", () => {
  assert.throws(() => stopProcess(1), /system process/);
  assert.throws(() => stopProcess(0), /valid pid/);
  assert.throws(() => stopProcess(-5), /valid pid/);
  assert.throws(() => stopProcess(1.5 as number), /valid pid/);
});

test("a pid that is not running says so rather than throwing something odd", () => {
  // 2^22 is above the default pid_max on Linux, so nothing can be using it
  assert.throws(() => stopProcess(4194304), /no longer running/);
});

test("labels drop interpreter noise", () => {
  // Exercised through the real list: whatever is running, no label should still
  // be an absolute path or start with a loader flag.
  for (const proc of machineProcesses()) {
    assert.ok(!proc.label.startsWith("/"), `absolute path leaked into a label: ${proc.label}`);
    assert.ok(!proc.label.startsWith("--"), `flag leaked into a label: ${proc.label}`);
    assert.ok(!proc.label.includes("node_modules"), `node_modules leaked into a label: ${proc.label}`);
  }
});

test("a process psm starts can be found and stopped", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX signals only");

  // something that sits still and is unmistakably ours
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(child.pid, "spawned without a pid");

  const exited = new Promise<number | null>((resolve) => child.on("exit", (code, signal) => resolve(signal ? 0 : code)));
  const result = stopProcess(child.pid!);
  assert.equal(result.signal, "SIGTERM", "terminate politely by default");
  await exited;
  assert.equal(child.killed || child.exitCode !== null || child.signalCode !== null, true);

  // and stopping it again reports the truth
  assert.throws(() => stopProcess(child.pid!), /no longer running/);
});

test("duplicates are flagged against the newest copy, never itself", () => {
  for (const proc of machineProcesses()) {
    if (!proc.duplicateOf) continue;
    assert.notEqual(proc.duplicateOf, proc.pid, "a process cannot be its own duplicate");
    const newer = machineProcesses().find((other) => other.pid === proc.duplicateOf);
    if (newer) {
      assert.ok(newer.ageSeconds <= proc.ageSeconds, "the survivor should be the newer one");
      assert.equal(newer.duplicateOf, null, "the newest copy is not itself a duplicate");
    }
    assert.equal(proc.self, false, "psm's own tree is never marked stale");
  }
});
