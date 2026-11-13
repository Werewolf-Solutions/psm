# P14 hub contract (B0–B3, C1, D)

Written 2026-10-15 so the dapp hub, the Todo client and the PSM executor can be
built in parallel. Plan: [ecosystem-intake-and-agent-jobs.md](ecosystem-intake-and-agent-jobs.md).
Change this file first if the contract has to change.

**2026-11-12:** psm now also implements this contract itself, in its own database
(`src/server/executor/local-hub.ts`), and uses that by default. The hub described
here is used when psm runs with `PSM_HUB=werewolf`. The rules below apply to both.

All responses use dapp's envelope: `{ success: true, data }` or
`{ success: false, code?, message }`.

## B0 — Platform apps vs business apps (werewolf-dapp)

`CloudApplication.owner = { kind: "platform" }` or
`{ kind: "business", business: ObjectId }`.

- Migration: an existing row becomes `business` (keeping its `business`).
  `psm`, `psm-web`, `todo` and the portal become `platform`.
- Bootstrap scripts register platform rows with no business required:
  `bootstrap-todo.js`, `bootstrap-psm.js` and `preview-seed.js` keep working.
- Catalog, billing and entitlement code branch on `owner.kind`, never on the
  app key.
- Hub routes below require the calling app to be `platform`.

## B1 — Project registry

`PsmProject { owner: User, projectId: "prj_…", name, displayName, archived: bool, lastSeenAt, sources: [executorId] }`.
Unique on `(owner, projectId)`.

- `PUT /api/v1/psm/projects`. PSM session (`protectPsm`) plus the
  `X-PSM-Executor` header (see B3), which identifies the publishing machine.
  Body `{ projects: [{ projectId, name, displayName?, archived? }] }`, at most
  500.
  - Upserts the listed projects and adds this executorId to their `sources`.
  - **Revised 2026-10-15:** a project of this owner that is not listed loses
    this executorId from `sources`. Only a project left with **no** sources is
    marked `archived: true`, never deleted. Each machine (desktop, VPS) sees
    only its own folders, so one machine's list must never archive another's
    projects.
  - Returns `{ count, archived }`.
- `GET /api/v1/apps/todo/projects?q=&limit=8`. Todo session. Returns
  `{ projects: [{ projectId, name, displayName }] }`, not archived.
  - Ranking: name prefix, then displayName prefix, then substring
    (case-insensitive), then name.
  - With an empty `q`: everything, sorted by name, up to `limit` (max 50).

## B2 — Intake

`TodoTask.projectId` and `TodoNote.projectId`: `"prj_…"` or `null`, stored
**alongside** the existing plain-string `project` (the name), which stays.

`PsmIntake`:

```text
{ intakeId: "int_<24 hex>", owner, projectId, source: "todo" | "manual",
  sourceRef: { kind: "task" | "note", id }, text,
  status: "new" | "claimed" | "triaged" | "failed" | "withdrawn",
  claim: { executorId, leaseUntil } | null, attempts: number,
  verdict: Verdict | null, error: string | null, createdAt, updatedAt }
```

Rules (all server-side; the browser never creates an intake directly):

- Saving a task or note with a `projectId` creates one intake for it, or reuses
  the existing intake for the same `sourceRef`.
- Changing its text or `projectId` resets the intake to `new` (verdict cleared,
  attempts 0).
- Clearing `projectId` or deleting the task/note sets `withdrawn`.
- Task and note JSON returned to Todo gain
  `intake: { intakeId, status, verdict } | null`.

Live changes: `GET /api/v1/apps/todo/events` (Todo session, `todo:read`, platform
app) is a Server-Sent Events stream of the caller's own intake changes. Every
transition above, plus claim and result (B3), sends

```text
event: intake
data: { "kind": "task" | "note", "itemId": "<task or note id>", "intake": { intakeId, status, verdict } | null }
```

(`null` once withdrawn). The stream opens with `event: ready`, sends a
`: keep-alive` comment every 25 s and `X-Accel-Buffering: no` for nginx. Events
reach every dapp instance through the Redis channel `psm:intake-events` when
`REDIS_URL` is set. Delivery is best effort: a client that reconnects refetches
rather than expecting a replay.

## B3 — Executor queue

PSM session plus a header `X-PSM-Executor: <executorId>` (`[a-z0-9-]{1,64}`).

- `POST /api/v1/psm/executor/claim`. Body `{ kinds: ["triage"] }`.
  - Long-polls for at most 25 s.
  - Returns `204` with no job, or `200 { job: { jobId: intakeId, kind: "triage", intakeId, projectId, projectName, text, attempt, leaseUntil } }`.
  - Atomic: one intake is never claimed twice.
  - Lease is 120 s. An expired lease returns the job to `new`.
- `POST /api/v1/psm/executor/jobs/:jobId/heartbeat` returns `{ leaseUntil }`.
  Returns `409` if the job is no longer claimed by this executor.
- `POST /api/v1/psm/executor/jobs/:jobId/result`. Body is either
  `{ status: "triaged", verdict }` or `{ status: "failed", error }`.
  - `failed` with `attempts < 2` goes back to `new` (one retry).
  - Otherwise it stays `failed`.
  - Returns `409` if not held.
- `GET /api/v1/psm/intake?status=&projectId=` lists the owner's intake for the
  hosted page. Returns `{ intake: [PsmIntake] }`, at most 200, newest first.
- Tasks written in PSM itself (P17), all with `X-PSM-Executor`:
  - `POST /api/v1/psm/intake`. Body
    `{ projectId, text, sourceRef: { kind: "psm", key: "pst_<24 hex>" } }`.
    `201` with `{ intake, created: true }`; a retry with the same key is `200`
    with the same intake, unchanged. `text` is 1–20000 characters, trimmed.
    A project that is unknown, archived or another owner's is the same `404`
    (`project_not_found`).
  - `PATCH /api/v1/psm/intake/:intakeId`. Body `{ text?, projectId? }`. A real
    change resets the intake to `new` and clears the verdict.
  - `DELETE /api/v1/psm/intake/:intakeId` sets it to `withdrawn`.
  - Edit and withdraw are `409` (`job_active`) while the intake's job is
    `queued`, `claimed` or `review`, and `403` (`not_psm_intake`) for Todo
    intake, which only Todo changes.
  - Such an intake lists with `source: "psm"` and
    `sourceRef: { kind: "psm", key }`.

## C2 — Questions (added 2026-11-10)

`GET /api/v1/apps/todo/questions` (Todo session, `todo:read`) and
`GET /api/v1/psm/questions` (PSM session), both platform apps; per user like
`/projects` and `/events`. Returns `{ questions: [...] }`, newest first,
at most 100: the caller's intake with `status: "triaged"` and
`verdict.verdict: "needs_decision"`, minus any whose latest job is `queued`,
`claimed` or `review` (Go was the decision). Each row:

```text
{ intakeId, kind: "task" | "note" | "psm", itemId | null, projectId, project | null,
  text, workspace: "personal" | "business:<id>" | null, date: "YYYY-MM-DD" | null,
  questions: [string], rationale, size, updatedAt }
```

A task or note deleted without a withdraw is left out. Todo shows the count in
its header, refetches on every `event: intake`, and answers by appending the
answer to the item's text (task) or body (note) in that item's workspace. That
edit resets the intake to `new` (B2), so the executor triages it again with the
answer in it. `psm`-kind rows are answered in PSM, whose Questions panel shows
the same list beside session questions (one count), links Todo rows to Todo, and
offers Go for both; MCP clients read it with `list_questions`.

## D — Verdict (validated on both sides; invalid = failed run)

```json
{ "verdict": "fits | doesnt_fit | needs_decision",
  "size": "S | M | L | XL",
  "dependsOn": ["string"], "conflictsWith": ["string"],
  "queue": { "after": ["string"], "note": "string" },
  "questions": ["string"],
  "rationale": "string (<= 2000 chars)" }
```

Rules:
- `questions` is required and non-empty only when the verdict is
  `needs_decision`.
- No calendar dates anywhere in a verdict.
- Each list holds at most 10 entries, each at most 200 characters.

## E — Implement jobs (Go → branch → review)

`PsmJob`:

```text
{ jobId: "job_<24 hex>", owner, intakeId, projectId, kind: "implement",
  status: "queued" | "claimed" | "review" | "accepted" | "rejected" | "stalled" | "failed" | "cancelled",
  claim: { executorId, leaseUntil } | null, attempts, pinnedExecutor: string | null,
  selection: { mode: "auto" } | { mode: "manual", engine: "claude" | "codex", model: string | null, effort: string | null },
  revisions: [{ comment, at }], result: ImplementResult | null, error, createdAt, updatedAt }
```

- **Go** (`POST /api/v1/apps/todo/intake/:intakeId/go`, Todo `todo:write`; or
  `POST /api/v1/psm/jobs { intakeId, selection }`, executor) queues a job for a `triaged`
  intake whose verdict is `fits` or `needs_decision`. One active
  (`queued | claimed | review`) job per intake. Go is the owner's approval for
  that one job.
- **Repo lock.** A unique partial index on `{ owner, projectId }` where
  `status: "claimed"`: at most one running implement job per project, enforced
  by the database. A claim that hits it moves on to the next project.
- **Claim** with `kinds: ["implement"]` (triage is claimed first when both are
  asked for). Oldest `queued` first; a job pinned to another executor is
  skipped. Payload: `jobId, kind, intakeId, projectId, projectName, text,
  verdict, selection, revisions, attempt, continueClone, leaseUntil`. Same 120 s lease and
  heartbeat routes as triage (`job_` ids are dispatched to jobs). An expired
  lease re-queues; after 2 attempts the job is `stalled`.
- **Result** (`POST /psm/executor/jobs/job_…/result`):
  `{ status: "review", result: { branch: "psm/job/<jobId>", baseCommit, headCommit,
  commits: [{ sha, subject }], diffStat: { files, insertions, deletions },
  checks: [{ name, ok }], model: { engine, model, effort, reason }, summary } }`, or `{ status: "stalled" | "failed", error }`.
  `failed` retries once on the same executor. The job is then pinned to that
  executor: the branch lives only in its clone and is never pushed (D4).
- **Review**, reported by the pinned executor: `POST /psm/jobs/:jobId/accept`,
  `/reject`, `/revise { comment }` (re-queues on the same executor, which
  continues in the same clone). `POST /psm/jobs/:jobId/cancel` and
  `/apps/todo/jobs/:jobId/cancel` cancel a queued, stalled or failed job.
  `GET /psm/jobs` lists the owner's jobs.
- Todo's intake summary gains `job: { jobId, status, branch, summary, error } | null`,
  and job changes go out on the live intake stream.
