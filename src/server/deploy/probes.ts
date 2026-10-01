import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export class ProbeError extends Error {
  constructor(message: string, readonly code = "dependency-failed") {
    super(message);
  }
}

export interface HttpProbeRequest {
  url: string;
  method?: "GET" | "HEAD" | "OPTIONS";
  timeoutMs?: number;
  maxBytes?: number;
  followSameOriginRedirects?: boolean;
  /** Server-owned scope. Manifest data must never set this. */
  privateAllowedOrigins?: string[];
  /** Resolved by a typed connection adapter, never copied from a manifest. */
  authorization?: string;
}

export interface HttpProbeResult {
  ok: boolean;
  status: number;
  url: string;
  observedAt: number;
  durationMs: number;
  bytes: number;
  redirects: number;
  json?: unknown;
}

function ipv4Parts(address: string): number[] | null {
  if (net.isIP(address) !== 4) return null;
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => part >= 0 && part <= 255) ? parts : null;
}

export function isPublicAddress(address: string): boolean {
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPublicAddress(mapped);
  const v4 = ipv4Parts(address);
  if (v4) {
    const [a, b] = v4;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 0 || b === 168)) return false;
    if (a === 192 && b === 0 && (v4[2] === 2 || v4[2] === 0)) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && v4[2] === 100))) return false;
    if (a === 203 && b === 0 && v4[2] === 113) return false;
    return true;
  }
  if (net.isIP(address) !== 6) return false;
  const value = address.toLowerCase();
  return !(
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    /^fe[89ab]/.test(value) ||
    value.startsWith("ff") ||
    value.startsWith("2001:db8:")
  );
}

function normalizedOrigin(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

type ProbeAddress = { address: string; family: 4 | 6 };

async function publicDnsAddresses(hostname: string): Promise<ProbeAddress[]> {
  const resolver = new dns.Resolver({ timeout: 2_000, tries: 1 });
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
  return [
    ...(v4.status === "fulfilled" ? v4.value.map((address) => ({ address, family: 4 as const })) : []),
    ...(v6.status === "fulfilled" ? v6.value.map((address) => ({ address, family: 6 as const })) : []),
  ];
}

/** Public probes may outlive a local router's cached NXDOMAIN after DNS was created. */
export async function addressesFor(
  url: URL,
  allowPrivate: boolean,
  lookup: (hostname: string) => Promise<Array<{ address: string; family: number }>> = (hostname) => dns.lookup(hostname, { all: true, verbatim: true }),
  publicLookup: (hostname: string) => Promise<ProbeAddress[]> = publicDnsAddresses,
): Promise<ProbeAddress[]> {
  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = await lookup(url.hostname);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (allowPrivate || (code !== "ENOTFOUND" && code !== "EAI_AGAIN")) {
      throw new ProbeError(`DNS lookup failed for ${url.hostname}: ${(error as Error).message}`);
    }
    // This is an independent public answer, not a manifest-supplied address.
    // The ordinary public-address check below and TLS hostname verification
    // still apply, and the connection is pinned to the validated answer.
    resolved = await publicLookup(url.hostname).catch(() => []);
    if (!resolved.length) throw new ProbeError(`DNS lookup failed for ${url.hostname}: ${(error as Error).message}; public DNS also returned no address`);
  }
  if (!resolved.length) throw new ProbeError(`DNS returned no address for ${url.hostname}`);
  const answers = resolved
    .filter((entry): entry is { address: string; family: 4 | 6 } => entry.family === 4 || entry.family === 6);
  if (!answers.length) throw new ProbeError(`DNS returned no usable address for ${url.hostname}`);
  if (!allowPrivate) {
    const refused = answers.find((entry) => !isPublicAddress(entry.address));
    if (refused) throw new ProbeError(`public probe resolved to a non-public address`, "probe-target-refused");
  }
  return answers;
}

async function oneRequest(
  url: URL,
  input: Required<Pick<HttpProbeRequest, "method" | "timeoutMs" | "maxBytes">> & HttpProbeRequest,
  allowPrivate: boolean,
): Promise<{ status: number; location: string | null; body: Buffer; remote: string }> {
  const addresses = await addressesFor(url, allowPrivate);
  const selected = addresses[0];
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: input.method,
      servername: url.hostname,
      headers: {
        Host: url.host,
        Accept: "application/json, text/plain;q=0.9, */*;q=0.1",
        "User-Agent": "psm-deployment-probe/1",
        ...(input.authorization ? { Authorization: input.authorization } : {}),
      },
      // Node asks a custom lookup for every address at once whenever it picks
      // the family itself — autoSelectFamily, on by default since Node 20 — and
      // then expects an array. Answering with the scalar form makes it read
      // `addresses[0].address` as undefined and fail every probe as "Invalid IP
      // address: undefined". An IP literal skips lookup altogether, which is
      // why probing 127.0.0.1 never noticed. Either shape still offers exactly
      // the one address `addressesFor` validated, so the peer cannot change
      // between the check and the connection.
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address: selected.address, family: selected.family }]);
        else callback(null, selected.address, selected.family);
      },
      timeout: input.timeoutMs,
    }, (response) => {
      const remote = response.socket.remoteAddress || "";
      if ((!allowPrivate && !isPublicAddress(remote)) || !addresses.some((entry) => entry.address === remote || `::ffff:${entry.address}` === remote)) {
        response.destroy(new ProbeError("connected peer did not match the validated DNS answer", "probe-target-refused"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > input.maxBytes) {
          response.destroy(new ProbeError("probe response exceeded its byte limit", "probe-response-too-large"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on("end", () => resolve({
        status: response.statusCode || 0,
        location: typeof response.headers.location === "string" ? response.headers.location : null,
        body: Buffer.concat(chunks),
        remote,
      }));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new ProbeError("probe timed out", "probe-timeout")));
    request.on("error", reject);
    request.end();
  });
}

export async function httpProbe(request: HttpProbeRequest): Promise<HttpProbeResult> {
  const method = request.method || "GET";
  if (!new Set(["GET", "HEAD", "OPTIONS"]).has(method)) {
    throw new ProbeError("deployment probes cannot use a state-changing method", "manifest-invalid");
  }
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new ProbeError("probe URL is invalid", "manifest-invalid");
  }
  if (url.username || url.password) throw new ProbeError("probe URL cannot contain credentials", "manifest-invalid");
  const allowedPrivate = new Set((request.privateAllowedOrigins || []).map((origin) => new URL(origin).origin));
  const firstOrigin = normalizedOrigin(url);
  const allowPrivate = allowedPrivate.has(firstOrigin);
  if (url.protocol !== "https:" && !allowPrivate) {
    throw new ProbeError("public deployment probes require HTTPS", "probe-target-refused");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProbeError("probe URL must use HTTP or HTTPS", "manifest-invalid");
  }

  const normalized = {
    ...request,
    method,
    timeoutMs: Math.min(Math.max(Number(request.timeoutMs) || 8_000, 250), 30_000),
    maxBytes: Math.min(Math.max(Number(request.maxBytes) || 256 * 1024, 1), 1024 * 1024),
  };
  const started = Date.now();
  let redirects = 0;
  while (true) {
    const currentAllowPrivate = allowedPrivate.has(normalizedOrigin(url));
    const response = await oneRequest(url, normalized, currentAllowPrivate);
    if (response.status >= 300 && response.status < 400 && response.location) {
      if (!request.followSameOriginRedirects) {
        return { ok: true, status: response.status, url: url.href, observedAt: Date.now(), durationMs: Date.now() - started, bytes: response.body.length, redirects };
      }
      if (++redirects > 3) throw new ProbeError("probe followed too many redirects", "dependency-failed");
      const next = new URL(response.location, url);
      if (next.origin !== url.origin) throw new ProbeError("probe refused a cross-origin redirect", "probe-target-refused");
      url = next;
      continue;
    }
    let json: unknown;
    const type = response.body.length ? response.body.toString("utf8") : "";
    if (type) {
      try { json = JSON.parse(type); } catch { /* status-only probes do not require JSON */ }
    }
    return {
      ok: true,
      status: response.status,
      url: url.href,
      observedAt: Date.now(),
      durationMs: Date.now() - started,
      bytes: response.body.length,
      ...(json === undefined ? {} : { json }),
      redirects,
    };
  }
}

export function jsonPath(value: unknown, expression: string): unknown {
  if (expression === "$") return value;
  if (!/^\$(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(expression)) {
    throw new ProbeError("v1 JSON predicates use simple $.field paths only", "manifest-invalid");
  }
  let current = value;
  for (const part of expression.slice(2).split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
