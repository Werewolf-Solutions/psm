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
npm run dev             # → http://localhost:4317   (set PORT to change)
```

To try the deployed posture on your own machine, run the other script — it uses
port 4318, so both can run at once and you can compare them side by side:

```bash
npm run prod            # → http://localhost:4318   hosted mode: login required
npm run agent           # in another terminal: the local half hosted psm pairs with
```

Both scripts hand `PORT` to the server process rather than exporting it, and refuse to be
sourced. `PORT` inherited from somewhere else is a nasty one to debug: `dotenv` does not
overwrite variables that already exist, so a project silently ignores its own `.env` and
uses the inherited value. For the same reason psm strips `PORT` and every `PSM_*` variable
from the environment it gives a project's **Run** command — otherwise every dev server
psm launches would try to bind psm's own port. If something binds an unexpected port
anyway, check `echo $PORT` in that terminal.

`npm run prod` is the same process the Dockerfile starts. It generates a local
`PSM_SESSION_SECRET` into `.psm-prod.env` on first run (gitignored — production injects
its own), keeps state in `.psm-data/`, binds loopback only, and prints which Werewolf API
sign-in will go to. Expect an empty board: hosted psm has no filesystem, which is the
point of the agent.

## Modes — local, agent, hosted

psm is one codebase in three postures, chosen with `PSM_MODE`. The reason there is
more than one: **a page served from the internet cannot read your disk**, so "hosted"
and "maps all your local projects" only coexist if something local keeps running.

| Mode | What it is | Scans | Runs commands | Auth |
| --- | --- | --- | --- | --- |
| `dev` (default) | the original local tool, `npm run server` | `workspaceRoot` automatically | yes | none (loopback) |
| `agent` | local, driven by the hosted UI, `npm run agent` | only linked folders | yes | pairing token for remote origins |
| `hosted` | the deployed front end, `npm start` | nothing — it has no disk | **no** | required, per account |

`production` and `prod` are accepted spellings of `hosted`. Copy `.env.example` for the
full environment reference.

**In hosted mode the routes that shell out do not exist.** Run, logs, AI, planner,
preview, filesystem browsing, and project creation are registered on a router that is
only mounted when the process has a machine under it, so a routing mistake cannot reach
a shell. `src/server/hosted.test.ts` boots a real hosted server and asserts each of
those routes 404s.

## Linked folders — what psm looks at

Dev mode scans `workspaceRoot` from `psm.config.json`, as it always has. Everywhere
else, psm looks at nothing until you **link** a folder, in one of two kinds:

- **A directory of projects** — every folder inside it becomes a project. (This is what
  `workspaceRoot` always was.)
- **A single project** — that one folder, on its own.

Use **🔗 Folders** in the top bar, or the empty-state prompt on a fresh install. Paths
can be typed or found with the built-in browser, which marks which folders look like
projects and which look like directories of them, and preselects the matching kind. Two
linked sources holding a same-named folder stay separate projects (the second is
qualified with its parent), because the name keys overrides and AI sessions. Dev mode's
configured root appears in the list as an unremovable link so it is obvious where
projects are coming from.

### Pairing the hosted UI with a local agent

The agent stays on `127.0.0.1` and keeps refusing non-loopback requests, with one
deliberate hole: a browser origin on the allowlist (`PSM_HOSTED_ORIGIN`) that also
presents the agent's pairing token. `Origin` alone is never enough — it is
attacker-controllable outside a browser, and this API runs shell commands. The token is
minted on first run into `.psm-agent.json` (mode 0600), shown in the local cockpit's
**Folders** panel for copy-paste, and rotatable from there. Chrome's Private Network
Access preflight is answered, without which a public→private fetch never leaves the
browser.

## Signing in

Accounts belong to werewolf-dapp (`/api/v1/apps/psm/*`). psm stores no passwords, mints
no identities, and holds none of dapp's signing keys — it asks dapp.

> **Signing in needs psm registered as a `CloudApplication` in the dapp environment you
> point at** — dapp creates it with `npm run bootstrap:psm`. Local dev has it, and the whole
> flow is verified end to end there. Production answered `app_not_configured` on 2026-08-12:
> the row is missing, and dapp's code there is current — `/apps/psm/public` returning 404 is
> the controller mapping `app_not_configured`, not a stale build. Details in
> [`docs/werewolf-psm-registration.md`](docs/werewolf-psm-registration.md).

### Which API a mode talks to

| mode | Werewolf API |
| --- | --- |
| `dev` | the local werewolf-dapp — `http://127.0.0.1:3000/api/v1` |
| `agent`, `hosted` | production — `https://werewolf.solutions/api/v1` |

`WEREWOLF_API_URL` overrides both. This used to pick whichever answered a probe first,
which meant the target changed silently depending on whether a local dapp happened to be
running — so `npm run server` could end up signing you in to production. It is now decided
by the mode and merely *probed* for reachability, and the Cloud panel says when the target
is not answering rather than falling back.

The **consent screen** is a page on dapp's web client, not its API, so it is resolved
separately. Against production they are the same origin. Against a local dapp they are
not: the API is on 3000, but 3000 serves a *built* bundle that may be months old, while
the client you are working on is Vite's dev server. So psm looks for a running Vite inside
the werewolf-dapp project and uses its port — which also survives Vite climbing to 5174 or
5175 when an old one is still holding 5173 — and falls back to `http://localhost:5173`.
`WEREWOLF_WEB_ORIGIN` overrides the lot.

### Continue with Werewolf

The same OAuth 2.0 authorization-code + PKCE handoff todo-app uses: leave for dapp's
consent screen, come back to psm with a 60-second single-use code, redeem it for a
session. Because the browser is already signed in at werewolf.solutions, there is no
password to retype — and psm never sees one.

**The PKCE verifier never reaches the page.** todo-app has no server, so it keeps the
verifier in `sessionStorage`; psm has one, so the verifier is minted and held server-side
keyed by `state`. The browser only ever carries the code, which is useless without it.

Redirect URIs are exact-matched by dapp. psm is registered `clientType: 'native'`, whose
rule is *any loopback port with the path locked to `/api/cloud/sso/callback`* — so a local
instance works on 4317, 4318, or anywhere else with no per-port registration. A public
https origin is not a loopback URI, so hosted psm hides the button and says what dapp
needs to allow; set `PSM_SSO_REGISTERED=1` once it does, and `PSM_PUBLIC_ORIGIN` if psm
cannot infer its own origin from the proxy headers.

**psm's server is the confidential client, not the browser.** todo-app can run the whole
flow in the tab because dapp hands *web* clients an httpOnly refresh cookie the page
cannot read; psm's app-session endpoints take the refresh token in the request body
instead, which a browser could only keep somewhere JavaScript can reach. So psm redeems
the authorization code server-side, and the browser gets back a cookie carrying nothing
but an opaque session id and a signature over it. dapp's rotating refresh token stays
server-side and is swapped for a fresh access token as needed; a refresh dapp rejects
ends the session rather than looping.

**There is exactly one way in.** The password sign-in/sign-up form and the Cloud panel's
separate account are gone, along with the second session they needed — its own login,
refresh and OS-keyring credential store. Cloud features (sync, backups, devices, billing)
borrow the signed-in session's access token, which is already psm-audience, so signing in
once is enough for all of it.

In **hosted** mode the screen gates the app: `/api/*` returns 401 without a session, apart
from the auth routes themselves and the static assets the login screen is made of. In
**local** modes signing in is optional — psm works signed out, and the screen is reached
from the account chip — but it is how a local cockpit gets a session without retyping a
password, which is the whole point of the redirect flow.

API clients can also present a werewolf access token as `Authorization: Bearer`; psm
validates it by calling `/apps/psm/me`, which needs no shared key material and honours a
session revoked a moment ago. `PSM_AUTH_JWKS_URL` / `PSM_AUTH_SECRET` remain for
verifying tokens minted by a provider directly, and are tried first when set.

## psm.werewolf.solutions

The hosted cockpit is **static files, not a server**. `web/` is rsynced to
`/var/www/psm.werewolf.solutions` by `.github/workflows/deploy.yml` on push to `master`, and
nginx serves it — there is no psm process on the droplet and `pm2 list` is unchanged by a
deploy. That is deliberate: the droplet has 1 GB of RAM shared by dapp prod, staging, redis
and nginx, and it cannot even run `npm ci` without being OOM-killed.

Everything the page needs from a server, it gets from somewhere that already exists:

- **Accounts** from werewolf-dapp (`/apps/psm-web/auth/*`), with the browser doing PKCE the
  way todo-app does. dapp puts the refresh token in an httpOnly cookie for `clientType: 'web'`
  clients, so the page never holds one.
- **Projects, logs, AI and everything else** from **your own machine** — the page talks to
  `http://127.0.0.1:4317` directly, over the paired agent boundary. Nothing about your code
  ever reaches a server.

Run `npm run agent` on the machine you want to see, pair it once with the token the local
cockpit shows, and link folders. See `docs/deploy/PUBLISHING-A-NEW-APP.md` for the runbook.

Open the URL. Click a card to **edit** its status, priority, description, next step,
category, run command, web port, deploy commands, AI engine/model/effort — or **pin** it. Changes are
saved to `overrides.json`. Hit **Export MD** to regenerate `PROJECTS.md`, or **Rescan** to
re-read the workspace. **＋ New** can either scaffold a project immediately or open an
idea in the workspace chat first, so psm can compare it against existing projects and
suggest reusable pieces before anything is created. **House rules** edits the layered AI
rules — a workspace baseline plus an optional per-project overlay — and the opt-in
engineering practices each project adopts. **Skills** shows which Claude Code skills the
agents have actually used.

## The dashboard

- **⚡ Running** — what is running on this machine, not just what psm started. Lists every
  process holding a listening TCP port plus anything that looks like a dev server,
  attributed to a linked project by its working directory, with the port, uptime and
  memory. A wrapper's port is rolled up from whatever is below it, so a `nodemon` row
  names the port its child holds; a project whose server has died shows its configured
  port as a dashed `:3000?` chip meaning "meant to serve this, nothing listening". Where the same project has several copies of the same command alive, all but
  the newest are flagged **left over** — that is why a fourth `npm run dev` ends up on
  5176. Stopping is two clicks and sends `SIGTERM`; **Stop stale** clears the leftovers in
  one go. psm's own process is shown but has no stop button.
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
  - **Dev mode** — point at the running app and click any element to open a note saying what
    should change. Each pick records the element's selector, opening tag, visible text, and
    page, and drops a numbered pin on it; the notes rail collects the batch. **Make changes**
    sends them all to the AI as one prompt and switches to the AI tab to watch the turn. The
    same engine/model/effort/full-access/usage controls as the AI tab sit in dev mode's own
    bar, so a round of notes can be aimed without leaving the preview. Notes survive reloads
    and reopening the project; `Esc` (or **Add note**) stops picking so the preview clicks
    through to the app again. Dev mode routes the preview through a loopback proxy that
    injects the inspector — HMR websockets, redirects, and root-relative URLs pass straight
    through, and normal preview is untouched.
- **AI** — chat with **Claude Code** (default) or **Codex**, running inside the project
  directory so it makes real edits. Model choices are fetched fresh from the installed,
  authenticated CLI whenever the picker opens, and the effort picker follows each model's
  advertised levels. Full-access toggle (run commands, not just edit), per-project
  engine/model/effort/access memory, and the shared house rules as its system prompt.
  - **Persistent sessions** — the conversation survives closing/reopening and server
    restarts; it resumes the real session, so you never re-explain where you were.
- **Session** — a read-only tab with the provider session id, model, effort, queue depth,
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
src/mode.ts          which posture this process runs in (dev / agent / hosted)
src/links.ts         linked sources — a directory of projects, or a single project
src/store.ts         where state lives and whose it is (per-account when hosted)
src/server/agent.ts  the agent boundary — pairing token, origin allowlist, PNA preflight
src/server/session.ts sign-in/sign-up against werewolf-dapp; psm is the confidential
                     client and the browser only ever holds an httpOnly cookie
src/server/auth.ts   who is this request — session cookie, werewolf bearer, or JWT
src/server/browse.ts read-only directory listing for the link picker
src/server/machine.ts what is running on this machine — listening ports joined to
                     processes, stale duplicates flagged, and stopping them
src/server/preview.ts dev-mode preview proxy — mirrors a project's dev server on its own
                     loopback port with the element inspector injected
web/                 the dashboard (vanilla HTML/CSS/JS, no build step)
web/preview-inspector.js  runs inside the previewed page: highlights, picks, and pins
                     elements, and reports them to psm over postMessage
house-rules.md       workspace-baseline AI rules, applied to every project (edit in the UI)
src/server/rules.ts  layered rules (baseline + per-project .psm/ overlay) + opt-in practices
src/server/skills.ts "skills used by the agents" — mines Claude Code transcripts
src/identity.ts      stable per-project ids, minted on demand into <project>/.psm/identity.json
<project>/.psm/      committed per-project psm config: rules.md overlay, profile.json (practices),
                     identity.json (stable id)
```

- **Auto** (never hand-edited): last activity, git branch/tag, detected stack, README/pkg
  description, first open TODO line, run command, web port.
- **Overrides** (`overrides.json`, hand- or UI-edited): status, priority, pinned, curated
  description, next step, category, run/deploy commands, port, AI engine/model/effort & full-access,
  manual Working on flag, archived flag + note. Any blank override field falls back to the auto value.
- **Identity** (`<project>/.psm/identity.json`): a stable `prj_…` id, shown on the project card and
  copyable from it. The folder name is only a human handle — it changes when you rename or move a
  project — so the id is what a cloud project or an external system should key off. Ids are minted
  lazily: on the first time you open a project's workspace, or when you click **assign id** on its
  card. Commit the file and the id follows the repo to other machines.

Project pages are addressed by that id — `#/p/prj_…/logs`, not `#/p/<name>/logs` — so a bookmark
survives a rename. Old name-addressed URLs still resolve and are rewritten to the id form.

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

## Versioning

`vX.Y.Z` in the **repo-root `package.json`**, per the rule in `house-rules.md`: X
released/stable, Y pre-release line, Z each feature or fix. Deliberately not semver, and
the field is the single source of truth — not a git tag, not a hardcoded constant.

todo-app and werewolf-dapp bake that field into the UI at build time (Vite's
`__APP_VERSION__`). psm has no build step, so `src/version.ts` reads it, `/api/projects`
serves it, and the dashboard footer renders it — same guarantee, different plumbing: the
number in the footer *is* the field, so the two cannot drift. `src/version.test.ts` pins
that. Every shipped change bumps something; docs-only changes need not.

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
  authenticated. Their live APIs supply the current model and supported-effort catalogs;
  a safe built-in fallback remains available if discovery fails. Full-access mode runs the
  AI with elevated permissions in that project — it's off by default and opt-in per
  project.
