import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_REDACTION_MARKER,
  StreamingRedactor,
  redactStructuredValue,
  sensitiveTextVariants,
} from "./redaction.ts";

test("streaming redaction hides a value across every possible chunk boundary", () => {
  const secret = "super-secret-token";
  const source = `before ${secret} after`;
  for (let boundary = 1; boundary < source.length; boundary += 1) {
    const redactor = new StreamingRedactor([secret]);
    const output = redactor.push(source.slice(0, boundary))
      + redactor.push(source.slice(boundary))
      + redactor.end();
    assert.equal(output, `before ${DEFAULT_REDACTION_MARKER} after`, `boundary ${boundary}`);
    assert.doesNotMatch(output, /super-secret-token/);
  }
});

test("longest overlapping value wins without exposing a suffix", () => {
  const redactor = new StreamingRedactor(["token", "token-with-suffix", "with-suffix"]);
  const output = redactor.push("x token-with-") + redactor.end("suffix y token");
  assert.equal(output, "x [REDACTED] y [REDACTED]");
});

test("byte chunks use streaming UTF-8 decoding before redaction", () => {
  const secret = "clé-🔐-secret";
  const input = Buffer.from(`begin ${secret} end`, "utf8");
  const redactor = new StreamingRedactor([secret]);
  let output = "";
  for (const byte of input) output += redactor.push(Uint8Array.of(byte));
  output += redactor.end();
  assert.equal(output, "begin [REDACTED] end");
});

test("derived URL, base64, and base64url renderings can be registered together", () => {
  const secret = "client token:+/=";
  const variants = sensitiveTextVariants(secret);
  assert.ok(variants.includes(encodeURIComponent(secret)));
  const redactor = new StreamingRedactor();
  redactor.register(secret, { derived: true });
  for (const variant of variants) {
    assert.equal(redactor.redact(`value=${variant}`), "value=[REDACTED]");
  }
});

test("structured event values are defensively redacted without changing keys", () => {
  const redactor = new StreamingRedactor(["bearer-123"]);
  assert.deepEqual(redactStructuredValue({
    kind: "adapter-message",
    detail: "provider echoed bearer-123",
    nested: ["safe", { message: "bearer-123" }],
  }, redactor), {
    kind: "adapter-message",
    detail: "provider echoed [REDACTED]",
    nested: ["safe", { message: "[REDACTED]" }],
  });

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => redactStructuredValue(cyclic, redactor), /must not contain cycles/);
});

test("text and byte input modes cannot be mixed accidentally", () => {
  const redactor = new StreamingRedactor(["secret"]);
  redactor.push("text");
  assert.throws(() => redactor.push(Buffer.from("bytes")), /cannot mix/);
  assert.throws(() => redactor.register("late-secret"), /before consuming/);
});
