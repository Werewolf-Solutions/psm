import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { APP_VERSION, DISPLAY_VERSION } from "./version.ts";

test("the served version is the repo-root package.json field", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8"),
  );
  assert.equal(APP_VERSION, pkg.version);
});

test("the version follows the X.Y.Z house rule", () => {
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/);
});

test("the footer form carries the v prefix", () => {
  assert.equal(DISPLAY_VERSION, `v${APP_VERSION}`);
});
