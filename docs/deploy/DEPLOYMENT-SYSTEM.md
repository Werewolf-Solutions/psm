# PSM deployment system — technical specification

Status: implemented, unproven. The engine described here is built and tested; no executor has
yet run against a real target. Section 0 says exactly where that line falls.

This specification defines the managed deployment system that will replace PSM's current
pair of deploy-command fields. The existing command runner remains available during migration
as an explicitly labelled **unmanaged command**. The current manual static-app runbook remains
[`PUBLISHING-A-NEW-APP.md`](PUBLISHING-A-NEW-APP.md) until each managed capability ships.

## 0. What is built today

Stages 1–6 of the delivery sequence in section 20 are implemented, tested and wired into the
server. `createDeploymentEngine` (`src/server/deploy/engine.ts`) assembles the store, the planner
and the runner; `src/server/index.ts` mounts the guarded API, installs the runtime adapters,
resumes durable work on boot and drains the runner on `SIGINT`/`SIGTERM`. Of stage 7, workroom
dependency presentation is built; `static-ssh-nginx@1` is still the only recipe.

What is implemented, for a project with a committed `.psm/deployments.json`:

- strict manifest validation and graph expansion;
- local connection profiles, scope constraints, OS-keyring or process-memory secret leases
  and redaction;
- read-only dependency, resource and Watch observation, and previewable diffs;
- durable SQLite plans, exact-digest approval, one-use approval intents, runs, steps, events
  and target locks;
- plan re-derivation at every mutation gate, so drift stops a run instead of silently
  applying a plan nobody approved;
- startup recovery that resumes interrupted work but holds anything that died after a
  provider submission for a person;
- an installed executor for every one of the fifteen action kinds, across the host helper,
  DigitalOcean DNS, the GitHub release controller and the external monitor; and
- the managed Deploy pane, with artifact preparation, plan discovery, approval, live run
  events and rollback; and
- the workroom dependency strip, which names every cross-project edge in a room that is not
  passing and links to the project that owns it.

The five adapter and packaging decisions section 21 deferred are now closed by ADRs in
[`adrs/`](adrs/): Better Stack for Watch, `@napi-rs/keyring` for persistent secret slots,
a static Go host helper, immutable `controller-vX.Y.Z` tags, and 30-day/five-release retention.
The helper itself lives in [`../../host-helper/`](../../host-helper).

### What is not proven yet

Every executor exists in code and is covered by unit tests against a faked provider. **None has
run against a real target**, because the operational prerequisites in section 21 are still not
installed:

| Missing | Blocks |
|---|---|
| `Werewolf-Solutions/deployment-control` — the repository does not exist | `stage-static-release@1`, `activate-static-release@1`, artifact preparation |
| The host helper is not installed on any droplet, and no target contract is enrolled | the eight host action kinds |
| No Better Stack monitor is bound | `observe-watch@1` |
| No DigitalOcean connection profile is configured | `reconcile-dns@1` |
| No connection profile is bound in any slot, so every environment reports `connection-missing` | approval of anything |

PSM and todo-app both carry a manifest: psm declares `production`
(`psm.werewolf.solutions`), todo-app declares `staging` and `production`
(`todo-staging` and `todo.werewolf.solutions`). Both parse, expand into a graph and plan;
both stop at the same wall. todo-app's is still uncommitted, so it additionally plans
preview-only.

So a managed plan today reaches the point where it would call a provider and stops there,
reporting the missing connection or contract. That is the intended failure — an unconfigured
adapter refuses rather than pretends — but it means the end-to-end claim in this section is
"the engine is complete", not "a deployment has been performed". Section 20's rule still holds:
command execution is not called Release, a local timer is not called Watch, direct
live-directory rsync is not called immutable and a branch check is not called dependency
verification.

Until a target is adopted, [`PUBLISHING-A-NEW-APP.md`](PUBLISHING-A-NEW-APP.md) and the two
unmanaged deploy commands remain how anything actually ships.

## 1. Outcome

PSM will model a deployment as a graph of independently owned things:

- an environment with a risk policy;
- one or more releasable units;
- an immutable artifact for each unit;
- an explicit executor and target;
- desired infrastructure resources;
- observable cross-project or external dependencies;
- immediate verification probes; and
- an external monitor that remains alive when PSM is off.

The lifecycle is **Reconcile → Release → Activate → Verify → Watch**. Planning and dependency checks
happen before every mutation. Production approval is enforced by the server and bound to the
exact plan, source commit, payload/archive digests, observations and target that were reviewed.

There is no project-level `deployType`. `static-ssh-nginx@1` is the first reusable recipe,
not a type assigned to a whole project.

## 2. Current state and migration boundary

Today PSM has:

- support for `deployStaging` and `deployProduction` string fields through `overrides.json`;
- a fixed `run | deploy:staging | deploy:production` process model;
- a `POST /api/projects/:name/run` endpoint that can accept a raw command;
- `shell: true` child execution with nearly all of PSM's ambient environment;
- an in-memory process registry and one overwritten transcript per project/kind; and
- a second browser click as the only production confirmation.

PSM's GitHub workflow is more disciplined—it tests, checks SSH prerequisites, stamps a
version and smoke-tests the result—but it still uses `rsync --delete` against the live
directory. It does not produce a retained immutable artifact, atomically activate a release,
record rollback state or recover a run after interruption.

These are compatibility inputs, not foundations for the managed engine. In particular:

- managed deployment endpoints never accept a command string;
- managed adapters do not call the existing process runner;
- legacy commands do not acquire managed target locks or create managed release records; and
- the UI never describes a successful legacy command as a verified release.

If `.psm/deployments.json` is absent, the current Deploy pane continues to show the two legacy
commands. If the manifest is present, the managed surface is primary and legacy commands move
under an **Unmanaged commands** disclosure with an explicit warning until a target is adopted.
Once any unit/resource binding marks that target managed, PSM disables the overlapping legacy
commands. Break-glass use requires a loopback-only action that first disables the managed binding,
invalidates outstanding plans, marks target state unknown and forces full re-observation before
managed work can resume. PSM cannot stop an operator using an external terminal, so discovery also
records unexplained target releases as out-of-band drift.

## 3. Decisions and invariants

The following are load-bearing rules.

1. **The committed manifest is desired state, not authority.** A repository can request a
   connection or target only within constraints configured locally by the operator.
2. **Managed deployment secrets never enter a repository, manifest, plan, API response, log or
   AI context.** They are resolved just in time for one typed adapter operation.
3. **Plan is read-only.** No discovery or preview operation may mutate a provider, target,
   repository or monitoring service.
4. **Apply means the reviewed plan.** Drift invalidates the plan; the server never silently
   replans and continues.
5. **A release names exact bytes.** It records the full commit SHA, canonical payload-tree
   SHA-256 and transport-archive SHA-256, not merely a branch or tag.
6. **One normal control plane mutates each unit.** For the first static recipe, PSM reconciles
   infrastructure while GitHub Actions builds and releases the client. A second local release
   executor must not target the same unit.
7. **Activation is atomic and rollback reactivates retained bytes.** Rollback never rebuilds
   an old branch.
8. **Dependencies are assertions about observed environments.** Branch ancestry is useful
   source context but never evidence that a dependency is deployed.
9. **Resource ownership is explicit.** PSM will not update or delete an unowned provider
   object merely because its name matches.
10. **Locks name real mutation targets.** Project and environment names are not lock keys.
11. **Production policy is a server-side ceiling.** A request or manifest can ask for stricter
    handling, never weaken the locally configured risk policy.
12. **Watch is external.** PSM displays monitoring state but is not the process responsible for
    continuous uptime or certificate-expiry detection.
13. **Stable project IDs own history.** Folder names remain display labels only.
14. **Repository content is untrusted input.** No manifest field becomes privileged shell,
    nginx or sudo text.

## 4. Vocabulary and ownership

### Environment

An arbitrary stable identifier such as `preview`, `staging`, `production-eu` or `production`,
plus a risk class. PSM does not infer risk from the identifier.

Risk classes in v1 are `development`, `staging` and `production`. Local policy may promote an
environment to a stricter class but cannot demote the class committed by the project.

### Deployment unit

The smallest independently released part of a project. Todo's static client is one unit. The
Todo API is not another todo-app unit because it is built and released by werewolf-dapp; it is
a cross-project dependency.

### Artifact

Immutable bytes plus metadata: a PSM logical artifact ID assigned before packaging, provider
artifact locator, kind, full source commit, root package version, build-profile digest, payload
digest, archive digest, producer, creation time and provenance URL. V1 supports `static-files`.
Future kinds can include service bundles and container images without changing what an environment
or dependency means. Provider IDs are locators, never the identity embedded in served bytes.

### Executor

The system authorized to build and/or deliver an artifact. V1 implements `github-actions` for
managed releases. A future `local-agent` executor is a separate adapter and must be deliberately
selected; it is not a fallback when GitHub is unavailable.

### Target

Where a unit is activated, such as an SSH release directory or managed platform application.
The target contains no branch policy, DNS ownership or public hostname.

A resolved target has a canonical non-secret identity: adapter kind, logical target ID, provider/
host identity, canonical root, environment, unit and target-contract revision. This identity—not
the connection alias—is hashed into plans, locks, CI contracts and release receipts. Several
projects sharing one host therefore remain separate release targets while still rolling up to one
shared host view.

### Resource

Desired infrastructure reconciled independently of a release: DNS, directory layout, nginx
ingress and TLS certificate in the first recipe. A resource adapter observes, diffs, applies
and verifies one typed resource.

### Dependency assertion

A read-only condition that must be true before mutation. It can refer to a stable PSM project
ID, an external capability or a provider object, but it resolves to typed observable evidence.

### Verification probe

An immediate, bounded assertion run before or after activation. Verification answers whether
the release just attempted is acceptable. It is not continuous monitoring.

### Watch

Fresh state read from an external monitoring provider: public HTTP health, latency, TLS expiry
and incidents. Host capacity belongs to the shared target view, not to every project card.

### Recipe

A versioned expansion from a concise manifest into typed units, resources, dependencies,
verification steps and locks. Recipe expansion occurs during planning and the expanded graph is
stored with the plan. Adapters dispatch on their own versioned `kind`, never on one growing
project-type switch. A unit's `resourceRefs` names the independently declared resources the recipe
assembles; expansion does not create duplicate implicit resources with hidden ownership.

## 5. Committed manifest

Each participating project owns `.psm/deployments.json`. It is committed beside
`.psm/identity.json`, uses the stable project ID, and contains no machine paths outside declared
targets, credentials, credential-file paths or secret-variable references. Explicit public build
inputs are allowed, displayed and included in artifact provenance.

The v1 envelope is:

```json
{
  "apiVersion": "psm.werewolf.solutions/deployments/v1",
  "kind": "DeploymentManifest",
  "projectId": "prj_e4713173923933470bd3",
  "environments": []
}
```

The schema lives in PSM at `schemas/deployment-manifest.v1.schema.json`. PSM validates the JSON
against that schema and then performs semantic validation. Unknown properties and unknown
adapter versions fail closed; they do not fall back to a generic command.

### 5.1 Todo production example

This is the target contract, not a claim that the named workflow, connections or monitor exist
today:

```json
{
  "apiVersion": "psm.werewolf.solutions/deployments/v1",
  "kind": "DeploymentManifest",
  "projectId": "prj_e4713173923933470bd3",
  "environments": [
    {
      "id": "production",
      "risk": "production",
      "releasePolicy": {
        "allowedBranch": "master",
        "requireReachableFromBranch": true,
        "requireChecks": true,
        "approval": "authenticated-local-operator"
      },
      "connections": {
        "github": { "kind": "github-actions@1" },
        "dns": { "kind": "digitalocean-api@1" },
        "infrastructure": { "kind": "ssh-host-helper@1" },
        "werewolf": { "kind": "werewolf-api@1" },
        "monitor": { "kind": "external-monitor@1" }
      },
      "dependencies": [
        {
          "id": "todo-api",
          "kind": "http-status@1",
          "projectId": "prj_83c4a799bc7ca92d8e73",
          "request": {
            "url": "https://werewolf.solutions/api/v1/apps/todo/board",
            "method": "GET"
          },
          "expect": { "status": 401 }
        },
        {
          "id": "todo-registration",
          "kind": "http-json@1",
          "projectId": "prj_83c4a799bc7ca92d8e73",
          "request": {
            "url": "https://werewolf.solutions/api/v1/apps/todo/public?redirectUri=https%3A%2F%2Ftodo.werewolf.solutions%2Fauth%2Fcallback",
            "method": "GET"
          },
          "expect": {
            "status": 200,
            "equals": [
              { "path": "$.success", "value": true },
              { "path": "$.data.redirectAllowed", "value": true }
            ]
          }
        },
        {
          "id": "todo-backup-policy",
          "kind": "werewolf-backup-policy@1",
          "connection": "werewolf",
          "projectId": "prj_83c4a799bc7ca92d8e73",
          "environment": "production",
          "expect": { "scheduled": true, "lastSuccessMaxAgeHours": 26 }
        }
      ],
      "resources": [
        {
          "id": "public-dns",
          "kind": "digitalocean-dns-record@1",
          "connection": "dns",
          "desired": {
            "zone": "werewolf.solutions",
            "type": "A",
            "name": "todo",
            "valueFrom": { "connection": "infrastructure", "field": "address" },
            "ttl": 300
          }
        },
        {
          "id": "site-directory",
          "kind": "host-release-directory@1",
          "connection": "infrastructure",
          "desired": {
            "root": "/var/www/todo.werewolf.solutions",
            "retainReleases": 5
          }
        },
        {
          "id": "ingress",
          "kind": "nginx-static-site@1",
          "connection": "infrastructure",
          "dependsOn": ["resource:site-directory", "resource:public-dns"],
          "desired": {
            "hostname": "todo.werewolf.solutions",
            "documentRoot": "/var/www/todo.werewolf.solutions/current",
            "spaFallback": true,
            "denyPrefixes": ["/api/"],
            "cachePolicy": "vite-hashed",
            "securityHeaders": "werewolf-static-spa@1"
          }
        },
        {
          "id": "tls",
          "kind": "letsencrypt-certificate@1",
          "connection": "infrastructure",
          "dependsOn": ["resource:public-dns", "resource:ingress#http-ready"],
          "desired": {
            "hostname": "todo.werewolf.solutions",
            "renewal": "automatic"
          }
        }
      ],
      "units": [
        {
          "id": "web",
          "recipe": "static-ssh-nginx@1",
          "resourceRefs": [
            "resource:public-dns",
            "resource:site-directory",
            "resource:ingress",
            "resource:tls"
          ],
          "artifact": {
            "kind": "static-files@1",
            "output": "client/dist",
            "buildProfile": {
              "id": "production",
              "publicInputs": {
                "VITE_API_BASE": "https://werewolf.solutions/api/v1",
                "VITE_WEREWOLF_WEB_ORIGIN": "https://werewolf.solutions"
              }
            }
          },
          "executor": {
            "kind": "github-actions@1",
            "connection": "github",
            "sourceRepository": "Werewolf-Solutions/todo-app",
            "prepareWorkflow": "build-static.yml",
            "releaseController": "werewolf-static@1"
          },
          "target": {
            "kind": "ssh-release-directory@1",
            "targetId": "werewolf:todo-production-web",
            "observerConnection": "infrastructure",
            "root": "/var/www/todo.werewolf.solutions"
          },
          "verification": [
            {
              "id": "home",
              "kind": "http-status@1",
              "request": { "url": "https://todo.werewolf.solutions/", "method": "GET" },
              "expect": { "status": 200 }
            },
            {
              "id": "callback-fallback",
              "kind": "http-status@1",
              "request": {
                "url": "https://todo.werewolf.solutions/auth/callback",
                "method": "GET"
              },
              "expect": { "status": 200 }
            },
            {
              "id": "api-sealed",
              "kind": "http-status@1",
              "request": { "url": "https://todo.werewolf.solutions/api/x", "method": "GET" },
              "expect": { "status": 404 }
            },
            {
              "id": "served-release",
              "kind": "release-metadata@1",
              "request": {
                "url": "https://todo.werewolf.solutions/version.json",
                "method": "GET"
              },
              "expect": {
                "commit": "$release.commit",
                "psmArtifactId": "$release.psmArtifactId"
              }
            }
          ]
        }
      ],
      "watch": [
        {
          "id": "public-web",
          "kind": "external-http-monitor@1",
          "connection": "monitor",
          "unit": "web",
          "monitorKey": "todo-production-web",
          "hostname": "todo.werewolf.solutions",
          "maxObservationAgeSeconds": 180
        }
      ],
      "policy": {
        "planTtlSeconds": 600,
        "rollbackOnVerificationFailure": true,
        "allowDelete": false,
        "requireFreshWatchBeforeRelease": true
      }
    }
  ]
}
```

The backup assertion is deliberately blocking. Current werewolf-dapp documentation says the
backup procedure is proven but unscheduled; production planning therefore reports this gate as
failed instead of letting a branch name stand in for readiness.

Known repository-grounded blockers on 2026-08-24:

- todo's release workflow exists only in its local checkout and is not the prepare/release contract
  above;
- the todo API work is not present on werewolf-dapp's `dev` or `master` deployment refs;
- production PSM CloudApplication registration/migration is still outstanding, so the required
  authenticated local production approval cannot work yet;
- the connection profiles, host helper, trusted workflows and external monitor do not exist; and
- `werewolf-backup-policy@1` has no authoritative provider surface today.

That backup probe is required cross-project work owned by werewolf-dapp: expose a narrow read-only
scheduled/last-success readiness endpoint or a separately authorized host observation. The current
`werewolf:psm-readonly` capability reports PSM billing/storage readiness, not Mongo backup health.
Until that surface exists and the backup is scheduled, the adapter returns `blocked`; it never
parses an operations document and calls that live evidence.

### 5.2 Validation

Schema and semantic validation enforce at least:

- the `projectId` equals the committed `.psm/identity.json` value;
- environment-wide unique IDs, typed references such as `resource:public-dns`, allowlisted adapter
  substates such as `resource:ingress#http-ready`, and an acyclic expanded action graph;
- known, explicitly versioned adapter and recipe kinds;
- strict environment, resource and unit ID syntax;
- relative artifact paths without traversal or symlinks escaping the checkout;
- a repo-root `package.json` with the workspace's strict `X.Y.Z` version; no manifest field may
  redirect version lookup to a subpackage;
- explicit non-secret build inputs whose keys/values are bounded and shown in the plan; secret-
  shaped keys and values are rejected rather than passed to CI;
- normalized absolute target paths, checked again against the connection profile's allowed
  roots;
- HTTPS for non-development public probes, bounded timeouts and response sizes, no URL
  credentials and no redirects to a different origin;
- public-probe DNS/IP validation that rejects loopback, link-local, private and reserved targets
  before and after resolution; private targets require an explicit server-owned connection scope;
- normalized hostnames and provider-specific resource constraints;
- connection aliases that resolve to profiles of the required kind;
- unit `resourceRefs` that exist, are compatible with the recipe and cover every resource the
  recipe requires;
- no shell, sudo, raw nginx, static authorization header, secret value, env-file path or
  credential-shaped property; and
- recipe-specific invariants, including the `/api/` seal for this static SPA recipe.

The only symbolic values in v1 are the documented exact `$release.*` fields accepted by specific
verification schemas. There is no general expression, environment expansion or string-template
language.

Manifest validity does not prove readiness. Missing local connections, failed dependencies,
unowned resources and observed drift are planning results.

## 6. Desired state, observation and ownership

Every built-in resource adapter implements the same contract:

```ts
interface ResourceAdapter<Desired, Observed, Action> {
  validate(desired: Desired, connection: ConnectionMetadata): ValidationResult;
  observe(context: ObserveContext, desired: Desired): Promise<ObservedResult<Observed>>;
  diff(desired: Desired, observed: ObservedResult<Observed>): DiffResult<Action>;
  apply(context: ApplyContext, action: Action): Promise<ApplyResult>;
  verify(context: VerifyContext, desired: Desired): Promise<VerificationResult>;
  lockKeys(desired: Desired, connection: ConnectionMetadata): string[];
}
```

`observe` is read-only and returns normalized, redacted data plus a provider revision, ETag or
fingerprint whenever one exists. `diff` is deterministic and has no I/O. `apply` accepts only
the typed action stored in the approved plan.

Resource states are:

- `in-sync` — owned and equal to desired;
- `create` — absent and safe for this adapter to create;
- `update` — owned but different;
- `adopt` — an existing object matches but has no PSM ownership binding;
- `conflict` — an unowned object differs, ownership is ambiguous or duplicates exist;
- `blocked` — a dependency, connection or permission is unavailable; and
- `unknown` — observation failed or was incomplete.

`conflict`, `blocked` and `unknown` prevent mutation. Adoption is a separate reviewed operation:
it binds the exact provider object ID and observed fingerprint to the manifest resource ID,
then requires a fresh plan. PSM never combines first-time adoption and mutation in one action.

Provider bindings are local durable state keyed by project ID, environment, resource ID,
provider account and provider object ID. Losing the binding returns the object to `adopt` or
`conflict`; PSM does not infer ownership by hostname alone. Deletes are unsupported in v1 even
when a manifest entry disappears. A future delete action needs its own explicit policy and
approval class.

This is why the current DigitalOcean script is not a reconciler: finding any `todo` A record
and returning does not compare its address, TTL, duplicates or ownership.

## 7. Planning and approval

### 7.1 Operations

Artifact `prepare` is a durable non-target operation described in section 11. The plan/apply
operations are:

- `reconcile` — evaluate dependencies, apply only resource actions and verify desired resources;
- `release` — require referenced resources already in sync, stage one prepared artifact, activate
  it and verify it; infrastructure drift blocks instead of being repaired implicitly;
- `deploy` — reconcile, stage the prepared artifact, activate it and verify it in one reviewed
  graph; and
- `rollback` — compare-and-swap the active unit to an exact retained release and verify it, without
  rebuilding source or reconciling unrelated infrastructure.

Adoption is its own plan type and never mutates the provider object. Dependency definitions apply
to reconcile/release/deploy by default; only assertions explicitly marked `requiredForRollback`
may block an emergency rollback. Watch is continuous observation, not a run operation.

A cancellation before staging is immediate. During staging it cleans only the run's incoming
directory. Once activation begins, cancellation becomes a request: the executor completes the
atomic switch and mandatory verify/pre-authorized rollback path before it can end. Production
cancellation uses the same authority policy as production approval.

### 7.2 Plan creation

A plan request names:

- stable project ID, local checkout ID and environment ID;
- operation: `reconcile`, `release`, `deploy` or `rollback`;
- a prepared PSM artifact ID for release/deploy, resolving to provider locator, full source commit
  and digests; and
- unit IDs, or all units when omitted.

The checkout ID is an installation-local handle for one canonical real path. History remains owned
by stable project ID, but two clones carrying the same `.psm/identity.json` are ambiguous execution
sources; PSM refuses a managed plan until the request selects one checkout. For release/deploy,
PSM reads `.psm/deployments.json`, `.psm/identity.json` and root `package.json` from the exact Git
object named by the artifact commit, not from the mutable worktree, and requires the artifact result
to carry the same manifest/build-profile digest. Reconcile/adoption plans likewise require the
selected manifest to be committed; a dirty manifest may be previewed but cannot be approved.

The server loads and hashes the manifest, expands recipes, resolves connection metadata,
verifies source policy and artifact provenance, runs dependency probes, observes resources and
current releases, and produces a canonical plan. Artifact preparation is a separate non-target
run; planning never starts a build or workflow. It does not resolve secret values during planning
unless a provider cannot perform a read without one; if it does, the value remains inside that
adapter call.

For a new release, the prepared artifact's repo-root version must be greater than the active
release version under the workspace `X.Y.Z` ordering. Rollback selects a retained release and is
exempt. A deliberate decrease is a separately acknowledged policy exception and is allowed only
when the selected commit message contains an explicit rationale, which the plan preserves.

A plan stores:

- `planId`, revision, created/expiry times and risk class;
- project, environment, operation and initiating agent/device;
- manifest digest and the complete expanded graph;
- exact PSM artifact ID, GitHub artifact ID/producer run, payload-algorithm ID, payload/archive
  digests, build-profile digest, commit, source repository, producer and required-check result;
- manifest/identity/package blobs read from that exact Git commit and their digests;
- checkout ID, connection/profile revisions, authenticated provider principals and secret
  generations (never secret values);
- effective local-policy revision, PSM engine version, schema version and adapter/recipe
  implementation digests;
- release-controller repository, workflow, protected ref, expected commit/blob digest, Environment
  mapping and artifact-reader App/installation identity;
- redacted desired and observed snapshots with their fingerprints;
- ordered typed actions and verification steps;
- every target lock key;
- dependency evidence and watch freshness;
- warnings, blockers and required acknowledgements; and
- a SHA-256 digest of RFC 8785 canonical JSON, prefixed by the deployment-plan schema/domain
  version, for all fields that can affect execution.

Volatile presentation fields such as explanatory prose are outside the digest. Actions,
preconditions, identities, policies and inputs are inside it.

### 7.3 Approval

Approval is a durable one-use record containing:

```ts
interface DeploymentApproval {
  planId: string;
  planRevision: number;
  planDigest: string;
  risk: "development" | "staging" | "production";
  actor: { kind: "local-operator" | "werewolf-user"; subject: string | null };
  agentId: string;
  origin: "local" | "paired";
  acknowledgementIds: string[];
  approvedAt: number;
  expiresAt: number;
  consumedAt: number | null;
}
```

The approval endpoint receives the plan ID, revision, digest and explicit acknowledgement IDs.
Inside one database transaction it checks that the plan is current, unblocked, unexpired and
unconsumed; applies the server-side risk ceiling; records approval; creates the run; and consumes
the approval. There is no later unbound “execute this” request.

For this workspace, production uses `authenticated-local-operator`: the approval must come from
the loopback cockpit and carry a valid Werewolf session so the actor is attributable. Paired
browsers may inspect and plan production but cannot approve it. Staging may use `local-operator`
or an authenticated paired operator according to local policy.

**Standing approval (2026-09-24, P02).** A plan created by Make ready may instead be approved by
an operator-set `deploy.approve` rule for its environment (Agent permissions; the Operate staging
preset adds one for `staging`). It uses the same `approveAndQueue` transaction and binds the same
plan ID, revision and digest; the record's actor is `local-operator` with subject
`policy:<rule id>@r<policy revision>`, so every run names the rule and policy revision that stood in
for a review. A plan that requires acknowledgements — every production plan requires
`production-target`, and version decreases add their own — is approved by rule only when that rule
is scoped to exactly that environment, i.e. an explicit owner choice; an unscoped grant or the Full
access preset never claims it. Without a covering rule the plan waits for review exactly as above.

This is an accident and accountability boundary, not an OS sandbox. PSM's current security model
trusts processes running as the same local user; a malicious process with that user's filesystem
and loopback access cannot be strongly isolated by an in-process keychain wrapper. Install the
credential broker/helper under a separate OS identity if protection from same-user processes or
full-access coding agents is required.

### 7.4 Apply-time preconditions

Before mutation and again after any long queue/environment-approval wait, the runner rechecks
global dependencies, artifact retention/digests, source/check policy, Watch freshness, connection
principal/revisions, effective policy, implementation/workflow trust and the lock set. A mismatch
ends the run as `stale-plan` without silently generating a replacement.

Every mutation also performs its own compare-and-set immediately before apply, using the provider
revision, object fingerprint or exact current release captured for that action. A successful action
records and verifies its postcondition; that postcondition—not the original observation—becomes the
expected input for dependent actions. The runner therefore detects concurrent drift without
mistaking its own earlier reconciliation for drift. The remote workflow/helper repeats plan-expiry
and current-release CAS immediately before activation.

The operator sees what changed and creates a new plan. This is the deployment equivalent of the
existing attachment workflow's preview-digest and apply-time ownership checks.

### 7.5 Local policy and request authority

Local SQLite stores versioned `deployment_policies` at global/risk, project, environment and target
scope. Production has no permissive implicit default: until a local policy classifies its target
and approval mode, planning is blocked. Effective policy composes fail-closed:

- effective risk is the strictest of manifest risk, policy minimums and every target/connection
  minimum-required risk;
- a connection's maximum-authorized risk must cover that effective risk;
- plan TTL and maximum Watch age take the smallest configured value;
- required check names/app IDs are the union, while allowed source refs are the intersection;
- authenticated/local approval requirements take the strictest mode; and
- delete, automatic rollback, break-glass and paired approval are allowed only when every
  applicable server-owned policy allows them.

The plan stores the resulting policy and every input revision. Manifests may make any field
stricter, never looser. Required checks name exact contexts and publisher/app IDs; the release
workflow's own pending check is excluded from becoming a circular prerequisite.

For `authenticated-local-operator`, the actor record is `{ kind: "werewolf-user", origin:
"local" }`. The server records the currently signed-in machine session; it does not claim proof
that the account owner personally clicked. Production approval rejects no-Origin and non-loopback
HTTP requests, requires the exact local-cockpit origin, a same-session intent/anti-CSRF nonce, a
current Werewolf subject and the complete server-generated acknowledgement set. A retried approval
for the same plan revision/digest returns its existing run through a unique database relation; it
cannot create a second run.

Connection create/delete/binding, every constraint change, secret create/rotate/delete, local
policy changes, helper enrollment and production cancellation are subject to the same loopback
authority rule. Paired callers can read redacted readiness and run allowed connection tests but
cannot change authority-bearing state.

## 8. Connections and secret isolation

The committed manifest declares connection **slots and kinds**, not local profile names. Local
SQLite binds each `{checkout, environment, slot}` to a named profile, for example:

- `dns` → `digitalocean:werewolf-dns`;
- `infrastructure` → `ssh:todo-production`;
- `github` → `github:werewolf-actions`;
- `werewolf` → `werewolf:psm-readonly`; and
- `monitor` → `monitor:werewolf-public`.

That binding is local authority: another clone or operator can select a different authorized
profile without changing committed desired state. A new binding is previewed and confirmed; a
manifest change cannot bind itself to a more powerful profile.

The profile name and non-secret configuration live in local SQLite. Secret slots live in the OS
keychain. If no supported keychain is available, PSM may hold an entered value in memory for the
current process; it must not fall back to plaintext disk.

The API returns profile kind, readiness, constraints, secret generation and either a provider/
public-key identity or keyed HMAC fingerprint only—never a plain hash of a low-entropy secret. It
never returns a secret value. Creating or changing a secret is loopback-only; the hosted paired UI
can report a missing connection but cannot submit credential material.

Each profile contains server-owned constraints, including where applicable:

- allowed stable project IDs and environment IDs;
- provider account, zone or repository allowlists;
- exact SSH host, user, port and pinned host-key fingerprint;
- canonical target roots and component-aware allowed-root prefixes;
- allowed GitHub source owner/repository, prepare workflow and required-check publishers;
- release-controller mappings to the fixed control repository, dispatch workflow, immutable
  protected ref, expected full commit/workflow-blob digest and target Environment;
- the cross-repository artifact-reader GitHub App/installation identity and source-repository
  allowlist;
- allowed source refs and required check context/publisher IDs;
- allowed monitor IDs; and
- minimum-required risk for a target plus maximum-authorized risk for a credential.

A manifest slot cannot widen these constraints. If a production slot is bound to a profile scoped
to staging, resolution fails before any secret is fetched. The PSM-side GitHub profile has only
contents/checks/Actions read on allowed source repositories plus contents/Actions read and workflow
dispatch on the fixed control repository; it cannot administer repositories, Environments or
secrets. Werewolf and monitoring profiles are read-only. Provider limitations that prevent a truly
DNS-only DigitalOcean token are called out as residual risk rather than disguised as least
privilege.

Managed adapters use built-in provider clients or `execFile`/`spawn` with structured argv and
`shell: false`. Option-shaped input is rejected or placed after `--`. Each operation receives a
minimal environment allowlist. Deployment credentials never enter `childEnv()`, project scripts,
coding-agent processes or arbitrary repository hooks.

Secrets exist only in the broker/typed adapter's bounded ephemeral memory. Adapters emit structured,
allowlisted events rather than raw provider responses wherever possible. Before execution, the
runner registers resolved and known derived sensitive values with a chunk-boundary-safe streaming
redactor; output passes through it before persistence, broadcast or display. Redaction is defense
in depth, not the primary secret boundary.

Temporary private-key files use a fresh `0700` directory and `0600` file, are unlinked as soon as
the adapter exits and are never placed under a checkout. File-descriptor/stdin or memory-backed
delivery is preferred when the tool supports it. Startup scavenges only validated PSM-owned stale
temporary directories by age and ownership.

SSH additionally requires `BatchMode=yes`, `IdentitiesOnly=yes`, `IdentityAgent=none`, strict
host-key checking against the pinned profile, no agent fallback and no sudo for the release key.
There is no execution-time `ssh-keyscan` trust-on-first-use and no interpolation of manifest values
into an SSH remote command: SSH reaches only the fixed forced-command/versioned-JSON protocol.

### 8.1 Least-privilege host helpers

The static recipe uses two target credentials:

1. A per-project/environment **release key** can stage, list and activate releases only within
   that unit's release root. It has no sudo and is restricted by a forced command or equivalent
   target-side protocol.
2. A separately approved **infrastructure helper** performs the narrow privileged operations
   required for directory ownership, nginx and certificate reconciliation.

The helper is root-owned and installed once by a human. It accepts versioned JSON over stdin,
validates hostnames and paths against root-owned configuration, renders nginx from built-in
templates, runs `nginx -t` before reload, and invokes only fixed certbot operations. It does not
accept shell, arbitrary argv, repository paths or nginx text. Its sudo rule, if used, permits only
the helper binary—not a shell or general `systemctl`, `cp` or `certbot` access.

Before PSM can reconcile a target, a separate loopback-approved enrollment installs its canonical
target contract in root-owned helper configuration and creates the lock namespace under
`/var/lib/psm-deploy/locks/`. The lock path is derived from SHA-256 of the canonical target ID, not
from manifest path text, and exists before the release root does. Enrollment is the only bootstrap
step allowed to create this authority; an ordinary deployment plan cannot enroll itself.

The helper, not merely PSM, resolves and pins the configured root, compares path components rather
than string prefixes, refuses symlinked root/components and uses descriptor-relative/no-follow file
operations where the platform permits. A manifest path can only narrow the root-owned target
contract.

The control repository's target Environment secrets hold the release key used by the GitHub
executor. PSM's local host profile holds only what its infrastructure adapter needs. This is an
intentional split of duties, not two executors racing to release the same bytes.

## 9. Locks and concurrency

A lock key is derived from normalized mutation identity, never a display name. Examples include:

- `do:<account-id>:dns:werewolf.solutions:A:todo`;
- `ssh:<host-key-fingerprint>:/var/www/todo.werewolf.solutions`; and
- `github:Werewolf-Solutions/deployment-control:target:<canonical-target-digest>`.

Before a run mutates, it sorts and atomically acquires all keys in SQLite. A lock row records run,
agent, process boot ID, acquisition time, lease expiry and heartbeat. Acquisition uses a database
transaction and a unique key so two local runs cannot both win. Locks remain held until the
terminal run state is committed; stale leases are recovered conservatively after observation.

SQLite coordinates one PSM installation only. Cross-machine enforcement is layered:

- GitHub Actions uses a group derived from the canonical target digest with
  `cancel-in-progress: false`. Sending all v1 managed releases through the control repository makes
  that group effective across source projects, but it remains repository-scoped and cannot cover
  external/manual helpers or a future second controller;
- every target-helper operation that can mutate the release root, `current`, layout, incoming
  files or garbage collection acquires the same definitive target-side lock; infrastructure-helper
  ingress operations whose safety depends on that root acquire it too, alongside their own
  host/nginx lock in canonical sorted order;
- stage/activate/rollback use the same lock and an expected-current compare-and-swap, including
  direct break-glass dispatches; and
- provider adapters use provider revisions/ETags or compare-before-write where supported.

DNS and other disjoint provider objects keep separate keys. No implementation may claim two scopes
are disjoint merely because one call came from PSM and the other from GitHub; the helper's typed
operation schema declares the lock keys it must hold, and its receipt proves acquisition.
The definitive file lock is `/var/lib/psm-deploy/locks/<sha256(canonical-target-id)>.lock` in the
pre-enrolled helper-owned namespace, never inside a release root that the lock must help create.

An out-of-band GitHub dispatch is break-glass activity. PSM discovers and records its resulting
release as external by listing the helper's immutable `release.json` receipts and comparing the
active link. Provenance is `external`, no PSM approval/run is fabricated, cached observations are
invalidated and the next managed action requires a fresh plan.

## 10. Run state, persistence and recovery

Managed runs have immutable IDs and explicit phases. The normal path is:

`queued → acquiring-locks → checking-preconditions → reconciling → dispatching →
waiting-executor → observing-result → verifying → succeeded`

Phases that do not apply to an operation are skipped. Remote staging, target-lock acquisition,
activation and conditional rollback are persisted as typed executor steps/events beneath
`waiting-executor`; PSM does not claim that local staging happened before it dispatched GitHub.

Terminal alternatives are `failed`, `cancelled`, `interrupted`, `stale-plan` and `rolled-back`.
Rollback failure is `failed` with a critical `rollback-failed` event; it is never reported as a
successful rollback. `recovery-required` is nonterminal: an accepted side effect has an uncertain
outcome, so locks remain held and automatic retry is forbidden until observation classifies it.
Loss of durable logging sets an `auditDegraded` flag on the run; it is an annotation, not another
ambiguous status.

Artifact preparation is also a durable run, but it has no infrastructure locks or approval and
cannot access a GitHub deployment environment. Its normal path is `queued → dispatching →
waiting-executor → importing-artifact → succeeded`. A deployment run references the completed
artifact run rather than absorbing its mutable build steps.

Each side-effecting step has a stable idempotency key and durable `prepared → submitted → observed
→ completed` state. Intent and preconditions are committed before submission. A crash after a
provider accepts work but before PSM records the response leaves `submitted`, which startup observes
by provider object/action ID before deciding whether to complete, retry or require recovery. An
uncertain DNS create, workflow dispatch or activation is never blindly repeated.

Events have a monotonic sequence number and contain redacted structured data:

```ts
interface DeploymentEvent {
  runId: string;
  sequence: number;
  at: number;
  type: string;
  phase: string;
  level: "info" | "warning" | "error";
  message: string;
  data: DeploymentEventData;
}
```

`DeploymentEventData` is a versioned discriminated union per event type with bounded, normalized
fields. Arbitrary provider objects and response bodies cannot become queryable event JSON; capped
redacted diagnostic text belongs only in the raw run log.

SQLite stores queryable deployment state:

- manifests cached by digest;
- connection metadata and local manifest-to-profile bindings;
- provider resource ownership bindings;
- plans and their immutable expanded actions;
- approvals;
- runs, steps and ordered events;
- target locks and leases;
- artifacts and releases; and
- latest external-monitor snapshots.

The relational boundary is explicit; illustrative key columns are:

```text
deployment_manifests       (project_id, checkout_id, environment_id, commit_sha, digest, document)
deployment_connections     (connection_id, kind, metadata_revision, secret_generation, constraints)
deployment_connection_bindings
                           (checkout_id, environment_id, slot, connection_id, binding_revision)
deployment_policies        (scope_kind, scope_id, revision, policy)
deployment_resource_bindings
                           (project_id, environment_id, resource_id, provider_account, object_id,
                            observed_fingerprint)
deployment_plans           (plan_id, revision, digest, expires_at, immutable_document)
deployment_plan_actions    (plan_id, revision, ordinal, action_digest, preconditions)
deployment_approvals       (approval_id, plan_id, revision, digest, actor, expires_at, consumed_at)
deployment_runs            (run_id, approval_id?, artifact_run_id?, state, phase, audit_degraded)
deployment_run_steps       (run_id, ordinal, action_digest, idempotency_key, state, external_id?)
deployment_events          (run_id, sequence, event_type, payload)
deployment_target_locks    (lock_key, owner_run_id, owner_boot_id, lease_expires_at, heartbeat_at)
deployment_artifacts       (psm_artifact_id, source_repository, github_artifact_id,
                            producer_run_id, commit_sha, payload_digest, archive_digest,
                            retained_until, tombstoned_at?)
deployment_releases        (release_id, psm_artifact_id, target_id, previous_release_id?,
                            provenance, activated_at, tombstoned_at?)
deployment_watch_snapshots (monitor_id, environment_id, unit_id, observed_at, normalized_state)
```

Question marks mark nullable relationships, not optional integrity. Secret values are absent from
this schema. JSON columns use versioned, strictly validated documents rather than open-ended bags.

Database constraints carry the safety claims:

- a plan revision/digest is immutable and an approval is unique to that exact pair;
- one consumed approval creates exactly one durable queued run;
- step idempotency keys, external workflow run IDs, PSM artifact IDs, source-repository/GitHub
  artifact-ID pairs and target release IDs are unique;
- event primary key is `(run_id, sequence)` and sequence allocation is transactional;
- a canonical lock key has one live lease owner; and
- artifacts/releases reference their producing run and retain tombstones when bytes/logs expire.

The startup worker reads durable queued/recovery rows; queueing is never an in-memory-only callback.

All of this is local by default. Connections, approvals, target locks, observations and raw logs
are excluded from PSM Cloud sync. If release summaries are synced later, they get a separate
redacted schema containing only project/environment/unit IDs, version, commit, digests, timestamps
and public health—not target paths, provider object IDs, connection names or operator credentials.

Before deployment state ships, `.psm-data/`, `.psm-deploy-logs/` and credential temp directories
become hard exclusions from PSM Cloud source backups as well as sync. Structured run/release
metadata remains until explicitly pruned; raw logs default to 90 days with a configurable global
size cap and never evict an active run. Pruning records a tombstone rather than making a past run
look as if it never existed.

Raw per-run output is a separate `0600` file under `.psm-deploy-logs/<runId>.log`; it is never
overwritten by a later run. Database rows point to it and say when logging was degraded. PSM-owned
state directories must be tightened to `0700` before credential or deployment state is introduced.

On startup:

- a local adapter whose process no longer exists becomes `interrupted` after its last side effect
  is observed;
- a remote GitHub run is reattached by its persisted workflow run ID and polling resumes;
- a submitted action without a conclusive provider result is observed by its idempotency key and
  otherwise enters `recovery-required`;
- an expired lock is not discarded until the target/resource is observed; and
- success, cancellation and rollback are never inferred solely from PSM disappearing.

Shutdown stops accepting jobs, marks local work `interrupting`, terminates owned process groups,
flushes events, commits `interrupted` where appropriate and releases locks only after the terminal
state is durable. Cancellation of a remote run is a request to GitHub; PSM observes the target
before deciding whether it is cancelled, failed or already activated.

## 11. GitHub Actions executor contract

PSM's initial managed executor has separate **prepare** and **release** workflows. Preparation runs
in the source repository. Release is dispatched directly in the organization-controlled
`Werewolf-Solutions/deployment-control` repository; there is no project-owned secret-bearing caller.
That control repository owns the target GitHub Environments, restricted release keys and
cross-repository artifact-reader credential. This separation lets the operator approve exact bytes:
preparation produces an immutable artifact without target authority, and only the central release
workflow can reach the target. Neither workflow accepts a host, target path, key or arbitrary
command as input.

### 11.1 Prepare artifact

Preparation may be triggered by ordinary CI on a commit or requested by PSM as a durable
non-target run. It receives:

- `psm_run_id` when PSM initiated it;
- `psm_artifact_id`, assigned before packaging (an independently triggered workflow generates one
  before it writes metadata);
- `project_id`, `environment_id` and `unit_id`;
- full `commit_sha`; and
- canonical public build-profile JSON plus its digest.

The prepare workflow:

1. checks out the exact SHA and verifies repository identity;
2. installs and tests on the runner;
3. exposes only the reviewed public build inputs, then builds the declared output—never on the
   droplet;
4. reads the version from the repo-root `package.json`;
5. writes served metadata containing full commit, version, unit and `psm_artifact_id`;
6. rejects symlinks, hardlinks, sockets, devices, FIFOs, traversal, duplicate paths and configured
   file-count/unpacked-size limits in the actual output tree;
7. writes a `psm-static-tree-sha256@1` file manifest and calculates the extracted **payload
   digest**;
8. creates one tar archive, calculates its **archive digest**, and uploads that tar as an opaque
   GitHub artifact named by `psm_artifact_id` rather than relying on GitHub's wrapper digest;
9. resolves the uploaded artifact's GitHub numeric ID within this exact producer run and uploads a
   redacted `psm-artifact-result.json` containing both IDs; and
10. runs with a read-only GitHub token, no deployment environment and no release secrets.

#### Static payload digest

`psm-static-tree-sha256@1` is byte-defined so the source runner and target helper compute the same
identity independently:

1. The workflow overwrites the root `version.json` with generated metadata and reserves root
   `release.json`/`.psm-release.json`; source output using either reserved receipt name is rejected.
2. The tree contains directories and regular files only. Symlinks and other special entries are
   rejected; empty directories are ignored. File modes, mtimes, uid and gid are not semantic and
   extraction normalizes directories to `0755` and files to `0644`.
3. Every relative path uses `/`, consists of valid UTF-8 segments normalized to Unicode NFC, and
   contains no empty, `.` or `..` segment, NUL or backslash. A normalization collision is rejected.
4. Regular files are ordered by unsigned lexicographic comparison of their normalized UTF-8 path
   bytes. `version.json` is included. The generated manifest itself lives outside the served tree.
5. For each file, form `0x01 || uint32be(pathByteLength) || pathBytes || uint64be(fileByteLength) ||
   sha256(fileBytes)`, where the final digest is 32 raw bytes.
6. The payload digest is SHA-256 of UTF-8 `psm-static-tree-sha256@1` followed by NUL and every file
   record in that order. File/path/count limits are part of the algorithm profile and checked before
   hashing.

The algorithm ID, limits, payload digest and exact transport-archive digest appear in the artifact
result, deployment plan, execution contract, helper receipt and release result. A new canonical
algorithm requires a new versioned ID; an implementation upgrade cannot reinterpret an old digest.

The prepare workflow may be repository-owned at the exact source commit because it has no target
authority. PSM accepts its result only when every correlation field, manifest digest, build-profile
digest, commit, unit, version, payload digest and archive digest agrees with the requested run. It
imports the producer workflow/run, logical `psm_artifact_id`, provider `github_artifact_id`, both
digests, checks and retention deadline. The provider ID is accepted only if that run contains one
artifact with the logical name; PSM never treats a GitHub numeric ID as a served identity.

A release/deploy plan is blocked with `artifact-missing` until a retained artifact satisfies source
policy. If several artifacts claim the same commit/profile, the plan request must select one; PSM
never guesses. Both exact digests are part of the plan and approval.

### 11.2 Release prepared artifact

The manifest's logical `releaseController: "werewolf-static@1"` is resolved only by local policy.
In v1 it maps to `Werewolf-Solutions/deployment-control`, dispatchable workflow
`release-static.yml`, a protected immutable tag, its expected full commit and workflow-blob digest,
and one control-repository Environment mapped from the canonical target ID. PSM verifies the tag,
commit and blob immediately before dispatch and accepts a run only when its repository, workflow,
ref and `head_sha` attest the same values. Repository content cannot redirect the call to another
controller or Environment.

The control Environment also holds a GitHub App credential whose installation has Actions-read
access only to the allowed source repositories. The central job mints a short-lived installation
token, downloads the exact numeric `github_artifact_id` from the exact source repository and
producer run, then discards the token. It also requires the artifact name to equal the approved
`psm_artifact_id`. The PSM connection policy binds the App/installation identity and repository
allowlist; neither the project workflow nor manifest receives that credential.

Required release dispatch inputs are:

- `psm_run_id`;
- `project_id`;
- `environment_id` and `unit_id`;
- prepared `psm_artifact_id`, `github_artifact_id`, producer run ID, payload digest and archive
  digest;
- full `commit_sha`;
- approved `plan_digest` and expiry;
- generated `release_id`; and
- a bounded versioned execution contract plus its digest.

The execution contract contains only non-secret typed fields: operation, artifact identities,
payload-algorithm ID/limits, canonical target ID/fingerprint, expected current release ID/digest,
intended release or rollback ID/digest, plan expiry, allowed conditional rollback, PM2 invariant
and executor-owned probes. It contains no host, path, credential or shell text. The trusted
workflow validates its schema and digest; the control-repository Environment maps the canonical
target ID to protected host/path configuration.

The local infrastructure profile and `targets/<targetId>.json` at the pinned control-repository
commit carry the same non-secret target contract: target ID, SSH host-key fingerprint, canonical
release root, helper protocol, target Environment name and contract revision. PSM reads and hashes
that trusted file with its declared control-repository contents permission before approval,
compares it to local observation and puts its blob/fingerprint/revision in the plan. The central
workflow validates its Environment mapping against the same pinned file, while the target helper
validates and returns the same identity before mutation. A secret accidentally pointing at another
host therefore fails host-key/helper attestation. A mismatch anywhere is
`target-contract-mismatch`, so “exact target” does not rely on two coincidentally similar
configurations or access to Environment secrets.

The central dispatch workflow and every third-party Action are pinned to full commits. The
secret-bearing job starts on a fresh runner, checks out no project repository and executes no
artifact or repository code. Before dispatch, PSM rechecks artifact retention, digests, workflow
trust, target contract, source policy and required checks. The workflow repeats those checks,
rejects an expired plan before target contact, downloads the exact tar and verifies its archive
digest. It then performs one ordered activation protocol:

1. contact the restricted helper and acquire the canonical target-side lock before any mutation of
   `incoming`, releases, layout, `current` or garbage collection;
2. under that lock, attest the target contract, recheck plan expiry and compare
   `expectedCurrentReleaseId`/digest without switching it;
3. stage the archive into a fresh run-owned incoming path, safely extract it and recompute
   `psm-static-tree-sha256@1` with the approved limits and payload digest;
4. move the completed tree into the release-ID directory without overwriting an existing release;
5. immediately before activation, recheck expiry and expected current, then atomically switch
   `current` exactly once while retaining the previous target;
6. run the contract's typed target invariants and public smoke checks;
7. if those checks fail and the contract pre-authorized it, compare-and-swap back to the exact
   previous release ID/digest while the lock is still held;
8. write the immutable target receipt, perform only lock-protected retention/GC, and release the
   lock; and
9. publish a redacted, schema-validated `psm-release-result.json` for PSM to ingest.

The result names every correlation field, trusted workflow revision, target contract/receipt,
prepared artifact, payload-algorithm ID and both digests, target release ID, previous release ID,
activation time, verification results and rollback outcome. PSM accepts it only from the exact
dispatched control-repository run and re-observes the target through the local profile. The PSM
plan digest is correlation, not GitHub authorization; workflow trust, GitHub permissions and
environment protection remain authoritative in CI.

Manual rollback dispatches the same trusted workflow with `operation: rollback`, an exact retained
release ID/digest and expected current release. If PSM's own immediate verification disagrees with
a workflow that reported success, automatic rollback is allowed only when the approved contract
contains a still-valid rollback authorization; otherwise PSM creates a blocked manual rollback
plan rather than borrowing the infrastructure credential as a second release executor.

Both workflows set `run-name` to include the unique PSM run ID. PSM writes a dispatch intent before
the API request and persists the returned external run ID when the pinned GitHub API version
provides one. If PSM dies after GitHub accepts a dispatch but before the ID commit, startup searches
by the unique correlation ID and does not blindly dispatch again. The target helper also treats a
release ID as idempotent: the same ID and digests return the existing result, while the same ID with
different bytes is a conflict.

Mutating push-triggered workflows are removed when a project adopts managed release. A push may
still run CI or prepare an artifact, but normal activation happens only through the explicit release
workflow PSM dispatches. Direct release dispatch remains a documented break-glass route.

## 12. `static-ssh-nginx@1`

This recipe composes one `static-files@1` unit with its explicit `resourceRefs`, then expands that
graph into ordered infrastructure, release, activation and verification actions. It does not own a
second hidden copy of those resources. It preserves the existing droplet constraint: no package
installation or build on the host, and no new PM2 process.

### 12.1 Target layout

For target root `/var/www/todo.werewolf.solutions`:

```text
/var/www/todo.werewolf.solutions/
  current -> releases/rel_<id>/site/
  releases/
    rel_<id>/
      site/
        ...static files...
        version.json
      release.json
  incoming/
```

The definitive lock lives in the pre-enrolled helper namespace described in section 9, outside this
tree. `incoming` and `release.json` are never served. `version.json` is written before the site
archive is hashed and contains the commit/version/PSM artifact identity, but not either digest:
embedding a digest inside the bytes it hashes would be self-referential. `release.json` records the
verified payload and archive digests beside the served tree. A completed directory is immutable.
Activation creates a new temporary symlink and renames it over `current`, which is atomic on the
same filesystem.
Garbage collection runs only after a verified activation and retains the current, previous and
configured number of recent releases plus target-side pins held by an active execution contract.
A rollback plan re-observes its target and becomes stale if an older unpinned release has already
left the retention window; the target helper cannot rely on PSM's local database while PSM is off.

### 12.2 Reconciliation

The recipe's expansion orders these operations:

1. dependency assertions;
2. DNS observation and owned create/update;
3. release-directory layout;
4. `ingress#http-ready`: an HTTP-only nginx/ACME vhost when a certificate does not exist;
5. `tls#certificate-ready`: `certbot certonly --webroot` issuance or renewal-state verification;
6. `ingress#tls-ready`: the final TLS nginx configuration generated from typed fields;
7. `nginx -t` and graceful reload; and
8. re-observation of DNS, HTTP redirect, document root and certificate.

`nginx-static-site@1` is the sole owner of the vhost through both ingress substates;
`letsencrypt-certificate@1` owns certificate material only and never invokes certbot's nginx
rewriter. Recipe expansion stores the two ingress mutations as distinct actions and makes the
final action depend on the certificate postcondition. This staged adapter state machine resolves
first-certificate ordering without two resources fighting over one file.

This is reconciliation, so it is safe to rerun. A mismatched owned record produces an update diff;
an unowned record produces adoption/conflict. Certificate renewal remains the host's scheduled
certbot responsibility; PSM verifies that the timer and certificate state satisfy desired policy.

The generated nginx template provides:

- SPA fallback when requested;
- an explicit 404 for `/api/` before the fallback;
- cache policy matched to hashed or unhashed assets;
- no directory listing;
- a named built-in security-header/CSP profile selected in the manifest; and
- a document root ending in `/current`.

V1 does not accept arbitrary header or CSP text. Profiles are versioned built-in templates with
typed parameters and are shown in the plan. `werewolf-static-spa@1` is suitable for todo; PSM's own
hosted page uses a different profile because its loopback agent `connect-src`/framing permissions
must never leak into an ordinary static app.

### 12.3 Release and rollback

A release stages new bytes without touching `current`. Activation occurs only after digest and
artifact-shape verification. Public probes then verify `/`, callback fallback, `/api/` sealing and
the exact release metadata served.

The recipe captures a normalized PM2 application/status snapshot before and after release. Any
change is a failed invariant because this recipe must not add, restart or remove a process. It is
recorded with the run but is not shown as a permanent project-card metric.

If post-activation verification fails and policy permits automatic rollback, the already-approved
plan may reactivate the recorded previous release and run the same probes. Infrastructure updates
are not automatically reversed. A successful recovery ends `rolled-back`, preserving the failed
release and evidence for diagnosis. With no prior retained release, the run fails and reports that
automatic rollback was unavailable.

Manual rollback starts with a new plan naming an existing retained release ID and its stored digest.
It acquires the same target lock and never rebuilds source.

## 13. Dependencies and probes

Dependency evaluation precedes resource mutation as well as release. A dependency result records
the resolved target, observation time, bounded response evidence and pass/fail reason. Sensitive
response bodies are neither stored nor displayed.

Built-in v1 probes are:

- `http-status@1` — method, exact status, timeout and optional same-origin redirects;
- `http-json@1` — exact status plus allowlisted JSON-path equality predicates;
- `github-checks@1` — commit, required checks and conclusion;
- `project-release@1` — another PSM project/environment exposes a required capability and release;
- `release-metadata@1` — served commit/version/PSM artifact ID equals the release record;
- `werewolf-backup-policy@1` — read-only scheduled/last-success readiness; and
- adapter-specific provider observations used by resources.

HTTP probes have fixed size/time limits, validate TLS, reject cross-origin redirects by default and
do not accept arbitrary headers from a manifest. Public probes reject loopback, link-local,
private and reserved addresses and protect against DNS rebinding on every connection.
Manifest-authored probes permit only `GET` and `HEAD` (`OPTIONS` only for an adapter that
explicitly requires it), never state-changing methods. Authenticated or private probes reference a
connection whose server-owned scope authorizes only that exact endpoint.

For todo, `401` from the protected board route proves the route exists and is guarded; `404` proves
it is not ready. The CloudApplication check proves the exact production callback is permitted. A
future werewolf-dapp release manifest can publish a typed `todo-api@1` capability, allowing the HTTP
probe to be replaced by a stronger `project-release@1` assertion without changing todo's unit.

Workrooms present these edges and provide project links for coordination. The deployment engine,
not the workroom or AI narrative, enforces them.

## 14. Verification and external Watch

Verification is performed immediately by the runner and/or executor. Each result is attached to the
release run and names the exact release metadata it checked.

Continuous state comes from an external service in a different failure domain. The monitor adapter
normalizes provider data to:

```ts
interface WatchSnapshot {
  monitorId: string;
  environmentId: string;
  unitId: string;
  providerState: "healthy" | "degraded" | "down" | "paused" | "unknown" | null;
  freshness: "fresh" | "stale" | "missing";
  effectiveState: "healthy" | "degraded" | "down" | "paused" | "unknown" | "stale" | "not-monitored";
  observedAt: number | null;
  latencyMs: number | null;
  certificateExpiresAt: number | null;
  incidentUrl: string | null;
  provider: string;
}
```

PSM may refresh this while running, but the provider performs the checks and sends alerts while the
browser, laptop and agent are off. A snapshot older than `maxObservationAgeSeconds` renders as
`stale`, never healthy. An absent external provider renders as `not monitored`, never unknown green.

`requireFreshWatchBeforeRelease` requires a configured monitor and a fresh observation, not a
healthy pre-release site. A fresh `down` result is expected before a first activation and does not
by itself block bootstrap; it becomes an acknowledgement and the post-activation verification must
turn it healthy within the monitor's convergence window. `missing`/`stale` blocks when the policy is
enabled. Recovery/rollback remains available even when Watch is down.

Project cards show public hostname, active version/commit, activation time and fresh public/TLS
state. The deployment view shows units, resources, dependencies, plan/run history and rollback.
RAM, disk, load and shared-service state belong to a target/host view because several projects share
the droplet.

The external provider behind `external-http-monitor@1` is intentionally replaceable. Selecting the
first provider requires a small adapter ADR, but no deployment milestone may claim Watch complete
until a real off-machine monitor is connected and its freshness behavior is tested.

In v1 a watch entry binds an already-created provider monitor through `monitorKey`; monitor
creation is an out-of-band setup step, not a side effect of discovery. The local connection maps
that key to one provider object and constrains the allowed hostname. Ambiguous or mismatched
bindings are `not monitored`. A future version may add external-monitor resources with the same
observe/diff/ownership rules as DNS.

## 15. Server API

Managed routes use stable project IDs. Names may be accepted only as a compatibility lookup and are
immediately resolved to an ID.

```text
GET    /api/projects/:id/deployments
GET    /api/projects/:id/deployments/:environment
GET    /api/projects/:id/deployment-artifacts
POST   /api/projects/:id/deployment-artifacts/prepare
POST   /api/projects/:id/deployment-plans
GET    /api/deployment-plans/:planId
POST   /api/deployment-plans/:planId/approval-intents
POST   /api/deployment-plans/:planId/approve
PUT    /api/projects/:id/deployments/:environment/connection-bindings/:slot
POST   /api/projects/:id/deployments/:environment/resources/:resourceId/adoption-plans
GET    /api/projects/:id/deployment-runs
GET    /api/deployment-runs/:runId
POST   /api/deployment-runs/:runId/cancel
POST   /api/deployment-runs/:runId/rollback-plans
GET    /api/deployment-runs/:runId/events
POST   /api/deployment-runs/:runId/stream-ticket
GET    /api/deployment-runs/:runId/stream?ticket=<short-lived-ticket>
GET    /api/deployment-targets
GET    /api/deployment-targets/:targetId
GET    /api/work-sessions/:id/deployments
GET    /api/connections
POST   /api/connections
PATCH  /api/connections/:connectionId
DELETE /api/connections/:connectionId
GET    /api/deployment-policies
PUT    /api/deployment-policies/:scope
POST   /api/connections/:connectionId/secrets
DELETE /api/connections/:connectionId/secrets/:slot
POST   /api/connections/:connectionId/test
```

All connection/profile/binding/policy mutations, secret writes, production approval/cancellation
and helper bootstrap operations are local-only. The approval-intent endpoint mints the short-lived,
same-session anti-CSRF nonce required by production policy; it grants no authority by itself. New
SSE endpoints use a short-lived ticket bound to run, allowed origin and current agent-token
generation, with only its hash stored. It may reconnect until expiry for EventSource/
`Last-Event-ID`, then the UI explicitly rotates it; the long-lived agent pairing token does not
appear in the stream URL.

Expected conflict/error codes include `manifest-invalid`, `connection-missing`,
`connection-out-of-scope`, `artifact-missing`, `artifact-expired`, `dependency-failed`,
`resource-conflict`, `source-ambiguous`, `version-not-increased`, `plan-blocked`, `plan-expired`,
`stale-plan`, `approval-required`, `target-contract-mismatch`, `target-locked`,
`artifact-integrity`, `executor-failed`, `recovery-required`, `verification-failed`,
`monitor-stale` and `rollback-failed`. HTTP 409 is used for stale plans, target contention and
state conflicts; validation is 400; missing local authority is 403.

## 16. Module boundaries

The managed engine should be a new server subsystem rather than more branches in `procs.ts` or
`server/index.ts`:

```text
src/server/deploy/
  manifest.ts          schema + semantic validation
  graph.ts             recipe expansion and DAG ordering
  connections.ts       metadata, scope checks and secret leases
  policy.ts            fail-closed local policy and authority checks
  observations.ts      normalized discovery and probe evidence
  planner.ts           deterministic desired/observed diff
  approvals.ts         risk policy and one-use exact-plan approval
  locks.ts             durable local leases and target keys
  runner.ts            state machine, recovery, cancellation and shutdown
  store.ts             SQLite access and migrations
  events.ts            durable redacted event stream
  releases.ts          artifact/release records and rollback selection
  adapters/            versioned built-in resource/executor/probe/monitor adapters
  api.ts               Express router
schemas/
  deployment-manifest.v1.schema.json
```

Logic, I/O and presentation remain separate: adapters perform I/O, planner/graph code is pure where
possible, and the vanilla web UI consumes only API view models.

## 17. UI behavior

The managed Deploy pane is derived from the manifest rather than hardcoded to two environments.
For one selected environment it presents:

- risk class and release policy;
- every unit with executor, target and active release;
- dependency and resource state;
- connection readiness without secret values;
- a **Discover changes** action;
- a plan grouped into reconcile, release, activation and verification;
- server-required acknowledgements and approval;
- a durable step/event timeline; and
- retained releases with a plan-first Roll back action.

Production approval controls appear only after a current unblocked plan exists. Refreshing or
reopening the page reconstructs state from the server; no safety state lives only in JavaScript.

Project cards summarize the active public release and fresh Watch state. Workrooms render
cross-project dependency failures with links to the owning project/environment. The shared-target
view owns droplet metrics and contention.

A workroom reads recorded observations only — opening a room never probes another project's
endpoints. An edge is attributed to its owner by the `projectId` the manifest itself declares:
required on `project-release@1` and `werewolf-backup-policy@1`, optional on the HTTP probes.
PSM never infers an owner from a URL, so an unattributed probe is not a cross-project edge and
is not shown as one. An edge nothing has planned yet reads *not observed*, which is a different
statement from *blocked* and is marked differently.

Legacy commands retain their existing console and stop behavior but are labelled **Unmanaged**,
with copy explaining that PSM cannot prove artifact identity, target state, rollback or health.

## 18. Security and failure rules

### Trust boundary

Trusted components are PSM's installed code, locally configured connection policy, the root-owned
host helper, the central `Werewolf-Solutions/deployment-control` workflow pinned by protected
commit/blob digest, and the operator identity required by environment policy. Repository manifests,
project code, repository-owned prepare workflows, build output, provider responses and remote
target state are validated inputs.

The paired-agent bearer token remains equivalent to broad local cockpit access. It is sufficient
for read/plan operations and staging only where policy permits; it is not sufficient for production
approval or credential enrollment in this workspace.

### Failure semantics

- A failed observation blocks; cached success is not substituted silently.
- Partial infrastructure apply stops the graph and re-observes completed actions. The next plan
  shows the new reality.
- No generic automatic undo exists for DNS, nginx or TLS changes.
- Failed artifact staging cannot alter `current`.
- Failed activation verification follows the plan's rollback policy.
- Loss of PSM during remote execution reattaches; it does not dispatch a duplicate.
- Loss of GitHub status produces an `unknown` observation and moves the run to
  `recovery-required`; locks remain held until observation classifies the target.
- A monitor outage produces stale/unknown monitor state, distinct from application down.
- Logs that cannot be written mark the run degraded; the operator is told before approval if the
  durable audit trail is unavailable.
- A redactor-pipeline error aborts the adapter rather than streaming possibly sensitive output;
  redaction is not treated as proof that every unknown encoding or derived value was recognized.

## 19. Verification strategy

The implementation is not complete without automated coverage for:

### Manifest and planning

- JSON-schema fixtures for valid and invalid manifests;
- unknown kinds, unknown fields, traversal, bad URLs and secret-shaped content rejected;
- public probe SSRF, redirect and DNS-rebinding cases rejected unless a server-owned private-target
  scope explicitly permits them;
- deterministic recipe expansion and plan digests;
- cyclic dependencies and duplicate IDs rejected;
- new releases enforce an increased repo-root version, while rollback and explicitly justified
  version decreases follow their separate policies;
- server policy can strengthen but never weaken manifest risk;
- desired/observed states produce the expected no-op/create/update/adopt/conflict actions; and
- a changed observation causes `stale-plan` before mutation.

### Credentials and security

- profile scope prevents cross-project/environment/host/root use;
- secret values never appear in DB, API JSON, events, logs or child environments;
- managed subprocesses use `shell: false`, explicit argv and minimal env;
- pinned SSH host keys, `IdentitiesOnly` and no agent fallback are enforced;
- paired origins cannot enroll secrets or approve production;
- approval is exact-digest, attributed, expiring and one-use; and
- stream tickets reconnect only for their bound run/origin before expiry, rotate explicitly and
  cannot be reused across runs, origins or agent-token generations.

### Persistence and concurrency

- concurrent plans for the same canonical target have one lock winner;
- multi-lock acquisition cannot deadlock;
- release and infrastructure-helper mutations of one target contend on the same target-side lock,
  including break-glass dispatches;
- restart marks local work interrupted and reattaches remote work;
- remote staging/activation are executor events after dispatch, never fabricated local phases;
- run event sequence is durable and SSE replay resumes from sequence/Last-Event-ID;
- shutdown commits interruption before releasing locks; and
- one run never overwrites another run's transcript.

### Static release integration

- CI checks out the exact requested SHA and records the repo-root version;
- public build inputs and their digest match the approved build profile;
- golden vectors make `psm-static-tree-sha256@1` identical across prepare and helper
  implementations, including Unicode normalization collisions, empty directories and reserved
  metadata names;
- payload and transport-archive digests survive CI download and safe target extraction;
- logical PSM and numeric GitHub artifact IDs remain distinct, and the provider locator resolves
  only inside the approved source repository/producer run to the approved logical artifact name;
- release dispatch goes only to the pinned control repository/ref/blob and exact mapped
  Environment, and its short-lived artifact-reader token cannot read an unallowed source repo;
- the trusted workflow and local/GitHub/helper target-contract identities agree;
- expected-current compare-and-swap rejects concurrent/out-of-band activation;
- activation switches atomically and preserves the previous release;
- `/`, `/auth/callback`, `/api/x` and `version.json` meet their contracts;
- nginx validation failure prevents reload;
- PM2 before/after state is unchanged;
- verification failure reactivates the previous release when approved; and
- rollback selects stored bytes and does not rebuild.

### Watch

- external healthy/down/TLS-expiry snapshots normalize correctly;
- stale snapshots never render healthy;
- PSM being stopped does not stop the external check; and
- no monitor is visibly `not monitored`.

## 20. Delivery sequence

Implementation proceeds in dependency order:

1. Versioned manifest schema, strict validation, normalized graph and legacy unmanaged adapter.
2. Local connection/policy registry, scope constraints, OS-keychain/memory secret leases and
   redaction.
3. Read-only dependency probes, resource discovery, ownership bindings, external Watch adapter
   and previewable diffs.
4. SQLite run/event/approval/lock model, exact-plan server approval and recovery scaffolding.
5. Host helper, trusted GitHub prepare/release contract and `static-ssh-nginx@1` immutable
   release/rollback.
6. Managed Deploy UI plus project/target summaries.
7. Workroom dependency presentation (built) and additional recipes (not started).

Each stage can ship only when its failure states are honest. In particular, command execution is
not called Release, a local timer is not called Watch, direct live-directory rsync is not called
immutable and a branch check is not called dependency verification.

## 21. Prerequisites and deferred decisions

Production adoption remains blocked until:

- PSM's production CloudApplication registration supports the authenticated local approval flow;
- werewolf-dapp owns a live read-only backup-readiness surface and its Mongo backup is scheduled;
- the protected `Werewolf-Solutions/deployment-control` workflow, target Environments,
  artifact-reader App, target-contract convention and helper target enrollment are installed; and
- a real external monitor is bound and returning fresh observations.

The adapter and packaging decisions this section deferred are now closed, each by an ADR in
[`adrs/`](adrs/). They constrain the implementations; changing one requires a superseding ADR
rather than an edit:

- [ADR-0001](adrs/0001-better-stack-watch.md) — Better Stack supplies `external-http-monitor@1`;
- [ADR-0002](adrs/0002-native-os-keyring.md) — `@napi-rs/keyring` backs persistent secret slots;
- [ADR-0003](adrs/0003-static-go-host-helper.md) — the host helper is a static Go service;
- [ADR-0004](adrs/0004-controller-revisions.md) — controller revisions are immutable release tags; and
- [ADR-0005](adrs/0005-release-retention.md) — 30-day artifacts and five retained target releases.

An adapter still cannot claim ready on its ADR alone: it needs an integration test against the
real service, which is what the prerequisites above are blocking.
