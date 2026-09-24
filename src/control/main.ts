/**
 * psm-control: the hosted control service.
 *
 * Configuration (environment):
 *   PSM_CONTROL_PORT          listen port (default 4420)
 *   PSM_CONTROL_HOST          bind address (default 127.0.0.1; put a TLS proxy in front for public use)
 *   PSM_CONTROL_DATA          data directory (default ./.psm-control)
 *   PSM_CONTROL_MASTER_KEY    base64 32-byte key; otherwise <data>/master.key is created (0600)
 *   PSM_WEREWOLF_API          Werewolf API base, e.g. http://localhost:3000/api/v1
 *   PSM_CONTROL_ORIGINS       comma-separated browser origins allowed to call /api/v1
 *   PSM_CONTROL_DEV_AUTH=1 + PSM_CONTROL_DEV_TOKENS   fixed tokens, loopback only
 */
import path from "node:path";

import { controlApp } from "./api.ts";
import { DevelopmentVerifier, WerewolfVerifier, type Verifier } from "./auth.ts";
import { SecretSealer } from "./crypto.ts";
import { openControlDatabase } from "./db.ts";
import { ControlService } from "./service.ts";

const port = Number(process.env.PSM_CONTROL_PORT || 4420);
const host = process.env.PSM_CONTROL_HOST || "127.0.0.1";
const data = path.resolve(process.env.PSM_CONTROL_DATA || ".psm-control");
const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";

let verifier: Verifier | null = DevelopmentVerifier.fromEnvironment();
if (verifier && !loopback) {
  console.error("psm-control: development tokens are refused on a non-loopback bind.");
  process.exit(1);
}
if (!verifier) {
  if (!process.env.PSM_WEREWOLF_API) {
    console.error("psm-control: set PSM_WEREWOLF_API (or PSM_CONTROL_DEV_AUTH for local development).");
    process.exit(1);
  }
  verifier = new WerewolfVerifier(process.env.PSM_WEREWOLF_API);
}

const database = openControlDatabase(path.join(data, "control.db"));
const service = new ControlService(database, SecretSealer.fromEnvironment(path.join(data, "master.key")));
const app = controlApp({ service, verifier, allowedOrigins: (process.env.PSM_CONTROL_ORIGINS || "").split(",").map((entry) => entry.trim()).filter(Boolean) });

const sweep = setInterval(() => {
  try {
    const { requeued, uncertain } = service.sweep();
    if (requeued.length || uncertain.length) console.log(`psm-control: lapsed leases — requeued ${requeued.length}, uncertain ${uncertain.length}`);
  } catch (error) { console.error("psm-control: sweep failed", error); }
}, 5_000);
sweep.unref();

const server = app.listen(port, host, () => console.log(`psm-control on http://${host}:${port} (${verifier instanceof DevelopmentVerifier ? "development tokens" : "Werewolf identity"})`));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { server.close(); database.close(); process.exit(0); });
