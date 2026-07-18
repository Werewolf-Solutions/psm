# psm — projects manager

A small tool that keeps an eye on every project in this workspace. It **scans** each
sibling folder, **classifies** it (status, stack, last activity), lets you **override** the
things a scanner can't know, and serves a **live dashboard** — plus it regenerates
`PROJECTS.md` on demand.

## Run the dashboard

```bash
npm install
npm run server          # → http://localhost:4317   (set PORT to change)
```

Open the URL. Click any card to edit its **status, priority, description, next step,
category**, or pin it to the top. Changes are saved to `overrides.json`. Hit **Export MD**
to regenerate `PROJECTS.md`, or **Rescan** to re-read the workspace.

## CLI

```bash
npm run list            # quick terminal rundown
npm run build:md        # regenerate PROJECTS.md
npm run scan            # same as list (fresh scan)
npm run typecheck
```

## How it works

```
src/scan.ts       folder → raw signals (git, package.json, README, notes/todo, stack, mtime)
src/classify.ts   signals + overrides.json → status/category  (loads & saves overrides)
src/render.ts     merged projects → PROJECTS.md
src/index.ts      the scan→merge pipeline used by everything
src/server/       Express API + serves web/
web/              the dashboard (vanilla HTML/CSS/JS, no build step)
```

- **Auto** (never hand-edited): last activity, git branch/tag, detected stack, README/pkg
  description, first open TODO line.
- **Overrides** (`overrides.json`, hand- or UI-edited): status, priority, pinned, curated
  description, next step, category, archived flag + note. Any blank override field falls
  back to the auto value.

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
