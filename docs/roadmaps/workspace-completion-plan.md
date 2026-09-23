# Werewolf workspace integration: completion plan

Date: 2026-09-21. Requested implementer: Claude Code, Opus.

## Outcome and boundaries

Werewolf Dapp is the account/business entry point and application launcher. Todo and PSM support distinct personal and business workspaces. PSM manages existing/new projects and provides the repeatable deployment path. First deployment target: Todo staging at `https://todo.werewolf.solutions`, using staging identity/API at `https://staging.werewolf.solutions`.

Finish the existing implementation; do not rebuild identity, move all repositories into a monorepo, introduce an event broker, provision a new fleet, or replace the deployment security model. Preserve independent products and product-owned data. Business membership must not confer local filesystem, agent, infrastructure or deployment authority. Keep personal PSM use available offline. Never mix staging and production identity.

Read applicable repository instructions before changing files. Existing user edits belong to the user: no blanket stash, resets, destructive checkout, or commits that sweep up unrelated changes. No production deployment, purchases, credential invention, broad permissions or live data/index changes without the required authority and safeguards. Do not print secrets.

## Reviewed baseline (verify before applying)

| Repository | Main checkout | Existing feature work |
| --- | --- | --- |
| werewolf-dapp | Clean `dev`, `938e297`, version 0.5.1 | Workspace/catalog feature already incorporated. Worktree branch `workspaces-integration` at `95fc3fc` is behind main. Do not reapply it. |
| todo-app | Clean `master`, `fd447a9`, version 0.5.2 | `.claude/worktrees/workspaces`, branch `workspaces-integration`, feature `faf5614`; baseline snapshot `a3d8a7d`. Adopt the feature-only diff, preserving main's newer staging configuration. |
| psm | Dirty `dev`, `0740bc5`, version 0.2.8 | `.claude/worktrees/workspaces`, branch `workspaces-integration`, feature `6e5a841`; baseline snapshot `2b61b87`. Adopt feature-only changes, preserving all current user edits. |

The snapshot commits include pre-existing work, not just workspace functionality. Do not merge/cherry-pick the snapshot history wholesale. Inspect three-way overlaps, especially PSM server registration and web assets. Record original status/diffs outside tracked source so preservation can be checked. Deliver integrated, runnable main checkouts, not an implementation stranded in worktrees. If an overlap cannot safely be resolved, document the exact conflict and continue independent work.

Prior focused review passed 31 Dapp integration tests, 9 PSM workspace tests and 8 Todo tests. These are a baseline, not proof of completion. The implementation status document is stale: Dapp 0.5.1 was subsequently deployed to staging. Latest `938e297` CI/deploy failed the version gate; last successful deployment was `95fc3fc`. Todo DNS last returned ENOTFOUND. Recheck current state before acting.

## 1. Fix PSM project reassignment authorization first

Confirmed reproduction: assign a personal project to business A while authorized; remove membership; make a signed-out PUT assigning it to `personal`. The feature endpoint returns 200 and deletes the business assignment. It checks the destination workspace but not the source (`src/server/workspaces.ts`, approximately lines 170–194 in the feature worktree).

Load the existing assignment and require current write authority for both source and destination before any state or identity write. Validate canonical references and fail closed on unavailable membership verification for business operations. Personal-to-personal/offline personal behavior must remain supported. Distinguish changing local project metadata from moving any linked cloud data; do not silently change cloud ownership.

Regression tests: signed-out, revoked-member and viewer cannot move business A to personal or business B; unauthorized destination also fails; writable source and destination succeed. Failures leave assignment/state/project identity unchanged. Test offline personal behavior and ensure pairing/local capability checks are not weakened.

## 2. Review and harden Todo ownership and transfers

Keep all server reads/writes scoped by selected workspace, live membership and role. Test two users and two businesses; viewer cannot write; membership revocation takes effect without a new login. Preserve personal isolation, business private/team visibility and existing personal data compatibility.

Review `services/todoTransfer.js`: multi-record week/day/task moves currently update children before parents without a transaction. Source-scoped retries can miss already-moved children after partial failure. Add injected-failure and retry tests, including concurrent modification. Establish actual database transaction capability; implement atomic transfer where supported or an explicit recoverable protocol. If safe transfers cannot be provided within scope, disable unsafe operations with a clear response rather than advertise success. Do not reconfigure live MongoDB to gain transactions.

Review whether container moves can reveal other users' private children, especially when changing business or visibility. Enforce the agreed ownership/privacy rule explicitly and test it; this is an investigation item, not a previously proven exploit. Avoid broad unrelated schema changes.

## 3. Complete the user journey and truthful app catalog

Integrate Todo's WorkspaceContext/switcher and PSM's workspace UI into the actual development checkouts. Exercise: account login, business selection/creation, application launch carrying workspace reference, permitted selection, task creation/listing, PSM project assignment and return navigation. Never carry access tokens in launch URLs.

Make membership/load failures visible. Todo's current provider appears to set an error while falling back to personal state, potentially hiding the failure; do not silently create personal tasks when a business selection could not be verified. Test switching during in-flight fetches and auth retries so an operation stays bound to its originating workspace and stale responses cannot overwrite the current selection.

App registration is not deployment readiness: a registered Todo callback must not alone produce an enabled Open button for a hostname that is not deployed. Use explicit environment-specific readiness/configuration, not per-request public DNS checks. Preserve separate `supportsWorkspace` and launch availability concepts.

PSM is a hosted cockpit plus a paired local agent, not solely a desktop product. Reflect that accurately. Only offer hosted launch URLs verified for the current environment; do not point staging sessions at production PSM as a workaround. Keep missing pairing and missing business authorization distinct in UI and APIs.

## 4. Versions, migration safeguards and verification

Fix the Dapp version-gate failure with the appropriate version increment for the resulting change; do not weaken the gate. Apply each repository's version conventions to integrated Todo/PSM releases. Run focused new regression tests, existing relevant suites, type checks and production builds available in each repository. Check diffs for whitespace/errors and preservation of baseline edits.

Run local/browser integration against disposable accounts/data, covering personal and business paths, two-user isolation, viewer/revocation behavior, direct API denials and workspace deep links. Clearly distinguish automated checks from manual checks not performed.

Inspect the actual staging migration/index state read-only before proposing any migration. `server/scripts/migrate-todo-workspaces.js` uses `syncIndexes()`, which can remove unrelated indexes: ensure intended indexes and preservation are explicit. Do not repeat a migration merely because an old status document says it is pending. Live mutations require verified target, backup/rollback and authorization.

## 5. Complete the PSM-controlled Todo staging rollout

Read `docs/deploy/TODO-STAGING.md`, `docs/deploy/controller/README.md`, Todo's `docs/DEPLOY.md`, and active `.psm/deployments.json`. Recheck real deployment/access state; prior controller/host blockers may have changed during the user's later Claude session.

The active Todo target is staging at `todo.werewolf.solutions`; the former production manifest is reference material, not another active target for the same hostname/root. Build off-host for the constrained VPS. Use existing enrollment, pinned controller workflow/source artifacts, scoped release identity, approval and rollback mechanisms. Complete missing repo-owned code/tests/configuration where possible; do not bypass these mechanisms with ad hoc SSH or fabricated readiness.

Use the already requested staging scope only. Before remote mutation verify the actual host, branch/artifact, routing, environment, credentials and rollback. Missing authority, controller repository access, DNS control or host enrollment is a specific blocker, not permission to relax checks. Do all independent local work before reporting that blocker. Do not create paid resources or touch production.

If staging prerequisites are present, execute the intended staging workflow and verify DNS, valid TLS, HTTP health, built version, staging auth redirect/callback, personal/business operations, isolation and rollback artifact availability. If not, provide the exact one-time setup/actions needed; do not claim deployment success from a local build or a SPA HTTP 200.

## Acceptance and handoff

- All three main development checkouts contain the integrated changes, with pre-existing PSM work preserved and clear diffs.
- Source-and-destination authorization regression tests pass; no business authority leaks into local/deploy capabilities.
- Todo isolation and transfer failure behavior are tested; unsupported unsafe operations fail clearly.
- Workspace selection and launcher behavior are environment-correct and failure-visible.
- Relevant tests/builds and version checks pass, or failures have reproducible commands and ownership.
- Todo is verified at its staging URL through the intended deployment path, or remaining external prerequisites are explicit and limited.

Update `docs/roadmaps/workspace-implementation-status.md` with actual code locations/branches, versions, test results, integration state, deployment evidence and remaining blockers. Distinguish modified, committed, pushed and deployed. Leave a concise final summary; do not report planned work as completed.
