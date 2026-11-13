/**
 * HTTP surface for resources: what runs on this machine, the level chosen for
 * each, and the database-script buttons those levels allow.
 *
 * The page's view is never trusted. Every run re-detects the script, re-resolves
 * its target from the `.env` as it is *now*, and re-reads the stored level; a
 * `.env` edited between listing and clicking is caught here, not in the page.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express, { type Request, type Response } from "express";

import { listeningSockets, machineProcesses, processTable } from "../machine.ts";
import { procState, start, type ProcKind } from "../procs.ts";
import { assemble, dockerView, envReferences, folderKey, folderSummary, type Discovery } from "./discover.ts";
import { suggest } from "./levels.ts";
import { detectScripts, scriptCommand, type DbScript } from "./scripts.ts";
import { GIT_STATE_TEXT, scriptDigest, scriptGitState } from "./script-binding.ts";
import { ResourceStoreError, isLevel, type Level, type ResourceStore } from "./store.ts";

export interface ResourceApiOptions {
  store: ResourceStore;
  projects: () => Array<{ name: string; path: string; port?: number | null }>;
  localRequest: (req: Request) => boolean;
  actor: () => string;
  /** Injected so tests can run without a real machine under them. */
  discover?: () => Discovery;
  /** Called after every change, to refresh the guidance terminal agents read. */
  changed?: () => void;
}

/** An Apply must follow a clean Preview of the same script and target, this recently. */
export const PREVIEW_FRESH_MS = 15 * 60 * 1000;

export function scriptKind(script: Pick<DbScript, "id">): ProcKind {
  return `script:${script.id}`;
}

export function allowed(level: Level, script: DbScript): { preview: boolean; apply: boolean; why: string | null } {
  if (!script.target) return { preview: false, apply: false, why: script.reason };
  if (level === "full") return { preview: true, apply: true, why: null };
  if (level === "read") return { preview: true, apply: false, why: "Apply needs Full access to this database." };
  return { preview: false, apply: false, why: "This database is set to None (or not set yet). Choose Read or Full in Resources." };
}

function fail(res: Response, error: unknown) {
  if (error instanceof ResourceStoreError) return res.status(error.status).json({ error: error.message, code: error.code });
  return res.status(500).json({ error: error instanceof Error ? error.message : String(error), code: "unexpected" });
}

export function resourceRouter(options: ResourceApiOptions): express.Router {
  const router = express.Router();
  const { store } = options;
  /** Last preview per script kind: which target it ran against, and when. */
  /** Last preview per script kind: target, command, start, and the digest of what ran (P02a.4). */
  const previews = new Map<string, { target: string; command: string; startedAt: number; digest: string }>();

  const discover = options.discover ?? (() => {
    const projects = options.projects();
    return assemble({
      sockets: listeningSockets(),
      table: processTable(),
      docker: dockerView(),
      env: envReferences(projects),
      servers: machineProcesses({ roots: projects.map((project) => ({ name: project.name, path: project.path, port: project.port ?? null })) }),
      folders: store.folders(),
    });
  });

  const local = (req: Request, res: Response) => {
    if (options.localRequest(req)) return true;
    res.status(403).json({ error: "Change resource access from the local cockpit.", code: "local-authority-required" });
    return false;
  };

  const changed = () => {
    try {
      options.changed?.();
    } catch (error) {
      // The level is saved either way; a guidance file psm could not write is
      // reported in the log rather than undoing the choice.
      console.warn(`[resources] could not update agent guidance: ${(error as Error).message}`);
    }
  };

  const project = (name: unknown) => options.projects().find((entry) => entry.name === name) ?? null;

  const scriptView = (script: DbScript) => {
    const level = script.target ? store.effective(script.target.key) : "none";
    const levelSet = script.target ? !!store.get(script.target.key)?.level : false;
    const state = procState(script.project, scriptKind(script));
    const owner = project(script.project);
    const git = owner ? scriptGitState(owner.path, script.path) : "no-git";
    const verdict = allowed(level, script);
    // A Read target previews committed code only (P02a.4); say so before the click.
    const gated = level === "read" && verdict.preview && git !== "committed"
      ? { ...verdict, preview: false, why: `On a Read database Preview runs committed code only; this script ${GIT_STATE_TEXT[git as Exclude<typeof git, "committed">]}.` }
      : verdict;
    return { ...script, kind: scriptKind(script), level, levelSet, allowed: gated, state, git };
  };

  router.get("/api/resources", (_req, res) => {
    try {
      const found = discover();
      const settings = new Map(store.list().map((setting) => [setting.key, setting]));
      const resources = found.resources.map((resource) => {
        const setting = settings.get(resource.key) ?? null;
        const level = setting?.level ?? null;
        const row = {
          ...resource,
          level,
          revision: setting?.revision ?? 0,
          settable: resource.kind !== "server",
          suggestion: level ? null : suggest(resource),
        };
        // A folder's contents are not looked at below Read — not even counted.
        if (resource.kind === "folder" && resource.path && (level === "read" || level === "full")) return { ...row, summary: folderSummary(resource.path) };
        return row;
      });
      res.json({ resources, docker: found.docker });
    } catch (error) { fail(res, error); }
  });

  router.put("/api/resources/level", (req, res) => {
    if (!local(req, res)) return;
    try {
      const { key, level, revision } = req.body ?? {};
      if (typeof key !== "string" || !isLevel(level)) return res.status(400).json({ error: "Send a resource key and a level (none, read or full).", code: "invalid" });
      const setting = store.setLevel(key, level, Number(revision) || 0, options.actor());
      changed();
      res.json({ setting });
    } catch (error) { fail(res, error); }
  });

  router.post("/api/resources/folders", (req, res) => {
    if (!local(req, res)) return;
    try {
      const given = req.body?.path;
      const raw = typeof given === "string" ? given.trim().replace(/^~(?=$|\/)/, os.homedir()) : given;
      if (typeof raw !== "string" || !path.isAbsolute(raw)) return res.status(400).json({ error: "Choose a folder by its full path.", code: "invalid" });
      let real: string;
      try {
        real = fs.realpathSync(raw);
        if (!fs.statSync(real).isDirectory()) throw new Error("not a directory");
      } catch {
        return res.status(400).json({ error: "That folder does not exist.", code: "invalid" });
      }
      const setting = store.addFolder(folderKey(real), real, options.actor());
      changed();
      res.json({ setting });
    } catch (error) { fail(res, error); }
  });

  router.delete("/api/resources", (req, res) => {
    if (!local(req, res)) return;
    try {
      const { key, revision } = req.body ?? {};
      if (typeof key !== "string") return res.status(400).json({ error: "Send a resource key.", code: "invalid" });
      store.forget(key, Number(revision) || 0);
      changed();
      res.json({ ok: true });
    } catch (error) { fail(res, error); }
  });

  router.get("/api/resources/scripts", (req, res) => {
    try {
      const wanted = typeof req.query.project === "string" ? project(req.query.project) : null;
      if (req.query.project && !wanted) return res.status(404).json({ error: "unknown project", code: "unknown-project" });
      const projects = wanted ? [wanted] : options.projects();
      res.json({ scripts: projects.flatMap((entry) => detectScripts(entry)).map(scriptView) });
    } catch (error) { fail(res, error); }
  });

  router.post("/api/resources/scripts/run", (req, res) => {
    if (!local(req, res)) return;
    try {
      const { project: name, id, mode } = req.body ?? {};
      if (mode !== "preview" && mode !== "apply") return res.status(400).json({ error: "mode must be preview or apply", code: "invalid" });
      const owner = project(name);
      if (!owner) return res.status(404).json({ error: "unknown project", code: "unknown-project" });
      // Re-detect now: only a script psm itself found can run, by its id.
      const script = detectScripts(owner).find((entry) => entry.id === id);
      if (!script) return res.status(404).json({ error: "That script is not one psm detected in this project.", code: "unknown-script" });
      const level = script.target ? store.effective(script.target.key) : "none";
      const verdict = allowed(level, script);
      if (mode === "preview" ? !verdict.preview : !verdict.apply) return res.status(403).json({ error: verdict.why, code: "resource-level" });
      // Preview executes the script with the database's credentials: on a Read target, only committed code.
      const git = scriptGitState(owner.path, script.path);
      if (mode === "preview" && level === "read" && git !== "committed") {
        return res.status(403).json({ error: `On a Read database Preview runs committed code only; this script ${GIT_STATE_TEXT[git]}. Commit it, or set the database to Full.`, code: "uncommitted-script" });
      }
      const digest = scriptDigest(owner.path, script, script.target!.key);

      const kind = scriptKind(script);
      const state = procState(owner.name, kind);
      if (state.status === "running") return res.status(409).json({ error: "This script is still running.", code: "running" });

      const previewCommand = scriptCommand(script, "preview");
      if (mode === "apply") {
        const last = previews.get(kind);
        const clean = last
          && last.target === script.target!.key
          && state.command === previewCommand
          && state.status === "exited"
          && state.exitCode === 0
          && Date.now() - last.startedAt < PREVIEW_FRESH_MS;
        if (!clean) return res.status(409).json({ error: "Run Preview first; Apply follows a clean preview of the same database.", code: "preview-required" });
        if (last.digest !== digest) {
          previews.delete(kind);
          return res.status(409).json({ error: "The script or its lockfile changed since its Preview. Preview it again before Apply.", code: "preview-stale" });
        }
      }

      const command = scriptCommand(script, mode);
      const cwd = path.join(owner.path, script.directory);
      const entry = start(owner.name, kind, command, cwd, { unsetEnv: script.unset, redact: true });
      if (mode === "preview") previews.set(kind, { target: script.target!.key, command, startedAt: entry.startedAt, digest });
      else previews.delete(kind); // an Apply always needs its own fresh preview
      res.json({ ok: true, kind, command, target: script.target, status: entry.status });
    } catch (error) { fail(res, error); }
  });

  return router;
}
