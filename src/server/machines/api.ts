/**
 * HTTP surface for machines. Reads and changes both go through workspace
 * authority; every change is additionally local-cockpit-only for now, like the
 * rest of deployment authority, until the hosted control service (P03) can
 * authorize operators on its own.
 */
import express, { type Request, type Response } from "express";

import { MachinePlanError } from "./plan.ts";
import { MachineServiceError, type MachineProject, type MachineService } from "./service.ts";
import { MachineTransportError } from "./ssh.ts";
import { MachineStoreError } from "./store.ts";

export interface MachineApiOptions {
  service: MachineService;
  localRequest: (req: Request) => boolean;
  /** Resolve a project by stable id, with the workspace it belongs to. */
  project: (id: string) => MachineProject | null;
  /** May the caller manage this workspace's machines right now? */
  authorize: (workspaceId: string) => Promise<{ ok: true } | { ok: false; status: number; error: string }>;
  actor: () => string;
}

function fail(res: Response, error: unknown) {
  if (error instanceof MachineServiceError || error instanceof MachineStoreError) return res.status(error.status).json({ error: error.message, code: error.code });
  if (error instanceof MachinePlanError) return res.status(400).json({ error: error.message, code: "invalid", field: error.field });
  if (error instanceof MachineTransportError) return res.status(502).json({ error: error.message, code: error.code });
  return res.status(500).json({ error: error instanceof Error ? error.message : String(error), code: "unexpected" });
}

export function machineRouter(options: MachineApiOptions): express.Router {
  const router = express.Router();
  const { service } = options;

  /** Resolve and authorize the workspace a request acts in. */
  const workspace = async (req: Request, res: Response, change: boolean): Promise<string | null> => {
    if (change && !options.localRequest(req)) {
      res.status(403).json({ error: "Change machine access from the local cockpit.", code: "local-authority-required" });
      return null;
    }
    const ref = String(req.query.workspace || req.body?.workspace || "personal").toLowerCase();
    const verdict = await options.authorize(ref);
    if (!verdict.ok) {
      res.status(verdict.status).json({ error: verdict.error, code: "workspace-authority" });
      return null;
    }
    return ref;
  };
  const route = (change: boolean, handler: (req: Request, res: Response, workspaceId: string) => Promise<unknown> | unknown) =>
    async (req: Request, res: Response) => {
      try {
        const workspaceId = await workspace(req, res, change);
        if (workspaceId === null) return;
        await handler(req, res, workspaceId);
      } catch (error) { fail(res, error); }
    };
  const revision = (req: Request) => Number(req.body?.revision);

  router.get("/api/machines", route(false, (_req, res, ws) => res.json({ machines: service.listMachines(ws) })));
  router.post("/api/machines/discover", route(true, async (req, res) => res.json(await service.discover(req.body?.host, req.body?.port))));
  router.post("/api/machines", route(true, (req, res, ws) => {
    const machine = service.register({ workspaceId: ws, name: req.body?.name, host: req.body?.host, port: req.body?.port, knownHost: req.body?.knownHost, confirmFingerprint: req.body?.confirmFingerprint, fromConnectionId: req.body?.fromConnectionId });
    res.status(201).json({ machine: service.getMachine(machine.id, ws) });
  }));
  router.get("/api/machines/:id", route(false, (req, res, ws) => res.json({ machine: service.getMachine(req.params.id, ws) })));
  router.post("/api/machines/:id/confirm-host-key", route(true, (req, res, ws) => {
    service.confirmHostKey(req.params.id, ws, revision(req), req.body?.fingerprint);
    res.json({ machine: service.getMachine(req.params.id, ws) });
  }));
  router.put("/api/machines/:id/admin-connection", route(true, (req, res, ws) => {
    service.setAdminConnection(req.params.id, ws, revision(req), req.body?.connectionId ?? null);
    res.json({ machine: service.getMachine(req.params.id, ws) });
  }));
  router.delete("/api/machines/:id", route(true, (req, res, ws) => {
    service.remove(req.params.id, ws, revision(req));
    res.json({ ok: true });
  }));
  router.post("/api/machines/:id/inspect", route(true, async (req, res, ws) => res.json({ report: await service.inspect(req.params.id, ws) })));

  router.post("/api/machines/:id/access", route(true, async (req, res, ws) => {
    const project = options.project(String(req.body?.projectId || ""));
    if (!project) return res.status(404).json({ error: "Project not found.", code: "project-not-found" });
    const access = await service.planCommandAccess({ machineId: req.params.id, workspaceId: ws, project, environmentId: req.body?.environmentId, risk: req.body?.risk });
    res.status(201).json({ access: service.accessView(access) });
  }));
  router.post("/api/machines/:id/helper", route(true, async (req, res, ws) => {
    const access = await service.planHelperInstall({ machineId: req.params.id, workspaceId: ws });
    res.status(201).json({ access: service.accessView(access) });
  }));
  router.post("/api/machines/:id/admin-access", route(true, async (req, res, ws) => {
    const access = await service.planAdminAccess({ machineId: req.params.id, workspaceId: ws });
    res.status(201).json({ access: service.accessView(access) });
  }));
  router.post("/api/machine-access/:id/release", route(true, async (req, res, ws) => res.json({ access: service.accessView(await service.releaseAdminAccess(req.params.id, ws)) })));
  router.post("/api/machine-setup-jobs/:id/probe", route(true, async (req, res, ws) => {
    await service.probeManualSetup(req.params.id, ws);
    res.json({ job: service.getJob(req.params.id, ws) });
  }));
  router.post("/api/machines/:id/deploy-access", route(true, async (req, res, ws) => {
    const project = options.project(String(req.body?.projectId || ""));
    if (!project) return res.status(404).json({ error: "Project not found.", code: "project-not-found" });
    const access = await service.planDeployAccess({
      machineId: req.params.id, workspaceId: ws, project, environmentId: req.body?.environmentId, risk: req.body?.risk, unitId: req.body?.unitId,
      targetId: req.body?.targetId, hostname: req.body?.hostname, certbotEmail: req.body?.certbotEmail, canonicalRoot: req.body?.canonicalRoot, allowedRootPrefix: req.body?.allowedRootPrefix,
    });
    res.status(201).json({ access: service.accessView(access) });
  }));
  router.get("/api/machine-access/:id", route(false, (req, res, ws) => res.json({ access: service.accessView(service.getAccess(req.params.id, ws)) })));
  router.get("/api/machine-access/:id/script", route(false, (req, res, ws) => res.json(service.setupScript(req.params.id, ws))));
  router.post("/api/machine-access/:id/revoke", route(true, async (req, res, ws) => res.json({ access: service.accessView(await service.revokeAccess(req.params.id, ws, revision(req))) })));
  router.post("/api/machine-access/:id/setup", route(true, (req, res, ws) => {
    const job = service.startSetup({ accessId: req.params.id, workspaceId: ws, planDigest: req.body?.planDigest, method: req.body?.method, actor: options.actor() });
    res.status(202).json({ job: service.getJob(job.id, ws) });
  }));

  router.get("/api/machine-setup-jobs/:id", route(false, (req, res, ws) => res.json({ job: service.getJob(req.params.id, ws) })));
  router.post("/api/machine-setup-jobs/:id/retry", route(true, (req, res, ws) => {
    const job = service.retry(req.params.id, ws);
    res.status(202).json({ job: service.getJob(job.id, ws) });
  }));
  router.post("/api/machine-setup-jobs/:id/cancel", route(true, (req, res, ws) => {
    service.cancel(req.params.id, ws);
    res.json({ job: service.getJob(req.params.id, ws) });
  }));
  router.post("/api/machine-setup-jobs/:id/confirm", route(true, async (req, res, ws) => {
    await service.confirmManualSetup(req.params.id, ws);
    res.json({ job: service.getJob(req.params.id, ws) });
  }));
  return router;
}
