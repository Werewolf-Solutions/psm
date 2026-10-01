# Publishing a new app to `*.werewolf.solutions`

> **Manual reference.** For a supported static project, start with PSM's
> [managed setup flow](PROJECT-SETUP.md). The managed engine has completed a Todo
> staging release; [its technical specification](DEPLOYMENT-SYSTEM.md) separates
> that evidence from remaining acceptance. This runbook preserves the manual
> static-app path and is not a recipe for a project with its own API server.

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
staging (5100), Mongo, Redis and nginx, and `werewolf-dapp/docs/11-operations.md` says
it cannot run `npm ci` without being OOM-killed. All npm and build work, when any is
needed, runs in CI; only static or otherwise produced files reach the droplet. `pm2
list` looking identical after a deploy is part of acceptance, not an aside.

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

### Choosing the subdomain

Choose and verify a hostname for each environment before deployment. Todo's
explicit choice is now `todo.werewolf.solutions` for **staging**; the former
`a6s1j3p3zh.werewolf.solutions` name is superseded. The setup UI suggests a readable
project hostname, but does not establish ownership or availability. A random
label is an optional way to reduce accidental collisions, not an access control
or a guarantee against indexing or discovery.

```bash
node -e 'const{randomInt}=require("node:crypto");const l="abcdefghjkmnpqrstvwxyz";const a=l+"0123456789";let s=l[randomInt(l.length)];while(s.length<10)s+=a[randomInt(a.length)];console.log(s)'
```

No `i`, `l`, `o` or `u`, so a label cannot spell a word or be misheard, and it starts
with a letter. Generate it **once** and record it in the project's
`.psm/deployments.json`. The DNS record, the release directory, the nginx vhost, the TLS
certificate and the callback registered in step 2 all pin the exact string — changing it
later means redoing all five, and the app stops being able to sign anyone in until you
do.

## 1. DNS ⚙️

```bash
cd werewolf-dapp
DNS_NAME=<subdomain> node .dogfood/dns.mjs
```

Create-if-absent, not a full reconciler: it stops when any matching A record exists and
does not compare its address, TTL, duplicates or ownership. It reads `DOP_TOKEN` and
`DO_SSH_HOST` from `werewolf-dapp/.env` and never prints them. TTL 300.

Verify both sides: `getent hosts <subdomain>.werewolf.solutions` must return the intended
droplet IP, not merely any address.

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

A `CloudApplication` row has one client type. An app that genuinely needs both native and
web token transports needs separate rows. PSM does not use that split: its current design is
one `psm` web application with exact pinned loopback callbacks. Its local server redeems the
authorization code server-side and retains dapp's httpOnly refresh cookie. See
[`../werewolf-psm-registration.md`](../werewolf-psm-registration.md).

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

Use this repository's `psm.werewolf.solutions.nginx.conf` as a hardening and `/api/`
sealing reference, not as a drop-in base. Its CSP deliberately grants loopback access needed
by PSM, and its cache policy assumes unhashed source assets. Generate an app-specific CSP and
cache policy. Todo's checked-in vhost predates the `/api/` seal below, so do not copy it
unchanged. Three things to get right:

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

## 4. GitHub deployment environment 👤 per environment

Set `DEPLOY_SSH_KEY`, `DEPLOY_HOST` and `DEPLOY_USER` on the repository's GitHub
deployment environment. Prefer a dedicated key per project/environment, restricted to that
release directory and without sudo. A shared organization key is legacy convenience with an
organization-wide blast radius: if it still exists during migration, scope it to the minimum
repository set and replace it as each target adopts the managed release helper.

Repository secrets of the same name shadow the organization's, and **environment** secrets
shadow both. That precedence is the mechanism for staging: same workflow, same secret names,
different target and key.

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

This list is superseded by the managed deployment architecture and delivery sequence in
[`DEPLOYMENT-SYSTEM.md`](DEPLOYMENT-SYSTEM.md#20-delivery-sequence). This runbook remains the
manual path until those pieces ship; do not grow it into a second collection of one-off
deployment scripts.

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
