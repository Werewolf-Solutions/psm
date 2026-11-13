# PSM MCP operations and ecosystem integration

Status: MCP-1 read-only slice implemented 2026-10-22 in the working tree, not yet
accepted (it waits for P02a.2); see [Implementation status](#implementation-status).
Product decisions: 2026-10-22. Reviewed against the code on 2026-10-22 and
adjusted. This is a P05/P14 interface
and job extension under P02 authority; it does not change the priority or
acceptance state of the [delivery index](README.md).

**Prerequisite:** [P02a local operator authority hardening](local-operator-authority.md).
Today any local process, and any page on any `localhost` port, has full operator
authority over the PSM API. Until P02a.2 lands, MCP credentials and operator
reviews can be bypassed with a plain `curl` to the REST API, so MCP-1 must not
ship before it.

## Outcome and decisions

An MCP-capable host on the operator's machine can discover and use PSM projects,
planning, implementation jobs, deployment readiness, machines and permitted Data
operations through one PSM-owned tool surface. Codex, Claude and a requester-local
ai-mesh node are the first clients; the contract is not tied to any model provider.
Todo and the Werewolf hub can request bounded PSM work through the existing paired
executor and show its progress. PSM remains the authority for local files,
connections, resource levels, review decisions and deployment execution.

Decisions already made:

- Build the identity model so it can later serve several users, but release and
  accept the first integration for the operator's own account and paired agents.
- Todo and the hub may request planning/implementation and read status or
  previews. Sensitive changes require PSM operator review by default. A later
  operator-created, scoped standing grant may replace repeated reviews for
  selected operations; an MCP tool or model response cannot create that grant.
- A local model begins as a **caller** through an MCP-capable host. ai-mesh is the
  first concrete host candidate, not an assumed existing MCP client. Making an
  ai-mesh model selectable as PSM's own planner/implementer is a separate provider
  milestone in [the ai-mesh plan](ai-mesh-provider.md).

This plan does not expand the attached Werewolf capability into customer data or
money-moving tools. It does not authorize a live deployment or a database write.

## Verified starting point

| Area | Current code and limit |
| --- | --- |
| PSM MCP client | `src/server/agent-mcp-tools.ts` connects to attached stdio/HTTP servers and brokers tool calls; this is the opposite direction from the proposed PSM server. |
| Managed PSM tools | `src/server/agent-permission-runtime.ts` creates an in-process Claude SDK MCP server; `agent-codex-runtime.ts` bridges its tools into Codex. Neither is a standalone PSM endpoint. |
| Work and plans | `src/server/plans.ts`, `ai.ts`, `index.ts` provide plan revisions, planner conversations and managed Claude/Codex work. Existing plan confirmation starts work and must retain revision binding. |
| Hub jobs | `werewolf-dapp/server/routes/api/v1/psmHub.js`, `server/services/psmJobs.js` and PSM `src/server/executor/*` implement per-user triage/implement jobs, leases, one claimed implementation per project, local clones and review. Job kinds are only `triage` and `implement`; the executor needs a sign-in again after restart. |
| Todo | `todo-app` is a static React client. Its `/apps/todo/*` API and live intake stream are in werewolf-dapp. Todo already offers Go for a triaged task and reports job progress; it has no backend process in which to host an MCP client. |
| Werewolf MCP | `werewolf-dapp/mcp/werewolf-mcp.mjs` is a separate, business-key-scoped site-builder server. Its `ws_sk_` key is not PSM machine/operator authority. |
| Operations | `src/server/deploy/*`, `machines/*` and `resources/*` have specialized plans, checks, approvals and audit paths. Data scripts are discovered by PSM, restricted by resource level and require a fresh clean Preview before Apply. |
| ai-mesh | Its `docs/api.md` rejects `tools` and `tool_choice`; `docs/agents-design.md` says free model tool choice and passing tools through the mesh are planned. Inference and the bounded coding farm do not yet form an MCP agent host. |
| Local API trust | `agentGuard` (`src/server/agent.ts`) treats requests with no `Origin` as the operator with no token. Loopback origins on other ports needed no token either until P02a.1 (2026-10-22). The rest is fixed by [P02a](local-operator-authority.md), not by this plan. |
| Operator reviews | `src/server/agent-reviews.ts` is a retry model: approval adds an Allow rule and the agent repeats the tool. Reviews expire after 30 minutes, listing is capped at 200 per project, and `summary`/`reason` are written by the requesting agent. It is not reusable as-is for MCP requests (see [MCP operation reviews](#mcp-operation-reviews)). |
| Plan confirmation | `POST /api/projects/:name/plans/:id/confirm` (`src/server/index.ts`) confirms and immediately starts a fresh AI session. It has no origin check beyond the local guard. (`aiFullAccess` is always false now and kept only for API compatibility.) |
| Data scripts | `src/server/resources/api.ts` keeps Preview freshness in memory, bound to the command string only. Preview runs `node <script>` from the working copy with the project environment. Content binding is fixed in [P02a.4](local-operator-authority.md#phase-4--data-preview-and-apply-binding). |
| Sandboxes | Implement-job and task containers run with `--network=none` (`executor/sandbox-shell.ts`, `agent-task-runner.ts`), so they cannot reach the PSM API. Host-side managed Claude/Codex sessions can. |

The hub currently keys projects and jobs by user and `prj_` project ID, while a
project may have several source executors. Generic remote operations need an
explicit selected device and workspace binding. The current `X-PSM-Executor`
header identifies a claimed worker but is not a device credential by itself.

## Architecture and ownership

```text
Codex / Claude / local MCP host -- stdio adapter --+
ai-mesh requester-side host ----- MCP client ------+--> running local PSM agent
                                                      |  MCP transport + caller identity
                                                      |  operation service + P02 policy
                                                      +--> plans / jobs / deployment / machines / Data

Todo static client --> Werewolf API/hub --> paired, selected PSM executor
                                            --> same PSM operation service
```

The running PSM agent owns the MCP server and the operation service. Start with
loopback MCP HTTP (Streamable HTTP) inside the existing agent. Claude Code and
Codex can both connect to it directly and send the credential as a bearer
token read from an environment variable (Codex `bearer_token_env_var`; Claude
`.mcp.json` `headers` with `${VAR}` expansion), so no credential value is written
into a config file. Add a small stdio adapter only for clients without HTTP
support; it must not import `src/server/index.ts` and start a second PSM runtime
with competing in-memory sessions, approvals or deployment controllers. Keep the
socket on loopback. A different machine reaches PSM only through an explicitly
paired, authenticated job/connection path, not by publishing PSM's local shell
API on the network.

The MCP route has its own authentication, separate from `agentGuard`'s loopback
trust:

- It requires an MCP client credential on every request. Loopback alone is not
  enough.
- It refuses any request carrying a browser `Origin` header, so neither a
  localhost page nor the paired hosted page can reach it.
- The pairing token is not an MCP credential.

**PSM must not call itself.** `src/server/agent-mcp-tools.ts` lets PSM-managed
sessions attach MCP servers. Refuse to attach PSM's own MCP endpoint (or its
stdio adapter) to a PSM-managed session or implement job, and refuse MCP
credentials presented from those sessions. Otherwise a managed agent could
start more jobs or request reviews under a different identity.

Extract shared, typed operations from Express route handlers as needed. The web
UI, MCP server and paired executor call the same services and policy checks. Do
not implement MCP by issuing unauthenticated HTTP requests to PSM's existing
loopback API: that API currently treats local requests as trusted. Give each MCP
client its own revocable credential and record its principal, client, device,
workspace and project scope, including for a stdio client.
Mint and revoke these credentials in the local operator UI (an action that
needs the P02a operator credential); store them outside project files, and never
place their values in `.mcp.json`, `overrides.json`, hub jobs, model prompts or
logs. The stdio adapter passes its credential only to the PSM endpoint.
Connection setup shows which local PSM installation and projects a client will
reach.

Be accurate about what these credentials do. An MCP client like Codex or Claude
runs a shell as the same OS user, and can read any credential that user can.
MCP credentials **identify and scope a cooperating client**: attribution,
per-project limits, budgets and revocation. They are not a boundary against a
same-user process. That boundary comes from P02a: the operator credential on
authority-granting endpoints, and user-presence approvals for high-risk actions.

The first server should expose stable tools with bounded, structured results.
Use resources for longer reference/status data where useful, and explicit job IDs
for work that outlives a tool call. Avoid one universal `execute` tool or a
blind mirror of every Express route. Pin an MCP protocol/SDK compatibility
matrix before coding: this repo currently depends on the v1 SDK, while the
[official v2 migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2)
and [2026 protocol guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)
describe a newer wire revision. Test the actual installed Codex, Claude and
ai-mesh clients; support a legacy revision only where those clients require it.

## Tool contract and approval behavior

Each tool accepts stable project IDs rather than directory names. Responses
include a result or a typed state such as `unavailable`, `denied`,
`review_required`, `running`, `succeeded`, `failed` or `uncertain`, with a durable
operation/job ID when applicable. Long operations expose `get_operation` and
`cancel_operation`; cancellation never implies an external effect was undone.
Use idempotency keys and persisted attempt/fence IDs for mutations so a client
retry cannot queue two deployments or repeat a database Apply.

| Family | Initial tools or operations | Authority and result |
| --- | --- | --- |
| Discover | `list_projects`, `get_project`, `get_access_status`, `get_operation` | Resolve caller and workspace before returning project metadata; redact secrets and private paths outside granted scope. |
| Plan | `start_plan`, `get_plan`, `list_plans`, `request_plan_confirmation` | Bind to project, plan ID and revision. Confirmation returns an operator review; MCP cannot self-confirm. |
| Implement | `start_implementation`, `get_implementation`, `cancel_implementation`, `get_change_review` | Reuse bounded clone, checks and stop rules where applicable. Starting a Todo Go job carries the owner's explicit one-job consent; other callers need equivalent authority. Merge/accept remains a separate PSM review. |
| Deploy | `get_deployment_readiness`, `create_deployment_plan`, `get_deployment_run`, `request_deployment_approval` | Reuse exact plan digest, source/artifact pins, environment policy and production cockpit review. Approval is completed in PSM; the MCP request cannot approve itself. |
| Machines | `list_machines`, `get_machine_snapshot`, `create_machine_access_plan`, `get_machine_setup_job`, `request_firewall_apply` | Use machine/environment roles and existing plan/revision checks; no generic admin shell as a shortcut. |
| Data | `list_resources`, `list_database_scripts`, `preview_database_script`, `request_apply_database_script` | Obey None/Read/Full for every target. Preview executes repository code with database credentials, so treat it as execution: through MCP it requires the script to match its committed content (P02a.4 hash binding), and on a Read target an uncommitted script is refused. Apply requires a fresh clean Preview of the same script hash and target plus operator review. No raw connection strings or arbitrary queries in the first release. |

Descriptions and input schemas are discoverability, not authority. Every call
resolves an authenticated principal, checks workspace/project/device scope and
P02 rules at call time, and rechecks before a delayed mutation. Return review
IDs and status to the caller; the operator answers in PSM. Do not offer a tool
that edits grants, returns credentials or impersonates the operator. Preserve
existing stronger gates even if a caller has a broad MCP connection.

### MCP operation reviews

The existing `OperationReviews` store answers an agent's held-back tool call by
adding an Allow rule for a retry. MCP requests need a different review kind:

- **PSM executes the bound operation on approval.** The review stores the
  operation ID, typed arguments, project/target and their digest (plan
  revision, deployment plan digest, script hash). On approval PSM rechecks
  policy and the digest, then runs the operation through the shared service.
  The caller never retries with new arguments.
- **PSM writes the summary.** The operator sees a summary generated from the
  typed operation, including consequences such as "starts an AI session that
  edits this project" for a plan confirmation. The caller's free-text reason is shown
  separately, labelled as untrusted text from the named client.
- **Plan confirmation goes through a service.** `request_plan_confirmation`
  creates a review; approval calls the confirm-and-start service, not the HTTP
  route, and the review shows the engine, model and permission profile the
  session will run with.
- **No flooding.** Each credential has a cap on pending reviews (for example 5
  per project) and a request rate limit. MCP reviews are listed separately and
  pending reviews are never pushed out of view by a row limit. An identical
  pending request is reused, as today.
- **No standing grants from MCP.** MCP reviews offer approve-once or reject.
  Standing grants are created only in the operator UI (see decisions above).
- High-risk approvals (production deploy, Data Apply) need the P02a.3
  user-presence boundary before MCP may request them.

### Budgets and untrusted tool output

- **Budgets:** starting plans and implementation jobs spends model credits.
  Each MCP credential has limits on concurrent jobs, jobs per day and total
  model budget, counted against the existing P14 job budget caps. Over budget,
  the tool returns `denied` with the reason.
- **Tool output is data:** plans, change reviews, intake text, logs and file
  excerpts can contain text written by an attacker (repository content,
  dependency output, Todo items). Return them in clearly delimited result fields,
  never as instructions, and keep scope checks on every follow-up call so
  injected text cannot reach another project. Leave log excerpts out of the
  first release; secret redaction in logs is best-effort.

For the first release, limit externally exposed operations to the tested subset
above. Expand coverage operation by operation until the supported PSM functions
are mapped; `get_access_status` must say what is unavailable and why. Billing,
customer records and money-moving operations remain outside this PSM contract.

### Coverage ledger for the wider PSM surface

MCP-0 inventories every cockpit operation and records its backing service,
required authority, data classification, external effects and recovery path.
The table below is the planned expansion order, not a claim of support today.

| PSM area | First contract | Later coverage gate |
| --- | --- | --- |
| Projects, work sessions, notes, plans | Scoped inventory, plan/job status and authored notes | Create/edit/archive only after shared service extraction and revision checks. |
| Repository, Git, builds, previews | Bounded implementation job and verified result | Individual managed tools only where brokered permissions and isolation can be preserved; no direct host shell. |
| Run processes and logs | Status only; bounded redacted log excerpts after redaction is tested | Start/stop/restart with project command scope and process ownership checks. Planned as runbook units and stacks in [P18](p18-project-runbook.md). |
| Capabilities and attachments | List effective attachments and access status | Preview/attach/detach with manifest pinning and operator review; no self-granting tool. |
| Deployment and app operations | Readiness, exact plan, run status and review request | Deploy, rollback, service controls and recovery only through existing environment policy, immutable evidence and uncertain-outcome handling. |
| Machines and Data | Inventory, snapshots, detected scripts and Preview | Each setup/firewall/command/apply operation receives a distinct typed contract and its existing review/recovery gate. |
| Cloud sync, backup, devices, billing | Readiness or safe metadata only where PSM is authoritative | Sensitive account, backup restore and device changes need separate product/auth review; billing and money movement remain excluded here. |

Do not call the server “full PSM support” until the ledger names every supported
operation and `get_access_status` reports unsupported ones accurately. A product
feature without a safe callable service remains visible as unavailable.

## Todo, hub and device contract

Keep Todo's browser talking to `/apps/todo/*`; it does not connect to PSM MCP
directly. Extend the Werewolf hub's existing authenticated queue with versioned
request kinds and result summaries for planning/status and, after review,
other approved actions. Retain its per-user isolation, lease, heartbeat, repo
lock, retry and live intake behavior. Add explicit `workspaceRef`, `projectId`,
`targetExecutorId`, actor, request origin, operation kind, idempotency key and
policy/review references. Resolve a target from the project's registered
`sources`; if several devices qualify, require the user to select one rather
than routing a machine or Data action unpredictably.

Before unattended hub use, give each PSM executor a durable, rotatable device
session bound to the user and installation. A user access token plus a caller-
supplied `X-PSM-Executor` name is insufficient as device authentication. The
hub authenticates the requester and device separately; the PSM agent then
rechecks its own project and resource policy. On sign-out, revocation, lost
lease or policy reduction, stop new work and reconcile in-flight state. Keep
source code, database contents, machine credentials and full transcripts local;
send bounded status, approval metadata and reviewed summaries to the hub.

The first Todo UX can retain its current Go flow and add links/status for plan
and deployment readiness. The Werewolf portal can show device availability,
projects, pending reviews and job status using the same hub contract. Do not
add a Werewolf server-side MCP client merely to call a local machine: the hub
queue is the reachable, authenticated path. A hosted MCP facade for remote AI
clients can be added later by translating authorized tool calls into those
same durable hub requests; it must not become a second operation authority.

## ai-mesh and other local models

An arbitrary local model is useful through MCP only if its **host** can choose
tools, call an MCP client and feed results back to the model. The PSM server
can be tested immediately with an existing MCP-capable host. ai-mesh needs a
requester-side MCP client configuration, tool selection loop, model capability
discovery, bounded step/context budgets, cancellation and tests for malformed
or adversarial model calls. Its current OpenAI-compatible endpoint rejects
tool definitions, so a plain OpenAI-compatible connection is not acceptance.

Keep tool execution on the requester's trusted node, as ai-mesh's
`docs/agents-design.md` intends. An inference peer may generate proposed tool
calls but receives no PSM credential and never executes them. For private PSM
context, start with an explicitly selected local model; exporting context to a
remote inference peer requires a separate visible transfer scope under the
[ai-mesh provider plan](ai-mesh-provider.md). A model unable to produce reliable
tool calls may use a fixed, host-driven workflow, with unsupported capabilities
reported rather than silently switching models. PSM-native ai-mesh inference
and remote coding-farm execution retain their separate M04/F04 gates.

## Ordered implementation and acceptance

| Step | Deliverable | Acceptance gate |
| --- | --- | --- |
| MCP-0 | Inventory and contract | Freeze tool schemas, operation IDs, actor/workspace/device model, redaction, MCP review kind, per-credential budgets, SDK/CLI compatibility matrix and a disposable three-repo fixture. Record which PSM actions already have callable services and which need extraction. Can run in parallel with P02a. |
| MCP-1 | Local PSM server and identity | **Requires P02a.1 and P02a.2.** Running PSM serves a read-only MCP subset over loopback HTTP to installed Codex and Claude (stdio adapter only if a client needs it). Demonstrated: per-client credentials and revocation, loopback binding, no second PSM process, denied cross-project calls, the MCP route refusing browser `Origin`s and the pairing token, PSM's own server refused as an attachment to managed sessions, and `curl` without the operator credential failing on authority-granting endpoints. |
| MCP-2 | Plans and bounded jobs | Tool calls start/read/cancel a plan or implementation job; job and review IDs survive client disconnect/restart. Existing revision confirmation, clone isolation, checks, stop rules and merge review remain enforced. Plan confirmation is an MCP review executed by PSM. Per-credential job budgets and the pending-review cap are enforced. |
| MCP-3 | Operational previews and reviews | **Requires P02a.3 and P02a.4.** Deployment readiness/plans, machine snapshots and Data discovery/Preview work through common services. A request for each sensitive action yields a PSM review; stale digests, None/Read targets, expired previews, a script edited after Preview, an uncommitted script on a Read target and cross-device requests fail closed. Prove mutation only after the existing specific approval path. |
| MCP-4 | Durable hub/device extension | Werewolf binds a user, workspace, selected executor and idempotency key; PSM reconnects after restart. Todo and portal show offline, pending, review, success and uncertain states. Duplicate delivery and lease loss do not repeat external effects. |
| MCP-5 | ai-mesh host integration | ai-mesh requester runs an MCP client and a bounded local model tool loop; its API no longer claims tool support without negotiation. A real local model performs read → plan/status on a disposable project; a hostile/faulty model cannot escalate, access another project or cause a reviewed mutation. |
| MCP-6 | Coverage and release acceptance | Add remaining PSM operations only with their own typed policy/recovery checks. Compare cockpit, Codex, Claude, ai-mesh and Todo results for the same test projects. Record local, paired-device and hosted acceptance separately; customer rollout is a later gate. |

Cross-repository ownership: PSM owns operation services, MCP transport, grants,
reviews and local execution; werewolf-dapp owns authenticated hub/device routing
and durable remote request state; todo-app owns the user action and status view;
ai-mesh owns its requester-side MCP client/model tool loop. Update the P14 hub
contract, ai-mesh coding-farm/provider plans and each product's API docs when
their corresponding implementation lands. Preserve the existing P07/P08/P12
deployment and recovery acceptance gates; an MCP smoke test cannot replace them.

## Implementation status

2026-10-22, working tree (PSM 0.3.46). Detailed evidence is in the
[evidence register](acceptance-evidence.md).

| Piece | State | Where |
| --- | --- | --- |
| P02a.1 (prerequisite): only the agent's own origin skips the token | Implemented, tested | `src/server/agent.ts` (`isOwnLoopbackOrigin`) |
| `/mcp` Streamable HTTP, stateless, inside the running agent | Implemented, tested | `src/server/mcp/server.ts`, mounted in `src/server/index.ts` |
| Per-client credentials: hash-only, project scope, revocation, coarse last-use, audit | Implemented, tested | `src/server/mcp/clients.ts`, migration `mcp_clients` / `mcp_audit` |
| Read-only tools `list_projects`, `get_project`, `get_access_status`, `list_plans`, `get_plan`; bounded, no paths or commands, repository text under `untrusted` | Implemented, tested | `src/server/mcp/operations.ts` |
| Read-only status tools `list_processes` (psm-started processes: kind, status, start time, port; no command, folder or log), `list_machines` (name, trust, last inspection, each access's role/state; no host, keys, accounts or scripts; scoped clients see only their projects' accesses), `get_hub_status` (Werewolf API target and reachability, sign-in, executor, project publishing). Added 2026-11-10 ahead of MCP-3: they read status only, while machine snapshots and every action stay behind P02a | Implemented, tested | `src/server/mcp/operations.ts`, `processSummaries()` in `src/server/procs.ts` |
| Read-only P18 tools `get_runbook` (every script: kind, how to run, port, dependencies with out-of-scope projects unnamed, env names, credit, status; descriptions under `untrusted`; no script text) and `list_stacks` (only stacks whose every project is in scope). Added 2026-11-12 | Implemented, tested over HTTP with the SDK client | `src/server/mcp/operations.ts`, [P18](p18-project-runbook.md) |
| First acting tools: `start_units` / `stop_units` (P18 R6), all or nothing, only for units the operator allowed in the Scripts tab for their current script, in scope, on resources at Full. Added 2026-11-12 after P02a.2 | Implemented, tested end to end with real processes | `src/server/mcp/operations.ts`, `src/server/units.mcp.test.ts`, [P18](p18-project-runbook.md) |
| Read-only `list_agents`: the Agents page roster (executor and its jobs, AI sessions, script agents and processes; other executors and MCP clients for all-projects clients only), scoped to visible projects, no commands, folders or machine name, transcript text under `untrusted`. Added 2026-11-12 | Implemented, tested | `src/server/mcp/operations.ts`, `src/server/agents.ts` |
| Requests over MCP: `submit_request`, `list_requests`, `get_request`, `withdraw_request`. A client asks for a bug fix or feature in a project in its scope; psm creates a hub intake (the P17 `POST /psm/intake`, source `psm`, text headed with the client's name), so it is triaged and then waits for the operator's Go. It never starts work. Off per client until the operator ticks "May send requests" in Linked folders → AI clients (`PUT /api/mcp/clients/:id/requests`, operator token); 20 new requests per client per day; idempotent on the client's key; a client reads back only its own requests (an all-projects client sees every client's). The Agents page queue names the requesting client. Added 2026-11-12 as the first slice of MCP-2; no hub change | Implemented, tested with a fake hub and the real SDK client over HTTP. Not run against a live hub | `src/server/mcp/requests.ts` (table `mcp_requests`), `src/server/mcp/operations.ts`, `src/server/mcp/server.ts` |
| One-click Connect (2026-11-12): buttons in Linked folders → AI clients for Claude Code, Codex and "another harness or a local model". A click mints a client, writes its credential to a private connection file (`~/.config/psm/mcp/<client>.json`, 0600 in a 0700 directory; `PSM_MCP_CONNECT_DIR` overrides) and adds psm to the host's config through the host's own CLI (`claude mcp add-json --scope user`, `codex mcp add`); for other hosts it shows the command to paste. Every host uses the stdio relay `scripts/psm-mcp-stdio.mjs` (the stdio adapter this plan allowed: stateless, no dependencies, no second psm), so no config or shell profile holds the credential. Reconnecting a host replaces its earlier client; Revoke deletes the file and removes the entry. **Changes one earlier property:** a connected client's token is kept on disk, where a hand-minted one is hash-only and shown once. The relay sends its pid and `/mcp` refuses a relay that psm itself started (`startedByPsm`), which keeps "PSM must not call itself" for hosts that load user-level MCP config | Implemented; tested with fake CLIs and with the real SDK stdio client through the relay to the real handler. Not yet clicked in the cockpit, and the real `claude`/`codex` CLIs were not run | `src/server/mcp/connect.ts`, `scripts/psm-mcp-stdio.mjs`, `POST /api/mcp/connect` |
| Local queue (2026-11-12): psm keeps the queue itself, so the executor, the Agents page composer and `submit_request` need no Werewolf account and no running werewolf-dapp. `src/server/executor/local-hub.ts` implements the same `Hub` interface as the Werewolf client over psm's database (tables `hub_intake`, `hub_jobs`) with the P14 contract's rules: 120 s leases, one retry, one claimed implement job per project, Go only on a triaged item. It is the default; `PSM_HUB=werewolf` keeps the previous behaviour (the hub in werewolf-dapp, signed in). **Consequence:** in the default mode Todo `@project` items and feedback intake, which are written to the Werewolf hub, no longer reach this psm; items already in the Werewolf hub are not copied over | Implemented and unit tested. Not yet run with the real executor against a real task | `src/server/executor/local-hub.ts`, `src/server/executor/hub.ts` |
| Browser `Origin` and pairing token refused; 120 calls/min per client | Implemented, tested | `src/server/mcp/server.ts` |
| PSM's own endpoint or credential refused as an attached MCP server; `PSM_MCP_TOKEN` dropped from psm's environment | Implemented, tested | `src/server/agent-mcp-tools.ts`, `src/server/index.ts` |
| Mint/list/revoke in Linked folders → AI clients, with Claude Code and Codex setup snippets | Implemented; rendered check open | `web/index.html`, `web/app.js`, `/api/mcp/clients` |
| Real clients | Claude Code 2.1.308 and Codex 0.163.0 discovered and called the tools against the real handler on a spare port | evidence register |
| stdio adapter | Built 2026-11-12 as the Connect relay (row above); HTTP with a bearer token still works | `scripts/psm-mcp-stdio.mjs` |
| MCP-1 acceptance | Open: needs P02a.2, a run in the full agent process and a revocation demo with a real client | — |

Projects without a stable `prj_` id can't be addressed; `get_access_status`
reports how many there are. On 2026-10-22, 14 projects had one.

## Evidence to record

Use a disposable project and fake machine/Data adapters for contract and fault
tests. Verify real Codex and Claude tool discovery, schema calls and cancellation;
ai-mesh needs a real local-model test after its host exists. Exercise mixed MCP
protocol versions, restart, credential revocation, stale approvals, changed
project/workspace scope, duplicate job delivery, lost lease, interrupted external
effects, redaction and a forged client/device claim. Also record: an MCP client
trying to approve its own review over MCP and over `curl`; a localhost page
calling the MCP route; a review flood hitting the pending cap; a job budget
being exhausted; a Data script edited between Preview and Apply; and prompt-injected
text in a plan or intake trying to reach another project. Prove an actual Todo → hub
→ paired PSM → status round trip without publishing local credentials or source.
Record each environment's version and observed result in
[acceptance evidence](acceptance-evidence.md) before marking a step complete.
