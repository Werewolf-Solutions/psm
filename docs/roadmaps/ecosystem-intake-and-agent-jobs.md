# P14 — Ecosystem intake, project AI manager and bounded agent jobs

Written 2026-10-15. Status: **planned; Phase A starts now.** Linked from the
[delivery index](README.md) as P14.

## What the user asked for

1. Tag a project from Todo with `@project`. A list opens and narrows with every
   letter typed.
2. The tag reaches a **project AI manager** in PSM. It answers: does this fit,
   what does it collide with or depend on, and where does it go in the queue.
3. Agents work **whenever there is work**, such as many todos or a lot of user
   feedback, and sit **idle when there is none**. No open-ended agents running
   for their own sake. Every job is bounded and has a clear output: a nightly
   test report, a weekly roadmap proposal, or a draft branch for the top
   accepted intake item.
4. PSM has to be **online and persistent** so Todo and the rest of the
   ecosystem can reach it.
5. Fix the P05 blocker. Every Todo route failed `preview_check` because Todo's
   session refresh (`POST /api/v1/apps/todo/auth/refresh`) has no backend in
   the offline sandbox
   ([evidence](../evidence/todo-browser-walkthrough-2026-10-13.json)). The fix
   is to run the werewolf-dapp backend inside the sandbox as well.

## Facts this plan is built on (checked 2026-10-15)

| Fact | Source |
| --- | --- |
| The dapp server reads `PORT=3000` from both `werewolf-dapp/.env` and `server/.env`. `bin/www` falls back to 3001. | `.env` files, `server/bin/www:15` |
| `npm run server` is `cd server && npm run dev`, which is `nodemon ./bin/www`. `start` is `node ./bin/www`. | `werewolf-dapp/package.json`, `server/package.json` |
| The dapp needs MongoDB (`MONGODB_URI`) and Redis (`REDIS_URL`). Locally these are 127.0.0.1:27017 and :6379. | `server/.env` |
| Todo's Vite proxy sends `/api` to `VITE_API_TARGET`, which defaults to `http://localhost:3000`. Todo ships no server of its own. | `todo-app/client/vite.config.ts` |
| The sandbox is `docker run --network=none --read-only --cap-drop=ALL …`. | `src/server/agent-task-runner.ts:118` |
| `mongo:7`, `redis:7-alpine`, `node:22-bookworm-slim` and `psm-task-browser:1.64.0` are already preloaded. | `docker images` |
| `TodoTask.project` and `TodoNote.project` already exist. Both are plain strings holding a PSM directory name. | `werewolf-dapp/server/models/TodoTask.js:123` |
| The dapp already serves PSM routes (`/api/v1/psm/*`: auth, devices, sync, todos, backups). | `server/routes/api/v1/psm.js` |
| **No PSM process runs on any server.** `psm.werewolf.solutions` is static, and werewolf-alpha has about 323 MB free on EOL Ubuntu 20.04. | memory: hosted-psm-architecture, werewolf-alpha-capacity |
| Production dapp has **no PSM CloudApplication row**, so `/apps/psm/*` answers `503 app_not_configured`. | `docs/werewolf-psm-registration.md` |
| Workroom write leases are **not built**, so two writers can edit one repo. | memory: workroom-plan-sequencing |

## The shape: what "PSM online" means here

A PSM server on the droplet was built once and withdrawn because the host had
no memory for it, and that constraint still holds. This plan makes PSM
persistent and reachable **without** putting a PSM process on werewolf-alpha.
The work is split into three pieces:

```text
 Todo (browser) ──@project──▶  PSM hub = module in werewolf-dapp  ◀──HTTPS poll── PSM executor
 psm.werewolf.solutions ──────▶  (already deployed: Mongo, Redis,       (psm in agent mode, always on,
                                   BullMQ, /api/v1/psm, sessions)         systemd user service on a
                                                                           machine that has the repos)
```

- **Hub (online, persistent).** This is new code in werewolf-dapp. It holds the
  project registry, intake items, triage verdicts and the job queue. Todo, the
  hosted PSM page and any other ecosystem app talk only to the hub. It costs a
  few routes and collections in a process that is already running, not a new
  service.
- **Executor (persistent, wherever the repos are).** This is the existing PSM
  agent running as a long-lived service. It publishes the project registry,
  claims jobs with a lease, runs triage and agent jobs in the existing sandbox,
  and posts results back. Source code, logs and AI output stay on that machine.
- **Page (online).** `psm.werewolf.solutions` reads the hub with a dapp session.
  The inbox, verdicts and job history are visible even when the executor is
  offline, and the page shows when that is the case.

If a full PSM server is still wanted online later, it needs its own host
(decision D1). It does not change the hub contract below.

## Phase A — Real backend in the preview sandbox (unblocks P05). Start now.

Goal: `preview_check` on Todo passes with the **real** werewolf-dapp answering
`/api`, without fixtures, and still with no internet egress.

**A1. Boot probe.** By hand, run dapp in `node:22-bookworm-slim` on a
`docker network create --internal` network next to `mongo:7` and
`redis:7-alpine`, both on tmpfs and fresh each run. Record which env vars it
refuses to boot without, and which route works as a readiness probe (no health
route was found in `app.js` or `routes/`). Set `PORT=3000` **explicitly**:
never inherit it, because an inherited `PORT` silently beats `.env`.

**A1 result (2026-10-15, done by hand, all containers removed afterwards).**
- Setup: internal network, `mongo:7` on tmpfs, `redis:7-alpine`, and the dapp
  checkout mounted read-only, run with `npm run dev` (nodemon works).
  Outbound fetch fails with `EAI_AGAIN`, so there is no egress.
- **The real `.env` must be masked.** Without that, dotenv loaded 59 real
  variables, including secrets and the real `MONGODB_URI`, into the sandbox.
  An empty file is bind-mounted over both `server/.env` and the root `.env`.
  The runner must do the same for every service, and a test must assert
  `injecting env (0)`. The existing snapshot (`taskInputs` →
  `git ls-files --exclude-standard`) already leaves out gitignored `.env`
  files. The leak only happens with a raw bind mount like the probe's, so
  service projects must go through the same snapshot. Add an explicit `.env*`
  deny as well, for projects that are not git repos or do not ignore `.env`.
- `logs/` and `uploads/` must be writable tmpfs, or boot dies with `EROFS` on
  `logs/server.log`.
- **`NODE_ENV=development`, not `test`.** `app.js` deliberately skips the DB
  connection under `test`. The URI is `MONGODB_URI=mongodb://mongo:27017/psm-preview`.
- Boot needs only `PORT=3000`, `MONGODB_URI`, `REDIS_URL` and throwaway
  `JWT_SECRET`/`JWT_APP_CODE_SECRET`.
- A fresh DB gives `503 app_not_configured` for `todo`. Seed: insert a
  `businesses` doc, then run the real
  `TODO_BUSINESS_ID=<id> node scripts/bootstrap-todo.js`.
- Refresh then answers by Origin:
  - `http://localhost:5200` gets **401 "Refresh token is invalid or expired"**,
    the correct signed-out answer.
  - `http://127.0.0.1:5200` and no Origin get **403 "Application origin is not
    allowed"**. The registered origins are exact strings.
  - So the browser must load Todo at `http://localhost:5200` (the
    development redirect URI). Serving on `127.0.0.1` would fail every route
    again.
- `GET /` returns 200 and works as the readiness probe.

**A2–A4 result (2026-10-15): implemented locally, not committed.**
- Todo's five routes pass `preview_check` against the real dapp with **no
  fixtures**. Evidence:
  [todo-browser-walkthrough-2026-10-15.json](../evidence/todo-browser-walkthrough-2026-10-15.json).
- The format that shipped is schema `psm.werewolf.solutions/preview/v2`. It
  differs from the sketch below in these ways:
  - `secrets` lists variables PSM fills with random values on each run.
  - `expected` lists real 4xx answers that are normal, such as the
    signed-out refresh 401. Each one used is reported.
  - `host` is `localhost` or `127.0.0.1`.
  - No `writable` list is needed: the service runs from a copied tmpfs
    workspace.
  - Dependencies come from the service project's own installed
    `node_modules`, mounted read-only at `/deps`. The brokered installer
    refuses dapp's stale local `../../accounting` lock entry.
  - `.env*` files (except example/sample/template) are never copied for
    any project.
- A4: a service project must be in the task's scope and needs its own
  `repo.read` and `script.run`. Otherwise nothing starts.
- The seed is `werewolf-dapp/server/scripts/preview-seed.js`. It refuses any
  Mongo host except `mongo`.

**A2. Declaration (original sketch).** Extend `psm-preview.json` with a `services` list that the
app under test declares:

```json
{
  "services": [{
    "project": "werewolf-dapp",
    "cwd": "server",
    "script": "dev",
    "port": 3000,
    "ready": { "path": "/", "status": [200] },
    "env": { "NODE_ENV": "development" },
    "writable": ["logs", "uploads"],
    "needs": ["mongo", "redis"],
    "seed": ["preview-business", "node scripts/bootstrap-todo.js"]
  }],
  "proxyEnv": { "VITE_API_TARGET": "http://werewolf-dapp:3000" },
  "origin": "http://localhost:5200"
}
```

`script: "dev"` mirrors `npm run server` as requested. If nodemon misbehaves
on a read-only root, fall back to `start` (same entry point, `node ./bin/www`).
PSM injects `MONGODB_URI=mongodb://mongo:27017/psm-preview`,
`REDIS_URL=redis://redis:6379`, `WORKERS_IN_PROCESS` as needed, and throwaway
random JWT secrets that are generated per run and never read from the real
`.env`.

**A3. Runner.** In `agent-task-runner.ts`, `runPreview` gets a service stage:

1. Create an internal network.
2. Start mongo and redis.
3. Start the dependency project from its own checkout (read-only mount,
   dependencies installed through the existing brokered `downloadLockedPackage`
   path, which gives no registry access from inside).
4. Wait for readiness, bounded at 60 s, and on timeout report the service's
   last log lines.
5. Run the browser container on the same network.
6. Tear everything down in `finally`.

Resource limits match the current sandbox, and the whole stack counts toward
one task timeout. Fixtures still apply. A declared fixture answers first, so
apps without a backend keep working.

**A4. Permissions.** Reading a second project (dapp) from a Todo task is a
cross-project read. The grant shows up as `repo.read` on `werewolf-dapp`
through the existing grant-request flow, never as a silent widening.

**A5 result (2026-10-15): verified locally.**
- Signed in, `/`, `/objectives`, `/notes` and `/backlog` render against the
  real dapp with no fixtures and no errors.
- How the session works:
  - `psm-preview.json` declares
    `session { cookie, path, secret }`, where the secret must be one a service
    declares, so a real token can never live in a repository.
  - PSM generates the token per run, and `preview-seed.js` issues a real Todo
    session whose refresh hash matches it.
  - The probe carries the cookie jar route to route, because tokens rotate.
- `preview_check` takes `signedIn: true`. Only signed-out passes record
  verification.
- Fixed along the way: mongo:7 aborted on the 256 MB tmpfs (preallocated
  journals). It now uses about 21 MB.

**A5. Seed for signed-in journeys (original sketch).** Run dapp's `bootstrap:todo` (or a
preview-only seed) against the throwaway Mongo to create one test user, so
board, objectives, notes and backlog can be checked signed in.

**Acceptance:**
- `PSM_RUNNER_DOCKER=1` test: a fixture-free Todo preview passes all five
  signed-out routes against the real dapp.
- One signed-in route passes.
- The network is `internal`, which a test proves by failing to reach an
  outside address.
- Containers and networks are gone afterwards.
- New evidence file `docs/evidence/todo-browser-walkthrough-<date>.json`.
- Then the P05 managed-agent walkthrough of Todo can run.

## Phase B — PSM hub in werewolf-dapp, executor as a service

**B1. Project registry.** Collection `PsmProject`: `{ projectId (prj_…),
name, displayName, workspace, owner, archived, lastSeenAt }`. Route
`PUT /api/v1/psm/projects` is a bulk upsert from the executor after each scan.
The `prj_` ids come from `.psm/identity.json`; projects without one get one
first, the existing stable-ids flow.

**B2. Intake.** Collection `PsmIntake`:

```text
{ intakeId, projectId, source: todo|manual (feedback later), sourceRef, text,
  status: new|claimed|triaged|failed|withdrawn,
  claim: { executorId, leaseUntil }, verdict, createdBy, createdAt }
```

An intake is created server-side when a Todo task or note is saved with a
project, so the browser cannot forge one for another user. Editing the task
text re-opens triage, and deleting the task withdraws the intake.

**B3. Executor API.**
- `POST /api/v1/psm/executor/claim`: long-poll for up to 30 s, returns at most
  one job with a lease, and is idempotent.
- `POST …/jobs/:id/heartbeat` and `POST …/jobs/:id/result`.
- An expired lease returns the job to the queue.
- BullMQ (already in dapp) handles schedules and delays. Mongo is the source of
  truth.

**B4. Auth.** Hub routes require a platform app (B0). The executor uses the existing PSM device session
(`/apps/psm/auth/refresh`, devices list and revoke). Hub routes are **not**
gated on the PSM Pro entitlement that `/sync` uses. Production needs the PSM
CloudApplication row (decision D2). Until then, B runs against local dapp
(:3000) and staging dapp (:5100 on werewolf-alpha).

**B5. Executor service.** PSM in `PSM_MODE=agent` gets:
- a `psm executor` loop: publish registry, claim, run, report
- a systemd **user** unit (`Restart=on-failure`, no root, no privileged
  container)
- a status line in the PSM UI: connected / last claim / jobs running

**B6. Hosted page.** `psm.werewolf.solutions` gets an Inbox view that reads
the hub: intake items, verdicts, job history, and executor online/offline.

**Acceptance:**
- A Todo task saved with a project creates exactly one intake item.
- A running executor claims it.
- Killing the executor mid-job returns the job to the queue after the lease
  expires, with no duplicate result.
- A second user cannot read the first user's intake.
- Tests live in dapp's suite, and PSM has a contract test against a local dapp.

## Phase C — `@project` in Todo

**C1.** Add `GET /api/v1/apps/todo/projects?q=` in dapp, using the Todo-audience
session and backed by `PsmProject`. Ranking: prefix match on name, then prefix
on display name, then substring. Limit 8. The client caches the last full list
so it still works offline.

**C2.** In the task and note editor, typing `@` opens a popover that re-filters
on every keystroke: client-side over the cached list, then server-side when
the list is stale. ↑/↓/Enter/Tab/Esc work as expected and the popover has
`aria-activedescendant`. Choosing a project inserts a chip and sets
`projectId` **and** the legacy `project` name. That keeps existing links and
PSM's per-project Todos pane working.

**C3.** Show the verdict badge on the task (fits / needs decision / doesn't
fit / triaging…). Clicking it opens the rationale and a link to the project's
PSM workspace.

**Acceptance:** a browser walkthrough through `preview_check` with the Phase A
backend. It types `@to`, the list narrows to matching projects, the user picks
one, the task is saved, and the badge reaches "triaging".

## Phase D — Project AI manager (one-shot triage)

**D-1. Context pack.** The run reads, without writing:
- `docs/roadmaps/**`, README and CLAUDE.md
- `git log` for 30 days, open branches and unmerged work
- open intake items and Todo tasks for the project
- AI session recaps and Workroom membership
- the latest job reports

The pack is assembled deterministically by PSM and its size is capped. The AI
does not go looking for it.

**D-2. Run.** One engine call in the project's scope with edit tools disabled
(read-only permission set; the sandbox is not needed because nothing executes
project code). 5-minute timeout. A content hash of the intake text plus the
context version gives cache hits for identical triage.

**D-3. Output.** A strict JSON schema, validated, so a malformed answer counts
as a failed run rather than a fake verdict:

```json
{ "verdict": "fits|doesnt_fit|needs_decision",
  "size": "S|M|L|XL",
  "dependsOn": ["roadmap item / intake id"],
  "conflictsWith": ["…"],
  "queue": { "after": ["P05 walkthrough", "intake_123"], "note": "…" },
  "questions": ["…only when needs_decision"],
  "rationale": "…" }
```

There are **no calendar dates**. Position is relative to named items. A
`needs_decision` verdict lands in PSM's existing Questions inbox.

**Acceptance:** ten real intake items across three projects get verdicts. The
user grades them, and the graded set is kept as a regression fixture for
prompt changes.

## Phase E — Bounded agent jobs: busy when there is work, idle when there is not

**E1. Job model: one queue per project.** Every job has a type, a trigger,
an input, a timeout and attempt limit, and an expected output artifact. **Each project has its own
queue and at most one writing job at a time**, enforced by the E3 lease.
Read-only jobs (triage, test reports) can run beside it. A global pool of N
workers (default 2) serves all project queues. **An empty queue means zero
running agents.** That is the "always working" behaviour without anything
running for its own sake.

The focus (2026-10-15) is the Todo → PSM connection and per-project
implementation. Feedback-hub intake is deferred (see D5).

| Job | Trigger | Output | Writes code? |
| --- | --- | --- | --- |
| `triage` | new or edited intake | verdict (Phase D) | no |
| `implement` | user marks a triaged intake "go"; runs in queue order | branch `psm/job/<id>` in its own worktree **on the executor, not pushed** (D4), with tests and `preview_check` results attached | yes, behind the lease |
| `nightly-tests` | cron, per project with tests | report: pass/fail diff vs last night, new failures, flaky list | no |
| `roadmap-review` | weekly | proposal file `docs/roadmaps/proposals/<date>.md` on a local branch | docs only |
| `feedback-digest` | *deferred*: feedback-hub, batched | clustered, deduped intake items | no |

Reviewing an `implement` result: the PSM page shows the branch's diff, test
output and preview results from the executor. **Accept** merges it into the
project's working branch on the executor and pushes only when you click.
**Reject** deletes the branch. **Revise** re-queues the job with your comment.

**E2. Stop rules (all mandatory, enforced by the executor, not the prompt).**
- Timeout per job type, and at most 3 attempts at the same failing check (D3).
- One retry after a crash or timeout, then `stalled`.
- **No-progress detector:** stop when two consecutive iterations produce no
  new diff hunk, the same failing test set, or a summary too similar to an
  earlier one (normalized-text similarity above a threshold).
- A stopped job ends `stalled` with its reason and a Questions-inbox entry.
  It never retries silently. The repeat guard ("stop repeating unchanged repair
  attempts", e41ff2a) is the model to follow.

**E3. Write safety. This must land before `implement` is enabled.**
- Repo write leases: one writer per repo, lease in the hub, released on
  finish or expiry. This closes the known Workroom gap.
- One git worktree per job, and branches named `psm/job/<id>`.
- **Local branch only (D4).** No push, no PR, no merge, no deploy without a
  click. Releases stay in the existing P07/P12 gates.

**E4. Visibility.** A Jobs view (hosted page and local) shows queue, running,
stalled and done, time per job, and a kill switch for the whole
pool and per project.

**Acceptance:**
- With an empty queue, no engine process runs (checked with `ps`).
- 50 synthetic intake items drain with at most N concurrent jobs.
- An injected loop (a job that makes no changes) stalls at the
  second-iteration check.
- Two `implement` jobs on one repo serialize on the lease, and two different
  projects run in parallel.

## Execution order

1. **A2 → A5** (local; A1 is done). This closes the P05 blocker and is what
   lets `implement` jobs verify Todo frontend changes.
2. **B0** (platform apps in dapp, D2), then **B1-B3 + C1-C3 against local
   dapp**, then staging dapp.
3. **D** on the local executor.
4. **E3** leases, then the **E1** `implement` job and E2 stop rules, on the
   local executor.
5. **V1-V4**: move the executor to the new VPS (D1), then **B6** hosted inbox.
6. `nightly-tests` and `roadmap-review`. Feedback-hub later.
7. Production hub after staging acceptance.

Each step records its evidence in [acceptance-evidence.md](acceptance-evidence.md)
in the existing handoff format.

## Decisions (answered 2026-10-15)

- **D1. The executor runs on a new VPS, `46.101.14.20`.** See the V steps below.
- **D2. PSM is an internal Werewolf Solutions app. Separate platform apps from
  business-owned apps.** See B0. This replaces the open `PSM_BUSINESS_ID`
  question.
- **D3. No spending budgets. Jobs stop on time and on being stuck.**
  The executor enforces these, not the prompt:
  - **Timeout:** triage 5 min; `implement` 60 min; `nightly-tests` 30 min.
  - **Attempts:** an `implement` job gets at most 3 attempts at the same
    failing check (tests, build or `preview_check`). After that it stops.
  - **Stuck detection:** stop when two consecutive iterations produce no
    new diff hunk, the same failing test set, or the same summary.
  - **Retries:** a crashed or timed-out job is retried once. After that it
    stays `stalled`.
  - **Concurrency:** one writer per project; pool of 2 jobs at once overall.
  - A stopped job keeps its partial branch and lands in the Questions inbox
    with the reason. It never loops silently.
- **D4. Local branch only for now.** No push and no PRs from jobs.
- **D5. Feedback-hub deferred.** It is the embeddable widget/MCP feedback
  product. Its intake comes after the Todo ↔ PSM connection and the
  per-project implementation queue work.
  **Lifted 2026-11-09:** planned as [P16](p16-feedback-intake.md), after the
  implement path is proven end to end (P16 Gate 0).

### B0 — Platform apps vs business apps (from D2)

Today every `CloudApplication` belongs to a Business, so registering PSM means
choosing a business to own and bill it. Add an owner kind:

- `owner: { kind: "platform" }` — Werewolf Solutions' own apps (PSM, Todo,
  the portal). No business, no Stripe Connect onboarding, and allowed to call
  hub routes.
- `owner: { kind: "business", business }` — apps and webapps that a
  customer business publishes. These keep the current rules.

Steps:
- Migration: existing rows become `business` unless listed as platform.
- `bootstrap-todo.js` and a new `bootstrap-psm.js` register platform rows.
- Catalog, billing and entitlement code must branch on the kind, never on
  the app key.

Platform-app redirect URIs keep the exact-match rule. This is a werewolf-dapp
change and needs its own tests there.

### V0 — Create machines from PSM (decided 2026-10-15)

**DigitalOcean first**, behind a small provider interface (`createMachine`,
`addKey`, `list`, `destroy`). The account and SSH keys already exist and
werewolf-alpha's onboarding was proven there. A second provider, Hetzner for
example, comes later and is what proves the interface. It is not part of this
slice.

Flow, from one **Create machine** action:
1. Use a DigitalOcean token scoped to droplet, ssh_key and read, kept in
   PSM's credential store.
2. PSM generates its own key and uploads it.
3. PSM generates the server's **SSH host key itself** and hands it over in
   cloud-init, so the fingerprint is known before the first connection (no
   TOFU).
4. cloud-init creates the users and sets up Docker, Node 22, the firewall
   (SSH only) and unattended security upgrades.
5. The existing P04 onboarding runs (helper, roles), then the executor role.

Engine logins without SSH (both checked on this machine 2026-10-15):
- **Claude:** the operator runs `claude setup-token` locally, where the
  browser is. PSM stores the token and installs it for the `psm` user.
- **Codex:** 0.162.1 has `codex login --device-auth`. PSM starts it on the VPS
  and shows the code in the page.

The executor's device is registered by the "Create executor" click itself.
The reboot test is a confirmed button that reboots and verifies reconnection
without anyone logging in.

### V-keys — Connecting a machine, from "I have no key" to connected (extends P04)

The operator types an address. Everything after that is one of these paths.

**Step 1: Is this the right server? (host key)**
- PSM scans the server's host key and shows its fingerprint.
- For a droplet PSM created itself (V0), the fingerprint is known in advance,
  so it is compared automatically.
- Otherwise the operator compares it with the fingerprint shown in the
  provider's console.
- A mismatch stops everything. No keys are tried against a server that might
  be the wrong one.

**Step 2: Can one of my keys log in? (automatic)**
- PSM lists the key pairs in `~/.ssh` and tries each one on its own:
  `BatchMode`, `IdentitiesOnly`, agent off, pinned host key. Users tried:
  `root`, then the operator's own username, then any user typed in.
- Each key gets one plain answer:
  - works with sudo
  - works without sudo
  - refused
  - has a passphrase (cannot be used unattended)
  - server unreachable

**Step 3a: A key works with sudo.**
- One button: "Use werewolf_mesh_droplet once to set up PSM's access".
- PSM creates its own account and key on the server, verifies it, and is
  done. The personal key is never stored.

**Step 3b: A key logs in but sudo needs a password.**
- PSM shows the one setup command to run in that session, where sudo can
  ask for the password. Same result as 3a.

**Step 3c: No key works, the "set it up from new" path.**
1. **Create a key.** One button creates a dedicated ed25519 key for this
   machine, `psm-<machine>`, kept in PSM's credential store. Only its public
   key is shown.
2. **Put the public key on the server.** The page shows only the option that
   fits:
   - **DigitalOcean, with an API token saved in PSM:** "Add to my
     DigitalOcean account" uploads the public key.
     - A droplet you are about to create gets it at creation.
     - An existing droplet still has to receive it through the console
       (next option), because DigitalOcean only injects keys at creation.
   - **DigitalOcean, no API token yet:** the page links to
     *API → Generate New Token* and lists the exact scopes to tick
     (`droplet: create, read`, `ssh_key: create, read`). Once the token is
     pasted, PSM saves it and continues as above. The token is optional for
     connecting an existing droplet; it is needed for V0 creation.
   - **Existing droplet:** *Droplet → Access → Launch Droplet Console*, then
     paste the one line PSM shows. It appends the public key to the right
     user's `authorized_keys` with the correct permissions.
   - **Any other VPS with password login:**
     `ssh-copy-id -i <psm public key> user@host`, shown ready to copy.
   - **Any other VPS without password login:** the provider panel's
     "SSH keys" or recovery console, with the same one line to paste.
3. **Test again.** Step 2 reruns. When the new key works with sudo, PSM
   continues as 3a.

**Never:**
- Ask for or store a passphrase.
- Copy a personal private key.
- Try keys after a host-key mismatch.

**Implemented 2026-10-15:** `src/server/machines/keys.ts`, with tests:
discovery, per-key testing and the next-step decision.

Live check against 46.101.14.20:
- 9 local keys were tested and `werewolf_mesh_droplet` logs in as root with
  sudo.
- `id_ecdsa` was correctly reported as passphrase-only.
- The decision was "use werewolf_mesh_droplet".

Not yet done: wiring into the Add-machine page (`web/machines.js`,
`machines/api.ts`), the key-creation and DigitalOcean upload steps, and the
LXD acceptance run.

**Finding: 46.101.14.20 is not a fresh VPS.**
- Host: up for over 4 years on Ubuntu 20.04 (EOL), 1 vCPU, 976 MB RAM
  (330 MB available), no swap.
- Already running werewolf-mesh, controlroom, nginx (80/443), a Node app on
  :5000, Tailscale, and Python services on the tailnet.
- Too small for the executor: one sandboxed preview alone needs about 3.6 GB.
- Use a new droplet instead: **Ubuntu 24.04, at least 2 vCPU / 4 GB RAM**,
  created through V0 once it exists, or by hand with one of PSM's keys.

### V — Executor on the VPS (from D1)

- **V1.** Read-only inventory of `46.101.14.20`: OS, RAM/CPU/disk, Docker,
  open ports. No changes without approval. **Do not reuse** the homelab key
  that is due for rotation.
- **V2.** Provision:
  - a `psm` user (unprivileged)
  - Docker with the preloaded sandbox images (`node:22-bookworm-slim`,
    `psm-task-browser`, `mongo:7`, `redis:7-alpine`)
  - Node 22
  - `claude`/`codex` CLIs logged in as that user
- **V3.** Repository checkouts, with a deploy key **per repo** and read-only
  until D4 changes. Run psm in agent mode as a systemd **user** unit
  (`loginctl enable-linger psm`). The executor reaches only the hub (HTTPS
  outbound); there are no inbound ports apart from SSH.
- **V4.** The executor's device session in dapp is revocable from the PSM
  devices list. Engine credentials live only on the VPS.
- **Acceptance:**
  - Reboot the VPS; the executor reconnects and claims jobs without anyone
    logging in.
  - Revoking the device stops it within one lease period.

## Relation to existing phases

- Phase A is the remaining **P05** work.
- The hub + executor is a narrow, concrete slice of **P03**. It uses durable
  jobs and leases but has no multi-customer runner fleet.
- Phase E is the first slice of **P09** (scheduled, bounded, standing-grant
  tasks).
- The repo write leases in E3 close the Workroom gap.
