# P15 — DSH-style ticket model for PSM jobs

Status: **pending**. Planned 2026-11-09; no code changed yet. This plan extends
[P14 ecosystem intake and agent jobs](ecosystem-intake-and-agent-jobs.md). It does
not change P14's decisions or the priority of the [delivery index](README.md).

Background: [DSH Super-agent compared with our projects](../research/dsh-superagent-comparison.md).
That study found that PSM's hub + executor already follow DSH's ticket flow
(Todo note → triage → **Go** → isolated job → review). DSH's design covers several
things PSM's flow does not have yet. This plan adds them in order of value.

## Outcome

PSM is the one place where work for any project arrives, gets a decision, runs in
isolation and comes back for review, while taking as little of the operator's
attention as possible:

- Work can come from Todo, GitHub and Telegram, not only Todo.
- A comment on a running or reviewed job reaches that job. It does not start a new
  triage.
- Every job shows one clear state, and the operator sees first what waits for them.
- Work nobody asked for is first only recorded (`observe`), and is accepted
  automatically only after the operator turns that on.
- psm's MCP server gives an up-to-date rundown of every project.

## Starting point (checked 2026-11-09)

| Area | Today | Where |
| --- | --- | --- |
| Intake | Todo notes only; one-shot triage verdict (`fits`, `needs_decision`, …) | werewolf-dapp `server/services/psmJobs.js`, psm `src/server/triage/` |
| Jobs | `queued → claimed → review → accepted / rejected`, plus `stalled`, `failed`, `cancelled`; leases with one silent re-queue, then `stalled` | `psmJobs.js` |
| Revise | Pushes a comment into `revisions` and re-queues the job | `psmJobs.js` |
| Execution | Clone in `.psm-jobs/<project>/<jobId>`, Docker `sandbox_shell` with no network, stop rules, review with Accept / Reject / Revise | psm `src/server/executor/` |
| Questions | A pending-questions inbox exists for work sessions | psm `src/server/questions-inbox.ts`, `GET` in `src/server/index.ts` |
| MCP | Read-only `/mcp`: `list_projects`, `get_project`, `get_access_status`, `list_plans`, `get_plan`; acceptance waits for P02a.2 | psm `src/server/mcp/`, [MCP plan](psm-mcp-operations.md) |
| Remote workers | ai-mesh farm runs offline test/build routines; coding agents (F03–F07) planned | ai-mesh `docs/coding-farm-plan.md`, [ai-mesh provider](ai-mesh-provider.md) |

## Phases

Each phase records implemented / tested / committed / accepted separately in the
[evidence register](acceptance-evidence.md), as the delivery index requires.

### P15a — Fixed report states and a "needs a person" view

DSH idea: workers end each turn with one fixed state, and questions go through one
structured field.

- Add a structured report from the implement agent: `progress`, `waiting`,
  `ready`, `blocked`, `failed`, `dropped`, with an optional single `question`.
- Map reports onto the hub's job statuses. `ready` → `review`. A `question` puts
  the job in a new `needs_answer` status, which shows in the existing questions
  inbox. `dropped` (nothing to do) ends the job without a review.
- Group the Queue tab and Todo's job panel by who the job waits for:
  **needs you** (answer, review, blocked, failed) first, then working, then queued.
  A healthy state takes no extra space.
- Acceptance: one job asks a question and continues after the answer; one ends
  `dropped`; counts on the panel equal the lists they link to.

### P15b — Follow-ups go to the job

DSH idea: a Ticket subscribes to its threads, and later messages there reach its
worker without a new decision.

- Give each job the threads it follows: its Todo note, and later its GitHub issue
  or PR (P15d).
- A new comment on a followed thread while the job is `claimed`, `needs_answer`
  or `review` is delivered to the job as input instead of starting a triage. In
  `review`, this replaces typing into Revise.
- The agent can hand a comment back when it asks for work outside the job; only
  then does it go to triage.
- A person's comment on an `accepted` or `rejected` job reopens it under the same
  grant. Bot and CI messages never reopen a job.
- Acceptance: a comment on a running job changes its result without a new triage;
  an off-topic comment is handed back and triaged once.

### P15c — Save the action before doing it

DSH idea: every side effect is stored first and carried out after, so a restart
neither loses nor repeats work.

- Audit the executor and hub for actions done before they are recorded: posting a
  verdict or result, merging on Accept, publishing, sending messages.
- Move each one behind a stored, idempotent entry that a restart picks up.
- Acceptance: kill the executor during each of these actions; after restart each
  happens exactly once or is shown as uncertain. Do not claim exactly-once for
  external effects.

### P15d — More sources: GitHub and Telegram

DSH idea: a Source turns its own events into triggers, keeps its own read position
and allowed list, and replies on the same conversation.

- Define a small source interface in the hub: read new events, map them to threads,
  check the sender against that source's allowed list, and reply on the thread.
- **GitHub:** issues and PR comments that mention the agent account, from listed
  accounts, on repositories that have a `prj_` id.
- **Telegram:** reuse aurora's bridge or move it into psm (open decision below).
- Every source writes into the same intake, so triage and jobs do not change.
- Acceptance: a GitHub mention from a listed account produces one job, and its
  result is posted back on the same issue; an unlisted account produces nothing.

### P15e — `observe` mode for work nobody asked for

DSH idea: proactive rules run in `off`, `observe` or `auto`. `observe` records
what the agent would have done, without doing it.

- Add written rules for unrequested work (for example "triage every new GitHub
  issue"), each with a mode. Default `observe`.
- In `observe`, a positive triage is recorded as "would accept" and nothing is
  queued. Explicit requests from listed people work in every mode.
- The operator can review "would accept" records and switch a rule to `auto`.
- Acceptance: a week of `observe` records reviewed before any rule goes `auto`.

### P15f — psm's MCP as the project rundown

- Extend the read-only MCP with live per-project state: branch, uncommitted
  changes, ahead/behind, version from `package.json`, open jobs and next step.
- Give the remaining projects `prj_` ids (14 had one on 2026-10-22).
- Depends on MCP-1 acceptance, which waits for P02a.2.
- Acceptance: Claude Code asks "what's the state of all my projects" and gets an
  answer that matches the dashboard.

### P15g — A router that only routes (later)

DSH idea: one long-running main session decides where incoming work goes, never
waits, and never does technical work itself.

- Start only after P15a–P15d prove useful. psm's notes already ask for a
  "main psm agent that sees everything" with Telegram and voice notes; this is that
  agent, limited to routing, answering status questions and stopping jobs.
- Acceptance: defined when the phase starts.

### P15h — ai-mesh as a second executor (later)

- Keep the executor swappable: the hub hands a job to the local Docker executor or
  to an ai-mesh farm worker. Follows the [ai-mesh provider plan](ai-mesh-provider.md)
  and ai-mesh F03–F07.

## Out of scope

- wfq's CTO → team lead → dev hierarchy. DSH gets parallel work from many
  independent jobs, one review each. A hierarchy can come back later as a mode
  for very large tasks if needed.
- Daedalus. It is now an infrastructure platform; its alerts could become a
  source later.
- Running DSH itself. It is a plugin for DeepSeek Harness and does not run alone.

## Open decisions

| Decision | Gates |
| --- | --- |
| Which GitHub account the agent acts as, and which accounts may ask it for work | P15d |
| Telegram: reuse aurora's bridge or build it into psm | P15d |
| Whether a comment on an `accepted` job may reopen it, or must start a new job | P15b |
| Which model and budget a long-running router may use | P15g |

## Order

P15a → P15b → P15c can start now, in that order, in parallel with the P05/P07
release work. P15d needs P15b. P15e needs P15d. P15f needs MCP-1 acceptance.
P15g and P15h come after the rest.
