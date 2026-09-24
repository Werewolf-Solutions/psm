# PSM hosted control service and runners

Status 2026-09-24 (P03): implemented and verified locally with real Docker.
Live hosted operation is **blocked** on two open decisions recorded in the
[delivery index](../roadmaps/README.md#open-decisions): where the runner fleet
runs, and production Werewolf registration for PSM.

## Pieces

| Process | Talks to | Holds |
| --- | --- | --- |
| `psm-control` (`npm run control`) | Werewolf (identity), browsers, runners, machines being set up | jobs, job events, sealed secrets, runner credentials (hashed), enrollment intents, audit |
| `psm-runner` (`npm run runner`) | the control service only, outbound | its own credential (`runner.json`, 0600) |
| local cockpit (`npm run dev` / agent) | loopback only | unchanged; it is not a multi-customer API |

The loopback agent API is never exposed for hosted execution. The control
service has no cookies: every request carries an explicit credential.

## Authority

- **People** send a Werewolf bearer token. `/apps/psm/me` names them and
  `/apps/psm/workspaces` lists memberships (cached 60 s). A personal
  workspace is `user:<id>`; a business is `business:<id>`. Viewers read,
  members write, admins/owners manage runners and secrets. An unreachable
  Werewolf is a 503, never "no workspaces".
- **Runners** are registered with a single-use token an admin creates for one
  workspace. They only ever lease that workspace's jobs and can decrypt only
  the secrets a job they hold declared; each hand-out is audited.
- **Machines** being set up claim a single-use, expiring enrollment intent
  bound to what the operator reviewed. A claim is a claim: PSM still verifies
  the machine independently (P01's verification step).

## Jobs

A job is a validated spec: image (from the runner's advertised list), 1–20
shell steps, optional checkout (https repository + ref, optional token
secret), declared secrets mapped to environment variables, network `none` or
`egress`, timeout, and whether it is idempotent.

Lease rules: a lease lapses 60 s after the last heartbeat. A job that never
started returns to the queue. A started job is queued again only when it
declared itself idempotent (at most 3 attempts); otherwise it becomes
**uncertain** and waits for a person, who must confirm they checked its
effects before retrying. Cancellation stops queued jobs at once and running
ones through the heartbeat.

## Container isolation (Docker backend)

Every job runs in fresh containers with: the runner's unprivileged uid, all
capabilities dropped, `no-new-privileges`, read-only root, tmpfs `/tmp`, pids
512, 2 GB memory, 2 CPUs, no Docker socket, no host paths except the job's own
work directory, `--pull never`, and no network unless the job asked for
egress. A checkout clones in a separate container with egress, using a token
passed through a private env file and turned into an HTTP header inside the
container. Secret values are redacted from output. **Never** run the runner
with `--privileged`, host namespaces or a mounted Docker socket inside jobs.

Containers are not a hostile multi-tenant boundary. For customers who do not
trust each other, run each workspace's runner on its own VM (the planned
hosted default) — the protocol is unchanged.

## Running locally

```sh
# control service with development tokens (loopback only)
PSM_CONTROL_DEV_AUTH=1 \
PSM_CONTROL_DEV_TOKENS='{"dev-token-0000000001":{"subject":"me","workspaces":{"user:me":"owner"}}}' \
npm run control                                   # http://127.0.0.1:4420

# against a Werewolf API instead
PSM_WEREWOLF_API=http://localhost:3000/api/v1 PSM_CONTROL_ORIGINS=http://127.0.0.1:4317 npm run control

# a runner (first start needs a registration token)
curl -XPOST -H 'Authorization: Bearer dev-token-0000000001' \
  http://127.0.0.1:4420/api/v1/workspaces/user:me/runner-registrations
docker pull node:22-bookworm-slim alpine/git:2.47.2
PSM_CONTROL_URL=http://127.0.0.1:4420 PSM_RUNNER_REGISTRATION=psmreg_… npm run runner
```

The master key is `<data>/master.key` (0600, created on first start) unless
`PSM_CONTROL_MASTER_KEY` is set. Back it up with the database; without it the
secrets cannot be opened.

## Verification

- `src/control/service.test.ts`, `api.test.ts`: cross-workspace denial, roles,
  single-use registration, runner confinement, declared-only secrets and
  workspace-bound sealing, lease-lapse rules, cancellation, intents, provider
  key checks, Werewolf membership changes and outage, origin allowlist.
- `PSM_RUNNER_DOCKER=1 src/runner/runner.docker.test.ts`: real containers —
  no network, CapEff 0, read-only root, no Docker socket, runner uid, secret
  redaction, failing steps, runner death (idempotent vs uncertain), orphan
  cleanup after SIGKILL, checkout of a public repository.
- Manual, 2026-09-24: control + runner as processes; runner SIGKILLed
  mid-job, control restarted, new runner stopped the orphan, the idempotent job
  ran again and finished exactly once.
