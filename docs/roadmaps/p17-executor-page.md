# P17 — Executor page: give PSM tasks the same flow Todo has

Status: **P17a–c built 2026-11-10, not committed, not deployed; P17d pending.**

What was built, and where it differs from the plan below:

- P17a is in werewolf-dapp (`models/PsmIntake.js`, `services/psmIntake.js`,
  `controllers/psmHubController.js`, `routes/api/v1/psmHub.js`), with tests in
  `test/integration/psmHub.test.js`. The key has its own unique index, scoped
  by owner (`one_intake_per_source_key`). The existing test "the browser cannot
  create intake directly" changed: `POST /psm/intake` used to be `404` and is
  now `400` without an executor header and a PSM source key.
- P17b is `src/server/executor/intake-routes.ts` with its own test file. PSM had
  no executor route tests to extend, because `index.ts` is not importable in a
  test. The hub key is `pst_` + the first 24 hex of sha256(executor id, nonce),
  so no state is kept. `source` was already on the queue rows.
- P17c: the page keeps the Queue's one-column sections rather than the
  list-and-detail sketch, with the composer above them. It has the project
  filter but no status filter. `intakeEvents.publish` is called for PSM intake
  but delivers nothing, because the event is keyed by a Todo item.
- P17d needs the hub change deployed (or a local dapp) and psm restarted.

## What the user asked for (2026-11-10)

`@project` tagging in Todo works end to end (Todo note → hub intake → executor
triage → Go → job → review). Two asks:

1. Let PSM start the same flow itself, without going through Todo: write a task
   for a project in PSM, and the PSM executor triages it, runs it on Go, and
   brings it back for review.
2. Give the executor its own **header button that opens a full page**, in place
   of today's modal (Running → Activity).

The feedback-hub widget in todo-app (P16 F2) comes after this.

## What already exists (checked 2026-11-10)

| Piece | Where | State |
| --- | --- | --- |
| Intake model with `source: 'todo' \| 'manual'` | werewolf-dapp `models/PsmIntake.js` | `manual` is declared but **nothing creates it** |
| Triage claim | dapp `services/psmIntake.js` `claimNext` | Claims any `new` intake for the owner. It does not check `source`, so PSM-made intake gets triaged with no changes. |
| Hub routes for the executor | dapp `routes/api/v1/psmHub.js` | Has projects, intake list, jobs, Go, accept/reject/revise, cancel, claim/heartbeat/result. **No route to create, edit or withdraw an intake.** |
| Planned `POST /api/v1/psm/intake` | [P16 F3](p16-feedback-intake.md) | Planned for the feedback bridge, idempotent on `sourceRef`. P17 builds it first, and P16 reuses it. |
| Go, diff, Accept, Reject, Revise, Cancel in PSM | psm `src/server/index.ts` `/api/executor/*`, `web/executor.js` | Already work, inside the modal's Queue tab |
| Activity (prompt, answer, verdict, job log) | `web/executor.js`, `/api/executor/activity*` | Already works, inside the modal |
| Executor on/off switch | Running dialog, `renderExecutorSwitch` in `web/app.js` | Works |
| Hash routes | `web/app.js`: `#/`, `#/p/<id>/<pane>`, `#/w/<id>/<pane>` | Adding `#/executor` fits the same router |

So P17 is mostly a hub endpoint, a PSM composer, and moving the existing UI
from a modal onto its own page. Triage, jobs, stop rules and review don't
change.

## P17a — Hub: create, edit and withdraw intake (werewolf-dapp)

- `PsmIntake.source` gains `psm`. `sourceRef.kind` gains `psm`, with
  `sourceRef.key` (a string the client generates, `pst_<24 hex>`), because
  `sourceRef.id` is an ObjectId tied to Todo documents. The unique index
  gains the `key` case.
- `POST /api/v1/psm/intake` (executor auth, like `/jobs`). Body
  `{ projectId, text, sourceRef: { kind: 'psm', key } }`.
  - `projectId` must be a non-archived `PsmProject` of the caller. Otherwise
    the hub returns `404`, so one owner can't probe another's ids.
  - Idempotent on `sourceRef`: a retry returns the same intake (`200`, not a
    second `201`).
  - `text` is 1–20000 characters, trimmed.
- `PATCH /api/v1/psm/intake/:intakeId` `{ text?, projectId? }` follows Todo's
  rule: a change resets the intake to `new` and clears the verdict. It is
  refused while a job is `queued | claimed | review` for that intake.
- `DELETE /api/v1/psm/intake/:intakeId` sets the intake to `withdrawn`
  (reuses `withdraw`). It is refused while a job is active; cancel the job
  first.
- Only `source: 'psm'` intake can be edited or withdrawn through these routes.
  Todo intake stays owned by Todo.
- `intakeEvents.publish` fires as it does for Todo, so the hub's live
  stream stays correct.
- Tests (in `test/integration/psmHub.test.js`): create, idempotent retry,
  another owner's project id, archived project, edit resets the verdict,
  withdraw, edit/withdraw refused during a job, Todo intake refused.

**P16 reuse:** the feedback bridge later posts
`{ sourceRef: { kind: 'feedback', key: '<hub>:<feedbackId>' } }` to the same
route.

## P17b — PSM server

- Hub client (`src/server/executor/client.ts`): `createIntake`, `updateIntake`,
  `withdrawIntake`.
- `POST /api/executor/intake`, `PATCH /api/executor/intake/:id` and
  `DELETE /api/executor/intake/:id` on the `local` router. They need
  `localRequest` and a signed-in user (the same guard as `jobRoute`).
  - The project must be a scanned project with a `prj_` id. A project without
    `.psm/identity.json` gets a clear error, not a hub call.
  - The server generates the `sourceRef.key`, so a double-click retry from
    the browser stays idempotent: the page sends a client nonce, and the
    server maps it to the key.
- `/api/executor/queue` already merges project names. Add `source` to each row,
  so the page can show "from Todo" or "from PSM".
- Tests in the existing executor route tests: wrong origin is 403, signed out
  is 401, unknown project, a project with no id, success passes through to the
  hub.

## P17c — The Executor page (PSM web)

**Header.** A new `⚙ Executor` button in `.topbar .actions`, next to
Running. It shows a count badge for jobs waiting for review (`review`) plus
stalled jobs, the same way Questions shows its count. It navigates to
`#/executor`.

**Route.** `#/executor` (optional `?project=<prj_id>`) is handled by the same
router as `#/p/…`. The board and workspace hide. The back button and
`#/` return home.

**Layout.**

```text
┌ Executor ───────────────── [On ▾]  connected · last claim 12s ago ┐
│ [Queue] [Activity]                  project: [All ▾]  status: [▾] │
├───────────────────────────────┬───────────────────────────────────┤
│ New task                      │  selected item                    │
│ [@project ▾] [text……………]  Add │  text · verdict · reasons         │
│                               │  Go (engine/model)  · Edit · ✕    │
│ Needs review (2)              │  — job —                          │
│  • todo-app  EmptyWeek…  ●    │  step / progress                  │
│ Running (1)                   │  diff · tests · preview           │
│ Triaged (3)                   │  Accept · Reject · Revise [comment]│
│ Triaging / new (1)            │                                   │
│ Done / stalled / withdrawn    │                                   │
└───────────────────────────────┴───────────────────────────────────┘
```

- **Composer.** Pick the project from a list or type `@` with autocomplete.
  Both use the local project list filtered to projects with a `prj_` id. The
  `@token` is removed from the saved text, as Todo does. Enter adds the task.
  New rows appear at once as "new", then move to triaging… → verdict through
  polling.
- **Queue and detail.** The Queue tab and job review in `web/executor.js`
  move here unchanged. `PsmExecutor.open(ctx)` already takes its elements
  from the caller, so the page passes page containers instead of modal ones.
  Edit and Withdraw show only on `source: psm` rows.
- **Activity** is the second tab, the same module.
- **Status strip.** The executor switch and status (`executorNote`) appear
  here too. The Running dialog keeps its switch row, and its Activity button
  now goes to `#/executor`.
- **Live updates.** Keep polling (the modal already does), at 3 s while the
  page is visible and stopped when it is hidden. SSE from the hub is not
  needed for one local page.
- **Remove the modal** (`#executor-modal`, `openExecutorActivity`) once the page
  is in. The page is its only home.
- **Stream privacy.** Task text, diffs and logs keep `data-stream-private`.
- Tests: `src/web-assets.test.ts` checks the header button, the route and that
  the modal is gone.

## P17d — Prove it (doubles as Gate 0's G0.3–G0.4)

Using the same throwaway stack as P16 G0.1:
1. In PSM: `@todo-app` "Fix: the first task of a new week can't be tagged
   (EmptyWeek.tsx uses a plain input)". It triages to `fits`.
2. Press Go, pick the engine. The job clones, makes the change, passes tests
   and `preview_check`, and ends in `review`. The badge in the header counts it.
3. Accept merges `--no-ff` into todo-app master. Also run one Reject and one
   Revise.
4. Edit a triaged PSM task: it goes back to triage. Withdraw one.
5. Record `docs/evidence/p17-executor-page-<date>.json` and a row in
   [acceptance-evidence.md](acceptance-evidence.md).

After that, the next PSM task is P16 F2 (the widget embed), written with the
widget contract in its text, because a job sees only its own project (the
P16 lesson).

## Order

P17a → P17b → P17c → P17d. P17a and P17b can be reviewed together. P17c can
start against a stubbed `/api/executor/intake`.

## Open questions

- Should PSM-made tasks also appear in Todo, for example in an "Inbox" list?
  The plan says no: they have no Todo note, and the hub summary for Todo is
  keyed by note.
- Should the page show other executors' claims (another machine that is
  paired), or only this machine's? Today `mine` is already in the queue rows.
  The plan shows all, marking the ones this machine holds.
