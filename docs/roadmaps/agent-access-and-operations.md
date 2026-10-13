# PSM agent access and software operations

Execution order and resume state: [PSM delivery index](README.md).

Proposed plan, 2026-09-23. This document records the requested product direction;
it does not grant access, change runtime policy, or authorize a live deployment.

## Outcome

PSM should carry an authorized software task from investigation through editing,
testing, deployment, verification and maintenance. An owner can connect accounts
and runners, select a useful preset in one action, or control each operation and
resource. Once access is granted, the assistant continues without repeatedly
asking for the same authority or turning executable work into a manual runbook.

“Full access” must mean full authority within the explicitly selected accounts,
resources and execution environment. Display that scope next to the control.
Connecting an account, granting the agent access, and having a working tool are
three separate requirements. A permission toggle cannot supply a missing API,
provider entitlement, credential or administrator identity.

## Historical diagnosis: September 23 checkout

The findings below explain the original plan, not the current implementation.
P02/P04/P05 subsequently delivered several of these capabilities. Use the
[acceptance evidence register](acceptance-evidence.md) for dated results and
remaining gaps.

The quoted answer alone cannot establish why two complete conversations differ.
Model, effort, earlier context and available credentials may also differ. These
implementation differences are directly observable:

| Finding | Evidence | Effect |
| --- | --- | --- |
| Full managed access contains only 12 permission keys | `src/server/agent-permissions.ts`, `web/agent-permissions.js` | No general command, SSH administration, browser, research or deployment tool is granted by this button. |
| Codex native execution, browsing, integrations and skill discovery are disabled | `src/server/agent-codex-runtime.ts`, `codexManagedConfig` | The model receives PSM's small dynamic tool set inside an empty temporary directory. |
| Claude built-in tools and inherited settings are disabled | `src/server/agent-permission-runtime.ts`, `managedAgentOptions` | Both providers operate through the same restricted repository broker. |
| Managed turns use fresh provider sessions | `src/server/ai.ts`, `startTurn`; both provider adapters | PSM injects up to 30 recent non-system events, capped at 48,000 characters, rather than preserving the provider's full working context. |
| External diagnosis explicitly forbids fixing host/connection problems | `src/server/deploy/repair-sessions.ts`, `repairBrief` | The assistant is instructed to provide operator actions and stop. |
| Every attached MCP invocation needs an exact review | `src/server/agent-mcp-tools.ts`, `agent-permission-runtime.ts` | A standing integration grant still interrupts every call. |
| Execution only supports restricted tests and dependency preparation | `src/server/agent-task-runner.ts` | Normal builds, typechecks, development servers, private dependencies and other languages cannot be assumed available. |
| Enrollment requires an administrator outside the deployment connection | `host-helper/README.md`, `docs/deploy/CONNECTIONS.md` | A release key cannot perform the enrollment in the user's example. |

There are already useful components: revisioned grants and audits, connection
profiles, a secret broker, deployment plans, immutable artifacts, locks, recovery,
verification and rollback. Extend these rather than building another deployment
engine. Existing documents disagree about some live setup status; this review
inspected local code and documentation and did not verify remote infrastructure.

## Product experience

Add one **Access & connections** destination at workspace and project level,
reachable from chat, deployment readiness and settings. Keep public capability
discovery separate from granting authority, but present both in this destination.

The main flow is:

1. **Connect** an account or machine using OAuth/app installation, a secure token
   form, SSH identity, or runner pairing. Show the connected account identity.
2. **Select scope**: workspace, projects, repositories, environment, hosts,
   cloud resources and runner. Offer discovered resources with their source.
3. **Choose access** using a preset or Customize. Show the resulting authority,
   whether it includes production, and any remaining provider limitations.
4. **Start**. Reuse these grants across subsequent authorized tasks. Show progress,
   results and pending decisions in the same work view.

For an already connected scope, applying a preset takes one action. A new account
may still require provider login/consent or initial machine administrator access.
Do not promise that a single button can bypass those external prerequisites.

| Preset | Intended behavior |
| --- | --- |
| Inspect | Read selected code, documentation, deployment status and permitted logs. |
| Develop | Edit, install, build, test, preview and use approved development tools. |
| Operate staging | Develop plus configure, deploy, restart and roll back selected staging resources. |
| Operate production | Manage selected production resources, with review frequency chosen by the owner. |
| Full access to selected scope | All supported operations within the shown resource and runner scope, including administration where connected and granted. No repeated per-operation approval inside that grant. |
| Custom | Configure individual actions, resources, execution authority and review frequency. |

Custom rules support **Deny / Ask / Allow**, with allow-once, task, time-limited
and standing durations. Include paths, repositories/branches, hosts/users,
environments, API operations, network access, secret usage, provisioning limits
and maintenance schedules. Production deployment, resource deletion and database
changes can also be standing grants when the owner explicitly chooses them.

Search by intent as well as provider: “deploy this app”, “fix DNS”, “read logs”,
“manage my server”. Each result shows **Ready / Needs connection / Needs grant /
Provider restricted / Unsupported**, with a direct action. Expose the same
inventory to the assistant through capability discovery and access explanation
tools. Tool names alone are insufficient context.

## Authority and execution design

Use one versioned decision service for chat tools, background jobs, integrations
and deployments. A grant records actor, workspace, project, connection, resources,
actions, runner, constraints, duration and revision. The server returns allow,
review-required or deny, with the rule responsible and the next available action.

Effective authority is the intersection of workspace policy, the user's ability
to delegate, provider credentials, resource scope and the execution environment.
Project overrides cannot defeat a workspace denial. Repository files, retrieved
content and model messages can propose changes; only authenticated operator
controls create grants. A chat request can open that control inline.

Reuse exact deployment plans, source pins and apply-time checks. Add two ways to
authorize a plan: a specific review or a matching standing policy. Record the
exact plan and policy revision in both cases. This intentionally changes the
current requirement for a fresh human review of every publication/infrastructure
plan; update the existing specification and tests when implementing it.

Likewise replace mandatory per-call MCP reviews with the selected connection and
tool policy. Tool descriptions claiming “read-only” do not grant authority.
Provider scope restrictions remain visible. The current Werewolf attachment is
explicitly read-only; this plan does not expand it to customer data or payments.
Any future administrative interface needs its own provider implementation and
explicit connection/consent.

### Execution profiles

Provide both a managed runner for constrained access and an explicitly selected
administrator runner for broad machine control. Keep the assistant's shell,
file operations, terminal sessions, browser and provider tools available where
the selected profile can actually enforce their grants.

An arbitrary shell can invoke APIs and read every credential accessible to its
process. Root can change the host's controls. Therefore a “deny deploy” checkbox
cannot be promised alongside unrestricted shell access to deployment credentials
on the same machine. Enforce fine controls using process/container or VM
boundaries, filesystem mounts, network controls and brokered credential leases;
display broader authority when selecting host shell or root administration.
Do not implement the boundary by matching command strings.

The administrator path can manage arbitrary supported CLIs and software on a
selected execution machine or connected target host. It must explicitly show which machine, OS identity and account
credentials are reachable. Keep the policy authority outside a runner on which
the agent has root when independent enforcement is required. Revocation blocks
new operations and cancels work where possible; it cannot undo an external action
already accepted by a provider.

On a PSM-hosted runner, full access can include root inside an isolated customer
execution environment and explicitly connected remote hosts. It never means
administration of PSM's shared control service, host infrastructure or other
customers' environments. The UI must make that scope explicit.

### Context and provider adapters

Preserve supported native provider tools when they fit the execution profile.
Supply broker equivalents when required by narrower scope. Make missing provider
features visible instead of advertising parity that has not been verified.

Maintain a durable task record: objective, user decisions, grants, involved
projects, artifacts, pending questions, completed operations and next action.
Resume provider sessions when compatible with current authority; otherwise
start a fresh session with this record and relevant history. Every tool call
still checks current policy. Permission changes must not lose the task.

Load applicable repository guidance and selected skills with provenance. Rules
about asking for approval must agree with the user's standing policy; surface
actual conflicts. Give the agent verified machine identities, working
directories, relevant file locations and connection health. Do not guess facts
such as a certificate contact address.

## First milestone: prepare deployment machines

**Product feature:** [Machine onboarding through the PSM web app](machine-onboarding.md)
defines the reusable wizard, automatic bootstrap, copyable one-time fallback,
workspace ownership, project reuse and hosted execution requirements. This flow
replaces manual server-specific setup as the intended user experience. Register
each machine once, then provision scoped access for each project/environment.

User direction, 2026-09-23: begin with the machines that will host applications
and provision distinct users through which PSM can execute commands. Use the
home homelab setup as the reference. PSM-hosted AI runners remain the SaaS
execution model; deployment targets are the separate machines they operate.

The user selected **46.101.29.222 (werewolf-alpha)** as the first target. Remote
inspection confirms existing `psm-infra` and `psm-release` accounts and an active
host helper. The prepared command-account bootstrap and verified status are in
[the first machine runbook](../deploy/machines/todo-staging/README.md). Its
read-only preflight passed; account creation has not been performed. Following
the user's request for a web-app feature, treat this script as implementation
reference and build the reusable onboarding flow instead of requiring the user
to continue a manual runbook. PSM command-tool and hosted-runner wiring are
required parts of that product flow.

### What the homelab already demonstrates

Reviewed `/srv/homelab/AGENTS.md`, `README.md`, `installer/README.md`, SSH client
configuration, and `daedalus/deploy/homelab/` installer and systemd units:

- The installed server has a human administrator, `homelab`, using a dedicated
  SSH key, key-only SSH login and strict host-key verification. Initial install
  and ongoing server access use separate connection configurations.
- The installer creates `daedalus` as a system account with its own group,
  `/var/lib/daedalus` home and `/usr/sbin/nologin` shell. The core service runs
  as this unprivileged identity.
- Executables and service definitions are root-owned. A separate root executor
  listens on a local Unix socket and accepts typed service-restart requests for
  an exact allowlist. This is not a general SSH command-execution account.
- Daedalus's dashboard is exposed through private Tailscale access; the backend
  binds to loopback. Application builds are produced on the main PC and copied
  to the server.

These are facts from saved setup files, not a new verification of the running
host. The current attempt to connect through `homelab.local` failed name
resolution, and the saved `10.42.0.215` address timed out. Do not assume the direct
Ethernet topology is still active.

### Machine account model

Names below are proposed roles; persist the actual allocated names and UIDs.
Create only the roles selected for that target, scoped per project/environment
when they need separate authority.

| Identity | Purpose | Authority |
| --- | --- | --- |
| Existing human administrator | Initial bootstrap and recovery | Existing administration rights; bootstrap credential use is explicit. |
| `psm-exec-<scope>` | Run real commands and maintenance tasks over SSH or the target agent | Login/exec-capable account with its own working directory, selected files and credentials; no sudo by default. |
| `psm-release-<scope>` | Publish and activate app releases | Separate key, forced host-helper command and target-scoped release UID; no general shell or sudo through this key. |
| `psm-infra-<scope>` | Manage selected nginx/TLS/target resources | Separate UID/key, forced host-helper command and infrastructure UID enrollment. |
| `app-<scope>` | Run the deployed application | Non-login service account owning only its required runtime data; no deployment credentials. Static-only apps may not need this account. |
| Optional `psm-admin-<scope>` | Broad server administration selected by the owner | Explicit root-equivalent access to this target, separately credentialed and audited. |

Existing `psm-host-helper` already checks separate `infrastructureUids` and
`releaseUids` against the Unix socket caller. Its installer currently creates
the group and service, but not these SSH users or their keys. Extend that
onboarding path. Do not try to use the release account for arbitrary commands
or enrollment: initial enrollment requires the bootstrap/admin path.

SSH accounts must have a shell compatible with their selected forced-command
transport; copy `nologin` only for accounts that never use SSH execution.
Different keys on one shared Unix user do not provide separate UID-based helper
authority. An app account must not be able to replace a privileged helper,
systemd unit or script executed by root. Any scoped sudo rule must name a
root-owned validated entry point; arbitrary command access plus unrestricted
sudo is the explicitly broad administrator profile.

### Add machine flow

1. **Identify:** select an existing server or provision through a connected
   provider. Record its host identity, address, OS, architecture and reachable
   transport. Offer verified SSH or an outbound target-agent connection for
   private hosts; a hosted runner cannot assume access to LAN mDNS names.
2. **Inspect:** read current users/groups, paths, services, available resources
   and privilege mechanism. Preserve an existing recovery login. Unsupported
   hosts get a concrete explanation before any installation.
3. **Choose access:** select projects/environments and presets such as Run
   commands, Deploy apps, Manage infrastructure or Full server administration.
   Expand to see exact account, file, service and privilege effects.
4. **Preview and apply:** generate an idempotent bootstrap plan, obtain the
   selected administrator authority once, create missing accounts/directories,
   install verified helpers and selected public keys, and enroll target roles.
   Resolve conflicting existing accounts explicitly; never silently take over
   an existing UID, home or shared application directory.
5. **Verify:** authenticate separately as each selected identity, run a harmless
   command where shell access was selected, test scoped file/service operations,
   prove prohibited access is rejected and read back enrolled UIDs/revisions.
   Mark only verified capabilities ready.
6. **Operate:** save connection metadata, credential references and a bootstrap
   receipt. Discard one-time bootstrap leases, then resume the waiting deployment
   task. Support key rotation, revocation, drift checks and removal with a preview
   of owned resources; do not delete app data as part of disconnecting a machine.

Use separate credentials for each target/scope and keep private keys out of chat,
repository manifests and logs. Re-running setup must not duplicate users, rotate
keys unexpectedly or overwrite existing service configuration. Persist completed
steps and reconcile after interruption before attempting a change again.

The initial implementation targets existing Ubuntu/systemd hosts used by this
workspace. Provisioning a whole new VM, installing an OS and configuring an
existing host are distinct workflows; the homelab's PXE/disk installation is
not part of ordinary PSM app onboarding.

First acceptance: a selected machine appears in PSM, its chosen accounts and
permissions are verified, and an authorized command runs from a PSM-hosted
runner under the expected remote UID. Then execute the enrollment/deployment
case below. Account creation alone does not satisfy the acceptance criterion.

## The enrollment example as the first deployment acceptance case

The intended user experience is: **Prepare Todo staging → review missing access
and required values → Grant and continue → deployment verified**.

1. Read the existing target file and current enrolled contract. Show the exact
   hostname, host identity, target root and proposed change. Ask for the TLS
   contact only when no confirmed value exists.
2. Identify that the connected release account cannot enroll targets. Offer
   **Connect administrator access** or use an already authorized bootstrap runner.
   Do not retry the release key as if permissions were a connectivity problem.
3. Present one operation preview covering transfer, enrollment and connection
   update, bound to the host identity and expected contract revision. Honor an
   existing standing grant when it covers these actions.
4. Transfer the validated payload over the verified connection, run enrollment
   through the administrator executor, capture the actual revision/fingerprint,
   and update the PSM connection with a revision check. Use restricted temporary
   storage and clean up the payload.
5. Re-test the connection, clear the blocker and resume preparation automatically.
   Handle enrollment success plus connection-update failure by reading back and
   reconciling state; do not blindly replay privileged actions.
6. Continue source preparation, publication, build, infrastructure setup, release
   and verification under the chosen policy. Report the resulting URL and evidence.

Manual instructions remain available when the owner chooses manual setup or no
administrator channel exists. Commands then name their execution machine and
use verified paths. No placeholder `target.json` is presented as a prepared file.

## Runners and SaaS operation

The current hosted UI is static and uses a paired local agent. Remote unattended
work therefore needs an additional execution service. **User decision,
2026-09-23: PSM-hosted runners are part of the first SaaS version.** Routine
deployment and maintenance run through an available authorized execution service.
Local and user-hosted runners remain optional execution targets using the same
protocol; they are not prerequisites for the main onboarding flow.

**User clarification, 2026-10-05:** after thorough acceptance testing, automate
staging deployment and then production deployment. An environment's configured
policy authorizes routine releases; a local cockpit click is not required for
each release. [P12](release-and-api-lifecycle.md) defines the staged acceptance
gates. Hosted PSM execution needs P03; an accepted CI executor can provide release
automation independently. Existing local runtime approval checks remain the
implementation baseline until these milestones ship.

Separate the UI/control service from runners. Runners register to one workspace,
authenticate through outbound connections, report available tools and receive
scoped jobs with expiring credentials. Maintain durable job events, heartbeats,
leases, concurrency limits, cancellation and recovery. Reconcile provider status
after ambiguous timeouts before retrying a mutation.

Hosted runners require isolation between customers, workspace authorization on
every job and secret lookup, isolated storage, controlled outbound access,
retention settings and usage limits. Do not expose the existing loopback agent
directly as a public multi-customer execution API. Schedules and monitors must
continue while the browser is closed; show when a required runner is offline.

The first hosted slice needs a workspace-authenticated control API, durable job
queue and event store, isolated per-workspace job environments, encrypted secret
storage with short-lived runner leases, Git checkout and artifact storage, and
provider authentication suitable for unattended execution. Existing local CLI
logins and OS keyrings are not automatically cloud credentials. Establish the
supported provider account/API authentication and usage model before offering
hosted execution; do not copy local session files into shared runner images.
Show usage, storage retention and configurable compute/spending limits in setup.
Use the existing Werewolf identity integration where applicable, with explicit
workspace authorization for every new cloud operation.

For hosted onboarding: sign in, connect a repository and target accounts, select
scope and access, then start a task. PSM provisions the execution environment.
Display that source, build data and authorized credentials will now be processed
by the hosted service; the current local-only privacy description must change.

## Delivery sequence

The execution order follows prerequisites in the [delivery index](README.md#development-sequence-and-prerequisites);
this document does not define a competing sequence. The table records which part
of this specification each phase delivers. Deliver each as an observable workflow.
Broader integrations should follow a working first deployment, without delaying
basic coding capability.

| Phase | Scope from this specification and existing integration points | Done when |
| --- | --- | --- |
| P01 · Machine inventory and bootstrap | Machines inventory, homelab identity separation, command-execution accounts, scoped helper roles and optional administration; generated bootstrap and enrollment against test hosts. See `machine-onboarding.md`. | Repeatable enrollment and collision handling work against test hosts under existing authority. |
| P02 · Unified policy and honest access | Scoped Allow/Ask/Deny policies, presets, secure credential use and managed/admin execution profiles; route both providers and integration calls through current decisions. Make access honest first: capture effective tools, model/effort and context handling, rename the current button to describe its limited managed grants, and explain blocker causes. Start in `agent-permissions.ts`, both runtime adapters and `web/agent-permissions.js`. | Every limitation reports whether the cause is missing grant, tool, connection, provider restriction or runner. Presets describe actual enforcement, and full access is unavailable in a Workroom (see the index's P02 row). |
| P03 · Hosted foundation | Workspace-authenticated hosted control API, isolated job runner, durable queue and cloud secret leases. | Workspace isolation and unattended provider authentication are verified; a job survives a closed browser and a runner restart. |
| P04 · Web machine onboarding | Connect → Choose access → Set up → Ready wizard; automatic bootstrap or one generated copyable enrollment command, then verify/bind/resume automatically. | A user onboards a supported host through PSM, adds another project without repeating machine setup, and sees verified allowed/denied access, including hosted-to-target execution. |
| P05 · Usable execution and continuity | Extend `agent-task-runner.ts`; preserve task context across turns; discovery and Grant and continue; matched baseline comparison. | Through the selected runner, an authorized agent can check out a repository, install/change a dependency, build, typecheck, test, inspect a rendered preview and repair a failure. Local and hosted execution have separate acceptance evidence. |
| P07 · Todo staging | Administrator bootstrap/enrollment, account setup actions, inline grant-and-resume and policy-authorized publication/deployment. Extend connections, host-helper adapter, `repair-sessions.ts`, `make-ready.ts` and existing deployment approvals. | The enrollment case above completes against an authorized staging host, including verification and rollback exercise, with no copied shell commands after connection. |
| P08 · Application operations milestones | [P08a.1 service baseline, P08a.2 recovery, P08a.3 uninterrupted switching, P08b workers/jobs, P08c data/migrations/recovery, P08d observation](application-operations.md). Extend connectors through API, MCP and CLI adapters with a custom adapter contract. | Each milestone proves its named workflow and failure/recovery cases. Later phases require only the relevant accepted slices; the first service does not wait for every worker/database recipe. |
| P09 · Maintenance and SaaS scale | Extend the hosted foundation with schedules, monitoring-triggered tasks within granted policy, runner autoscaling, usage controls and optional local/user-hosted runners. Reuse deployment locking, events and recovery. | An authorized update/maintenance task survives closing the browser and restarting a runner, with no duplicate external mutation or cross-workspace access. |

For the first rollout, use the current GitHub, host helper and DigitalOcean
integration points. Generic HTTP/MCP/CLI adapters and custom recipes provide
extensibility; they do not make every SaaS operation automatically supported.
Provider login, MFA and account restrictions must be represented as real setup
steps when they cannot be automated.

## Verification and migration

Run a matched comparison using the same model, effort, task, checkout and
equivalent authorized credentials in PSM and the direct provider workflow.
Record completed tasks, unnecessary handoffs, repeated approvals, unsupported
tools, retained decisions, elapsed time and cost where reported. Evaluate useful
results and verified system state, not just whether the answer sounds helpful.

Acceptance includes the enrollment case, multi-turn repair, private dependency
installation, browser verification, custom integration discovery, production
review versus standing production authority, revocation during a job, runner
recovery and restore from backup. Check denial across projects, environments,
tenants, networks and secret scopes; test the actual runner boundary against shell
bypass. A full-access test must complete authorized work without hidden per-call
prompts. A narrow-access test must demonstrate that prohibited work is blocked.

Migrate existing grants with identical effective authority. Existing “full
access” must not silently gain host administration or production powers.
Version preset contents and show added authority before adopting a newer version.
Unify or retire the legacy full-access toggle so it cannot disagree with managed
permissions. Preserve connection credentials through the existing secret broker.

Ship behind a selectable execution profile, verify on an explicitly selected
staging environment and retain the current profile during rollout. Update
`agent-permissions.md`, `DEPLOYMENT-SYSTEM.md`, connection docs and README as each
phase ships. Local tests and mocks are prerequisites; they are not evidence
that a real deployment or hosted isolation works.

The first complete deployment outcome is P07: usable target identities, practical
agent tools, understandable access, and a verified staging release with recovery
evidence. Hosted execution adds P03 and its own acceptance checks. P12 then
introduces automatic staging followed by automatic production; P13 expands
progressive rollout and measured production scale.
