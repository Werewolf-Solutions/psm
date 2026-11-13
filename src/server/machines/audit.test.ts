import assert from "node:assert/strict";
import test from "node:test";

import { externalAuditChecks, internalAuditChecks, type AuditCommandRunner } from "./audit.ts";

const observed = {
  sshd: { available: true, code: 0, out: "passwordauthentication no\nkbdinteractiveauthentication no\npermitrootlogin no\npubkeyauthentication yes\n" },
  firewall: { available: true, code: 0, out: "Status: active\nDefault: deny (incoming), allow (outgoing)\n22/tcp ALLOW IN Anywhere\n" },
  listeners: { available: true, code: 0, out: "tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\n" },
  updates: { available: true, code: 0, out: "enabled\n" },
  lynis: { available: false, detail: "lynis is not installed" },
};

test("internal audit distinguishes effective SSH and firewall findings from missing Lynis", () => {
  const checks = internalAuditChecks(observed, 22);
  assert.equal(checks.find(check => check.id === "ssh")?.status, "pass");
  assert.equal(checks.find(check => check.id === "firewall")?.status, "pass");
  assert.equal(checks.find(check => check.id === "lynis")?.status, "unavailable");
  const weak = internalAuditChecks({ ...observed, sshd: { ...observed.sshd, out: "passwordauthentication yes\npermitrootlogin prohibit-password\npubkeyauthentication yes\n" } }, 22);
  assert.equal(weak.find(check => check.id === "ssh")?.status, "attention");
  const wrongPort = internalAuditChecks(observed, 2222);
  assert.equal(wrongPort.find(check => check.id === "firewall")?.status, "attention");
});

test("external audit preserves uncertain UDP and tool failures", async () => {
  const calls: string[] = [];
  const runner: AuditCommandRunner = async (file, args) => {
    calls.push(`${file} ${args.join(" ")}`);
    if (file === "ssh-audit") return { code: null, stdout: "", stderr: "", error: "ssh-audit is not installed" };
    if (args.includes("-sU")) return { code: 0, stdout: "53/udp open|filtered domain\nNmap done: 1 IP address (1 host up)\n", stderr: "" };
    return { code: 0, stdout: "22/tcp open ssh\n8080/tcp open http-proxy\nNmap done: 1 IP address (1 host up)\n", stderr: "" };
  };
  const checks = await externalAuditChecks("203.0.113.9", 22, runner);
  assert.equal(checks.find(check => check.id === "tcp")?.status, "attention");
  assert.equal(checks.find(check => check.id === "udp")?.status, "unknown");
  assert.equal(checks.find(check => check.id === "ssh-audit")?.status, "unavailable");
  assert.match(calls[0], /-p- --open/);
  assert.match(calls[1], /-sU --top-ports 100/);
});
