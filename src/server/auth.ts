/**
 * Hosted session auth.
 *
 * On loopback, "if you can reach it, it's yours" is true — that is the whole
 * security model of the local tool. On the internet it is false, so hosted mode
 * refuses to serve anything without an identified user, and every hosted read
 * and write is scoped to that user's id (see server/store.ts).
 *
 * The identity provider is werewolf-dapp. psm does not mint sessions; it only
 * verifies them, which keeps the signing keys in one place. Three strategies,
 * tried in order:
 *
 *   1. psm's own session cookie, set by "Continue with Werewolf" (server/sso.ts)
 *   2. a werewolf access token as a bearer, validated by asking dapp
 *   3. a provider-signed JWT verified locally (PSM_AUTH_JWKS_URL / PSM_AUTH_SECRET)
 *
 * If none is available, hosted mode fails closed: it serves 503 rather than
 * running unauthenticated, because a psm that is reachable and unauthenticated
 * is worse than one that is down.
 */
import crypto from "node:crypto";
import type express from "express";

import { requiresAuth } from "../mode.ts";
import { sessionFromRequest, userForAccessToken } from "./session.ts";

export interface SessionUser {
  id: string;
  email?: string;
  name?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

const COOKIE_NAME = () => process.env.PSM_AUTH_COOKIE || "werewolf_session";

export class AuthConfigError extends Error {}

function base64urlToBuffer(part: string): Buffer {
  return Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function decodeSegment(part: string): any {
  return JSON.parse(base64urlToBuffer(part).toString("utf8"));
}

interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 10 * 60 * 1000;

async function jwks(): Promise<Jwk[]> {
  const url = process.env.PSM_AUTH_JWKS_URL;
  if (!url) return [];
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`JWKS fetch failed: ${response.status}`);
  const body = (await response.json()) as { keys?: Jwk[] };
  jwksCache = { keys: body.keys || [], fetchedAt: Date.now() };
  return jwksCache.keys;
}

/** Rebuild a verifying key from a JWK without pulling in a JOSE dependency. */
function keyFromJwk(jwk: Jwk): crypto.KeyObject {
  return crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: "jwk" });
}

const NODE_ALG: Record<string, string> = {
  RS256: "RSA-SHA256",
  RS384: "RSA-SHA384",
  RS512: "RSA-SHA512",
  ES256: "SHA256",
  ES384: "SHA384",
};

async function verifyToken(token: string): Promise<SessionUser> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [headerPart, payloadPart, signaturePart] = parts;

  const header = decodeSegment(headerPart);
  const payload = decodeSegment(payloadPart);
  const signed = `${headerPart}.${payloadPart}`;
  const signature = base64urlToBuffer(signaturePart);

  const secret = process.env.PSM_AUTH_SECRET;
  if (header.alg === "HS256") {
    if (!secret) throw new Error("HS256 token but PSM_AUTH_SECRET is not set");
    const expected = crypto.createHmac("sha256", secret).update(signed).digest();
    if (expected.length !== signature.length || !crypto.timingSafeEqual(expected, signature))
      throw new Error("bad signature");
  } else {
    const algorithm = NODE_ALG[header.alg];
    if (!algorithm) throw new Error(`unsupported alg ${header.alg}`);
    const keys = await jwks();
    const candidates = header.kid ? keys.filter((k) => k.kid === header.kid) : keys;
    if (!candidates.length) throw new Error("no verification key for this token");
    const ok = candidates.some((jwk) => {
      try {
        return crypto.verify(
          algorithm,
          Buffer.from(signed),
          header.alg.startsWith("ES")
            ? { key: keyFromJwk(jwk), dsaEncoding: "ieee-p1363" }
            : keyFromJwk(jwk),
          signature,
        );
      } catch {
        return false;
      }
    });
    if (!ok) throw new Error("bad signature");
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < now) throw new Error("session expired");
  if (typeof payload.nbf === "number" && payload.nbf > now) throw new Error("session not yet valid");

  const issuer = process.env.PSM_AUTH_ISSUER;
  if (issuer && payload.iss !== issuer) throw new Error("wrong issuer");
  const audience = process.env.PSM_AUTH_AUDIENCE;
  if (audience && ![].concat(payload.aud ?? []).includes(audience as never))
    throw new Error("wrong audience");

  const id = String(payload.sub || payload.userId || "");
  if (!id) throw new Error("token carries no subject");
  return { id, email: payload.email, name: payload.name };
}

function tokenFromRequest(req: express.Request): string {
  const header = String(req.headers.authorization || "");
  const bearer = header.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  const cookies = String(req.headers.cookie || "");
  for (const part of cookies.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME()) return decodeURIComponent(rest.join("="));
  }
  return "";
}

/**
 * Hosted psm is signed in to through werewolf-dapp (src/server/session.ts), so
 * it is configured for auth by default. The JWKS and shared-secret strategies
 * remain for verifying tokens minted by an identity provider directly, which is
 * what a future federated setup would use.
 */
export function authConfigured(): boolean {
  return !!(process.env.PSM_AUTH_JWKS_URL || process.env.PSM_AUTH_SECRET || werewolfAuthEnabled());
}

/** Signing in via dapp is the default; set PSM_WEREWOLF_AUTH=0 to require JWTs. */
export function werewolfAuthEnabled(): boolean {
  return process.env.PSM_WEREWOLF_AUTH !== "0";
}

/** Routes that must stay reachable without a session, or nobody can get one. */
const PUBLIC_PATHS = new Set([
  "/api/auth/logout",
  "/api/auth/session",
  // the redirect flow: leaving for the consent screen and coming back are both
  // things you do precisely because you are not signed in yet
  "/api/cloud/sso/start",
  "/api/cloud/sso/callback",
]);

/**
 * Identify the caller, by any strategy this deployment accepts:
 *
 *   1. psm's own session cookie, set when the user signed in through dapp.
 *   2. a werewolf access token presented as a bearer, validated against dapp.
 *   3. a provider-signed JWT verified locally (JWKS or shared secret).
 *
 * Returns null when the request carries no identity at all.
 */
export async function identify(req: express.Request): Promise<SessionUser | null> {
  const cookieUser = await sessionFromRequest(req);
  if (cookieUser) return cookieUser;

  const token = tokenFromRequest(req);
  if (!token) return null;

  // Local verification first: it is a signature check rather than a round trip,
  // so when this deployment holds the key material it should never pay for a
  // network call. A dapp access token is a JWT too, but psm has no business
  // holding dapp's signing secret, so those fall through to introspection —
  // which is also the only way to notice a session revoked a minute ago.
  if (process.env.PSM_AUTH_JWKS_URL || process.env.PSM_AUTH_SECRET) {
    try {
      return await verifyToken(token);
    } catch (err) {
      if (!werewolfAuthEnabled()) throw err;
    }
  }
  if (werewolfAuthEnabled()) return await userForAccessToken(token);
  return null;
}

/**
 * Hosted-mode middleware. Never installed in dev or agent mode — the local
 * cockpit has no accounts and must not grow a login screen.
 */
export function hostedAuth(): express.RequestHandler {
  return (req, res, next) => {
    if (!requiresAuth()) return next();

    // Fail closed: an unauthenticated public psm is worse than an unavailable one.
    if (!authConfigured()) {
      return res.status(503).json({
        error: "hosted psm is not configured for auth — set PSM_WEREWOLF_AUTH, PSM_AUTH_JWKS_URL or PSM_AUTH_SECRET",
        code: "auth_unconfigured",
      });
    }
    if (req.method === "OPTIONS") return next();
    // Signing in cannot itself require being signed in. Static assets are public
    // too — the login screen is served from them.
    if (PUBLIC_PATHS.has(req.path) || !req.path.startsWith("/api/")) return next();

    identify(req)
      .then((user) => {
        if (!user) {
          return res.status(401).json({ error: "sign in to use psm", code: "unauthenticated" });
        }
        req.user = user;
        next();
      })
      .catch((err: Error) =>
        res.status(401).json({ error: err.message || "invalid session", code: "unauthenticated" }),
      );
  };
}

/** The owner of the current request's state. One machine, one owner, locally. */
export function currentUserId(req: express.Request): string {
  return req.user?.id || "local";
}
