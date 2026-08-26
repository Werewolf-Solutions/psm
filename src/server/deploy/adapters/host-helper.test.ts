import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  decodeHostHelperFrame,
  encodeHostHelperFrame,
  HOST_HELPER_REQUEST_SCHEMA,
  HOST_HELPER_RESPONSE_SCHEMA,
  HostHelperError,
  knownHostFingerprint,
  type HostHelperRequest,
} from "./host-helper.ts";

const request: HostHelperRequest = {
  schema: HOST_HELPER_REQUEST_SCHEMA,
  requestId: "req_1",
  targetId: "target_todo",
  operation: "observe-target",
  desired: {},
};

function response(value: Record<string, unknown>): Buffer {
  const raw = Buffer.from(JSON.stringify(value));
  const frame = Buffer.alloc(4 + raw.length);
  frame.writeUInt32BE(raw.length, 0);
  raw.copy(frame, 4);
  return frame;
}

test("host-helper framing binds the declared archive length", () => {
  const archive = Buffer.from("archive");
  const framed = Buffer.from(encodeHostHelperFrame({ ...request, archiveBytes: archive.length }, archive));
  assert.equal(framed.readUInt32BE(0), Buffer.byteLength(JSON.stringify({ ...request, archiveBytes: archive.length })));
  assert.equal(framed.subarray(-archive.length).toString(), "archive");
  assert.throws(() => encodeHostHelperFrame({ ...request, archiveBytes: 1 }, archive), HostHelperError);
});

test("host-helper response must repeat every correlation field", () => {
  const valid = {
    schema: HOST_HELPER_RESPONSE_SCHEMA,
    requestId: request.requestId,
    targetId: request.targetId,
    operation: request.operation,
    outcome: "succeeded",
    code: "ok",
    detail: "observed",
    observedAt: "2026-08-26T12:00:00Z",
    data: { state: "in-sync" },
  };
  assert.equal((decodeHostHelperFrame(response(valid), request).data as { state: string }).state, "in-sync");
  assert.throws(() => decodeHostHelperFrame(response({ ...valid, targetId: "other" }), request), HostHelperError);
  assert.throws(() => decodeHostHelperFrame(response({ ...valid, unexpected: true }), request), HostHelperError);
});

test("known-host fingerprints use the OpenSSH SHA256 representation", () => {
  const key = Buffer.from("a stable public host key fixture");
  const expected = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
  assert.equal(knownHostFingerprint(`example.com ssh-ed25519 ${key.toString("base64")}`), expected);
  assert.throws(() => knownHostFingerprint("example.com ssh-ed25519 !!!"), HostHelperError);
});
