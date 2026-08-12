import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { setModeForTesting } from "./mode.ts";

/**
 * links.ts picks its store up from PSM_LINKS_FILE at import time, so the temp
 * dir has to exist before the module is loaded.
 */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "psm-links-"));
process.env.PSM_LINKS_FILE = path.join(sandbox, "links.json");

const { LinkError, addLink, activeLinks, describeLinks, listLinks, removeLink, resolveLinkTarget } =
  await import("./links.ts");
const { scanSources } = await import("./scan.ts");

const CONFIG = {
  workspaceRoot: path.join(sandbox, "workspace"),
  ignore: ["node_modules", "docs"],
  activeDays: 45,
  archivePatterns: [],
};

function makeProject(dir: string, name: string) {
  const target = path.join(dir, name);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name, description: name }));
  return target;
}

test.beforeEach(() => {
  fs.writeFileSync(process.env.PSM_LINKS_FILE!, JSON.stringify({ links: [] }));
  setModeForTesting("agent"); // links-only unless a test says otherwise
});

test.after(() => {
  setModeForTesting(undefined);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("a relative or missing path is refused with a reason", () => {
  assert.throws(() => resolveLinkTarget("projects/thing"), LinkError);
  assert.throws(() => resolveLinkTarget(""), LinkError);
  assert.throws(() => resolveLinkTarget(path.join(sandbox, "nope")), /No such folder/);
});

test("a file is not a folder", () => {
  const file = path.join(sandbox, "a-file.txt");
  fs.writeFileSync(file, "x");
  assert.throws(() => resolveLinkTarget(file), /Not a folder/);
});

test("linking a directory of projects yields one project per child", () => {
  const root = path.join(sandbox, "many");
  makeProject(root, "alpha");
  makeProject(root, "beta");
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(root, ".hidden"), { recursive: true });

  addLink("workspace", root);
  const names = scanSources(CONFIG as any).map((s) => s.name).sort();
  assert.deepEqual(names, ["alpha", "beta"], "ignored and dotted folders stay out");
});

test("linking a single project yields exactly that project", () => {
  const solo = makeProject(sandbox, "just-me");
  makeProject(solo, "nested-should-not-appear");

  addLink("project", solo);
  const names = scanSources(CONFIG as any).map((s) => s.name);
  assert.deepEqual(names, ["just-me"]);
});

test("the same folder cannot be linked twice, in either kind", () => {
  const root = path.join(sandbox, "dupe");
  makeProject(root, "one");
  addLink("workspace", root);
  assert.throws(() => addLink("workspace", root), /already linked/);
  assert.throws(() => addLink("project", root), /already linked as/);
});

test("a project already covered by a linked workspace is refused", () => {
  const root = path.join(sandbox, "covered");
  const child = makeProject(root, "inside");
  addLink("workspace", root);
  assert.throws(() => addLink("project", child), /already comes from/);
});

test("same-named projects from different sources stay separate", () => {
  const left = path.join(sandbox, "left");
  const right = path.join(sandbox, "right");
  makeProject(left, "api");
  makeProject(right, "api");

  addLink("workspace", left);
  addLink("workspace", right);
  const names = scanSources(CONFIG as any).map((s) => s.name).sort();
  assert.equal(names.length, 2, "two projects, not one");
  assert.ok(names.includes("api"));
  assert.ok(names.includes("right/api"), `expected a qualified name, got ${names.join(", ")}`);
});

test("unlinking drops its projects", () => {
  const root = path.join(sandbox, "temporary");
  makeProject(root, "ghost");
  const link = addLink("workspace", root);
  assert.equal(scanSources(CONFIG as any).length, 1);

  assert.equal(removeLink(link.id), true);
  assert.equal(removeLink(link.id), false, "removing twice is not an error, just false");
  assert.deepEqual(listLinks(), []);
  assert.equal(scanSources(CONFIG as any).length, 0);
});

test("agent mode scans nothing until something is linked", () => {
  makeProject(CONFIG.workspaceRoot, "in-the-config-root");
  for (const mode of ["agent"] as const) {
    setModeForTesting(mode);
    assert.deepEqual(activeLinks(CONFIG as any), [], mode);
    assert.deepEqual(scanSources(CONFIG as any), [], mode);
  }
});

test("dev mode keeps the configured workspace root as an unremovable link", () => {
  setModeForTesting("dev");
  makeProject(CONFIG.workspaceRoot, "from-config");

  const links = describeLinks(CONFIG as any);
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, "workspace");
  assert.equal(links[0].implicit, true, "it comes from psm.config.json, not the link store");
  assert.equal(removeLink(links[0].id), false, "an implicit link is not in the store to remove");
  assert.ok(scanSources(CONFIG as any).some((s) => s.name === "from-config"));
});

test("a linked folder that has been deleted is reported, not thrown", () => {
  const root = path.join(sandbox, "will-vanish");
  makeProject(root, "child");
  addLink("workspace", root);
  fs.rmSync(root, { recursive: true, force: true });

  const [link] = describeLinks(CONFIG as any);
  assert.equal(link.exists, false);
  assert.deepEqual(scanSources(CONFIG as any), [], "a missing source scans as empty");
});
