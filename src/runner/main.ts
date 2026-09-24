/**
 * psm-runner entry point.
 *
 *   PSM_CONTROL_URL         control service base URL (required)
 *   PSM_RUNNER_REGISTRATION one-time registration token (first start only)
 *   PSM_RUNNER_DATA         data directory (default ~/.config/psm-runner)
 *   PSM_RUNNER_IMAGES       comma-separated images this runner offers
 *                           (default node:22-bookworm-slim,alpine/git:2.47.2)
 *   PSM_RUNNER_NAME         display name
 */
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { DockerBackend, defaultWorkRoot } from "./backend.ts";
import { ControlClient, defaultRunnerName, loadOrRegister, Runner } from "./runner.ts";

const controlUrl = process.env.PSM_CONTROL_URL;
if (!controlUrl) { console.error("psm-runner: set PSM_CONTROL_URL"); process.exit(1); }
const data = process.env.PSM_RUNNER_DATA || path.join(os.homedir(), ".config", "psm-runner");
const images = (process.env.PSM_RUNNER_IMAGES || "node:22-bookworm-slim,alpine/git:2.47.2").split(",").map((entry) => entry.trim()).filter(Boolean);

// Only offer images that are present; jobs run with --pull never.
const present = images.filter((image) => {
  try { execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" }); return true; }
  catch { console.warn(`psm-runner: ${image} is not present; pull it to offer it`); return false; }
});

const identity = await loadOrRegister({
  file: path.join(data, "runner.json"), controlUrl, registrationToken: process.env.PSM_RUNNER_REGISTRATION,
  name: process.env.PSM_RUNNER_NAME || defaultRunnerName(),
  capabilities: { images: present, backend: "docker", version: "1" },
});
console.log(`psm-runner ${identity.runnerId} for ${identity.workspaceId} → ${identity.controlUrl}`);
const runner = new Runner(new ControlClient(identity), new DockerBackend({ runnerId: identity.runnerId, workRoot: defaultWorkRoot() }));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => runner.stop());
await runner.loop();
