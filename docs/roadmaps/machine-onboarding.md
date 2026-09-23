# Machine onboarding through the PSM web app

Execution order and resume state: [PSM delivery index](README.md).

Feature specification, 2026-09-23. Part of
[agent access and software operations](agent-access-and-operations.md).
This is the proposed product workflow, not a claim that hosted execution or the
onboarding UI is implemented. The server-specific Todo bootstrap is reference
material; users must not need that runbook to use this feature.

## Product contract

A user adds a deployment machine from PSM, chooses what PSM may do, and lets PSM
prepare and verify it. Adding subsequent projects reuses the machine connection
and provisions the additional scoped access automatically. Existing servers,
fresh supported servers, different owners and multiple projects all use the same
flow. PSM remembers setup state so a browser refresh or closed tab does not lose
the job.

**Register a machine once per owning workspace. Grant access separately for each
project and environment.** The same physical host can serve several applications,
but one project's connection must not silently inherit another project's grants.
Sharing a physical host across unrelated customer workspaces requires explicit
host-owner delegation; matching an IP address is never evidence of ownership.

All routine setup belongs in the web app: key generation, account creation,
directories, helper installation, target enrollment, connection creation,
verification and deployment resumption. The only terminal step is an initial
administrator handoff when PSM has no way to authenticate that authority. PSM
generates that step and explains exactly where to run it.

## Entry points and main screens

- Workspace navigation: **Machines → Add machine**.
- Project **Deploy → Set up hosting**: choose an existing machine or add one.
- Deployment blocker: **Finish machine setup**, opening the saved job at the
  step requiring attention.
- **Access & connections**: each machine shows its connected projects, accounts,
  effective permissions, connection health and last verification.

Use a single wizard with four steps: **Connect → Choose access → Set up → Ready**.
Keep machine name, owning workspace and selected environment visible throughout.
Advanced fields are expandable; ordinary users do not handle target JSON, UIDs,
contract hashes, key files or helper commands.

### 1. Connect

Ask for a friendly machine name and host/address. Default SSH to port 22, with
custom port and transport under Advanced. Reusing a registered machine skips
these questions and uses its saved, verified identity.

Offer two setup methods:

| Method | User experience | PSM behavior |
| --- | --- | --- |
| **Connect with administrator access** | Select a saved administrator connection, connect an SSH identity, or upload a key securely. | Verify host identity, inspect the server, and perform approved setup automatically. Use existing noninteractive sudo authority when available. |
| **Run a setup command once** | Copy a generated command into the server terminal or the provider's browser console. | The installer authenticates the machine to the pending setup job; PSM verifies the result and resumes the flow. No manual connection-profile import follows. |

For private machines, offer an outbound target-agent connection. A hosted PSM
runner cannot resolve a user's LAN-only hostname or reach a private address
without a route. Show **Reachable from PSM / Private connection needed** with a
specific next action. Do not require the user's laptop to relay routine work.

Host identity should be understandable: show the fingerprint, its verification
source and a **Compare fingerprint** action. Prefer a trusted provider/console
source or the already pinned identity. Network key discovery alone does not
establish trust. A changed key opens a repair flow and does not silently replace
the pin.

If SSH works but sudo needs authentication, offer a secure administrator prompt
in the setup UI where the transport supports it, or the generated one-time
terminal step. The UI never suggests putting a password in chat. Credentials
are scoped to the setup job and are not included in model context or logs.

### 2. Choose access

Use task descriptions on the main screen:

| Choice | Resulting access |
| --- | --- |
| **Deploy this application** | Project/environment release identity, required working directories and target enrollment. |
| **Run application commands** | Separate command identity for builds, diagnostics or maintenance, with the selected working directory and execution limits. |
| **Manage application infrastructure** | Scoped helper identity for required service, reverse-proxy and certificate operations. |
| **Full administration of this server** | Explicit broad administrator authority on the selected target. Explain that it includes other resources accessible to that administrator. |
| **Customize** | Individual operations, accounts, directories, services, credentials, network access and Allow / Ask / Deny rules. |

Provide a **Recommended for this app** preset derived from its deployment recipe
and a **Customize** control. Label defaults and their sources. Resolve ambiguous
ownership or certificate contact information with an inline question; never
invent an email address or choose a customer's business implicitly.

Preview the concrete result before setup:

- Accounts to create or reuse and what each can do.
- Paths, helper/service installation, target contracts and machine privileges.
- Projects/environments covered and the duration of any administrator access.
- Any shared service affected and the verification/recovery plan.

Allow inspection of account names and the exact script under **Advanced → View
setup changes**. Generate short stable account names using project/environment
identity and a collision-resistant suffix, rather than trusting display names as
Unix usernames. Preserve existing accounts unless their ownership and role can
be established. Offer explicit adoption instead of silently changing an account.

Account roles follow the homelab pattern: unprivileged control/command identities,
separate application runtime identities, and a privileged helper for specific
operations. Preserve general command execution when selected; do not replace it
with a tiny command allowlist while labeling it full access. Unix accounts alone
do not isolate hostile tenants; finer policies use the runner and credential
boundaries defined in the main plan.

### 3. Set up

**Set up machine** is the action that approves the displayed bootstrap plan.
If a standing administrator grant already covers it, use that grant without
asking for the same authority again.

Show real backend steps, not a progress animation disconnected from execution:

1. Verify machine identity and inspect compatibility.
2. Prepare project accounts and directories.
3. Install or verify the helper/target agent required by the chosen access.
4. Enroll the project and environment.
5. Verify each connection and effective permission.
6. Save the usable connections and resume the original deployment task.

Each step has a status, plain-language result and expandable technical details.
On failure, preserve completed work and show **Retry this step**, **Change
settings**, or **Reconnect** as appropriate. A permission request opens inline.
Cancel stops future operations; it must report any accounts or resources already
created. Removing those resources is an explicit reviewed action.

#### The one-time command card

The card must contain:

- **Run on:** the selected server, with its name/address clearly displayed.
- **Why:** one sentence explaining the missing administrator connection.
- One complete generated command, with no placeholders or manually assembled
  file paths, and a **Copy command** button with **Copied** feedback.
- **View script**, **Download setup file**, **Copy verification command**, and
  **Regenerate expired command** controls when applicable.
- An expiry time and **Waiting for machine → Connected → Verified** status.
- A short reminder that sudo may prompt in that terminal; no password appears
  in the command.

The installer is versioned and integrity-checked before privileged execution.
It binds to an expiring, single-use enrollment intent for this workspace,
machine, project, environment and reviewed plan. It contains no reusable
administrator credentials or private project key. Bootstrap artifacts and
enrollment endpoints must be reachable from the target over verified HTTPS;
never generate a server-side `curl localhost:4317` command from the local cockpit.

Support both **paste into the server terminal** and, when an administrator SSH
connection is configured, **run from my computer**. Label the execution location
explicitly; do not silently switch between them.

If the target cannot reach the enrollment service, offer a downloaded setup file
and a structured result import with **Choose result file / Paste setup result**.
Treat imported output as a claimed result until PSM independently verifies the
target identity and account access. Explain the unavailable network path. This
fallback must not be presented as successful automatic enrollment.

### 4. Ready

Show which capabilities were actually verified, the accounts used, and the
connected project/environment. Do not label a machine deployment-ready merely
because it answers SSH or a script returned exit code zero.

The primary action is **Continue deployment**; continue automatically when the
user entered from an active authorized preparation task. Other actions are
**Run connection check**, **Manage access**, and **Add another project**.

Adding another project reuses the machine identity and transport. If existing
administrator authority permits provisioning the new scope, the user selects
the project, reviews its access preset, and PSM completes setup. Otherwise it
requests only the missing scope. Repeating the entire host installation is not
part of per-project onboarding.

## Ongoing machine management

The machine detail page shows connection state and verification time, owned
projects, account roles, effective authority, job history and pending work.
Provide **Retest**, **Rotate credentials**, **Change access**, **Repair setup**,
**Disconnect project** and **Disconnect machine**.

Disconnecting a project revokes its connections and pending authority without
deleting deployed data. Offer cleanup separately with an ownership-aware preview.
Do not delete shared helpers while other projects use them. Reinstallation or
host-key change requires explicit re-verification. Credential rotation checks
the new credential before retiring the old one so a failed rotation is recoverable.

## Backend design

Reuse the existing deployment secret broker, connections, target enrollment,
policy checks, durable events and job recovery. Add the missing lifecycle rather
than teaching the AI to assemble ad hoc shell snippets for every user.

| Record | Owns |
| --- | --- |
| Machine | Owning workspace, stable machine identity, verified host keys, addresses/transports, supported features and last observation. |
| Project machine access | Project/environment, account roles, paths/services, effective grants and resulting connection references. |
| Bootstrap plan | Exact proposed operations, relevant revisions, installed-artifact digests, expiration and authority used. |
| Setup job | Durable steps, outputs with secrets removed, pending input, cancellation, observed changes and retry/reconciliation state. |
| Enrollment intent | Single-use challenge bound to the plan, target and owner; hashed token storage and short expiration. |

The target agent's enrollment identity is not the same credential as an app's
deployment key. Generate and store credentials with the broker; keep only public
keys and opaque references in metadata. Automatically persist observed UIDs,
fingerprints and contract revisions. Never ask users to transcribe them.

Generate installers from validated structured plans. Validate names, paths,
addresses, shells, key formats and service identifiers. Avoid shell concatenation
of user-supplied values. Fail before mutation on unsupported OS/architecture,
path symlinks, UID/account conflicts, changed host identity or stale authority.
Pin the helper version and digest. New-machine installation and upgrades have
separate plans; upgrades must preserve enrolled targets and working connections.

Jobs run outside the browser with durable state and leases. Serialize conflicting
machine/account changes, recheck grants immediately before mutations, and
reconcile real state after a timeout before retrying. Persist a change receipt
for partial success. Removal/rollback acts only on resources owned by the job
and cannot erase an application directory because setup was cancelled.

### Authorization through the hosted web app

The current code's deployment-authority mutations are local-cockpit-only
(`src/server/deploy/api.ts`, `requireLocal`); the hosted page uses a paired local
agent. A new wizard alone cannot satisfy this feature.

Implement machine ownership and workspace authorization in the hosted control
API, plus an explicit delegation flow when targeting a paired local agent.
Validate the authenticated operator's ability to manage the machine/project and
grant the requested authority. Browser origin, pairing, workspace membership and
administrator delegation are distinct checks. Do not remove the local-only
guard globally or treat sign-in alone as machine administration authority.

The selected product model remains PSM-hosted runners. Setup jobs and subsequent
commands must work without the user's laptop. Local-agent operation is an
optional transport supported by the same machine/access model. The UI must show
which execution service is connected and must not advertise unattended hosted
execution while depending on a laptop process.

### Integration points in this repository

- `web/deployment-connections.js`: add machine selection/onboarding beside the
  host slot; consume saved machine scopes and automatically bind verified
  connections. Keep advanced import for experienced operators.
- Workspace navigation and a dedicated Machines view: reusable inventory and
  lifecycle actions, with deep links to pending setup jobs.
- `src/server/deploy/connections.ts` and durable store: machine references and
  scope bindings, without embedding credentials in public metadata.
- `src/server/deploy/api.ts`: authorized machine setup endpoints, plan review,
  events, enrollment, retry and cancellation with explicit web authority.
- `host-helper/packaging/`: reusable install/upgrade and per-target account
  enrollment. Replace the fixed Todo names with validated plan parameters.
- `src/server/deploy/make-ready.ts`: route machine blockers to their setup job
  and resume the original task on successful verification.
- Hosted control service/runners: durable execution, secure credential leases,
  workspace isolation and reachable enrollment endpoints from the main plan.

## Delivery order and acceptance

These steps are local to this feature. The execution order is the phase queue in
the [delivery index](README.md#ordered-delivery-queue): steps 1–2 run in P01 against
existing authority, the hosted control path and durable jobs come from P03, and
steps 3–4 complete in P04 and P07.

1. **Machine model and execution foundation:** ownership, transport, credential
   references, authorization and durable jobs. The hosted control path is
   delivered by P03 and integrated here, not built separately.
2. **Installer and verification:** inspect existing/new supported Linux hosts,
   provision selected roles, install/verify helpers, enroll and test access.
3. **Web wizard:** all four steps, existing-machine reuse, automatic administrator
   setup, one-time command card, clipboard/download and inline recovery.
4. **Deployment integration and lifecycle:** bind verified connections, resume
   preparation, rotate/revoke access, repair drift and add subsequent projects.

Feature acceptance:

- A new user with an existing Ubuntu/systemd server can connect it and deploy
  from the web app without editing JSON or manually generating keys/users.
- Existing administrator credentials permit completely automatic setup after
  the requested access is granted.
- Without a usable administrator channel, one generated copyable command can
  complete initial trust/setup; status appears back in PSM automatically.
- Another project can use the same machine without repeating machine setup or
  inheriting the first project's credentials or grants.
- Two workspaces cannot discover, approve or use each other's machine jobs,
  enrollment intents or credentials.
- Reload, closed browser and worker restart preserve progress; retry does not
  create duplicate users or replay uncertain privileged mutations blindly.
- Wrong host key, expired/replayed intent, altered installer, account collision,
  scope revocation and partial install produce actionable states.
- Clipboard denial provides a selectable command and download alternative;
  keyboard/screen-reader navigation and narrow screens remain usable.
- The Todo staging host is the first real acceptance target. Existing infra and
  release users must be detected and reviewed for adoption; no other app on the
  shared host is restarted or modified as incidental setup.

Measure time to first verified connection, manual terminal steps, unexplained
failures, repeated questions and successful project reuse. The success criterion
is a verified useful connection and resumed deployment, not a generated script.
