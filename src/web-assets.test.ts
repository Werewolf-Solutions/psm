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
import vm from "node:vm";
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

test("the permissions UI survives mixed frontend and backend versions", () => {
  // Static browser files update immediately in development, while the TypeScript
  // service requires a restart. The legacy response has neither categories nor
  // bulk permission input, so an upgrade must still render individual grants.
  const permissions = read("agent-permissions.js");
  assert.match(permissions, /fallbackCategories/);
  assert.match(permissions, /permissionCategory/);
  assert.match(permissions, /permission: permissions\.length === 1/);
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

test("page startup cannot wait forever on Werewolf authentication", () => {
  const auth = read("auth.js");
  const app = read("app.js");
  const server = fs.readFileSync(path.join(WEB, "..", "src", "server", "index.ts"), "utf8");
  const session = fs.readFileSync(path.join(WEB, "..", "src", "server", "session.ts"), "utf8");
  const sso = fs.readFileSync(path.join(WEB, "..", "src", "server", "sso.ts"), "utf8");

  assert.match(auth, /const AUTH_REQUEST_MS = [\d_]+;/, "direct browser auth needs a deadline");
  assert.match(auth, /function timedFetch\(/, "browser auth calls should share the bounded fetch");
  assert.match(app, /\/api\/auth\/session[\s\S]{0,160}AbortSignal\.timeout\(STARTUP_REQUEST_MS\)/);
  assert.match(session, /signal: AbortSignal\.timeout\(DAPP_REQUEST_TIMEOUT_MS\)/);
  assert.match(sso, /setTimeout\(\(\) => controller\.abort\(\), REGISTRATION_TIMEOUT_MS\)/);
  assert.match(
    server,
    /app\.use\("\/api\/cloud",[\s\S]{0,240}sessionContext\(\)/,
    "only cloud routes should resolve the remote session before handling a request",
  );
  assert.ok(
    server.indexOf('app.use("/api/cloud"') > server.indexOf('app.get("/api/auth/session"'),
    "page and auth routes must be mounted before cloud session middleware",
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

  // Navigation and stored preferences share one validator. Exercise it against
  // the actual tabs so a rename cannot silently send a valid tab to the default.
  const app = read("app.js");
  const context = vm.createContext({ localStorage: { getItem: () => null } });
  vm.runInContext(app.slice(app.indexOf("const PANE_MEMORY_KEY ="), app.indexOf("function projectHash(")), context);
  for (const tab of tabs) {
    assert.equal(context.selectedPane("project", "prj_test", tab), tab, `navigation would refuse ${tab}`);
    assert.equal(context.selectedPane("work", "room", tab), ["ai", "session", "changes", "deploy"].includes(tab) ? tab : "ai");
    assert.equal(context.selectedPane("project", "__workspace__", tab), ["ai", "session"].includes(tab) ? tab : "ai");
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

test("every id app.js reaches for exists in the page", () => {
  // `$("#thing")` on a missing id returns null, and the failure surfaces later
  // and elsewhere — as "cannot set property of null" in a handler nobody ran
  // during review. There is no build step to catch it, so read the two files.
  const html = read("index.html");
  const app = read("app.js");
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const missing = [...app.matchAll(/\$\("#([a-z0-9-]+)"\)/gi)]
    .map((m) => m[1])
    .filter((id) => !ids.has(id));
  assert.deepEqual([...new Set(missing)], [], "app.js reaches for ids the page does not have");
});

test("a workroom is addressable, and never mistaken for a project", () => {
  const app = read("app.js");
  // Rooms route under #/w/, projects under #/p/. One regex reading the other's
  // URLs would open a project page onto a room id.
  assert.match(app, /#\\\/w\\\/\(\[\^\/\]\+\)/, "the router has to recognise a workroom URL");
  // Their AI endpoints differ too; the chat UI picks the base rather than
  // assuming every conversation belongs to a project.
  assert.match(app, /function aiBase\(/);
  assert.match(app, /\/api\/work-sessions\//);
});

test("a workroom's questions and URLs never pretend to be a project's", () => {
  const app = read("app.js");
  // Both the open cockpit and the Working on lane raise the same question. They
  // have to name it the same way, or the modal opens from one and is closed by
  // the other — and the answer is posted to a project named after the room.
  assert.match(app, /function conversationKey\(/);
  assert.match(app, /function sessionConversationKey\(/);
  assert.match(app, /function questionBase\(/);
  assert.ok(
    !/openQuestion\(name, /.test(app),
    "openQuestion should be given a conversation key, not whatever the caller called the target",
  );

  // switchPane used to write the open target into a #/p/ URL. For a room that
  // is a project id that does not exist, so the next reload lost the room.
  assert.match(app, /function workroomHash\(/);
  assert.match(app, /WS\.kind === "work" && WS\.id\s*\)\s*\{\s*history\.replaceState\(null, "", workroomHash/);
});

test("AI figures render sandboxed, with scripts off", () => {
  // A ```html block from the model is untrusted markup. It renders in an iframe
  // whose sandbox grants same-origin (only so the height can be measured) and
  // nothing else — allow-scripts here would hand the model the cockpit's origin.
  const js = read("app.js");
  const sandbox = js.match(/frame\.setAttribute\("sandbox", "([^"]*)"\);\n\s*frame\.addEventListener\("load"/);
  assert.ok(sandbox, "the figure iframe should set an explicit sandbox");
  assert.equal(sandbox[1], "allow-same-origin");
  assert.match(js, /default-src 'none'/, "the figure document's CSP should cut off the network");
});

test("the transcript renders the same fence the AI is told to write", () => {
  // The rule (src/server/ai.ts) and the renderer are two halves of one feature:
  // if they ever disagree on the tag, figures silently arrive as code again.
  const rules = fs.readFileSync(path.join(WEB, "..", "src", "server", "ai.ts"), "utf8");
  // the rule lives in a template literal, so its fences are backslash-escaped
  assert.match(rules, /(?:\\`){3}psm-figure/, "the protocol should ask for a psm-figure block");
  assert.match(read("app.js"), /const FIGURE_FENCE = \/```\(\?:psm-figure\|/);
});

test("assistant text never reaches the transcript as markup", () => {
  // el(tag, cls, html) assigns innerHTML. Assistant text goes through textContent
  // instead; only the fenced figure is allowed to be markup, and only in the frame.
  const js = read("app.js");
  assert.match(js, /part\.textContent = trimmed;/, "text parts of an answer stay text");
  assert.ok(
    !/el\("div", "ai-text", /.test(js),
    "ai-text must not be built through el()'s innerHTML argument",
  );
});

test("the AI stream always states the model and effort, even when empty", () => {
  // The server reads an absent model/effort as "unspecified" and falls back to
  // the project's saved values. Omitting them when the user clears them — which
  // is exactly what switching engines does — made the old model and effort come
  // straight back on the reconnect, overwriting the new selection.
  const js = read("app.js");
  const params = js.match(/const params = new URLSearchParams\(\{\s*engine: WS\.engine,([\s\S]*?)\}\);/);
  assert.ok(params, "connectAi should build the stream query in one object");
  assert.match(params[1], /model: WS\.model \|\| ""/, "model is always sent");
  assert.match(params[1], /effort: WS\.effort \|\| ""/, "effort is always sent");
});

test("a late model catalog cannot undo a newer choice", () => {
  // Discovery is a live CLI round-trip. Rendering the model/effort captured when
  // it started would silently reset whatever the user picked while it ran, so
  // the selection is read back at render time instead.
  const js = read("app.js");
  assert.match(
    js,
    /async function refreshModelCatalog\(project, engine, selection, effortSelect[,)]/,
    "refreshModelCatalog should take a selection getter, not fixed values",
  );
  assert.match(js, /const \{ model, effort \} = selection\(\);/);
  assert.ok(
    !/refreshModelCatalog\([^)]*,\s*""\s*,\s*""\s*,/.test(js),
    "no caller should still pass frozen model/effort strings",
  );
});

test("a workroom's dependency rows are text, and its owner links are real routes", () => {
  // The detail and the dependency id come from another repository's committed
  // manifest, so they are exactly the strings that must not be able to become
  // markup. el(tag, cls, html) assigns innerHTML; these go through textContent.
  const js = read("app.js");
  const render = js.match(/async function renderRoomDependencies\([\s\S]*?\n}\n/);
  assert.ok(render, "renderRoomDependencies should exist");
  const body = render[0];
  for (const field of ["edge.detail", "edge.dependencyId"]) {
    assert.ok(
      new RegExp(`textContent = ${field.replace(".", "\\.")}`).test(body),
      `${field} must be written as text, never markup`,
    );
  }
  // The owner label is a ternary, so check the assignment rather than the operand.
  assert.match(body, /link\.textContent = edge\.ownerProjectName\s*\?/, "the owner label is text");
  assert.ok(
    !/el\("(span|button)", "ws-room-dep[^"]*", [^)]/.test(body),
    "no row field may go through el()'s html argument",
  );
  // A row is only useful if it reaches the project that owns the edge.
  assert.match(body, /projectHash\(routeKey\(owner\), "deploy"\)/, "the owner link opens that project's Deploy pane");
  assert.match(body, /link\.disabled = true/, "an owner psm cannot find is shown, but not linked");
});

test("opening a workroom reads recorded dependency state, never probes", () => {
  // A view that fetches must not be able to trigger network calls to somebody
  // else's endpoints. The room asks the server for what was already recorded.
  const js = read("app.js");
  assert.match(js, /\/api\/work-sessions\/\$\{encodeURIComponent\(roomId\)\}\/deployments/);
  const server = fs.readFileSync(path.join(WEB, "..", "src", "server", "index.ts"), "utf8");
  assert.match(server, /crossProjectDependencies\(room\.projects\)/, "the room endpoint reads stored edges");
});

test("the environment chooser names the domain each environment publishes to", () => {
  // "Staging or production" is only a real choice if you can see where each one
  // goes. The domain used to appear once, as the subtitle of whichever
  // environment happened to be selected.
  const js = read("app.js");
  const chooser = js.match(/const envs = \$\("#dep-envs"\);[\s\S]*?\n  }\n(?:  \/\/[\s\S]*?\n)?  if \(declared\.length === 1\) \{[\s\S]*?\n  \}\n/);
  assert.ok(chooser, "renderManagedDeploy should build #dep-envs from the declared environments");
  assert.match(chooser[0], /item\.hostname \|\| item\.target\?\.hostname/, "each chip reads its own hostname");
  assert.match(chooser[0], /dep-env-host/, "the hostname is rendered, not just read");
  // One environment is not a choice; say so instead of showing a lone dead chip.
  assert.match(chooser[0], /Only \$\{declared\[0\]\.id\} is declared/);
  assert.ok(read("styles.css").includes(".dep-env-host"), "the hostname line needs a style");
});
