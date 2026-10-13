import express from "express";
import { userInfo } from "node:os";
import { AGENT_PERMISSIONS, AgentPermissionStore, isPermissionOperatorRequest, PermissionError } from "./agent-permissions.ts";
import { isWorkspaceRef } from "./workspaces.ts";

/** Local operator controls. Hosted policy management needs its own authenticated contract. */
export function workspaceAgentPolicyRouter(options: {
  store: AgentPermissionStore;
  authorize: (workspaceId: string) => Promise<{ ok: true; entry?: { name: string } } | { ok: false; status: number; error: string }>;
  changed: (workspaceId: string, change: { restrictive: boolean }) => void;
}): express.Router {
  const router = express.Router();
  const view = (ref: string, workspaceName: string) => ({ ...options.store.workspacePolicy(ref), workspaceName, permissions: AGENT_PERMISSIONS, history: options.store.workspaceHistory(ref) });
  const authorize = async (req: express.Request, res: express.Response): Promise<{ ref: string; name: string } | null> => {
    if (!isWorkspaceRef(req.params.ref)) { res.status(400).json({ error: "Unknown workspace." }); return null; }
    const ref = req.params.ref.toLowerCase();
    const verdict = await options.authorize(ref);
    if (!verdict.ok) { res.status(verdict.status).json({ error: verdict.error }); return null; }
    return { ref, name: verdict.entry?.name ?? ref };
  };
  router.get("/api/workspaces/:ref/agent-policy", async (req, res) => {
    try { const workspace = await authorize(req, res); if (workspace) res.json(view(workspace.ref, workspace.name)); }
    catch (error) { res.status(503).json({ error: (error as Error).message }); }
  });
  const mutate = async (req: express.Request, res: express.Response, remove: boolean) => {
    if (!isPermissionOperatorRequest(req)) { res.status(403).json({ error: "Change workspace policy from the local, same-origin cockpit." }); return; }
    try {
      const workspace = await authorize(req, res);
      if (!workspace) return;
      const { ref } = workspace;
      const actor = `local:${userInfo().username}`;
      const before = options.store.workspacePolicy(ref);
      const after = remove
        ? options.store.removeWorkspaceRule(ref, req.params.rule, req.body?.revision, actor)
        : options.store.addWorkspaceRule(ref, { permission: req.body?.permission, effect: req.body?.effect, scope: req.body?.scope ?? {}, duration: req.body?.duration, source: "custom", actor }, req.body?.revision);
      options.changed(ref, { restrictive: after.restrictedRevision > before.restrictedRevision });
      res.json(view(ref, workspace.name));
    } catch (error) { res.status(error instanceof PermissionError ? 409 : 400).json({ error: (error as Error).message }); }
  };
  router.post("/api/workspaces/:ref/agent-policy/rules", (req, res) => { void mutate(req, res, false); });
  router.delete("/api/workspaces/:ref/agent-policy/rules/:rule", (req, res) => { void mutate(req, res, true); });
  return router;
}
