/**
 * Keeping the hub's project registry in step with this machine.
 *
 * The Todo app's `@project` picker lists what the hub knows, and the hub only
 * knows what a psm told it. So while psm is signed in with Werewolf it publishes
 * its projects — `prj_` id, name, archived — and nothing else: no paths, no
 * notes, no code. Unlike claiming jobs, this does not need PSM_EXECUTOR=1; the
 * picker is useful before triage is switched on. PSM_PUBLISH_PROJECTS=0 stops it.
 *
 * The hub replaces this executor's share on every publish (projects it no longer
 * lists lose this source, and are archived once no source has them), so a full
 * list is always sent, and only when it changed or has gone stale.
 */
import crypto from "node:crypto";

import type { Hub, HubProject } from "./client.ts";

/** Same rule as the hub (PsmProject.PROJECT_ID). */
const PROJECT_ID = /^prj_[A-Za-z0-9]{1,64}$/;
/** The hub's own limit per publish. */
const MAX_PROJECTS = 500;
/** Re-send an unchanged list this often, so `lastSeenAt` stays fresh. */
const REFRESH_MS = 30 * 60 * 1000;

export function projectsForHub(projects: Array<{ id: string | null; name: string; archived?: boolean }>): HubProject[] {
  const seen = new Set<string>();
  const out: HubProject[] = [];
  for (const project of projects) {
    if (!project.id || !PROJECT_ID.test(project.id) || seen.has(project.id)) continue;
    seen.add(project.id);
    out.push({ projectId: project.id, name: project.name.slice(0, 200), archived: project.archived === true });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_PROJECTS);
}

export interface PublishStatus {
  enabled: boolean;
  state: "off" | "signed-out" | "published" | "error";
  count: number;
  lastPublishedAt: number | null;
  lastError: string | null;
}

export interface PublisherOptions {
  hub: Pick<Hub, "publishProjects">;
  projects: () => Array<{ id: string | null; name: string; archived?: boolean }>;
  /** True when psm holds a Werewolf session; no session, no publish. */
  signedIn: () => Promise<boolean>;
  intervalMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export function createProjectPublisher(options: PublisherOptions) {
  const now = options.now ?? Date.now;
  const status: PublishStatus = { enabled: true, state: "signed-out", count: 0, lastPublishedAt: null, lastError: null };
  let lastDigest: string | null = null;
  let running: Promise<PublishStatus> | null = null;
  let timer: NodeJS.Timeout | null = null;

  /** Publish if signed in and the list changed or went stale (or `force`). */
  async function sync(force = false): Promise<PublishStatus> {
    if (running) return running;
    running = (async () => {
      try {
        if (!(await options.signedIn())) {
          status.state = "signed-out";
          lastDigest = null; // a new sign-in may be another account: publish again
          return { ...status };
        }
        const list = projectsForHub(options.projects());
        const digest = crypto.createHash("sha256").update(JSON.stringify(list)).digest("hex");
        const stale = status.lastPublishedAt === null || now() - status.lastPublishedAt > REFRESH_MS;
        if (!force && digest === lastDigest && !stale && status.state === "published") return { ...status };
        const result = await options.hub.publishProjects(list);
        lastDigest = digest;
        Object.assign(status, { state: "published", count: result.count, lastPublishedAt: now(), lastError: null });
        options.log?.(`hub: published ${result.count} project${result.count === 1 ? "" : "s"}${result.archived ? `, archived ${result.archived}` : ""}`);
      } catch (error) {
        Object.assign(status, { state: "error", lastError: (error as Error).message });
        lastDigest = null;
      }
      return { ...status };
    })();
    try {
      return await running;
    } finally {
      running = null;
    }
  }

  return {
    sync,
    status: (): PublishStatus => ({ ...status }),
    start() {
      if (timer) return;
      void sync();
      timer = setInterval(() => void sync(), options.intervalMs ?? 60_000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
