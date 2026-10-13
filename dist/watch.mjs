// src/watch/main.ts
import fs2 from "node:fs";
import os2 from "node:os";
import path from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";

// src/watch/metrics.ts
import fs from "node:fs";
import os from "node:os";
function cpuCounters(text) {
  const values = text.split("\n")[0].trim().split(/\s+/).slice(1, 9).map(Number);
  if (values.length !== 8 || values.some((n) => !Number.isFinite(n) || n < 0)) throw Error("CPU counters unavailable");
  return { total: values.reduce((a, b) => a + b, 0), idle: values[3] + values[4] };
}
function cpuUsage(previous, current) {
  if (!previous || current.total <= previous.total || current.idle < previous.idle) return null;
  return Math.max(0, Math.min(100, 100 * (1 - (current.idle - previous.idle) / (current.total - previous.total))));
}
var HostCollector = class {
  previous = null;
  collect() {
    const counters = cpuCounters(fs.readFileSync("/proc/stat", "utf8"));
    const cpuPercent = cpuUsage(this.previous, counters);
    this.previous = counters;
    const mem = Object.fromEntries([...fs.readFileSync("/proc/meminfo", "utf8").matchAll(/^(MemTotal|MemAvailable):\s+(\d+) kB/gm)].map((m) => [m[1], Number(m[2]) * 1024]));
    if (!mem.MemTotal || !Number.isFinite(mem.MemAvailable)) throw Error("Memory metrics unavailable");
    const diskPath = "/srv";
    const disk = fs.statfsSync(diskPath);
    return { observedAt: Date.now(), hostname: os.hostname(), cpuPercent, memoryUsedBytes: mem.MemTotal - mem.MemAvailable, memoryTotalBytes: mem.MemTotal, diskUsedBytes: (disk.blocks - disk.bfree) * disk.bsize, diskTotalBytes: disk.blocks * disk.bsize, diskPath, load1: os.loadavg()[0], uptimeSeconds: os.uptime() };
  }
};

// src/watch/watch.ts
import https from "node:https";
import "node:sqlite";
function monitorsFromConfig(input) {
  const entries = input?.monitors;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 50) throw Error("Configure 1\u201350 monitors");
  const ids = /* @__PURE__ */ new Set();
  return entries.map((value) => {
    const m = value;
    if (!m || !/^[a-z][a-z0-9-]{0,79}$/.test(m.id) || ids.has(m.id)) throw Error("Invalid or duplicate monitor ID");
    ids.add(m.id);
    const url = new URL(m.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw Error("Monitor URLs must be HTTPS without credentials, queries or fragments");
    const bounded = (key, fallback, min, max) => {
      const n = m[key] ?? fallback;
      if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw Error(`Invalid ${key}`);
      return n;
    };
    if (m.expectJson && (typeof m.expectJson !== "object" || Array.isArray(m.expectJson) || Object.entries(m.expectJson).some(([key, value2]) => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) || !["string", "boolean", "number"].includes(typeof value2)))) throw Error("Invalid JSON predicates");
    return {
      id: m.id,
      url: url.href,
      expectedStatus: bounded("expectedStatus", 200, 100, 599),
      intervalSeconds: bounded("intervalSeconds", 60, 10, 3600),
      timeoutSeconds: bounded("timeoutSeconds", 10, 1, 30),
      tlsWarningDays: bounded("tlsWarningDays", 14, 1, 90),
      confirmationChecks: bounded("confirmationChecks", 2, 1, 10),
      recoveryChecks: bounded("recoveryChecks", 2, 1, 10),
      ...m.expectJson ? { expectJson: m.expectJson } : {}
    };
  });
}
function probe(m, trust) {
  const started = Date.now();
  const url = new URL(m.url);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (values) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({
        id: m.id,
        url: m.url,
        hostname: url.hostname,
        observedAt: Date.now(),
        state: "down",
        status: null,
        durationMs: Date.now() - started,
        tlsExpiresAt: null,
        detail: "HTTPS check failed",
        ...values
      });
    };
    const request = https.get(url, { rejectUnauthorized: true, agent: false, ...trust ?? {} }, (response) => {
      const socket = response.socket;
      const expiry = Date.parse(socket.getPeerCertificate().valid_to);
      const tlsExpiresAt = Number.isFinite(expiry) ? expiry : null;
      const status = response.statusCode ?? 0;
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 65536) {
          request.destroy();
          finish({ status, tlsExpiresAt, detail: "Response exceeded 64 KiB" });
        } else if (m.expectJson) chunks.push(chunk);
      });
      response.on("error", () => finish({ status, tlsExpiresAt, detail: "Incomplete HTTP response" }));
      response.on("end", () => {
        if (status !== m.expectedStatus) return finish({ status, tlsExpiresAt, detail: `Expected HTTP ${m.expectedStatus}, received ${status}` });
        if (!socket.authorized || tlsExpiresAt === null) return finish({ status, tlsExpiresAt, detail: "TLS evidence unavailable" });
        if (m.expectJson) {
          let json;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            return finish({ status, tlsExpiresAt, detail: "Expected health JSON" });
          }
          if (!json || Object.entries(m.expectJson).some(([key, value]) => json[key] !== value)) return finish({ status, tlsExpiresAt, detail: "Health JSON did not match" });
        }
        const warning = tlsExpiresAt - Date.now() <= m.tlsWarningDays * 864e5;
        finish({
          state: warning ? "degraded" : "healthy",
          status,
          tlsExpiresAt,
          detail: warning ? "TLS certificate expiry is approaching" : `HTTP ${status}; TLS verified`
        });
      });
    });
    const deadline = setTimeout(() => {
      request.destroy();
      finish({ detail: "HTTPS check timed out" });
    }, m.timeoutSeconds * 1e3);
    request.on("error", () => finish({ detail: "HTTPS connection or TLS verification failed" }));
  });
}
var WatchStore = class {
  constructor(database) {
    this.database = database;
    database.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS host_samples(at INTEGER PRIMARY KEY, metrics TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS latest(id TEXT PRIMARY KEY, sample TEXT NOT NULL, state TEXT NOT NULL, failures INTEGER NOT NULL, successes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS samples(id TEXT NOT NULL, at INTEGER NOT NULL, sample TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS samples_at ON samples(at);
      CREATE TABLE IF NOT EXISTS incidents(id INTEGER PRIMARY KEY, monitor TEXT NOT NULL, opened INTEGER NOT NULL, resolved INTEGER, detail TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS incident_open ON incidents(monitor) WHERE resolved IS NULL;`);
  }
  database;
  record(m, sample) {
    const old = this.database.prepare("SELECT state, failures, successes FROM latest WHERE id=?").get(m.id);
    const failed = sample.state !== "healthy";
    const failures = failed ? (old?.failures ?? 0) + 1 : 0;
    const successes = failed ? 0 : (old?.successes ?? 0) + 1;
    let state = old?.state ?? "unknown";
    if (failed && failures >= m.confirmationChecks) state = sample.state;
    else if (!failed && (state === "unknown" || state === "healthy" || successes >= m.recoveryChecks)) state = "healthy";
    if (failed && state === "healthy" && failures < m.confirmationChecks) state = "degraded";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("INSERT INTO latest VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sample=excluded.sample,state=excluded.state,failures=excluded.failures,successes=excluded.successes").run(m.id, JSON.stringify(sample), state, failures, successes);
      this.database.prepare("INSERT INTO samples VALUES(?,?,?)").run(m.id, sample.observedAt, JSON.stringify(sample));
      if (failed && failures >= m.confirmationChecks) this.database.prepare("INSERT OR IGNORE INTO incidents(monitor,opened,detail) VALUES(?,?,?)").run(m.id, sample.observedAt, sample.detail);
      if (!failed && state === "healthy") this.database.prepare("UPDATE incidents SET resolved=? WHERE monitor=? AND resolved IS NULL").run(sample.observedAt, m.id);
      this.database.prepare("DELETE FROM samples WHERE at < ?").run(sample.observedAt - 7 * 864e5);
      this.database.prepare("DELETE FROM incidents WHERE resolved < ?").run(sample.observedAt - 90 * 864e5);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.observation(m.id);
  }
  recordHost(metrics) {
    this.database.prepare("INSERT OR REPLACE INTO host_samples VALUES(?,?)").run(metrics.observedAt, JSON.stringify(metrics));
    this.database.prepare("DELETE FROM host_samples WHERE at < ?").run(metrics.observedAt - 7 * 864e5);
  }
  history(id, now = Date.now()) {
    const since = now - 7 * 864e5;
    const checks = this.database.prepare(`SELECT (at/3600000)*3600000 AS at, count(*) AS checks,
      sum(json_extract(sample,'$.state')='healthy') AS healthy,
      sum(json_extract(sample,'$.state')='degraded') AS degraded,
      sum(json_extract(sample,'$.state')='down') AS down,
      round(avg(json_extract(sample,'$.durationMs')),1) AS latencyMs
      FROM samples WHERE id=? AND at>=? GROUP BY 1 ORDER BY 1`).all(id, since);
    const host = this.database.prepare(`SELECT (at/3600000)*3600000 AS at,
      round(avg(json_extract(metrics,'$.cpuPercent')),1) AS cpuPercent,
      round(avg(json_extract(metrics,'$.memoryUsedBytes'))) AS memoryUsedBytes,
      max(json_extract(metrics,'$.memoryTotalBytes')) AS memoryTotalBytes,
      max(json_extract(metrics,'$.diskUsedBytes')) AS diskUsedBytes,
      max(json_extract(metrics,'$.diskTotalBytes')) AS diskTotalBytes,
      round(avg(json_extract(metrics,'$.load1')),2) AS load1
      FROM host_samples WHERE at>=? GROUP BY 1 ORDER BY 1`).all(since);
    const latest = this.database.prepare("SELECT metrics FROM host_samples ORDER BY at DESC LIMIT 1").get();
    const incidentTime = (start) => Number(this.database.prepare(`SELECT coalesce(sum(max(0,min(coalesce(resolved,?),?)-max(opened,?))),0) AS duration
      FROM incidents WHERE monitor=? AND opened<? AND (resolved IS NULL OR resolved>?)`).get(now, now, start, id, now, start).duration);
    return { checks, host, incidentTime24hMs: incidentTime(now - 864e5), incidentTime7dMs: incidentTime(since), hostLatest: latest ? JSON.parse(latest.metrics) : null, bucketSeconds: 3600, retentionDays: 7 };
  }
  observation(id) {
    const row = this.database.prepare("SELECT sample,state FROM latest WHERE id=?").get(id);
    if (!row) return null;
    const incidents = this.database.prepare("SELECT id,opened,resolved,detail FROM incidents WHERE monitor=? ORDER BY opened DESC LIMIT 20").all(id);
    return { ...JSON.parse(row.sample), effectiveState: row.state, incidents };
  }
};

// src/watch/main.ts
var stateDirectory = process.env.WEREWOLF_WATCH_STATE ?? "/var/lib/psm-watch";
if (process.argv[2] === "read") {
  const command = process.env.SSH_ORIGINAL_COMMAND ?? process.argv[3] ?? "";
  const match = /^watch ([a-z][a-z0-9-]{0,79})$/.exec(command);
  if (!match) throw Error("Only watch <monitor-id> is available");
  const file = path.join(stateDirectory, "snapshots", `${match[1]}.json`);
  const stat = fs2.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 131072) throw Error("Invalid snapshot");
  process.stdout.write(fs2.readFileSync(file));
} else {
  const configFile = process.env.WEREWOLF_WATCH_CONFIG ?? "/etc/psm-watch/monitors.json";
  const monitors = monitorsFromConfig(JSON.parse(fs2.readFileSync(configFile, "utf8")));
  fs2.mkdirSync(path.join(stateDirectory, "snapshots"), { recursive: true, mode: 488 });
  const store = new WatchStore(new DatabaseSync2(path.join(stateDirectory, "watch.db")));
  const collector = new HostCollector();
  let hostDue = 0;
  const due = /* @__PURE__ */ new Map();
  let stopped = false;
  process.on("SIGTERM", () => {
    stopped = true;
  });
  process.on("SIGINT", () => {
    stopped = true;
  });
  while (!stopped) {
    if (Date.now() >= hostDue) {
      try {
        store.recordHost(collector.collect());
      } catch {
        console.error("Host metrics unavailable");
      }
      hostDue = Date.now() + 6e4;
    }
    const ready = monitors.filter((monitor) => (due.get(monitor.id) ?? 0) <= Date.now());
    for (let offset = 0; offset < ready.length && !stopped; offset += 4) {
      await Promise.all(ready.slice(offset, offset + 4).map(async (monitor) => {
        const sample = await probe(monitor);
        const observation = store.record(monitor, sample);
        const snapshot = {
          schema: "werewolf.watch/v1",
          monitorId: monitor.id,
          observer: os2.hostname(),
          failureDomain: process.env.WEREWOLF_WATCH_FAILURE_DOMAIN ?? "unspecified",
          ...observation,
          history: store.history(monitor.id)
        };
        const destination = path.join(stateDirectory, "snapshots", `${monitor.id}.json`);
        const temporary = `${destination}.tmp`;
        fs2.writeFileSync(temporary, JSON.stringify(snapshot) + "\n", { mode: 416 });
        fs2.renameSync(temporary, destination);
        due.set(monitor.id, Date.now() + monitor.intervalSeconds * 1e3);
        const incident = observation.incidents[0];
        if (incident?.opened === sample.observedAt || incident?.resolved === sample.observedAt) console.log(JSON.stringify({ monitor: monitor.id, state: observation.effectiveState, incident }));
      }));
    }
    if (!stopped) await new Promise((resolve) => setTimeout(resolve, 1e3));
  }
  store.database.close();
}
