import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverKeys, nextStep, testKeys, type KeyTest, type LocalKey, type Run } from "./keys.ts";

test("discovery lists real key pairs and tells passphrase keys apart", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "psm-keys-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "plain key", "-f", path.join(directory, "plain")]);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "secret-passphrase", "-C", "locked key", "-f", path.join(directory, "locked")]);
  fs.copyFileSync(path.join(directory, "plain.pub"), path.join(directory, "orphan.pub"));
  const keys = await discoverKeys(directory);
  assert.deepEqual(keys.map(key => [key.name, key.type, key.encrypted, key.comment]), [["locked", "ED25519", true, "locked key"], ["plain", "ED25519", false, "plain key"]]);
  assert.match(keys[0].fingerprint, /^SHA256:/);
  assert.deepEqual(await discoverKeys(path.join(directory, "missing")), []);
});

const key = (name: string, encrypted = false): LocalKey => ({ name, privatePath: `/home/x/.ssh/${name}`, type: "ED25519", bits: 256, fingerprint: `SHA256:${name}`, comment: "", encrypted });

test("each key is tried alone with the agent off, against the pinned host key", async () => {
  const calls: string[][] = [];
  let pinned = "";
  const exec: Run = async (_file, args) => {
    calls.push(args);
    pinned = fs.readFileSync(args.find(arg => arg.startsWith("UserKnownHostsFile="))!.split("=")[1], "utf8");
    const identity = args[args.indexOf("-i") + 1];
    if (identity.endsWith("/mesh") && args.includes("root@46.101.14.20")) return { code: 0, stdout: "psm-key-ok\npsm-sudo-ok\n", stderr: "" };
    if (identity.endsWith("/deploy") && args.includes("lorenzo@46.101.14.20")) return { code: 0, stdout: "psm-key-ok\n", stderr: "" };
    return { code: 255, stdout: "", stderr: "root@46.101.14.20: Permission denied (publickey)." };
  };
  const results = await testKeys({ host: "46.101.14.20", knownHosts: "46.101.14.20 ssh-ed25519 AAAA", users: ["root", "lorenzo"], keys: [key("deploy"), key("locked", true), key("mesh")] }, exec);
  assert.equal(pinned.trim(), "46.101.14.20 ssh-ed25519 AAAA");
  for (const args of calls) {
    for (const option of ["BatchMode=yes", "IdentitiesOnly=yes", "IdentityAgent=none", "StrictHostKeyChecking=yes", "PasswordAuthentication=no"]) assert.ok(args.includes(option), option);
  }
  assert.equal(calls.length, 4, "the passphrase key is never offered");
  assert.deepEqual(results.map(r => [r.key, r.user, r.outcome, r.sudo]), [
    ["deploy", "root", "refused", false], ["deploy", "lorenzo", "works", false],
    ["locked", "root", "passphrase", false], ["locked", "lorenzo", "passphrase", false],
    ["mesh", "root", "works", true], ["mesh", "lorenzo", "refused", false],
  ]);
  assert.deepEqual(nextStep(results), { kind: "use-key", key: "mesh", user: "root" });
});

test("a changed host key or an unreachable server stops the search at once", async () => {
  const mismatch: Run = async () => ({ code: 255, stdout: "", stderr: "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed." });
  const stopped = await testKeys({ host: "h", knownHosts: "h ssh-ed25519 AAAA", users: ["root"], keys: [key("a"), key("b")] }, mismatch);
  assert.equal(stopped.length, 1);
  assert.deepEqual(nextStep(stopped), { kind: "fix-host-key" });
  const down: Run = async () => ({ code: 255, stdout: "", stderr: "ssh: connect to host h port 22: Connection timed out" });
  assert.deepEqual(nextStep(await testKeys({ host: "h", knownHosts: "h ssh-ed25519 AAAA", users: ["root"], keys: [key("a"), key("b")] }, down)), { kind: "unreachable" });
});

test("no working key always ends in creating one; a login without sudo says so", () => {
  const refused = (k: string): KeyTest => ({ key: k, fingerprint: "", user: "root", outcome: "refused", sudo: false, detail: "" });
  assert.deepEqual(nextStep([refused("a"), refused("b")]), { kind: "create-key" });
  assert.deepEqual(nextStep([]), { kind: "create-key" });
  assert.deepEqual(nextStep([refused("a"), { ...refused("b"), user: "lorenzo", outcome: "works" }]), { kind: "needs-sudo", key: "b", user: "lorenzo" });
});
