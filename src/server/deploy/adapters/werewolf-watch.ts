import type { WatchObservation } from "../observations.ts";
import type { ExternalHttpWatch } from "../types.ts";
import type { ConnectionProfile } from "../connections.ts";
import type { MachineTransport } from "../../machines/ssh.ts";
import { parseKnownHost } from "../../machines/plan.ts";

export function normalizeWerewolfWatch(text: string, definition: ExternalHttpWatch, now = Date.now()): WatchObservation {
  if (Buffer.byteLength(text) > 131072) throw Error("Werewolf Watch response is too large");
  const snapshot = JSON.parse(text);
  if (!snapshot || snapshot.schema !== "werewolf.watch/v1" || snapshot.monitorId !== definition.monitorKey) throw Error("Werewolf Watch returned another monitor");
  const url = new URL(snapshot.url);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.hostname !== definition.hostname || snapshot.hostname !== definition.hostname) throw Error("Werewolf Watch target does not match");
  if (!Number.isSafeInteger(snapshot.observedAt) || snapshot.observedAt <= 0 || snapshot.observedAt > now + 5000) throw Error("Werewolf Watch timestamp is invalid");
  const states = ["healthy", "down", "degraded", "unknown"];
  if (!states.includes(snapshot.effectiveState)) throw Error("Werewolf Watch state is invalid");
  if (["healthy", "degraded"].includes(snapshot.effectiveState) && snapshot.state === "healthy"
    && (!Number.isSafeInteger(snapshot.tlsExpiresAt) || snapshot.tlsExpiresAt <= snapshot.observedAt || !Number.isInteger(snapshot.status))) throw Error("Werewolf Watch TLS evidence is invalid");
  if (snapshot.effectiveState === "healthy" && snapshot.state !== "healthy") throw Error("Werewolf Watch health evidence is inconsistent");
  const state = now - snapshot.observedAt > definition.maxObservationAgeSeconds * 1000 ? "stale" : snapshot.effectiveState;
  const detail = typeof snapshot.detail === "string" ? snapshot.detail.slice(0, 300) : "Monitor observation";
  return {monitorId: definition.id, providerState: snapshot.effectiveState, effectiveState: state,
    observedAt: snapshot.observedAt, detail: `Werewolf Watch: ${detail}`, evidence: {
      provider: "werewolf-watch@1", providerMonitorId: definition.monitorKey, url: url.href,
      observer: typeof snapshot.observer === "string" ? snapshot.observer.slice(0, 100) : "unknown",
      failureDomain: ["same-host", "independent-host"].includes(snapshot.failureDomain) ? snapshot.failureDomain : "unspecified",
      history: normalizeHistory(snapshot.history, now),
      status: snapshot.status, durationMs: snapshot.durationMs, tlsExpiresAt: snapshot.tlsExpiresAt,
      incidents: Array.isArray(snapshot.incidents) ? snapshot.incidents.filter((i: unknown) => i !== null && typeof i === "object").slice(0,20).map((i: Record<string, unknown>) => ({id:Number.isSafeInteger(i.id)?i.id:null,opened:Number.isSafeInteger(i.opened)?i.opened:null,resolved:Number.isSafeInteger(i.resolved)?i.resolved:null,detail:typeof i.detail === "string" ? i.detail.slice(0,300) : "Incident"})) : [],
    }};
}

export async function observeWerewolfWatch(profile: ConnectionProfile, transport: MachineTransport, definition: ExternalHttpWatch): Promise<WatchObservation> {
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(definition.monitorKey)) throw Error("Invalid Werewolf monitor ID");
  const ssh = profile.constraints.ssh;
  if (!ssh) throw Error("Werewolf monitoring needs a pinned reader connection");
  const pin = parseKnownHost(profile.publicMetadata?.knownHost, ssh.host, ssh.port);
  if (pin.fingerprint !== ssh.hostKeyFingerprint) throw Error("Werewolf monitoring host key differs from the connection");
  const result = await transport.run({host:ssh.host,port:ssh.port,user:ssh.user,knownHost:pin.knownHost,connectionId:profile.connectionId}, `watch ${definition.monitorKey}`, "", {timeoutMs:15000});
  if (result.code !== 0) throw Error("Werewolf monitor snapshot is unavailable");
  return normalizeWerewolfWatch(result.stdout, definition);
}

/** Accept only bounded numeric public metrics; arbitrary observer data cannot reach the UI. */
export function normalizeHistory(input: unknown, now=Date.now()): Record<string, unknown>|null {
  if(!input || typeof input!=="object")return null;
  const value=input as Record<string,any>;
  const numeric=(row:Record<string,unknown>,keys:string[])=>Object.fromEntries(keys.map(key=>[key,typeof row[key]==="number" && Number.isFinite(row[key]) && (row[key] as number)>=0?row[key]:null]));
  const rows=(list:unknown,keys:string[])=>Array.isArray(list)?list.slice(-169).filter(row=>row && typeof row==="object" && Number.isSafeInteger(row.at) && row.at>now-8*86400000 && row.at<=now).map(row=>numeric(row,keys)):[];
  const latest=value.hostLatest;
  return {bucketSeconds:3600,retentionDays:7,
    ...numeric(value,["incidentTime24hMs","incidentTime7dMs"]),
    checks:rows(value.checks,["at","checks","healthy","degraded","down","latencyMs"]),
    host:rows(value.host,["at","cpuPercent","memoryUsedBytes","memoryTotalBytes","diskUsedBytes","diskTotalBytes","load1"]),
    hostLatest:latest && typeof latest==="object" && Number.isSafeInteger(latest.observedAt) && latest.observedAt<=now+5000 ? {
      ...numeric(latest,["observedAt","cpuPercent","memoryUsedBytes","memoryTotalBytes","diskUsedBytes","diskTotalBytes","load1","uptimeSeconds"]),
      hostname:typeof latest.hostname==="string"?latest.hostname.slice(0,100):"unknown",diskPath:"/srv",
    }:null};
}
