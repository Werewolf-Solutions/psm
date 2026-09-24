/**
 * Secrets at rest and bearer credentials.
 *
 * Secrets are sealed with AES-256-GCM under one master key. The workspace and
 * secret name are authenticated data, so a sealed value copied into another
 * workspace's row (or renamed) no longer opens. Bearer credentials — runner
 * credentials, registration and enrollment tokens — are stored only as
 * SHA-256 hashes and compared in constant time.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class SecretSealer {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.byteLength !== 32) throw new Error("The control master key must be 32 bytes.");
    this.#key = Buffer.from(key);
  }

  /** Load the key from PSM_CONTROL_MASTER_KEY (base64) or a 0600 key file, creating it on first start. */
  static fromEnvironment(file: string, env: NodeJS.ProcessEnv = process.env): SecretSealer {
    if (env.PSM_CONTROL_MASTER_KEY) return new SecretSealer(Buffer.from(env.PSM_CONTROL_MASTER_KEY, "base64"));
    try {
      const stat = fs.statSync(file);
      if ((stat.mode & 0o077) !== 0) throw new Error(`${file} must not be readable by other users (chmod 600).`);
      return new SecretSealer(Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const key = randomBytes(32);
      fs.writeFileSync(file, `${key.toString("base64")}\n`, { mode: 0o600, flag: "wx" });
      return new SecretSealer(key);
    }
  }

  seal(workspaceId: string, name: string, value: Buffer): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(`${workspaceId}\0${name}`));
    const body = Buffer.concat([cipher.update(value), cipher.final()]);
    return `v1.${nonce.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${body.toString("base64")}`;
  }

  open(workspaceId: string, name: string, sealed: string): Buffer {
    const [version, nonce, tag, body] = sealed.split(".");
    if (version !== "v1" || !nonce || !tag || body === undefined) throw new Error("Unrecognised sealed secret.");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(nonce, "base64"));
    decipher.setAAD(Buffer.from(`${workspaceId}\0${name}`));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]);
  }

  /** A stable, non-reversible fingerprint to show which value is stored. */
  fingerprint(workspaceId: string, name: string, value: Buffer): string {
    return `hmac:${createHmac("sha256", this.#key).update(`${workspaceId}\0${name}\0`).update(value).digest("hex").slice(0, 16)}`;
  }
}

export function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokenMatches(token: string, hash: string): boolean {
  const candidate = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(hash, "hex");
  return candidate.byteLength === expected.byteLength && timingSafeEqual(candidate, expected);
}
