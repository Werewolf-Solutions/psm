# Project agent permissions

## Outcome

A preparation workroom has effective permission to edit, stage and commit before
it starts. Missing authority is a readiness blocker, never a failed repair
attempt. Grants originate in the local cockpit, never in chat or repository
configuration. The original implementation required separate operator reviews
for publication and infrastructure; later policy support and the planned
automation path are distinguished below.

**Scope of this record (2026-10-05 reconciliation):** the checklist below records
the original managed implementation; the P02 section records later standing
policy support. Where the two describe different behavior, the dated P02 behavior
supersedes the baseline. The [evidence register](acceptance-evidence.md) tracks
local editor/browser acceptance, open delegation and P05 provider/browser gates. P12 extends exact-source and
release authorisation to accepted automatic environment policies, so publication
and infrastructure may use explicit covering policy instead of a fresh click.
That future path is not claimed as implemented here.

## Implemented and verified

- [x] Store project/checkout-scoped grants and an append-only permission audit
  trail in PSM's database. Missing grants and legacy identity files grant nothing.
- [x] Define preparation requirements and instructions together. Check before
  repairs, on resumed turns and after engine changes; preserve attempt budgets.
- [x] Route Claude project/workroom turns through the SDK repository broker.
  Disable built-in tools, filesystem settings and automatic external MCP loading.
- [x] Route Codex project/workroom turns through app-server dynamic tools backed
  by the same broker. The original baseline used fresh ephemeral threads; the P05
  increment below adds managed continuity. Inherited executable integrations and
  native approvals remain disabled, with restricted native filesystem/network access.
- [x] Check the current grant revision on every broker operation. Stop affected
  turns and clear queued work when grants change. Never resume legacy CLI sessions
  into managed execution.
- [x] Protect authority files, credentials, Git internals and attached executable
  provider projects. Reject traversal, links and nested repository scope escapes.
- [x] Stage explicit files and commit only broker-staged changes. Preserve
  unrelated staged work and disable hooks, filters, signing and external diff tools.
- [x] Implement `test.run`: named `test`/`test:…` scripts or `node --test` run in a
  disposable offline Docker container with bounded resources and read-only host
  inputs. Test output is returned; generated files do not modify the checkout.
- [x] Implement `pkg.install`: verify public npm tarballs against lockfile SHA-512
  integrity, then run `npm ci --offline --ignore-scripts` inside the sandbox.
  Tests reuse the prepared dependency inputs for that turn. Project edits require
  a fresh installation. No lifecycle scripts execute during installation.
- [x] Implement `mcp.use`: discover explicitly attached, unchanged MCP servers and
  submit calls for individual operator review. Bind reviews to the project grant
  revision, attachment digest, tool and arguments. Persist decisions/results;
  reject expired/replayed reviews and changed or detached integrations.
- [x] Add exact-source publication before GitHub artifact builds. Show repository,
  branch, old/new commit IDs, commits and changed-file statistics. Bind approval
  to source, policy and credential revisions with a short-lived one-use intent.
  Publish from an isolated bare repository, require a fast-forward and use an
  exact remote-ref lease to reject concurrent writers. Verify publication before
  dispatching the build. Managed deployment keeps this exact-review path; operators may now separately grant bounded standing `git.fetch` and non-force `git.push` access to configured remotes.
- [x] Pause Make ready for publication approval, then continue the build and
  infrastructure preparation automatically. Cancellation invalidates pending
  publication reviews; failures require a fresh review.
- [x] Resume permission/checkout-blocked preparation when its prerequisites are
  satisfied, while retaining the distinction between Git checkout problems and grants.
- [x] Route source defects to repository repair and external dependencies,
  credentials, provider setup and policy decisions to an explicit setup pause.
  Preserve upstream project/connection ownership, group shared connection causes,
  and spend no repair attempts on external-only failures. Mixed reports repair
  local source first. Resource drift uses the infrastructure approval path.
- [x] Reconcile stale cached credential-presence flags with the secret broker
  before runtime observation, with metadata/generation checks that preserve
  invalid profiles. Presence still does not assert successful provider authentication.
- [x] Show grant provenance, MCP call reviews and grouped deployment-connection
  diagnostics in Capabilities. Group grants by repository, local Git, remote Git,
  execution and integrations; support atomic category grants and full managed
  access. Preserve the existing Attached tools surface.
- [x] Test grant forgery, stale revisions, revocation, protected files, real Git
  staging/committing, Codex tool routing, sandbox arguments, reviewed MCP calls,
  publication races, API origin/policy/intent enforcement and preparation resumption.
- [x] Pass TypeScript checking, the complete test suite and browser smoke checks
  for attached-call review and exact-source publication.

## Policies, reviews and presets (P02, 2026-09-24)

- [x] Standing grants are kept as unscoped Allow rules; migrated projects keep identical
  authority. Scoped Allow / Ask / Deny rules add environment, connection, attached tool, task and
  one-exact-operation scopes, and once / task / until / standing durations. Most specific wins;
  Deny beats Ask beats Allow; a workspace Deny beats the project. Decisions name their rule.
- [x] Only authority reductions invalidate running turns (`restricted_revision`); approvals and
  new grants let the task continue.
- [x] Ask becomes an operator review recording the exact operation; answers: once (bound to the
  operation digest), this task, always, reject. Push approvals bind commit, remote and branch.
- [x] Attached MCP calls follow `mcp.call`: Allow runs directly, explicit Deny refuses, no rule
  keeps the exact per-call review; a review can be answered "always allow this tool".
- [x] `machine.command`: commands on connected servers as the environment's verified command
  account (P01), per-environment rules.
- [x] `deploy.approve`: standing approval of Make-ready infrastructure plans; see
  DEPLOYMENT-SYSTEM.md §7.3 for the acknowledgement rule.
- [x] Versioned presets (Inspect, Develop, Operate staging, Operate production, Full access to this
  project), each stating what it grants and what remains impossible. "Grant full access" is gone.
- [x] Access explanation per task (ready / needs review / grant / connection / runner / provider
  restricted / unsupported) in Capabilities and as the agents' `access_status` tool.
- [x] Workspace chat's former Unrestricted toggle was retired; CLI sessions now keep
  their sandbox enabled even when an old saved setting or request asks for full access.
- Open at the September 24 checkpoint: delegation between people (needs hosted
  workspace authentication, P03) and workspace-rule editing UI. The October 5
  increment below implements the local editor; delegation remains open.

## Workspace restriction editor (P02, 2026-10-05)

- Implemented **Capabilities → Agent permissions → Workspace restrictions** for
  the project's owning workspace. Add/remove standing or expiring Deny rules,
  scoped by environment, connection, capability and tool, with audit history.
- Expected revisions prevent stale edits. Local operator metadata is required;
  business management authority is rechecked through Werewolf for each request.
- New restrictions stop affected turns/queues and fence older broker snapshots
  and retained provider sessions. Removing a restriction leaves project grants
  intact and does not resume stopped work.
- Automated enforcement, role, lifecycle and UI-handler checks are recorded in
  the [evidence register](acceptance-evidence.md). Rendered browser and hosted
  acceptance remain open. [Full editor contract](workspace-policy-editor.md).

## Managed Codex continuity (P05, 2026-10-05)

- Resume only PSM-managed threads with matching scope, restriction revisions,
  selections and tool catalog. Each turn uses a fresh native directory and broker.
- Missing history/catalog changes may fall back before turn start. Active-turn
  errors, interrupted turns and authentication failures are not automatically replayed.
- Real Codex 0.160.0 two-turn acceptance verified brokered reading and retained
  context across process restart. [Contract and retention](managed-codex-continuity.md),
  [native evidence](../evidence/codex-managed-continuity-2026-10-05.json).

## Host setup and validation

These are runtime prerequisites, separate from the completed implementation:

- Codex must be installed and authenticated as the PSM user. The adapter was
  initially checked against app-server **0.154.0** without a model turn;
  managed continuity now has actual two-turn acceptance on **0.160.0**.
  Protocol tests exercise broker calls and restricted resume. See the official
  [app-server documentation](https://learn.chatgpt.com/docs/app-server).
- The PSM user needs access to a working Docker daemon and a preloaded Node/npm
  image. The default is `node:22-bookworm-slim`; the operator can set
  `PSM_TASK_IMAGE` on the PSM process to a compatible preloaded image or digest.
  PSM uses `--pull=never` and never silently substitutes an unrestricted runner.
  On the host, check `docker info` and `docker image inspect node:22-bookworm-slim`;
  preload the image with `docker pull node:22-bookworm-slim` when needed.
- **This development host (diagnosed 2026-09-21):** the daemon is running and the
  PSM user *is* in the `docker` group — `getent group docker` → `docker:x:984:oznerol`,
  and `docker ps` works in a new shell. What is denied is **the running psm
  process**, which was started before that group membership existed:

  ```
  /proc/<psm pid>/status →  Gid: 1000   Groups: 4 24 27 30 46 100 114 1000
  a new shell            →  Groups: 4 24 27 30 46 100 114 984 1000
                                                           ^^^ docker
  ```

  A process's supplementary groups are fixed at exec and never re-read, so no
  amount of `usermod` reaches a psm that is already up. **The fix is to restart
  psm from a session that has the group** — there is nothing to configure and no
  capability to add. `describeDockerConnectionFailure` in
  `src/server/agent-task-runner.ts` now says this instead of surfacing the bare
  `permission denied`, which had been read as a failing test.

  **Done, and verified 2026-09-21.** psm was restarted from a session holding the
  group; the new process shows `Groups: … 984 …`, `node:22-bookworm-slim` was
  already preloaded, and a disposable container ran under the sandbox's own flags
  (`--pull=never --network=none --read-only --tmpfs /tmp`) and printed
  `v22.23.2`. Container execution on this host is no longer a prerequisite.
- Install support currently covers npm lockfiles v2/v3 containing public
  `registry.npmjs.org` packages with SHA-512 integrity. Private registries,
  workspace/file/Git dependencies and package-version resolution are not supported.
  Installs prepare disposable test inputs; they do not rewrite a project's lockfile.
- GitHub publication needs a connection token with repository Contents write
  permission; changes to workflow files may also require Workflows write.
  Branch protection still applies. Validation uses mocked provider calls and does
  not publish a project or trigger a real GitHub workflow.

## Enforced boundary

The tool broker owns standing grants. Repository content, chat, MCP annotations
and model-selected commands cannot create authority. Claude has only PSM tools;
Codex receives equivalent dynamic tools, with native execution disabled/restricted.
Missing grant keys and unknown engines fail closed.

Tests execute project code only within an offline container: no host checkout,
credential directory, Docker socket or PSM authority database is writable or
available. Source inputs and verified package tarballs are mounted read-only;
all execution writes use size-limited tmpfs. Calls are serialized per project and
turn, bounded by time/output/resources, and containers are removed after execution.

Attached integrations are trusted operator-selected services. Their tool hints
are not proof of safety: an invocation runs only under an explicit `mcp.call` rule
for that tool, otherwise it requires an exact operator review, including tools
advertised as read-only. Tool discovery starts the attached
server; it does not authorize tool calls. Approval cannot undo an external action
already sent, and revocation prevents subsequent broker calls.

This is not OS isolation against another process running as the operator.
Workspace chat, operator terminals and other applications retain their own
permissions. File deletion, branch switching/deletion, merging, fetching and non-force pushing are separate standing grants. Remote operations accept only configured remote names and validated refs; models cannot supply remote URLs or arbitrary Git flags. PSM's running code cannot be edited by its managed agents; use a separate development checkout.
