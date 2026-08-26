import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

interface StreamTicketRecord {
  digest: Buffer;
  runId: string;
  origin: string;
  agentGeneration: number;
  expiresAt: number;
}

const digest = (token: string) => createHash("sha256").update(token).digest();

function requestOrigin(req: Pick<Request, "headers">): string {
  return typeof req.headers.origin === "string" && req.headers.origin
    ? req.headers.origin
    : `local://${String(req.headers.host || "unknown")}`;
}

export class DeploymentStreamTicketRegistry {
  readonly #records = new Map<string, StreamTicketRecord>();

  constructor(readonly ttlMs = 60_000) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 5_000 || ttlMs > 5 * 60_000) throw new Error("stream ticket TTL is out of range");
  }

  mint(input: { runId: string; origin: string; agentGeneration: number }, now = Date.now()) {
    this.prune(now);
    const ticket = randomBytes(32).toString("base64url");
    const hashed = digest(ticket);
    const expiresAt = now + this.ttlMs;
    this.#records.set(hashed.toString("hex"), { digest: hashed, ...input, expiresAt });
    return { ticket, expiresAt };
  }

  validate(input: { ticket: string; runId: string; origin: string; agentGeneration: number }, now = Date.now()): boolean {
    const hashed = digest(input.ticket);
    const record = this.#records.get(hashed.toString("hex"));
    return !!record
      && record.expiresAt > now
      && timingSafeEqual(record.digest, hashed)
      && record.runId === input.runId
      && record.origin === input.origin
      && record.agentGeneration === input.agentGeneration;
  }

  validateRequest(req: Request, agentGeneration: number): boolean {
    const match = /^\/api\/deployment-runs\/([^/]+)\/stream$/.exec(req.path);
    const ticket = typeof req.query?.ticket === "string" ? req.query.ticket : "";
    if (!match || !ticket) return false;
    return this.validate({ ticket, runId: decodeURIComponent(match[1]), origin: requestOrigin(req), agentGeneration });
  }

  originFor(req: Request): string {
    return requestOrigin(req);
  }

  prune(now = Date.now()): void {
    for (const [key, record] of this.#records) if (record.expiresAt <= now) this.#records.delete(key);
  }
}
