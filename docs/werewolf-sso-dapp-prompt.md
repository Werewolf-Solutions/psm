# Paste-in prompt for a dedicated werewolf-dapp Claude session

---

You are implementing the **server + client side of "Sign in with Werewolf" SSO** in this repo
(`werewolf-dapp`, run at `http://localhost:3000`, API base `/api/v1`). A separate local app
called **psm** (a project cockpit on `http://127.0.0.1:4317`) will consume it. Your job is only
the `werewolf-dapp` half; do **not** worry about the psm codebase beyond honoring the HTTP
contract below exactly.

## Goal

Let a user who is already logged in to `werewolf.solutions` in their browser authorize the psm
desktop/local app **without re-entering their password**, using **OAuth 2.0 Authorization Code +
PKCE**. The identity JWT must never leave the browser — only a short-lived, single-use code
crosses to psm's loopback address. The minted session must be the **same device-bound, revocable
AppSession** that psm's password login already produces, so existing Devices/revoke/refresh keep
working.

## Reuse what already exists (verify these before coding)

- `utils/jwt.js` — `generateAccessToken(payload,{audience,expiresIn})`, `verifyAccessToken`, and
  the SSO ticket pair `generateSSOTicket`/`verifySSOTicket` (HS256, 60s, `jti`). Follow the same
  style for the new code helpers.
- `lib/cache/ssoReplayStore.js` — `markUsed(jti)` returns `true` on first use, `false` on replay
  (Redis-backed or in-memory). Reuse it for single-use codes.
- `controllers/psmController.js` — `authResult(user, device)` → `issueSession(user, application,
  device)` in `services/psmCloud.js`. This is what `POST /apps/psm/auth/login` returns after a
  successful `comparePassword`. Your `exchange` endpoint must return the **identical** shape by
  calling `authResult(user, device)` (skipping only the password check).
- `middleware/auth.js` `protect` — identity JWT (`Authorization: Bearer`) guard.
- `routes/api/v1/psm.js` — the psm route group (mounts under `/api/v1/apps/psm`). Public routes
  (`/auth/register`, `/auth/login`, `/auth/refresh`) are declared **before** `router.use(protectPsm)`.
- `server/app.js` — has a CSRF skip-list (public POST routes such as `/api/v1/apps/psm/auth/login`)
  and serves a small HTML page at `/apps/psm/billing/complete` (precedent, not needed here).
- `client/src/services/api.ts` — the website stores its identity token at
  `localStorage.accessToken` / `localStorage.refreshToken`; axios attaches it as Bearer.

> Do not assume line numbers; grep and confirm. Do not modify payments/Stripe logic.

## HTTP contract (psm depends on this — do not change field names)

### 1) `POST /api/v1/apps/psm/auth/authorize`  — auth: identity JWT (`protect`)
Request JSON:
```
{ "codeChallenge": "<base64url S256>", "codeChallengeMethod": "S256", "redirectUri": "<loopback url>" }
```
Behavior:
- Validate `redirectUri`: scheme `http`, host ∈ {`127.0.0.1`,`localhost`}, path exactly
  `/api/cloud/sso/callback`, any port. Reject otherwise → `400`.
- Require `codeChallengeMethod === "S256"` → else `400`.
- Mint an **auth code**: signed JWT with a new secret `JWT_APP_CODE_SECRET`, `expiresIn: "60s"`,
  claims: `{ userId, email, name, cc: codeChallenge, rd: sha256hex(redirectUri), jti: uuid, aud: "psm" }`.
Response `200`:
```
{ "success": true, "data": { "code": "<jwt>", "expiresIn": 60 } }
```

### 2) `POST /api/v1/apps/psm/auth/exchange`  — public (no auth; add to CSRF skip-list)
Request JSON:
```
{ "code": "<jwt>", "codeVerifier": "<random>", "redirectUri": "<same loopback url>",
  "device": { "id": "<uuid>", "name": "<host>", "platform": "<os arch>" } }
```
Behavior (all failures → `401` with a **generic** message, no oracles):
- `verifyAppAuthCode(code)` with `JWT_APP_CODE_SECRET` and `audience: "psm"`; expired/invalid → 401.
- `markUsed(jti)` → if `false` (replay) → 401.
- PKCE: `base64url(sha256(codeVerifier)) === cc` → else 401.
- Redirect binding: `sha256hex(redirectUri) === rd` → else 401.
- `User.findById(userId)`; missing/inactive → 401.
- `const result = await authResult(user, device);`  ← same helper password login uses.
- Audit-log the exchange (user id, device, ip) via `services/auditLog`.
Response `200` — **identical shape to `/apps/psm/auth/login`**:
```
{ "success": true, "data": { "user": {...}, "tokens": {...}, "entitlement": {...} } }
```

### 3) Client consent route `/authorize/psm` (React, in `client/`)
Reads query: `redirect_uri`, `state`, `code_challenge`, `code_challenge_method`.
- If not authenticated (no `localStorage.accessToken`), send through the normal login flow and
  return to this route afterward (preserve the query).
- Validate `redirect_uri` is loopback (defense-in-depth; server also validates).
- Render a **consent screen**: "Authorize **psm** to access your Werewolf Solutions account on
  this device?" with **Approve** / **Deny**.
- Approve → `POST /api/v1/apps/psm/auth/authorize` (Bearer identity token) with
  `{ codeChallenge: code_challenge, codeChallengeMethod: code_challenge_method || "S256",
  redirectUri: redirect_uri }` → then `window.location = \`${redirect_uri}?code=${code}&state=${state}\``.
- Deny → `window.location = \`${redirect_uri}?error=access_denied&state=${state}\``.

## Implementation checklist

1. `utils/jwt.js`: add and export `generateAppAuthCode(payload)` / `verifyAppAuthCode(token)`
   (HS256, `JWT_APP_CODE_SECRET`, 60s, `aud: "psm"`). Verify with `{ audience: "psm" }`.
2. `controllers/psmSsoController.js` (new): `authorizeApp` + `exchangeAppCode` as specified.
3. `routes/api/v1/psm.js`: add the two routes **before** `router.use(protectPsm)`:
   `router.post('/auth/authorize', protect, ctrl.authorizeApp)` and
   `router.post('/auth/exchange', ctrl.exchangeAppCode)`.
4. `server/app.js`: add `/api/v1/apps/psm/auth/exchange` to the CSRF skip-list. Confirm how CSRF
   is applied — if it only guards cookie sessions, the Bearer-authed `/authorize` needs no change;
   verify and handle correctly.
5. `client/`: add the `/authorize/psm` route + consent component, wired to the existing axios/api
   service.
6. Env: add `JWT_APP_CODE_SECRET` to config loading and `.env.example` (a strong random value in
   real envs). Fail fast at startup if missing in production.
7. Rate-limit both new endpoints (reuse the project's existing rate-limit middleware).

## Security requirements (must all hold — this is a payments/ERP backend)

- PKCE **S256 mandatory** (reject `plain`/missing). Codes single-use (`markUsed`) + 60s TTL +
  `aud:"psm"`. Dedicated `JWT_APP_CODE_SECRET` (never reuse the SSO/business or access secret).
- `redirect_uri` **loopback allowlist only**, and bound into the code (`rd` hash) so a stolen code
  can't be redirected elsewhere.
- Generic `401` messages for every verification failure. Never log codes, verifiers, or tokens.
- Minted session is the standard device-bound, revocable AppSession (via `issueSession`) — appears
  in Devices, refresh-rotated.
- Explicit user consent in the browser is required; a local process opening the authorize URL
  cannot mint a session without the logged-in user approving.

## Tests (follow the repo's existing test framework/layout)

Cover `authorizeApp` + `exchangeAppCode`: happy path; replay → 401; wrong/absent PKCE → 401;
expired code → 401; wrong `aud` → 401; non-loopback `redirect_uri` → 400; mismatched `rd` → 401;
unknown/inactive user → 401. Assert the happy path creates an `AppSession` row and that its token
works against `GET /api/v1/apps/psm/me`.

## Before you start / verification

- Work on a new branch. Run the existing server test suite first to confirm a green baseline.
- Grep to confirm every file/symbol referenced above (names, not line numbers).
- Manual e2e against local `:3000`: obtain an identity token via `POST /api/v1/auth/login`; call
  `/authorize` (Bearer) with a test PKCE pair + a loopback `redirect_uri`; call `/exchange` with the
  returned code + verifier; assert the `data` shape equals `/apps/psm/auth/login` and that
  `/apps/psm/me` works with `data.tokens.accessToken`. Confirm password login is unaffected.
- Report: the final endpoint list, the exact response JSON of `/exchange`, the new env var, and any
  deviation from this contract (so the psm side can be aligned).
