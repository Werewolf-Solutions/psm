import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
