import { scansImplicitly } from "../mode.ts";

export type RuntimeServiceSource = "local" | "production" | "override";

export interface RuntimeService {
  id: "werewolf";
  title: string;
  project: string;
  activeUrl: string;
  source: RuntimeServiceSource;
  localUrl: string;
  productionUrl: string;
  localAvailable: boolean;
  /** Did the target this mode selected answer? */
  reachable: boolean;
  checkedAt: number;
  error?: string;
}

const DISCOVERY_TTL_MS = 10_000;
const DISCOVERY_INTERVAL_MS = 15_000;
const PROBE_TIMEOUT_MS = 1_200;

function cleanBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

const fixedUrl = process.env.WEREWOLF_API_URL
  ? cleanBaseUrl(process.env.WEREWOLF_API_URL)
  : null;
const localUrl = cleanBaseUrl(process.env.WEREWOLF_LOCAL_API_URL || "http://127.0.0.1:3000/api/v1");
const productionUrl = cleanBaseUrl(
  process.env.WEREWOLF_PRODUCTION_API_URL || "https://werewolf.solutions/api/v1",
);

const werewolf: RuntimeService = {
  id: "werewolf",
  title: "Werewolf Solutions API",
  project: "werewolf-dapp",
  activeUrl: productionUrl, // replaced on first refresh by targetUrlForMode()
  source: "production",
  localUrl,
  productionUrl,
  localAvailable: false,
  reachable: false,
  checkedAt: 0,
};

let discovery: Promise<RuntimeService> | null = null;

export async function probeWerewolfApi(
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ available: boolean; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${cleanBaseUrl(apiUrl)}/auth/me`, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as any;
    const unauthenticatedWerewolf = response.status === 401
      && body?.success === false
      && /authoriz|token/i.test(String(body?.message || ""));
    const authenticatedWerewolf = response.ok && body?.success === true && !!body?.data?.user;
    return unauthenticatedWerewolf || authenticatedWerewolf
      ? { available: true }
      : { available: false, error: `unexpected /auth/me response (${response.status})` };
  } catch (err) {
    const error = err as Error;
    return {
      available: false,
      error: error.name === "AbortError" ? "local probe timed out" : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function copyService(): RuntimeService {
  return { ...werewolf };
}

export function currentWerewolfRuntime(): RuntimeService {
  return copyService();
}

/**
 * Which Werewolf API this psm talks to — decided by the mode, not by probing.
 *
 *   dev              the local werewolf-dapp (127.0.0.1:3000). `npm run server`
 *                    is for working on the workspace, and it should not be
 *                    reaching production accounts.
 *   agent / hosted   werewolf.solutions, because those are the real deployment
 *                    and they share one account with the hosted front end.
 *
 * `WEREWOLF_API_URL` overrides both. This used to pick whichever answered a
 * probe, which meant the target silently changed depending on whether a local
 * dapp happened to be running — the same class of surprise as an inherited
 * `PORT`. It is still probed, but only to *report* whether it is reachable.
 */
export function targetUrlForMode(): { url: string; source: RuntimeServiceSource } {
  if (fixedUrl) return { url: fixedUrl, source: "override" };
  return scansImplicitly()
    ? { url: localUrl, source: "local" }
    : { url: productionUrl, source: "production" };
}

export async function refreshWerewolfRuntime(force = false): Promise<RuntimeService> {
  const target = targetUrlForMode();
  werewolf.activeUrl = target.url;
  werewolf.source = target.source;

  if (!force && werewolf.checkedAt && Date.now() - werewolf.checkedAt < DISCOVERY_TTL_MS) {
    return copyService();
  }
  if (discovery) return { ...(await discovery) };

  discovery = (async () => {
    // Probe the target we are actually going to use, so the UI can say "the
    // local dapp is not running" instead of quietly signing you in to production.
    const probe = await probeWerewolfApi(target.url);
    werewolf.localAvailable = target.source === "local" ? probe.available : false;
    werewolf.reachable = probe.available;
    werewolf.checkedAt = Date.now();
    if (probe.error) werewolf.error = probe.error;
    else delete werewolf.error;
    return copyService();
  })();
  try {
    return await discovery;
  } finally {
    discovery = null;
  }
}

export async function werewolfApiUrl(force = false): Promise<string> {
  return (await refreshWerewolfRuntime(force)).activeUrl;
}

export async function runtimeServices(force = false): Promise<Record<string, RuntimeService>> {
  return { werewolf: await refreshWerewolfRuntime(force) };
}

export function startRuntimeDiscovery(): void {
  refreshWerewolfRuntime(true).catch(() => {});
  setInterval(() => refreshWerewolfRuntime(true).catch(() => {}), DISCOVERY_INTERVAL_MS).unref();
}
