/**
 * Personal and business workspaces in psm.
 *
 * A workspace is `personal` or `business:<id>`, the same references werewolf-dapp
 * uses. What psm adds is local:
 *
 * - **Personal works offline and signed out.** It is always available and needs
 *   no login. Business workspaces exist only for a signed-in Werewolf account
 *   and are listed by the API from *current* membership, so a business is never
 *   something this machine can claim for itself.
 * - **The selection is a view, not a grant.** It is remembered locally (as a bare
 *   reference, never a credential) and re-checked against the live list each
 *   time; if the account is signed out or the membership is gone the effective
 *   workspace is personal, and the remembered choice comes back on its own once
 *   it is valid again.
 * - **A project belongs to exactly one workspace**, recorded against its stable
 *   `.psm/identity.json` id — never its directory path, which is only where a
 *   clone happens to live on this machine and identifies nothing in the cloud.
 *   Unassigned projects are personal. Assigning one is an explicit action, is
 *   refused unless the API confirms membership, and changes nothing about who
 *   can read the folder.
 * - **Moving a project is a write to both ends.** The workspace it leaves loses
 *   it and the workspace it joins gains it, so current write authority is
 *   required in *both* before anything is written. Checking only the
 *   destination is not enough: personal is always available and always
 *   writable, so it would otherwise be a way to pull a project out of a
 *   business nobody can still prove they belong to.
 * - **Unknown membership is not absent membership.** If the account API cannot
 *   be reached, a business workspace is unverifiable, not empty; business
 *   operations fail closed (and say so) rather than treating an outage as a
 *   loss of membership.
 * - **Nothing here widens local authority.** Business membership does not grant
 *   filesystem access, agent pairing or deployment rights; those stay with the
 *   paired-agent and deployment permission systems.
 */
import express from "express";
import fs from "node:fs";

import { ensureProjectId, readProjectId } from "../identity.ts";
import { statePath, writeFileAtomic } from "../store.ts";
import type { Project } from "../types.ts";
import { cloudAvailable, cloudRequest } from "./cloud.ts";

export const PERSONAL = "personal";
const REF_PATTERN = /^(personal|business:[a-f0-9]{24})$/i;
export const WORKSPACE_HEADER = "X-Werewolf-Workspace";
const STATE_FILE = ".psm-workspaces.json";
/** Tests point this at a scratch file; otherwise it sits beside the other .psm-* state. */
const stateFile = () => process.env.PSM_WORKSPACES_FILE || statePath(STATE_FILE);

export interface WorkspaceEntry {
  ref: string;
  kind: "personal" | "business";
  name: string;
  role: "owner" | "admin" | "member" | "viewer";
  canWrite: boolean;
  canManage: boolean;
}

interface WorkspaceState {
  selected: string;
  /** project id (prj_…) → workspace ref. Absent means personal. */
  assignments: Record<string, string>;
}

export const isWorkspaceRef = (value: unknown): value is string =>
  typeof value === "string" && REF_PATTERN.test(value);

/** Workspace references are compared case-insensitively; ids are hex either way. */
const sameRef = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const PERSONAL_ENTRY: WorkspaceEntry = {
  ref: PERSONAL,
  kind: "personal",
  name: "Personal",
  role: "owner",
  canWrite: true,
  canManage: true,
};

export function loadState(): WorkspaceState {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    const assignments: Record<string, string> = {};
    for (const [id, ref] of Object.entries(raw?.assignments || {})) {
      // Canonical lower case, so a hand-edited file cannot make the workspace a
      // project sits in read as a *different* one from the same id in the list.
      if (/^prj_[0-9a-f]{20}$/.test(id) && isWorkspaceRef(ref)) assignments[id] = ref.toLowerCase();
    }
    return {
      selected: isWorkspaceRef(raw?.selected) ? raw.selected.toLowerCase() : PERSONAL,
      assignments,
    };
  } catch {
    return { selected: PERSONAL, assignments: {} };
  }
}

function saveState(state: WorkspaceState): void {
  writeFileAtomic(stateFile(), JSON.stringify(state, null, 2) + "\n", 0o600);
}

export interface Availability {
  signedIn: boolean;
  workspaces: WorkspaceEntry[];
  /** Set when a signed-in session could not list businesses; personal still works. */
  businessError?: string;
}

/** Personal, plus the businesses the signed-in account currently belongs to. */
export async function availableWorkspaces(): Promise<Availability> {
  if (!cloudAvailable()) return { signedIn: false, workspaces: [PERSONAL_ENTRY] };
  try {
    const listed: WorkspaceEntry[] = await cloudRequest("/workspaces");
    const businesses = (Array.isArray(listed) ? listed : []).filter(
      (entry) => entry?.kind === "business" && isWorkspaceRef(entry.ref),
    );
    return { signedIn: true, workspaces: [PERSONAL_ENTRY, ...businesses] };
  } catch (err) {
    return {
      signedIn: true,
      workspaces: [PERSONAL_ENTRY],
      businessError: (err as Error).message || "Could not list business workspaces",
    };
  }
}

/** The workspace in effect: the remembered choice if it is valid right now, else personal. */
export function effectiveWorkspace(state: WorkspaceState, available: Availability): WorkspaceEntry {
  return available.workspaces.find((w) => sameRef(w.ref, state.selected)) || PERSONAL_ENTRY;
}

/** Where a project lives: its assignment, else personal. */
export function projectWorkspaceRef(state: WorkspaceState, projectId: string | null): string {
  return (projectId && state.assignments[projectId]) || PERSONAL;
}

/**
 * Whether this account may act in a workspace right now, decided only from the
 * list the account API just returned.
 *
 * The three ways a workspace can be missing from that list are deliberately
 * *different* answers: signed out (401, sign in), verified and not a member
 * (403, a real no) and could-not-verify (503, unknown). Collapsing the last into
 * 403 would let an outage read as "you are not a member", which is exactly the
 * state an attacker or a flaky network would want when trying to move somebody
 * else's work.
 */
type Verdict = { ok: true; entry: WorkspaceEntry } | { ok: false; status: number; error: string };

function resolveWorkspace(ref: string, available: Availability): Verdict {
  const entry = available.workspaces.find((w) => sameRef(w.ref, ref));
  if (entry) return { ok: true, entry };
  if (!available.signedIn) return { ok: false, status: 401, error: "Sign in with Werewolf to use a business workspace" };
  if (available.businessError) {
    return {
      ok: false,
      status: 503,
      error: `Could not verify your membership of that workspace (${available.businessError}) — nothing was changed`,
    };
  }
  return { ok: false, status: 403, error: "That workspace is not available to this account" };
}

/** Membership, and a role that may write. Personal is always the caller's own. */
function writeAuthority(ref: string, available: Availability): Verdict {
  const found = resolveWorkspace(ref, available);
  if (!found.ok) return found;
  if (!found.entry.canWrite) return { ok: false, status: 403, error: "Your role in that workspace is read-only" };
  return found;
}

export function workspaceRouter(deps: { getProjects: () => Project[] }): express.Router {
  const router = express.Router();
  const fail = (res: express.Response, status: number, error: string) => res.status(status).json({ error });
  const findProject = (name: string) => deps.getProjects().find((p) => p.name === name);

  /** The list, the effective selection, and whether a remembered one is waiting. */
  router.get("/workspaces", async (_req, res) => {
    const state = loadState();
    const available = await availableWorkspaces();
    const current = effectiveWorkspace(state, available);
    res.json({
      signedIn: available.signedIn,
      workspaces: available.workspaces,
      current,
      // A remembered business that is not usable right now (signed out, removed):
      // shown so the UI can explain, and honoured again once it is valid.
      pending: current.ref.toLowerCase() === state.selected.toLowerCase() ? null : state.selected,
      businessError: available.businessError,
    });
  });

  router.put("/workspaces/selected", async (req, res) => {
    const ref = req.body?.ref;
    if (!isWorkspaceRef(ref)) return fail(res, 400, "ref must be personal or business:<id>");
    const available = await availableWorkspaces();
    // Choosing a view is not a write, so a read-only role is fine here — but it
    // still needs a membership the API actually confirmed.
    const chosen = resolveWorkspace(ref, available);
    if (!chosen.ok) return fail(res, chosen.status, chosen.error);
    const state = loadState();
    state.selected = chosen.entry.ref;
    saveState(state);
    res.json({ current: chosen.entry });
  });

  /** Each project with its workspace, and whether the selected view includes it. */
  router.get("/workspaces/projects", async (_req, res) => {
    const state = loadState();
    const current = effectiveWorkspace(state, await availableWorkspaces());
    const projects = deps.getProjects().map((project) => {
      const ref = projectWorkspaceRef(state, project.id ?? readProjectId(project.path));
      return { name: project.name, workspace: ref, visible: ref.toLowerCase() === current.ref.toLowerCase() };
    });
    res.json({ current: current.ref, projects });
  });

  /**
   * Move a project into a workspace. Both the workspace it leaves and the one
   * it joins must be writable by this account right now, and nothing — not the
   * assignment, not the project's identity file — is written until both agree.
   */
  router.put("/workspaces/projects/:name", async (req, res) => {
    const project = findProject(req.params.name);
    if (!project) return fail(res, 404, "No such project");
    const ref = req.body?.ref;
    if (!isWorkspaceRef(ref)) return fail(res, 400, "ref must be personal or business:<id>");

    const state = loadState();
    // Where it is *now* decides who else has to agree. Read before deciding, and
    // read without minting anything: an unidentified project is personal.
    const from = projectWorkspaceRef(state, project.id ?? readProjectId(project.path));

    const available = await availableWorkspaces();
    const source = writeAuthority(from, available);
    if (!source.ok) {
      return fail(res, source.status, `Cannot take this project out of its current workspace: ${source.error}`);
    }
    const target = writeAuthority(ref, available);
    if (!target.ok) return fail(res, target.status, target.error);
    const to = target.entry.ref;

    // The stable id lives in the project folder; minting it is the point where an
    // explicit assignment asks psm to write there. Personal (the default) needs none.
    const id = to === PERSONAL ? readProjectId(project.path) : ensureProjectId(project.path, project.name).id;
    if (id) {
      if (to === PERSONAL) delete state.assignments[id];
      else state.assignments[id] = to;
      if (!sameRef(from, to)) saveState(state);
    }
    res.json({
      project: project.name,
      from,
      workspace: to,
      // This is psm's own record of where a project belongs. It does not move
      // anything the Werewolf API owns; cloud data changes hands only through
      // that API's own transfer, with its own authorisation.
      cloudDataMoved: false,
    });
  });

  /** The project's Todo tasks, from the workspace the *project* belongs to. */
  router.get("/workspaces/todos", async (req, res) => {
    const project = findProject(String(req.query.project || ""));
    if (!project) return fail(res, 404, "No such project");
    if (!cloudAvailable()) return fail(res, 401, "Sign in with Werewolf to see Todo tasks");
    const state = loadState();
    const ref = projectWorkspaceRef(state, project.id ?? readProjectId(project.path));
    try {
      const data = await cloudRequest(`/todos?project=${encodeURIComponent(project.name)}`, {
        headers: { [WORKSPACE_HEADER]: ref },
      });
      res.json({ workspace: ref, ...data });
    } catch (err) {
      const typed = err as Error & { status?: number };
      fail(res, typed.status || 500, typed.message);
    }
  });

  return router;
}
