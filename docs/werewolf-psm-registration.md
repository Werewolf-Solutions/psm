# Registering psm as a Werewolf cloud application

- **Status:** psm's side is done and tested. **One thing is outstanding, and it is in
  werewolf-dapp:** the `psm` CloudApplication row has to become a `web` client with psm's
  callbacks listed. Until then sign-in refuses with a sentence saying exactly that — on the
  local dapp *and* on production.
- **Date:** 2026-08-17. Supersedes the two-row design of 2026-08-12.
- **Repo that owns the remaining work:** `werewolf-dapp` (a database record, created by a
  script).

## The shape, in one table

psm signs in as **one** application, the way todo-app does. One row, one `client_id`, one
consent screen, one callback path, whether the page came from the local agent or from
psm.werewolf.solutions.

| | |
|---|---|
| `key` | `psm` |
| `clientType` | `web` |
| `redirectUris` | the exact list below |
| `scopes` | `psm:profile`, plus the data scopes if/when cloud sync is turned back on |
| `trusted` | `true` (first-party) |

**Superseded:** psm used to register twice — `psm` as `native` for the local cockpit and
`psm-web` as `web` for the hosted page — because dapp's native rule (any loopback port) and
its web rule (exact match) cannot both come from one row. Two rows meant two registrations
to keep alive, two things to bootstrap, and a sign-in that could work in one posture and
not the other. The cost of collapsing them is that **psm's ports are pinned**, exactly as
todo-app pins 5200. That is the trade.

## The redirect URIs

A `web` client is exact-matched by `CloudApplication.isRedirectAllowed` — string equality,
no port wildcard, and **`localhost` and `127.0.0.1` are different strings**. Register all
of these:

```js
const REDIRECT_URIS = [
  'https://psm.werewolf.solutions/auth/callback', // the hosted page
  'http://localhost:8080/auth/callback',          // npm run web, the static host
  'http://localhost:4317/auth/callback',          // npm run dev, the cockpit
  'http://127.0.0.1:4317/auth/callback',          // the same cockpit, typed the other way
];
```

Running psm on another port (`PORT=4000 npm run dev`) means signing in will be refused
until that origin is registered too. psm says so rather than failing silently — see
Verifying below.

## Which dapp build is on the other end

Checked 2026-08-17, and it matters: **the httpOnly refresh-cookie transport
(`server/utils/appSessionCookie.js`) exists only on the `feat/todo-app` branch.**
`dev`, `master` and the other feature branches have the app-SSO controller but no cookie —
their `/apps/:key/auth/exchange` returns `refreshToken` in the JSON body and their
`/auth/refresh` reads `req.body.refreshToken`.

`clientType: 'web'` and the exact-match redirect rule are on every branch, so **registering
the row works regardless**. What differs is where the refresh credential lives, and psm
handles both without being told which is which — it presents the credential in the cookie
*and* in the body, and a dapp with the cookie transport ignores the body for a web client.

| | dapp with the cookie (`feat/todo-app`) | dapp without it (`dev`, `master`) |
|---|---|---|
| Cockpit (agent holds the session) | works | works |
| Hosted page, first sign-in | works | works |
| Hosted page, **after a reload** | stays signed in | signs in again |

That last cell is the real cost. The hosted page holds a body-borne refresh token in memory
only and never writes it to storage — anything storage can hold, injected script can read —
so a reload has nothing to restore from. It resolves itself when `feat/todo-app` merges.

## What has to change in werewolf-dapp

Two things, neither of them large.

### 1. A bootstrap script that does not require Stripe

`server/scripts/bootstrap-psm-cloud.js` refuses to create the row at all unless the
business has completed Stripe Connect onboarding:

```js
if (!business.stripe?.accountId || !business.stripe.isOnboarded) {
  throw new Error('Complete Stripe Connect onboarding for the PSM business first');
}
```

It provisions the Pro product and prices *before* it writes the CloudApplication, so psm's
**identity** is gated behind **billing** — which sign-in has nothing to do with. That is
why `todo` got registered locally and psm's production row never did:
`bootstrap-todo.js` just upserts the row.

Model the new one on `bootstrap-todo.js`. Billing stays where it is; run
`bootstrap-psm-cloud.js` later, when there is something to sell and a Connect-onboarded
business to sell it under, and let it update the same row's `stripe.*` fields.

**This script now exists** as `werewolf-dapp/server/scripts/bootstrap-psm.js`, added
2026-08-17. It is untracked on whatever branch is checked out, and requires only
`config/database`, `models/Business` and `models/CloudApplication` — all of which are on
every branch, so it runs wherever dapp is. **It has not been run against any database.**

Read it before running it; the shape is `bootstrap-todo.js` with psm's key, `clientType:
'web'`, the redirect list above, and `scopes: ['psm:profile']`. It is idempotent, and it
prints what it did — `created`, or `migrated (native → web)`.

`PSM_BUSINESS_ID` is **a decision, not a lookup** — whether psm reuses the business that
publishes the other apps or gets its own is unmade until someone makes it.

### 2. Retire the `psm-web` row

The row is no longer used by anything: psm's page sends `client_id=psm` in every posture.
Leaving an unused trusted row registered is a standing grant nobody needs. Set
`isActive: false`, or delete it. (`bootstrap-psm-web.js` lives on `feat/todo-app` along with
the cookie transport; nothing needs it now.)

## Running it

Local dapp first — the local row is currently `native`, so local sign-in is refused until
this runs. The row already exists there, so it carries its own business and there is
nothing to decide:

```bash
cd werewolf-dapp/server
node scripts/bootstrap-psm.js          # migrates the existing row: native → web
```

The local dapp API is on `:3000` and its consent screen is the Vite client on `:5173`; psm
discovers both, and `WEREWOLF_WEB_ORIGIN` overrides the consent screen if it moves.

Production, in preference order (from `docs/deploy/PUBLISHING-A-NEW-APP.md`):

1. **From your laptop against the production Atlas URI** — no dapp deploy needed:
   ```bash
   MONGODB_URI='<prod Atlas URI>' PSM_BUSINESS_ID=<id> node scripts/bootstrap-psm.js
   ```
   Only blocked if Atlas's IP allowlist excludes you.
2. **On the droplet**, which means merging the script through dapp's `dev` → `master`
   first. Safe on 1 GB — the OOM constraint is about `npm ci`, not about running a script.
3. Never by hand in `mongosh`: the row would exist with no reproducible provenance.

## Verifying any environment

```bash
API=https://werewolf.solutions/api/v1     # or http://localhost:3000/api/v1
curl "$API/apps/psm/public?redirectUri=http%3A%2F%2Flocalhost%3A4317%2Fauth%2Fcallback"
# want: {"success":true,"data":{...,"clientType":"web","redirectAllowed":true}}
```

The query parameter is **`redirectUri`**, camelCase; `redirect_uri` is silently read as
absent and reports `redirectAllowed:false`, which is a misleading way to be told you asked
the wrong question. A 404 here means *the app is not configured* — the controller maps
`app_not_configured` to 404 on this route and 503 on `/auth/exchange` — not that the route
is missing.

psm asks this itself before it redirects anywhere, and reports the answer in the sign-in
panel (`ssoAvailability()` in `src/server/sso.ts`, `checkRegistered()` in `web/auth.js`).
The three states it distinguishes, each with its own sentence:

| What dapp says | What psm shows |
|---|---|
| 404 / 503 | psm is not registered here; it needs a row with key `psm`, clientType `web` |
| `clientType: 'native'` | registered as a native client, and this build signs in as web |
| `redirectAllowed: false` | this page's callback is not in `redirectUris`, and names the URI |

Then: `npm run dev`, click the account chip, **Sign in with Werewolf**.

## Production, as last checked

Re-checked **2026-08-17**: `https://werewolf.solutions/api/v1` has **no cloud applications
registered at all**. `psm`, `psm-web` *and* `todo` every one answer
`503 app_not_configured` on `/auth/exchange`, and `todo.werewolf.solutions` does not
resolve. So there is no working production example of this flow to copy — todo-app works
against a local dapp, which is where all four rows (`psm`, `psm-web`, `todo`, `nfc-pay`)
actually exist.

## Why `web` rather than `native`, and where the cookie goes

dapp gives a `web` client its refresh credential as an httpOnly cookie
(`ws_app_rt_psm`, scoped to `/api/v1/apps/psm/auth`) and omits it from the JSON —
`server/utils/appSessionCookie.js`. A `native` row would hand a browser its refresh token
in the response body, which for a page means storing it somewhere injected script can read.

That cookie is `SameSite=Lax` and host-only on the API's host, which decides who redeems
the code:

- **Hosted page.** `psm.werewolf.solutions` → `werewolf.solutions` are different origins but
  the same *site*, so the cookie is stored and sent. The page exchanges and refreshes
  directly, exactly like todo-app.
- **Cockpit.** `localhost:4317` → `werewolf.solutions` is genuinely cross-site; the browser
  would neither store the cookie nor send it, and every reload would sign you out. So the
  page posts its code to its own agent (`POST /api/auth/exchange`) and psm's server keeps
  the cookie — a server has no SameSite rules. See `src/server/session.ts`.

The PKCE half is identical in both: the verifier is minted in the page, kept in
sessionStorage, and is useless to anyone without the exchange.
