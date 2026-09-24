/**
 * libsodium `crypto_box_seal`, which GitHub requires for Actions secrets: an
 * ephemeral X25519 key, XSalsa20-Poly1305 (tweetnacl's audited `box`), and a
 * nonce of BLAKE2b-192(ephemeralPublicKey || recipientPublicKey). The output
 * is ephemeralPublicKey || ciphertext. Only the holder of the recipient's
 * private key can open it; PSM keeps nothing.
 */
import nacl from "tweetnacl";

const IV = new BigUint64Array([
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
]);
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4], [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13], [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11], [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5], [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
const MASK = 0xffffffffffffffffn;
const rotr = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & MASK;

/** Unkeyed BLAKE2b (RFC 7693) with a chosen digest length; small inputs only. */
export function blake2b(input: Uint8Array, outlen: number): Uint8Array {
  if (!Number.isInteger(outlen) || outlen < 1 || outlen > 64) throw new RangeError("outlen must be 1..64");
  const h = new BigUint64Array(IV);
  h[0] ^= 0x01010000n ^ BigInt(outlen);
  const blocks = Math.max(1, Math.ceil(input.length / 128));
  const view = new DataView(new ArrayBuffer(128));
  for (let block = 0; block < blocks; block++) {
    const chunk = input.subarray(block * 128, block * 128 + 128);
    new Uint8Array(view.buffer).fill(0).set(chunk);
    const m = Array.from({ length: 16 }, (_, i) => view.getBigUint64(i * 8, true));
    const last = block === blocks - 1;
    const counter = BigInt(last ? input.length : (block + 1) * 128);
    const v = [...h, ...IV];
    v[12] ^= counter & MASK;
    v[13] ^= counter >> 64n;
    if (last) v[14] ^= MASK;
    const g = (a: number, b: number, c: number, d: number, x: bigint, y: bigint) => {
      v[a] = (v[a] + v[b] + x) & MASK; v[d] = rotr(v[d] ^ v[a], 32n);
      v[c] = (v[c] + v[d]) & MASK; v[b] = rotr(v[b] ^ v[c], 24n);
      v[a] = (v[a] + v[b] + y) & MASK; v[d] = rotr(v[d] ^ v[a], 16n);
      v[c] = (v[c] + v[d]) & MASK; v[b] = rotr(v[b] ^ v[c], 63n);
    };
    for (let round = 0; round < 12; round++) {
      const s = SIGMA[round % 10];
      g(0, 4, 8, 12, m[s[0]], m[s[1]]); g(1, 5, 9, 13, m[s[2]], m[s[3]]);
      g(2, 6, 10, 14, m[s[4]], m[s[5]]); g(3, 7, 11, 15, m[s[6]], m[s[7]]);
      g(0, 5, 10, 15, m[s[8]], m[s[9]]); g(1, 6, 11, 12, m[s[10]], m[s[11]]);
      g(2, 7, 8, 13, m[s[12]], m[s[13]]); g(3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
  }
  const out = new Uint8Array(64);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setBigUint64(i * 8, h[i], true);
  return out.slice(0, outlen);
}

/** Seal `message` to a 32-byte X25519 public key, as `crypto_box_seal` does. */
export function sealedBox(message: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
  if (recipientPublicKey.length !== nacl.box.publicKeyLength) throw new RangeError("recipient key must be 32 bytes");
  const ephemeral = nacl.box.keyPair();
  try {
    const nonce = blake2b(new Uint8Array([...ephemeral.publicKey, ...recipientPublicKey]), nacl.box.nonceLength);
    const boxed = nacl.box(message, nonce, recipientPublicKey, ephemeral.secretKey);
    const sealed = new Uint8Array(ephemeral.publicKey.length + boxed.length);
    sealed.set(ephemeral.publicKey);
    sealed.set(boxed, ephemeral.publicKey.length);
    return sealed;
  } finally {
    ephemeral.secretKey.fill(0);
  }
}
