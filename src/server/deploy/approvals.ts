import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

interface ApprovalIntentRecord {
  digest: Buffer;
  planId: string;
  planRevision: number;
  planDigest: string;
  actorSubject: string;
  agentId: string;
  origin: "local" | "paired";
  expiresAt: number;
}

export interface ApprovalIntentBinding {
  planId: string;
  planRevision: number;
  planDigest: string;
  actorSubject: string;
  agentId: string;
  origin: "local" | "paired";
}

const hash = (token: string) => createHash("sha256").update(token).digest();

/** Short-lived, one-use, same-session intent. Only its digest remains in memory. */
export class ApprovalIntentRegistry {
  readonly #records = new Map<string, ApprovalIntentRecord>();

  constructor(readonly ttlMs = 90_000) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 5_000 || ttlMs > 10 * 60_000) {
      throw new Error("approval intent TTL must be between five seconds and ten minutes");
    }
  }

  mint(binding: ApprovalIntentBinding, now = Date.now()): { intent: string; expiresAt: number } {
    this.prune(now);
    const intent = randomBytes(32).toString("base64url");
    const digest = hash(intent);
    const expiresAt = now + this.ttlMs;
    this.#records.set(digest.toString("hex"), { digest, ...binding, expiresAt });
    return { intent, expiresAt };
  }

  consume(intent: string, binding: ApprovalIntentBinding, now = Date.now()): boolean {
    const digest = hash(intent);
    const key = digest.toString("hex");
    const record = this.#records.get(key);
    this.#records.delete(key);
    if (!record || record.expiresAt <= now || !timingSafeEqual(record.digest, digest)) return false;
    return record.planId === binding.planId
      && record.planRevision === binding.planRevision
      && record.planDigest === binding.planDigest
      && record.actorSubject === binding.actorSubject
      && record.agentId === binding.agentId
      && record.origin === binding.origin;
  }

  prune(now = Date.now()): void {
    for (const [key, record] of this.#records) if (record.expiresAt <= now) this.#records.delete(key);
  }
}
