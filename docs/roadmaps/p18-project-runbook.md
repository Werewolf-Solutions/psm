# P18 — Project runbook: what every project can run, and starting it over MCP

Status: **R1–R6 built 2026-11-12, not committed.** R6 (starting and stopping
over MCP) was built after P02a.2 landed the same day. R7 waits for MCP-2.

## Implementation status (2026-11-12)

| Step | State | Where | Checked |
| --- | --- | --- | --- |
| R1 detection | Built | `src/runbook.ts` (`detectRunbook`) | `src/runbook.test.ts`; run against werewolf-dapp, todo-app, feedback-hub (tables below match) |
| R2 Scripts pane, `.psm/runbook.json` | Built | `web/scripts.js`, Scripts tab; `GET/PUT /api/projects/:name/runbook` | Rendered on a disposable psm copy; editor wrote a fixture's `.psm/runbook.json` |
| R3 AI draft | Built | `src/server/runbook-draft.ts`, `POST /api/projects/:name/runbook/draft`, draft panel | `runbook-draft.test.ts` with a fake engine. A real model call was not run |
| R4 units as processes | Built | `src/server/units.ts`, `unit:<id>` kind, `POST /api/units/start|stop` | `units.test.ts`; live on two fixture projects (below) |
| R5 stacks + MCP read | Built | `src/server/stacks.ts` (table `stacks`), `/api/stacks*`, Stacks group on the Agents page; MCP `get_runbook`, `list_stacks` | `stacks.test.ts`, `mcp.test.ts` (real SDK client over HTTP); stack created, started and stopped in the browser |
| R6 MCP start/stop | Built | MCP `start_units`, `stop_units` (`src/server/mcp/operations.ts`, `mcpUnitControl` in `units.ts`); per-unit grant `src/server/unit-grants.ts` (table `unit_mcp_grants`), "Allow for MCP" in the Scripts tab | `mcp.test.ts` (every refusal), `unit-grants.test.ts`, `units.mcp.test.ts` (real SDK client, real processes); grant toggle in the browser; `curl` cannot grant (401) |

Live check on a disposable copy of psm (own state, port 4391, executor off,
guidance writes off) with two throwaway fixture projects, `rb-demo` (server +
client in nested packages, root `concurrently` script) and `rb-app` (a service
and an agent):

- The Scripts pane listed both units with the root aliases, the composite and
  the data script; "Start server/dev + client/dev" started both, each with its
  own log.
- With `rb-app dev` given `dependsOn: rb-demo: server/dev`, starting it started
  the server first ("needed by rb-app dev"). Stopping the server alone was
  refused while `rb-app dev` ran. `seed:db` was refused as a data script.
- A stack (rb-app dev + helper-agent) made in the Agents page started the
  dependency, then both units; stopping it stopped all three, dependents first,
  and left an unrelated unit running.

Differences from the plan below:

- Descriptions come from the root README's script list (it beats a script
  comment), then the script file's header comment, then a generic line per kind.
  Express's "Module dependencies." boilerplate is skipped.
- Ports: command flag, then the folder's `.env` `PORT` (only that value is read),
  then the Vite config, then the entry file's `PORT ||` default. Agents get a
  port only from their own command. werewolf-dapp's server is :3000 from
  `server/.env`, which is what todo-app's Vite proxy targets, so starting
  todo-app's client brings up werewolf-dapp's server by itself.
- The AI draft proposes text and a credit warning only. Kind and dependencies
  are never drafted, and a draft cannot turn a detected credit warning off
  (enforced in `parseDraft` and in the pane).
- The project's Run button and custom commands are unchanged. todo-app's custom
  commands for werewolf-dapp are not migrated yet; its client's proxy dependency
  now does the same job from the Scripts tab or a stack.

Open, found while building:

- **psm restarts orphan what it started.** Children run detached and psm has no
  shutdown handling, so after a restart their ports read as taken and the
  Agents page no longer sees them. Either stop them on shutdown or adopt them on
  start; both change current behavior, so this is an operator decision.
- The MCP tools were exercised by the real SDK client in tests, not yet by
  Claude Code or Codex against your running psm: that needs psm restarted with
  this code and a client minted in Folders → AI clients.

R6 as built:

- `start_units` takes units by `{ projectId, unit }` or a `stackId`, resolves
  dependencies across projects, and is **all or nothing**: every unit in the
  plan, dependencies included, must be in the client's scope, be a service,
  agent or task, be allowed for MCP for its current script, and use only
  resources at Full. Otherwise nothing starts and the reason names each unit.
- The grant is per unit, set only in the Scripts tab (a local write behind the
  P02a.2 operator token), and bound to a digest of folder, script, script text
  and kind: an edited script must be allowed again. A unit that spends credit
  takes a second click to allow.
- Resources come from the unit folder's `.env` references, as in the Resources
  panel. With today's levels werewolf-dapp `server/dev` is refused over MCP,
  because local Redis :6379 is not set (open decision 2).
- `stop_units` stops only allowed units; a stack stops with the dependencies
  it brought up, dependents first; a unit still needed keeps running unless
  `force`.
- Not done: per-client budgets for credit-spending units (the MCP plan's
  budget caps do not exist yet); the result lists those units instead.

## What the user asked for (2026-11-12)

1. Each project's brief in psm lists its scripts, says what each one does and when
   to use it. werewolf-dapp has a server and a client; some projects have scripts
   that run agents; and so on.
2. At the end, use the psm MCP to start several things at once, depending on the
   current work. Example: werewolf-dapp server, client or both, then the todo-app
   and feedback-hub agents, maybe the website agent, then whichever other projects
   are in play (todo-app, feedback-hub, a new project).

## Where psm is today

| Area | Today | Limit |
| --- | --- | --- |
| Detection | `detectRunCommand` (`src/scan.ts`) picks one root script (`dev` → … → `start`). `Signals` holds one `runCommand` and one `port`. | Nested packages (`server/`, `client/`, `mcp/`) are not read. No list of scripts, no descriptions, no "when to use". |
| Running | `procs.ts` runs one process per `(project, kind)`: `run`, `deploy:*`, `custom:<uuid>`, `script:<hash>` (Data). | werewolf-dapp's `run` is `npm run dev` = `concurrently server client`: one process, one log, server and client cannot be stopped separately. |
| Cross-project | todo-app has two custom commands that run `npm run server` / `npm run dev` **in werewolf-dapp** (`overrides.json`). | A workaround for a missing dependency. Starting both todo-app and werewolf-dapp starts the werewolf-dapp server twice and the second fails on its port. |
| Ports | One `port` per project (werewolf-dapp 5173, todo-app 5200, feedback-hub 4400). The server's 3001 is not recorded. | An exported `PORT` in psm's shell overrides every child's port, and dotenv does not replace it (the "injecting env (N)" count shows it). |
| MCP | Read-only: `list_processes` gives kind, status, port. Commands and logs are not served (`MCP_UNAVAILABLE`). | Nothing can be started. The coverage ledger in the [MCP plan](psm-mcp-operations.md#coverage-ledger-for-the-wider-psm-surface) lists start/stop as a later gate. |

Scripts in the three projects of the example, as found on 2026-11-12:

| Project | Folder | Scripts |
| --- | --- | --- |
| werewolf-dapp | root | `dev` (concurrently server+client), `server`, `client`, `website-agent`, `build*`, `test*`, `bootstrap:todo`, `check:version`, `mcp` |
| | `server/` | `dev` (nodemon, port 3001), `start`, `worker`, `website-agent` (+`:create`, `:remote`), `trades-trial`, `test*`, `bootstrap:*`, `repair:psm`, `import:todo`, `export:todo`, `rotate:psm-backup-kek` |
| | `client/` | `dev` (vite, 5173), `build`, `lint`, `preview`, `typecheck`, `test*` |
| todo-app | root → `client/` | `dev`/`client` (vite 5200, proxies to the werewolf-dapp API), `build`, `test`, `carry`, `next-week`, `next-week:dry` |
| feedback-hub | root | `start`/`dev` (port 4400), `test`, `check:client`, `mcp`, `cluster` |

## Two kinds of "agent"

The request uses "agent" for two different things. The plan keeps them apart.

- **Script agents** are long-running processes in a repository: werewolf-dapp's
  `website-agent` and `worker`, feedback-hub's `cluster`. psm starts them like a
  server. They often spend model credit and have guards (`website-agent run` needs
  `WEBSITE_AGENT=local`, a non-production `NODE_ENV` and a local Mongo).
- **AI agents on a project** ("a todo-app agent") are psm-managed Claude/Codex
  sessions or executor jobs working on that project's code. Starting them over MCP
  is MCP-2 (`start_plan`, `start_implementation`) in the
  [MCP plan](psm-mcp-operations.md); this plan only lets a stack include one.

Open decision 1 asks which one "todo-app agent" and "feedback-hub agent" meant.

## Model

### Unit

A **unit** is one thing psm can start, stop and describe:

```jsonc
{
  "id": "server",                    // stable within the project
  "title": "API server",
  "folder": "server",                // relative to the project root
  "script": "dev",                   // a package script, or "command" for non-npm units
  "kind": "service",                 // service | agent | task | data | mcp | install | deploy
  "summary": "Express API with nodemon reload. Everything else talks to it.",
  "whenToUse": "Any work that touches the API, the hub or a client that calls /api.",
  "port": 3001,
  "ready": { "port": 3001 },        // or { "log": "listening on" }
  "dependsOn": [],                  // unit refs, may name another project: "werewolf-dapp:server"
  "env": ["MONGODB_URI", "REDIS_URL", "WEBSITE_AGENT"],   // names only, never values
  "resources": ["local MongoDB :27017", "local Redis :6379"],
  "costs": false,                   // spends model or API credit when running
  "mcp": "off",                     // off | start — set only in the operator UI
  "source": "detected"              // detected | readme | ai-draft | curated
}
```

Kinds decide what psm will do with a unit:

| Kind | Examples | psm behavior |
| --- | --- | --- |
| `service` | server `dev`, client `dev`, feedback-hub `start` | Long-running. Start/stop/restart; ready check; port reserved. |
| `agent` | `website-agent`, `worker`, `cluster` | Long-running, often `costs: true`. Same controls as a service; MCP start needs `mcp: start` and, when it costs, the budget below. |
| `task` | `build`, `test`, `lint`, `typecheck`, `check:*`, `next-week:dry` | Runs to completion; exit code is the result. |
| `data` | `bootstrap:*`, `repair:*`, `import:*`, `export:*`, `rotate:*`, `next-week`, `carry` | Changes data or state. Listed in the rundown, never startable here; it goes through the Data card (Preview, then Apply) or stays a manual command. |
| `mcp` | `mcp` scripts | An MCP server another client launches. Listed and linked to the capability catalog; not run as a process. |
| `install`, `deploy` | `dev-install`, `build:prod`, `start:prod` | Listed with a pointer to the setup and deploy flows; not startable from the runbook. |

`concurrently` scripts (werewolf-dapp `dev`, `test:all`) are not units. They are
recorded as **composites** of the units they start, so the rundown can say
"`npm run dev` = server + client" while psm runs each part separately.

### Stack

A **stack** is a named set of units, possibly across projects, started together:

```jsonc
{ "id": "todo-work", "title": "Todo work",
  "units": ["werewolf-dapp:server", "todo-app:client"] }
{ "id": "feedback-loop", "title": "Feedback loop",
  "units": ["werewolf-dapp:server", "werewolf-dapp:client", "todo-app:client",
            "feedback-hub:server", "werewolf-dapp:website-agent"] }
```

Starting a stack resolves `dependsOn`, starts in dependency order, waits for each
unit's ready check, and starts a shared unit **once**: if `werewolf-dapp:server` is
already running, todo-app reuses it. Stopping a stack stops only the units nothing
else running still needs. Stacks are psm-local operator state (they name this
machine's projects), stored in psm's database, not in a repository.

### Where the rundown comes from

The rundown merges four sources; a higher source wins field by field and the
brief shows where each text came from:

1. **Curated** — `.psm/runbook.json` in the project, committed next to
   `identity.json` and `profile.json`. It travels with the repository, so a clone
   on another machine gets the same descriptions. Edited from the brief.
2. **Repository text** — a README "Scripts" section (werewolf-dapp has one), the
   header comment of the script file (`website-agent.js` documents its modes and
   guards), `.env.example` comments next to a variable.
3. **AI draft** — on request, a model reads the scripts, script files and README
   and drafts `summary`, `whenToUse`, `kind`, `dependsOn` and `costs`. Shown as a
   draft; the operator accepts it into `runbook.json` or edits it. Never applied
   silently. Repository text is input, not instructions (the draft prompt says so,
   and its output is validated against the schema).
4. **Detection** — package scripts of the root and every nested package (folders
   with a `package.json`, `node_modules` excluded), `cd X && npm run Y` delegation
   followed to the real unit, `concurrently` parsed into composites, kinds from
   name and command (`nodemon`, `vite`, `--watch`, `serve` → service; `bootstrap:`
   → data), ports from `PORT ||` defaults and Vite config, env names from
   `.env.example`. Also `Procfile`, `docker-compose.yml` services, `Makefile`
   targets, `Cargo.toml`/`go.mod` as today.

Resources come from the Resources panel's "Used by" mapping, which already links
`werewolf-dapp/server MONGODB_URI` to local MongoDB :27017.

## Starting and stopping

- Each unit runs as its own `procs.ts` process with kind `unit:<id>`, its own log
  and its own ready state. The project's `run` becomes "the project's default
  units" (werewolf-dapp: server + client), so the existing Run button still works.
- Before start: the unit's port is free (otherwise report who holds it, psm or an
  unknown process); `PORT` is removed from the inherited environment and set to
  the unit's port, so an exported `PORT` cannot leak into siblings.
- After start: ready is the port accepting connections or the log pattern, with a
  timeout; a unit that exits before ready reports its last log lines in the
  cockpit (not over MCP, see below).
- todo-app's two werewolf-dapp custom commands are replaced by
  `todo-app:client dependsOn werewolf-dapp:server`. psm offers the migration; it
  does not delete custom commands on its own.

## MCP surface

Read tools can ship in the current read-only tier (like `list_processes`). Write
tools wait for P02a.2.

| Tool | Returns / does |
| --- | --- |
| `get_runbook(project_id)` | Units with title, kind, folder, script name, summary, when to use, port, dependencies, env **names**, resources and their access level, costs, `mcp` setting, current status. Summary and when-to-use are under `untrusted` (they can come from repository text). No raw command for `command` units or custom commands, since those can carry credentials. |
| `list_stacks()` | Stacks, their units and which are running. |
| `start_units({ units } \| { stack })` | **R6.** Starts the resolved set in order. Returns per unit `running`, `ready`, `reused`, `denied` (with reason) or `failed` (exit code, no log). Idempotent: an already-running unit is `reused`. |
| `stop_units({ units } \| { stack })`, `restart_unit` | **R6.** Stops only psm-started processes; a unit another running unit needs is kept unless `force` is passed and the dependent is stopped too. |

Authority for `start_units`:

- The MCP client's project scope must include **every** project in the resolved
  set, including dependencies.
- Only units of kind `service`, `agent` or `task` whose `mcp` is `start`. The
  operator sets that per unit in the brief; an MCP tool, a model or
  `runbook.json` from a pull cannot set it (it lives in psm's database, keyed by
  project id and unit id, and is cleared when the unit's script text changes).
  This is the "operator-created standing grant" the MCP plan allows.
- Every resource the unit uses must be at **Full** for this machine. A unit that
  uses a resource at None or Read is refused with the resource named.
- `costs: true` units count against the client's job budget (MCP plan
  [Budgets](psm-mcp-operations.md#budgets-and-untrusted-tool-output)) and are
  listed in the operator's activity.
- `data`, `install`, `deploy`, `mcp` kinds are never startable over MCP.
- Logs stay out, as `MCP_UNAVAILABLE` already says.

## Phases

| Step | Deliverable | Acceptance |
| --- | --- | --- |
| R1 | Detection: nested packages, delegation, composites, kinds, ports, env names; `Runbook` type in `src/types.ts`; `scan.ts` returns units next to `runCommand`. | Fixture tests shaped like werewolf-dapp, todo-app and feedback-hub produce the tables above; `bootstrap:*`/`rotate:*` come out as `data`; `npm run dev` comes out as a composite of server + client. |
| R2 | Rundown in the brief: a "Scripts" section grouped by kind, with source badges; `.psm/runbook.json` read/write; README and header-comment extraction. | The three projects show a correct rundown with no AI; editing a description writes `runbook.json` only. |
| R3 | AI draft of descriptions, accept/edit/discard. | Drafts for the three projects are reviewed by the operator; nothing reaches `runbook.json` without acceptance; a README line saying "ignore your instructions" ends up as text in a draft, not as behavior. |
| R4 | Units as processes: `unit:<id>` kind, per-unit start/stop/restart in the cockpit, ready checks, port check, `PORT` handling, dependencies; Run = default units; todo-app custom command migration offered. | werewolf-dapp server and client start, log and stop separately; starting todo-app reuses a running server; a held port is reported, not retried; an exported `PORT` no longer leaks. |
| R5 | Stacks: create/edit in the cockpit, start/stop with reuse and dependency-aware stop. MCP read tools `get_runbook`, `list_stacks`. | The two example stacks start and stop correctly from the cockpit; Claude Code reads the rundown and explains when to use each werewolf-dapp script. |
| R6 | **After P02a.2.** MCP `start_units`, `stop_units`, `restart_unit`; per-unit `mcp: start` toggle; resource-level and scope checks; budget for `costs` units. | The end scenario below, plus refusals: a unit without `mcp: start`, a `data` script, a project outside the client's scope, a resource at None, a unit whose script changed after it was allowed. |
| R7 | Stacks may include AI agents on a project once MCP-2 serves `start_plan`/`start_implementation`. | Defined when MCP-2 lands. |

## End scenario (R6 acceptance)

From Claude Code, connected to the running psm with a client scoped to
werewolf-dapp, todo-app and feedback-hub:

1. "What can I run in werewolf-dapp, and what do I need for Todo work?" — the
   answer comes from `get_runbook` and names server + client, the website agent
   and its guard, and that `bootstrap:todo` is a data script for the Data card.
2. "Start the werewolf-dapp server and the todo-app client." — `start_units`
   starts the server, waits for 3001, starts the client on 5200; both show as
   running in the cockpit.
3. "Also start feedback-hub and the website agent." — the server is `reused`,
   feedback-hub starts on 4400, the website agent starts only if it was allowed
   and its resources are Full; otherwise the reply names the reason.
4. "Stop everything except the server." — the clients and agent stop, the server
   stays.

Record versions and results in the [evidence register](acceptance-evidence.md).

## Open decisions

1. **"todo-app agent", "feedback-hub agent":** script processes in those repos
   (none exist today besides feedback-hub's `cluster`), or AI sessions working on
   those projects (MCP-2)? The plan supports both; the answer decides whether R7
   moves earlier.
2. **Redis at None:** werewolf-dapp/server's `REDIS_URL` (local Redis :6379) is
   "not set (None)" in the Resources table, while MongoDB :27017 is Full. Under
   the rule above, MCP could not start the server until Redis is set to Full (or
   the server is recorded as not using it). Set :6379 to Full, or treat a
   dependency the server only connects to as allowed?
3. **Per-call review or standing allow** for MCP starts of dev services: the plan
   uses the per-unit `mcp: start` allow, no review each time. Agents with
   `costs: true` could still ask each time.
4. **Where curated text lives:** committed `.psm/runbook.json` (proposed; shared
   across machines and clones) or psm-local `overrides.json` (private, not in the
   repo).
