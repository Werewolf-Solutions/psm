# Design: hosted psm at `psm.werewolf.solutions`, with local projects still mapped

- **Status: SUPERSEDED (2026-08-12).** The shape below — a psm *server* on the internet,
  multi-tenant, with shell-out routes withheld from a hosted build — was built and then
  retired the same day, once the droplet's actual constraints were checked: 1 GB of RAM
  shared with dapp prod, staging, redis and nginx, and an ops doc that says it cannot run
  `npm ci`. **What shipped instead is the simpler thing this document itself describes in
  "Chosen shape": a hosted *page* and a local agent.** psm.werewolf.solutions is static
  files; the browser signs in against werewolf-dapp as a separate `psm-web` application and
  talks to `127.0.0.1` directly. There is no psm process on any server, so multi-tenancy,
  hosted auth and shell-out isolation all became moot rather than solved.
  Read `docs/deploy/PUBLISHING-A-NEW-APP.md` for what actually happens. This file is kept
  for the reasoning in "Why this shape" and the security review, both of which still hold.
- **Date:** 2026-08-11 (plan), 2026-08-12 (build)
- **Repos touched:** `psm` (this repo) + `werewolf-dapp` (auth) + deployment
- **Supersedes for the hosted case:** `docs/werewolf-sso-plan.md` (that plan's redirect_uri
  allowlist is *loopback only*, which a hosted origin breaks — see "Auth" below)

## Context / goal

Three things were asked for together, and they constrain each other:

1. psm must still **map local projects** — scanning every folder on the machine is the
   thing psm is actually for.
2. psm must be **production-ready and hosted** at `psm.werewolf.solutions`, behind
   werewolf-dapp auth.
3. Project pages must be addressed by **project id**, not folder name. *(Shipped in 0.1.2.)*

The collision is (1) against (2): **a page served from `psm.werewolf.solutions` cannot read
your disk.** The browser has no filesystem access, and the hosted server is in a datacentre
that has never seen `/home/oznerol/projects`. Anything that scans folders must run *on the
machine that has the folders*.

**Chosen shape (confirmed 2026-08-11): hosted UI + local agent on loopback.** The page is
served from `psm.werewolf.solutions`; the psm Node server keeps running on `127.0.0.1:4317`
as a **local agent**; the page talks to that agent directly from the browser. Project code,
logs, and AI output never leave the machine. The cockpit is fully functional while the agent
is running, and degrades to cloud-only data when it is not.

```
browser tab on https://psm.werewolf.solutions
   |
   |-- HTTPS --> hosted psm      account, billing, backups, cross-machine project map
   |             (werewolf-dapp auth; the only thing on the public internet)
   |
   `-- fetch --> http://127.0.0.1:4317   the local agent: scan, run, logs, AI, plans
                 (CORS-allowed for the hosted origin + paired with a token)
```

## Why this shape

- **Local stays local.** Source, logs, and model output never transit a server. That is the
  same promise the current localhost-only tool makes, and the reason the cockpit is trusted
  with `aiFullAccess`.
- **It reuses what exists.** The agent is today's `src/server/index.ts` — the scanner, proc
  registry, SSE log stream, and AI pane are unchanged.
- **The join key already exists.** Stable `prj_…` ids (0.1.1, `<project>/.psm/identity.json`)
  are what let a cloud row and a local folder name the same project across machines and
  renames. Without them this design has nothing to key on.

Known cost, accepted: **the page depends on the local agent for the cockpit.** On a phone, or
with the agent stopped, you get the cloud map and account surfaces but cannot run or tail
anything. The UI must say so plainly rather than appear broken.

## Work, in dependency order

### Phase 1 — the agent boundary (psm, local)

Today `src/server/index.ts` binds `127.0.0.1` and **rejects any non-loopback Host/Origin**
(README "Notes"). Serving a hosted origin means deliberately punching one hole in that, which
is the single most security-sensitive change in this plan.

1. **Pairing, not just CORS.** Generate an agent token on first run
   (`.psm-agent.json`, `0600`, gitignored). The hosted page cannot read it: the user pairs by
   copy-pasting it once, or by clicking a confirm prompt the agent shows locally. Every
   cross-origin request carries it as a bearer token; unpaired requests get 401.
   *Rationale: `Origin` is attacker-controllable outside the browser, so an origin allowlist
   alone means any process on the machine — or any page that guesses the port — reaches an
   API that runs shell commands.*
2. **CORS + Private Network Access.** Allow exactly `https://psm.werewolf.solutions` (plus
   `http://localhost:*` for development). Answer the PNA preflight
   (`Access-Control-Request-Private-Network`) that Chrome sends for public→private requests;
   without it the fetch fails before it is made.
3. **Keep the loopback UI.** `http://127.0.0.1:4317` keeps serving `web/` unauthenticated for
   local use. Hosted and local are two front ends over one agent.
4. **Agent identity.** The agent reports `{ agentId, hostname, platform, version, projects }`
   so the hosted side can name the machine — `deviceIdentity()` in `cloud.ts` already mints a
   stable device id; reuse it rather than inventing a second one.

### Phase 2 — auth (werewolf-dapp + psm)

The existing `docs/werewolf-sso-plan.md` designs PKCE with a **loopback** redirect_uri, which
a hosted app cannot use. Hosted psm is an ordinary first-party web app on a sibling subdomain,
so it is simpler, not harder:

1. **Session on `psm.werewolf.solutions`.** Same identity provider as werewolf.solutions.
   Cheapest correct option: issue the identity cookie on `.werewolf.solutions` (parent domain)
   so the sibling subdomain is signed in already; otherwise a standard OAuth code flow with
   `redirect_uri: https://psm.werewolf.solutions/auth/callback` added to the allowlist.
2. **Keep the loopback PKCE plan for the agent.** The agent still needs its own device-bound
   AppSession for backups/sync — that is exactly what the existing plan builds, unchanged.
3. **Do not reuse `JWT_APP_CODE_SECRET`** for the hosted flow; a hosted redirect and a loopback
   redirect should not be interchangeable in a signed code.
4. **Authorize every hosted route.** The current server assumes "if you can reach it, it's
   yours" — true on loopback, false on the internet. Every hosted endpoint needs the user id
   from the session, and every cloud row needs an owner column checked on read *and* write.

### Phase 3 — production readiness (psm)

The current server is a single-user local tool. Hosting it needs, at minimum:

- **Multi-tenancy.** `overrides.json`, `.psm-plans/`, `.psm-sessions.json`, and
  `.psm-catalog.json` are process-global files. Hosted, they must be per-account rows keyed by
  `(userId, projectId)`. This is the largest single piece of work in the plan.
- **Nothing that shells out, hosted.** `procs.ts` and `ai.ts` run commands. They must exist
  only in the agent, and the hosted build must not expose them at all — not "guarded by a
  flag", *absent*, so a routing mistake cannot reach them.
- **Rate limiting, CSRF, audit logging** on hosted mutations; werewolf-dapp's existing
  middleware is the reference.
- **Secrets** out of the repo root: no `overrides.json`-style plaintext state on the server.
- **CI.** psm has no `.github/` at all. Port werewolf-dapp's `check-version.mjs` gate plus
  typecheck/test on push before anything is deployed.
- **Static UI build.** `web/` is unbuilt vanilla JS served from disk; hosted it needs
  fingerprinted assets and a CDN-cacheable index, and `__APP_VERSION__`-style injection would
  then replace the `/api/projects` version field (see README "Versioning").

### Phase 4 — the cross-machine map (the payoff)

With ids and an agent in place: each agent pushes a **project index** (id, name, status, git
branch, last activity — metadata only, never contents) for its machine. Hosted psm then shows
every project you own across every machine, marks which agent is online, and deep-links
`#/p/<prj_id>` to whichever agent has it. This is the "scans all the projects you have and
maps them" outcome, and it only works because the id is minted in the folder and travels with
the repo.

## Security review (must hold before hosting)

- The agent runs shell commands. Its cross-origin surface is the highest-value target in the
  workspace; **pairing token + strict origin allowlist + no wildcard CORS**, and it stays bound
  to `127.0.0.1` (never `0.0.0.0`).
- Hosted psm must never receive project source, logs, or AI output — only the metadata index.
  State this as an invariant and test it, because it is easy to erode one convenience at a time.
- Every hosted read and write is owner-checked; a project id is a **capability-free
  identifier**, not a secret, and must never be the only thing authorizing access. (It is
  displayed on cards and copyable by design.)
- `aiFullAccess` must remain a local-only setting. A hosted toggle that grants full filesystem
  access to an agent is a remote-code-execution feature.

## Verification

- Agent: unit-test the pairing guard (missing token → 401, wrong origin → blocked, PNA
  preflight answered). Manual: load the hosted page against a local agent, confirm cockpit
  panes work; stop the agent, confirm the UI degrades with a clear message rather than errors.
- Auth: sign in at werewolf.solutions, open psm.werewolf.solutions, confirm no second login;
  confirm sign-out propagates; confirm the agent's own AppSession still appears in Devices.
- Multi-tenancy: two accounts, same project id on two machines, confirm no cross-read.

## Open questions

1. ~~**Pairing UX**~~ — resolved 2026-08-12: copy-paste a token. The agent shows it in the
   local cockpit's **Folders** panel (reveal / copy / rotate). A confirm dialog needs the
   agent to own a window, which a headless agent does not have.
2. **Does hosted psm need to work with no agent at all** (phone use), or is "agent offline"
   an acceptable dead end for the cockpit panes?
3. **Which machine wins** when two agents report the same project id (same repo cloned twice)?
   Proposal: both, listed per agent, with the id naming the *project* and the agent naming the
   *checkout*.

## Where this stands (2026-08-12)

Built, with tests:

- **Modes** (`src/mode.ts`) — `dev` / `agent` / `hosted`, chosen by `PSM_MODE`, with
  capability predicates the server branches on rather than mode-string comparisons.
- **Linked sources** (`src/links.ts`) — the plan assumed one `workspaceRoot`; a psm that is
  pointed at a machine from elsewhere needs to be *told* what to look at, so a source is now
  a link of kind `workspace` (a directory of projects) or `project` (one folder). Dev keeps
  the configured root as an implicit, unremovable link, so existing installs are unchanged.
  Name collisions across sources are qualified rather than merged — the project name keys
  overrides and AI sessions, so a merge would be a data corruption.
- **Phase 1, the agent boundary** (`src/server/agent.ts`) — pairing token in
  `.psm-agent.json` (0600), strict origin allowlist, PNA preflight, loopback unchanged and
  unauthenticated. 14 tests including near-miss origins (`…werewolf.solutions.evil.com`).
- **Phase 3, "nothing that shells out, hosted"** — the shell-out routes moved to a router
  mounted only when `isLocal()`. `src/server/hosted.test.ts` boots a real hosted server and
  asserts they 404.
- **Phase 3, multi-tenancy** (`src/store.ts`) — state paths resolve per account via
  AsyncLocalStorage carrying the verified session subject. Hashed directory names, so an
  exotic user id cannot traverse.
- **Phase 2, in full for password sign-in** (`src/server/session.ts`, `src/server/auth.ts`) —
  dapp already exposed psm's own endpoints (`/apps/psm/auth/{register,login,refresh,logout}`,
  `/apps/psm/me`), so no dapp change was needed after all: psm signs people in against them
  directly, as the confidential client. The browser gets an httpOnly cookie holding an opaque
  session id; dapp's rotating refresh token never leaves the server. Bearer tokens are
  validated by calling `/apps/psm/me` rather than by holding dapp's signing secret, which also
  honours revocation. JWKS/shared-secret verification remains for provider-minted tokens and is
  tried first when configured. Fails closed with 503 when no strategy is configured at all.
- **Deployment** — `Dockerfile` (hosted only; the agent is deliberately not containerised),
  `.env.example`, and a CI workflow running typecheck plus tests.

- **Phase 2's redirect flow** (`src/server/sso.ts`, built 2026-08-12) — "Sign in with
  Werewolf" as the full-page PKCE handoff todo-app uses, implemented per
  `docs/werewolf-sso-plan.md`. The verifier is minted and kept server-side keyed by `state`,
  so unlike todo-app nothing sensitive reaches the page. Local instances use the loopback
  callback dapp's native registration already allows on any port.

Not built / blocked:

- **The `psm` CloudApplication record on production.** Local dev has it (dapp's
  `npm run bootstrap:psm` creates it), and the redirect flow was driven end to end against
  a local dapp on 2026-08-12 — consent screen, approval, code exchange, session, replay
  refused. Production answered `503 app_not_configured` on the same date and is running an
  current there — the row simply has not been bootstrapped. See
  `docs/werewolf-psm-registration.md`, which also covers the choice hosted psm forces: a
  `native` client cannot accept an https callback, so the hosted front end needs either its
  own application row or a widened rule.
- **Phase 4, the cross-machine index.** Agents do not yet push a project index, so hosted psm
  has no projects of its own — it authenticates, serves the UI, and says so plainly.
- **Static UI build.** `web/` is still unfingerprinted vanilla JS served from disk.
- **Rate limiting, CSRF, audit logging** on hosted mutations. There are no hosted mutations
  yet beyond cloud passthrough, but they arrive with phase 4.
