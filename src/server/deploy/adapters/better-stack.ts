import type { WatchObservation } from "../observations.ts";
import type { ExternalHttpWatch } from "../types.ts";

const DEFAULT_API_BASE = "https://uptime.betterstack.com";
const MAX_RESPONSE_BYTES = 512 * 1024;
const MONITOR_ID = /^[1-9][0-9]{0,19}$/;

export class BetterStackError extends Error {
  constructor(message: string, readonly code = "monitor-unavailable", readonly status: number | null = null) {
    super(message);
    this.name = "BetterStackError";
  }
}

export interface BetterStackClientOptions {
  token: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

interface JsonApiResource {
  id?: unknown;
  type?: unknown;
  attributes?: unknown;
  relationships?: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boundedText(value: unknown, maximum = 300): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedState(provider: string): WatchObservation["effectiveState"] {
  if (provider === "up") return "healthy";
  if (provider === "down") return "down";
  if (provider === "validating" || provider === "maintenance") return "degraded";
  if (provider === "paused") return "not-monitored";
  return "unknown";
}

export class BetterStackClient {
  readonly #token: string;
  readonly #base: URL;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(options: BetterStackClientOptions) {
    if (!options.token || options.token.length > 16 * 1024 || /[\r\n]/.test(options.token)) {
      throw new BetterStackError("Better Stack token is missing or invalid", "monitor-credential-invalid");
    }
    const base = new URL(options.apiBaseUrl ?? DEFAULT_API_BASE);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
      throw new BetterStackError("Better Stack API base must be an HTTPS origin", "monitor-config-invalid");
    }
    this.#token = options.token;
    this.#base = base;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async #json(pathname: string): Promise<Record<string, unknown>> {
    const url = new URL(pathname, this.#base);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    timeout.unref?.();
    try {
      const response = await this.#fetch(url, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${this.#token}` },
        redirect: "error",
        signal: controller.signal,
      });
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new BetterStackError("Better Stack response is too large", "monitor-response-invalid");
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new BetterStackError("Better Stack response is too large", "monitor-response-invalid");
      if (!response.ok) throw new BetterStackError(`Better Stack returned HTTP ${response.status}`, "monitor-api-error", response.status);
      try { return record(JSON.parse(text)); } catch { throw new BetterStackError("Better Stack returned invalid JSON", "monitor-response-invalid"); }
    } catch (error) {
      if (error instanceof BetterStackError) throw error;
      throw new BetterStackError(error instanceof Error && error.name === "AbortError" ? "Better Stack request timed out" : "Better Stack request failed");
    } finally {
      clearTimeout(timeout);
    }
  }

  async observe(definition: ExternalHttpWatch): Promise<WatchObservation> {
    if (!MONITOR_ID.test(definition.monitorKey)) throw new BetterStackError("Better Stack monitor ID is invalid", "monitor-config-invalid");
    const monitorEnvelope = await this.#json(`/api/v2/monitors/${definition.monitorKey}`);
    const monitor = record(monitorEnvelope.data) as JsonApiResource;
    const attributes = record(monitor.attributes);
    if (String(monitor.id) !== definition.monitorKey || monitor.type !== "monitor") {
      throw new BetterStackError("Better Stack returned another monitor", "monitor-response-invalid");
    }
    const providerState = boundedText(attributes.status, 32) ?? "unknown";
    const checkedAt = timestamp(attributes.last_checked_at);
    const monitorUrl = boundedText(attributes.url, 2_048);
    let parsedUrl: URL;
    try { parsedUrl = new URL(monitorUrl ?? ""); } catch { throw new BetterStackError("Better Stack monitor has no valid URL", "monitor-response-invalid"); }
    if (parsedUrl.hostname.toLowerCase() !== definition.hostname.toLowerCase()) {
      throw new BetterStackError("Better Stack monitor hostname does not match the manifest", "monitor-target-mismatch");
    }
    if (parsedUrl.protocol !== "https:" || attributes.verify_ssl !== true || typeof attributes.ssl_expiration !== "number") {
      throw new BetterStackError("Better Stack monitor is not enforcing TLS and certificate expiry", "monitor-tls-not-configured");
    }

    const observedAt = checkedAt ?? this.#now();
    const age = this.#now() - observedAt;
    let effectiveState = normalizedState(providerState);
    if (age > definition.maxObservationAgeSeconds * 1_000) effectiveState = "stale";

    const incidentEnvelope = await this.#json(`/api/v3/incidents?monitor_id=${definition.monitorKey}&resolved=false`);
    const incidents = Array.isArray(incidentEnvelope.data) ? incidentEnvelope.data.map(record) : [];
    const tlsIncident = incidents.find((item) => timestamp(record(item.attributes).ssl_certificate_expires_at) !== null);
    const tlsExpiresAt = tlsIncident ? timestamp(record(tlsIncident.attributes).ssl_certificate_expires_at) : null;
    const activeIncident = incidents.find((item) => {
      const state = boundedText(record(item.attributes).status, 32);
      return state !== null && state !== "Resolved";
    });
    if (tlsIncident || (activeIncident && effectiveState === "healthy")) effectiveState = "degraded";

    const detailParts = [`Better Stack ${providerState}`, `checked ${new Date(observedAt).toISOString()}`];
    if (tlsExpiresAt) detailParts.push(`certificate expires ${new Date(tlsExpiresAt).toISOString()}`);
    return {
      monitorId: definition.id,
      providerState,
      effectiveState,
      observedAt,
      detail: detailParts.join("; "),
      evidence: {
        provider: "better-stack@1",
        providerMonitorId: definition.monitorKey,
        url: parsedUrl.toString(),
        tlsVerified: true,
        sslExpirationWarningDays: attributes.ssl_expiration,
        tlsExpiresAt,
        activeIncident: activeIncident ? boundedText(record(activeIncident.attributes).cause, 300) : null,
      },
    };
  }
}
