# psm — workspace cockpit & project glue

**Implementation roadmap:** start with the [ordered delivery index](docs/roadmaps/README.md).
It links all plans, resolves their execution order and tracks the next phase.

A tool that keeps an eye on every project in this workspace, lets you work on each one
without leaving the dashboard, and acts as the glue between them. It **scans** each
sibling folder, **classifies** it (status, stack, last activity), tracks reusable
capabilities, and gives the workspace AI enough context to help decide whether a new
idea should reuse an existing project, attach a capability, or become a fresh scaffold.
From any project card you can open a **workspace** to run it, watch its logs, chat to an
AI that edits its code, preview its web page, attach workspace capabilities, and deploy
it — the multi-terminal workflow, in one place. It also regenerates `PROJECTS.md` on
demand.

The [ecosystem integration assessment](docs/roadmaps/ecosystem-integration.md)
maps PSM, Todo and Werewolf's current boundaries and the path to repeatable app
rollouts. The first deployment target is Todo staging at `todo.werewolf.solutions`;
see [current readiness](docs/deploy/TODO-STAGING.md).
Todo staging completed its first successful managed release on **2026-09-29**:
PSM recorded run `run_a7ef155bd9f04884` as succeeded, with all four release probes
passing for version **0.6.0**. This proves the local-agent/GitHub/host release path;
the full hosted acceptance and live rollback rehearsal remain open.
For another project, start with [managed deployment setup](docs/deploy/PROJECT-SETUP.md).
Managed deployment runs appear above readiness details after confirmation;
**Copy full run log** copies saved events and step results for diagnosis.
An uncertain nginx reload can be closed by an authenticated operator so a
fresh reviewed plan can repeat it; other uncertain side effects stay held.

For an operator-run, dry-run-first repair of Todo's staging root permission and a
staging-only controller scaffold, use [the setup runbook](docs/deploy/TODO-STAGING-SETUP.md).
`node scripts/setup-todo-staging.mjs check` is read-only; no deployment is triggered.

## Run the dashboard

```bash
npm install
npm run dev             # → http://localhost:4317   (set PORT to change)
```

Node 22.5 or newer — psm keeps your notes in a local SQLite database through Node's
built-in `node:sqlite`, which older releases do not have.

To try the hosted page locally — the same static files nginx serves at
psm.werewolf.solutions — run the static host alongside an agent:

```bash
npm run agent           # the machine half: linked folders only, pairable
npm run web             # → http://localhost:8080   the page, with no server behind it
```

`scripts/dev.sh` and `scripts/static.sh` hand `PORT` to the process rather than exporting
it, and refuse to be sourced. `PORT` inherited from somewhere else is a nasty one to debug:
`dotenv` does not overwrite variables that already exist, so a project silently ignores its
own `.env` and uses the inherited value. For the same reason psm strips `PORT` and every
`PSM_*` variable from the environment it gives a project's **Run** command — otherwise
every dev server psm launches would try to bind psm's own port. If something binds an
unexpected port anyway, check `echo $PORT` in that terminal.

## Two postures, and a page

psm has two postures, chosen with `PSM_MODE`, and both have a machine under them:

| Mode | What it is | Scans |
| --- | --- | --- |
| `dev` (default) | the local cockpit, `npm run dev` | `workspaceRoot` automatically |
| `agent` | the same server, driven from psm.werewolf.solutions, `npm run agent` | only linked folders |

There is no third. **psm.werewolf.solutions is static files** — nginx serves `web/`, the
browser signs in against werewolf-dapp directly, and every project operation goes to the
agent on your own machine. `PSM_MODE=hosted` is refused with a pointer to that fact, because
someone setting it is expecting a server that does not exist.

The reason it is shaped this way: **a page served from the internet cannot read your disk.**
"Hosted" and "maps all your local projects" only coexist if something local keeps running —
so the something local is the agent, and the page is just a page. Your code, logs and AI
output never reach a server.

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
| `agent` | production — `https://werewolf.solutions/api/v1` |

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

### Sign in with Werewolf

The same OAuth 2.0 authorization-code + PKCE handoff todo-app uses: leave for dapp's
consent screen, come back to `/auth/callback` with a 60-second single-use code, redeem it
for a session. Because the browser is already signed in at werewolf.solutions, there is no
password to retype — and psm never sees one.

**One application.** `client_id` is `psm` in every posture — one row, one consent screen,
one callback path. psm used to register twice (`psm` as a `native` client for the cockpit,
`psm-web` for the hosted page) because dapp's native rule and its web rule cannot come from
one row; the cost of collapsing them is that psm's ports are **pinned** and registered
exactly, the way todo-app pins 5200. See `docs/werewolf-psm-registration.md` for the list.

**Two transports, because of one cookie.** dapp gives a `web` client its refresh credential
as an httpOnly cookie and omits it from the JSON, and that cookie is `SameSite=Lax` and
host-only on the API's host:

- The **hosted page** at psm.werewolf.solutions is same-*site* with werewolf.solutions, so
  it exchanges and refreshes directly and the cookie rides along — exactly like todo-app.
- The **cockpit** on localhost is cross-site, so the browser would drop the cookie on the
  floor. The page posts its code to its own agent instead, and psm's server keeps the
  cookie. A server has no SameSite rules.

The PKCE half is the same code in both, and the verifier never leaves the tab that minted
it. Either way, no refresh credential ends up anywhere JavaScript can read.

**It says so when it cannot work.** dapp answers `app_not_configured` until the row exists,
and its consent screen cannot explain itself, so psm asks first — before redirecting — and
puts the answer in the sign-in panel: not registered, registered as the wrong client type,
or this exact callback not allowed.

Historical note: psm redeemed the code server-side and handed the browser a cookie carrying nothing
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

- **Accounts** from werewolf-dapp (`/apps/psm/auth/*`), with the browser doing PKCE the
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

On **Deploy**, a fresh exact plan appears above the readiness and connection
details. **Review plan** jumps to it; **Confirm & deploy** inside that plan is
the action that approves its digest. **Check again** refreshes readiness and
brings the new plan into view. HTTP response times remain available as evidence,
but changes in latency alone cannot invalidate an approved plan.

Chats (including planner/reviewer and preparation attempts), Run/Deploy command
output, and deployment events show their recorded local date and time with seconds.
Hover a timestamp for its timezone. Preparation and deployment panels also show
when work started or last changed, and when readiness was checked. Reopening history
preserves the original event times; older entries without a timestamp say so.

Failed artifact preparations offer **Open GitHub run** (when GitHub supplied a run
ID) and **Retry preparation** on the Deploy page. Dispatch and artifact-import
failures show their recorded cause and pause for correction, without spending AI
attempts editing application source. Retry starts a fresh preparation check;
infrastructure changes retain their existing approval requirements.
Artifact import supports both canonical snake_case results and the complete
legacy camelCase format emitted by published Todo workflows, with the same
strict identity and provenance checks (mixed formats are rejected).

- **Plan** — structured implementation plans render as editable phase cards and nested
  steps beside a dedicated planning room. A read-only planner and a second-model reviewer
  iterate for up to three revision-bound rounds; reorder or edit the result, then
  **Confirm & start working** to open a fresh normal project-agent session. Confirmed
  revisions are immutable and progress becomes a live checklist.
- **Capabilities** — grant managed agents repository, local Git, remote Git, execution,
  and integration access individually, by category, or with **Grant full access**. Remote Git
  includes bounded fetch and non-force push to operator-configured remotes. The same pane
  attaches explicit workspace MCP servers, copy-pinned docs/API specs, repository skills,
  or a custom MCP command/URL; attached calls keep their individual review flow.
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
  - **Figures, not ASCII art** — psm's interaction protocol asks the AI to answer a
    "show me how this fits together" question with a ` ```psm-figure ` block instead of
    box art in a text fence, and the transcript renders each one as a real HTML surface
    in place, between the paragraphs around it. A figure draws in an iframe sandboxed to
    `allow-same-origin` and nothing else — scripts, forms, popups, and navigation off,
    plus a CSP that cuts off the network — with psm's own colour tokens handed in so it
    matches the cockpit in either theme. Each figure carries **fullscreen**, **copy
    source**, and **download .html** controls; the transcript stores the block, not the
    rendering, so figures survive a reload and the source is always recoverable. A plain
    ` ```html ` block still means "here is some markup" and is shown as text.
- **Workroom dependencies** — a room spanning several projects names, above the conversation,
  every managed dependency between its members that is not passing, and links to the project
  that owns each one. These are recorded observations, so opening a room never probes anybody's
  endpoints, and an edge nobody has planned yet says *not observed* rather than claiming a
  failure. An owner is only ever the project a manifest names — psm does not infer one from a URL.
- **Session** — a read-only tab with the provider session id, model, effort, queue depth,
  current activity, and recent AI events for the project.
- **Questions** — the header lists pending questions across projects, workrooms,
  workspace chat, planners and reviewers, with a count. New questions and page
  reloads update the list without opening dialogs. Choose **Review question** to
  answer; closing the dialog leaves it pending. A waiting chat also has a direct
  **Review question** button beside its composer.
- **Recap** — a "where we left off" summary shown on reopen.
- **Subscription usage** — **Usage** appears only inside an opened project and reads only
  the provider selected by that project's engine/model controls. A shared engine/model cache
  is reused across projects and refreshed automatically every minute; unchanged responses do
  not rerender the percentage or modal. Changing the selected model switches to its cached
  view or loads it once. Provider-reported model-family windows are narrowed where available.
  Hard provider limits also pause sending in the AI pane.
- **Capabilities** — attach reusable workspace pieces (MCP servers, skills, docs, and
  API surfaces) to a project with a preview of the files psm will write.
- **Deploy** — projects without a deployment manifest now get **Set up managed
  deployment**. PSM detects the repository and application, offers setup for supported
  static Vite projects, and explains blockers for other stacks. The generated files
  stay local until reviewed and published. Existing Staging/Production commands remain
  available as explicitly **unmanaged** commands with a "Guide me with AI" hand-off.

  Alongside them, the **managed** desired-state engine specified in
  [`docs/deploy/DEPLOYMENT-SYSTEM.md`](docs/deploy/DEPLOYMENT-SYSTEM.md) is built and wired in.
  psm carries its own manifest (`.psm/deployments.json`), so its Deploy pane is the managed
  one. A project with such a manifest gets a Deploy pane that observes the
  environment, builds a plan, blocks it when anything has drifted, takes an exact-digest
  approval bound to what was reviewed, then runs it with live events, target locks, crash
  recovery and rollback. Every one of the fifteen action kinds has an installed executor,
  across a root-owned [host helper](host-helper/), DigitalOcean DNS, a GitHub release
  controller and an external monitor.

  **Prepare build / Make ready** shows each automated repair as an expandable PSM
  entry in its session, labelled with its attempt number. Three attempts are a
  ceiling: if a repair leaves the source revision and readiness checks unchanged,
  preparation stops before another prompt or build. Supply the missing evidence
  or access and resume explicitly; existing build and typecheck gates stay in place.

  The supported recipes are `static-ssh-nginx@1` and `node-service-ssh-nginx@1`.
  Todo staging has completed a managed static release. Handymanservices staging
  completed its first managed Node service release and PSM verification on
  2026-10-01 (`run_29d57729336843e6`, version 1.0.1). Its GitHub App controller,
  scoped host access, runtime secrets, DNS, TLS and public release probes were
  exercised on the real target. The Node recipe still needs retained-release
  rollback and zero-downtime switching acceptance. [P07a status](docs/roadmaps/github-button-setup.md).
  See [project setup and limits](docs/deploy/PROJECT-SETUP.md),
  [connections](docs/deploy/CONNECTIONS.md) and
  [remaining acceptance](docs/deploy/DEPLOYMENT-SYSTEM.md#what-is-not-proven-yet).

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
src/server/deploy/   the managed deployment engine — manifest, graph, connections/secrets,
                     observation, planner, approval, durable store, runner and executors
.psm/deployments.json  psm's own desired state: one production environment on
                     psm.werewolf.solutions, planned by the engine above
.psm/scripts/        the CI half of the artifact contract — builds web/ into an immutable,
                     independently digested payload for .github/workflows/build-static.yml
host-helper/         the root-owned Go service a target runs so psm can reconcile nginx,
                     certificates and immutable release directories without a shell
schemas/             the published JSON Schema for `.psm/deployments.json`
<project>/.psm/      committed per-project psm config: rules.md overlay, profile.json (practices),
                     identity.json (stable id), deployments.json (managed deployment manifest)
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
Each project and workroom remembers its selected tab in this browser. Switching
to a preparation session and back therefore returns to Deploy; explicit links
to another tab still take precedence, including after a page reload.

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

PSM's managed `git_commit` now assigns the version for code commits: if the root
version still equals HEAD, it increments Z and synchronizes the root npm lockfiles.
An explicitly staged newer version is preserved; Markdown/reStructuredText-only
commits keep their version. This requires `repo.edit` as well as `git.commit`.
PSM refuses to absorb unstaged or untracked version-file changes into that commit.

Deployment readiness detects uncommitted application files, not just manifest or
package edits. Builds are selected by the current commit, source repository and
environment build inputs. A new commit clears the previous artifact selection
and cached readiness; finishing preparation refreshes the artifact list in the
open page. External commits that omit a version bump are caught before building,
and Make ready can create a managed version commit. Publishing still uses the
reviewed source-publication flow; existing artifacts are never relabelled.
An identical artifact already active on a target can be redeployed to finish
PSM's verification after a later probe fails; a different artifact at the same
version still needs a version bump.

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
- What you *write* — the per-project notes pane: bugs and todos, features, ideas — is kept in
  a local SQLite database at `.psm-data/psm.db` (gitignored), so one note is edited without
  rewriting a file and nothing is lost to a crash mid-write. It uses Node's built-in
  `node:sqlite`, so there is nothing to install; the schema is migrated forward on startup by
  `src/server/db.ts`. Notes written before the database (`.psm-notes/*.json`) are imported once,
  automatically, and those files are then left alone.
- psm listens on `127.0.0.1` and rejects non-loopback Host/Origin requests. Custom manifests
  may contain environment variable names, never values; export required variables before
  starting psm.
- The AI panes shell out to the `claude` / `codex` CLIs; they must be installed and
  authenticated. Their live APIs supply the current model and supported-effort catalogs;
  discovery failures are shown without inventing model or effort choices. Full-access mode runs the
  AI with elevated permissions in that project — it's off by default and opt-in per
  project.

## Provider maintenance

Run `npm run providers:check` to check installed AI CLIs, available updates, and
live model/effort discovery. See [provider maintenance](docs/provider-maintenance.md)
for project-specific checks and the contract for adding providers.


## Workspaces (personal and business)

The header selector chooses a workspace: **Personal** always works, signed out and offline;
business workspaces appear only for a signed-in Werewolf account that the API says belongs to them
(`src/server/workspaces.ts`). A project's workspace is recorded against its stable
`.psm/identity.json` id, not its directory, and moving it never changes file, agent-pairing or
deployment access. See [docs/roadmaps/workspace-implementation-status.md](docs/roadmaps/workspace-implementation-status.md).
