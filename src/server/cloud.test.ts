import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("cloud identity uses Werewolf auth/me while cloud data uses the scoped PSM session", async () => {
  const calls: Array<{ path: string; authorization: string; body: any }> = [];
  let psmLoginStatus = 200;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = bodyText ? JSON.parse(bodyText) : null;
    calls.push({
      path: req.url || "",
      authorization: String(req.headers.authorization || ""),
      body,
    });

    const send = (status: number, data: any) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status >= 400 ? data : { success: true, data }));
    };

    if (req.url === "/auth/login") {
      return send(200, {
        user: { id: "login-response", name: "Login response", email: body.email },
        accessToken: "identity-access",
        refreshToken: "identity-refresh",
      });
    }
    if (req.url === "/auth/me") {
      if (req.headers.authorization !== "Bearer identity-access") {
        return send(401, { success: false, message: "identity token required" });
      }
      return send(200, {
        user: { _id: "canonical-id", name: "Canonical User", email: "person@example.com", role: "user" },
      });
    }
    if (req.url === "/apps/psm/auth/login") {
      assert.equal(body.email, "person@example.com");
      assert.ok(body.device?.id);
      if (psmLoginStatus !== 200) {
        return send(psmLoginStatus, { success: false, message: "Device limit reached" });
      }
      return send(200, {
        tokens: { accessToken: "cloud-access", refreshToken: "cloud-refresh", expiresIn: 900 },
        entitlement: { plan: "free" },
      });
    }
    if (req.url === "/apps/psm/me") {
      if (req.headers.authorization !== "Bearer cloud-access") {
        return send(401, { success: false, message: "cloud token required" });
      }
      return send(200, {
        user: { id: "scoped-user", name: "Scoped response", email: "person@example.com" },
        entitlement: { plan: "pro", canSync: true },
        limits: { devices: 3 },
      });
    }
    if (req.url === "/apps/psm/auth/logout" || req.url === "/auth/logout") return send(200, {});
    return send(404, { success: false, message: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "psm-cloud-auth-"));
  process.env.WEREWOLF_API_URL = `http://127.0.0.1:${address.port}`;
  process.env.PSM_CLOUD_DEVICE_FILE = path.join(temp, "device.json");
  process.env.PSM_CLOUD_DISABLE_KEYRING = "1";

  try {
    const cloud = await import(`./cloud.ts?auth-contract=${Date.now()}`);
    assert.equal(cloud.cloudAvailable(), false);

    const account = await cloud.authenticate("login", {
      email: "person@example.com",
      password: "correct-horse-battery-staple",
    });
    assert.equal(cloud.cloudAvailable(), true);
    assert.equal(account.user.id, "canonical-id", "auth/me must own account identity");
    assert.equal(account.user.name, "Canonical User");
    assert.equal(account.entitlement.plan, "pro");
    assert.equal(account.cloudReady, true);
    assert.equal(account.apiUrl, process.env.WEREWOLF_API_URL);
    assert.equal(account.apiSource, "override");
    assert.deepEqual(calls.slice(0, 4).map((call) => call.path), [
      "/auth/login",
      "/auth/me",
      "/apps/psm/auth/login",
      "/apps/psm/me",
    ]);
    assert.equal(calls[0].body.device, undefined, "canonical login must not use the PSM device contract");

    calls.length = 0;
    await cloud.account(true);
    assert.deepEqual(calls.map((call) => call.path), ["/auth/me", "/apps/psm/me"]);

    calls.length = 0;
    await cloud.logout();
    assert.deepEqual(calls.map((call) => call.path), ["/apps/psm/auth/logout", "/auth/logout"]);
    assert.equal(cloud.cloudAvailable(), false);

    calls.length = 0;
    psmLoginStatus = 403;
    const identityOnly = await cloud.authenticate("login", {
      email: "person@example.com",
      password: "correct-horse-battery-staple",
    });
    assert.equal(identityOnly.user.id, "canonical-id");
    assert.equal(identityOnly.cloudReady, false);
    assert.match(identityOnly.serviceError, /Device limit reached/);
    assert.equal(cloud.cloudAvailable(), true, "auth/me success still means signed in");
    assert.deepEqual(calls.map((call) => call.path), [
      "/auth/login",
      "/auth/me",
      "/apps/psm/auth/login",
    ]);
    await cloud.logout();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(temp, { recursive: true, force: true });
    delete process.env.WEREWOLF_API_URL;
    delete process.env.PSM_CLOUD_DEVICE_FILE;
    delete process.env.PSM_CLOUD_DISABLE_KEYRING;
  }
});
