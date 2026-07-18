# psm — projects manager & cockpit

A tool that keeps an eye on every project in this workspace **and** lets you work on
each one without leaving the dashboard. It **scans** each sibling folder, **classifies**
it (status, stack, last activity), lets you **override** the things a scanner can't know,
and serves a **live dashboard**. From any project card you can open a **workspace** to run
it, watch its logs, chat to an AI that edits its code, preview its web page, and deploy it
— the multi-terminal workflow, in one place. It also regenerates `PROJECTS.md` on demand.

## Run the dashboard

```bash
npm install
npm run server          # → http://localhost:4317   (set PORT to change)
```

Open the URL. Click a card to **edit** its status, priority, description, next step,
category, run command, web port, deploy commands, AI engine — or **pin** it. Changes are
saved to `overrides.json`. Hit **Export MD** to regenerate `PROJECTS.md`, or **Rescan** to
re-read the workspace. **＋ New** scaffolds a project; **House rules** edits the shared AI
system prompt.

## The dashboard

- **Working on** — every project with an ongoing AI conversation, most-recent first, so
  you see what you're in the middle of at a glance. Click to jump straight into its chat.
- **📌 Pinned** — pinned projects float to the top, out of their category.
- **Categories** — the rest, grouped and sorted by last activity, with an archived table
  at the bottom.

## The workspace (per project)

Click **▶** on a card to open its cockpit:

- **Run** — start/stop the project's run command (auto-detected — npm scripts, `cargo run`,
  `go run`, `dotnet run` / `./build.sh run`, or a node/python entry — and editable). Logs
  stream live, ANSI-stripped; the command you actually run is remembered.
- **Web** — embeds the project's own page in an iframe. The port is auto-detected and also
  sniffed live from the run output (so monorepos land on the right dev-server port).
- **AI** — chat with **Claude Code** (default) or **Codex**, running inside the project
  directory so it makes real edits. Full-access toggle (run commands, not just edit),
  per-project engine/access memory, and the shared house rules as its system prompt.
  - **Persistent sessions** — the conversation survives closing/reopening and server
    restarts; it resumes the real session, so you never re-explain where you were.
  - **Recap** — a "where we left off" summary shown on reopen.
  - **Usage limits** — if a provider is rate-limited, the pane says so upfront and pauses
    sending, so you don't fire a doomed turn or disturb the session.
- **Deploy** — per-project **Staging** and **Production** commands, with a two-click
  confirm on production and a "Guide me with AI" hand-off that walks you through it.

## CLI

```bash
npm run list            # quick terminal rundown
npm run build:md        # regenerate PROJECTS.md
npm run scan            # same as list (fresh scan)
npm run typecheck
```

## How it works

```
src/scan.ts          folder → raw signals (git, package.json, README, notes/todo, stack,
                     run command, web port, mtime)
src/classify.ts      signals + overrides.json → status/category  (loads & saves overrides)
src/render.ts        merged projects → PROJECTS.md
src/index.ts         the scan→merge pipeline used by everything
src/server/index.ts  Express API + serves web/
src/server/procs.ts  process registry — runs projects & deploys, streams logs over SSE
src/server/ai.ts     the AI pane — shells out to claude/codex, persists sessions & recaps
web/                 the dashboard (vanilla HTML/CSS/JS, no build step)
house-rules.md       shared AI system prompt, applied to every project (edit in the UI)
```

- **Auto** (never hand-edited): last activity, git branch/tag, detected stack, README/pkg
  description, first open TODO line, run command, web port.
- **Overrides** (`overrides.json`, hand- or UI-edited): status, priority, pinned, curated
  description, next step, category, run/deploy commands, port, AI engine & full-access,
  archived flag + note. Any blank override field falls back to the auto value.

## Config — `psm.config.json`

| key | meaning |
|---|---|
| `workspaceRoot` | folder to scan, relative to `psm/` (default `..`) |
| `ignore` | folder names to skip |
| `activeDays` | ≤ this many days since last activity ⇒ auto **active**, else **paused** |
| `archivePatterns` | regex on folder name that auto-marks **archived** |

## Notes

- `PROJECTS.md` is **generated** — edit `overrides.json` (or the dashboard), not the markdown.
- Folders with no git use newest file mtime for "last activity" (shown as `·mtime`).
- Per-project AI sessions and recaps live in `.psm-sessions.json` (gitignored).
- The AI panes shell out to the `claude` / `codex` CLIs; they must be installed and
  authenticated. Full-access mode runs the AI with elevated permissions in that project —
  it's off by default and opt-in per project.
