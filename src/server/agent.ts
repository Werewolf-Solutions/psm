/**
 * The agent boundary.
 *
 * psm's local server has always been safe by geography: it binds 127.0.0.1 and
 * refuses any request whose Host or Origin is not loopback. It can afford to run
 * shell commands because nothing off the machine can reach it.
 *
 * Hosting the UI means deliberately punching one hole in that, which makes this
 * the most security-sensitive file in the repo. The rules:
 *
 *   - The socket stays on 127.0.0.1. Never 0.0.0.0.
 *   - Same-origin and loopback requests keep working unauthenticated, exactly as
 *     before. The local cockpit is unchanged.
 *   - A cross-origin request is allowed only when all of: the process is in agent
 *     mode, the Origin is on the allowlist, and it carries the pairing token.
 *   - `Origin` alone is never enough. It is a browser-supplied header, so any
 *     local process (or any page that guesses the port) could forge it; the token
 *     is the thing that actually authenticates, and it never leaves the machine
 *     except when the user copies it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type express from "express";

import { acceptsPairedOrigins, psmMode } from "../mode.ts";
import { APP_VERSION } from "../version.ts";
import { deviceIdentity } from "./cloud.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const AGENT_FILE = process.env.PSM_AGENT_FILE || path.join(ROOT, ".psm-agent.json");

/** Where the hosted UI is served from. Configurable so staging can be paired too. */
const DEFAULT_HOSTED_ORIGIN = "https://psm.werewolf.solutions";

export interface AgentSecret {
  token: string;
  createdAt: number;
}

function readSecret(): AgentSecret | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(AGENT_FILE, "utf8"));
    if (typeof parsed?.token === "string" && parsed.token.length >= 32) return parsed;
  } catch {
    /* fall through to minting */
  }
  return null;
}

/** Mint on first use; 0600 because this token is equivalent to shell access. */
export function agentSecret(): AgentSecret {
  const existing = readSecret();
  if (existing) return existing;
  const secret: AgentSecret = { token: crypto.randomBytes(32).toString("base64url"), createdAt: Date.now() };
  fs.writeFileSync(AGENT_FILE, JSON.stringify(secret, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(AGENT_FILE, 0o600); // an existing file keeps its old mode without this
  } catch {
    /* best effort on platforms without POSIX modes */
  }
  return secret;
}

export function rotateAgentToken(): AgentSecret {
  try {
    fs.rmSync(AGENT_FILE);
  } catch {
    /* nothing to remove */
  }
  return agentSecret();
}

/** Who this agent is, for the hosted side to name the machine. Never the token. */
export function agentIdentity() {
  const device = deviceIdentity();
  return {
    agent: true,
    agentId: device.id,
    name: device.name,
    hostname: os.hostname(),
    platform: device.platform,
    version: APP_VERSION,
    mode: psmMode(),
  };
}

export function hostedOrigins(): string[] {
  const configured = String(process.env.PSM_HOSTED_ORIGIN || DEFAULT_HOSTED_ORIGIN)
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return [...new Set(configured)];
}

export const isLoopbackHost = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";

function originAllowed(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (isLoopbackHost(url.hostname)) return true;
  return acceptsPairedOrigins() && hostedOrigins().includes(origin.replace(/\/$/, ""));
}

/** Constant-time compare so a wrong token leaks nothing through timing. */
function tokenMatches(presented: string): boolean {
  const expected = agentSecret().token;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function presentedToken(req: express.Request): string {
  const header = String(req.headers.authorization || "");
  const bearer = header.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  // EventSource cannot set headers, and the cockpit is built on SSE streams, so
  // a query token is the only way those work cross-origin
  const query = req.query?.agentToken;
  return typeof query === "string" ? query : "";
}

export interface GuardOptions {
  /** Paths a paired origin may call without the token (discovery only). */
  publicPaths?: string[];
}

/**
 * The request guard. Applied before every route in local modes; hosted mode uses
 * session auth instead and never installs this.
 */
export function agentGuard(options: GuardOptions = {}): express.RequestHandler {
  const publicPaths = new Set(options.publicPaths || []);

  return (req, res, next) => {
    let hostname: string;
    try {
      hostname = new URL(`http://${req.headers.host || "invalid"}`).hostname;
    } catch {
      return res.status(400).json({ error: "invalid Host header" });
    }
    // the socket is bound to loopback, but a proxy could still forward a foreign
    // Host; refuse rather than trust the deployment to be careful
    if (!isLoopbackHost(hostname)) {
      return res.status(403).json({ error: "psm only accepts loopback requests" });
    }

    const origin = req.headers.origin;
    if (!origin) return next(); // curl, same-origin navigation, or a non-CORS fetch

    if (!originAllowed(origin)) {
      return res.status(403).json({ error: "cross-origin requests are not allowed" });
    }

    let originHost = "";
    try {
      originHost = new URL(origin).hostname;
    } catch {
      return res.status(400).json({ error: "invalid Origin header" });
    }
    const loopbackOrigin = isLoopbackHost(originHost);

    if (!loopbackOrigin) {
      // A paired hosted origin: answer CORS, including Chrome's Private Network
      // Access preflight — without that header the fetch never leaves the browser.
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Max-Age", "600");
      if (req.headers["access-control-request-private-network"] === "true") {
        res.setHeader("Access-Control-Allow-Private-Network", "true");
      }
      if (req.method === "OPTIONS") return res.status(204).end();

      if (!publicPaths.has(req.path) && !tokenMatches(presentedToken(req))) {
        return res.status(401).json({
          error: "pair this browser with the agent first",
          code: "agent_unpaired",
        });
      }
    }

    next();
  };
}
