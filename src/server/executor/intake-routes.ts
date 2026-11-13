/**
 * Tasks written in PSM itself (P17): create, edit and withdraw hub intake from
 * the Executor page, without going through Todo.
 *
 * The hub is the source of truth and does the real checks (the project is the
 * caller's and live, the intake is a PSM one, no job is under way). This side
 * only refuses what it can tell is wrong without a hub call, and turns the
 * browser's nonce into the hub's idempotency key.
 */
import crypto from "node:crypto";
import express from "express";

import type { Hub } from "./client.ts";

export const MAX_TASK_TEXT = 20_000;
const NONCE = /^[A-Za-z0-9_-]{8,64}$/;
const PROJECT_ID = /^prj_[a-z0-9]{1,64}$/i;
const INTAKE_ID = /^int_[0-9a-f]{24}$/;

export interface IntakeRouteOptions {
  /** True for the local cockpit, false for a paired remote origin. */
  isLocal: (req: express.Request) => boolean;
  signedIn: () => Promise<boolean>;
  hub: () => Pick<Hub, "createIntake" | "updateIntake" | "withdrawIntake">;
  /** The scanned projects; `id` is the `prj_` id from .psm/identity.json, when it has one. */
  projects: () => { id?: string | null; name: string }[];
  executorId: () => string;
}

/**
 * The hub key for one press of Add. The same nonce from the same machine is the
 * same key, so a double click or a retried request is one intake, not two.
 */
export function intakeKey(executorId: string, nonce: string): string {
  return `pst_${crypto.createHash("sha256").update(`${executorId}\n${nonce}`).digest("hex").slice(0, 24)}`;
}

type Refusal = { status: number; error: string };

function taskText(raw: unknown): string | Refusal {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { status: 400, error: "Write the task first." };
  if (text.length > MAX_TASK_TEXT) return { status: 400, error: `A task is at most ${MAX_TASK_TEXT} characters.` };
  return text;
}

/** A scanned project with a `prj_` id, by id or by folder name. */
function projectIdOf(options: IntakeRouteOptions, raw: unknown): string | Refusal {
  const wanted = typeof raw === "string" ? raw.trim() : "";
  if (!wanted) return { status: 400, error: "Choose a project." };
  const projects = options.projects();
  const project = projects.find((candidate) => candidate.id === wanted) ?? projects.find((candidate) => candidate.name === wanted);
  if (!project) return { status: 404, error: "psm does not know that project on this machine." };
  if (!project.id || !PROJECT_ID.test(project.id)) {
    return { status: 409, error: `${project.name} has no project id yet (.psm/identity.json). Open it once in psm to give it one, then add the task.` };
  }
  return project.id;
}

export function intakeRoutes(options: IntakeRouteOptions): express.Router {
  const router = express.Router();

  const guarded = (handler: (req: express.Request, res: express.Response) => Promise<unknown>) => async (req: express.Request, res: express.Response) => {
    if (!options.isLocal(req)) return res.status(403).json({ error: "Add and change tasks from the local cockpit." });
    if (!(await options.signedIn())) return res.status(401).json({ error: "Sign in with Werewolf first." });
    try {
      await handler(req, res);
    } catch (error) {
      const status = (error as { status?: number }).status;
      res.status(status && status >= 400 && status < 500 ? status : 502).json({ error: (error as Error).message });
    }
  };
  const refuse = (res: express.Response, refusal: Refusal) => res.status(refusal.status).json({ error: refusal.error });

  router.post("/api/executor/intake", guarded(async (req, res) => {
    const nonce = req.body?.nonce;
    if (typeof nonce !== "string" || !NONCE.test(nonce)) return res.status(400).json({ error: "nonce must be 8-64 characters of a-z, 0-9, - and _." });
    const text = taskText(req.body?.text);
    if (typeof text !== "string") return refuse(res, text);
    const projectId = projectIdOf(options, req.body?.projectId ?? req.body?.project);
    if (typeof projectId !== "string") return refuse(res, projectId);
    const { intake, created } = await options.hub().createIntake({ projectId, text, key: intakeKey(options.executorId(), nonce) });
    res.status(created ? 201 : 200).json({ intake, created });
  }));

  router.patch("/api/executor/intake/:intakeId", guarded(async (req, res) => {
    if (!INTAKE_ID.test(req.params.intakeId)) return res.status(404).json({ error: "No such task." });
    const change: { text?: string; projectId?: string } = {};
    if (req.body?.text !== undefined) {
      const text = taskText(req.body.text);
      if (typeof text !== "string") return refuse(res, text);
      change.text = text;
    }
    if (req.body?.projectId !== undefined) {
      const projectId = projectIdOf(options, req.body.projectId);
      if (typeof projectId !== "string") return refuse(res, projectId);
      change.projectId = projectId;
    }
    if (!Object.keys(change).length) return res.status(400).json({ error: "Nothing to change." });
    res.json({ intake: await options.hub().updateIntake(req.params.intakeId, change) });
  }));

  router.delete("/api/executor/intake/:intakeId", guarded(async (req, res) => {
    if (!INTAKE_ID.test(req.params.intakeId)) return res.status(404).json({ error: "No such task." });
    res.json({ intake: await options.hub().withdrawIntake(req.params.intakeId) });
  }));

  return router;
}
