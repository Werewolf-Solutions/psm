/**
 * Control service + runner + real Docker, end to end. Opt in with
 * PSM_RUNNER_DOCKER=1; needs node:22-bookworm-slim and alpine/git:2.47.2 pulled.
 * The checkout case clones a small public GitHub repository.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { controlApp } from "../control/api.ts";
import { DevelopmentVerifier } from "../control/auth.ts";
import { SecretSealer } from "../control/crypto.ts";
import { openControlDatabase } from "../control/db.ts";
import { ControlService, LEASE_MS } from "../control/service.ts";
import { DockerBackend } from "./backend.ts";
import { ControlClient, loadOrRegister, Runner } from "./runner.ts";

const enabled = process.env.PSM_RUNNER_DOCKER === "1";
const WS = "user:alice";

test("jobs run isolated in Docker, survive a runner dying, and never leak secrets", { skip: !enabled && "set PSM_RUNNER_DOCKER=1" }, async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "psm-runner-test-"));
  const database = openControlDatabase(":memory:");
  let clock = Date.now();
  const service = new ControlService(database, new SecretSealer(randomBytes(32)), () => clock);
  const verifier = new DevelopmentVerifier({ "alice-token-000000": { subject: "alice", workspaces: { [WS]: "owner" } } });
  const server = controlApp({ service, verifier }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => { server.close(); database.close(); fs.rmSync(data, { recursive: true, force: true }); });
  const api = async (method: string, pathname: string, body?: unknown) => {
    const response = await fetch(`${base}${pathname}`, { method, headers: { Authorization: "Bearer alice-token-000000", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };

  // A person registers a runner; the runner exchanges the one-time token for its credential.
  const registration = await api("POST", `/api/v1/workspaces/${encodeURIComponent(WS)}/runner-registrations`);
  assert.equal(registration.status, 201);
  const identity = await loadOrRegister({ file: path.join(data, "runner.json"), controlUrl: base, registrationToken: registration.body.token, name: "test", capabilities: { images: ["node:22-bookworm-slim", "alpine/git:2.47.2"], backend: "docker" } });
  assert.equal((fs.statSync(path.join(data, "runner.json")).mode & 0o777), 0o600);
  const backend = new DockerBackend({ runnerId: identity.runnerId, workRoot: data });
  const runner = () => new Runner(new ControlClient(identity), backend, () => undefined, { idleMs: 100, heartbeatMs: 500, flushMs: 100 });

  await api("PUT", `/api/v1/workspaces/${encodeURIComponent(WS)}/secrets/DEPLOY_TOKEN`, { value: "s3cr3t-value-1234" });
  const events = async (jobId: string) => (await api("GET", `/api/v1/workspaces/${encodeURIComponent(WS)}/jobs/${jobId}/events`)).body.events.map((event: any) => event.text).join("\n");
  const state = async (jobId: string) => (await api("GET", `/api/v1/workspaces/${encodeURIComponent(WS)}/jobs/${jobId}`)).body.job;

  // 1. Isolation: no network, no privileges, secrets usable but redacted in output.
  const isolated = await api("POST", `/api/v1/workspaces/${encodeURIComponent(WS)}/jobs`, {
    kind: "command", title: "isolation", image: "node:22-bookworm-slim", secrets: [{ name: "DEPLOY_TOKEN", env: "TOKEN" }],
    steps: [
      "echo token=$TOKEN; test \"$TOKEN\" = s3cr3t-value-1234 && echo token-ok",
      "id -u; grep CapEff /proc/self/status",
      "node -e \"fetch('https://example.com').then(()=>console.log('network=yes'),()=>console.log('network=no'))\"",
      "touch /etc/x 2>/dev/null && echo rootfs=writable || echo rootfs=readonly",
      "echo data > /work/out.txt && cat /work/out.txt",
      "test ! -S /var/run/docker.sock && echo no-docker-socket",
    ],
  });
  assert.equal(isolated.status, 201, JSON.stringify(isolated.body));
  assert.equal(await runner().once(), true);
  const isolatedJob = await state(isolated.body.job.id);
  const isolatedLog = await events(isolated.body.job.id);
  assert.equal(isolatedJob.state, "succeeded", isolatedLog);
  assert.match(isolatedLog, /token=\[redacted\]/);
  assert.ok(!isolatedLog.includes("s3cr3t-value-1234"), "the secret value never reaches the log");
  assert.match(isolatedLog, /token-ok/);
  assert.match(isolatedLog, /CapEff:\s+0000000000000000/);
  assert.match(isolatedLog, /network=no/);
  assert.match(isolatedLog, /rootfs=readonly/);
  assert.match(isolatedLog, /no-docker-socket/);
  assert.match(isolatedLog, new RegExp(`^${process.getuid!()}$`, "m"), "runs as the runner's unprivileged uid");

  // 2. A failing step fails the job.
  const failing = await api("POST", `/api/v1/workspaces/${encodeURIComponent(WS)}/jobs`, { kind: "command", title: "fails", image: "node:22-bookworm-slim", steps: ["echo before", "exit 7", "echo never"] });
  await runner().once();
  const failed = await state(failing.body.job.id);
  assert.equal(failed.state, "failed");
  assert.equal(failed.result.exitCode, 7);
  assert.ok(!(await events(failing.body.job.id)).includes("never"));

  // 3. The runner dies mid-job: a non-idempotent job becomes uncertain, an idempotent one runs again.
  for (const idempotent of [false, true]) {
    const long = await api("POST", `/api/v1/workspaces/${encodeURIComponent(WS)}/jobs`, { kind: "command", title: `long ${idempotent}`, image: "node:22-bookworm-slim", idempotent, steps: ["sleep 30"] });
    const dying = runner();
    const running = dying.once();
    for (let i = 0; i < 50 && (await state(long.body.job.id)).state !== "running"; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await state(long.body.job.id)).state, "running");
    // Simulate a crash: the process is gone, nothing completes; a new runner cleans up containers.
    (dying as any).client = { call: async () => ({ status: 0, data: null }) };
    dying.stop();
    await running.catch(() => undefined);
    assert.equal(await backend.cleanup(), 0, "stop() already killed the container");
    clock += LEASE_MS + 1;
    service.sweep();
    const after = await state(long.body.job.id);
    assert.equal(after.state, idempotent ? "queued" : "uncertain", JSON.stringify(after));
    if (idempotent) {
      await api("POST", `/api/v1/workspaces/${encodeURIComponent(WS)}/jobs/${long.body.job.id}/cancel`);
    } else {
      assert.equal((await api("POST", `/api/v1/workspaces/${encodeURIComponent(WS)}/jobs/${long.body.job.id}/retry`, {})).status, 400, "retrying needs an explicit confirmation");
      await api("POST", `/api/v1/workspaces/${encodeURIComponent(WS)}/jobs/${long.body.job.id}/cancel`);
    }
  }

  // 3b. A hard crash (SIGKILL) leaves the container running; the next start stops it.
  const { execFileSync } = await import("node:child_process");
  execFileSync("docker", ["run", "-d", "--rm", "--label", `psm.runner=${identity.runnerId}`, "--network", "none", "--entrypoint", "sleep", "node:22-bookworm-slim", "60"]);
  assert.equal(await backend.cleanup(), 1);
  assert.equal(execFileSync("docker", ["ps", "-q", "--filter", `label=psm.runner=${identity.runnerId}`], { encoding: "utf8" }).trim(), "");

  // 4. Checkout: clone a public repository with egress only for the clone, then run without network.
  const checkout = await api("POST", `/api/v1/workspaces/${encodeURIComponent(WS)}/jobs`, {
    kind: "command", title: "checkout", image: "node:22-bookworm-slim",
    checkout: { repository: "https://github.com/octocat/Hello-World.git", ref: "master" },
    steps: ["ls", "cat README"],
  });
  await runner().once();
  const checkoutLog = await events(checkout.body.job.id);
  assert.equal((await state(checkout.body.job.id)).state, "succeeded", checkoutLog);
  assert.match(checkoutLog, /checked out [0-9a-f]{40}/);
  assert.match(checkoutLog, /Hello World!/);
  assert.deepEqual(fs.readdirSync(data).filter((entry) => entry.startsWith("job_")), [], "job directories are removed");
});
