/**
 * The control service's HTTP API. Three audiences, three prefixes:
 *
 * - /api/v1     people, with a Werewolf bearer token, acting in a workspace
 *               they currently belong to;
 * - /runner/v1  runners, with their own credential, only for their workspace;
 * - /enroll/v1  a machine presenting a single-use setup intent token.
 *
 * Nothing here is served from, or trusts, the local cockpit's loopback API.
 * No cookies are used, so there is no ambient authority for a browser to be
 * tricked into spending: every request carries its credential explicitly.
 */
import express, { type NextFunction, type Request, type Response } from "express";

import { AuthError, type Principal, type Verifier } from "./auth.ts";
import { ControlError, type ControlService, type RunnerRecord } from "./service.ts";

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;

function bearer(req: Request): string {
  const header = String(req.headers.authorization ?? "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function fail(res: Response, error: unknown): void {
  if (error instanceof AuthError) { res.status(error.status).json({ error: error.message, code: error.status === 401 ? "unauthenticated" : error.status === 503 ? "identity-unavailable" : "forbidden" }); return; }
  if (error instanceof ControlError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
  console.error("[psm-control]", error);
  res.status(500).json({ error: "Unexpected control service error.", code: "unexpected" });
}

export function controlApp(options: { service: ControlService; verifier: Verifier; allowedOrigins?: readonly string[]; fetchImpl?: typeof fetch }): express.Express {
  const { service, verifier } = options;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(express.json({ limit: "1mb" }));
  // Browsers on the hosted page may call /api/v1; nothing else is cross-origin.
  app.use("/api/v1", (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && options.allowedOrigins?.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
    } else if (origin) {
      res.status(403).json({ error: "This origin may not call the control service.", code: "origin" }); return;
    }
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    next();
  });

  const user = (handler: (principal: Principal, req: Request, res: Response) => unknown | Promise<unknown>): Handler => async (req, res) => {
    try { await handler(await verifier.verify(bearer(req)), req, res); } catch (error) { fail(res, error); }
  };
  const runner = (handler: (runner: RunnerRecord, req: Request, res: Response) => unknown | Promise<unknown>): Handler => async (req, res) => {
    try { await handler(service.authenticateRunner(String(req.headers["x-psm-runner"] ?? ""), bearer(req)), req, res); } catch (error) { fail(res, error); }
  };
  const ws = (req: Request) => String(req.params.workspace);

  app.get("/healthz", (_req, res) => { res.json({ ok: true, service: "psm-control" }); });

  /* people */
  app.get("/api/v1/me", user((principal, _req, res) => res.json({ subject: principal.subject, name: principal.name, workspaces: [...principal.workspaces.values()] })));
  app.get("/api/v1/workspaces/:workspace/runners", user((principal, req, res) => res.json({ runners: service.listRunners(principal, ws(req)) })));
  app.post("/api/v1/workspaces/:workspace/runner-registrations", user((principal, req, res) => res.status(201).json(service.createRegistration(principal, ws(req), Number(req.body?.ttlMs) || undefined))));
  app.post("/api/v1/workspaces/:workspace/runners/:runner/revoke", user((principal, req, res) => res.json({ runner: service.revokeRunner(principal, ws(req), String(req.params.runner)) })));
  app.get("/api/v1/workspaces/:workspace/jobs", user((principal, req, res) => res.json({ jobs: service.listJobs(principal, ws(req)) })));
  app.post("/api/v1/workspaces/:workspace/jobs", user((principal, req, res) => res.status(201).json({ job: service.createJob(principal, ws(req), req.body) })));
  app.get("/api/v1/workspaces/:workspace/jobs/:job", user((principal, req, res) => res.json({ job: service.getJob(principal, ws(req), String(req.params.job)) })));
  app.get("/api/v1/workspaces/:workspace/jobs/:job/events", user((principal, req, res) => res.json({ events: service.events(principal, ws(req), String(req.params.job), Number(req.query.after) || 0) })));
  app.post("/api/v1/workspaces/:workspace/jobs/:job/cancel", user((principal, req, res) => res.json({ job: service.cancelJob(principal, ws(req), String(req.params.job)) })));
  app.post("/api/v1/workspaces/:workspace/jobs/:job/retry", user((principal, req, res) => {
    if (req.body?.confirm !== true) throw new ControlError("Confirm that you checked the previous attempt's effects.", 400, "confirm-required");
    res.json({ job: service.retryUncertain(principal, ws(req), String(req.params.job)) });
  }));
  app.get("/api/v1/workspaces/:workspace/secrets", user((principal, req, res) => res.json({ secrets: service.listSecrets(principal, ws(req)) })));
  app.put("/api/v1/workspaces/:workspace/secrets/:name", user((principal, req, res) => res.json(service.putSecret(principal, ws(req), req.params.name, req.body?.value, req.body?.kind))));
  app.delete("/api/v1/workspaces/:workspace/secrets/:name", user((principal, req, res) => { service.deleteSecret(principal, ws(req), String(req.params.name)); res.json({ ok: true }); }));
  app.post("/api/v1/workspaces/:workspace/secrets/:name/verify", user(async (principal, req, res) => res.json(await service.verifyProviderKey(principal, ws(req), String(req.params.name), options.fetchImpl))));
  app.post("/api/v1/workspaces/:workspace/enrollment-intents", user((principal, req, res) => res.status(201).json(service.createEnrollmentIntent(principal, ws(req), { purpose: req.body?.purpose, binding: req.body?.binding, ttlMs: Number(req.body?.ttlMs) || undefined }))));
  app.get("/api/v1/workspaces/:workspace/enrollment-intents/:intent", user((principal, req, res) => res.json(service.getEnrollmentIntent(principal, ws(req), String(req.params.intent)))));
  app.get("/api/v1/workspaces/:workspace/audit", user((principal, req, res) => res.json({ audit: service.audit(principal, ws(req)) })));

  /* runners */
  app.post("/runner/v1/register", async (req, res) => {
    try { res.status(201).json(service.registerRunner(bearer(req), { name: req.body?.name, capabilities: req.body?.capabilities })); } catch (error) { fail(res, error); }
  });
  app.post("/runner/v1/lease", runner((record, _req, res) => {
    const job = service.lease(record);
    if (!job) { res.status(204).end(); return; }
    res.json({ job: { id: job.id, attempt: job.attempts, spec: job.spec, leaseExpiresAt: job.leaseExpiresAt } });
  }));
  app.post("/runner/v1/jobs/:job/heartbeat", runner((record, req, res) => res.json(service.heartbeat(record, String(req.params.job), req.body?.started === true))));
  app.post("/runner/v1/jobs/:job/events", runner((record, req, res) => { service.appendEvents(record, String(req.params.job), req.body?.events); res.json({ ok: true }); }));
  app.post("/runner/v1/jobs/:job/secrets", runner((record, req, res) => res.json({ env: service.leaseSecrets(record, String(req.params.job)) })));
  app.post("/runner/v1/jobs/:job/complete", runner((record, req, res) => res.json({ job: { id: service.complete(record, String(req.params.job), req.body ?? {}).id } })));

  /* machines claiming a setup intent */
  app.post("/enroll/v1/intents/:intent/claim", async (req, res) => {
    try { res.json(service.claimEnrollmentIntent(String(req.params.intent), bearer(req), req.body)); } catch (error) { fail(res, error); }
  });

  app.use((_req, res) => { res.status(404).json({ error: "Not found.", code: "not-found" }); });
  return app;
}
