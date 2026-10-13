# `node-service-ssh-nginx@1` — design for review

Status: **first managed Handymanservices staging release verified on werewolf-alpha** · 2026-10-01 · rollback and zero-downtime switching remain open

This is the P08 recipe for an app that needs a running Node server: build it once on
GitHub Actions, release the exact bytes to a host, run it as a supervised service behind
nginx, verify it, and roll back to retained bytes when verification fails. It reuses
everything [`static-ssh-nginx@1`](DEPLOYMENT-SYSTEM.md#12-static-ssh-nginx1) proved (manifest,
plans, approvals, locks, GitHub prepare/release, host helper, DNS, TLS, To do list) and adds
only what a process needs.

P08a.1 is the recorded first target release; P08a.2 owns complete managed rollback
acceptance and P08a.3 owns uninterrupted switching. Workers, data and observation
are separate milestones in the [P08 scope](../roadmaps/application-operations.md).

## What to do next

The live target now has version 1.0.1 active. PSM run `run_29d57729336843e6`
finished `succeeded` after checking the exact target release and public `/`,
`/healthz` and `/version.json` responses. The setup steps below are retained as
the sequence used for this first deployment; the next acceptance is a newer
release followed by retained-release rollback, then a health-checked switch
without a restart gap.

1. ~~Prove the helper on a throwaway machine.~~ **Done 2026-10-01 on homelab** (Ubuntu 24.04,
   systemd 255): enrollment, unit and secrets, two healthy releases, automatic rollback of a broken
   one, manual rollback, secret rotation, crash restart, sandbox and loopback checks, nginx proxy
   (HTTP stage). It found and fixed four host defects: the helper's sandbox lacked the service
   paths; `install.sh` missed directories on a fresh host; `User=root` with `NoNewPrivileges=yes`
   cost the helper `CAP_SETUID` on systemd 255; a host without PM2 failed the PM2 invariant.
   Report: `/srv/homelab/reports/2026-10-01/psm-node-service-test.md`. Everything was removed after.
2. ~~Install the new helper on `werewolf-alpha` through Machines.~~ Done for the
   Handymanservices staging target; the Todo target remains enrolled.
3. ~~Review controller setup / update on the Deploy page.~~ The Handymanservices
   GitHub App controller is pinned and completed the first release.
4. ~~Set up Handymanservices, enroll the target and enter runtime secrets.~~
   Done for `handymanservices-staging.werewolf.solutions`; `API_KEY` and
   `BUSINESS_ID` are in PSM's broker and match the host.

## Built (2026-10-01)

| Part | Where | Tested by |
|---|---|---|
| Host helper: `service` contract block, systemd unit and env files, secrets with keyed fingerprints, health gate (HTTP 200 + unit active + loopback-only listener), deploy/activate/rollback of service releases, nginx proxy template | `host-helper/service.go`, `releases.go`, `nginx.go` | `service_test.go` (healthy release, rollback of an unhealthy one, first release stopped, contract cannot be widened, foreign unit never replaced, secrets never in responses), race detector |
| Manifest kinds, validation, JSON Schema, graph expansion | `types.ts`, `manifest.ts`, `graph.ts`, `schemas/` | `node-service-recipe.test.ts` |
| Executor contract and controller accept `psm-service-tree-sha256@1`; the helper operation follows the artifact | `executor-contract.ts`, `controller/scripts/psm_controller.py` | controller `unittest`, contract tests |
| Runtime secrets in PSM's store, compared by verdict only; generation per service | `runtime-adapters.ts`, `secrets.ts`, `store.ts` | `node-service-recipe.test.ts` |
| Build template and generated workflow; bundle digest pinned against the helper's golden vector | `templates/prepare-node-service.mjs`, `setup.ts` | `setup.test.ts`, golden vector in Go and TS |
| Setup detection for client + Express, config/secret split from `.env.example` (never `.env`) | `setup.ts` | `setup.test.ts` |
| Enrollment: no-login service account outside `psm-deploy`, port picked on the server | `machines/roles.ts` | `roles.test.ts` (script syntax, port picker in bash) |
| Deploy page: Runtime secrets section and To do items; setup page lists required project changes | `web/app.js` | manual |

**Differences from the draft below.** The release goes through the existing pinned controller
(`werewolf-static@1`), which picks the helper operation from the artifact's payload algorithm, so
the GitHub App setup and pin you already have keep working; there is no separate `release-node.yml`.
Node is the exact binary `actions/setup-node` installs, recorded in `version.json`; the bundle
carries `bin/node` only, about 110 MB per release (about 550 MB for five retained). Native modules
are refused in v1. Readiness does not yet show the service's live state (active, restarts,
memory); the helper's `observe-service` provides it for a follow-up.

## Decisions

| # | Decision | Status | Choice |
|---|---|---|---|
| 1 | What supervises the process | **Decided 2026-10-01** | One systemd unit per service, rendered by the host helper from a fixed template, running as its own Unix user. Not the shared PM2 daemon: there every app runs as one user and can read the others' env and files, and env caching leaks between apps (the [exported `PORT`](#configuration-and-secrets) problem). The recipe still proves PM2 is left unchanged. |
| 2 | How the app is packaged and isolated | **Decided 2026-10-01** | A release tarball with the Node runtime bundled, run by systemd with its sandboxing, now; a container image (`oci-image@1`, run by Podman under systemd) once the host meets the prerequisites below. See [Containers or not](#containers-or-not). |
| 3 | Where runtime secrets live | **Decided 2026-10-01** | PSM's local secret store, written to the host by the infrastructure helper into a root-only file systemd reads. Secrets change without a rebuild, never pass through CI, and the release key never sees them. |
| 4 | Downtime on activation | **Decided 2026-10-01** | v1 accepts a restart gap of a few seconds. Zero-downtime releases are a required follow-up on the [delivery index](../roadmaps/README.md) (P08), not optional. |

## Host prerequisites

Read from `werewolf-alpha` on 2026-10-01 (read-only). The host stays in use for v1; memory is
freed rather than bought.

| Fact | Value | Consequence |
|---|---|---|
| Memory | 965 MB total, **51 MB available, 411 MB of swap in use** | Must be freed before the first service release: see below. |
| Biggest consumer | `AI-social-media-autopilot` at 487 MB 46 minutes after a restart, dying with "JavaScript heap out of memory" (83 PM2 restarts) | A leak, not a size: it grows until it crashes and takes the host into swap with it. |
| Other apps | handymanservices, print-shop, werewolf-dapp, werewolf-dapp-staging: 3–32 MB resident each, plus swap; each started through `npm start` | The npm wrapper is a second process per app (≈10 MB plus ≈23 MB of swap each). |
| handymanservices | **Already running** under PM2 on port 3001 behind `handymanservices.werewolf.solutions` | The managed service replaces this process rather than adding one. |
| Node | Apps use Node v22.21 from nvm; the system `node` is v14 | Bundling Node in the release removes both dependencies. |
| CPU, disk | 1 vCPU; 14 GB free of 25 GB | Enough for v1, including five retained releases with bundled Node. |
| OS | Ubuntu 20.04.6, kernel 5.4; standard support ended May 2025 | Tracked as maintenance on the [delivery index](../roadmaps/README.md); containers wait for 24.04. |
| Exposure | App ports 3001, 5000, 5001, 5100, 5555 listen on all interfaces but do not answer from the internet | A firewall in front holds; the managed service listens on loopback regardless. |

### Freeing memory (each step needs operator approval; none touches data)

| Step | Expected gain | Risk |
|---|---|---|
| Cap AI-social-media-autopilot: `--max-old-space-size=192` and PM2 `max_memory_restart: 220M`, then find its leak in that repository | ≈250–300 MB | It restarts earlier instead of swapping the host; the leak itself needs a fix in that project. |
| Start each PM2 app with `node bin/www` instead of `npm start` | ≈50 MB resident, ≈110 MB swap | One restart per app (seconds). |
| Disable host services a droplet does not use (`ModemManager`, `udisks2`, `multipathd`; `snapd` only if no snap such as certbot depends on it) | ≈30–40 MB | Checked one by one; each is re-enabled with one command. |
| Replace PM2 handymanservices with the managed service | ≈0 (a swap, not an addition) | Done by the first release, with the old process stopped only after the new one passes. |

### Done on 2026-10-01

With approval, the AI app was capped (heap 192 MB, PM2 restart at 220 MB) and it, werewolf-dapp
and werewolf-dapp-staging now start as `node bin/www`; each answered exactly as before, and the
PM2 list was saved. Available memory afterwards: **323 MB**, swap in use 194 MB (from 51 MB and
411 MB). handymanservices was left alone because its `.env` changed after it started; the managed
release replaces it. Unused host services were not disabled.

**print-shop is intentionally stopped for capacity.** User clarification on
2026-10-05 confirms this is an accepted choice to free droplet capacity, with no
current recovery task. The October 1 inspection recorded a non-Git folder with
newer code (MongoDB, Stripe, login), missing dependencies/configuration, and a
restart that exposed eleven missing packages. Preserve those observations as
historical restart prerequisites if the owner later chooses to restore it.
Lesson for the recipe and for M1:
an unmanaged app can only be restarted safely after checking that the code on disk can start;
managed releases avoid the problem because the running bytes are always the retained release.

## Containers or not

Researched 2026-10-01 for this setup: a few small apps on one small VPS, released from GitHub
Actions, with exact-bytes releases and rollback.

| Option | Fits this host? | What it would add | Verdict |
|---|---|---|---|
| **Kubernetes (k3s)** | No. A k3s server needs 2 cores and 2 GB RAM before any workload ([k3s requirements](https://docs.k3s.io/installation/requirements)). | Scheduling across many nodes, which one server does not need. | Not for this scale. Revisit only with several servers. |
| **Docker + Compose, Kamal, Dokku or Coolify** | No. Docker Engine installs only on Ubuntu 22.04, 24.04 and 26.04 ([Docker docs](https://docs.docker.com/engine/install/ubuntu/)); Dokku needs 22.04+ and 1 GB ([Dokku](https://dokku.com/docs/getting-started/installation/)); Coolify needs 2 cores and 2 GB ([Coolify](https://coolify.io/docs/get-started/installation)). The Docker daemon also costs memory the host does not have. | A standard image format, OS libraries pinned in the image, and (Kamal) a health-checked proxy switch for zero-downtime deploys ([kamal-proxy](https://kamal-deploy.org/docs/configuration/proxy/)). | The common choice for small VPS hosting, but it brings a second control plane next to PSM's, and needs a newer OS and more memory. |
| **Podman + Quadlet** | Not yet. Needs Podman 4.4+ and cgroups v2: Ubuntu 22.04+ ([Red Hat](https://www.redhat.com/en/blog/quadlet-podman)). | The same image format as Docker, but no daemon: each container is a systemd unit, so it keeps decision 1 and PSM stays the only control plane. | **The container path for this recipe** once the host runs 24.04. |
| **systemd + release tarball with bundled Node** | Yes, today. | Exact bytes including the runtime, atomic switch and rollback, a per-service user, memory limit and sandbox (`ProtectSystem`, `ProtectHome`, `PrivateTmp`, `NoNewPrivileges`). | **v1.** It covers what containers would give this app, which has no native modules or OS libraries to pin. |

What containers would still add later: OS libraries pinned with the app (matters for native
modules), stronger filesystem isolation, and an artifact that runs unchanged on managed
platforms, which matters for PSM's hosted future. The spec already treats container images as
another artifact kind; adding `oci-image@1` changes the artifact and the activation step, not
the environment, plan, approval or To do flow.

## What it deploys

handymanservices is the shape this recipe targets: a Vite client in `client/` built into
`server/public/`, and an Express server in `server/` that serves those files and proxies three
routes (`/api/business`, `/api/bookings/book`, `/api/messages/message`) to the Werewolf API
with a server-held `API_KEY` and `BUSINESS_ID`. It has no database of its own.

One unit, `web`, is one artifact: the built client inside the server, the server's
production dependencies, and the Node runtime.

## Manifest

The recipe adds three typed kinds; everything else is the existing schema.

```jsonc
{
  "id": "web",
  "recipe": "node-service-ssh-nginx@1",
  "resourceRefs": ["resource:dns", "resource:directory", "resource:service", "resource:ingress", "resource:certificate"],
  "artifact": {
    "kind": "node-service@1",
    "runtime": "node@22",                       // major only; CI resolves and records the exact build
    "build": "npm run build",                   // root script; must leave the client in server/public
    "serviceRoot": "server",                    // the directory that becomes the release
    "entry": "bin/www",                         // relative to serviceRoot; run as `node <entry>`
    "buildProfile": { "id": "staging", "publicInputs": { "VITE_API_BASE": "/api" } }
  },
  "executor": { "kind": "github-actions@1", "connection": "github", "sourceRepository": "Werewolf-Solutions/handymanservices",
                "prepareWorkflow": "build-node-service.yml", "releaseController": "werewolf-node@1" },
  "target": { "kind": "ssh-service-release@1", "targetId": "werewolf:handyman-staging-web", "observerConnection": "host",
              "root": "/srv/handyman-staging.werewolf.solutions" },
  "runtimeConfig": {                            // non-secret, shown in plans
    "NODE_ENV": "production",
    "WEREWOLF_API_URL": "https://staging.werewolf.solutions/api/v1",
    "FRONTEND_URL": "https://handyman-staging.werewolf.solutions"
  },
  "runtimeSecrets": ["API_KEY", "BUSINESS_ID"], // names only; values never leave PSM's store and the host
  "health": { "path": "/healthz", "expect": { "status": 200 }, "startupTimeoutMs": 20000 },
  "verification": [ /* http-status@1 on /, /healthz; release-metadata@1 on /version.json */ ]
}
```

Resources: `dns` and `certificate` are unchanged; `directory` is `host-release-directory@1` at
the new root; `service` is the new `systemd-node-service@1`; `ingress` is the new
`nginx-node-proxy@1`.

Validation rules: `runtimeConfig`/`runtimeSecrets` names are `[A-Z_][A-Z0-9_]*`, disjoint from
each other and from names the recipe owns (`PORT`, `HOST`, `NODE_OPTIONS`, `PATH`, anything
`PSM_*`); `entry` and `serviceRoot` are relative, canonical and inside the repository;
`runtime` is from an allowlist of supported majors.

## Artifact: `node-service@1`

Built by a generated `build-node-service.yml` in the project repository (the same
pattern as `prepare-static-artifact.mjs`), on a fresh GitHub runner:

1. Check out the exact commit; resolve `node@22` to an exact version and download the official
   linux-x64 tarball, verifying it against Node's signed `SHASUMS256.txt`.
2. `npm ci` at the root and run `build` with the public build inputs.
3. In `serviceRoot`, `npm ci --omit=dev --install-links --no-bin-links`, so production
   dependencies are real files: the payload digest refuses symlinks, and `node_modules/.bin`
   is not needed at run time.
4. Refuse the artifact if it contains any `.env*` file, private-key material or a
   `node_modules` native addon built for another platform.
5. Write `version.json` (commit, version, PSM artifact ID, Node version) into the served public
   directory, then package `app/` (the service root) and `runtime/` (Node) and compute the
   payload digest with a new `psm-service-tree-sha256@1`: the static tree algorithm plus
   recorded executable bits, with no symlinks.

Release receipts record the exact Node version alongside the existing commit, version and
both digests.

## Target and server layout

```text
/srv/handyman-staging.werewolf.solutions/
  current -> releases/rel_<id>/
  releases/rel_<id>/
    app/        server code, server/public with the built client, node_modules
    runtime/    the bundled Node
    release.json
  incoming/
  state/        the only directory the service may write (owned by the service user)
```

Enrollment (root, once per target, through the existing machine onboarding flow) extends the
helper's target contract with a `service` block. The repository cannot choose any of these:

```json
"service": {
  "unitName": "psm-svc-handyman-staging-web",
  "user": "psm-s-handyman-staging", "uid": 1105, "gid": 1105,
  "listen": { "host": "127.0.0.1", "port": 41001 },
  "memoryMaxMb": 256,
  "secretsFile": "/etc/psm-deploy/secrets/werewolf__handyman-staging-web.env"
}
```

Ports come from a root-owned range (`41000–41999`), one per target. The service user owns
nothing but `state/`; release directories stay owned by the deploy account, read-only to the
service.

## Process: `systemd-node-service@1`

The infrastructure helper renders the unit from a built-in template, runs
`systemd-analyze verify`, then `daemon-reload`. No manifest text reaches the file except
validated names and values.

```ini
[Unit]
StartLimitBurst=5

[Service]
User=psm-s-handyman-staging
WorkingDirectory=/srv/handyman-staging.werewolf.solutions/current/app
ExecStart=/srv/handyman-staging.werewolf.solutions/current/runtime/bin/node bin/www
Environment=HOST=127.0.0.1 PORT=41001
EnvironmentFile=/etc/psm-deploy/targets/werewolf__handyman-staging-web.config.env
EnvironmentFile=/etc/psm-deploy/secrets/werewolf__handyman-staging-web.env
Restart=on-failure
RestartSec=2
MemoryMax=256M
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ReadWritePaths=/srv/handyman-staging.werewolf.solutions/state
```

The unit is enabled at boot. Logs go to journald under the unit name.

## Configuration and secrets

- **The process gets exactly what the unit gives it.** No shell environment is inherited, so
  an exported `PORT` or a stray `.env` cannot leak in. `HOST` and `PORT` come from the
  contract; `runtimeConfig` from the manifest; `runtimeSecrets` from the secrets file.
- **Secrets file.** Root-owned, mode `0600`. systemd reads it before dropping privileges; the
  service user cannot read the file, and other apps cannot read the process environment.
- **Setting values.** The Deploy page gets a *Runtime secrets* section listing the declared
  names. Values are entered locally (loopback only, like credentials) into PSM's secret
  store. Plans show each name with an HMAC fingerprint of its value, never the value.
- **Applying values.** A new helper operation, `reconcile-service-secrets`, receives the values
  inside one typed request over the existing infrastructure channel and replaces the file
  atomically. A changed fingerprint is a plan diff with "restarts the service".
- **App compatibility.** The app reads `process.env` as before. Code that loads `dotenv` still
  works, but the artifact never contains a `.env` to load.

## Ingress: `nginx-node-proxy@1`

Same staged HTTP-then-TLS state machine as `nginx-static-site@1` (the ACME challenge is served
by nginx itself), with the final vhost proxying to `127.0.0.1:<port>`: `X-Forwarded-For/Proto/Host`,
bounded body size and timeouts, and the named security-header profile. Hashed assets under
`/assets/` may be served with long cache headers from the proxied response; nginx does not read
the release directory.

## Release, activation, health gate and rollback

The `werewolf-node@1` controller workflow in `deployment-control` follows the static protocol
step for step (section 11.2), changing only activation:

1. lock, attest the target contract and expected current release;
2. stage into `incoming/`, extract, recompute `psm-service-tree-sha256@1`, move to
   `releases/rel_<id>/`;
3. **activate**: switch `current`, then ask the helper to restart the unit;
4. **health gate**: the helper polls `http://127.0.0.1:<port><health.path>` until it answers the
   expected status or `startupTimeoutMs` passes, and checks the unit is `active` and its
   listening socket is loopback-only;
5. public probes (`/`, `/healthz`, `/version.json` naming the exact release);
6. on any failure, with rollback pre-authorized: switch `current` back, restart, re-run the
   health gate on the previous release, end `rolled-back`;
7. receipt, retention (current, previous and the configured recent releases), unlock, result.

Restart, health and rollback are helper operations (`activate-service-release`,
`rollback-service-release`); the release key can stage but cannot restart anything.

Manual rollback is the existing flow: a plan naming a retained release.

## Verification and invariants

Recorded with every run:

- the unit is `active`, its restart count did not climb during verification, and its memory is
  under `MemoryMax`;
- the service listens on `127.0.0.1:<port>` only;
- **the PM2 snapshot is unchanged** before and after, which proves werewolf-dapp's processes
  were not touched;
- the public probes and exact `version.json`.

## Changes by component

| Component | Change |
|---|---|
| Manifest and planner | The recipe, three kinds, `runtimeConfig`/`runtimeSecrets`/`health`, and the graph: dns → directory → service → ingress(http) → certificate → ingress(tls) → release. |
| Host helper (Go) | Contract `service` block; operations `reconcile-systemd-service`, `reconcile-service-secrets`, `activate-service-release`, `rollback-service-release`, `observe-service`; `psm-service-tree-sha256@1`; unit and proxy templates. New protocol version. |
| Machine onboarding | Creates the service user, allocates the port, writes the contract `service` block and an empty secrets file. |
| deployment-control | `release-node.yml` and `werewolf-node@1` controller; set up through the existing GitHub App controller setup and pinned like `werewolf-static@1`. |
| Project setup | Generates `build-node-service.yml` and the manifest for a detected client + Express server, instead of "Plan deployment support with AI". |
| Deploy page | Runtime secrets section; service state (active, restarts, memory) in readiness; To do items for missing secrets and an unhealthy service. |

## Changes needed in handymanservices

Small, and made as normal reviewed commits:

- `server/bin/www`: listen on `process.env.HOST` as well as `PORT`.
- Add `GET /healthz` returning 200 when the server is up (no call to the Werewolf API, so a
  Werewolf outage is reported by the dependency check, not as an unhealthy release).
- Remove `ecosystem.config.js` from the managed path (keep it only for local use) and move
  `FRONTEND_URL` and the API URL to runtime config.
- Upgrade `express` from `~4.16` and drop `jade` if only the generated error page uses it.

## Out of scope for this recipe

Databases, migrations and workers use P08b/P08c; operational observation and
external Watch use P08d. This app has no database or worker of its own. The
current recipe does not implement uninterrupted switching; P08a.3 adds it as a
required follow-up. Regional/horizontal rollout belongs to P13. External Watch
is a release-policy gate when required, even if it is provided outside this recipe.

## Acceptance on staging

1. Enrollment and setup from the Deploy page alone, following its To do list.
2. A first release reaches `active`, all probes pass, PM2 is unchanged.
3. A second release with a new version replaces it.
4. A deliberately failing release (health returns 500) rolls back automatically to the previous
   release, which then passes its probes.
5. A manual rollback to a retained release.
6. Rotating `API_KEY` produces a plan that restarts the service and nothing else.
7. Rebooting the host brings the service back on its own.

## Delivery order

1. Free host memory (table above) and confirm at least ~250 MB available.
2. Helper: contract block, service operations and templates, with Go tests and a
   throwaway-VM run (no privileged containers on the desktop).
3. Manifest kinds, planner graph and runtime adapters, with tests.
4. Build template and `werewolf-node@1` controller workflow.
5. Deploy page: runtime secrets, service readiness, To do items.
6. handymanservices changes, then staging acceptance.
