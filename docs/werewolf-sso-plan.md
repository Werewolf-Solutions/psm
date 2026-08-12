# Design: "Sign in with Werewolf" — browser-handoff SSO for psm

- **Status:** proposed (plan-first; no code written yet)
- **Date:** 2026-07-22
- **Repos touched:** `werewolf-dapp` (server auth) + `psm` (this repo)

## Context / goal

Today psm re-authenticates against the Werewolf API with **email + password**
(`cloud.ts` → `/auth/login` + `/apps/psm/auth/login`). Being logged in on
`werewolf.solutions` does **not** log you into psm, because API auth is **JWT Bearer**
(`middleware/auth.js` reads only `Authorization: Bearer`), not a shared cookie — and psm
runs on `localhost`, which no `*.werewolf.solutions` cookie can reach.

Goal: one click in the psm cockpit → because the same browser is already logged in to
`werewolf.solutions`, psm gets a session with **no password re-entry**. This is the
standard **OAuth 2.0 Authorization Code + PKCE** pattern for a native/local app, built by
reusing primitives that already exist in `werewolf-dapp`.

## Existing primitives we reuse (do not reinvent)

- `utils/jwt.js`: `generateAccessToken(payload,{audience,expiresIn})`, `verifyAccessToken`,
  and the SSO-ticket pair `generateSSOTicket`/`verifySSOTicket` (HS256, 60s, `jti`).
- `lib/cache/ssoReplayStore.js` `markUsed(jti)` — atomic single-use guard (Redis or memory).
- `controllers/psmController.js` `authResult(user, device)` → `issueSession(user, app, device)`
  in `services/psmCloud.js` — mints the **device-bound, revocable AppSession** that password
  login already returns (so Devices list + revoke keep working unchanged).
- `middleware/auth.js` `protect` (identity JWT) and the CSRF skip-list in `server/app.js:91-98`
  (public POST routes like `/apps/psm/auth/login` are listed there).
- Server-rendered HTML page precedent: `server/app.js` already serves `/apps/psm/billing/complete`.
- Website stores its identity token at `localStorage.accessToken` (`client/src/services/api.ts:43`).
- psm side: `runtime.ts` (`werewolfApiUrl`, local/production URLs), `cloud.ts` token store
  (`acceptTokens`, keyring), `deviceIdentity()`.

## The flow

```
psm cockpit (browser)                 werewolf.solutions (same browser, logged in)      psm server (127.0.0.1:4317)
   | click "Sign in with Werewolf"
   |-- GET /api/cloud/sso/start ----------------------------------------------------------->|
   |<-- { authorizeUrl } (PKCE verifier+state kept server-side, keyed by state) ------------|
   | window.open(authorizeUrl)
   |----------------------> /authorize/psm?redirect_uri=127.0.0.1..&state&code_challenge
   |                        (consent page reads localStorage.accessToken)
   |                        user clicks Approve
   |                        POST /api/v1/apps/psm/auth/authorize (Bearer identity)  --> { code }  (60s, single-use, PKCE-bound, aud:psm)
   |                        302 redirect_uri?code=..&state=..
   |------------------------------------------------------------> GET /api/cloud/sso/callback?code&state
   |                                                              server: POST /apps/psm/auth/exchange {code, codeVerifier, device}
   |                                                              <-- { tokens, user, entitlement }  (issueSession — same as password login)
   |                                                              store tokens (keyring); serve "done, return to psm" page
   | popup postMessage / poll /api/cloud/status -> signedIn -> render account
```

The identity token never leaves the browser; only a 60-second, single-use, PKCE-bound
**authorization code** crosses to psm.

## werewolf-dapp changes (server)

1. **`utils/jwt.js`** — add `generateAppAuthCode(payload)` / `verifyAppAuthCode(token)`:
   HS256 with a **new `JWT_APP_CODE_SECRET`** (do not reuse the SSO/business secret), 60s,
   `jti`, `aud: "psm"`. Payload: `{ userId, email, name, cc (PKCE S256 challenge), rd (sha256 of redirect_uri), jti, aud }`.
2. **New controller** `controllers/psmSsoController.js`:
   - `authorizeApp` (`protect`): body `{ codeChallenge, redirectUri }`. Validate `redirectUri`
     against a **loopback allowlist** (`http://127.0.0.1:<port>/api/cloud/sso/callback`,
     `http://localhost:...`). Return `{ code: generateAppAuthCode({ userId: req.user._id, email, name, cc: codeChallenge, rd: sha256(redirectUri) }) }`.
   - `exchangeAppCode` (public): body `{ code, codeVerifier, device }`. `verifyAppAuthCode`;
     `markUsed(jti)` (replay → 401); check `base64url(sha256(codeVerifier)) === cc` (PKCE S256);
     load `User.findById(userId)`; `return authResult(user, device)`. Audit-log via `services/auditLog`.
3. **`routes/api/v1/psm.js`** — before `router.use(protectPsm)`:
   `router.post('/auth/authorize', protect, psmSso.authorizeApp)` and
   `router.post('/auth/exchange', psmSso.exchangeAppCode)`.
4. **`server/app.js`** — add `/api/v1/apps/psm/auth/exchange` to the CSRF skip-list (`:91-98`);
   rate-limit both new routes.
5. **Consent page** — primary: a client route `client/.../authorize/psm` (has axios + token).
   Fallback: a server-rendered page like `/apps/psm/billing/complete`. It reads
   `localStorage.accessToken` (if absent → normal login, then return), validates `redirect_uri`
   is loopback, shows **"Authorize psm on `<host>` to access your Werewolf account?"** with
   Approve/Deny, calls `/auth/authorize`, then `302`s to `redirect_uri?code&state`.

## psm changes (this repo)

1. **`src/server/runtime.ts`** — add `werewolfWebUrl()` (website origin for the authorize page,
   vs the `/api/v1` API base).
2. **`src/server/cloud.ts`**:
   - `beginBrowserAuth(callbackUrl)`: make `codeVerifier` (random 32B), `codeChallenge =
     base64url(sha256(verifier))`, `state`; stash `{verifier, callbackUrl}` in memory by `state`
     (TTL 5m); return the `authorizeUrl`.
   - `completeBrowserAuth(code, state)`: look up by `state`; `POST /apps/psm/auth/exchange
     { code, codeVerifier, device: deviceIdentity() }`; `acceptTokens("cloud", data.tokens, apiUrl)`;
     set `state.account` from `data.user` + entitlement.
   - Adapt `account()`: when there is **no identity token** (SSO path), don't call `/auth/me`;
     use the app session (`/apps/psm/me`) + the `user` captured at exchange. (Today `account()`
     hard-requires the identity session.)
3. **`src/server/index.ts`**:
   - `GET /api/cloud/sso/start` → `{ authorizeUrl }` (builds callback from the request host).
   - `GET /api/cloud/sso/callback?code&state` → `completeBrowserAuth`, then serve a tiny HTML
     page that `postMessage`s the opener and says "return to psm".
4. **`web/cloud.js`** — in `renderCloudLogin`, add a primary **"Sign in with Werewolf"** button:
   `GET /api/cloud/sso/start` → `window.open(authorizeUrl)` → on `message` (or poll
   `/api/cloud/status` every ~1.5s) until `signedIn` → `loadCloud(true)`. Keep the
   email+password form as a fallback.

## Security review (payments/ERP backend — must hold)

- **PKCE S256 mandatory**; auth code is single-use (`markUsed`) + 60s TTL + `aud:"psm"` so it
  can't be crossed with business SSO tickets. New dedicated `JWT_APP_CODE_SECRET`.
- **redirect_uri allowlist = loopback only**, validated on the consent page **and** bound into
  the code (`rd` hash) so a stolen code can't be redirected elsewhere.
- **Explicit consent screen** showing the device/host — a local process can open the authorize
  URL, but cannot mint a session without the logged-in user approving in the browser.
- **`state`** round-tripped and checked in psm (CSRF); loopback callback binds to `127.0.0.1` only.
- Minted session = the **same device-bound, revocable AppSession** as password login → appears in
  Devices, revocable, refresh-rotated. Identity token **never** leaves the browser.
- Rate-limit `/auth/authorize` + `/auth/exchange`; **audit-log** every exchange (user, device, ip).
- psm stores only the app-session tokens (keyring), never a password or the identity token.

## Verification

- **werewolf-dapp**: unit-test `authorizeApp`/`exchangeAppCode` (happy path, replay→401,
  bad PKCE→401, expired code→401, wrong `aud`→401, non-loopback redirect→400). Manual: curl the
  authorize (with a real identity token) → exchange → assert an AppSession row + working `/apps/psm/me`.
- **psm**: run the cockpit, click "Sign in with Werewolf" while logged in to the site in the same
  browser → approve → account renders with **no password**; confirm the new device shows in Devices
  and revoke works; confirm password login still works as fallback.
- End-to-end against the **local** API (`:3000`) first (runtime already prefers it), then production.

## Decisions (confirmed 2026-07-22)

1. **Consent page:** a **client React route** in `werewolf-dapp/client` (e.g. `/authorize/psm`),
   reusing the app's axios/token handling — not a server-rendered page. Implies a client build +
   deploy as part of shipping this.
2. **New env `JWT_APP_CODE_SECRET`:** yes — a dedicated secret for psm auth codes, isolated from
   the business SSO secret. Must be added to the werewolf-dapp server deployment/config.
3. **Password login:** **kept as a fallback.** "Sign in with Werewolf" is the primary path; the
   email+password form stays for headless/no-browser/offline use.
