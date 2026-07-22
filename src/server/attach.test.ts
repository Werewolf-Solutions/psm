import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CopyCapability, McpCapability } from "../types.ts";
import { AttachmentManager, WiringConflictError } from "./attach.ts";

function capability(provider: string): McpCapability {
  return {
    ref: "workspace:feedback-hub",
    id: "feedback-hub",
    kind: "mcp",
    source: "workspace",
    integrity: "workspace-mutable",
    title: "Feedback Hub",
    summary: "Feedback tools",
    usage: "Use this to inspect feedback.",
    providerProject: "feedback-hub",
    manifestDigest: "sha256:test",
    ready: true,
    warnings: [],
    requiredEnv: [],
    missingEnv: [],
    mcp: {
      transport: "stdio",
      launch: { type: "npm-script", script: "mcp", workingDirectory: provider },
      env: { DB_PATH: path.join(provider, "data", "feedback-hub.db") },
    },
  };
}

function docCapability(provider: string): CopyCapability {
  return {
    ref: "workspace:control-room-spec",
    id: "control-room-spec",
    kind: "doc",
    source: "workspace",
    integrity: "workspace-mutable",
    title: "Control Room specification",
    summary: "Architecture docs",
    usage: "Consult this reference when designing event flows.",
    providerProject: "control-room",
    manifestDigest: "sha256:manifest",
    artifactDigest: "sha256:artifact",
    ready: true,
    warnings: [],
    requiredEnv: [],
    missingEnv: [],
    copy: {
      sourceRoot: provider,
      files: ["README.md", "interfaces/events.md"],
      targetRoots: [path.join(".psm", "capabilities", "control-room-spec")],
    },
  };
}

test("attach and detach restore untouched files byte for byte", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-attach-project-"));
  const state = path.join(os.tmpdir(), `psm-attach-state-${Date.now()}-${Math.random()}.json`);
  const manager = new AttachmentManager(state);
  const originalMcp = '{\n    "mcpServers": {\n        "mine": { "command": "mine" }\n    }\n}\n';
  const originalClaude = "# Existing guidance\n\nKeep this exact.\n";
  fs.writeFileSync(path.join(root, ".mcp.json"), originalMcp);
  fs.writeFileSync(path.join(root, "CLAUDE.md"), originalClaude);

  const attachPlan = manager.plan(root, [capability("/workspace/feedback-hub")]);
  const preview = manager.publicPlan(attachPlan);
  assert.equal(preview.commands[0].command, "npm");
  assert.deepEqual(preview.commands[0].args, [
    "--prefix",
    "/workspace/feedback-hub",
    "run",
    "mcp",
  ]);
  manager.apply(attachPlan);
  const wired = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
  assert.equal(wired.mcpServers.mine.command, "mine");
  assert.equal(
    wired.mcpServers["psm-feedback-hub"].env.DB_PATH,
    "/workspace/feedback-hub/data/feedback-hub.db",
  );
  assert.match(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), /Attached capabilities/);

  manager.apply(manager.plan(root, []));
  assert.equal(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"), originalMcp);
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), originalClaude);
  assert.equal(fs.existsSync(path.join(root, "AGENTS.md")), false);
  assert.equal(fs.existsSync(path.join(root, ".codex", "config.toml")), false);
});

test("outside guidance edits survive detach and owned edits conflict", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-attach-project-"));
  const state = path.join(os.tmpdir(), `psm-attach-state-${Date.now()}-${Math.random()}.json`);
  const manager = new AttachmentManager(state);
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Existing\n");
  manager.apply(manager.plan(root, [capability("/workspace/feedback-hub")]));
  const wired = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# User changed outside\n" + wired);
  manager.apply(manager.plan(root, []));
  assert.match(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), /^# User changed outside/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), /psm:attachments/);

  manager.apply(manager.plan(root, [capability("/workspace/feedback-hub")]));
  const edited = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8")
    .replace("Use this to inspect feedback.", "Malicious replacement");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), edited);
  assert.throws(() => manager.plan(root, []), WiringConflictError);
});

test("a failed metadata commit rolls wiring and ownership back", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-attach-project-"));
  const state = path.join(os.tmpdir(), `psm-attach-state-${Date.now()}-${Math.random()}.json`);
  const manager = new AttachmentManager(state);
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Original\n");
  const plan = manager.plan(root, [capability("/workspace/feedback-hub")]);
  assert.throws(
    () => manager.apply(plan, () => { throw new Error("override write failed"); }),
    /override write failed/,
  );
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "# Original\n");
  assert.equal(fs.existsSync(path.join(root, ".mcp.json")), false);
  manager.apply(manager.plan(root, [capability("/workspace/feedback-hub")]));
  assert.equal(fs.existsSync(path.join(root, ".mcp.json")), true);
});

test("copied docs are pinned, reversible, and protected from silent edits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psm-copy-project-"));
  const provider = fs.mkdtempSync(path.join(os.tmpdir(), "psm-copy-provider-"));
  fs.mkdirSync(path.join(provider, "interfaces"));
  fs.writeFileSync(path.join(provider, "README.md"), "# Specification\n");
  fs.writeFileSync(path.join(provider, "interfaces", "events.md"), "# Events\n");
  const state = path.join(os.tmpdir(), `psm-copy-state-${Date.now()}-${Math.random()}.json`);
  const manager = new AttachmentManager(state);
  const capability = docCapability(provider);

  manager.apply(manager.plan(root, [capability]));
  const copied = path.join(root, ".psm", "capabilities", "control-room-spec", "interfaces", "events.md");
  assert.equal(fs.readFileSync(copied, "utf8"), "# Events\n");
  assert.equal(fs.existsSync(path.join(root, ".mcp.json")), false);
  assert.match(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), /Pinned copy/);

  fs.writeFileSync(copied, "# User changed owned copy\n");
  assert.throws(() => manager.plan(root, []), WiringConflictError);
  fs.writeFileSync(copied, "# Events\n");
  manager.apply(manager.plan(root, []));
  assert.equal(fs.existsSync(copied), false);
  assert.equal(fs.existsSync(path.join(root, "AGENTS.md")), false);
});
