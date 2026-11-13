/**
 * P02a.2 — the operator credential on psm's local API.
 *
 * Until now a request with no Origin (curl, any local process, an agent's
 * shell) was the operator. Now every state-changing request from the local side
 * must carry the operator token, and so must a short list of sensitive reads
 * (the pairing token). Plain reads stay open.
 *
 * How the cockpit gets the token: psm writes it into the cockpit page it serves
 * (a <meta> tag), and web/operator.js adds it as a header to the page's own
 * same-origin requests. Not a cookie on purpose: cookies ignore the port, so a
 * `localhost` cookie would also be sent to every project dev server opened on
 * localhost — repository code that could read it from its request headers.
 * Other loopback ports cannot read the page itself: agentGuard refuses them
 * without the pairing token.
 *
 * Paired origins (the hosted page) authenticate with the pairing token, which
 * agentGuard has already checked by the time this gate runs. The MCP endpoint
 * has its own per-client credentials and is not gated here.
 *
 * Limit, stated plainly: a process running as the same OS user can GET the page
 * and read the token, or read the file it is kept in. This stops careless and
 * prompt-injected `curl` calls from approving things; it is not a boundary
 * against deliberate code running as the user. That boundary is P02a.3.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import type express from "express";

export const OPERATOR_HEADER = "x-psm-operator";
export const OPERATOR_META = "psm-operator";
const TOKEN_PREFIX = "psm_op_";
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface OperatorSecret {
  token: string;
  createdAt: number;
}

const newToken = () => TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");

/** The operator secret, created on first use and kept 0600 so a restart does not log open tabs out. */
export class OperatorCredential {
  #secret: OperatorSecret | null = null;

  constructor(private readonly file: string | null, private readonly now: () => number = Date.now) {}

  current(): OperatorSecret {
    if (this.#secret) return this.#secret;
    if (this.file) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
        if (typeof saved?.token === "string" && saved.token.startsWith(TOKEN_PREFIX) && typeof saved.createdAt === "number") {
          this.#secret = { token: saved.token, createdAt: saved.createdAt };
          return this.#secret;
        }
      } catch {
        /* none yet */
      }
    }
    return this.#write({ token: newToken(), createdAt: this.now() });
  }

  /** A new token; every page holding the old one must reload. */
  rotate(): OperatorSecret {
    return this.#write({ token: newToken(), createdAt: this.now() });
  }

  matches(presented: unknown): boolean {
    if (typeof presented !== "string" || presented.length > 200) return false;
    const expected = Buffer.from(this.current().token);
    const given = Buffer.from(presented);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  #write(secret: OperatorSecret): OperatorSecret {
    if (this.file) {
      const temp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(secret) + "\n", { mode: 0o600 });
      fs.renameSync(temp, this.file);
    }
    this.#secret = secret;
    return secret;
  }
}

export interface OperatorGateOptions {
  credential: OperatorCredential;
  /** Is this request from a paired (non-own) origin? agentGuard has checked its pairing token. */
  pairedOrigin: (req: express.Request) => boolean;
  /** Paths with their own authentication, such as the MCP endpoint. */
  ownAuth?: string[];
  /** Reads that hand out authority, such as the pairing token. */
  sensitiveReads?: string[];
}

export function operatorGate(options: OperatorGateOptions): express.RequestHandler {
  const ownAuth = new Set(options.ownAuth ?? []);
  const sensitive = new Set(options.sensitiveReads ?? []);
  return (req, res, next) => {
    if (ownAuth.has(req.path)) return next();
    if (READ_METHODS.has(req.method) && !sensitive.has(req.path)) return next();
    if (options.pairedOrigin(req)) return next();
    if (options.credential.matches(req.headers[OPERATOR_HEADER])) return next();
    res.status(401).json({
      error: "This needs the operator: use the psm cockpit in your browser. If the cockpit shows this, reload the page.",
      code: "operator_required",
    });
  };
}

/** The cockpit page with the operator token in a <meta> tag that web/operator.js reads. */
export function injectOperatorToken(html: string, token: string): string {
  const tag = `<meta name="${OPERATOR_META}" content="${token}">`;
  return html.includes("<head>") ? html.replace("<head>", `<head>\n    ${tag}`) : `${tag}\n${html}`;
}
