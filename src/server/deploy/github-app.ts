import { createPrivateKey, sign } from "node:crypto";
import type { ConnectionProfile, SecretBroker } from "./connections.ts";

export type GitHubPermissions = Record<string, "read" | "write">;
export interface GitHubTokenRequest { pathname: string; method?: string }
export interface GitHubAppIdentity { id: string; installationId: string; owner: string; slug: string }
const ID = /^[1-9][0-9]{0,19}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The GitHub pages where an App's repositories and permissions are changed; PSM cannot change either. */
export function githubAppPages(profile: ConnectionProfile): { installation: string; permissions: string; billing: string } {
  const app = profile.publicMetadata?.githubApp as Record<string, string> | undefined;
  const organization = (profile.publicMetadata?.githubAppSetup as Record<string, string> | undefined)?.accountKind === "organization";
  const owner = encodeURIComponent(String(app?.owner ?? ""));
  const settings = organization ? `https://github.com/organizations/${owner}/settings` : "https://github.com/settings";
  return {
    installation: `${settings}/installations/${encodeURIComponent(String(app?.installationId ?? ""))}`,
    permissions: `${settings}/apps/${encodeURIComponent(String(app?.slug ?? ""))}/permissions`,
    billing: organization ? `${settings}/billing` : "https://github.com/settings/billing",
  };
}

/**
 * Who can push to a repository is visible to an App only with the organization
 * "Members: read" permission; without it GitHub answers an empty list.
 */
export const COLLABORATOR_PERMISSIONS: GitHubPermissions = { metadata: "read", members: "read" };

export function githubAppIdentity(profile: ConnectionProfile): GitHubAppIdentity | null {
  const value = profile.publicMetadata?.githubApp;
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid GitHub App identity");
  const { id, installationId, owner, slug } = value;
  if (typeof id !== "string" || !ID.test(id) || typeof installationId !== "string" || !ID.test(installationId)
    || typeof owner !== "string" || !/^[A-Za-z0-9-]+$/.test(owner)
    || typeof slug !== "string" || !/^[A-Za-z0-9-]+$/.test(slug)) throw new Error("Invalid GitHub App identity");
  return { id, installationId, owner, slug };
}

export function githubAppJwt(id: string, pem: string, now = Date.now()): string {
  if (!ID.test(id)) throw new Error("Invalid GitHub App ID");
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "rsa") throw new Error("GitHub App key must be RSA");
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 540, iss: id })).toString("base64url");
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`;
}

/** Fixed provider origin; redirects and provider error bodies never carry credentials onward. */
export async function githubAppRequest(pathname: string, token: string | null, method = "GET", body?: unknown, fetcher = fetch): Promise<Record<string, any>> {
  if (!pathname.startsWith("/") || pathname.startsWith("//")) throw new Error("Invalid GitHub API path");
  const response = await fetcher(`https://api.github.com${pathname}`, {
    method, redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "psm-managed-deployments",
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    // GitHub's own one-line reason ("Upgrade to GitHub Pro or make this repository public…")
    // tells a plan limit from a missing permission. Kept apart from the message, bounded.
    const reason = await response.json().then((body) => typeof body?.message === "string" ? body.message.replace(/\s+/g, " ").slice(0, 200) : "", () => "");
    // The path names the step that failed. Tokens travel in headers; the one-time manifest code is withheld.
    const step = pathname.split("?")[0].replace(/^\/app-manifests\/[^/]+/, "/app-manifests/…");
    throw Object.assign(new Error(`GitHub ${method} ${step} failed (HTTP ${response.status})${reason ? `: ${reason}` : ""}`), { status: response.status, reason });
  }
  if (response.status === 204) return {};
  const reader = response.body?.getReader();
  if (!reader) throw new Error("GitHub response is empty");
  let size = 0; const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error("GitHub response exceeds limit"); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Invalid GitHub JSON response"); }
}

export class GitHubAppTokens {
  readonly #cache = new Map<string, { value: string; expires: number }>();
  constructor(readonly broker: SecretBroker, readonly fetcher = fetch, readonly now = Date.now) {}

  async token(profile: ConnectionProfile, repository: string, permissions: GitHubPermissions, fresh = false): Promise<string> {
    const app = githubAppIdentity(profile);
    if (!app) throw new Error("Connect a GitHub App first");
    if (!REPOSITORY.test(repository) || !profile.constraints.allowedRepositories?.includes(repository)
      || repository.split("/")[0].toLowerCase() !== app.owner.toLowerCase()) throw new Error("GitHub repository is outside this connection's scope");
    const status = await this.broker.status(profile.connectionId, ["appPrivateKey"]);
    if (!status.ready) throw new Error("GitHub App private key is unavailable");
    const generation = status.generation;
    const key = JSON.stringify([profile.connectionId, profile.metadataRevision, generation, app, repository, Object.entries(permissions).sort()]);
    const cached = this.#cache.get(key);
    if (!fresh && cached && cached.expires > this.now() + 60_000) return cached.value;
    const result = await this.broker.withLease(profile.connectionId, ["appPrivateKey"], (lease) => lease.useUtf8("appPrivateKey", (pem) =>
      githubAppRequest(`/app/installations/${app.installationId}/access_tokens`, githubAppJwt(app.id, pem, this.now()), "POST",
        { repositories: [repository.split("/")[1]], permissions }, this.fetcher)));
    const expires = Date.parse(result.expires_at);
    if (typeof result.token !== "string" || result.token.length < 8 || /\s/.test(result.token) || !Number.isFinite(expires) || expires <= this.now()) throw new Error("GitHub returned an invalid installation token");
    // Confirm provider narrowing as well as requesting it. Never accept an all-repository token.
    if (!Array.isArray(result.repositories) || result.repositories.length !== 1 || result.repositories[0]?.full_name?.toLowerCase() !== repository.toLowerCase()) throw new Error("GitHub did not restrict the token to the requested repository");
    if (!result.permissions || typeof result.permissions !== "object" || Array.isArray(result.permissions)) throw new Error("GitHub did not report token permissions");
    for (const [name, level] of Object.entries(permissions)) {
      const granted = result.permissions[name];
      if (granted !== level && !(level === "read" && granted === "write")) throw new Error("GitHub did not grant the requested token permissions");
    }
    for (const [name, level] of Object.entries(result.permissions)) {
      if (name === "metadata" && level === "read") continue;
      if (!permissions[name] || (level === "write" && permissions[name] !== "write")) throw new Error("GitHub returned broader token permissions than requested");
    }
    if (this.#cache.size >= 128) this.#cache.clear();
    if (!fresh) this.#cache.set(key, { value: result.token, expires });
    return result.token;
  }
}

const clients = new WeakMap<SecretBroker, GitHubAppTokens>();
export function githubAppTokens(broker: SecretBroker): GitHubAppTokens {
  let client = clients.get(broker);
  if (!client) { client = new GitHubAppTokens(broker); clients.set(broker, client); }
  return client;
}

export async function deploymentGitHubToken(broker: SecretBroker, profile: ConnectionProfile, request: GitHubTokenRequest): Promise<string> {
  if (!githubAppIdentity(profile)) return broker.withLease(profile.connectionId, ["apiToken"], (lease) => lease.useUtf8("apiToken", (value) => value));
  if (profile.publicMetadata?.apiBaseUrl && profile.publicMetadata.apiBaseUrl !== "https://api.github.com") throw new Error("GitHub App credentials require the GitHub API origin");
  const match = /^\/repos\/([^/]+)\/([^/]+)\/(.*)$/.exec(request.pathname);
  if (!match) throw new Error("GitHub App operation must name one repository");
  const repository = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`;
  const suffix = match[3]; const write = request.method && request.method !== "GET";
  const permissions: GitHubPermissions = suffix.startsWith("collaborators") ? COLLABORATOR_PERMISSIONS
    : suffix.startsWith("actions/") ? { actions: write ? "write" : "read" }
    : suffix.startsWith("environments/") ? (!suffix.includes("/secrets") && !suffix.includes("/variables")
      // An environment itself is read under Actions and changed under Administration;
      // the Environments permission covers only its secrets and variables.
      ? (write ? { administration: "write" } : { actions: "read" }) : { environments: write ? "write" : "read" })
    : { contents: "read" };
  return githubAppTokens(broker).token(profile, repository, permissions);
}
