# psm — workspace cockpit & project glue

A tool that keeps an eye on every project in this workspace, lets you work on each one
without leaving the dashboard, and acts as the glue between them. It **scans** each
sibling folder, **classifies** it (status, stack, last activity), tracks reusable
capabilities, and gives the workspace AI enough context to help decide whether a new
idea should reuse an existing project, attach a capability, or become a fresh scaffold.
From any project card you can open a **workspace** to run it, watch its logs, chat to an
AI that edits its code, preview its web page, attach workspace capabilities, and deploy
it — the multi-terminal workflow, in one place. It also regenerates `PROJECTS.md` on
demand.

## Run the dashboard

```bash
npm install
npm run server          # → http://localhost:4317   (set PORT to change)
```

Open the URL. Click a card to **edit** its status, priority, description, next step,
category, run command, web port, deploy commands, AI engine/model — or **pin** it. Changes are
saved to `overrides.json`. Hit **Export MD** to regenerate `PROJECTS.md`, or **Rescan** to
re-read the workspace. **＋ New** can either scaffold a project immediately or open an
idea in the workspace chat first, so psm can compare it against existing projects and
suggest reusable pieces before anything is created. **House rules** edits the layered AI
rules — a workspace baseline plus an optional per-project overlay — and the opt-in
engineering practices each project adopts. **Skills** shows which Claude Code skills the
agents have actually used.

## The dashboard

- **Working on** — projects with an open AI/Session pane, a running process, an active
  or queued AI turn, or a manual **Working on now** mark. **Stop working** clears the
  manual mark, cancels AI work and its queue, closes the AI session pane, and stops
  managed run/deploy processes for that project.
- **📌 Pinned** — pinned projects float to the top, out of their category.
- **Categories** — the rest, grouped and sorted by last activity, with an archived table
  at the bottom.

## The workspace (per project)

Click **▶** on a card to open its cockpit:

- **Plan** — structured implementation plans render as editable phase cards and nested
  steps beside a dedicated planning room. A read-only planner and a second-model reviewer
  iterate for up to three revision-bound rounds; reorder or edit the result, then
  **Confirm & start working** to open a fresh normal project-agent session. Confirmed
  revisions are immutable and progress becomes a live checklist.
- **Capabilities** — attach explicit workspace MCP servers, copy-pinned docs/API specs,
  repository skills, or a custom MCP command/URL. Every change has a file/command preview
  and separate confirmation. psm writes configuration but never runs or proxies the tool.
- **Run** — start/stop the project's run command (auto-detected — npm scripts, `cargo run`,
  `go run`, `dotnet run` / `./build.sh run`, or a node/python entry — and editable). Logs
  stream live, ANSI-stripped; the command you actually run is remembered.
- **Web** — embeds the project's own page in an iframe. The port is auto-detected and also
  sniffed live from the run output (so monorepos land on the right dev-server port).
- **AI** — chat with **Claude Code** (default) or **Codex**, running inside the project
  directory so it makes real edits. Full-access toggle (run commands, not just edit),
  per-project engine/model/access memory, and the shared house rules as its system prompt.
  - **Persistent sessions** — the conversation survives closing/reopening and server
    restarts; it resumes the real session, so you never re-explain where you were.
- **Session** — a read-only tab with the provider session id, model, queue depth,
  current activity, and recent AI events for the project.
- **Questions** — when an AI tool needs input, psm opens a structured answer popup.
  Choose **Later** to keep it pending, then reopen it from Working on or Session.
- **Recap** — a "where we left off" summary shown on reopen.
- **Subscription usage** — **Usage** appears only inside an opened project and reads only
  the provider selected by that project's engine/model controls. A shared engine/model cache
  is reused across projects and refreshed automatically every minute; unchanged responses do
  not rerender the percentage or modal. Changing the selected model switches to its cached
  view or loads it once. Provider-reported model-family windows are narrowed where available.
  Hard provider limits also pause sending in the AI pane.
- **Capabilities** — attach reusable workspace pieces (MCP servers, skills, docs, and
  API surfaces) to a project with a preview of the files psm will write.
- **Deploy** — per-project **Staging** and **Production** commands, with a two-click
  confirm on production and a "Guide me with AI" hand-off that walks you through it.

## CLI

```bash
npm run list            # quick terminal rundown
npm run build:md        # regenerate PROJECTS.md
npm run scan            # same as list (fresh scan)
npm run typecheck
npm test
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
src/server/catalog.ts capability catalog — workspace/custom attachable surfaces
src/server/attach.ts attachment planner/applier — writes psm-owned config sections
src/server/plans.ts  structured implementation plan storage and revision checks
web/                 the dashboard (vanilla HTML/CSS/JS, no build step)
house-rules.md       workspace-baseline AI rules, applied to every project (edit in the UI)
src/server/rules.ts  layered rules (baseline + per-project .psm/ overlay) + opt-in practices
src/server/skills.ts "skills used by the agents" — mines Claude Code transcripts
<project>/.psm/      committed per-project psm config: rules.md overlay + profile.json (practices)
```

- **Auto** (never hand-edited): last activity, git branch/tag, detected stack, README/pkg
  description, first open TODO line, run command, web port.
- **Overrides** (`overrides.json`, hand- or UI-edited): status, priority, pinned, curated
  description, next step, category, run/deploy commands, port, AI engine/model & full-access,
  manual Working on flag, archived flag + note. Any blank override field falls back to the auto value.

## PSM Cloud

The local dashboard and all existing project workflows remain free and work without an account. The Cloud button adds an optional Werewolf-hosted account:

- Free: one active device; no cloud sync or storage.
- Pro: £12/month or £120/year before applicable tax; three active devices, safe metadata sync, 5 GiB of encrypted source snapshots, daily/manual backups, and 30-day retention.
- A past-due subscription has three days of restore-only access. Sync and new uploads pause immediately.

Metadata sync includes safe project overrides, attachment references, latest structured plans, and cached recap text. It deliberately excludes commands, deploy configuration, absolute paths, logs, secrets, provider session ids, and raw transcripts. Pull first previews a revision; Apply validates attachment shapes and plan state. A confirmed plan cannot be moved backwards by cloud state.

Backups are encrypted by the local PSM server before upload. PSM always excludes .env variants, private-key formats, credential/session files, dependencies, build output, caches, logs covered by hard rules, and symlinks. Add project-specific patterns to .psmignore. Restore only targets a new or empty directory and verifies encryption and keyed chunk integrity before an atomic rename.

Daily backup is opportunistic while the PSM server is running: it checks enabled projects after startup and hourly, and backs up each project at most once per 24 hours. Use Back up now before closing PSM when a guaranteed snapshot is needed.

PSM keeps a global runtime-service registry. It probes the local Werewolf API through
`http://127.0.0.1:3000/api/v1/auth/me` every 15 seconds; the expected unauthenticated 401
response proves the API is present. New Cloud logins prefer that local API while it is
available and otherwise use `https://werewolf.solutions/api/v1`. Existing authenticated
sessions stay pinned to the origin that issued their tokens.

Set `WEREWOLF_API_URL` to force one API and disable discovery, or customize either side
with `WEREWOLF_LOCAL_API_URL` and `WEREWOLF_PRODUCTION_API_URL`, for example:

~~~bash
WEREWOLF_API_URL=http://localhost:3000/api/v1 npm run server
~~~

Linux persistent sign-in requires secret-tool and a working Secret Service; macOS uses Keychain. Other systems, or a failed keyring call, keep the rotating refresh credential in memory only.

Cloud identity uses the standard Werewolf Solutions account endpoints: login and registration go through `/auth/login` and `/auth/register`, and every status check treats a successful `/auth/me` response as the source of truth for whether PSM is signed in. Cloud sync, billing, backups, and device management continue to use a separate device-scoped PSM session, so those credentials cannot be used as a general Werewolf account token.

### Werewolf MCP attachment

The workspace Werewolf capability is attached through PSM's preview/confirm flow. Generated .mcp.json and .codex/config.toml entries reference WEREWOLF_API_KEY by name and do not contain its value. Export a secret API key scoped to the dedicated PSM Business before starting Claude or Codex:

~~~bash
export WEREWOLF_API_KEY=<PSM Business secret key>
~~~

Use the attached read-only get_psm_service_status tool to check connected Stripe, configured prices, Spaces readiness, active subscriber count, and aggregate encrypted bytes.

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
- Normal project-agent, planner, and reviewer sessions and recaps live in
  `.psm-sessions.json` (gitignored). Planner/reviewer commands are forced into Codex
  `read-only` or Claude `plan` permission mode; the full-access project setting applies
  only after confirmation hands work to the normal agent.
- Structured plans live in `.psm-plans/`; attachment ownership lives in
  `.psm-attachments-state.json`; custom manifests live in `.psm-catalog.json` (all gitignored).
- psm listens on `127.0.0.1` and rejects non-loopback Host/Origin requests. Custom manifests
  may contain environment variable names, never values; export required variables before
  starting psm.
- The AI panes shell out to the `claude` / `codex` CLIs; they must be installed and
  authenticated. Full-access mode runs the AI with elevated permissions in that project —
  it's off by default and opt-in per project.
