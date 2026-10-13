import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
const source = fs.readFileSync(new URL("../web/privacy.js", import.meta.url), "utf8");
function browser(preference = "off") {
  const classes = new Set<string>(), storage = new Map([["psm.stream-privacy", preference]]);
  const node = (tagName = "DIV") => {
    const attrs = new Map<string, string>();
    const n: any = { tagName, nodeType: 1, isConnected: true, inert: false,
      value: "original-private-value", textContent: "Original private text", querySelectorAll: () => [], matches: () => false,
      setAttribute: (key: string, val: string) => attrs.set(key, val), getAttribute: (key: string) => attrs.get(key) ?? null,
      closest: (selector: string) => selector === "[data-stream-private]" && attrs.has("data-stream-private") ? n : null };
    return n;
  };
  const body = node("BODY"), button = node("BUTTON");
  const document = { readyState: "loading", title: "Private project", body,
    documentElement: { classList: { toggle: (key: string, on: boolean) => on ? classes.add(key) : classes.delete(key) } },
    getElementById: () => button, createTreeWalker: () => ({ nextNode: () => null }), addEventListener() {}, dispatchEvent() {} };
  const context = vm.createContext({ window: {}, document, NodeFilter: { SHOW_TEXT: 4 }, CustomEvent: class {},
    localStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, val: string) => storage.set(key, val) } });
  vm.runInContext(source, context);
  return { privacy: (context.window as any).PsmPrivacy, node, classes, storage, document, button };
}

test("stream privacy restores the saved setting before the body or app renders", () => {
  const b = browser("on");
  assert.equal(b.privacy.enabled, true);
  assert.equal(b.classes.has("stream-privacy"), true);
});

test("covering private fields preserves actual values and restores prior interactivity", () => {
  const b = browser(), field = b.node("INPUT");
  b.privacy.cover(field); b.privacy.setEnabled(true);
  assert.equal(field.getAttribute("data-stream-private"), "");
  assert.equal(field.inert, true);
  assert.equal(field.value, "original-private-value");
  assert.equal(field.textContent, "Original private text");
  assert.equal(b.button.getAttribute("aria-pressed"), "true");
  assert.equal(b.storage.get("psm.stream-privacy"), "on");
  b.privacy.setEnabled(false);
  assert.equal(field.inert, false);
  assert.equal(field.value, "original-private-value");
  assert.equal(b.document.title, "Private project");
  assert.equal(b.classes.has("stream-privacy"), false);
});

test("an already inert private region stays inert when privacy is disabled", () => {
  const b = browser(), field = b.node(); field.inert = true;
  b.privacy.cover(field); b.privacy.setEnabled(true); b.privacy.setEnabled(false);
  assert.equal(field.inert, true);
});

test("sensitive identifiers are detected without treating deployment health as private", () => {
  const b = browser();
  for (const text of ["demo@example.test", "192.0.2.1", "/home/user/project", "C:\\Users\\user\\project", "https://private.example.test", "API_KEY=example", "Bearer example", "github_pat_example", "-----BEGIN OPENSSH PRIVATE KEY-----"])
    assert.equal(b.privacy.sensitiveText(text), true, text);
  for (const text of ["Healthy", "Production", "CPU 12%", "Version 0.3.37", "Check readiness again"])
    assert.equal(b.privacy.sensitiveText(text), false, text);
});

test("the header toggle and early masks are present before app startup", () => {
  const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  assert.ok(html.indexOf('src="/privacy.js"') < html.indexOf("<body>"));
  assert.match(html, /id="stream-privacy"[^>]*aria-pressed="false"/);
  assert.match(html, /id="connect-token"[^>]*data-stream-private/);
  assert.match(html, /id="ws-transcript"[^>]*data-stream-private/);
});
