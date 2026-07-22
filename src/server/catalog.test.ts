import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildCatalog,
  CatalogValidationError,
  prepareCustomCapability,
  saveCustomCapability,
} from "./catalog.ts";

function custom(commandArgs: string[] = ["/opt/example/server.js"]) {
  return {
    id: "example-mcp",
    kind: "mcp",
    title: "Example MCP",
    summary: "A deliberately untrusted test server.",
    usage: "Use only when the user asks for the example tools.",
    requiredEnv: ["EXAMPLE_TOKEN"],
    mcp: { transport: "stdio", command: "node", args: commandArgs },
  };
}

test("custom MCP manifests store names and argv but never environment values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-catalog-"));
  const customFile = path.join(root, ".psm-catalog.json");
  const workspaceFile = path.join(root, "workspace.json");
  fs.writeFileSync(workspaceFile, JSON.stringify({ capabilities: [] }));

  const prepared = prepareCustomCapability(custom());
  assert.equal(prepared.capability.source, "custom");
  assert.equal(prepared.capability.ready, false);
  saveCustomCapability(prepared.manifest, customFile);

  const stored = fs.readFileSync(customFile, "utf8");
  assert.match(stored, /EXAMPLE_TOKEN/);
  assert.doesNotMatch(stored, /secret-value/);
  assert.equal(fs.statSync(customFile).mode & 0o777, 0o600);
  const catalog = buildCatalog([], workspaceFile, customFile);
  assert.equal(catalog[0].ref, "custom:example-mcp");
});

test("custom manifests reject credential values in env, headers, argv, and URLs", () => {
  assert.throws(
    () => prepareCustomCapability({ ...custom(), mcp: { ...custom().mcp, env: { TOKEN: "secret-value" } } }),
    CatalogValidationError,
  );
  assert.throws(
    () => prepareCustomCapability(custom(["server.js", "--token", "secret-value"])),
    CatalogValidationError,
  );
  assert.throws(
    () => prepareCustomCapability(custom(["./relative/server.js"])),
    CatalogValidationError,
  );
  assert.throws(
    () => prepareCustomCapability({
      ...custom(),
      mcp: { transport: "http", url: "https://user:secret@example.com/mcp" },
    }),
    CatalogValidationError,
  );
  assert.throws(
    () => prepareCustomCapability({
      ...custom(),
      mcp: { transport: "http", url: "https://example.com/mcp", headers: { Authorization: "secret-value" } },
    }),
    CatalogValidationError,
  );
});
