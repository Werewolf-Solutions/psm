import assert from "node:assert/strict";
import test from "node:test";

import { CanonicalJsonError, canonicalDigest, canonicalJson } from "./canonical.ts";

test("canonical JSON sorts object keys recursively and leaves arrays ordered", () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: true, x: [3, "two", null] } }),
    '{"a":{"x":[3,"two",null],"y":true},"z":1}',
  );
});

test("canonical JSON rejects values ordinary JSON would erase", () => {
  assert.throws(() => canonicalJson({ missing: undefined }), CanonicalJsonError);
  assert.throws(() => canonicalJson(Number.NaN), CanonicalJsonError);
  assert.throws(() => canonicalJson(new Date()), CanonicalJsonError);
});

test("canonical digests are domain-separated", () => {
  const value = { a: 1 };
  assert.notEqual(canonicalDigest("plan@1", value), canonicalDigest("action@1", value));
  assert.equal(canonicalDigest("plan@1", value), canonicalDigest("plan@1", { a: 1 }));
});
