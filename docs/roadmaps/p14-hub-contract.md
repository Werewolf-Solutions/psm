# P14 hub contract (B0–B3, C1, D)

Written 2026-10-15 so the dapp hub, the Todo client and the PSM executor can be
built in parallel. Plan: [ecosystem-intake-and-agent-jobs.md](ecosystem-intake-and-agent-jobs.md).
Change this file first if the contract has to change.

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
