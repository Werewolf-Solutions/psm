# Todo staging deployment

For the dry-run-first operator helper, exact root-permission repair, staging-only
controller scaffold and GitHub setup commands, see [TODO-STAGING-SETUP.md](TODO-STAGING-SETUP.md).
That runbook does not deploy or imply that the remaining auth/transfer defects are fixed.

The current target is **https://todo.werewolf.solutions**, using
**https://staging.werewolf.solutions** for the API and sign-in.
The exact callback is https://todo.werewolf.solutions/auth/callback.

The generated hostname a6s1j3p3zh.werewolf.solutions is superseded by the user's
2026-09-21 request. Production is not an active Todo environment while staging
owns the requested hostname.

See [Todo's deployment runbook](../../../todo-app/docs/DEPLOY.md) for current
evidence, the precise remaining enrollment/controller work, and acceptance.
See [the ecosystem assessment](../roadmaps/ecosystem-integration.md) for the
integration sequence and business-isolation findings.

## What was established on 2026-09-21

- Staging's health endpoint returns 200, Todo's guarded board returns 401, and
  public Todo metadata allows the exact new callback. The old September 7
  missing-backend and missing-registration blockers are no longer current.
- PSM has bound DNS, GitHub and host connections. Its invalid saved SSH key was
  repaired using the already-existing local Todo staging key. A read-only
  host-helper probe succeeds and reports no active release.
- The enrolled host contract and PSM host scope still name the old directory.
  PSM refuses the new root until an administrator re-enrolls that specific
  target and the connection is updated with its new fingerprint.
- The release controller is unpinned and its expected repository cannot be
  resolved through the authenticated GitHub account.
- The Todo hostname still has no DNS record, and no release has been executed.

The Werewolf attached capability remains read-only. Infrastructure
checks and the credential repair used the local PSM deployment API and SSH
host helper, not that capability.

## Rechecked on 2026-09-21, later the same day

Everything below was observed directly from this workspace, not carried over
from an earlier session's notes.

| Check | How | Result |
| --- | --- | --- |
| `todo.werewolf.solutions` DNS | `getent hosts` | **No record.** Still the binding blocker. |
| `staging.werewolf.solutions` | HTTPS GET `/` | 200 |
| `psm.werewolf.solutions` | HTTPS GET `/` | resolves, 403 (the hosted cockpit's gate) |
| Staging dapp version | version string in the served main bundle | **0.5.1** — the release that contains the workspace API |
| Manifest dependency `werewolf-api` | GET staging `/api/v1/health` | 200, as declared |
| Manifest dependency `todo-api` | GET staging `/api/v1/apps/todo/board` | 401, as declared |
| Manifest dependency `todo-sign-in` | GET staging todo `/public?redirectUri=…` | 200, `redirectAllowed: true` for the exact new callback |
| `.psm/deployments.json` | parsed with PSM's own `deploymentManifestIssues` | **valid**, no issues |
| Artifact pipeline | ran `.psm/scripts/prepare-static-artifact.mjs` end to end locally | builds, packages deterministically, emits `version.json` carrying version 0.6.0 and the commit |
| `Werewolf-Solutions/deployment-control` | `gh repo view` | **does not exist** |
| Local release state | no `.psm-deploy*` state file names the target | **no release has ever been executed** |

So the repo-owned half is finished and verified: a valid manifest, a working
prepare workflow, an artifact that carries the metadata the manifest's
`release-metadata@1` check demands, and a staging API that already serves the
workspace release this frontend needs.

## Rechecked again on 2026-09-21, after the transfer-correctness round

Read-only inspection of the running local agent (`GET /api/connections`,
`/api/deployment-targets`, `/api/projects/prj_e471…/deployments/staging`) **corrects two
claims above.** Both were written from a failed lookup rather than from an authoritative
source, and both were wrong.

- **The host target IS enrolled.** `werewolf:todo-staging-web` exists, with
  `fingerprint: sha256:cc2889cf…`, `revision: todo-staging-v1`, root
  `/var/www/todo.werewolf.solutions`, on `46.101.29.222` as `psm-infra`. All three
  connections are bound and report no missing secret slots. What is stale is the host
  connection's `allowedTargetRootPrefixes`, still
  `["/var/www/a6s1j3p3zh.werewolf.solutions"]` — the superseded generated hostname. That
  single mismatch is why `directory`, `ingress` and `certificate` all read "differs from the
  target contract".
- **The GitHub account can create the control repository.** It is an org **admin**
  (`role: admin, state: active` in `Werewolf-Solutions`) and holds `repo`; `admin:org` is not
  what repository creation needs. The repository genuinely does not exist — confirmed by
  listing all 26 org repositories including private ones, not by a lookup that failed — but
  "could not create it" was not the reason.

PSM's own verdict is now exactly two blockers, with `canPrepare: false`:

| Blocker | PSM's message |
| --- | --- |
| `connection:host` / `connection-missing` | target root is not within an allowed component-aware prefix |
| `release-controller:web` / `release-controller-unpinned` | the github connection has no reviewed release workflow for `werewolf:todo-staging-web`; PSM pins it once it can read the release repository |

**The action pin is no longer one of them.** `docs/deploy/controller/release-static.yml` now
pins `actions/create-github-app-token` to a resolved, reviewed, signature-verified commit
SHA — see that directory's README, "The action pin". The four remaining `REPLACE_…` values
in `targets/*.json` are all enrollment-derived and are deliberately still blank.

So the smallest remaining operator actions are:

1. Widen the host connection's allowed root prefix to `/var/www/todo.werewolf.solutions`
   (connection `con_67802210-4432-4790-847b-4edaedd9cea5`). It widens what a live-droplet SSH
   credential may reach, so it is an explicit decision rather than a tidy-up.
2. Create `Werewolf-Solutions/deployment-control` from `docs/deploy/controller/`, register and
   install the GitHub App named in its README, and add a GitHub Environment `todo-staging-web`
   holding `PSM_TARGET_SSH_PRIVATE_KEY` and `PSM_TARGET_KNOWN_HOSTS`. App registration is a
   web-UI action and cannot be done from a checkout.

DNS still reports `state: create`, which is right: the manifest's `digitalocean-dns-record@1`
creates the A record **as part of a release**. Creating it by hand first would point the name
at a host that is not serving.

Two other things worth carrying forward, both verified on 2026-09-21:

- The artifact pipeline was run end to end twice and produced a **byte-identical**
  `archiveDigest` (`sha256:bd5d4be7…`), with `version.json` carrying the version and commit.
- PSM reads the **committed** tree: `source.version` is `0.5.2` with `inputsDirty: true`,
  because todo-app's 0.6.0 bump and its workspace client are uncommitted. A release today
  would ship 0.5.2, not the workspace work.

Full detail, including the browser verification and the two PSM sign-in defects found while
doing it, is in [../roadmaps/workspace-implementation-status.md](../roadmaps/workspace-implementation-status.md).
