# Roadmap acceptance and evidence register

Initially reconciled 2026-10-05 from repository records and read-only source
inspection; no checks were rerun for that documentation-only update. The subsequent
P02 implementation and its local checks are recorded separately below. Historical
results retain their original dates and scope.

Track **implementation**, **local acceptance**, **target acceptance**, and
**hosted acceptance** independently. A phase remains in progress when required
acceptance is open, even if one slice is verified. Source changes, commits,
publication and deployment are separate delivery facts.

| Phase / milestone | Evidence already recorded | Open acceptance / next evidence | Source |
| --- | --- | --- | --- |
| P00/P01 | September 23–24 baseline and test-host inventory/bootstrap, collision and role checks. | Reobserve a selected host before new mutations; old inventory is not live truth. | [Index handoffs](README.md#evidence-and-handoff-template), [machine contract](machine-onboarding.md). |
| P02 core | September 24 policy revisions, scoped rules, MCP standing calls, command access and presets. | Person-to-person delegation and hosted policy management remain open. Delegate only after P03 workspace identity integration. Preserve existing scoped enforcement. | [Permission implementation](agent-permissions.md#policies-reviews-and-presets-p02-2026-09-24). |
| P02 local workspace editor | October 5 working-tree implementation, PSM 0.3.26: scoped restriction add/remove, current business-management verification, revision/audit persistence, affected-turn cancellation and provider-session fencing. `npm run typecheck` passed; full `npm test`: 760 tests, 755 passed, 0 failed, 5 skipped. Targeted UI/store/HTTP/membership/session checks: 29 passed. | Rendered browser walkthrough, hosted authenticated management and person-to-person delegation. UI checks use a DOM test double; remote cloud, customer records and live deployment state were not mutated. The full suite covers existing working-tree changes too, not only this increment. | [Editor contract](workspace-policy-editor.md), `src/server/workspace-agent-policy.test.ts`, `src/workspace-agent-policy-ui.test.ts`, `src/server/agent-permission-lifecycle.test.ts`, `src/server/workspaces.test.ts`. |
| P03 | September 24 local control/runner tests, real Docker isolation checks, process-level crash recovery of an idempotent job; commit `a9180e8`. | Hosting provider/budget, actual hosted deployment, identity `psm`, scoped delegation, hosted callbacks and actual unattended jobs. | [Hosted evidence](../hosted/README.md#verification), [index P03 handoff](README.md#2026-09-24--p03-hosted-control-service-and-runners). |
| P04 | September 24 local cockpit + real systemd/LXD host, four-step wizard, browser setup and verified connection binding; 605 passing tests recorded. | Hosted HTTPS enrollment and wizard, intent expiry/regeneration, closed-browser recovery and project reuse through the selected execution service. | [Index P04 handoff](README.md#2026-09-24--p04-machine-onboarding-in-the-web-app), [feature acceptance](machine-onboarding.md#delivery-order-and-acceptance). |
| P05 baseline | September 24 script/build/typecheck execution, HTTP preview checks, discovery, Claude managed resume and a matched task comparison; 610 passing tests recorded. | Private dependencies and hosted acceptance. Rendering/JS inspection is now covered by the rendered-browser row below. Initial October 5 inspection found ephemeral managed Codex threads; the subsequent continuity increment below supersedes that gap. CLI resume remains a separate execution path. | [Index P05 handoff](README.md#2026-09-24--p05-practical-agent-tools-discovery-and-continuity), [comparison](../evidence/agent-comparison-2026-09-24.json). |
| P05 managed Codex continuity | October 5 working tree, PSM 0.3.27: protocol/lifecycle tests and actual two-turn Codex 0.160.0 / configured gpt-6.1-sol smoke. Turn one read a dummy phrase through the broker; a new process resumed the same thread and recalled it without tools after the file was removed. Test thread archived. Typecheck passed; full suite: 764 tests, 759 passed, 0 failed, 5 skipped. | Verify other provider installations/accounts separately. Hosted unattended authentication and private dependencies remain open; rendered-browser tooling is recorded in the next row. Stored provider history has separate retention; PSM conversation deletion does not erase rollout files. | [Continuity contract](managed-codex-continuity.md), [native evidence](../evidence/codex-managed-continuity-2026-10-05.json), `src/server/agent-codex-runtime.test.ts`, `src/server/agent-permission-lifecycle.test.ts`. |
| P05 rendered browser checks | `preview_check` loads each route in headless Chromium inside a disposable, offline, non-root container and fails on page errors, console errors, failed same-origin requests, Vite overlays and blank content; managed commits of frontend packages require it. October 13 at `799c58c` (0.3.38): `PSM_RUNNER_DOCKER=1` real-container tests, 2 passed. | October 13 Todo walkthrough through the managed task runner (0.6.6, `45454a3`): installs and builds passed and Chromium rendered every route, but verification failed on the unmodified project because its session refresh has no backend offline. PSM 0.3.39 (working tree) adds repo-declared preview fixtures; with one fixture on a scratch clone all five routes verified. Open: commit the fixture to todo-app, signed-in journeys, a provider-driven agent turn, Handymanservices. | [Website verification](../managed-website-verification.md), `src/server/agent-browser-preview.ts`, `src/server/agent-preview-fixtures.ts`, `src/server/agent-task-runner.docker.test.ts` (3 passed), [Todo walkthrough](../evidence/todo-browser-walkthrough-2026-10-13.json). |
| P06 | September 24 Dapp transfer fencing fix (`e4c267a`, 688 server tests recorded), Todo viewer fixes (`cc46a47`, `89f5b8a`, 11 tests/build), local browser PKCE/viewer/member checks using disposable users. | Establish that the accepted fixes are in the candidate actually released; complete required staging browser/isolation checks. The older transfer-race finding is fixed in that recorded branch, not an instruction to reimplement it. | [Index P06 handoff](README.md#2026-09-24--p06-appworkspace-release-defects), [historical workspace status](workspace-implementation-status.md). |
| P07 local static release | September 29 Todo 0.6.0, commit `9450ccedb9ba08493a6461ab930467ad0ea07625`, run `run_a7ef155bd9f04884`, four passed release probes. | Rollback: October 13 live read shows 0.6.5 active with 0.6.4, 0.6.1 and 0.6.0 retained and verified, and no rollback run in the history. Staging browser/workspace journey, external Watch when required by the target, hosted execution integration. | [Todo evidence](../deploy/TODO-STAGING.md). |
| P07a | September 29 Todo App creation/installation and local bundle setup code; October 1 Handymanservices App controller successfully released its target. | Todo controller migration, fresh-account button-only acceptance, update/re-pin acceptance, hosted callback/key lifecycle. Success for Handymanservices does not establish Todo migration or a fresh organisation. | [GitHub setup](github-button-setup.md), [Node checkpoint](../deploy/NODE-SERVICE-RECIPE.md#what-to-do-next). |
| P08a.1 | October 1 Handymanservices 1.0.1, source `ff17b6a`, run `run_29d57729336843e6`; target and `/`, `/healthz`, `/version.json` passed. PSM typecheck and suite: 740 passed, 5 skipped. | Managed repeat/rollback in P08a.2, uninterrupted switching in P08a.3 and operational observation in P08d. Since October 12/13 this project declares production only (1.1.0 active, run `run_967ea6a45d234f23`), so those rehearsals need another non-production Node-service target. | [Node recipe evidence](../deploy/NODE-SERVICE-RECIPE.md#built-2026-10-01). |
| P08a.2 helper-level evidence | October 1 homelab exercised two healthy releases, automatic/manual rollback, secret rotation, crash restart and HTTP proxy. The report path is `/srv/homelab/reports/2026-10-01/psm-node-service-test.md`; resources were removed. | Preserve this credit, but prove the complete PSM/GitHub/public staging path separately. The external report was not reread during this update. | [Recorded homelab result](../deploy/NODE-SERVICE-RECIPE.md#what-to-do-next). |
| P08a.3 helper-level switching | October 13 working tree (0.3.39): contract `alternatePort`/`drainSeconds`, standby unit, nginx upstream file, manifest `switching: health-checked`, enrollment reserving a second port. Go tests pass, including order of operations, a failing candidate, a rejected nginx configuration and the pre-reconcile fallback. `PSM_SWITCH_DOCKER=1` real nginx 1.27, three runs: 93,181, 76,422 and 76,191 requests, 0 failed; the failing candidate answered none. | systemd was replaced by in-process servers, so real units, boot enablement and memory for two instances are unproven. The homelab host was unreachable on October 13. No helper with this code is installed anywhere; no target is enrolled with a second port. Then the managed production rehearsal the operator selected. | [Recipe section](../deploy/NODE-SERVICE-RECIPE.md#health-checked-switching-built-2026-10-13-not-yet-on-any-host), `host-helper/switching_test.go`, `host-helper/switching_nginx_test.go`. |
| P08b/c/d, P09, M1, P10, P11, P12, P13 | Plans and prerequisites are defined; implemented baseline pieces are credited in the relevant documents. | Each named milestone requires its own evidence; no full-phase acceptance is claimed by this update. | [Operations milestones](application-operations.md), [workflow plan](engineering-workflows.md), [release plan](release-and-api-lifecycle.md). |

## Source provenance at this reconciliation

Read-only inspection on 2026-10-05 observed HEAD `0ba714c` (commit subject names
PSM 0.3.22) and root `package.json` version **0.3.25 in the working tree**.
There are existing uncommitted code/document changes. This supersedes presenting
0.3.21 as the current checkout; 0.3.21 and its 740-test result remain the October 1
checkpoint. No current suite result, publication or deployment is inferred from
the newer package field.

The subsequent P02 editor increment advances the working-tree version to 0.3.26
and records the checks above. It remains uncommitted and unpublished; no new
staging or production deployment is implied. The existing changes were preserved.

The following P05 continuity increment advances the working tree to 0.3.27;
current local results are recorded above. It is also uncommitted and unpublished.

The source-publication adapter requests repository-specific `contents: write`
and `workflows: write` when publishing app source, in addition to the controller
setup adapter's writes. Documentation now names both purposes.

Rechecked 2026-10-13: HEAD `799c58c` on `dev`, package **0.3.38**, clean working
tree. Typecheck passed; full suite: 837 tests, 831 passed, 0 failed, 6 skipped.
The working-tree notes above are historical. Increments 0.3.34 to 0.3.38 are
described in the [rollout runbook](../deploy/STAGING-TO-PRODUCTION.md) and
`docs/evidence/`; this recheck did not re-verify their individual claims.

## Evidence maintenance

### 2026-10-06 — staging monitoring and production migration preparation

Read-only live inspection confirmed Todo staging 0.6.5 and Handymanservices
managed staging 1.0.1. Both report `not-monitored`; no external-monitor connection
exists. The operator confirmed Better Stack account setup is still needed and
requested replacement of the Handymanservices staging address with the main
hostname. Host inspection confirmed the main hostname currently serves the
legacy PM2 app on port 3001, while managed staging uses port 41000.

The [rollout runbook](../deploy/STAGING-TO-PRODUCTION.md) records the provider
setup, acceptance and route transfer sequence. A separate production manifest
draft passed the shipped manifest validator against the actual app checkout.
The draft requires real monitoring, scoped production bindings and an approved
transfer of the legacy Nginx route. No application manifests, routes, credentials
or processes were changed. Monitoring and production acceptance remain open.
Evidence: [sanitized host inventory](../evidence/staging-production-inventory-2026-10-06.json).

### 2026-10-06 — pinned release summary and completed-release actions (PSM 0.3.31)

Todo staging deployment `run_d89b95165000401c` succeeded and the live environment
reports both committed source and active release at 0.6.5, commit
`cc9942ab317c2f652f68c137c6917a2a1f1995f9`. The screenshots showed an old actionable
plan and **Confirm & deploy** To do despite that success.

The release summary now sits above To do in a pinned container with the action
bar. Committed source, active release, public watch and target remain visible
while scrolling; narrow screens can scroll the cards horizontally. Scroll targets
account for the pinned container's measured height.

A completed release suppresses the old deployment plan, review/confirm buttons,
deployment To do and completed preparation banner. The approval handler also
refuses repeat approval. Rollback, a different artifact or source, dirty files,
and failed release verification remain actionable. Existing plan and authority
checks still apply.

Tests execute the shipped eligibility and To do functions for successful release,
rollback, new source, dirty files, changed artifact and failed verification.
Targeted web/UI checks: 35 passed. `npm run typecheck` passed; full `npm test`:
778 tests, 773 passed, 0 failed, 5 skipped. Output:
`/tmp/psm-release-ui-full-tests.log` (local transient evidence). These UI checks use
test doubles; a rendered browser scroll walkthrough remains unverified.
The idle local PSM was restarted; bootstrap reports 0.3.31 and live HTML, JavaScript
and CSS requests confirm the updated assets are served. No new app deployment was
started for this UI change.

### 2026-10-06 — infrastructure preparation completion (PSM 0.3.30)

The Todo run shown in the report, `run_a4dd1233dc444334`, had actually succeeded,
but its preparation immediately queued another infrastructure plan. Reconcile
plans deliberately include Nginx reload actions even when observations are in
sync; the coordinator used the existence of these actions to start another run
after every success. This caused an unbounded sequence of successful reloads.

The repeating preparation was cancelled through the supported local endpoint;
its final run `run_767802a7dbdf486b` reached terminal `cancelled`. The coordinator
now finishes after successful reconciliation and fresh ready checks. Remaining
infrastructure drift blocks for review rather than automatically repeating the
plan. Source/build and external checks retain their existing gates.

Regression tests cover manual approval completion, standing-rule completion with
one approval, and persistent drift after a successful run. `npm run typecheck`
passed; full `npm test`: 775 tests, 770 passed, 0 failed, 5 skipped. Output:
`/tmp/psm-reconcile-loop-tests.log` (local transient evidence). The idle local PSM
was restarted and its bootstrap endpoint confirmed version 0.3.30.

Live acceptance: resumed Todo preparation
`prep_0cceab87-0367-4fd6-9bb2-6aa501e51359` under its existing staging standing
approval. One reconciliation run, `run_3dd792118abe4246`, succeeded; the job then
reached terminal `succeeded` with **Ready to deploy** and no replacement run.
Committed source is 0.6.5 (`cc9942ab317c2f652f68c137c6917a2a1f1995f9`); active
staging remains 0.6.4. Preparation verification did not activate the new app release.

### 2026-10-06 — preparation recovery and commit/build flow (PSM 0.3.29)

The live Todo preparation endpoint confirmed a blocked job with `no such workroom`
and a stale saved room ID. Preparation now clears deleted room references before
permission review and readiness polling, opens a replacement on the selected AI,
and rechecks current source and grants. Missing conversations do not count as
completed repairs. Other workroom errors still surface.

Deploy now offers **Commit and prepare build** on dirty-source readiness rows.
The build button uses the same coordinator: prepare and commit intended changes
with managed Git, review source publication when required, then build the committed
revision. Readiness checks focus outstanding steps instead of a disabled deployment
plan; duplicate source-commit instructions are removed. Existing capability,
checkout, publication and exact infrastructure/deployment approvals still apply.

Regression scenarios cover deleted-room resume and deletion during a repair,
source repair continuing to build, both UI preparation entry points, and readiness
navigation. `npm run typecheck` passed; full `npm test`: 772 tests, 767 passed,
0 failed, 5 skipped. UI checks execute shipped handlers with test doubles; a real
Todo commit/build/publication remains live acceptance, not claimed by these tests.
Test output: `/tmp/psm-preparation-full-tests.log` (local transient evidence).
Live read-only inspection also confirmed the saved Todo workroom returned HTTP
404. The initial bounded idle-only reload waited four minutes and deferred because
`feedback-hub` still had an active AI turn. After the operator requested a restart
and that turn finished, the idle checks passed and PSM restarted successfully;
the live bootstrap endpoint reports 0.3.29. No active turn was stopped, no Todo
source was committed, and no build or deployment was dispatched in this increment.

### 2026-10-06 — deployment source/version clarity (PSM 0.3.28)

Read-only Todo inspection found working package version 0.6.5, while committed
HEAD `086e74fc77dc2cbf40c2443c80a1c90ae7315bea` still contained 0.6.4. The running
deployment API correctly selected committed source but did not show the newer
working version or an overview source-dirty blocker.

The source view now reports `workingTreeVersion` separately from the committed
`version`; Deploy labels **Working files** and **Committed source** distinctly,
and explains that the intended changes need committing before a build. A real-Git
fixture verifies that committing the bump immediately advances the deployment
source without allowing uncommitted files into an artifact. UI behavior is covered
by a test of the shipped summary renderer. Typecheck passed; full suite:
766 tests, 761 passed, 0 failed, 5 skipped. The idle local PSM was reloaded to load
the fix; no Todo source was committed and no application was deployed.

For each new result, record milestone, date, scenario/command, expected and actual
behavior, source commit, artifact/target when relevant, evidence path and remaining
gates. Include skipped tests and unsupported cases. Historical handoffs remain
append-only context; update this register and the index when evidence changes.

### 2026-10-06 — Werewolf-owned monitoring, PSM 0.3.32

The operator superseded the Better Stack signup direction: no external
monitoring account is required. Werewolf Watch is installed as an enabled
systemd service on werewolf-alpha, independent of the cockpit. Real HTTPS
checks for Todo staging, Handymanservices staging and the Werewolf staging API
passed, with trusted certificates and the expected Handymanservices health JSON.
Repeated observations continued after the service bundle update. The dedicated
SSH reader rejected an arbitrary `id` command.

Todo monitoring configuration is committed (`45454a3`, managed source 0.6.6)
and bound to the Werewolf reader. PSM was restarted at 0.3.32; its live refresh
API returned fresh healthy evidence while the active Todo release stayed 0.6.5.
The served UI includes refresh, certificate expiry, latency and incident history.
Typecheck passed. Full suite: 784 tests, 779 passed, 0 failed, 5 skipped. Tests
include real HTTPS failure modes, durable incident recovery and stale evidence.

The observer is explicitly `same-host`; independent whole-server coverage,
company notification delivery, rendered-browser acceptance and the
Handymanservices production routing transfer remain open. No production
migration or complete production monitoring is claimed. See [native evidence](../evidence/werewolf-watch-2026-10-06.json),
[runbook](../deploy/WEREWOLF-WATCH.md), [ADR 0006](../deploy/adrs/0006-werewolf-watch.md).

### 2026-10-06 — Monitoring tab and droplet graphs, PSM 0.3.33

Added a project Monitoring tab and a link beside Public Watch's status in Deploy.
The environment selector is independent of deployment controls. Users can select
24 hours or seven days and view hourly availability/failure, latency, CPU,
memory and disk graphs, resource totals and incident history. The service now
collects unprivileged Linux host metrics and retains them in SQLite for seven
days, preserving earlier public-check samples across the upgrade.

The new collector bundle was deployed to werewolf-alpha and the idle local PSM
restarted at 0.3.33. Live Todo refresh returned healthy checks, hourly history
and real host resource data; the new tab, link and chart assets are served.
Typecheck passed. Full suite: 788 tests, 783 passed, 0 failed, 5 skipped;
subsequent targeted CPU/history/dashboard checks also passed. The dashboard
labels observation gaps and host identity; CPU is unavailable until a delta
sample exists. Independent-host coverage and rendered-browser acceptance remain
open. See [dashboard runbook](../deploy/WEREWOLF-WATCH.md).
