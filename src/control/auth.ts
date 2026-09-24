/**
 * Who is calling the control service, and which workspaces they may act in.
 *
 * Membership is decided by Werewolf, re-read with a short cache: a removed
 * member loses access within a minute, and an unreachable Werewolf is an error,
 * never "no workspaces" silently downgraded to something else. A personal
 * workspace is `user:<id>` here, so two people's personal workspaces are two
 * different workspaces — the local cockpit's bare "personal" means only "me".
 */
import { createHash } from "node:crypto";

export type Role = "owner" | "admin" | "member" | "viewer";

export interface Membership {
  ref: string;
  role: Role;
  canWrite: boolean;
  canManage: boolean;
}

export interface Principal {
  subject: string;
  name: string;
  workspaces: Map<string, Membership>;
}

export class AuthError extends Error {
  constructor(message: string, readonly status: 401 | 403 | 503) {
    super(message);
    this.name = "AuthError";
  }
}

export interface Verifier {
  verify(token: string): Promise<Principal>;
}

const REF_PATTERN = /^(user:[A-Za-z0-9_-]{1,64}|business:[a-f0-9]{24})$/;
export const isControlWorkspace = (value: unknown): value is string => typeof value === "string" && REF_PATTERN.test(value);

type Fetch = typeof fetch;

export class WerewolfVerifier implements Verifier {
  readonly #cache = new Map<string, { at: number; principal: Principal }>();

  constructor(private readonly apiUrl: string, private readonly fetchImpl: Fetch = fetch, private readonly ttlMs = 60_000) {}

  async #get(token: string, pathname: string): Promise<any> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiUrl.replace(/\/+$/, "")}/apps/psm${pathname}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    } catch {
      throw new AuthError("Werewolf could not be reached to verify this session.", 503);
    }
    if (response.status === 401 || response.status === 403) throw new AuthError("This Werewolf session is not valid. Sign in again.", 401);
    if (!response.ok) throw new AuthError(`Werewolf answered ${response.status} while verifying this session.`, 503);
    const body = await response.json().catch(() => null);
    if (!body || body.success === false) throw new AuthError("Werewolf returned an unreadable answer.", 503);
    return body.data ?? body;
  }

  async verify(token: string): Promise<Principal> {
    if (!/^[\x21-\x7e]{16,4096}$/.test(token)) throw new AuthError("Missing or malformed bearer token.", 401);
    const key = createHash("sha256").update(token).digest("hex");
    const cached = this.#cache.get(key);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.principal;
    const me = await this.#get(token, "/me");
    const user = me.user ?? me;
    const subject = String(user.id ?? user._id ?? "");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(subject)) throw new AuthError("Werewolf did not identify the user.", 503);
    const listed = await this.#get(token, "/workspaces");
    const workspaces = new Map<string, Membership>();
    workspaces.set(`user:${subject}`, { ref: `user:${subject}`, role: "owner", canWrite: true, canManage: true });
    for (const entry of Array.isArray(listed) ? listed : []) {
      const ref = String(entry?.ref ?? "").toLowerCase();
      if (entry?.kind !== "business" || !isControlWorkspace(ref)) continue;
      const role = (["owner", "admin", "member", "viewer"].includes(entry.role) ? entry.role : "viewer") as Role;
      workspaces.set(ref, { ref, role, canWrite: entry.canWrite === true, canManage: entry.canManage === true });
    }
    const principal = { subject: `werewolf:${subject}`, name: String(user.name ?? user.email ?? subject), workspaces };
    this.#cache.set(key, { at: Date.now(), principal });
    return principal;
  }
}

/**
 * Fixed tokens for local development and tests only. Refused unless the
 * operator enabled it explicitly; the service also refuses it on a public bind.
 */
export class DevelopmentVerifier implements Verifier {
  constructor(private readonly tokens: Record<string, { subject: string; name?: string; workspaces: Record<string, Role> }>) {}

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): DevelopmentVerifier | null {
    if (env.PSM_CONTROL_DEV_AUTH !== "1" || !env.PSM_CONTROL_DEV_TOKENS) return null;
    return new DevelopmentVerifier(JSON.parse(env.PSM_CONTROL_DEV_TOKENS));
  }

  async verify(token: string): Promise<Principal> {
    const entry = this.tokens[token];
    if (!entry) throw new AuthError("Missing or unknown bearer token.", 401);
    const workspaces = new Map<string, Membership>();
    for (const [ref, role] of Object.entries(entry.workspaces)) {
      if (!isControlWorkspace(ref)) continue;
      workspaces.set(ref, { ref, role, canWrite: role !== "viewer", canManage: role === "owner" || role === "admin" });
    }
    return { subject: `dev:${entry.subject}`, name: entry.name ?? entry.subject, workspaces };
  }
}

/** The membership needed for an action, or an error that says which is missing. */
export function requireMembership(principal: Principal, workspaceId: string, need: "read" | "write" | "manage"): Membership {
  const membership = isControlWorkspace(workspaceId) ? principal.workspaces.get(workspaceId) : undefined;
  // Not a member reads exactly like "no such workspace".
  if (!membership) throw new AuthError("Workspace not found.", 403);
  if (need === "write" && !membership.canWrite) throw new AuthError("Your role in this workspace is read-only.", 403);
  if (need === "manage" && !membership.canManage) throw new AuthError("Your role in this workspace cannot manage runners or secrets.", 403);
  return membership;
}
