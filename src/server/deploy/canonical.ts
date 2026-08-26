import { createHash } from "node:crypto";

/** Values accepted by RFC 8785 / JSON Canonicalization Scheme. */
export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

export class CanonicalJsonError extends Error {}

/**
 * RFC 8785 canonical JSON using ECMAScript's JSON string/number serialization
 * and UTF-16 code-unit ordering for object keys. The validator rejects values
 * JSON would otherwise silently erase or coerce.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CanonicalJsonError("canonical JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    const fields = Object.keys(object).sort().map((key) => {
      const field = object[key];
      if (field === undefined || typeof field === "function" || typeof field === "symbol") {
        throw new CanonicalJsonError(`canonical JSON cannot encode field ${key}`);
      }
      return `${JSON.stringify(key)}:${canonicalJson(field)}`;
    });
    return `{${fields.join(",")}}`;
  }
  throw new CanonicalJsonError(`canonical JSON cannot encode ${typeof value}`);
}

export function canonicalDigest(domain: string, value: unknown): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,199}$/.test(domain)) {
    throw new CanonicalJsonError("canonical digest domain is invalid");
  }
  return `sha256:${createHash("sha256")
    .update(domain, "utf8")
    .update("\0")
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;
}
