# P16 — Feedback Hub as an intake source (Todo first)

Status: **pending**. Planned 2026-11-09; no code changed yet. Gate 0 (below) is
the first work. This plan lifts decision D5 of
[P14](ecosystem-intake-and-agent-jobs.md), which deferred feedback-hub, and it
reuses two pieces of [P15](p15-dsh-ticket-model.md): the source interface (P15d)
and `observe` mode (P15e).

## What the user asked for (2026-11-09)

1. Embed the feedback-hub widget in todo-app. Feedback users send there reaches
   PSM and becomes implementable work in the existing queue: triage → **Go** →
   job → branch → review.
2. No new per-project agent processes. The P14 executor is the PSM agent, and
   "per project" means a per-project queue and repo lock, not a process per
   project.
3. A person processes **every** piece of feedback. While that happens, an agent
   is trained to make the same call (good/bad, why) by watching those
   decisions. It earns more autonomy only from its measured agreement.

## Decisions (2026-11-09)

- **F-D1. Local first.** feedback-hub runs on :4400 next to Todo dev on :5200.
  It moves later to the droplet the user has already created. **That move goes
  through PSM's MCP deploy flow** (`get_deployment_readiness` →
  `create_deployment_plan` → `request_deployment_approval`, approved in PSM; see
  [psm-mcp-operations.md](psm-mcp-operations.md)), not by hand. See F6.
- **F-D2. Registration is done by agents over MCP, not in the dashboard.** The
  PSM agent registers the app through feedback-hub's MCP, and todo-app's own
  implement job embeds the widget. Nobody copies a key by hand.
- **F-D3. Every feedback item gets a human decision.** Only accepted items become
  PSM intake. Raw feedback never reaches the queue on its own, because the
  ingest key is a public write credential.
- **F-D4. The reviewer agent starts in `observe`.** It records a prediction for
  every item. It does not act until the user switches it up a stage based on
  the agreement numbers (F4).
- **F-D5.** Implement jobs still stop at a local branch (P14 D4).

## Gate 0 — Prove the Todo path end to end first

Feedback becomes another source feeding the same queue, so the queue has to
work first. The 2026-10-15 run
([evidence](../evidence/p14-end-to-end-2026-10-15.json)) proved Todo tag →
triage verdict through the **API only**. These are still unproven:

- [ ] **G0.1 Stack.** Local dapp (with `bootstrap-todo.js` and
  `bootstrap-psm.js` as platform apps), Todo on `http://localhost:5200`, and PSM
  with the executor on (`npm run executor` or `PSM_EXECUTOR=1`, paired with
  "Continue with Werewolf"). Redis: local :6379 is **None** in the machine
  resource table. Either use throwaway `redis:7-alpine` and `mongo:7` containers
  as the 2026-10-15 run did, or the user grants access first.
- [ ] **G0.2 Real Todo UI.** In a real browser: type `@to`, pick todo-app, save.
  The badge goes triaging… → a verdict, live over `/apps/todo/events`.
- [ ] **G0.3 Go → implement.** Press Go and pick the engine. The job must:
  - run the baseline tests;
  - clone into `.psm-jobs/`, branch `psm/job/<id>`;
  - make the edit and pass the tests and `preview_check`;
  - show its current step on the note;
  - end in `review`.
- [ ] **G0.4 Review.** The diff, tests and preview are visible. **Accept** merges
  with `--no-ff` into todo-app's working branch (master). Also run one
  **Reject** and one **Revise** with a comment.
- [ ] **G0.5 Failure paths.**
  - Kill the executor mid-job: the lease expires, the job goes back to the
    queue, and no result is duplicated.
  - A job that makes no change stalls at the second iteration.
- [ ] **G0.6 Restart.** The executor survives a PSM restart without a hand-issued
  session (B4 device-token flow). If this is still open, fix it here.
- [ ] **G0.7 Evidence.** Record
  `docs/evidence/p14-implement-end-to-end-<date>.json` and a row in
  [acceptance-evidence.md](acceptance-evidence.md).

**Test task for G0.2–G0.4: F2 itself.** Tag `@todo-app` with "embed the
feedback-hub widget, env-gated" and let the queue build it. The component is
off without its env vars, so the job needs no running hub or network, and
Gate 0 delivers P16's first piece.

Known gap carried from P14: a stalled job does not yet create a
Questions-inbox entry.

**Progress 2026-11-09:**
- G0.1 done. Throwaway mongo:7 and redis:7 run in containers; werewolf-dapp
  started from an empty directory (`injecting env (0)`); the user's PSM
  executor is connected and published 12 projects.
- G0.2 passed in a real browser:
  - `@to` narrowed the popover to todo-app;
  - picking it created one intake (`int_a57e767b766ff437a22c5b55`), which the
    executor claimed within 1 s;
  - triage returned `fits` / S in about 5 s, and the badge changed live.
- **Bug found:** the first task of a week that doesn't exist yet goes through
  `todo-app/client/src/board/EmptyWeek.tsx:38`, a plain `<input>` with no
  `@project` support. The workaround is to add the task, then tag it in the
  edit field.
- G0.3, first attempt (`job_fd2f1389fc125cb3bdd50f8e`, codex, auto): **stalled
  after 23 s, correctly.**
  - The clone and the baseline tests (51 pass) worked.
  - The agent refused to invent the widget contract: the job only sees
    todo-app, and the contract lives in feedback-hub (F1).
  - The stall path worked: the reason was reported to the hub and shown in
    Todo with a cancel button. No Questions-inbox entry was created (the known
    gap).
- **Lesson for F2:** an implement job sees only its own project. A task that
  depends on another repo's contract must carry that contract in its text, or
  the job must get a cross-project `repo.read` grant (as in P14 A4).
- Proposed: prove Gate 0 with the self-contained `EmptyWeek.tsx` bug instead
  of F2.
- G0.3, second attempt (`job_f2e2c7ce3c61c66af3378903`, codex, EmptyWeek
  bug): **stalled with the change made but not committed.**
  - The agent edited 3 files. Tests (51) and the build passed.
  - `preview_check` refused to start: "werewolf-dapp is not in this task's
    scope". The agent correctly declined to commit unverified work.
  - **PSM bug:** a job's scope was only its own clone, so no Todo frontend job
    could ever pass the browser check.
  - **Fixed in psm:**
    - a job now gets the backend projects that the **committed** preview file
      at its starting commit declares (`declaredPreviewServices`, read from
      the real checkout, so an agent's edit cannot add one);
    - these come as read-only preview services
      (`previewServiceSnapshot` + `previewServiceChecker`: only `repo.read`
      and `script.run`, never tool targets).
  - 3 new tests; executor and agent suites 155 pass, 0 fail.
- G0.3, third attempt (`job_f64f3f8b23a719191939215a`): **werewolf-dapp now
  starts beside Todo** (`ready: true`), so the scope fix works.
  - The preview still failed: the agent served Todo on 5173.
    `preview_check` requires a port, and nothing said Todo must use 5200, the
    only origin its sign-in accepts. The refresh got 403.
  - **Fixed in psm:** the v2 preview file takes an optional
    `port`, and `preview_check` always uses it. Todo's
    `client/psm-preview.json` gets `"port": 5200`. That must be **committed**
    in todo-app, because jobs clone the committed state.

## F1 — Agent-driven registration (over MCP)

- feedback-hub `apps` gains `project_id` (`prj_…`, from the project's
  `.psm/identity.json`; todo-app is `prj_e4713173923933470bd3`). The MCP
  `register_app` and `list_apps` tools take and return it.
- In this flow, `register_app` must always be called with `allowed_origins`.
  Today, omitting them **allows every origin**. Add a `require_origins` guard,
  or refuse an empty list when the call comes from PSM.
- Todo origins: `http://localhost:5200` now, `https://todo.werewolf.solutions`
  at F6.
- The key goes into todo-app's gitignored `client/.env.local` as
  `VITE_FEEDBACK_HUB_URL` and `VITE_FEEDBACK_KEY`. For staging it is a build
  variable of the deploy, never committed.
- Registration is idempotent: re-running it for the same `project_id` returns
  the existing app (and key) instead of creating a second one.
- The README's note that `register_app` cannot set origins is stale. Fix it.

## F2 — The widget in todo-app

- `client/src/feedback/FeedbackWidget.tsx` adds the script tag only when both
  env vars are set, with `data-version` set from `__APP_VERSION__`.
- **Privacy.** Todos are private by default.
  - Put `data-fh-private` on task text, note bodies, the account footer and the
    project popover, so QA sessions do not record their labels.
  - The widget sends no input values, but it does record visible labels.
- **User reference.** feedback-hub stores `user_ref`, but the widget never
  sends it.
  - Add a `data-user-ref` attribute or a `window.FeedbackHub.identify()` call.
  - Todo passes the opaque Werewolf user id plus the workspace ref (`personal`
    or `business:<id>`). **Never the email.**
- Acceptance: with the env vars, a quick feedback and a QA session from Todo
  land in feedback-hub under the right app. Without them, the build has no
  widget.

## F3 — Human review of each item, then the bridge

**In feedback-hub.** Every new feedback item waits in a review queue. The
reviewer picks one decision:

| Decision | Effect |
| --- | --- |
| `accept` | Becomes PSM intake (one per item, or attached to an existing intake as more evidence) |
| `duplicate` | Linked to the earlier item or intake; no new intake |
| `reject` | With a reason: `spam`, `not_actionable`, `out_of_scope`, `unclear`, `abuse` |
| `needs_info` | Kept open; no intake |

Decisions are stored in a new `feedback_reviews` table:

```text
feedback_reviews { feedback_id, decision, reason, note, reviewer, decided_at,
                   intake_id?, prediction_id? }
```

Clusters and the roadmap keep working as views over accepted items.

**In werewolf-dapp:**
- `PsmIntake.source` gains `feedback`, and `sourceRef.kind` gains `feedback`,
  with `{ hub, feedbackId, appId }`.
- New `POST /api/v1/psm/intake` (PSM session + `X-PSM-Executor`), idempotent on
  `sourceRef`.
- The intake text is the feedback body and its URL, version and category, plus
  the QA session id when there is one.

**The bridge is the P15d source interface, run by the executor.** The executor
already holds the dapp session and runs on the same machine as feedback-hub.
It does three things:
- reads accepted items over feedback-hub's MCP;
- creates their intakes;
- writes `intake_id` back.

Triage and implement jobs do not change. The implement prompt points at
`get_qa_session` when there is evidence, so the agent can read the timeline
and transcript.

## F4 — The reviewer agent (`observe` → suggest → narrow auto)

**The job.** A new read-only executor job kind, `feedback-review`. It is
bounded, idle when the queue is empty, and counted in the triage pool. For
every new item it records:

```text
feedback_predictions { id, feedback_id, decision, reason, confidence,
                       model, prompt_version, created_at }
```

**Stages.** The user moves between them by hand.
1. **Observe** (default). The prediction is **hidden until the human
   decides**, so it cannot anchor the decision. The dashboard shows agreement
   afterwards.
2. **Suggest.** The prediction pre-fills the decision. The human still
   confirms every item.
3. **Narrow auto.** Auto-apply `reject: spam` and `duplicate` only, above a
   confidence threshold. A random sample of auto decisions still goes to the
   human for audit. **`accept` is never automatic.** Even after a human accept,
   implementation still needs Go.

**Measurement.**
- Agreement per decision and per reason.
- False-reject rate: items the human accepted but the agent would have
  rejected. This one matters most.
- Calibration of the confidence values.
- All of it shown per `prompt_version`.

**Training.**
- The human decisions are the labels. Disagreements, plus a stratified
  sample, become a graded regression fixture, as in P14 Phase D.
- A prompt or model change must not lower agreement on that fixture.
- There is no fine-tuning: "training" means prompt and examples, chosen
  from the labelled set.

**Moving up a stage is the user's call.** It is shown with numbers, for
example "N ≥ 200 decisions, false-reject ≤ 2 %". The thresholds are set when
there is data.

## F5 — Status back to feedback-hub

- The executor writes the verdict, job status and branch back to the feedback
  item and its roadmap item. `roadmap_items.pr_url` and `status` already exist.
- Optional later: tell the user who sent the feedback that it shipped
  (P15d "reply on the same thread").

## F6 — Move feedback-hub to the new droplet (later)

> **Reminder:** do this through **PSM's MCP deploy flow**, not by hand.

- **Plan, approval, rollback.** The deploy goes through a PSM deployment plan
  with approval and rollback. The SSH host must be enrolled in PSM's machines
  first (P04/V-keys).
- **Hostname.** Something like `feedback.werewolf.solutions` over HTTPS. HTTPS
  is required: Todo on `https://todo.werewolf.solutions` cannot load the widget
  from HTTP.
- **Storage.** `DB_PATH` and `ARTIFACTS_PATH` on persistent private storage
  with `0700`/`0600` permissions. SQLite and the artifacts are backed up
  together.
- **Memory.** Whisper transcription needs ffmpeg and memory. Size the droplet
  for it, or set `TRANSCRIPTION=off`.
- **Retention.** A retention and purge policy before real users' recordings
  arrive (the feedback-hub README lists this as missing).
- **Executor reach.** With the hub remote, the bridge's MCP has to reach it.
  Either the executor moves to that droplet too (P14 V), or the bridge uses
  feedback-hub's admin HTTP API with a scoped token instead of stdio MCP.
- **Origins.** Add `https://todo.werewolf.solutions` to the app's origins
  through F1.

## Order

1. Gate 0, using the F2 widget as its test task.
2. F1, then turn on the widget locally.
3. F3, the human queue and bridge, with F4 in observe from day one. Predictions
   need to be collecting while the human labels.
4. F5.
5. F6 on the new droplet via the MCP deploy flow.
6. Raise F4's stage only from the measured numbers.

## Proposed — a scope the result can be checked against

Not built, and not yet decided. Both points come from an earlier workflow
sketch (`docs/psm-agent-workflow.md`, removed 2026-11-10). They touch the triage
verdict and job review, so they would change the P14 contract, not only P16.

- **Acceptance criteria in the verdict.** Today a verdict has fit, size,
  rationale and questions, and nothing a finished job can be checked against.
  Triage would also propose a short list of acceptance criteria. Go approves
  them along with the task. At review, the job's diff and checks are compared
  with each criterion, so the human sees which ones are met before Accept.
- **A scope rule for Revise.** A fix inside the approved criteria continues on
  the same branch, as Revise does today. A comment that changes the agreed
  outcome is new scope: it goes back to triage and needs a new Go before any
  more work starts. Today Revise takes any comment and continues.

## Open questions

- Should a duplicate attach to an existing *intake* (more evidence for a running
  job) or only to the earlier feedback item? Proposed answer, from the same
  sketch: attach it to the intake. A second report of the same bug adds its
  evidence to the first and creates no new intake, so the job that is queued
  or running sees it.
- Who else may review feedback: only the owner, or business members of the
  workspace? This affects `reviewer` and dapp permissions.
