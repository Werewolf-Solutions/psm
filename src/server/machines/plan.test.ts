import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCommandAccessPlan,
  commandAccountName,
  compatibility,
  copyableSetupCommand,
  parseInspection,
  parseKnownHost,
  parsePublicKey,
  validateHost,
  type MachineIdentity,
} from "./plan.ts";

const HOST_BLOB = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]).toString("base64");
const USER_KEY = `ssh-ed25519 ${Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 9)]).toString("base64")} psm`;

function machine(overrides: Partial<MachineIdentity> = {}): MachineIdentity {
  const pinned = parseKnownHost(`203.0.113.4 ssh-ed25519 ${HOST_BLOB}`, "203.0.113.4", 22);
  return {
    id: "mch_test",
    name: "test box",
    host: "203.0.113.4",
    port: 22,
    knownHost: pinned.knownHost,
    hostKeyFingerprint: pinned.fingerprint,
    hostKeySource: "operator-confirmed",
    ...overrides,
  };
}

function plan(overrides: Partial<Parameters<typeof buildCommandAccessPlan>[0]> = {}) {
  return buildCommandAccessPlan({
    machine: machine(),
    projectId: "prj_todo",
    projectName: "Todo App",
    environmentId: "staging",
    risk: "staging",
    publicKey: USER_KEY,
    now: 1_000,
    ...overrides,
  });
}

test("account names are stable per access, distinct across projects, and valid Unix names", () => {
  const first = commandAccountName("mch_a", "prj_1", "api", "staging");
  assert.equal(first, commandAccountName("mch_a", "prj_1", "api", "staging"));
  assert.notEqual(first, commandAccountName("mch_a", "prj_2", "api", "staging"));
  assert.notEqual(first, commandAccountName("mch_b", "prj_1", "api", "staging"));
  assert.notEqual(first, commandAccountName("mch_a", "prj_1", "api", "production"));
  const long = commandAccountName("mch_a", "prj_1", "An Extremely Long Project Name That Keeps Going", "production-eu-west");
  assert.ok(long.length <= 32, long);
  assert.match(long, /^psm-x-[a-z0-9-]+-[0-9a-f]{6}$/);
  assert.match(commandAccountName("mch_a", "prj_1", "日本語", "x"), /^psm-x-x-[0-9a-f]{6}$/);
});

test("host keys must name the machine being registered, and fingerprints match ssh-keygen", () => {
  const parsed = parseKnownHost(`example.com,203.0.113.4 ssh-ed25519 ${HOST_BLOB} comment`, "203.0.113.4", 22);
  assert.equal(parsed.knownHost, `203.0.113.4 ssh-ed25519 ${HOST_BLOB}`);
  assert.equal(parsed.fingerprint, `SHA256:${createHash("sha256").update(Buffer.from(HOST_BLOB, "base64")).digest("base64").replace(/=+$/, "")}`);
  assert.equal(parseKnownHost(`[203.0.113.4]:2222 ssh-ed25519 ${HOST_BLOB}`, "203.0.113.4", 2222).knownHost.split(" ")[0], "[203.0.113.4]:2222");
  assert.throws(() => parseKnownHost(`198.51.100.1 ssh-ed25519 ${HOST_BLOB}`, "203.0.113.4", 22), /not 203.0.113.4/);
  assert.throws(() => parseKnownHost(`203.0.113.4 ssh-ed25519 ${HOST_BLOB}`, "203.0.113.4", 2222), /not \[203.0.113.4\]:2222/);
  assert.throws(() => parseKnownHost(`|1|abc= ssh-ed25519 ${HOST_BLOB}`, "203.0.113.4", 22), /unhashed/);
  assert.throws(() => validateHost("root@host"), /hostname/);
  assert.throws(() => validateHost("host; rm -rf /"), /hostname/);
  assert.equal(validateHost("Alpha.Example.com"), "alpha.example.com");
});

test("setup cannot be planned against a host key nobody confirmed", () => {
  assert.throws(() => plan({ machine: machine({ hostKeySource: "scanned-unverified" }) }), /Confirm the machine's host key/);
});

test("plans bind every reviewed value into their digest", () => {
  const base = plan();
  assert.equal(base.digest, plan().digest);
  assert.notEqual(base.digest, plan({ environmentId: "production" }).digest);
  assert.notEqual(base.digest, plan({ risk: "production" }).digest);
  assert.ok(base.operations.some((line) => line.includes(parsePublicKey(USER_KEY).fingerprint)));
  assert.ok(base.authority.some((line) => /No sudo/.test(line)));
  assert.equal(base.workdir, `/srv/psm/commands/${base.account}`);
});

test("hostile display names never reach shell syntax", () => {
  const hostile = plan({ projectName: "x'; touch /tmp/pwned; echo '$(id)`id`" });
  const result = spawnSync("bash", ["-n"], { input: hostile.script });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.match(hostile.account, /^psm-x-[a-z0-9-]+-[0-9a-f]{6}$/);
  assert.ok(!hostile.script.includes("touch /tmp/pwned"));
  assert.throws(() => plan({ projectId: "prj'; id" }), /projectId/);
  assert.throws(() => plan({ publicKey: "ssh-rsa AAAA" }), /Ed25519/);
  assert.throws(() => plan({ publicKey: `${USER_KEY}\nssh-ed25519 AAAA` }), /Ed25519/);
});

test("inspect mode is read-only and reports what it finds on this machine", (t) => {
  const generated = plan();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "psm-plan-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "setup.sh");
  fs.writeFileSync(file, generated.script);
  const output = execFileSync("bash", [file, "--inspect"], { encoding: "utf8" });
  const report = parseInspection(output);
  assert.equal(report.plan, `mch_test:prj_todo:staging:command`);
  assert.equal(report.account, "absent");
  assert.equal(report.key, "absent");
  assert.equal(report.result, "inspected");
  assert.equal(report.kernel, "Linux");
  assert.ok(report.uid !== null);
  assert.ok(compatibility(report).supported, compatibility(report).reasons.join(", "));
  if (process.getuid?.() !== 0) {
    const apply = spawnSync("bash", [file, "--apply"], { encoding: "utf8" });
    assert.equal(apply.status, 77);
    assert.equal(parseInspection(apply.stdout).result, "needs-root");
  }
});

test("reports that are missing, foreign or truncated are never read as success", () => {
  assert.throws(() => parseInspection("hello\n"), /inspection report/);
  const partial = parseInspection("psm.schema=1\npsm.account=weird\npsm.conflict=symlink:/srv\n");
  assert.equal(partial.account, "unknown");
  assert.equal(partial.key, "unknown");
  assert.equal(partial.result, "");
  assert.deepEqual(partial.conflicts, ["symlink:/srv"]);
  assert.equal(compatibility({ ...partial, kernel: "Darwin", arch: "arm64" }).supported, false);
});

test("the copyable command reproduces the reviewed script byte for byte and checks its digest", (t) => {
  const generated = plan();
  const command = copyableSetupCommand(generated);
  assert.ok(!command.includes("PRIVATE"));
  assert.match(command, /sha256sum -c --quiet && sudo bash \/tmp\/psm-setup-/);
  const encoded = /printf '%s' '([A-Za-z0-9+/=]+)'/.exec(command)![1];
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), generated.script);
  // Run everything but the privileged step, to prove the digest check passes as written.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "psm-command-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const checkOnly = command.replace(/ && sudo bash (\S+) --apply; rm -f \S+$/, " && echo verified").replaceAll("/tmp/", `${directory}/`);
  assert.equal(execFileSync("bash", ["-c", checkOnly], { encoding: "utf8" }).trim(), "verified");
});
