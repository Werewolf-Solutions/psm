# ai-mesh provider and trusted execution integration

Status: planned, unimplemented. Product decision: 2026-10-08.

PSM is the planning and acceptance cockpit; ai-mesh supplies trusted compute.
Use a capable model for research, reasoning and explicit implementation plans,
then hand bounded work to an open-model worker or run exact verification routines
without a model. Preserve authorized Claude/Codex use on the machine PSM runs on
or connects to. This plan follows the
[ai-mesh worker implementation plan](../../../ai-mesh/docs/coding-farm-plan.md).

## Position in the delivery index

Treat this as a scoped P05/P11 execution/provider extension, with P02 authority
and P12 release evidence integration. Basic local routine execution does not
depend on finishing the P11 bundle marketplace or P03 hosted control acceptance.
Hosted dispatch and person-to-person delegation retain their P03/P02 acceptance
gates. Do not reorder or declare existing release milestones complete.

The first milestone is a disposable project verification run from local PSM to
one approved ai-mesh worker. Implementation, automatic scheduling and hosted
execution are separate gates.

## Existing code to extend

| Foundation | Reuse / extension |
| --- | --- |
| `src/server/plans.ts` | Bind jobs to confirmed plan revisions and bounded steps; evidence must precede accepted progress |
| `src/server/models.ts`, `ai.ts`, provider maintenance | Add mesh discovery and explicit engine capabilities; retain native Claude/Codex discovery and continuity |
| `src/server/agent-permissions.ts`, policy and reviews | Separate source export, remote execution, model recipient, result application and release authority |
| `src/control/service.ts`, `src/runner/*` | Reuse durable jobs, leases and uncertain-outcome semantics; do not create competing retry owners |
| `src/server/agent-task-runner.ts` | Reuse routine isolation/prepared dependency concepts and cancellation |
| `src/server/backups.ts` | Reuse exclusion/encryption primitives after review; task-specific packaging and key grants are new |
| `src/server/deploy/*` | Accept verified candidate evidence under existing source/artifact/policy checks; deployment remains here |

Existing control jobs support `kind: command`, image, steps, checkout, secrets,
network and timeout. They do not yet represent source packages, agent objectives,
patches or checkpoint transfer. Add a versioned extension with compatibility
tests; do not describe those as existing capabilities. Hosted runner acceptance
remains open according to the delivery index.

## Model provider and execution location

Keep these independent concepts in configuration and UI. ai-mesh is both an
inference provider and an execution backend, with separately discovered support.

| Choice | Model runs through | Tools run on | First support gate |
| --- | --- | --- | --- |
| Routine | No model | Selected trusted mesh worker | M01–M03 |
| Existing provider | Authorized Claude/Codex on PSM agent machine | Existing managed local tools | Preserve current behavior |
| Mesh inference | Selected open model via local mesh node | Existing managed PSM tools | M04 inference adapter |
| Mesh implementation | Evaluated open model and agent runtime | Selected mesh worker | M04 repository acceptance |
| Local subscription + mesh routines | Authorized provider on PSM agent machine | Explicit routine calls on mesh worker | M05 hybrid acceptance |

Do not imply every model/backend combination works. Advertise supported
combinations, explain missing capabilities, and never silently switch providers
or export project data to a different peer.

### Authorized subscriptions on a PSM machine

An installed and authenticated provider may remain available on the local PSM
machine or a user's explicitly paired, authorized PSM agent machine. Pairing
authenticates a connection; it does not itself grant use of another person's
provider account. Run the provider under its authorized account and documented
authentication mechanism. Check applicable provider terms before shipping new
remote access arrangements. No pooled logins, credential copying, subscription
resale or automatic fallback through someone else's subscription.

The subscription provider stays on that machine. ai-mesh may execute explicitly
approved test/build routines and return their results to the local agent loop.
Provider credentials, raw provider sessions, home directories and blanket MCP
configuration never enter mesh task packages. Subscription access is optional;
open-model execution continues to work without it. API/partnership support later
uses separately authorized adapters, not an assumption of future agreements.

## From plan to task

PSM retains research, discussion and the full plan. Compile one confirmed step
into the shared worker schema: exact source snapshot, plan/revision/step IDs,
objective, relevant docs/examples, allowed files/operations, pinned environment,
dependency inputs, verification commands, acceptance criteria, limits and outputs.
For routines the steps are executable commands explicitly selected by the user
or an authorized workflow, without model interpretation.

Show the transfer manifest and target trust scope. Exclude credentials, provider
transcripts, unrelated projects and sensitive local config. Record any included
uncommitted overlay; never present it as the base commit. Store the immutable
task and source digest locally before dispatch. Worker questions are surfaced in
PSM; an amended specification creates a new task revision/attempt.

Keep planning, implementation and review provider selections separate. A capable
planner can review a returned patch, but deterministic checks and scoped source
application remain PSM's responsibility.

## Dispatch, evidence and recovery

Connect through the requester-local ai-mesh node rather than exposing PSM's
loopback shell API to peers. Publish adapter operations for discovery, submit,
events/status, cancel, artifact retrieval and acknowledgement, with negotiated
versions and bounded timeouts.

PSM owns durable job IDs, dispatch attempt/fence, policy revision and retry
decisions. ai-mesh owns execution of that attempt and worker artifacts. Reuse
control-service leases where applicable and define local persistence where the
hosted control service is not selected. A browser closure must not lose state.
Reject expired/superseded results; reconcile ambiguous submissions by ID before
retry. Stop on revocation/lease loss. Retry only declared isolated operations;
unknown external side effects remain uncertain until reconciled.

Returned results bind job/attempt, source, plan revision, runtime/model identity,
patch/artifact digests, exit codes, bounded logs and check outcomes. Authenticate
and validate them; signed worker evidence is not proof of correct execution.
Record execution completed, checks passed, review accepted, applied, published
and deployed separately. Do not mark a plan done from the worker's self-report.

Apply patches only against matching source in an isolated local worktree; reject
path escapes and out-of-scope files. Reverify important checks under requester
control and show a reviewable diff. If the live project changed, preserve outputs
and require reconciliation instead of overwriting it. Release candidate evidence
must match existing PSM source, version, artifact and environment contracts;
mesh results cannot bypass promotion or deployment policies.

## Security and encryption

Use the mesh's authenticated encrypted transport. Encrypt durable task packages,
checkpoints and artifacts with per-job keys and authenticated job/source/attempt
binding. Grant decryption to the selected worker only and return results for the
requester. Implement identity-bound key wrapping, expiry, restart recovery,
rotation and reassignment with the worker contract. Preserve audit metadata
without logging keys, credentials or project contents.

The worker administrator can inspect plaintext during execution. The UI must
identify each owner who receives source or model context, including a separate
inference peer. Encryption protects transport and stored copies against parties
without keys; it does not make an ordinary host confidential from its owner.
Cleanup is retention reduction, not proof of deletion. Keep deployment secrets
on the authorized PSM/release executor for the initial integration.

## Ordered PSM implementation jobs

| ID | Deliverable | Acceptance / prerequisites |
| --- | --- | --- |
| M01 | Shared schema mapping and permission contract | F01; source export and execution separately authorized; unknown features denied; one retry owner documented |
| M02 | Local packaging and routine adapter | F02; pinned prepared environment; exact source transfer, events, cancellation, encrypted artifacts; no model or release credentials |
| M03 | Verification UI and independent acceptance | F03; tests/typecheck/build on a disposable repo; result survives browser closure/restart; source drift and stale attempts refused; no automatic source application |
| M04 | Mesh provider and bounded implementation | F04; discover live models/effort and context/tool capabilities; local-tools inference and remote-agent execution tested separately; small accepted patch and structured ambiguity question |
| M05 | Authorized machine-local subscription with mesh routines | Native provider stays on paired authorized machine; scoped remote routine tool; account credentials/sessions absent from exports; unsupported combinations fail visibly |
| M06 | Checkpoint recovery and automatic farm UX | F05/F06; cancellation/lease races, durable acknowledgements, peer revocation, compatible resume and owner-priority reclaim proven |
| M07 | Release evidence and optional hosted dispatch | Existing P12 gates plus separate P03 hosted acceptance where selected; artifact/source verification, authority, recovery and cross-workspace isolation proven |

M04 provider discovery extends [provider maintenance](../provider-maintenance.md)
without invented models or effort levels. Mesh model identities are catalog
artifact IDs, not commercial model names. Map declared effort modes explicitly;
do not infer tool support from an OpenAI-compatible chat endpoint. Support mixed
versions and a visible unavailable state. Do not alter saved provider selections
or native resume semantics. A full repository agent needs larger context than
the existing short code pipeline; reject unsupported budgets rather than truncate
the task silently.

M05 is a separate provider-specific acceptance exercise, not permission to turn
a commercial CLI into a multi-user network service. Routines run remotely;
the commercial agent session remains on its authorized machine.

## Verification and delivery evidence

Use targeted contract/lifecycle tests, then the repository's typecheck and suite
for implementation changes. Exercise two real trusted machines: malformed source
packages, missing images, transfer limits, worker loss, duplicate dispatch, late
results, cancellation, policy revocation and source changes during review.
Prove credentials are excluded and source cannot escape the sandbox.

For coding, evaluate about 20 pinned narrow tasks and record hardware, exact
model/runtime, accepted outcomes, independent checks, intervention, latency,
setup overhead and interruption loss. Establish task-class eligibility from the
results. A successful routine run does not establish coding-model competence.

Record implemented, locally tested, two-machine tested, committed, published and
hosted acceptance separately in the evidence register. Next action is M01 beside
ai-mesh F01, followed by one deterministic routine. This document adds a plan;
it does not claim execution support or authorize a live deployment.
