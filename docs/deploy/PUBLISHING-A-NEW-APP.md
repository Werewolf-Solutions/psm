# Publishing a new app to `*.werewolf.solutions`

The steps to put a new app on its own subdomain, in the order they have to happen,
with each one marked by how much of it is already automated. Written from todo-app's
`docs/DEPLOY.md` and psm's own deploy; both are static apps talking to werewolf-dapp's
API, which is the pattern to copy unless you have a reason not to.

**Legend:** ⚙️ = a script does it · 🔶 = scripted but needs a decision or a secret ·
👤 = a human, once per app

---

## The shape you are aiming for

```
browser ──── https://<app>.werewolf.solutions   static files, nginx, no process
   │
   ├──────── https://werewolf.solutions/api/v1  accounts + data (werewolf-dapp)
   │
   └──────── http://127.0.0.1:<port>            optional: a local agent, if the app
                                                needs the user's own machine
```

**No new process on the droplet.** It has 1 GB of RAM shared by dapp prod (5000),
staging (5100), redis and nginx, and `werewolf-dapp/docs/11-operations.md` says it
cannot run `npm ci` without being OOM-killed. Everything is built in CI and rsynced.
`pm2 list` looking identical after a deploy is part of acceptance, not an aside.

---

## 0. Decide what the app actually needs 👤

Three questions, and they determine everything below:

| Question | If yes |
|---|---|
| Does it need user accounts? | register a `CloudApplication` (step 2) |
| Does it store data for the user? | it goes in dapp's Mongo, behind `/apps/<key>/*` routes in dapp |
| Does it need the user's own machine? | it needs a local agent and a pairing boundary (psm is the worked example) |

If all three are no, you are publishing a static marketing page and only steps 1, 3, 4
and 5 apply.

## 1. DNS ⚙️

```bash
cd werewolf-dapp
DNS_NAME=<subdomain> node .dogfood/dns.mjs
```

Idempotent — it checks for an existing A record first. Reads `DOP_TOKEN` and
`DO_SSH_HOST` from `werewolf-dapp/.env` and never prints them. TTL 300.

Verify: `getent hosts <subdomain>.werewolf.solutions` returns the droplet's IP.

## 2. Register the app with werewolf-dapp 🔶

The row lives in dapp's Mongo. Without it every auth call answers
`503 app_not_configured`, and the consent screen says *"This authorization request is
invalid or incomplete"*.

Copy `werewolf-dapp/server/scripts/bootstrap-todo.js` (simplest) or
`bootstrap-psm-cloud.js` (if the app sells something — it also provisions Stripe
products and prices, and needs a Stripe-Connect-onboarded business).

**The one field that matters most is `clientType`,** because it decides where the
refresh token goes:

| `clientType` | Redirect rule | Refresh token |
|---|---|---|
| `web` | exact match against `redirectUris` | **httpOnly cookie** `ws_app_rt_<key>`, omitted from the JSON |
| `native` | `http` + loopback host + one fixed path, **any port** | returned in the JSON body |
| `mobile` | exact match, private-use scheme only | returned in the JSON body |

**A browser app must be `web`.** Anything a page can read, injected script can read
too — that is the whole reason `server/utils/appSessionCookie.js` exists. The cookie
works across `<app>.werewolf.solutions` → `werewolf.solutions` because they are
different *origins* but the same *site*.

An app with both a page and a local agent needs **two rows** — psm does: `psm`
(`native`, for the cockpit and agents, loopback PKCE) and `psm-web` (`web`, for the
hosted page). One row cannot be both, and flipping the shared one to `web` breaks every
local install.

Running it against production, in preference order:

1. **From your laptop against the production Atlas URI** — no dapp deploy needed:
   ```bash
   cd werewolf-dapp/server
   MONGODB_URI='<prod Atlas URI>' <APP>_BUSINESS_ID=<id> node scripts/bootstrap-<app>.js
   ```
   Only blocked if Atlas's IP allowlist excludes you.
2. **On the droplet**, which means merging the script through dapp's `dev` → `master`
   first. Safe on 1 GB — the OOM constraint is about `npm ci`, not about running a
   script against installed deps.
3. Never by hand in `mongosh`: the row would exist with no reproducible provenance.

`<APP>_BUSINESS_ID` is **a decision, not a lookup** — whether the app reuses the
business that publishes the others, or gets its own, is unmade until someone makes it.

Verify:
```bash
curl "https://werewolf.solutions/api/v1/apps/<key>/public?redirectUri=<exact URI>"
# want: {"success":true,…,"redirectAllowed":true}
```
A 404 here means *the app is not configured* — the controller maps `app_not_configured`
to 404 — not that the route is missing. The query parameter is **`redirectUri`**,
camelCase; `redirect_uri` is silently read as absent and reports `redirectAllowed:false`,
which is a misleading way to be told you asked the wrong question.

## 3. nginx vhost + TLS 👤 first time, ⚙️ after

```bash
sudo cp docs/deploy/<app>.werewolf.solutions.nginx.conf \
        /etc/nginx/sites-available/<app>.werewolf.solutions
sudo ln -s /etc/nginx/sites-available/<app>.werewolf.solutions /etc/nginx/sites-enabled/
sudo mkdir -p /var/www/<app>.werewolf.solutions
sudo chown "$USER":www-data /var/www/<app>.werewolf.solutions
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d <app>.werewolf.solutions
```

⚠️ **The vhost references certificate paths that do not exist until certbot has run**,
so `nginx -t` fails on the TLS block the first time. Either drop the `listen 443` server
for the first run and let certbot add it, or issue the certificate first with
`certbot certonly --webroot -w /var/www/certbot -d <app>.werewolf.solutions`.

Copy `todo-app/docs/deploy/todo.werewolf.solutions.nginx.conf` as the base. Three things
to get right:

- **SPA fallback** `try_files $uri $uri/ /index.html` — required if `/auth/callback` is
  a real path, which it is for any app using the redirect flow.
- **`location /api/ { return 404; }` before the fallback.** Otherwise a fetch that
  someone forgot to point at the API gets `index.html` with HTTP 200 and dies later in
  `JSON.parse`. Make it fail loudly.
- **Cache headers must match how the app is built.** A Vite build has hashed filenames,
  so `/assets/` can be `1y immutable` with `index.html` on `no-cache`. An app served
  raw from source (psm) has no hashes, so **everything** must be `no-cache` and rely on
  ETag revalidation — otherwise a returning visitor runs last week's JavaScript against
  this week's HTML.

## 4. GitHub secrets ⚙️ once for the org, 👤 per environment

`DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_USER` — set these **once as organization
secrets** (Werewolf-Solutions → Settings → Secrets and variables → Actions →
*New organization secret*), scoped to the repos that deploy. Every app repo then
inherits them, and rotating the droplet key is one edit rather than one per repo.
Setting them requires org-admin rights; a repo-scoped `gh` token gets 403 and the
web UI is the reliable path.

Repository secrets of the same name shadow the org's, and **environment** secrets
shadow both. That precedence is the mechanism for staging: same workflow, same
secret names, different machine.

Two things the names do not tell you, and both have cost a red deploy:

- **`DEPLOY_SSH_KEY` is the private half** — the file *without* `.pub`. A public key
  here fails as `Permission denied (publickey)`, which reads like an authorization
  problem on the droplet rather than a wrong upload.
- **The key's public half must be in `~<DEPLOY_USER>/.ssh/authorized_keys`** on the
  droplet (`ssh-copy-id -i <key>.pub <user>@<host>`), and `DEPLOY_USER` needs write
  access to `/var/www/<app>.werewolf.solutions`. Inheriting the org secret does not
  mean the target directory exists yet — that is step 3.

Non-secrets belong in **environment variables**, not secrets: `DEPLOY_HOSTNAME` and
`DEPLOY_TARGET_DIR` differ per environment, and being able to read them in the UI is
worth more than hiding a hostname.

## 5. Deploy workflow ⚙️

Copy `psm/.github/workflows/deploy.yml`. On push to `master` it deploys
**production**; `workflow_dispatch` offers a choice of environment, which is the
one-button deploy. Steps: install, test, preflight, build (if there is a build),
rsync, smoke-check.

Put the **preflight before anything touches the droplet** — missing secrets, a public
key pasted where a private one goes, a target directory that does not exist, a deploy
user that cannot write to it. rsync reports all four as `unexplained error (code 255)`.

```yaml
rsync -az --delete -e "ssh -i ~/.ssh/deploy_key" \
  <built-output>/ "${DEPLOY_USER}@${DEPLOY_HOST}:/var/www/<app>.werewolf.solutions/"
```

`--delete` keeps the target exact so a removed asset cannot linger and be served beside
its replacement. Nothing else should live in that directory.

If the client is built by Vite, bake the API origin in at build time
(`VITE_API_BASE`, `VITE_WEREWOLF_WEB_ORIGIN`). If there is no build step, derive it in
the client from `location.hostname` — templating a config file in CI turns the deploy
into a build by another name.

## 6. Smoke check ⚙️

More than one URL. The interesting failures are silent:

```bash
for u in / /<main-script>.js /auth/callback; do   # 200 each — the last proves SPA fallback
  curl -fsS -o /dev/null "https://<app>.werewolf.solutions$u" || exit 1
done
[ "$(curl -s -o /dev/null -w '%{http_code}' https://<app>.werewolf.solutions/api/x)" = "404" ] || exit 1
```

## 7. Acceptance 👤

- [ ] the app is served over TLS
- [ ] sign-in works against **production** dapp, not just local
- [ ] a push to `master` redeploys it
- [ ] `ssh <user>@<host> 'pm2 list'` shows **no new process**

## 8. Rollback ⚙️

Static apps have no migration to reverse: re-run the workflow from an earlier commit, or
`rsync` a previous build into the target. The API half rolls back with dapp's own deploy.

---

## What to automate next

Roughly in order of how much time each would save:

1. **`bootstrap-<app>.js` as a generic script** taking a JSON app descriptor, instead of
   one hand-copied file per app. The three existing ones differ only in the row and
   whether Stripe is involved.
2. **A `new-app` scaffold** that emits the vhost, the workflow and the bootstrap
   descriptor from `{ key, subdomain, clientType, build }` — steps 2, 3 and 5 are almost
   entirely mechanical once step 0 is decided.
3. **The vhost install** (step 3) as an idempotent script alongside `dns.mjs`; the only
   genuinely manual part is the first certbot run.
4. ~~**A deploy preflight**~~ — done in psm's `deploy.yml` for steps 3 and 4 (secrets
   present, private key, target directory writable). Still unchecked: DNS (step 1) and
   whether the app is registered (step 2), both of which fail later and less clearly.

## Things that have actually gone wrong

- **`redirect_uri` vs `redirectUri`** on `/apps/:key/public` — reports "not allowed" for
  a URI that is perfectly allowed.
- **A 404 from `/apps/:key/public` read as "the route is missing"** when it means "the
  app is not registered". Cost an incorrect "production is running an older build" note
  in three files.
- **An inherited `PORT`.** `dotenv` does not overwrite variables that already exist, so
  a `PORT` in the environment silently beats the project's own `.env`. psm was handing
  its own `PORT` to every dev server it launched. The tell: dotenv logs how many
  variables it injected, and the count drops by one for each it skipped.
- **Vite climbing ports.** A stale dev server on 5173 sends the next one to 5174, then
  5175, and anything hard-coded to 5173 quietly talks to the wrong instance.
