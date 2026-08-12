#!/usr/bin/env node
/**
 * Put a markdown file into todo-app's notes.
 *
 *   node scripts/publish-note.mjs <file.md> --title "…" [--email you@…] [--project <name>]
 *
 * Notes are `TodoNote` documents in werewolf-dapp's Mongo, not files: `project: null`
 * is the General pile, anything else is a per-project tab keyed by a psm directory name.
 *
 * **This writes to the database directly**, which is the pragmatic choice while
 * todo-app is not deployed and its API is only reachable with a browser session's
 * token. Once todo.werewolf.solutions is live, prefer:
 *
 *   POST /api/v1/apps/todo/notes  { title, body, project }   (scope todo:write)
 *
 * Idempotent: re-running with the same title updates that note rather than adding
 * a second one, so this can be wired into a docs pipeline later.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true);
const title = flag("title");
const email = flag("email", process.env.PSM_NOTE_EMAIL);
const project = flag("project"); // omitted → General
const dbName = flag("db", "werewolf-solutions");

if (!file || !title || !email) {
  console.error("usage: node scripts/publish-note.mjs <file.md> --title \"…\" --email you@example.com [--project <name>]");
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`no such file: ${file}`);
  process.exit(1);
}

const body = fs.readFileSync(file, "utf8");

// Hand the payload to mongosh as a generated script: JSON.stringify does the
// escaping, so a markdown body full of quotes and backticks cannot break out.
const script = `
const db = db.getSiblingDB(${JSON.stringify(dbName)});
const email = ${JSON.stringify(email)};
const user = db.users.findOne({ email }, { _id: 1 });
if (!user) { print("NO_SUCH_USER"); quit(1); }

const filter = { user: user._id, title: ${JSON.stringify(title)}, project: ${JSON.stringify(project)} };
const now = new Date();
const existing = db.todonotes.findOne(filter, { _id: 1 });

if (existing) {
  db.todonotes.updateOne({ _id: existing._id }, { $set: { body: ${JSON.stringify(body)}, updatedAt: now } });
  print("UPDATED " + existing._id);
} else {
  const doc = {
    user: user._id,
    title: ${JSON.stringify(title)},
    body: ${JSON.stringify(body)},
    project: ${JSON.stringify(project)},
    visibility: "private",
    createdAt: now,
    updatedAt: now,
    __v: 0,
  };
  print("CREATED " + db.todonotes.insertOne(doc).insertedId);
}
`;

const tmp = path.join(os.tmpdir(), `psm-note-${process.pid}.js`);
fs.writeFileSync(tmp, script);
try {
  const out = execFileSync("mongosh", ["--quiet", tmp], { encoding: "utf8" }).trim();
  if (out.includes("NO_SUCH_USER")) {
    console.error(`no user with email ${email} in the ${dbName} database`);
    process.exit(1);
  }
  console.log(`${out}  —  "${title}" in ${project ? `project ${project}` : "General"} (${body.length} chars)`);
} finally {
  fs.rmSync(tmp, { force: true });
}
