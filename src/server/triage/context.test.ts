import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PACK_MAX_BYTES,
  SECTION_LIMITS,
  assemblePack,
  buildContextPack,
  formatIntake,
  listRoadmapFiles,
  truncateBytes,
} from "./context.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "psm test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "psm test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(dir: string, ...args: string[]) {
  return execFileSync("git", ["-C", dir, ...args], { env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function write(dir: string, rel: string, text: string) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A small repo: README, CLAUDE.md, two roadmaps, a feature branch one commit ahead. */
function fixtureRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-triage-ctx-"));
  git(dir, "init", "-q", "-b", "main");
  write(dir, "README.md", "# Demo\n\nA demo project for triage.\n");
  write(dir, "CLAUDE.md", "Run npm test before committing.\n");
  write(dir, "docs/roadmaps/README.md", "# Roadmap index\n\n- P01 inbox\n");
  write(dir, "docs/roadmaps/p01-inbox.md", "# P01 inbox\n\nBuild the inbox view.\n");
  write(dir, "docs/roadmaps/notes.bin", "not markdown");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Start the demo");
  git(dir, "checkout", "-q", "-b", "feature/inbox");
  write(dir, "inbox.ts", "export const inbox = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Sketch the inbox");
  git(dir, "checkout", "-q", "main");
  return dir;
}

test("truncateBytes cuts on a character boundary and marks the cut", () => {
  assert.deepEqual(truncateBytes("short", 100), { text: "short", truncated: false });
  const cut = truncateBytes("é".repeat(100), 50);
  assert.ok(cut.truncated);
  assert.ok(Buffer.byteLength(cut.text) <= 50);
  assert.ok(!cut.text.includes("�"));
  assert.ok(cut.text.endsWith("…[truncated]"));
});

test("assemblePack keeps order, skips empty sections and respects the cap", () => {
  const pack = assemblePack([
    { title: "One", body: "first" },
    { title: "Empty", body: "   " },
    { title: "Two", body: "x".repeat(500) },
    { title: "Three", body: "never reached" },
  ], 200);
  assert.ok(pack.bytes <= 200);
  assert.ok(pack.truncated);
  assert.match(pack.text, /^## One\n\nfirst/);
  assert.doesNotMatch(pack.text, /Empty|Three/);
  assert.match(pack.digest, /^[0-9a-f]{64}$/);
});

test("formatIntake leaves out the current, withdrawn and failed items, sorted by id", () => {
  const text = formatIntake(
    [
      { intakeId: "int_c", text: "third", status: "triaged", verdict: { verdict: "fits", size: "S" } },
      { intakeId: "int_a", text: "first\nline", status: "new" },
      { intakeId: "int_self", text: "me", status: "claimed" },
      { intakeId: "int_w", text: "gone", status: "withdrawn" },
      { intakeId: "int_f", text: "broken", status: "failed" },
    ],
    "int_self",
  );
  assert.equal(text, "- int_a [new] first line\n- int_c [triaged · fits S] third");
});

test("listRoadmapFiles walks docs/roadmaps in path order and skips non-text files", () => {
  const dir = fixtureRepo();
  const files = listRoadmapFiles(dir).map((file) => path.relative(dir, file));
  assert.deepEqual(files, ["docs/roadmaps/README.md", "docs/roadmaps/p01-inbox.md"]);
});

test("the pack carries docs, history, branches, intake and recap", () => {
  const dir = fixtureRepo();
  const pack = buildContextPack({
    projectDir: dir,
    projectName: "demo",
    intakeId: "int_self",
    openIntake: [{ intakeId: "int_other", text: "Add dark mode", status: "new" }],
    recap: "- was wiring the inbox",
  });
  assert.match(pack.text, /## README\.md\n\n# Demo/);
  assert.match(pack.text, /## CLAUDE\.md\n\nRun npm test/);
  assert.match(pack.text, /### docs\/roadmaps\/p01-inbox\.md\n\n# P01 inbox/);
  assert.doesNotMatch(pack.text, /not markdown/);
  assert.match(pack.text, /[0-9a-f]{7,} Start the demo\n {4}\d+ files? changed/);
  assert.match(pack.text, /Base branch: main/);
  assert.match(pack.text, /- feature\/inbox: 1 ahead, 0 behind main/);
  assert.match(pack.text, /- main \(checked out\)/);
  assert.match(pack.text, /- int_other \[new\] Add dark mode/);
  assert.match(pack.text, /## AI session recap\n\n- was wiring the inbox/);
  assert.ok(!pack.truncated);
});

test("the pack is deterministic and its digest follows the content", () => {
  const dir = fixtureRepo();
  const input = { projectDir: dir, projectName: "demo", openIntake: [], recap: null };
  const first = buildContextPack(input);
  const second = buildContextPack(input);
  assert.equal(first.text, second.text);
  assert.equal(first.digest, second.digest);
  write(dir, "docs/roadmaps/p02-next.md", "# P02\n");
  assert.notEqual(buildContextPack(input).digest, first.digest);
});

test("oversized docs are truncated per file and the pack stays under its cap", () => {
  const dir = fixtureRepo();
  write(dir, "README.md", "r".repeat(50_000));
  for (let i = 0; i < 12; i++) write(dir, `docs/roadmaps/big-${String(i).padStart(2, "0")}.md`, `# big ${i}\n` + "b".repeat(20_000));
  const pack = buildContextPack({ projectDir: dir, projectName: "demo" });
  assert.ok(pack.bytes <= PACK_MAX_BYTES, `${pack.bytes} > ${PACK_MAX_BYTES}`);
  const readme = pack.text.match(/## README\.md\n\n(r+)/)![1];
  assert.ok(readme.length <= SECTION_LIMITS.readme);
  assert.match(pack.text, /…\[truncated\]/);

  const tight = buildContextPack({ projectDir: dir, projectName: "demo", maxBytes: 4096 });
  assert.ok(tight.bytes <= 4096);
  assert.ok(tight.truncated);
});

test("a folder that is not a git repo still gets a pack", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psm-triage-nogit-"));
  write(dir, "readme.md", "plain folder");
  const pack = buildContextPack({ projectDir: dir, projectName: "plain" });
  assert.match(pack.text, /## readme\.md\n\nplain folder/);
  assert.doesNotMatch(pack.text, /Git log|Local branches/);
});

test("symlinked docs are not followed out of the project", () => {
  const dir = fixtureRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "psm-triage-outside-"));
  fs.writeFileSync(path.join(outside, "secret.md"), "outside secret");
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(dir, "docs", "roadmaps", "leak.md"));
  const pack = buildContextPack({ projectDir: dir, projectName: "demo" });
  assert.doesNotMatch(pack.text, /outside secret/);
});
