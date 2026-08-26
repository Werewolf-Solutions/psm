import { TextDecoder } from "node:util";

export const DEFAULT_REDACTION_MARKER = "[REDACTED]";

export interface SensitiveValueOptions {
  /** Register common textual encodings that provider tools may echo. */
  derived?: boolean;
}

function asText(value: string | Uint8Array): string {
  if (typeof value === "string") return value;
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

/** Common deterministic renderings; callers should also register provider-specific derivations. */
export function sensitiveTextVariants(value: string | Uint8Array): string[] {
  const text = asText(value);
  if (!text) return [];
  const bytes = Buffer.from(text, "utf8");
  const variants = new Set<string>([
    text,
    encodeURIComponent(text),
    bytes.toString("base64"),
    bytes.toString("base64url"),
  ]);
  return [...variants].filter(Boolean);
}

function matchAt(text: string, offset: number, secrets: readonly string[]): string | null {
  for (const secret of secrets) {
    if (text.startsWith(secret, offset)) return secret;
  }
  return null;
}

/**
 * Literal, chunk-boundary-safe stream redaction.
 *
 * The class retains only the suffix where a registered value could still begin.
 * Values are ordered longest-first so overlapping values cannot expose a longer
 * credential. Register every value before consuming output; late registration
 * cannot recall text already emitted.
 */
export class StreamingRedactor {
  readonly #replacement: string;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #values = new Set<string>();
  #ordered: string[] = [];
  #maxLength = 0;
  #pending = "";
  #ended = false;
  #started = false;
  #inputMode: "unset" | "text" | "bytes" = "unset";

  constructor(
    values: readonly (string | Uint8Array)[] = [],
    replacement = DEFAULT_REDACTION_MARKER,
  ) {
    if (!replacement) throw new Error("redaction marker must not be empty");
    this.#replacement = replacement;
    for (const value of values) this.register(value);
  }

  register(value: string | Uint8Array, options: SensitiveValueOptions = {}): void {
    if (this.#ended) throw new Error("cannot register sensitive values after the stream ends");
    if (this.#started) {
      throw new Error("register every sensitive value before consuming stream output");
    }
    const variants = options.derived ? sensitiveTextVariants(value) : [asText(value)];
    for (const variant of variants) {
      if (!variant) continue;
      this.#values.add(variant);
    }
    this.#ordered = [...this.#values].sort((left, right) =>
      right.length - left.length || left.localeCompare(right)
    );
    this.#maxLength = this.#ordered[0]?.length ?? 0;
  }

  #consume(flushAll: boolean): string {
    if (this.#pending.length === 0) return "";
    if (this.#ordered.length === 0) {
      const plain = this.#pending;
      this.#pending = "";
      return plain;
    }

    // Starts before this point have enough following input to decide whether
    // the longest registered value matches. Later starts remain buffered.
    const safeStartLimit = flushAll
      ? this.#pending.length
      : Math.max(0, this.#pending.length - this.#maxLength + 1);
    let output = "";
    let offset = 0;
    while (offset < safeStartLimit) {
      const secret = matchAt(this.#pending, offset, this.#ordered);
      if (secret) {
        output += this.#replacement;
        offset += secret.length;
      } else {
        output += this.#pending[offset];
        offset += 1;
      }
    }
    this.#pending = this.#pending.slice(offset);
    return output;
  }

  push(chunk: string | Uint8Array): string {
    if (this.#ended) throw new Error("cannot write after the redaction stream ends");
    this.#started = true;
    if (typeof chunk === "string") {
      if (this.#inputMode === "bytes") {
        throw new Error("cannot mix byte and text chunks in one redaction stream");
      }
      this.#inputMode = "text";
      this.#pending += chunk;
    } else {
      if (this.#inputMode === "text") {
        throw new Error("cannot mix text and byte chunks in one redaction stream");
      }
      this.#inputMode = "bytes";
      this.#pending += this.#decoder.decode(chunk, { stream: true });
    }
    return this.#consume(false);
  }

  end(chunk?: string | Uint8Array): string {
    if (this.#ended) throw new Error("redaction stream already ended");
    let output = "";
    if (chunk !== undefined) output += this.push(chunk);
    if (this.#inputMode === "bytes") this.#pending += this.#decoder.decode();
    this.#ended = true;
    output += this.#consume(true);
    return output;
  }

  /** Redact a complete value without changing stream state. */
  redact(text: string): string {
    let output = "";
    let offset = 0;
    while (offset < text.length) {
      const secret = matchAt(text, offset, this.#ordered);
      if (secret) {
        output += this.#replacement;
        offset += secret.length;
      } else {
        output += text[offset];
        offset += 1;
      }
    }
    return output;
  }
}

/** Defensive traversal for bounded structured adapter events. */
export function redactStructuredValue(
  value: unknown,
  redactor: Pick<StreamingRedactor, "redact">,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === "string") return redactor.redact(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) throw new Error("structured event must not contain cycles");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactStructuredValue(item, redactor, seen));
    }
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = redactStructuredValue(item, redactor, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}
