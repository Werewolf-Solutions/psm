import assert from "node:assert/strict";
import test from "node:test";
import { probeWerewolfApi } from "./runtime.ts";

test("Werewolf discovery accepts its unauthenticated auth/me response", async () => {
  const calls: string[] = [];
  const result = await probeWerewolfApi("http://localhost:3000/api/v1/", async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({
      success: false,
      message: "Not authorized to access this route. No token provided.",
    }), { status: 401, headers: { "Content-Type": "application/json" } });
  });
  assert.deepEqual(result, { available: true });
  assert.deepEqual(calls, ["http://localhost:3000/api/v1/auth/me"]);
});

test("Werewolf discovery rejects an unrelated service on the configured port", async () => {
  const result = await probeWerewolfApi("http://localhost:3000/api/v1", async () =>
    new Response("not found", { status: 404 }));
  assert.equal(result.available, false);
  assert.match(result.error || "", /unexpected/);
});
