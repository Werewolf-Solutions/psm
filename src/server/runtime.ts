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
  activeUrl: fixedUrl || productionUrl,
  source: fixedUrl ? "override" : "production",
  localUrl,
  productionUrl,
  localAvailable: false,
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

export async function refreshWerewolfRuntime(force = false): Promise<RuntimeService> {
  if (fixedUrl) {
    werewolf.checkedAt = Date.now();
    return copyService();
  }
  if (!force && werewolf.checkedAt && Date.now() - werewolf.checkedAt < DISCOVERY_TTL_MS) {
    return copyService();
  }
  if (discovery) return { ...(await discovery) };

  discovery = (async () => {
    const probe = await probeWerewolfApi(localUrl);
    werewolf.localAvailable = probe.available;
    werewolf.activeUrl = probe.available ? localUrl : productionUrl;
    werewolf.source = probe.available ? "local" : "production";
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
