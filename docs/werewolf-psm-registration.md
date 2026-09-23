# Registering psm as a Werewolf cloud application

- **Status:** working end to end against a local dapp, verified in a browser on 2026-09-21
  with a disposable account and database (see *Verified, and how* below). Production is
  still unregistered — that is a script run against the production database, not a code
  change.
- **Date:** 2026-09-21. Supersedes the 2026-08-17 revision, which described the registration
  as the only outstanding item; a second bug (the missing `Origin`, below) was in psm.
- **Repo that owns the remaining work:** `werewolf-dapp` (a database record, created by a
  script).

## Two bugs, both fixed 2026-09-21

Sign-in was broken for two independent reasons, and fixing either alone would not have
helped.

1. **Registration drift.** `bootstrap-psm-cloud.js` upserted the row back to
   `clientType: 'native'` on its way to provisioning Stripe prices, and `npm run
   bootstrap:psm` pointed at *that* script. So the documented repair for a broken login
   was the thing that broke it. Identity and billing are now separate scripts that cannot
   contradict each other — see *Which script does what*.
2. **psm sent no `Origin`.** dapp pins a web client's cookie endpoints to an origin in the
   row's `redirectUris` (`isOriginAllowed`, `server/utils/appSessionCookie.js`), because
   those endpoints hand back a bearer token. A browser stamps that header itself; psm's
   agent is a server and sent none, and an absent Origin is not an allowed one — so the
   exchange answered `401` and every refresh `403`. **dapp's check was right and is
   unchanged.** psm now derives the header from the callback it has already validated, and
   keeps it on the session for refresh and logout (`src/server/session.ts`,
   `approvedSsoCallback`/`ssoOriginForCallback` in `src/server/sso.ts`).

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

## Which script does what

Three scripts, one subject each. The split exists because they used to overlap and the
overlap is what broke sign-in.

| Command (in `werewolf-dapp/server`) | Writes | Needs Stripe? |
|---|---|---|
| `npm run repair:psm` | nothing, unless `--apply` | no |
| `npm run bootstrap:psm` | identity: clientType, callbacks, scopes, isActive | no |
| `npm run bootstrap:psm-billing` | `stripe.*` and paid-plan storage limits only | yes |

**`npm run bootstrap:psm` now runs `bootstrap-psm.js`** (identity). It used to run
`bootstrap-psm-cloud.js`, which is how a row kept reverting to `native`.

The shape all three agree on lives in one module, `server/lib/psmRegistration.js`, and is
pure — it takes the row as it is and returns the row as it should be, which is what lets
the repair tool report before it writes and lets the whole thing be tested without a
database.

### Repairing a registration

```bash
cd werewolf-dapp/server
npm run repair:psm                  # report only — this is the default, and it writes nothing
npm run repair:psm -- --apply       # write exactly what the report listed
npm run repair:psm -- --env=production --apply
```

What it will change: `clientType` → `web`, missing redirect URIs, a missing `psm:profile`
scope, and `isActive` if the row was switched off.

What it will **not** change, ever: who publishes psm, any `stripe.*` field, device limits,
scopes it did not add, or redirect URIs it does not recognise (`--prune` removes those, and
names every one first). There are no Stripe calls in it and no billing prerequisite —
signing in has nothing to do with billing, which was the original complaint about
`bootstrap-psm-cloud.js`.

`PSM_BUSINESS_ID` is required only to *create* a row, and remains **a decision, not a
lookup**. On an existing row it is ignored, and a mismatch is reported rather than applied.

### Billing, afterwards

`bootstrap-psm-cloud.js` now refuses to run until the identity row exists, and writes only
`stripe.monthlyPriceId`, `stripe.annualPriceId` and the paid-plan storage limits. It no
longer sets `clientType`, `redirectUris`, `scopes`, `business` or the device allowances,
and it no longer upserts.

### Retire the `psm-web` row

Unchanged advice: the row is no longer used by anything, since psm's page sends
`client_id=psm` in every posture. Set `isActive: false`, or delete it.

## Running it

Local dapp first. The row already exists there, so it carries its own business and there is
nothing to decide — and as of 2026-09-21 the local row is already `web`, so this reports
"already correct" and writes nothing:

```bash
cd werewolf-dapp/server
npm run repair:psm                     # see what it would do
npm run bootstrap:psm                  # identity — migrates native → web if needed
```

The local dapp API is on `:3000` and its consent screen is the Vite client on `:5173`; psm
discovers both, and `WEREWOLF_WEB_ORIGIN` overrides the consent screen if it moves.

Production, in preference order (from `docs/deploy/PUBLISHING-A-NEW-APP.md`):

1. **From your laptop against the production Atlas URI** — no dapp deploy needed:
   ```bash
   # report first — it writes nothing without --apply
   MONGODB_URI='<prod Atlas URI>' PSM_BUSINESS_ID=<id> \
     node scripts/repair-psm-registration.js --env=production
   MONGODB_URI='<prod Atlas URI>' PSM_BUSINESS_ID=<id> \
     node scripts/repair-psm-registration.js --env=production --apply
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

## Verified, and how

Run **2026-09-21**, against a local dapp, with a disposable account and its own database
(`psm-login-verify-disposable`, dropped afterwards). The dev database was not touched, and
its `psm` row still reads `updatedAt: 2026-08-17`.

What a browser actually did: opened the cockpit, clicked **Sign in with Werewolf**, landed
on dapp's real consent screen at `/authorize?client_id=psm&…&code_challenge_method=S256`,
approved, came back to `/auth/callback`, and ended up signed in as the disposable user.
`GET /api/cloud/workspaces` then listed that user's business (`role: owner`) and
`PUT /api/cloud/workspaces/selected` switched to it — so the session works for downstream
cloud calls, not just for the account chip.

The refresh half cannot be reached in a browser inside a test window, because dapp's app
access token lives fifteen minutes. It was verified separately by driving psm's **real**
`session.ts` against the **running** dapp: exchange succeeded, a genuine refresh with the
retained origin succeeded, and the same refresh with no origin was refused — confirming the
fix without weakening dapp's check.

| | |
|---|---|
| `npm test` in `psm` | 540 pass |
| `npm test` in `werewolf-dapp/server` | 687 pass (325 unit, rest integration against local Mongo) |
| Reverting `appOrigin()` alone | 7 psm tests fail — the coverage is real, not decorative |

**Not verified:** production, which has no rows at all (below), and psm running behind a
proxy with `PSM_PUBLIC_ORIGIN` set.

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

### The `Origin` the agent has to send

A server has no SameSite rules, which is the point — but it also has no `Origin` header,
which turned out to matter. Those cookie endpoints return a bearer access token while the
platform's CORS policy is deliberately permissive for API-key integrations, so dapp pins a
web client to an origin drawn from its own `redirectUris`:

```js
// werewolf-dapp/server/utils/appSessionCookie.js
function isOriginAllowed(application, origin) {
  if (!usesCookie(application)) return true;
  const candidate = String(origin || '').trim();
  if (!candidate) return false;                       // ← psm landed here
  return (application.redirectUris || []).some(…);
}
```

A browser stamps the header itself, so todo-app never noticed. psm's agent is a server, and
an absent Origin is not an allowed origin — `401` on exchange, `403` on refresh, every
time.

**The repair was in psm, and dapp's check is untouched.** psm derives the header from the
callback this sign-in actually used, *after* checking that it is the callback this psm
issues (`approvedSsoCallback`), and keeps it on the in-memory session so refresh and logout
present the same one. Since the callback is registered and dapp re-checks that on the
exchange, its origin is in the allowlist by construction — nothing is widened.

Two things follow, and both are deliberate:

- The callback in the request body is **checked, not forwarded**. It has to equal the one
  `ssoRedirectUri()` would produce for the same request — otherwise whoever reached the
  route would be choosing the origin psm asserts to dapp.
- Running psm on an unregistered port still fails, and still says so. The origin is only as
  good as the registration behind it, which is the property worth keeping.
