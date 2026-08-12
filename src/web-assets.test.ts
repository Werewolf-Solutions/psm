/**
 * Rules the browser bundle has to keep, checked by reading the files.
 *
 * `web/` has no build step and no browser test harness, so these are grep tests.
 * They are cheap, and each one stands for a failure that has actually happened
 * or that would be silent in production.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const read = (file: string) => fs.readFileSync(path.join(WEB, file), "utf8");

test("index.html references its assets absolutely", () => {
  // The SPA fallback serves index.html at /auth/callback too. A relative
  // src="./app.js" resolves to /auth/app.js there, which the fallback answers
  // with index.html — so the browser parses HTML as JavaScript and the whole app
  // silently fails to boot, on the one path sign-in depends on.
  const html = read("index.html");
  const relative = [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(relative, [], `relative asset paths break under /auth/callback: ${relative.join(", ")}`);

  for (const asset of ["/app.js", "/auth.js", "/styles.css"]) {
    assert.ok(html.includes(`"${asset}"`), `index.html should load ${asset} absolutely`);
    assert.ok(fs.existsSync(path.join(WEB, asset.slice(1))), `${asset} should exist in web/`);
  }
});

test("auth.js is loaded before app.js", () => {
  const html = read("index.html");
  assert.ok(
    html.indexOf('"/auth.js"') < html.indexOf('"/app.js"'),
    "app.js calls PsmAuth during boot, so auth.js has to have run first",
  );
});

test("the page never stores a refresh token", () => {
  // The whole reason psm's hosted page is registered as a `web` client is that
  // dapp keeps its refresh token in an httpOnly cookie. Writing one to storage
  // would throw that away.
  const auth = read("auth.js");
  const suspicious = [...auth.matchAll(/(?:local|session)Storage\.setItem\(\s*([^,]+),/g)].map((m) => m[1].trim());
  for (const key of suspicious) {
    assert.ok(
      !/refresh/i.test(key),
      `auth.js writes something refresh-shaped to storage: ${key}`,
    );
  }
  assert.ok(!/refreshToken/.test(auth.replace(/^\s*\*.*$/gm, "")), "auth.js should never touch a refreshToken outside comments");
});

test("the local dapp default is same-site with the static host", () => {
  // The refresh cookie is SameSite=Lax, and Lax is about *site*. Pointing the
  // page at 127.0.0.1 while it is served from localhost makes the two
  // cross-site, the cookie is dropped, and every reload silently signs you out.
  const auth = read("auth.js");
  assert.ok(
    !/"http:\/\/127\.0\.0\.1:3000/.test(auth),
    "use http://localhost:3000 for the local dapp so the cookie is same-site with localhost:8080",
  );
});
