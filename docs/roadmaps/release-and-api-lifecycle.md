# Release, API compatibility and production scale

Status: planned. This is the detailed plan for P12 and P13 in the
[delivery index](README.md). It extends the existing managed deployment engine;
it does not claim that these capabilities are implemented or that any current
production target has passed acceptance.

User clarification, 2026-10-05: after thorough testing, enable automatic staging
deployment and then automatic production deployment. Per-release manual approval
is an optional policy mode; releases authorised by an accepted environment policy
run without a local cockpit click. This document specifies the future path;
existing runtime approval restrictions are not changed by documenting it.

## Local operator and future SaaS authorization

User clarification, 2026-10-06: local PSM approval does **not** require Werewolf
sign-in, including publication and deployment to a production target. The local
machine operator approves the exact reviewed change through the loopback cockpit.
Same-origin checks, one-use intents, acknowledgements, expiry and audit records
remain in force. Local approval records do not invent a Werewolf user identity.

Account sign-in, tenant/workspace roles, session expiry/revocation, and attributable
Werewolf operators are acceptance gates for the later **hosted SaaS control plane**
(P03 hosted authority, then P12b when that execution path is selected). They are not
prerequisites for local staging or production deployment. Hosted/paired requests
cannot inherit the local unsigned-operator exception. Before SaaS release, disable
the local exemption in the hosted controller and prove tenant isolation and denied
unsigned/expired-session approvals.

## Product outcome

An operator can see what runs in staging and production, test a specific release,
promote that release, observe its effect, and recover safely. An app or business
using the Werewolf API can request a capability and see its progress. Existing
clients continue working across compatible API deployments; breaking changes
have an explicit migration path and visible affected consumers.

Keep four identities distinct in records and UI:

| Identity | Meaning |
| --- | --- |
| Source version and commit | The code revision from which a build was made. |
| Artifact digest and release ID | The exact bytes deployed to an environment. |
| API contract version | The request/response behavior promised to consumers, such as `/api/v1`; it does not change for every server build. |
| Consumer version | The app build or external integration using that contract. A business's app access/installation is separate from its technical API version. |

Staging and production have distinct targets, credentials, identity and data.
Show the environment explicitly even when a hostname does not contain the word
`staging`. A release promotion uses the same immutable artifact where its build
inputs permit that; if an app embeds an environment-specific API URL, prepare a
separate artifact and show that difference rather than presenting it as the same
tested bytes. Production remains on its last verified release until a new one
passes its own gates.

## P12 — release promotion and API consumer lifecycle

### P12 milestones and gates

| Milestone | Scope | Prerequisites / acceptance |
| --- | --- | --- |
| **P12a — contracts and consumers** | Contract artifact, compatibility tests, consumer inventory and migration policy. | Starts alongside P07/P08; prove older and newer clients with disposable users/data. Removal windows and notice ownership must be declared for breaking changes. |
| **P12b — tested promotion and policy** | Environment-specific release settings, candidate evidence and exact-plan authorisation. | P07/P07a local acceptance plus the selected recipe's rollback and health evidence; for Node, P08a.2/P08a.3 and P08d. Review a candidate and rehearse recovery before enabling unattended release. |
| **P12c — automatic staging** | Accepted source/CI event creates a candidate, deploys staging and verifies it without a per-release prompt. | P12a/P12b and a configured durable executor. Inject test, auth, dependency and health failures; each must stop the flow or recover. Prove restart recovery, event deduplication and policy revocation. |
| **P12d — automatic production** | Passing staging evidence triggers production deployment under its selected policy. | P12c accepted; production artifact verified, fresh compatibility/health checks and target-specific monitoring/recovery. Persistent-data targets require restore-tested backups and migration safety. Inject bad/stale evidence, a failed switch and a revoked policy; prevent promotion or recover. |

P03 is required when PSM's hosted control/runner is the selected execution path.
An accepted GitHub/CI release executor can prove P12c/P12d independently of hosted
fleet provisioning. Automatic deployment must not depend on an open browser or
an interactive session on the operator's machine.

### Delivery details

1. **Record consumers and contracts.** Reuse `CloudApplication.key` for app
   identity. Add an environment-scoped registry of first-party apps and external
   integrations with owner, callback/launch location, declared API contract,
   supported workspace kinds, required scopes, and last compatibility result.
   Track business installation/entitlement separately from API version. Use
   observable client identity and reported version where available; show
   `unknown` rather than claiming all consumers have upgraded. Exclude secrets
   and customer data from this inventory.
2. **Publish an API change contract.** Describe endpoints, schemas, auth scopes,
   examples, and compatibility impact in a versioned contract artifact. CI checks
   schema and consumer fixtures against both the currently deployed production
   contract and the proposed one. Cover authenticated journeys, permissions,
   pagination/error behavior and webhooks/events where relevant. Health checks
   alone are insufficient.
3. **Default to compatible additions.** Add optional endpoints or fields without
   forcing existing apps to change. For a breaking change, keep the old contract
   served during a defined migration window, offer a new version or explicit
   opt-in, document the mapping, and set a removal date only after affected
   consumers are identified and notified. Test old and new clients against the
   new server before deprecating old behavior. Database migrations use staged,
   backward-compatible expansion and later cleanup so code rollback remains
   viable.
4. **Connect requests to releases.** Use the Werewolf portal as customer-facing
   intake for an app/business API request, with PSM as the operator's linked work
   and release view, following the existing ecosystem boundary. An app owner submits an API capability
   request with a use case, affected app and desired behavior. The operator can
   link it to a contract change, tests, staging evidence, release and migration
   notice. Requests do not grant deployment or data access.
5. **Offer a release path in PSM.** Show staging and production side by side:
   active release, artifact, API contract, target, health, last verification and
   rollback. The `Promote tested release` review names the exact bytes or build
   profile difference, passed checks, affected consumers, production target,
   migration plan and rollback. Server-side policy still enforces approval and
   fresh observation. After activation, run authenticated smoke checks and
   external Watch checks; retain the previous verified release.

6. **Automate the accepted path.** Select a source branch/ref, required CI checks,
   authorised trigger/actor, staging target, production target and promotion
   conditions in environment settings. Modes are **Manual review**, **Automatic
   staging**, then **Automatic staging and production**. Show missing acceptance
   and actual executor readiness before enabling a mode. Configure observation
   duration, failure thresholds and rollback/hold behavior per target; no guessed
   duration is silently chosen.

   Every trigger resolves an immutable source/artifact and durable job, deduplicates
   repeated events, and derives a fresh exact plan. Record the effective policy
   revision, actor, staging result, contract and production artifact. Recheck
   authority, drift, dependencies and fresh health immediately before activation.
   Failed/expired checks stop promotion; an uncertain external outcome is observed
   before retry. Revocation stops new mutations, and an operator can pause the
   pipeline or roll back under the configured recovery authority. Source publication
   and infrastructure actions require their own covering policy; a generic Git
   push grant is not evidence that the complete automated release is authorised.

   If environment-specific build inputs require different production bytes, build
   from the same accepted source and verify that production artifact before traffic
   activation. Prefer runtime environment configuration for artifact reuse where
   supported. Label both artifacts and record their checks; a staging test result
   alone cannot certify an untested production build.

### P12 acceptance

- A compatible API addition reaches staging and production while an older Todo
  client continues its authenticated journey. A newer client can use the addition
  after its separate release.
- A deliberately breaking contract fails compatibility review until an old
  contract remains available and every known consumer has a migration state.
  An unobserved consumer is displayed as unknown, never silently counted as safe.
- PSM shows which release and API contract each environment serves; an operator
  can promote a reviewed candidate, detect a failed production check, and restore
  retained bytes. A database change is tested for forward and rollback safety.
- An app or business request is traceable from request through contract, staging
  result and production release without exposing customer data in PSM.
- P12c and P12d run without per-release human clicks once their respective policies
  and acceptance gates are enabled; repeated triggers cannot duplicate deployment.
  Failed gates, stale evidence, authority revocation and uncertain provider results
  are exercised before declaring either automation milestone accepted.

## P13 — progressive and distributed production operations

Prerequisites: P12d, P09's durable unattended operations, monitored health and
rehearsed recovery. This is the path toward supporting production systems with
the complexity of a large technology company, including multi-region and
high-traffic services. It is a target capability, not a claim that one deployment
recipe can run every provider or workload. Each platform needs an explicit
adapter, scope policy and acceptance case.

1. Model production as one or more regions, clusters and traffic groups with
   independent target identities, locks, configuration, capacity and health.
   Show which customers or cohorts are exposed to each release without exposing
   their private data. Keep the desired state and rollout history durable.
2. Support progressive exposure: internal cohort, canary or small traffic share,
   then larger rings. Gate each step on error rate, latency, saturation and
   workload-specific success signals against a known baseline. Pause or reverse
   automatically when thresholds fail; require reviewed override for ambiguous
   signals. Feature flags can separate feature exposure from code deployment.
3. Coordinate API, workers, events and data changes across independently
   deployed services. Check old/new compatibility in both directions, event
   schema evolution, idempotency and migration progress. Do not assume a code
   rollback reverses a data migration or an external side effect.
4. Add multi-region failure handling: regional isolation, traffic failover,
   backup/restore drills, tested recovery objectives, capacity checks, and
   provider outage behavior. Drill with disposable or authorized test data.
5. Make the UI a control plane for large fleets: rollout map, current ring,
   release/contract version by region and cohort, live health, pause/resume,
   rollback, incident timeline and audit trail. The simple staging/production
   view remains the default for a single service.

### P13 acceptance

Accept the rollout mechanism, measured scale and resilience separately. Two groups
prove only the mechanism. Before scale testing, specify provider/workload, fleet
size, concurrent rollouts, throughput, health evaluation time, recovery time and
permitted data loss. Record achieved values and limits rather than declaring
universal or Google-scale support from a small demonstration. Google Cloud support
is a separate adapter choice from the ambition to support Google-scale systems.

- A test service rolls through at least two production-like groups using an
  immutable artifact. A forced health regression halts expansion and returns the
  affected group to a known good state while unaffected groups continue.
- An old app client, new client and background consumer work across a staged API
  and event change. A failed data migration has a rehearsed recovery path.
- A regional failure drill demonstrates the documented recovery objectives and
  produces evidence in PSM. Results distinguish simulated, production-like and
  live production verification.
- Under the declared load, restart or partition the control service/runner and
  prove safe leadership, durable rollout state, no duplicate activation, recoverable
  locks and enforcement of current authority. Publish the measured supported scale.

## Current baseline and gaps

The [deployment engine](../deploy/DEPLOYMENT-SYSTEM.md) already models
environments, immutable artifacts, dependencies, approvals, verification and
rollback. Todo's staging manifest (`todo-app/.psm/deployments.json` in the sibling
repository) checks shared API health and registration, but has no production environment or
external Watch, and its probes do not complete an authenticated browser journey.
The [Todo status](../deploy/TODO-STAGING.md) still lists browser acceptance and
retained-release rollback as open. The Werewolf `/api/v1` route is a public API
contract; its version should not be confused with the server package version.

## External practice used for the design

- [Google SRE: Canarying Releases](https://sre.google/workbook/canarying-releases/)
  describes partial production rollout and evaluation against a control.
- [Microsoft: Safe deployment practices](https://learn.microsoft.com/en-us/azure/well-architected/operational-excellence/safe-deployments)
  recommends progressive exposure, health gates and recovery.
- [Stripe: API versioning](https://docs.stripe.com/api/versioning) illustrates
  deliberate client upgrades when an API contract changes.
