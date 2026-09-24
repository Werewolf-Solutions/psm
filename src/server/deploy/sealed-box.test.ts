import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import nacl from "tweetnacl";

import { blake2b, sealedBox } from "./sealed-box.ts";

test("BLAKE2b matches the reference at full and GitHub's nonce length", () => {
  // Python: hashlib.blake2b(b"", digest_size=24).hexdigest()
  assert.equal(Buffer.from(blake2b(new Uint8Array(), 24)).toString("hex"), "ab3b5331a7135ed50d0f182d026e60abdb3646fd51bcf8a3");
  for (const length of [0, 1, 64, 127, 128, 129, 256, 1000]) {
    const input = Buffer.alloc(length, length % 251);
    assert.ok(Buffer.from(blake2b(input, 64)).equals(createHash("blake2b512").update(input).digest()), `length ${length}`);
  }
});

test("a sealed box opens only with the recipient's key", () => {
  const recipient = nacl.box.keyPair();
  const other = nacl.box.keyPair();
  const message = Buffer.from("release key");
  const sealed = sealedBox(message, recipient.publicKey);
  assert.equal(sealed.length, 32 + message.length + nacl.box.overheadLength);
  const open = (secretKey: Uint8Array, publicKey: Uint8Array) => nacl.box.open(sealed.subarray(32), blake2b(new Uint8Array([...sealed.subarray(0, 32), ...publicKey]), 24), sealed.subarray(0, 32), secretKey);
  assert.equal(Buffer.from(open(recipient.secretKey, recipient.publicKey)!).toString(), "release key");
  assert.equal(open(other.secretKey, other.publicKey), null);
  assert.notDeepEqual(sealedBox(message, recipient.publicKey), sealed, "each seal uses a fresh ephemeral key");
});
