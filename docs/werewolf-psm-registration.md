# Registering psm as a Werewolf cloud application

- **Status:** done on local dev (verified end to end); outstanding on production
- **Date:** 2026-08-12
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

On 2026-08-12, `https://werewolf.solutions/api/v1` answered:

```
POST /apps/psm/auth/exchange → 503 {"code":"app_not_configured",
                                    "message":"Cloud application \"psm\" is not configured"}
```

`/apps/todo/auth/exchange` answered identically, and `/apps/:appKey/public` was absent
there. That 404 is the controller mapping `app_not_configured` to 404, **not** a missing
route — production's dapp code is current; the row simply has not been bootstrapped there. Running `bootstrap:psm` against the production
database (with the production `PSM_BUSINESS_ID`) is what closes this.

## Hosted psm still needs a decision

`isRedirectAllowed` for a `native` client requires `http` + a loopback host, so
`https://psm.werewolf.solutions/api/cloud/sso/callback` can never be accepted by that row
— confirmed against local dapp, which returns `redirectAllowed:false` for it. Three ways
forward, in order of preference:

1. **A second application for the hosted front end.** Keep `psm` native for local cockpits
   and agents; add `psm-web` with `clientType: 'web'` and an exact `redirectUris` list.
   Cleanest: the two clients have genuinely different trust properties, and revoking one
   does not touch the other. Costs psm a config knob for which key to use.
2. **Allow both on one row.** Extend `isRedirectAllowed` so a native client may also match
   exact https entries in `redirectUris`. Smallest change for psm, but it widens the
   native rule for every future native app.
3. **Flip `psm` to `web`.** Simplest record, but it breaks loopback sign-in for every local
   cockpit and agent. Avoid.

Until one lands, hosted psm hides "Continue with Werewolf" and says why
(`ssoAvailability()` in `src/server/sso.ts`). Set `PSM_SSO_REGISTERED=1` once dapp accepts
the hosted callback, and `PSM_PUBLIC_ORIGIN` if psm cannot infer its origin from proxy
headers.

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
