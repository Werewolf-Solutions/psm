# Focused Opus follow-up: transfer correctness, browser verification, staging

User authorization: “yes do another focused opus pass on these 3 bugs, followed by browser verification and staging setup”.

Implement this follow-up, not another broad rewrite. Read applicable repository instructions and the prior completion plan/status. The main checkouts already contain the previous integration and pre-existing user changes; preserve both. Do not reapply feature worktree patches or bundle unrelated work into commits. Use Opus, not Codex.

## Independent review evidence

The reviewer reran 72 existing tests successfully: PSM workspace 17, Todo 11, Dapp workspace 30, catalog/migration 14. Three additional in-memory extensions of the existing Dapp workspace integration suite reproduced the bugs below against an isolated local standalone database. These probes did not edit repository files. Passing existing tests does not establish correctness of these cases.

### 1. Recovery writes occur before transfer authorization

In `werewolf-dapp/server/services/todoTransfer.js`, `transferWeek` calls `settle('week', week._id)` around line 202, before checking `mayMoveAll` around line 210. `transferPeriod` also settles before its full ownership check.

Reproduction using existing integration fixtures:

- Create a week owned by Alice in business A on a unique date.
- Simulate a torn move by creating an Alice-owned task linked to its day but stamped business B, visibility team.
- As Erin (member of A and B, neither admin nor creator), POST `/transfers` in A targeting B.
- Response is 403, but the task has already changed from B/team to A/private.

Required: denied requests must not mutate anything, including recovery. Authorize the actual source, destination and full affected unit before any mutation. Recovery is itself a privileged operation; do not infer authority over a stray row solely from its parent link. Cover weeks and periods, non-owner member/viewer/revoked caller and conflicts. Assert persisted documents unchanged on refusals. Do not merely move one check while leaving other authorization or validation after writes.

### 2. A genuine in-flight creation can be stranded after success

Current `tasks`/`days` are read before `withOptionalTransaction`. Writes later use that fixed ID set. New children can be missed. Transactions around only the writes do not automatically protect the preceding reads or concurrent writers.

Reproduction: create Gina's personal week on a unique date; intercept the week `updateOne` immediately before the actual container write, after the service has selected its children; insert a personal task linked to one of those days; resume the update and transfer to B. Response is 200 but the task remains personal and its week/day are now in B.

The existing test at `server/test/integration/todoWorkspaces.test.js:902` does NOT exercise this: it creates the supposedly late task before calling the transfer API, then can call `settle()` directly to repair state before asserting.

Required: real deterministic barrier-based concurrency tests. Prefer an actual authorized task-creation API request interleaved with a transfer; also test simultaneous transfers and relevant edits/deletes. A successful transfer must not leave cross-workspace children or silently overwrite another transfer. Coordinate all participating writers or fail safely; a second scan alone is not a synchronization protocol. Test standalone and transaction-capable paths where locally available. No direct test-only repair before asserting the public operation's postconditions.

### 3. An ordinary retry does not recover a partial standalone transfer

Reproduction: create Gina's personal week and task on a unique date. Inject failure on the first `TodoDay.updateMany` so the week moves into B but its days/tasks stay personal. First request returns 500. Repeat the identical original request (personal source, same ID, target B): it returns 404 at the source-scoped week lookup, leaving the partial move unresolved.

The current recovery test changes the request into a reverse transfer from B to personal; that is not retrying the original action.

Required: explicit authorized recovery semantics with a stable operation identity/state where needed, or fail closed before unsafe multi-document transfers on unsupported deployments. No success over a partial unit, no recovery that requires guessing the new source or issuing an opposite transfer, no replay that bypasses revoked permissions. Test identical retries after failures at each write boundary, recovery failure, duplicate retry, target conflicts and membership changes. If unsafe standalone transfer is disabled instead, make that limitation clear in API/UI/docs and retain safe ordinary task operations. Do not reconfigure live MongoDB.

## Implementation and regression gates

Write meaningful failing regression tests first, then fix the protocol coherently. Preserve legitimate privacy and ownership rules and personal/business isolation. Review both week and period paths rather than fixing only the reproduced week example. Keep scope bounded: do not introduce general platform infrastructure to solve this.

Run focused tests, relevant complete suites, type checks/builds and version checks as applicable. Update status with commands/counts and limitations; do not carry forward the previous inaccurate claims about retry/concurrency safety. Keep release versions consistent; never weaken version gates.

## Browser verification after correctness fixes

Discover installed browser tooling (e.g. Playwright/Chromium) and use it to actually exercise the UI with disposable local accounts/data, matching environment origins and local development servers. Do not substitute API tests, source inspection or an HTTP 200 for browser verification. Avoid real customer accounts/data.

Check: Werewolf sign-in and business selection/creation, personal/business launcher deep links, Todo board switching/task creation, revoked access and viewer restrictions, visible failed membership loading, and PSM selection/project assignment through the supported local-agent pairing flow. Include two users/two businesses and verify isolation. Exercise transfer UX if exposed; otherwise test transfers through API and state explicitly that no transfer UI exists. Capture concise browser evidence (scenario, expected/actual, screenshots or trace paths) without credentials. Check console/network errors. If browser dependencies or OAuth setup truly block a scenario, record the exact blocker and complete remaining scenarios; do not claim end-to-end coverage.

## Staging setup after verification

Targets: Todo staging `https://todo.werewolf.solutions`, identity/API `https://staging.werewolf.solutions`. No production changes. Last independent DNS check: Todo ENOTFOUND, staging resolved to 46.101.29.222; reverify before remote actions and do not treat this IP alone as host identity.

Inspect `psm/docs/deploy/TODO-STAGING.md`, `psm/docs/deploy/controller/README.md`, Todo's deployment docs/manifest and actual accessible resources. The user now explicitly requests staging setup. Perform safe, reversible, staging-scoped setup using verified existing authority and the intended PSM controller/enrollment workflow. Read-only inspection may show prior blockers have changed. An inaccessible GitHub repository is not proof it does not exist, and token scopes alone are not proof of the account's organization permissions: distinguish observed errors from conclusions.

Complete repository-owned setup work and resolve/review action pins rather than guessing them. Do not manufacture fingerprints, enroll the wrong root, weaken approval/helper boundaries, bypass artifact verification, or put secrets in source/logs. Never deploy arbitrary dirty working trees or sweep unrelated PSM edits into a release. Where a commit/push is a necessary staging step, include only reviewed in-scope changes; unresolved ownership of shared hunks is a blocker to packaging those hunks, not to independent work.

GitHub App installation, organization changes, privileged host setup, DNS/TLS writes and secret provisioning require exact verified targets and appropriate access; pause with a concise approval/access request if authority is missing or scope would expand. No paid provisioning, production deployment, real customer-data mutation, or live migration/index changes without explicit safeguards/approval. Preserve rollback and existing services.

If all prerequisites are satisfied, use the intended staging deployment path and verify DNS/TLS, served version, health, correct staging auth callbacks, browser login/workspace journey, and rollback readiness. Otherwise state exactly which setup steps were completed and the smallest remaining operator action. Do not stop local work merely because one external prerequisite is missing.

## Deliverable

Update `psm/docs/roadmaps/workspace-implementation-status.md` with the three regressions and fixes/limitations, test evidence, real browser results, and staging setup/deployment evidence. Distinguish local edits, commits, pushes and deployments. Leave a concise final handoff with precise remaining blockers. Never label this finished just because all pre-existing tests pass.
