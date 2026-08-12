/**
 * "Sign in with Werewolf" — OAuth 2.0 authorization code + PKCE, the flow
 * todo-app uses, designed for psm in docs/werewolf-sso-plan.md.
 *
 * Being signed in at werewolf.solutions should sign you in to psm without
 * retyping a password. The browser is already authenticated there, so it visits
 * dapp's consent screen, dapp mints a 60-second single-use code bound to a PKCE
 * challenge and a redirect URI, and psm redeems it for a session.
 *
 * **The PKCE verifier never reaches the page.** todo-app has no server, so it
 * keeps the verifier in sessionStorage; psm has one, so the verifier is created
 * and kept here, keyed by the `state` parameter. Nothing sensitive crosses to
 * the browser at any point — it only ever carries the code, which is useless
 * without the verifier.
 *
 * Redirect URIs are exact-matched by dapp (`CloudApplication.isRedirectAllowed`):
 *
 *   local   psm is registered `clientType: 'native'`, so any loopback port is
 *           accepted with the path locked to /api/cloud/sso/callback. Works out
 *           of the box on 4317, 4318, or wherever you run it.
 *   hosted  a public https origin is *not* a loopback URI, so it must be on
 *           psm's registered allowlist in dapp before this can work — see
 *           `ssoAvailability()`, which says so rather than failing obscurely.
 */
import crypto from "node:crypto";
import type express from "express";

import { getProjects } from "../index.ts";
import { requiresAuth } from "../mode.ts";
import { machineProcesses } from "./machine.ts";
import { currentWerewolfRuntime, werewolfApiUrl } from "./runtime.ts";
import { AuthError, dappPost, openSession } from "./session.ts";

/** Fixed by dapp for native clients; not ours to choose. */
export const SSO_CALLBACK_PATH = "/api/cloud/sso/callback";

const STATE_TTL_MS = 10 * 60 * 1000;

interface Pending {
  verifier: string;
  redirectUri: string;
  returnTo: string;
  createdAt: number;
}

// In memory on purpose: an in-flight login is short-lived, and a restart losing
// one costs a click. Persisting a verifier would be storing a credential.
const pending = new Map<string, Pending>();

function sweep() {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [state, entry] of pending) if (entry.createdAt < cutoff) pending.delete(state);
}

/** Vite's default, and what todo-app's own config uses for a local dapp. */
const VITE_DEFAULT_ORIGIN = "http://localhost:5173";

/**
 * Find the dapp client's dev server, because Vite climbs to 5174, 5175… when a
 * previous one is still holding the port. Guessing 5173 in that state sends the
 * user to a stale client; asking the machine gets the live one.
 */
function runningDappClientOrigin(): string | null {
  try {
    const dappName = currentWerewolfRuntime().project; // "werewolf-dapp"
    const project = getProjects().find((candidate) => candidate.name === dappName);
    if (!project) return null;
    const vite = machineProcesses().find(
      (proc) =>
        proc.ports.length &&
        /\bvite\b/.test(proc.label) &&
        proc.cwd &&
        (proc.cwd === project.path || proc.cwd.startsWith(project.path + "/")),
    );
    return vite ? `http://localhost:${vite.ports[0]}` : null;
  } catch {
    return null; // best effort — never let discovery break signing in
  }
}

/**
 * Where dapp's *consent screen* lives — its web client, not its API. Signing in
 * is a full-page redirect there, so this has to be a browsable origin.
 */
export function werewolfWebOrigin(apiUrl: string): string {
  const configured = process.env.WEREWOLF_WEB_ORIGIN;
  if (configured) return configured.replace(/\/$/, "");
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return "https://werewolf.solutions";
  }
  // https://werewolf.solutions/api/v1 → https://werewolf.solutions, which serves
  // the consent screen alongside the API.
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) return url.origin;

  // A local dapp is a different shape: its API is on 3000 but the client you are
  // actually working on is Vite's dev server, and 3000 serves a *built* bundle
  // that may be months old. Prefer the running dev client.
  return runningDappClientOrigin() || VITE_DEFAULT_ORIGIN;
}

/**
 * The callback psm will ask dapp to redirect to. Loopback locally, because that
 * is what psm's native registration allows; the deployment's public origin when
 * hosted, which dapp has to be told about separately.
 */
export function ssoRedirectUri(req: express.Request): string {
  const configured = process.env.PSM_PUBLIC_ORIGIN;
  if (configured) return `${configured.replace(/\/$/, "")}${SSO_CALLBACK_PATH}`;
  if (requiresAuth()) {
    // Hosted with nothing configured: guess from the request, and let the
    // availability check below explain why dapp may refuse it.
    const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0];
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "");
    return `${proto}://${host}${SSO_CALLBACK_PATH}`;
  }
  // dapp's native rule: http, loopback host, this exact path, any port.
  const port = Number(process.env.PORT || 4317);
  return `http://127.0.0.1:${port}${SSO_CALLBACK_PATH}`;
}

/**
 * Can this instance use the redirect flow at all? Hosted psm needs its public
 * callback on psm's allowlist in dapp, which is a record in dapp's database, not
 * something psm can arrange for itself. Saying so up front beats a consent
 * screen that mysteriously refuses.
 */
export function ssoAvailability(req: express.Request): { available: boolean; reason?: string } {
  const redirectUri = ssoRedirectUri(req);
  if (redirectUri.startsWith("http://127.0.0.1") || redirectUri.startsWith("http://localhost")) {
    return { available: true };
  }
  if (process.env.PSM_SSO_REGISTERED === "1") return { available: true };
  return {
    available: false,
    reason:
      `Werewolf must allowlist ${redirectUri} for the psm application before ` +
      "sign-in works from this origin — see docs/werewolf-psm-registration.md.",
  };
}

/**
 * Start a sign-in: mint the PKCE pair, remember the verifier here, and return
 * the consent-screen URL for the browser to navigate to.
 */
export async function ssoAuthorizeUrl(req: express.Request, returnTo = "/"): Promise<string> {
  sweep();
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("base64url");
  const redirectUri = ssoRedirectUri(req);

  pending.set(state, { verifier, redirectUri, returnTo, createdAt: Date.now() });

  const params = new URLSearchParams({
    client_id: "psm",
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  // The consent screen is a page on dapp's web client, not an API endpoint.
  return `${werewolfWebOrigin(await werewolfApiUrl())}/authorize?${params}`;
}

/**
 * Redeem the code dapp sent back. Throws AuthError with something worth showing
 * — a failed sign-in is the moment a user most needs a real sentence.
 */
export async function completeSso(
  req: express.Request,
): Promise<{ cookie: string; returnTo: string; user: { id: string; name?: string; email?: string } }> {
  sweep();
  const error = typeof req.query.error === "string" ? req.query.error : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";

  if (error) {
    throw new AuthError(error === "access_denied" ? "Sign-in was declined." : error, 400);
  }
  if (!code || !state) throw new AuthError("This sign-in is missing its code.", 400);

  const entry = pending.get(state);
  // Single-use: consume it before anything can go wrong, so a replayed callback
  // cannot reuse the verifier even if the exchange below fails.
  pending.delete(state);
  if (!entry) throw new AuthError("This sign-in did not start here, or it expired. Try again.", 400);

  const apiUrl = await werewolfApiUrl();
  const data = await dappPost(
    "/apps/psm/auth/exchange",
    {
      code,
      codeVerifier: entry.verifier,
      redirectUri: entry.redirectUri,
      device: {
        id: crypto.createHash("sha256").update(entry.redirectUri).digest("hex").slice(0, 32),
        name: "psm",
        platform: String(req.headers["user-agent"] || "web").slice(0, 80),
      },
    },
    apiUrl,
  );

  const { cookie, user } = openSession(data, apiUrl);
  return { cookie, returnTo: entry.returnTo, user };
}

/** Test seam: the pending map is process-local and otherwise unreachable. */
export function pendingCount(): number {
  return pending.size;
}
