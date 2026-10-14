# Managed website verification

PSM's managed agent cannot commit code in a package with a build script until that
build succeeds. Frontend packages (React, Vue, Angular, Svelte, Next, Nuxt or Vite)
also require a browser check. Documentation-only commits retain their existing
behavior. Verification covers the current source snapshot and staged files must
match the checked source. Editing any snapshot input makes earlier results stale.
Automatic release version assignment still happens after the verification gate.

Use `verification_status` to discover required packages and their current check
results. Run `install_packages` for each package needed by the checks, with
`directory` set to its repository-relative directory (default `.`). For example,
a root package invoking separate client/server scripts needs root, `client` and
`server` installations. Run `run_script` with `script: build` for each required
package, then `preview_check` with the frontend directory, `dev` script, port and
routes affected by the change. Vite receives explicit host, port and strict-port
arguments. The preview and all dependency installs remain offline, disposable,
non-root containers with no host credentials or published ports. The workspace
tmpfs permits execution for npm command shims and native build tools while
retaining nosuid/nodev; the host checkout remains read-only.

A dev server listening or returning HTML is insufficient. Chromium executes the
page scripts and rejects page errors, console errors, failed same-origin requests,
Vite overlays and empty app content. Each route gets a fresh browser context.
External requests are blocked; apps needing remote data must provide a local
fixture (see below) or their check remains unverified. Preview/start scripts with a build
script build inside the same disposable container before starting the server.

## Preview fixtures

A frontend whose API lives in another service has nothing to call in the offline
sandbox. Todo's dev server proxies `/api` to a backend that is absent there, so
its session refresh answered HTTP 500 and every route failed the check. Such a
package can commit `psm-preview.json` beside its `package.json`:

```json
{
  "schema": "psm.werewolf.solutions/preview-fixtures/v1",
  "responses": [
    { "method": "POST", "path": "/api/v1/apps/todo/auth/refresh", "status": 401, "json": { "error": "no session" } }
  ]
}
```

Each entry answers one exact method (default `GET`) and pathname on the preview
origin with a `status` (200-299 or 400-599) and a `json` or `text` body. At most
40 entries and 64 KiB of bodies. Only `fetch` and XHR requests are answered: the
page, its scripts and its assets always come from the real dev server, and
requests to other origins stay blocked. A fixture's own status is not counted as
a failed request; page errors, other console errors and unlisted failing requests
still fail the check. Each route's result lists the fixtures it used.

The file is part of the verified source snapshot, so changing it makes an earlier
pass stale. An invalid file stops the check. A fixture states what the app is
shown, not that the real API behaves that way; it appears in the commit for
review like any other source file.

Preload the browser image on the PSM host:

```bash
docker build -f scripts/task-browser.Dockerfile -t psm-task-browser:1.64.0 .
```

`PSM_BROWSER_IMAGE` can select another preloaded image containing Chromium and
Playwright at `/opt/psm-browser/node_modules/playwright`. Build/test tasks continue
using `PSM_TASK_IMAGE` (default `node:22-bookworm-slim`). The browser recipe pins
Playwright and its matching browser binaries; see [Playwright Docker documentation](https://playwright.dev/docs/docker).
The host used to develop this change has both images preloaded.

Task snapshots allow ordinary source files up to 8 MiB, web media/font assets up
to 32 MiB each, and 512 MiB total. Assets are copied in full; generated build,
cache and dependency directories are excluded. Limit errors identify the file,
size and threshold. A blocked check does not count as passing verification.

Run the regression tests, including real Chromium/container checks:

```bash
PSM_RUNNER_DOCKER=1 node --import tsx --test src/server/agent-task-runner*.test.ts src/server/agent-repository-tools.test.ts src/server/agent-permission-runtime.test.ts
```
