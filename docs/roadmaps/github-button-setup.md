# Button-only GitHub setup (P07a)

Written 2026-09-28. Roadmap phase **P07a** in the [delivery index](README.md).

Status updated 2026-09-29: **implemented locally; live GitHub acceptance pending**.
Todo's first managed release succeeded (`run_a7ef155bd9f04884`) using the
manually prepared controller and credentials. That release is the known-good
baseline for testing migration and repeatability.

Reconciliation 2026-10-05: the October 1 Handymanservices release proves an App
controller on that target. Todo migration and fresh-account setup remain distinct
open gates. See the [acceptance register](acceptance-evidence.md). P07a supplies
credentials/controllers for P12 automatic releases; a successful setup does not
alone prove release automation.

### Current implementation checkpoint

The local implementation now includes broker-backed App authentication,
repository/permission-scoped installation tokens, a browser-bound manifest
callback, Create/Install controls, controller file review and setup, and a fresh
source-only token handed to the controller before each release dispatch.
The first live Create attempt exposed GitHub's rejection of a loopback webhook
URL even with delivery disabled. The manifest now uses a public PSM HTTPS hook
URL with delivery inactive and no subscribed events; the registration callback
still returns to the loopback cockpit. The next live attempt succeeded: App
`5122783` (`psm-werewolf-solutions-b5a9e7`), installation `166171550`, is ready
and bound to Todo staging at binding revision 2. Its controller list is still
empty: controller review/apply and release migration are the next live checks.
The first controller Apply returned HTTP 422: the installation includes `todo-app`
but not the existing private `deployment-control` repository. PSM incorrectly
offered repository creation after the access check failed. The local fix now
recognises the saved controller, reports missing App access, and preserves its
existing `todo-staging-web` Environment during migration. Manage App repositories
opens the existing installation settings. Preview and Apply check branch-protection
access before changing controller files. A subsequent read-only GitHub check still
found no App access to the controller; add it to installation `166171550`, restart
PSM to load the fix, then review and apply again. No controller migration is yet
verified.
The setup action preserves the old PAT connection until the App installation is
checked and bound. Existing PAT profiles still work. A controller preview shows
every changed file and the GitHub actions; apply rechecks the binding, credentials,
manifest and controller branch before writing. It verifies the bundle before
pinning. The full PSM suite passed: **699 passed, 5 skipped, 0 failed**; TypeScript
typecheck passed. No real App, controller change or release has been created by
these tests.

The user explicitly approved this implementation after automatic review requested
more specific authorization for the App key, GitHub permissions and setup writes.
Live App creation and installation still require the account owner's GitHub clicks.
The current automatic repository creation path is for organisations; for a personal
account, create the empty controller repository on GitHub and install the App on
it before using Review controller setup. GitHub plan support for private branch
and Environment rules still needs a live check.

## Goal

A person deploying with PSM connects GitHub once and then only presses buttons in
PSM. They never create a GitHub App by hand, copy a private key, type a variable,
push to the release-controller repository or paste a commit hash.

The first Todo staging setup required those manual steps
([setup runbook](../deploy/TODO-STAGING-SETUP.md) steps 3–5, and a controller pin
that can only move by editing Advanced JSON). The 2026-09-28 run
`run_e19a8daa9f8d4e57` failed at exactly that seam: the controller environment had
no artifact-reader App credentials. That incident is resolved; eliminating the
manual setup that caused it remains this phase's work.

## What stays a click on GitHub

GitHub requires the account owner's consent for two things, and no API can skip them:

1. **Creating the App.** PSM uses GitHub's
   [App Manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest):
   PSM posts a pre-filled App definition, the owner presses **Create GitHub App**, and
   GitHub redirects back with a one-time code. PSM exchanges it
   (`POST /app-manifests/{code}/conversions`) for the App ID and private key, and
   stores the key in its credential store. Nobody sees or copies it.
   The implemented redirect targets the local agent on loopback. P03's hosted
   path needs a separately registered HTTPS callback bound to the authenticated
   workspace/operator and request state, with keys held by its secret broker.
   Reusing a loopback URL cannot provide hosted setup. Prove both supported setup
   postures; routine P12 release jobs use the resulting credentials unattended.
2. **Installing it on repositories.** The owner picks repositories and presses
   **Install**. PSM then links to the installation settings when a new source
   repository needs adding.

So the user story is **Connect GitHub → Create → Install**, then only PSM buttons.

## Design

### PSM GitHub App per connection

The `github-actions@1` connection authenticates as the App instead of a personal
access token. PSM signs a short-lived JWT with the App key and mints installation
tokens per operation, narrowed to the repositories and permissions that operation
needs (the access-token endpoint accepts `repositories` and `permissions`).
The current setup creates a new App for each connection. Reusing one App across
several projects in the same account is still a follow-up; it requires an explicit
per-project scope review before another binding is added.

Requested App permissions:

| Permission | Why |
| --- | --- |
| Actions: read & write | Dispatch prepare/release workflows, read runs, jobs and artifacts |
| Contents: read & write | Read source/controller files; write reviewed controller updates or publish authorised application source, using separate single-repository tokens. |
| Administration: read & write | Create/protect the controller repository and restrict deployment branches |
| Workflows: write | Write controller workflows and publish application source containing workflow changes; the current source-publication adapter requests this on its write token. |
| Environments: read & write | Create the controller Environment and publish its sealed secrets |
| Metadata: read | Mandatory |
| Organisation Members: read | The collaborator-read adapter requests this to inspect who can push when checking controller writer restrictions. |

Controller setup writes are narrowed to the controller repository. Application
source publication separately mints a token narrowed to the application's source
repository with `contents: write` and, in the current adapter, `workflows: write`.
Branch protections, exact-source/remote-ref checks and the operation's authority
still apply. Release artifact download uses a third token with source-repository
`actions: read` only. These are distinct credential purposes.

### The artifact reader goes away

The release job currently mints its own token from a second, long-lived App key
stored in the GitHub Environment (`PSM_ARTIFACT_READER_*`). Replace that:

1. Right before a release dispatch, PSM mints an installation token narrowed to the
   one source repository with `actions: read` only. It expires within an hour.
2. PSM writes it to the controller Environment as `PSM_SOURCE_READ_TOKEN`.
3. The workflow uses that secret directly; the "Mint a short-lived
   source-repository token" step is removed, and so is the pinned
   `actions/create-github-app-token` action.

Result: no long-lived App key in GitHub, one App instead of two, and a smaller
blast radius than today. Per-target locks already serialise releases, so two runs
never share the secret. The main App's key must **never** be put in an
Environment: anyone able to run that workflow would hold all of PSM's GitHub
permissions.

### PSM owns the controller repository's content

The reviewed controller files already live in PSM
([`docs/deploy/controller/`](../deploy/controller/README.md)). PSM ships them as a
versioned bundle and manages the repository with buttons:

- **Create release controller:** creates the private repository if missing, commits
  the bundle and `targets/<target>.json` (from the enrolled target contract) through
  the Git data API, and protects the default branch.
- **Pin:** because PSM wrote the files, pinning means reading the commit back and
  proving every file's git blob SHA equals the bundled reviewed copy. The pin keeps
  its guarantee (a rewritten workflow cannot release) without a human copying hashes.
  A commit that differs from the bundle is shown as a diff and needs explicit review.
- **Controller out of date → Update:** a newer PSM bundle (such as the 2026-09-28
  `run-name` fix) or a re-enrolled target produces a reviewed update commit and moves
  the pin in the same step. This replaces the manual push and Advanced-JSON re-pin.
- **Environment:** creates the target's GitHub Environment, restricts deployment
  branches to the controller branch, applies reviewers where the plan supports them,
  and publishes `PSM_TARGET_SSH_PRIVATE_KEY` and `PSM_TARGET_KNOWN_HOSTS` (today's
  **Publish to GitHub**, unchanged).

### Readiness names the button

Each missing prerequisite becomes a readiness check whose fix is a PSM button:
GitHub not connected, App not installed on a repository, controller missing or out
of date, Environment or credentials missing. The 2026-09-28
"Release controller artifact reader" check is the interim form and is removed with
the reader.

## Delivery steps

1. **App authentication** in `github-actions@1`: JWT signing, installation-token
   minting with narrowing, token caching until shortly before expiry. Existing PAT
   profiles keep working until migrated. Tests with a fake GitHub.
2. **Manifest flow**: Connect GitHub button, loopback redirect with state/CSRF
   check, code conversion, key into the credential store, installation discovery.
3. **Controller bundle and provisioning**: create repository, commit, verify and pin,
   update and re-pin, Environment creation. Idempotent; every write rechecks the
   observed state first.
4. **Per-release source token**: publish before dispatch; generated workflow
   omits the token-mint step. The execution wire contract remains
   `werewolf-static@1`; the pinned controller policy records
   `sourceAuthorization: installation-token` for the new credential mode.
5. **Migration of the Werewolf setup**: connect the App, re-pin
   `Werewolf-Solutions/deployment-control` to the managed bundle, delete the old
   reader variable/secret, revoke the PAT.
6. **Docs**: shrink the setup runbook to "Connect GitHub"; update
   [DEPLOYMENT-SYSTEM.md](../deploy/DEPLOYMENT-SYSTEM.md) and the controller README.

## Acceptance

On a fresh GitHub organisation and a fresh PSM profile: press Connect GitHub,
create and install the App, then deploy Todo staging using only PSM buttons.
Then change the bundled workflow and verify **Update** re-pins and the next
release uses it. Verify a hand-edited controller commit is refused until reviewed.

## Open questions

- Organisation App vs. per-user App for personal accounts (the manifest flow supports
  both; the install screen differs).
- Whether GitHub Environment protection rules are available on the user's plan for
  private repositories; PSM must say so rather than silently weakening protection.
- Hosted posture: the App key belongs in P03's workspace-bound secret broker;
  implement and accept its HTTPS callback, leases, rotation and revocation. This
  remains an implementation gate rather than an unresolved storage direction.


### Shared controller registration (implemented in PSM 0.3.34)

Projects can reuse an existing approved controller repository and GitHub App.
Target registration preserves the shared workflow/script and all other target
files, publishes only the selected target's environment credentials, and advances
compatible peer pins atomically after checking their complete unchanged bundles.
A target setup cannot upgrade shared workflow code; that needs a repository-wide
review. Tests cover peer file and credential isolation, stale peer metadata, and
refusal of common bundle replacement.

Remaining onboarding work: offer the company's existing compatible controller as
the default for new projects and combine target registration with the reviewed
machine enrollment flow. A fresh project must not require a fresh account or a
fresh controller repository. Target-specific authority and production execution
reviews continue to follow the deployment policy.
