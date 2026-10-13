import https from "node:https";
import type {HostMetrics} from "./metrics.ts";
import { DatabaseSync } from "node:sqlite";

export interface Monitor {
  id: string; url: string; expectedStatus: number; intervalSeconds: number;
  timeoutSeconds: number; tlsWarningDays: number; confirmationChecks: number;
  recoveryChecks: number; expectJson?: Record<string, string | boolean | number>;
}
export interface Sample {
  id: string; url: string; hostname: string; observedAt: number;
  state: "healthy" | "degraded" | "down"; status: number | null;
  durationMs: number; tlsExpiresAt: number | null; detail: string;
}
export function monitorsFromConfig(input: unknown): Monitor[] {
  const entries = (input as { monitors?: unknown[] })?.monitors;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 50) throw Error("Configure 1–50 monitors");
  const ids = new Set<string>();
  return entries.map((value) => {
    const m = value as Monitor;
    if (!m || !/^[a-z][a-z0-9-]{0,79}$/.test(m.id) || ids.has(m.id)) throw Error("Invalid or duplicate monitor ID");
    ids.add(m.id);
    const url = new URL(m.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw Error("Monitor URLs must be HTTPS without credentials, queries or fragments");
    const bounded = (key: keyof Monitor, fallback: number, min: number, max: number) => {
      const n = m[key] ?? fallback;
      if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw Error(`Invalid ${key}`);
      return n;
    };
    if (m.expectJson && (typeof m.expectJson !== "object" || Array.isArray(m.expectJson)
      || Object.entries(m.expectJson).some(([key, value]) => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) || !["string", "boolean", "number"].includes(typeof value)))) throw Error("Invalid JSON predicates");
    return { id: m.id, url: url.href, expectedStatus: bounded("expectedStatus", 200, 100, 599),
      intervalSeconds: bounded("intervalSeconds", 60, 10, 3600), timeoutSeconds: bounded("timeoutSeconds", 10, 1, 30),
      tlsWarningDays: bounded("tlsWarningDays", 14, 1, 90), confirmationChecks: bounded("confirmationChecks", 2, 1, 10),
      recoveryChecks: bounded("recoveryChecks", 2, 1, 10), ...(m.expectJson ? {expectJson: m.expectJson} : {}) };
  });
}

/** Public probes never record response bodies, headers, cookies or credentials. */
export function probe(m: Monitor, trust?: {ca: string}): Promise<Sample> {
  const started = Date.now();
  const url = new URL(m.url);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (values: Partial<Sample>) => {
      if (settled) return; settled = true; clearTimeout(deadline);
      resolve({ id: m.id, url: m.url, hostname: url.hostname, observedAt: Date.now(),
        state: "down", status: null, durationMs: Date.now() - started, tlsExpiresAt: null, detail: "HTTPS check failed", ...values });
    };
    const request = https.get(url, { rejectUnauthorized: true, agent: false, ...(trust ?? {}) }, (response) => {
      const socket = response.socket as import("node:tls").TLSSocket;
      const expiry = Date.parse(socket.getPeerCertificate().valid_to);
      const tlsExpiresAt = Number.isFinite(expiry) ? expiry : null;
      const status = response.statusCode ?? 0;
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 65536) { request.destroy(); finish({status, tlsExpiresAt, detail: "Response exceeded 64 KiB"}); }
        else if (m.expectJson) chunks.push(chunk);
      });
      response.on("error", () => finish({status, tlsExpiresAt, detail: "Incomplete HTTP response"}));
      response.on("end", () => {
        if (status !== m.expectedStatus) return finish({status, tlsExpiresAt, detail: `Expected HTTP ${m.expectedStatus}, received ${status}`});
        if (!socket.authorized || tlsExpiresAt === null) return finish({status, tlsExpiresAt, detail: "TLS evidence unavailable"});
        if (m.expectJson) {
          let json: Record<string, unknown>;
          try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
          catch { return finish({status, tlsExpiresAt, detail: "Expected health JSON"}); }
          if (!json || Object.entries(m.expectJson).some(([key, value]) => json[key] !== value)) return finish({status, tlsExpiresAt, detail: "Health JSON did not match"});
        }
        const warning = tlsExpiresAt - Date.now() <= m.tlsWarningDays * 86400000;
        finish({state: warning ? "degraded" : "healthy", status, tlsExpiresAt,
          detail: warning ? "TLS certificate expiry is approaching" : `HTTP ${status}; TLS verified`});
      });
    });
    const deadline = setTimeout(() => { request.destroy(); finish({detail: "HTTPS check timed out"}); }, m.timeoutSeconds * 1000);
    request.on("error", () => finish({detail: "HTTPS connection or TLS verification failed"}));
  });
}

export class WatchStore {
  constructor(readonly database: DatabaseSync) {
    database.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS host_samples(at INTEGER PRIMARY KEY, metrics TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS latest(id TEXT PRIMARY KEY, sample TEXT NOT NULL, state TEXT NOT NULL, failures INTEGER NOT NULL, successes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS samples(id TEXT NOT NULL, at INTEGER NOT NULL, sample TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS samples_at ON samples(at);
      CREATE TABLE IF NOT EXISTS incidents(id INTEGER PRIMARY KEY, monitor TEXT NOT NULL, opened INTEGER NOT NULL, resolved INTEGER, detail TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS incident_open ON incidents(monitor) WHERE resolved IS NULL;`);
  }
  record(m: Monitor, sample: Sample): Record<string, unknown> {
    const old = this.database.prepare("SELECT state, failures, successes FROM latest WHERE id=?").get(m.id) as {state: string; failures: number; successes: number} | undefined;
    const failed = sample.state !== "healthy";
    const failures = failed ? (old?.failures ?? 0) + 1 : 0;
    const successes = failed ? 0 : (old?.successes ?? 0) + 1;
    let state = old?.state ?? "unknown";
    if (failed && failures >= m.confirmationChecks) state = sample.state;
    else if (!failed && (state === "unknown" || state === "healthy" || successes >= m.recoveryChecks)) state = "healthy";
    // The very first failure is unconfirmed but cannot be green.
    if (failed && state === "healthy" && failures < m.confirmationChecks) state = "degraded";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("INSERT INTO latest VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sample=excluded.sample,state=excluded.state,failures=excluded.failures,successes=excluded.successes")
        .run(m.id, JSON.stringify(sample), state, failures, successes);
      this.database.prepare("INSERT INTO samples VALUES(?,?,?)").run(m.id, sample.observedAt, JSON.stringify(sample));
      if (failed && failures >= m.confirmationChecks) this.database.prepare("INSERT OR IGNORE INTO incidents(monitor,opened,detail) VALUES(?,?,?)").run(m.id, sample.observedAt, sample.detail);
      if (!failed && state === "healthy") this.database.prepare("UPDATE incidents SET resolved=? WHERE monitor=? AND resolved IS NULL").run(sample.observedAt, m.id);
      this.database.prepare("DELETE FROM samples WHERE at < ?").run(sample.observedAt - 7 * 86400000);
      this.database.prepare("DELETE FROM incidents WHERE resolved < ?").run(sample.observedAt - 90 * 86400000);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    return this.observation(m.id)!;
  }
  recordHost(metrics: HostMetrics): void {
    this.database.prepare("INSERT OR REPLACE INTO host_samples VALUES(?,?)").run(metrics.observedAt,JSON.stringify(metrics));
    this.database.prepare("DELETE FROM host_samples WHERE at < ?").run(metrics.observedAt-7*86400000);
  }
  history(id: string, now=Date.now()): Record<string, unknown> {
    const since=now-7*86400000;
    const checks=this.database.prepare(`SELECT (at/3600000)*3600000 AS at, count(*) AS checks,
      sum(json_extract(sample,'$.state')='healthy') AS healthy,
      sum(json_extract(sample,'$.state')='degraded') AS degraded,
      sum(json_extract(sample,'$.state')='down') AS down,
      round(avg(json_extract(sample,'$.durationMs')),1) AS latencyMs
      FROM samples WHERE id=? AND at>=? GROUP BY 1 ORDER BY 1`).all(id,since);
    const host=this.database.prepare(`SELECT (at/3600000)*3600000 AS at,
      round(avg(json_extract(metrics,'$.cpuPercent')),1) AS cpuPercent,
      round(avg(json_extract(metrics,'$.memoryUsedBytes'))) AS memoryUsedBytes,
      max(json_extract(metrics,'$.memoryTotalBytes')) AS memoryTotalBytes,
      max(json_extract(metrics,'$.diskUsedBytes')) AS diskUsedBytes,
      max(json_extract(metrics,'$.diskTotalBytes')) AS diskTotalBytes,
      round(avg(json_extract(metrics,'$.load1')),2) AS load1
      FROM host_samples WHERE at>=? GROUP BY 1 ORDER BY 1`).all(since);
    const latest=this.database.prepare('SELECT metrics FROM host_samples ORDER BY at DESC LIMIT 1').get() as {metrics:string}|undefined;
    const incidentTime=(start:number)=> Number((this.database.prepare(`SELECT coalesce(sum(max(0,min(coalesce(resolved,?),?)-max(opened,?))),0) AS duration
      FROM incidents WHERE monitor=? AND opened<? AND (resolved IS NULL OR resolved>?)`).get(now,now,start,id,now,start) as {duration:number}).duration);
    return {checks,host,incidentTime24hMs:incidentTime(now-86400000),incidentTime7dMs:incidentTime(since),hostLatest:latest?JSON.parse(latest.metrics):null,bucketSeconds:3600,retentionDays:7};
  }
  observation(id: string): Record<string, unknown> | null {
    const row = this.database.prepare("SELECT sample,state FROM latest WHERE id=?").get(id) as {sample: string; state: string} | undefined;
    if (!row) return null;
    const incidents = this.database.prepare("SELECT id,opened,resolved,detail FROM incidents WHERE monitor=? ORDER BY opened DESC LIMIT 20").all(id);
    return {...JSON.parse(row.sample), effectiveState: row.state, incidents};
  }
}
