# P05 — managed Codex continuity

Implemented and locally verified on 2026-10-05 in PSM 0.3.27. This closes the
managed Codex continuity slice; browser tooling, private dependencies and hosted
execution remain separate P05 gates.

## Behavior

Sequential project/workroom turns resume a **PSM-managed** Codex thread when the
engine, project identities, canonical checkouts, owning workspaces, restriction
revisions and model/effort selections match. Added grants preserve continuity.
Authority reductions, workspace changes, scope changes or changed Codex selections
start a fresh thread with PSM's bounded conversation replay. Returning to provider
defaults also starts fresh, so stored overrides cannot silently select the previous
model or effort.

Each turn launches a new app-server process and a new broker with current policy.
The native workspace is a fresh empty temporary directory, with native filesystem
writes/network tools disabled. Repository and server operations continue through
PSM tools. Native approvals, inherited MCP servers, executable skills and plugins
remain disabled. Only the active thread and turn can dispatch tools or complete
the turn; other thread/turn events cannot finish or mutate this session.

New managed threads use `ephemeral: false`; `thread/resume` loads their retained
provider history. PSM records the managed thread ID, authority key and SHA-256
digest of its dynamic tool definitions separately from CLI session IDs. On resume,
the adapter supplies current permissions, directory and instructions, and verifies
the tool digest before starting a turn. The installed resume schema restores stored
dynamic tools; it does not accept new `dynamicTools` or capability-root fields.

Only a missing stored thread or a changed tool catalog raises the explicit
pre-turn resume-unavailable result. PSM then creates one fresh thread with recent
conversation context. Authentication/startup errors and failures after turn start
are reported without automatic replay. A completed turn must have status
`completed`; `failed` and `interrupted` are errors. Cancellation does not start a
fallback turn.

## Retention

Provider history is retained in the configured local Codex session store so it
can survive process restarts. Temporary native workspaces are removed after each
turn. PSM's transcript stores the managed reference using its existing owner-only
file protections. Resetting/deleting a PSM conversation clears that reference;
it does not erase Codex rollout files. Provider history cleanup and retention
controls belong to the P09 storage/retention work. This local path is not a hosted
multi-customer history store.

## Evidence and maintenance

[Recorded evidence](../evidence/codex-managed-continuity-2026-10-05.json): installed
Codex **0.160.0**, configured model **gpt-6.1-sol**. An isolated two-turn smoke test
read a dummy phrase through `psm_read`, deleted its file, then recalled it without
tools after resuming the same thread in a new app-server process. The test thread
was archived and temporary inputs removed. No live deployment or customer records
were changed. A thread created without a first turn was not yet available through
the installed provider's stored-rollout lookup; missing-history fallback covers
that condition.

`npm run typecheck` passed. Full `npm test`: **764 tests, 759 passed, 0 failed,
5 skipped**, including protocol and permission-lifecycle tests. These results
cover the current working tree, including existing changes. Protocol fixtures
check scope overrides, tool routing, catalog mismatch, missing history, revocation,
interruption and failure without replay; lifecycle tests check managed persistence,
workspace fences and selection changes.

The protocol was checked against locally generated 0.160.0 TypeScript definitions
and [official OpenAI app-server documentation](https://learn.chatgpt.com/docs/app-server).
After a provider update, regenerate its experimental schema and rerun the protocol
tests. Repeat the isolated native two-turn acceptance case for the selected account
and model before claiming support for that installation. This result does not
establish unattended hosted authentication or every provider version/model.
