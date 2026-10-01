# Setting up managed deployment for another project

Status: implemented in the PSM working tree, reviewed and tested on 2026-09-29.
Todo has a [successful managed static release](TODO-STAGING.md); the generated
setup flow has not yet completed a second project's live acceptance.

## Start in Deploy

Open a project from a cockpit folder and choose **Deploy**. A project with a
deployment manifest opens the existing managed view. Without one, it opens
**Set up managed deployment**, with detected repository, branch, version, app
output and server information. A project without a stable identity first offers
**Give this project a PSM id**, which writes `.psm/identity.json`.

The setup detector currently looks for a Vite build in the repository root or
`client/`, `web/`, `frontend/`, `app/` or `site/`. It also checks the root and
`server/`, `api/` and `backend/` for known server frameworks. This is a limited
detector, not proof that an arbitrary repository has no runtime dependencies.

## Supported static projects

The generator needs a GitHub `origin`, a root package version in `X.Y.Z` form,
a detected Vite app with a build script, and no detected server. Its workflow
uses npm and expects a package lock in the app directory; the generated build
output assumes Vite's `dist` default. Review custom build paths, workspaces,
public configuration and external API dependencies before publishing.

1. Enter the hostname and its DNS zone, then choose staging or production.
   The default suggestion is `<project>.werewolf.solutions`; it is not evidence
   that the name is available or that the project owns it.
2. Press **Create deployment setup**. PSM validates and writes:
   - `.psm/scripts/prepare-static-artifact.mjs`;
   - `.github/workflows/build-static.yml`;
   - `.psm/deployments.json`.
3. Review the generated files. Existing files at those paths block setup; they
   are never silently overwritten or assumed compatible. The manifest is written
   last, and newly written files are removed if the write fails.
4. Continue in the managed view: connect scoped GitHub, DigitalOcean DNS and host
   profiles, enroll the target and resolve readiness items. The generator creates
   local repository files only; it does not provision connections or grant access.
5. Review and publish the source, prepare the artifact, check readiness, then
   review the exact plan and use **Confirm & deploy**.

The generated recipe is `static-ssh-nginx@1`: GitHub Actions builds static files,
and the host helper manages the release directory, nginx and TLS. API paths are
sealed; public build inputs and external API dependencies must be declared for
the actual application. Setup does not commit, push or deploy anything.

## Handymanservices and other server applications

The inspected handymanservices checkout has a Vite client in `client/`, an
Express server in `server/`, and a production build that copies the client into
the server's public directory. Its PM2 commands run that server. Publishing
`client/dist` alone is not an equivalent deployment.

PSM therefore blocks static setup and offers **Plan deployment support with AI**.
This opens a draft prompt for review and sending; it does not create a managed
server recipe, a deployable plan, or a release. Existing command deployment remains
available only when configured and is explicitly unmanaged.

P08's first concrete server case should be handymanservices. Before a managed
release is possible, implement and test:

- an immutable frontend-plus-server artifact and runtime configuration contract;
- a scoped Node process lifecycle and reverse-proxy configuration that preserve
  other workloads on the host;
- application/API health checks, retained releases and rollback, including a
  failed verification after activation;
- planning, readiness and recovery support for those typed operations;
- staging acceptance through the same review-and-confirm flow as Todo.

Databases, migrations, workers and backup/restore support remain separate P08
requirements; do not add them to the handymanservices recipe without evidence
that it needs them. The [delivery index](../roadmaps/README.md) keeps the phase
order and the remaining P07/P07a gates.

## Evidence and implementation

The 2026-09-29 verification passed typecheck, JavaScript syntax checks and the
full PSM suite: **680 passed, 5 skipped, 0 failed**. Setup tests cover a valid
static manifest, conflicting build files, server rejection and DNS-zone validation.
They do not prove a generated workflow has run successfully on GitHub.

Implementation: `src/server/deploy/setup.ts`, its `templates/` prepare script,
the `deployment-setup` routes in `src/server/deploy/api.ts`, and the setup view
in `web/app.js`. Changes remain in the working tree alongside earlier work.
