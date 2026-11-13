import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseKnownHost, type MachineIdentity } from "./plan.ts";
import { buildDeployAccessPlan, buildHelperInstallPlan, helperSourceDigest, type HelperBuild } from "./roles.ts";

const blob = (fill: number) => Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, fill)]).toString("base64");
const pinned = parseKnownHost(`203.0.113.4 ssh-ed25519 ${blob(7)}`, "203.0.113.4", 22);
const machine: MachineIdentity = { id: "mch_test", name: "alpha", host: "203.0.113.4", port: 22, knownHost: pinned.knownHost, hostKeyFingerprint: pinned.fingerprint, hostKeySource: "operator-confirmed" };
const build: HelperBuild = { arch: "x86_64", sha256: "a".repeat(64), bytes: 1234, sourceDigest: "b".repeat(64), file: "/nonexistent" };

function deploy(overrides: Partial<Parameters<typeof buildDeployAccessPlan>[0]> = {}) {
  return buildDeployAccessPlan({
    machine, projectId: "prj_todo", projectName: "Todo", environmentId: "staging", risk: "staging", unitId: "web",
    hostname: "todo.example.com", certbotEmail: "ops@example.com",
    infraPublicKey: `ssh-ed25519 ${blob(1)}`, releasePublicKey: `ssh-ed25519 ${blob(2)}`, now: 1, ...overrides,
  });
}

const syntax = (script: string) => spawnSync("bash", ["-n"], { input: script });

test("the helper install plan pins the build and its generated script parses", () => {
  const plan = buildHelperInstallPlan({ machine, build, now: 1 });
  assert.equal(syntax(plan.script).status, 0, syntax(plan.script).stderr.toString());
  assert.match(plan.script, new RegExp(`readonly PSM_HELPER_SHA256='${"a".repeat(64)}'`));
  assert.ok(plan.operations.some((line) => line.includes("aaaaaaaaaaaaaaaa")));
  assert.notEqual(plan.digest, buildHelperInstallPlan({ machine, build: { ...build, sha256: "c".repeat(64) }, now: 1 }).digest);
  assert.match(helperSourceDigest(), /^[0-9a-f]{64}$/);
});

test("deploy identities are distinct per role and project, and keys are forced to the helper client", () => {
  const plan = deploy();
  assert.equal(syntax(plan.script).status, 0, syntax(plan.script).stderr.toString());
  assert.match(plan.account, /^psm-i-todo-staging-[0-9a-f]{6}$/);
  assert.match(plan.release.account, /^psm-r-todo-staging-[0-9a-f]{6}$/);
  assert.notEqual(deploy({ projectId: "prj_api" }).account, plan.account);
  assert.equal(plan.target.canonicalRoot, "/var/www/todo.example.com");
  assert.equal(plan.target.targetId, "psm:prj_todo:staging:web");
  assert.match(plan.script, /command="\/usr\/local\/libexec\/psm-host-helper-client",restrict ssh-ed25519/);
  const contract = JSON.parse(Buffer.from(/readonly PSM_CONTRACT_B64='([^']+)'/.exec(plan.script)![1], "base64").toString());
  assert.equal(contract.deployUid, "__INFRA_UID__");
  assert.deepEqual(contract.releaseUids, ["__RELEASE_UID__"]);
  assert.equal(contract.revision, plan.target.revision);
});

test("the certificate contact is required and never invented, and paths stay inside their root", () => {
  assert.throws(() => deploy({ certbotEmail: "" }), /certificate notices/);
  assert.throws(() => deploy({ certbotEmail: "not-an-email" }), /certificate notices/);
  assert.throws(() => deploy({ hostname: "203.0.113.4" }), /domain name/);
  assert.throws(() => deploy({ hostname: "todo.example.com; rm -rf /" }), /domain name/);
  assert.throws(() => deploy({ canonicalRoot: "/etc/nginx" }), /inside the allowed root/);
  assert.throws(() => deploy({ canonicalRoot: "/var/www/../etc" }), /canonical/);
  assert.throws(() => deploy({ machine: { ...machine, hostKeySource: "scanned-unverified" } }), /Confirm/);
});

test("administrator access is one dedicated account whose sudo rule is validated before install", async () => {
  const { buildAdminAccessPlan } = await import("./roles.ts");
  const plan = buildAdminAccessPlan({ machine, publicKey: `ssh-ed25519 ${blob(3)}`, now: 1 });
  assert.equal(syntax(plan.script).status, 0, syntax(plan.script).stderr.toString());
  assert.match(plan.account, /^psm-a-psm-admin-[0-9a-f]{6}$/);
  assert.equal(plan.sudoersFile, `/etc/sudoers.d/${plan.account}`);
  assert.match(plan.script, new RegExp(`readonly PSM_SUDOERS_LINE='${plan.account} ALL=\\(ALL\\) NOPASSWD:ALL'`));
  assert.match(plan.script, /visudo -cf "\$staged"/);
  assert.match(plan.script, /printf '%s\\n' "\$PSM_SUDOERS_LINE"/);
  assert.ok(plan.authority[0].startsWith("Full administration"), "the plan says plainly what it grants");
});

test("a replacement is named by exact digest in both the plan and its script", () => {
  const plain = buildHelperInstallPlan({ machine, build, now: 1 });
  assert.equal(plain.replaces, undefined);
  assert.match(plain.script, /readonly PSM_REPLACE_BINARY=''/);
  const upgrade = buildHelperInstallPlan({ machine, build, replaces: { binary: "d".repeat(64) }, now: 1 });
  assert.equal(syntax(upgrade.script).status, 0, syntax(upgrade.script).stderr.toString());
  assert.deepEqual(upgrade.replaces, { binary: "d".repeat(64) });
  assert.match(upgrade.script, new RegExp(`readonly PSM_REPLACE_BINARY='${"d".repeat(64)}'`));
  assert.match(upgrade.operations[0], /^Replace the installed \/usr\/local\/libexec\/psm-host-helper \(sha256 dddddddddddddddd…\)/);
  assert.notEqual(upgrade.digest, plain.digest);
  assert.throws(() => buildHelperInstallPlan({ machine, build, replaces: { binary: "*" }, now: 1 }), /SHA-256/);

  const adopt = deploy({ replacesTarget: "e".repeat(64) });
  assert.equal(syntax(adopt.script).status, 0, syntax(adopt.script).stderr.toString());
  assert.equal(adopt.target.replaces, "e".repeat(64));
  assert.match(adopt.operations[0], /which names other accounts; those accounts lose access/);
  assert.equal(adopt.target.revision, deploy().target.revision, "replacing changes what may be overwritten, not the contract");
  assert.equal(deploy().publicKey, `ssh-ed25519 ${blob(1)}`);
  assert.throws(() => deploy({ replacesTarget: "abc" }), /SHA-256/);
});

test("reviewed retarget plan pins and archives only the inactive old contract", () => {
  const old = deploy();
  const repair = deploy({ targetId: "example:todo-staging-web", retireTarget: {
    targetId: old.target.targetId, file: old.target.file, digest: "d".repeat(64), root: old.target.canonicalRoot,
  } });
  assert.equal(syntax(repair.script).status, 0, syntax(repair.script).stderr.toString());
  assert.match(repair.script, /retire-target-changed/);
  assert.match(repair.script, /retire-target-active/);
  assert.match(repair.script, /mv -- "\$PSM_RETIRE_TARGET_FILE"/);
  assert.ok(repair.operations.some((line) => line.includes("archive inactive target")));
  assert.throws(() => deploy({ targetId: "example:todo-staging-web", retireTarget: { targetId: old.target.targetId, file: "/tmp/other", digest: "d".repeat(64), root: old.target.canonicalRoot } }), /file does not match/);
  assert.throws(() => deploy({ targetId: "example:todo-staging-web", retireTarget: { targetId: old.target.targetId, file: old.target.file, digest: "bad", root: old.target.canonicalRoot } }), /SHA-256/);
});

test("a CI release key extends exactly the release account the deploy plan created", async () => {
  const { buildReleaseCiKeyPlan, releaseAuthorizedLine } = await import("./roles.ts");
  const base = deploy();
  const plan = buildReleaseCiKeyPlan({ machine, deployAccessId: "mac_1", deploy: base, ciPublicKey: `ssh-ed25519 ${blob(9)}`, label: "psm-ci Todo staging", now: 1 });
  assert.equal(syntax(plan.script).status, 0, syntax(plan.script).stderr.toString());
  assert.equal(plan.account, base.release.account);
  assert.match(releaseAuthorizedLine(base), /^command="\/usr\/local\/libexec\/psm-host-helper-client",restrict ssh-ed25519 /);
  assert.ok(plan.script.includes(`readonly PSM_RELEASE_AUTHORIZED='${releaseAuthorizedLine(base)}'`));
  assert.match(plan.script, new RegExp(`readonly PSM_CI_AUTHORIZED='command="/usr/local/libexec/psm-host-helper-client",restrict ssh-ed25519 ${blob(9).replace(/[+/]/g, "\\$&")} psm-ci-Todo-staging'`));
  assert.equal(plan.target.targetId, base.target.targetId);
});

test("a Node service target gets its own no-login account, a /srv root and a contract service block", () => {
  const service = { entry: "bin/www", healthPath: "/healthz", startupTimeoutSeconds: 20, memoryMaxMb: 256 };
  const plan = deploy({ hostname: "handyman-staging.example.com", projectName: "handymanservices", service });
  assert.equal(syntax(plan.script).status, 0);
  assert.equal(plan.target.canonicalRoot, "/srv/handyman-staging.example.com");
  assert.equal(plan.target.allowedRootPrefix, "/srv");
  // A Linux account name, so at most 32 characters: the readable part is shortened.
  assert.match(plan.target.service!.account, /^psm-s-handymanservices-[a-z0-9-]*[0-9a-f]{6}$/);
  assert.ok(plan.target.service!.account.length <= 32);
  assert.equal(plan.target.service!.unitName, plan.target.service!.account.replace("psm-s-", "psm-svc-"));
  assert.deepEqual({ ...plan.target.service, account: undefined, unitName: undefined }, { ...service, account: undefined, unitName: undefined });
  const contract = JSON.parse(Buffer.from(/readonly PSM_CONTRACT_B64='([A-Za-z0-9+/=]+)'/.exec(plan.script)![1], "base64").toString());
  assert.deepEqual(contract.service, {
    unitName: plan.target.service!.unitName, user: plan.target.service!.account, uid: "__SERVICE_UID__", gid: "__SERVICE_GID__", port: "__SERVICE_PORT__",
    memoryMaxMb: 256, entry: "bin/www", healthPath: "/healthz", startupTimeoutSeconds: 20, systemdDir: "/etc/systemd/system", configDir: "/etc/psm-deploy/services",
  });
  assert.match(plan.script, /--shell \/usr\/sbin\/nologin/);
  assert.ok(plan.operations.some((line) => line.includes("outside psm-deploy")));
  // A static target is unchanged.
  const staticPlan = deploy();
  assert.equal(staticPlan.target.service, undefined);
  assert.equal(staticPlan.target.canonicalRoot, "/var/www/todo.example.com");
  assert.ok(!Buffer.from(/readonly PSM_CONTRACT_B64='([A-Za-z0-9+/=]+)'/.exec(staticPlan.script)![1], "base64").toString().includes("service"));
  assert.throws(() => deploy({ service: { ...service, entry: "../bin/sh" } }), /entry point/);
  assert.throws(() => deploy({ service: { ...service, memoryMaxMb: 8192 } }), /memory limit/);
});

test("the enrollment script keeps a target's ports and otherwise picks free, unclaimed ones", () => {
  const plan = deploy({ service: { entry: "bin/www", healthPath: "/healthz", startupTimeoutSeconds: 20, memoryMaxMb: 256, switching: "health-checked", drainSeconds: 10 } });
  assert.equal(syntax(plan.script).status, 0);
  const contract = JSON.parse(Buffer.from(/readonly PSM_CONTRACT_B64='([A-Za-z0-9+/=]+)'/.exec(plan.script)![1], "base64").toString());
  assert.equal(contract.service.alternatePort, "__SERVICE_ALT_PORT__");
  assert.equal(contract.service.drainSeconds, 10);
  assert.match(plan.script, /readonly PSM_SERVICE_SWITCHING='yes'/);
  assert.throws(() => deploy({ service: { entry: "bin/www", healthPath: "/healthz", startupTimeoutSeconds: 20, memoryMaxMb: 256, drainSeconds: 10 } }), /drain time/);
  const fn = /service_port\(\) \{[\s\S]*?\n\}\n/.exec(plan.script)![0];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "psm-port-"));
  const targets = path.join(directory, "targets");
  fs.mkdirSync(targets);
  const run = (targetFile: string, args: string) => spawnSync("bash", ["-c", `set -euo pipefail\nPSM_TARGET_FILE=${targetFile}\nPSM_TARGETS_DIR=${targets}\n${fn}\nservice_port ${args}`], { encoding: "utf8" });
  const enrolled = path.join(directory, "target.json");
  fs.writeFileSync(enrolled, `{\n  "service": {\n    "port": 41007,\n    "alternatePort": 41012,\n    "user": "x"\n  }\n}\n`);
  assert.equal(run(enrolled, "port").stdout, "41007", "a re-enrolled target keeps its port");
  assert.equal(run(enrolled, "alternatePort 41007").stdout, "41012", "and its second port");
  // Ports other contracts claim are skipped even while nothing listens on them.
  const free = (port: number) => spawnSync("bash", ["-c", `ss -Htln "sport = :${port}" | grep -q .`]).status !== 0;
  const [first, second, third] = Array.from({ length: 1000 }, (_, index) => 41000 + index).filter(free);
  fs.writeFileSync(path.join(targets, "other.json"), `{\n  "service": {\n    "port": ${first},\n    "alternatePort": ${second}\n  }\n}\n`);
  const absent = path.join(directory, "absent.json");
  assert.equal(run(absent, "port").stdout, String(third));
  assert.equal(run(absent, `alternatePort ${third}`).stdout, String(Array.from({ length: 1000 }, (_, index) => 41000 + index).filter(free).filter((port) => ![first, second, third].includes(port))[0]), "the second port is never the first");
  const single = deploy({ service: { entry: "bin/www", healthPath: "/healthz", startupTimeoutSeconds: 20, memoryMaxMb: 256 } });
  assert.match(single.script, /readonly PSM_SERVICE_SWITCHING='no'/);
  assert.ok(!Buffer.from(/readonly PSM_CONTRACT_B64='([A-Za-z0-9+/=]+)'/.exec(single.script)![1], "base64").toString().includes("alternatePort"));
});
