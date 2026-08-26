import type { DigitalOceanDnsResource } from "../types.ts";

const DEFAULT_API_BASE = "https://api.digitalocean.com";
const MAX_RESPONSE_BYTES = 512 * 1024;
const RECORD_ID = /^[1-9][0-9]{0,19}$/;

export interface DigitalOceanDnsRecord {
  id: string;
  type: "A";
  name: string;
  data: string;
  ttl: number;
}

export interface DigitalOceanDnsObservation {
  accountId: string;
  records: DigitalOceanDnsRecord[];
}

export class DigitalOceanError extends Error {
  constructor(message: string, readonly code = "digitalocean-api-error", readonly status: number | null = null) {
    super(message);
    this.name = "DigitalOceanError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

function parseRecord(value: unknown): DigitalOceanDnsRecord {
  const input = record(value);
  const id = String(input.id ?? "");
  if (
    !RECORD_ID.test(id)
    || input.type !== "A"
    || typeof input.name !== "string"
    || typeof input.data !== "string"
    || !Number.isInteger(input.ttl)
  ) {
    throw new DigitalOceanError("DigitalOcean returned an invalid DNS record", "digitalocean-response-invalid");
  }
  return { id, type: "A", name: input.name, data: input.data, ttl: input.ttl as number };
}

export class DigitalOceanClient {
  readonly #token: string;
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor(options: { token: string; apiBaseUrl?: string; fetch?: typeof fetch }) {
    if (!options.token || options.token.length > 16_384 || /[\r\n]/.test(options.token)) {
      throw new DigitalOceanError("DigitalOcean token is missing or invalid", "digitalocean-credential-invalid");
    }
    const base = new URL(options.apiBaseUrl ?? DEFAULT_API_BASE);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
      throw new DigitalOceanError("DigitalOcean API base must be an HTTPS origin", "digitalocean-config-invalid");
    }
    this.#token = options.token;
    this.#base = base.href.replace(/\/$/, "");
    this.#fetch = options.fetch ?? fetch;
  }

  async #request(pathname: string, options: { method?: "GET" | "POST" | "PUT"; body?: unknown; signal?: AbortSignal; statuses?: number[] } = {}): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), 15_000);
    timer.unref?.();
    try {
      const response = await this.#fetch(`${this.#base}${pathname}`, {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.#token}`,
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: "error",
        signal: controller.signal,
      });
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new DigitalOceanError("DigitalOcean response is too large", "digitalocean-response-invalid");
      const statuses = options.statuses ?? [200];
      if (!statuses.includes(response.status)) {
        throw new DigitalOceanError(`DigitalOcean returned HTTP ${response.status}`, "digitalocean-api-error", response.status);
      }
      if (!text) return {};
      try { return record(JSON.parse(text)); } catch { throw new DigitalOceanError("DigitalOcean returned invalid JSON", "digitalocean-response-invalid"); }
    } catch (error) {
      if (error instanceof DigitalOceanError) throw error;
      throw new DigitalOceanError(error instanceof Error && error.name === "AbortError" ? "DigitalOcean request timed out" : "DigitalOcean request failed");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  async accountId(signal?: AbortSignal): Promise<string> {
    const response = await this.#request("/v2/account", { signal });
    const uuid = record(response.account).uuid;
    if (typeof uuid !== "string" || !/^[A-Za-z0-9-]{8,100}$/.test(uuid)) {
      throw new DigitalOceanError("DigitalOcean returned no stable account identity", "digitalocean-response-invalid");
    }
    return uuid;
  }

  async observeDns(resource: DigitalOceanDnsResource, signal?: AbortSignal): Promise<DigitalOceanDnsObservation> {
    const query = new URLSearchParams({ type: "A", name: resource.desired.name });
    const [accountId, response] = await Promise.all([
      this.accountId(signal),
      this.#request(`/v2/domains/${pathSegment(resource.desired.zone)}/records?${query}`, { signal }),
    ]);
    if (!Array.isArray(response.domain_records) || response.domain_records.length > 100) {
      throw new DigitalOceanError("DigitalOcean returned an invalid DNS record list", "digitalocean-response-invalid");
    }
    return { accountId, records: response.domain_records.map(parseRecord) };
  }

  async getDns(zone: string, recordId: string, signal?: AbortSignal): Promise<DigitalOceanDnsRecord> {
    if (!RECORD_ID.test(recordId)) throw new DigitalOceanError("DigitalOcean record ID is invalid", "digitalocean-config-invalid");
    const response = await this.#request(`/v2/domains/${pathSegment(zone)}/records/${recordId}`, { signal });
    return parseRecord(response.domain_record);
  }

  async createDns(resource: DigitalOceanDnsResource, address: string, signal?: AbortSignal): Promise<DigitalOceanDnsRecord> {
    const response = await this.#request(`/v2/domains/${pathSegment(resource.desired.zone)}/records`, {
      method: "POST",
      body: { type: "A", name: resource.desired.name, data: address, ttl: resource.desired.ttl },
      signal,
      statuses: [201],
    });
    return parseRecord(response.domain_record);
  }

  async updateDns(resource: DigitalOceanDnsResource, recordId: string, address: string, signal?: AbortSignal): Promise<DigitalOceanDnsRecord> {
    if (!RECORD_ID.test(recordId)) throw new DigitalOceanError("DigitalOcean record ID is invalid", "digitalocean-config-invalid");
    const response = await this.#request(`/v2/domains/${pathSegment(resource.desired.zone)}/records/${recordId}`, {
      method: "PUT",
      body: { type: "A", name: resource.desired.name, data: address, ttl: resource.desired.ttl },
      signal,
    });
    return parseRecord(response.domain_record);
  }
}

export function dnsMatches(record: DigitalOceanDnsRecord, resource: DigitalOceanDnsResource, address: string): boolean {
  return record.type === resource.desired.type
    && record.name === resource.desired.name
    && record.data === address
    && record.ttl === resource.desired.ttl;
}
