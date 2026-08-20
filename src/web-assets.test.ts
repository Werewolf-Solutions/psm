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
  // psm is a `web` client so that dapp keeps the refresh token in an httpOnly
  // cookie. The builds of dapp without that transport hand the token to the page
  // instead, so auth.js does have to *hold* one — in a module variable, for the
  // life of the tab. What it must never do is persist it: anything storage can
  // hold, injected script can read, which is the whole point of the cookie.
  const auth = read("auth.js");
  const stores = [...auth.matchAll(/(?:local|session)Storage\.setItem\(([^;]*?)\)\s*[;,)]/gs)].map((m) => m[1]);
  assert.ok(stores.length, "the storage writes should still be findable");
  for (const call of stores) {
    assert.ok(
      !/refresh/i.test(call),
      `auth.js writes something refresh-shaped to storage: ${call.trim().slice(0, 80)}`,
    );
  }
  // And the one it does hold is a plain module variable, not a property that
  // could be read off PsmAuth by anything else on the page.
  assert.match(auth, /let bodyRefreshToken = null;/);
  assert.ok(
    !/bodyRefreshToken/.test(auth.slice(auth.indexOf("window.PsmAuth"))),
    "the held refresh token must not be exposed on PsmAuth",
  );
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

test("psm signs in as exactly one application", () => {
  // Two rows meant two registrations to keep alive and a sign-in that could work
  // in one posture and not the other. `psm-web` is gone; if it comes back, it
  // comes back deliberately and not by a copied line.
  const auth = read("auth.js");
  const code = auth.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /APP_KEY = "psm"/, "the one row is `psm`");
  assert.ok(!/psm-web/.test(code), "auth.js should not reference a second application row");

  // The server agrees, or the page and the agent would sign in as different apps.
  assert.match(
    fs.readFileSync(path.join(WEB, "..", "src", "server", "session.ts"), "utf8"),
    /APP_KEY = "psm"/,
  );
});

test("an agent-served page hands its code to the agent, not straight to dapp", () => {
  // The cockpit is cross-site with dapp, so a refresh cookie set in the browser
  // there is dropped on the floor. The agent can keep it; the page cannot.
  const auth = read("auth.js");
  assert.match(auth, /if \(servedByAgent\) \{\s*const res = await postToAgent\("\/api\/auth\/exchange"/);
  assert.match(auth, /async function restore\(\)[\s\S]*?if \(servedByAgent\) return false;/);

  // And app.js must decide that before the callback is redeemed, or the first
  // sign-in of a fresh cockpit would take the wrong path.
  const app = read("app.js");
  assert.ok(
    app.indexOf("PsmAuth.configure({ servedByAgent: SERVED_BY_AGENT })") < app.indexOf("PsmAuth.completeSignIn"),
    "detectHost() has to configure PsmAuth before boot() redeems a code",
  );
});

test("every workspace tab has a pane, and every pane a tab", () => {
  // switchPane() shows `.ws-panes > [data-pane]` by name. A tab whose pane is
  // named differently is a tab that opens onto nothing at all.
  const html = read("index.html");
  const tabs = [...html.matchAll(/class="ws-tab[^"]*" data-pane="([a-z]+)"/g)].map((m) => m[1]);
  const panes = [...html.matchAll(/<div class="ws-[a-z]+"[^>]*data-pane="([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(tabs.includes("notes"), "the Notes tab should exist");
  for (const tab of tabs) assert.ok(panes.includes(tab), `the ${tab} tab has no pane`);

  // app.js gates the same names again; a rename has to happen in both places.
  const app = read("app.js");
  const allowed = app.match(/new Set\(\[("[a-z]+",?\s*)+\]\);/)?.[0] ?? "";
  for (const tab of tabs) {
    assert.ok(allowed.includes(`"${tab}"`), `switchPane would refuse the ${tab} tab`);
  }
});

test("the console renders a window rather than every line it has ever seen", () => {
  // A dev server emitting thousands of lines a minute used to become thousands
  // of DOM nodes; the window is what keeps the pane usable.
  const app = read("app.js");
  assert.match(app, /const LOG_WINDOW = 100;/, "the console renders 100 lines at a time");
  assert.ok(
    /while \(con\.querySelectorAll\("\.logline"\)\.length > view\.window\)/.test(app),
    "appendLine should retire lines that fall outside the window",
  );
  // The window is only honest if the rest is still reachable.
  assert.ok(read("index.html").includes('id="ws-download"'), "the log needs a download button");
  assert.match(app, /logs\/download\?kind=/, "download should ask the agent for the whole transcript");
});
