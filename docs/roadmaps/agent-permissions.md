# Project agent permissions

## Outcome

A preparation workroom has effective permission to edit, stage and commit before
it starts. Missing authority is a readiness blocker, never a failed repair
attempt. Grants originate in the local cockpit, never in chat or repository
configuration. Publication and infrastructure require separate operator reviews.

## Implemented and verified

- [x] Store project/checkout-scoped grants and an append-only permission audit
  trail in PSM's database. Missing grants and legacy identity files grant nothing.
- [x] Define preparation requirements and instructions together. Check before
  repairs, on resumed turns and after engine changes; preserve attempt budgets.
- [x] Route Claude project/workroom turns through the SDK repository broker.
  Disable built-in tools, filesystem settings and automatic external MCP loading.
- [x] Route Codex project/workroom turns through app-server dynamic tools backed
  by the same broker. Start fresh ephemeral threads, disable inherited executable
  integrations, deny native approvals and restrict native filesystem/network access.
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

## Host setup and validation

These are runtime prerequisites, separate from the completed implementation:

- Codex must be installed and authenticated as the PSM user. The adapter was
  checked against app-server **0.154.0**: an actual thread-start accepted its
  restricted policy and dynamic tools. Protocol tests exercise tool calls;
  validation did not spend a model turn. See the official
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
are not proof of safety: every invocation requires an exact operator review,
including tools advertised as read-only. Tool discovery starts the attached
server; it does not authorize tool calls. Approval cannot undo an external action
already sent, and revocation prevents subsequent broker calls.

This is not OS isolation against another process running as the operator.
Workspace chat, operator terminals and other applications retain their own
permissions. File deletion, branch switching/deletion, merging, fetching and non-force pushing are separate standing grants. Remote operations accept only configured remote names and validated refs; models cannot supply remote URLs or arbitrary Git flags. PSM's running code cannot be edited by its managed agents; use a separate development checkout.
