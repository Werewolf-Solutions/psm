# Todo staging deployment

## Version and build selection — 2026-10-01 local checkpoint

Todo remains clean at commit `ad02646`, version 0.6.1. PSM was retaining the
previous 0.6.0 artifact in the open Deploy page, so committing the fix alone did
not clear the misleading version blocker. The local PSM fix selects only builds
matching the current commit, repository and environment inputs; readiness also
discards an old artifact ID sent by an already open browser. Cached readiness is
invalidated when source changes, and the artifact list refreshes after a build.
Restart PSM and reload its page to use these changes; Prepare build should then
request a build of 0.6.1 rather than another version increment.

Managed PSM commits now increment root X.Y.Z automatically for code changes and
synchronize root lockfiles while preserving explicit newer versions and unrelated
edits. External commits without a sufficient version are detected before a build.
All 715 PSM tests passed (5 skipped), with typecheck passing. This checkpoint does
not claim publication, a second deployment, rollback, or authenticated browser
acceptance; the earlier dated observations below remain historical evidence.

## Acceptance recheck — 2026-09-29, P07a work

PSM now has a locally tested GitHub App registration/installation flow and a
reviewed controller setup/update button. The first successful Todo release still
uses the legacy controller credentials. GitHub App `5122783`, installation
`166171550`, is now ready and bound to Todo staging at binding revision 2.
Its controller list is empty: no controller bundle has been applied and no new
Todo release or rollback has been dispatched during this P07a pass.
Controller setup currently needs `deployment-control` added to the App's selected
repositories. Its absence caused the HTTP 422 creation attempt. The local fix
reports that missing access and carries forward the existing `todo-staging-web`
Environment; restart PSM and review setup again after saving the installation's
repository selection. App-based controller migration remains unverified.
[Live migration and fresh-account acceptance](../roadmaps/github-button-setup.md#acceptance)
remain open.

Fresh read-only HTTPS checks passed for `/` (200), `/auth/callback` (200),
`/api/` (404), `/version.json` (200), and both referenced JavaScript and CSS
assets (200 with their expected content types). Public metadata still names
version 0.6.0, commit `9450ccedb9ba08493a6461ab930467ad0ea07625` and artifact
`artifact_917da4d6407541cf9105feeb`.

Staging's `/api/v1/apps/todo/public` accepts the exact Todo callback and reports
`clientType: web`, `redirectAllowed: true`. This checks registration, not a
completed browser sign-in or workspace membership behavior.

The local deployment database still contains one successful deployment and
only one retained release for Todo. A meaningful rollback rehearsal therefore
requires another reviewed, verified release before rolling back to this one;
there is no second release to select today. The Todo manifest declares `watch: []`,
so no external monitor was tested or claimed. Browser/workspace and hosted
acceptance remain open. These checks made no target mutations.

The **0.6.1 release candidate** is now in Todo's actual checkout and includes the
requested first-login calendar fix: missing weeks display Monday–Sunday, the
first task creates its week through the existing API, and the old import-command
prompt is removed. Sunday queries use Monday to find legacy weeks whose end date
is Saturday. Viewer controls remain read-only. All 21 Todo tests and
`tsc -b && vite build` passed with the manifest's staging public inputs. The
earlier `/tmp/psm-todo-repeatability` version-only candidate is superseded by these
changes. The candidate is committed locally as `ad02646` (Todo 0.6.1), and the
checkout is clean. It has not been pushed, built by GitHub, deployed or verified
as a second retained release. Refresh readiness, then use Prepare build to review
source publication and produce an artifact from this new commit.

The reported “Artifact 0.6.0 must be newer than active 0.6.0” blocker is the
expected version gate for an already verified active release. Publish the 0.6.1
source, prepare its immutable build, and select that artifact for the next
deployment. Rebuilding the unchanged 0.6.0 source does not satisfy this check.
PSM's blocker now explains those steps; its 16 planner tests passed. The local
build alone does not stand in for the GitHub artifact gate.

## Current status — successful managed release, 2026-09-29

Read-only inspection of PSM's local deployment database confirms that
`run_a7ef155bd9f04884` **succeeded**, finishing at **08:54:11 UTC**. Its GitHub
controller run is `36545610174`, using controller commit
`661ab2bb67a19225fb0d1b388532a6ddf1a1e657`.

The active managed release is `release_artifact_917da4d6407541cf9105feeb`,
version **0.6.0**, source commit `9450ccedb9ba08493a6461ab930467ad0ea07625`.
The saved controller receipt records activation at
`2026-09-29T08:54:01.219035232Z` and all four probes as passed:
`home`, `spa-fallback`, `api-sealed` and `release-metadata`.
The active release record now references this successful run.

This supersedes the earlier **active but unverified**, missing-result and
certificate-blocked states below. They remain as incident history. This docs
review read saved evidence; it did not start PSM, run another deployment or
recheck the public site.

Remaining P07 acceptance: rehearse rollback to a retained verified release,
record browser sign-in/workspace checks and any declared Watch checks, complete
P07a's button-only GitHub setup, and demonstrate hosted execution with the laptop
disconnected after P03's hosted prerequisites are resolved. A successful static
release does not close those broader product requirements.

## Result artifact upload repaired on 2026-09-29

Run `run_8f18f794636a4412` used controller run `36541279705`. Both GitHub
jobs, including stage/activate/verify on the target, succeeded. The workflow's
result-upload step was skipped because its `hashFiles()` condition looked for
a file under `runner.temp`; GitHub did not produce the expected result artifact.
The helper still attests the exact release active. PSM correctly did not mark
the run successful without its controller result.

Controller commit `661ab2bb67a19225fb0d1b388532a6ddf1a1e657` removes that
condition and always runs the upload step, whose existing
`if-no-files-found: error` setting reports a missing file explicitly. PSM now
observes the target after a completed controller with this exact missing result;
when it can establish the target state, it closes the run as failed and keeps
the release active but unverified. After loading the fix, **Check again**
closed this run as failed. PSM pinned the corrected controller commit and
workflow blob `4959a0ea9bf70b9aa1aeb6c2bf1a129579c953b3`. Readiness then
passed with no blockers.

Before another attempt, review found that Go's helper emits RFC3339Nano
`observedAt` while PSM's release-result parser accepted at most milliseconds.
The parser now accepts up to nine fractional digits for `activated_at`, while
plan timestamps retain their existing rule. Typecheck and focused tests pass.
The local PSM process must load this last parser change before a fresh plan is
confirmed.

## Repeat verification contract repaired on 2026-09-29

Run `run_d46cd4bea4b74897` stopped before GitHub dispatch. The active release
was also assigned as `conditionalRollback.previousReleaseId`, while rollback
was disabled for a repeat of that same release. Local validation raised
`ExecutorContractError`; the runner preserved an intent but had no provider
receipt, so it initially held the run in recovery-required. The controller's
run list has no dispatch for this PSM run.

The release contract now sets `previousReleaseId: null` whenever rollback is
not authorized. Release submission checks its local contract before contacting
GitHub and records deterministic contract errors as failed. Recovery recognizes
the saved pre-dispatch `ExecutorContractError` for this exact action, while an
unknown provider error remains held. After restarting the local PSM process,
**Check again** closed the historical run as failed and released its locks.
It did not dispatch a release.

Readiness was rechecked afterward: staging is ready, the fresh plan has no
blockers, and the exact active 0.6.0 artifact may be retried for verification.
The plan still needs its own review and confirmation. Typecheck, focused safety
tests, and the full PSM suite pass (675 passed, 5 skipped).

## Controller success response fixed on 2026-09-29

Run `run_ff1bfeb9441044fe` reached the target, but controller run
`36534901096` failed at its release step. The helper's wire response for a
successful operation is `outcome: succeeded, code: ok`; the controller tested
`outcome == ok`, so it reported a failure even when the helper returned success.
The helper attests the expected release active, its current PM2 snapshot matches
the approved digest, and HTTPS answers all four release probes as planned.

The controller fix and three regression tests were committed to
`Werewolf-Solutions/deployment-control` at
`12640f97e422a6a87db5cd349e015dd929195e22`. PSM re-read and pinned that
commit; the workflow blob is unchanged. The checked-in PSM controller draft has
the same fix and tests.

PSM recorded the release as active but unverified after the failed run. Its
version gate then blocked a retry of that exact 0.6.0 artifact. The planner now
allows a verification retry only for the same active, managed, unverified artifact
with matching commit and payload digest on the same target. A verified release
or different artifact at the same version remains blocked. Typecheck and the
focused planner and controller tests pass. The running PSM dev process predates
this planner change and must be restarted before checking readiness again.
The historical run remains failed; a fresh plan still needs review and approval.

## Active release repaired and target pins refreshed on 2026-09-29

The latest work already installed helper `0e49a8b79184…` and closed
`run_c9cd1a9be0404bd0` as failed with an explicit target-contract mismatch.
The source includes the staging permission fix, its regression under `UMask=0027`,
and the Machines helper-update action. Installing the helper did not repair the
existing release: its files remained 0640 and its assets directory 0750.

Using the enrolled administrator connection, the active Todo release's identity
and complete payload digest were verified before changing only its public file
modes to 0644 and directory modes to 0755. No file contents, active symlink,
nginx configuration, PM2 processes, or saved deployment approvals were changed.
HTTPS now returns 200 for `/`, `/auth/callback`, `/version.json`, and both JS/CSS
assets, and the expected 404 for `/api/`. Release metadata names artifact
`artifact_917da4d6407541cf9105feeb`, version `0.6.0`, commit
`9450ccedb9ba08493a6461ab930467ad0ea07625`.

The earlier approved PM2 user/home change accounts exactly for the target digest
moving from `sha256:69810bb1785d673bd5807854a308fab6ddf39c704087b93c65a3349238a03321`
to `sha256:c0e8e8296d9a2bdffc5b5005db0c21811a16ec2cd096cd9be3988208636fa614`.
The target-pin API reobserved that digest and updated the infrastructure, release,
and CI connections. Readiness now passes with no plan blockers. The historical
run remains failed; no new deployment has been approved or dispatched. A fresh
plan must still be reviewed and confirmed to complete a verified managed run.

Review also restored recovery checks for the current observed target ID/digest,
ready layout, receipt schema/target, and payload algorithm. An old matching
receipt alone cannot authorize recording an activation on a changed target.
Typecheck and the ten focused adapter/readiness tests pass after this change;
the preceding full review passed 672 tests with five skipped, plus the Go suite.

## PM2 baseline observation closed on 2026-09-28

Run `run_fb25b36c12d84c17` completed the HTTP and TLS nginx changes and
issued the Todo certificate successfully. It stopped immediately before
`unit:web#staged` because the read-only `unit:web#pm2-before` check failed.
PSM 0.3.13 collapsed the helper's failure to `post-mutation observation failed`,
so the saved run cannot identify the original PM2 command error. Repeating
the exact PM2 adapter check through the enrolled helper succeeded and returned
an empty process set. The helper journal shows a `runuser` PM2 invocation at
the failure time, but no command stderr. The cause of that first failure is
therefore unconfirmed.

Local PSM 0.3.14 retries read-only check errors up to three times, records the
failed action and bounded helper detail once if all attempts fail, and offers
**Close failed observation** only when no submitted side effect remains
unresolved. The helper source now preserves a short PM2 stderr excerpt; that
helper binary has **not** been installed on the host. Focused TypeScript and
Go tests pass. The existing run's approval expired, so the run was closed as
`failed / complete`; its prepared stage step was cancelled and all five
expired target locks were released. No static files were staged or activated.

The live helper target had PM2 user `psm-i-todo-app-staging-a73cc3` with its
own `.pm2` directory, while the checked-in
`host-targets/werewolf__todo-staging-web.json` names `lorenzo` and
`/home/lorenzo/.pm2`. A read-only host process check found six Node processes
and the PM2 daemon under `lorenzo`, but only an empty PM2 daemon under the
deployment account; its configured `.pm2` directory did not exist. With
separate operator approval, only the live target's `pm2User` and `pm2Home`
were changed to the checked-in Lorenzo values; all other fields and file
ownership were preserved. A read-only `snapshot-pm2` through the enrolled
helper then succeeded and observed six processes with digest
`sha256:1e52a722e8ff8b09de375731ef6b1a3dfd5dcc98b6ffc84c875854719728fb14`.
No new deployment was started. Restart local PSM to load 0.3.14 before
reviewing a fresh plan.

## HTTP reload recovery closed on 2026-09-28

Run `run_df15b5d806e14eaa` wrote the HTTP ingress file, then stopped at
`resource:ingress#http-reloaded` in `recovery-required`. A read-only
`validate-nginx` invocation through the enrolled helper reproduced the cause:
the helper's `ProtectSystem=strict` sandbox allows writes to nginx config but
not `/var/log/nginx/error.log` or `/run/nginx.pid`, which `nginx -t` opens.
The existing client also rejected the helper's multiline diagnostic, leaving
only `HostHelperError` in the saved run.

Local PSM 0.3.13 normalizes bounded helper diagnostics and exposes the saved
recovery reason. An authenticated operator can **Close uncertain reload** to
mark only this repeatable nginx action unresolved, fail the old run and release
its locks; a fresh reviewed plan will reload nginx again.

The operator approved adding only `/var/log/nginx` and `/run/nginx.pid` to the
root helper unit's `ReadWritePaths`. Both paths existed on the Todo staging
host. The approved base unit was installed there, verified with
`systemd-analyze verify`, and `psm-host-helper.service` was restarted and
confirmed active. The separate PM2 drop-in was preserved. A read-only
`validate-nginx` call through the enrolled helper succeeded after the change.
Nginx still reports a nonfatal duplicate `printshop.werewolf.solutions` server
name warning.

Run `run_df15b5d806e14eaa` was then closed as `failed / complete`: its
uncertain `reload-nginx@1` step is failed, later prepared steps are cancelled,
and its five expired target locks were released. No new deployment was started.
Restart the local PSM process to load 0.3.13, then review a fresh staging plan.

Applied unit-line change:

```diff
-ReadWritePaths=/etc/nginx/sites-available /etc/nginx/sites-enabled /etc/letsencrypt /var/lib/letsencrypt /var/log/letsencrypt /var/www /var/lib/psm-deploy /run/psm-deploy
+ReadWritePaths=/etc/nginx/sites-available /etc/nginx/sites-enabled /etc/letsencrypt /var/lib/letsencrypt /var/log/letsencrypt /var/www /var/lib/psm-deploy /run/psm-deploy /var/log/nginx /run/nginx.pid
```

## First certificate issuance stopped locally on 2026-09-28

Run `run_a6991dbb269a4978` completed the DNS, release-directory and HTTP
nginx-file actions, then failed issuing the first certificate. The helper's
submission returned `HostHelperError`, but PSM discarded its bounded message;
the follow-up observation reported `state: create`. The exact certbot error
cannot be recovered from that run's saved events. Public DNS now resolves to
`46.101.29.222`, and nginx answers HTTP on the challenge path.

The first-certificate graph wrote the HTTP nginx file but did not reload nginx
until after certificate issuance. Local PSM 0.3.12 adds a mandatory HTTP nginx
reload before certbot, while retaining the later TLS reload. A helper-reported
failure now records its bounded reason in the durable run events before PSM
observes the resulting state. This is a likely fix for the issuance failure,
not a confirmed staging deployment; no new run was started for this change.

## DNS observation and run logs fixed locally on 2026-09-28

Run `run_abb19f518ea449ea` submitted the DNS reconciliation and then failed
because DigitalOcean's filtered record list did not yet show the newly owned
record. Its durable failed step records `The owned DNS record no longer exists`,
but the page showed only a generic terminal event. Local PSM 0.3.11 checks the
owned record by ID when the list misses it and, for a record created in the
current submission, waits up to 30 seconds for it to become observable. A
persistently missing record still fails. Failed action details now appear in
the run and terminal event.
Later mutation gates compare the approved source, artifact, policy, connection
and lock authority without treating the run's own newly reconciled DNS state as
external plan drift. Before the first mutation, the full exact plan digest is
still required.

The run appears immediately below the deployment toolbar and is scrolled into
view after **Confirm & deploy**. **Copy full run log** fetches the current durable
run and copies every event and step result with timestamps. These changes are
uncommitted; no new deployment was approved or dispatched for this fix.

## Plan review and recheck fixed locally on 2026-09-28

After an artifact became ready, the exact plan appeared below the long
Connections section and the top Deploy button gave no path to review it. Two
approved Todo staging runs ended as `stale-plan` before any mutation. Comparing
their stored plans showed the only changing inputs were HTTP response times
(for example, 89ms versus 157ms), which PSM had included in dependency
fingerprints, action details and the plan digest. The health statuses and
other deployment inputs were unchanged.

Local PSM 0.3.10 places the plan directly below the toolbar, makes the top
button jump to the plan, and requires **Confirm & deploy** from that review.
Readiness checks bring the plan into view. HTTP response durations remain in
the observation document for diagnosis but no longer change its fingerprint
or digest. A real status, URL, redirect, resource or other input change still
makes an old plan stale. The runner records the exact stale reason. Changes
are uncommitted; no new deployment was approved or dispatched for this fix.

## Result format verified on 2026-09-28, after the branch fix

Run [36404335623](https://github.com/Werewolf-Solutions/todo-app/actions/runs/36404335623)
also built successfully. Its actual `psm-artifact-result.json` contains the complete
camelCase record (`psmRunId`, etc.), while PSM expected snake_case (`psm_run_id`).
This caused the next import rejection, `result.psm_run_id: is required`.

The local 0.3.9 fix accepts that exact legacy record and normalizes it before the
existing strict checks. It rejects partial, mixed and extra-field records. The
downloaded JSON is retained as a regression fixture. A read-only invocation of
the full GitHub downloader/importer now verifies artifact `10962210235`, version
`0.6.0`, against the original saved dispatch and committed source manifest,
including run correlation, commit, build-profile digest, provenance and retention.
No artifact was written to PSM's database, no new workflow was dispatched, and no
release was deployed during this verification.

Delivery state: working tree. Restart the PSM agent to load 0.3.9, then resume
preparation. This verifies the artifact-import path, not staging acceptance.

## Artifact import failure verified on 2026-09-28

GitHub run [36397699426](https://github.com/Werewolf-Solutions/todo-app/actions/runs/36397699426)
completed successfully for source `9450ccedb9ba08493a6461ab930467ad0ea07625`.
PSM preparation `run_76f587c4ed17441a` then rejected its receipt: the saved policy
and receipt used `master`, while the dispatch requested `refs/heads/master`.
Dispatch accepted those branch aliases, but artifact import compared their strings.
This was a PSM import defect, not a compiler error or missing operator permission.

The local 0.3.8 fix resolves the dispatch through its allowlisted policy before
comparing the receipt. Commit, workflow, correlation, artifact identity and
provenance checks remain enforced. Failed preparations now link to the GitHub run
and offer a retry; import failures pause with their actual error instead of asking
the project AI to change source. Exact-plan blockers show their messages.

Delivery state: working tree. Restart the PSM agent to load the backend fix, refresh
the cockpit, then use **Retry preparation** or **Resume preparation**. This check
did not dispatch another build or deploy a release; staging acceptance remains open.

For the dry-run-first operator helper, exact root-permission repair, staging-only
controller scaffold and GitHub setup commands, see [TODO-STAGING-SETUP.md](TODO-STAGING-SETUP.md).
That runbook does not deploy or imply that the remaining auth/transfer defects are fixed.

The current target is **https://todo.werewolf.solutions**, using
**https://staging.werewolf.solutions** for the API and sign-in.
The exact callback is https://todo.werewolf.solutions/auth/callback.

The generated hostname a6s1j3p3zh.werewolf.solutions is superseded by the user's
2026-09-21 request. Production is not an active Todo environment while staging
owns the requested hostname.

See [Todo's deployment runbook](../../../todo-app/docs/DEPLOY.md) for current
evidence, the precise remaining enrollment/controller work, and acceptance.
See [the ecosystem assessment](../roadmaps/ecosystem-integration.md) for the
integration sequence and business-isolation findings.

## What was established on 2026-09-21

- Staging's health endpoint returns 200, Todo's guarded board returns 401, and
  public Todo metadata allows the exact new callback. The old September 7
  missing-backend and missing-registration blockers are no longer current.
- PSM has bound DNS, GitHub and host connections. Its invalid saved SSH key was
  repaired using the already-existing local Todo staging key. A read-only
  host-helper probe succeeds and reports no active release.
- The enrolled host contract and PSM host scope still name the old directory.
  PSM refuses the new root until an administrator re-enrolls that specific
  target and the connection is updated with its new fingerprint.
- The release controller is unpinned and its expected repository cannot be
  resolved through the authenticated GitHub account.
- The Todo hostname still has no DNS record, and no release has been executed.

The Werewolf attached capability remains read-only. Infrastructure
checks and the credential repair used the local PSM deployment API and SSH
host helper, not that capability.

## Rechecked on 2026-09-21, later the same day

Everything below was observed directly from this workspace, not carried over
from an earlier session's notes.

| Check | How | Result |
| --- | --- | --- |
| `todo.werewolf.solutions` DNS | `getent hosts` | **No record.** Still the binding blocker. |
| `staging.werewolf.solutions` | HTTPS GET `/` | 200 |
| `psm.werewolf.solutions` | HTTPS GET `/` | resolves, 403 (the hosted cockpit's gate) |
| Staging dapp version | version string in the served main bundle | **0.5.1** — the release that contains the workspace API |
| Manifest dependency `werewolf-api` | GET staging `/api/v1/health` | 200, as declared |
| Manifest dependency `todo-api` | GET staging `/api/v1/apps/todo/board` | 401, as declared |
| Manifest dependency `todo-sign-in` | GET staging todo `/public?redirectUri=…` | 200, `redirectAllowed: true` for the exact new callback |
| `.psm/deployments.json` | parsed with PSM's own `deploymentManifestIssues` | **valid**, no issues |
| Artifact pipeline | ran `.psm/scripts/prepare-static-artifact.mjs` end to end locally | builds, packages deterministically, emits `version.json` carrying version 0.6.0 and the commit |
| `Werewolf-Solutions/deployment-control` | `gh repo view` | **does not exist** |
| Local release state | no `.psm-deploy*` state file names the target | **no release has ever been executed** |

So the repo-owned half is finished and verified: a valid manifest, a working
prepare workflow, an artifact that carries the metadata the manifest's
`release-metadata@1` check demands, and a staging API that already serves the
workspace release this frontend needs.

## Rechecked again on 2026-09-21, after the transfer-correctness round

Read-only inspection of the running local agent (`GET /api/connections`,
`/api/deployment-targets`, `/api/projects/prj_e471…/deployments/staging`) **corrects two
claims above.** Both were written from a failed lookup rather than from an authoritative
source, and both were wrong.

- **The host target IS enrolled.** `werewolf:todo-staging-web` exists, with
  `fingerprint: sha256:cc2889cf…`, `revision: todo-staging-v1`, root
  `/var/www/todo.werewolf.solutions`, on `46.101.29.222` as `psm-infra`. All three
  connections are bound and report no missing secret slots. What is stale is the host
  connection's `allowedTargetRootPrefixes`, still
  `["/var/www/a6s1j3p3zh.werewolf.solutions"]` — the superseded generated hostname. That
  single mismatch is why `directory`, `ingress` and `certificate` all read "differs from the
  target contract".
- **The GitHub account can create the control repository.** It is an org **admin**
  (`role: admin, state: active` in `Werewolf-Solutions`) and holds `repo`; `admin:org` is not
  what repository creation needs. The repository genuinely does not exist — confirmed by
  listing all 26 org repositories including private ones, not by a lookup that failed — but
  "could not create it" was not the reason.

PSM's own verdict is now exactly two blockers, with `canPrepare: false`:

| Blocker | PSM's message |
| --- | --- |
| `connection:host` / `connection-missing` | target root is not within an allowed component-aware prefix |
| `release-controller:web` / `release-controller-unpinned` | the github connection has no reviewed release workflow for `werewolf:todo-staging-web`; PSM pins it once it can read the release repository |

**The action pin is no longer one of them.** `docs/deploy/controller/release-static.yml` now
pins `actions/create-github-app-token` to a resolved, reviewed, signature-verified commit
SHA — see that directory's README, "The action pin". The four remaining `REPLACE_…` values
in `targets/*.json` are all enrollment-derived and are deliberately still blank.

So the smallest remaining operator actions are:

1. Widen the host connection's allowed root prefix to `/var/www/todo.werewolf.solutions`
   (connection `con_67802210-4432-4790-847b-4edaedd9cea5`). It widens what a live-droplet SSH
   credential may reach, so it is an explicit decision rather than a tidy-up.
2. Create `Werewolf-Solutions/deployment-control` from `docs/deploy/controller/`, register and
   install the GitHub App named in its README, and add a GitHub Environment `todo-staging-web`
   holding `PSM_TARGET_SSH_PRIVATE_KEY` and `PSM_TARGET_KNOWN_HOSTS`. App registration is a
   web-UI action and cannot be done from a checkout.

DNS still reports `state: create`, which is right: the manifest's `digitalocean-dns-record@1`
creates the A record **as part of a release**. Creating it by hand first would point the name
at a host that is not serving.

Two other things worth carrying forward, both verified on 2026-09-21:

- The artifact pipeline was run end to end twice and produced a **byte-identical**
  `archiveDigest` (`sha256:bd5d4be7…`), with `version.json` carrying the version and commit.
- PSM reads the **committed** tree: `source.version` is `0.5.2` with `inputsDirty: true`,
  because todo-app's 0.6.0 bump and its workspace client are uncommitted. A release today
  would ship 0.5.2, not the workspace work.

Full detail, including the browser verification and the two PSM sign-in defects found while
doing it, is in [../roadmaps/workspace-implementation-status.md](../roadmaps/workspace-implementation-status.md).
