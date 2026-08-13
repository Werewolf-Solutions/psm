# Registering psm as a Werewolf cloud application

- **Status:** done on local dev (verified end to end); outstanding on production. The
  hosted-callback question below is **decided** — two rows, `psm` and `psm-web` — and both
  bootstrap scripts exist. What is left is running them against production.
- **Date:** 2026-08-12, production re-checked 2026-08-13
- **Repo that owns it:** `werewolf-dapp` (a database record, created by a script)

## What psm needs

Signing in — "Continue with Werewolf", the only way in — keys off the `CloudApplication`
row with `key: 'psm'`. Without it, dapp answers `503 app_not_configured` from
`getApplication()` and sign-in cannot work.

dapp already ships the script that creates it:

```bash
cd werewolf-dapp/server
PSM_BUSINESS_ID=<the Werewolf business _id> npm run bootstrap:psm
```

`scripts/bootstrap-psm-cloud.js` upserts the row and wires the Stripe product and prices
for PSM Pro. The identity-relevant part of what it writes:

```js
clientType: 'native',      // loopback + PKCE
trusted: true,             // first-party: consent is remembered
scopes: ['psm:profile', 'psm:billing', 'psm:sync', 'psm:backup'],
```

It needs `PSM_BUSINESS_ID` and a business that has completed Stripe Connect onboarding,
because it also provisions billing.

## Local development — working

Verified against `http://localhost:3000/api/v1` on 2026-08-12. The row is present:

```bash
$ curl 'http://localhost:3000/api/v1/apps/psm/public?redirectUri=http%3A%2F%2F127.0.0.1%3A4331%2Fapi%2Fcloud%2Fsso%2Fcallback'
{"success":true,"data":{"key":"psm","name":"PSM","clientType":"native",
 "scopes":["psm:profile","psm:billing","psm:sync","psm:backup"],"redirectAllowed":true}}
```

Note the query parameter is **`redirectUri`**, camelCase — `redirect_uri` is silently
treated as absent and reports `redirectAllowed:false`, which is a misleading way to read
"you asked the wrong question".

Because psm is a `native` client, *any* loopback port is accepted with the path locked to
`/api/cloud/sso/callback` — 4317, 4331, 9999 all verified. A local psm needs no
per-port registration.

The whole flow was then driven end to end against this dapp: identity login → consent
screen ("Authorize PSM", naming the instance and the four scopes) → Approve → psm's
callback redeemed the code → signed in. A replayed callback was refused.

## Production — outstanding

Re-checked 2026-08-13. `https://werewolf.solutions/api/v1` has **no cloud applications
registered at all** — this is not psm-specific:

```
POST /apps/psm/auth/exchange     → 503 app_not_configured
POST /apps/psm-web/auth/exchange → 503 app_not_configured
POST /apps/todo/auth/exchange    → 503 app_not_configured
```

Use the **exchange** endpoint to check this, not `/apps/:key/public`. The latter answers
404 for every key, which reads like a missing route and is not: the controller maps
`app_not_configured` to 404. Production's dapp code is current; the collection is empty.

That `todo` is unregistered too is worth someone's attention separately — todo-app is
live, so either it does not use this sign-in path in production or its cloud sign-in is
broken there. Not investigated here.

Running both bootstrap scripts against the production database closes psm's half. See
`docs/deploy/PUBLISHING-A-NEW-APP.md` step 2 for the three ways to run them and why
`mongosh` by hand is not one of them.

## Hosted psm — decided: two rows

`isRedirectAllowed` for a `native` client requires `http` + a loopback host, so
`https://psm.werewolf.solutions/auth/callback` can never be accepted by the `psm` row —
confirmed against local dapp, which returns `redirectAllowed:false` for it. One row cannot
serve both halves.

**Resolved in favour of a second application** (psm commit `3b045e5`, 2026-08-12), which
was option 1 of the three weighed here. The two clients have genuinely different trust
properties, and revoking one does not touch the other:

| Row | `clientType` | Used by | Redirect |
|---|---|---|---|
| `psm` | `native` | the local cockpit and agents | loopback, any port, fixed path |
| `psm-web` | `web` | the hosted page at psm.werewolf.solutions | exact https allowlist |

`web/auth.js` hardcodes `APP_KEY = "psm-web"` and runs PKCE in the browser; the cockpit
keeps its server-side loopback flow in `src/server/sso.ts`. Which one applies is decided by
asking the page's own origin for `/api/auth/session`, not by guessing from the hostname.
werewolf-dapp ships `server/scripts/bootstrap-psm-web.js` alongside `bootstrap-psm-cloud.js`.

The two rejected options, for the record: widening `isRedirectAllowed` so a native client
may also match exact https entries (smallest change, but loosens the native rule for every
future app), and flipping `psm` to `web` (breaks loopback sign-in for every local install).

Local instances set `PSM_SSO_REGISTERED=1` once dapp accepts their callback, and
`PSM_PUBLIC_ORIGIN` if psm cannot infer its origin from proxy headers.

## Verifying any environment

```bash
# 1. is the application there?
curl "$API/apps/psm/public?redirectUri=http%3A%2F%2F127.0.0.1%3A4317%2Fapi%2Fcloud%2Fsso%2Fcallback"
# want: {"success":true,...,"redirectAllowed":true}

# 2. does the exchange route reach a configured app?
curl -X POST "$API/apps/psm/auth/exchange" -H 'Content-Type: application/json' \
  -d '{"code":"x","codeVerifier":"y","redirectUri":"http://127.0.0.1:4317/api/cloud/sso/callback"}'
# want: 401 "Invalid or expired authorization code"  (not 503 app_not_configured)
```

Then in psm: `npm run dev`, click the account chip, **Continue with Werewolf**.
