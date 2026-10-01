# Setting up managed deployment for another project

Status: static and Node-service setup are implemented. Todo has a
[successful managed static release](TODO-STAGING.md); Handymanservices staging
completed a managed Node-service deployment on 2026-10-01 (PSM run
`run_29d57729336843e6`, version 1.0.1).

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

PSM selects `node-service-ssh-nginx@1` for this shape. The first live
Handymanservices release exercised an immutable frontend-plus-server artifact,
scoped systemd process, nginx/TLS, brokered runtime secrets and public health
checks through the same reviewed plan flow as Todo. Retained-release rollback,
failed-verification recovery and a zero-downtime switch still need acceptance.

Databases, migrations, workers and backup/restore support remain separate P08
requirements; do not add them to the handymanservices recipe without evidence
that it needs them. The [delivery index](../roadmaps/README.md) keeps the phase
order and the remaining P07/P07a gates.

The recipe and remaining acceptance are in
[NODE-SERVICE-RECIPE.md](NODE-SERVICE-RECIPE.md).

## Evidence and implementation

The 2026-10-01 PSM verification passed typecheck and the full suite:
**740 passed, 5 skipped, 0 failed**. The live Handymanservices build and release
also completed through GitHub Actions and the enrolled target.

Implementation: `src/server/deploy/setup.ts`, its `templates/` prepare script,
the `deployment-setup` routes in `src/server/deploy/api.ts`, and the setup view
in `web/app.js`. Changes remain in the working tree alongside earlier work.
