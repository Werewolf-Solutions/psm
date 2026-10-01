# Workspace integration: implementation status

> **Historical evidence as of 2026-09-21.** The findings and delivery states below
> describe that review, not the current deployment. Todo has since completed a
> successful managed 0.6.0 release on 2026-09-29. Use the
> [delivery index](README.md) and [Todo staging status](../deploy/TODO-STAGING.md)
> for current progress. The successful static release alone does not reverify
> the cross-workspace/browser regressions recorded here.

Last verified: **2026-09-21**, by Claude Code (Opus 5), working
[workspace-focused-followup.md](workspace-focused-followup.md).

Everything below was observed in this workspace on that date. Where something was not
checked, it says so rather than inheriting a claim from an earlier document.

**This supersedes the previous version of this file, which was wrong in three places** and
is corrected here rather than quietly re-worded:

- It said an interrupted transfer "is finished by the next authorised attempt". It was not:
  the next attempt had to be a *reverse* transfer from wherever the container had got to.
  An identical retry of the original request returned 404. See regression 3.
- It said "a concurrent write during a transfer cannot strand a task". The test behind that
  claim created the task *before* calling the API and then called `settle()` by hand before
  asserting. A genuine interleaved creation was stranded. See regression 2.
- It said the host target "is not enrolled" and that the GitHub account "could not create"
  the control repository. The target **is** enrolled (fingerprint and revision below); what
  is stale is the host connection's allowed root *prefix*. And the account is an **org
  admin** with `repo` scope — repository creation was never the thing standing in the way.

## Modified / committed / pushed / deployed

Four different things, never merged here.

| Repository | Branch | Version | State |
| --- | --- | --- | --- |
| werewolf-dapp | `dev` | 0.5.1 → **0.5.4** | **Modified in the working tree. Not committed, not pushed, not deployed.** |
| todo-app | `master` | 0.5.2 → **0.6.0** | **Modified in the working tree.** Not committed, not pushed, not deployed. Untouched by this round. |
| psm | `dev` | 0.2.8 → **0.3.2** | **Modified in the working tree**, alongside the user's own uncommitted work. Not committed, not pushed. |

**Nothing was committed, pushed or deployed.** In psm the workspace changes and the user's
pre-existing uncommitted work share files (`README.md`, `src/server/index.ts`, `web/app.js`,
`web/index.html`, `web/styles.css`), so there is no commit that takes one without sweeping
up the other; that is the user's to split. In werewolf-dapp and todo-app no commit was
asked for and these are the user's own checkouts.

**Deployed, and unchanged by this work:** `staging.werewolf.solutions` serves werewolf-dapp
**0.5.1** (read from the version string in its served main bundle, 2026-09-21).
**All three regressions below are therefore live on staging right now.** 0.5.3 is a working
tree, nothing more. `todo.werewolf.solutions` still has no DNS record and has never been
deployed.

---

# The three regressions

Each was reproduced with a failing test **before** any fix. The tests live in
`werewolf-dapp/server/test/integration/todoTransferSafety.test.js` (new, 16 tests). Against
the old code **11 of the first 15 failed**; the other four are guards that were already
satisfied and are kept so they stay that way. The sixteenth covers an edge found while
reviewing the fix, and was confirmed to fail without it.

## 1. Recovery ran before authorization, so a refusal had already written

**Reproduced.** `transferWeek` called `settle('week', …)` at line 202 and only checked
`mayMoveAll` at line 210. `transferPeriod` settled before its ownership check too. A week of
business A holding a task that an earlier torn move had left stamped business B: Erin, a
member of both and neither the week's creator nor an admin of A, POSTs `/transfers` in A
targeting B. **Response 403 — and the task had already changed from B/team to A/private.**

A second, sharper case: Hank *is* an admin of A and a member of B, so the week is genuinely
his to move. The stray row is Alice's and it sits in B, where Hank is an ordinary member. The
old code moved it anyway — the row's parent link was treated as authority over the row.
**That returned 200.**

**Fixed** in `server/services/todoTransfer.js`, by ordering rather than by moving one check:

1. authorize the target from current membership
2. find the container — in the source, or as an unfinished move out of it
3. read the children by their link to it
4. authorize: the unit is the caller's, every part of it is somewhere they have authority,
   and the target has no clash
5. take the container's lock — 6. re-read and re-authorize under it — 7. write — 8. adopt
   stragglers — 9. release

Steps 1–4 write nothing at all. **There is no repair pass any more.** Children are selected
by their link (an id a transfer never changes) and every one of them is restamped to the
target wherever it currently sits, so a torn unit is repaired *by the authorized move* rather
than by a separate privileged write before the decision.

`residencyProblem` is the second half: a child stamped with a third workspace is only moved
out of there if the caller may write there **now** — their own row needs `member`, someone
else's needs `admin`. A row with no business sits in its owner's personal workspace and
nobody else has any authority there at all.

**Covered:** week and period; non-owner member, admin-without-authority-in-the-third-
workspace, viewer, revoked member; ownership refusal, clash refusal. Every refusal asserts a
full before/after snapshot — including `updatedAt`, because a write that put a row back
where it found it is still a write. Lock bookkeeping uses `timestamps: false` for the same
reason.

## 2. A creation landing mid-transfer was stranded

**Reproduced.** `TodoWeek.updateOne` is intercepted immediately before the container write,
after the service has chosen its children. Gina's own authorized `POST /tasks` runs to
completion on the held barrier, then the update is released. **Response 200, and the task
stayed personal while its week and day moved to B** — a child pointing at a day in another
workspace.

Transactions do not help here even where they exist: Mongo takes no predicate locks, so an
insert from outside the transaction still lands. A second scan is not a synchronization
protocol either — the next writer can always arrive after it.

**Fixed** with a small lock on the container, `server/lib/todo/transferLock.js`, plus a
`transfer` subdocument on `TodoWeek` and `TodoPeriod`:

- A transfer takes the lock (atomic compare-and-set) before it reads its children.
- Every write that attaches a child refuses with **409** while it is held: `createTask`,
  `scheduleBacklogTask`, `transferDayTasks`, `updateTask` when it re-homes a task,
  `deleteWeek`, `createObjective`, `createKeyResult`.
- Those writers also **re-check afterwards** that the container did not move under them —
  that is the half that actually closes the race. `createTask` undoes its insert and answers
  409 (nothing was promised to the client yet); the re-homing paths call
  `settle(kind, id, { only: [...] })` so their own rows end up with their container rather
  than across a boundary, and answer 409.
- After the writes the transfer adopts anything a pre-lock writer left behind, restricted to
  rows stamped with the **authorized source** — a row in some third workspace is left alone
  and reported as `strayElsewhere`, never silently swept up.

**Covered by barrier tests, not by hope:** a real interleaved `POST /tasks`; two simultaneous
transfers of the same week (the second gets 409 and the first's requested audience is the one
that applied); a re-home and a delete interleaved with a transfer. Each asserts the invariant
directly on the operation's own result, with no repair in between.

The old test in `todoWorkspaces.test.js` that called `settle()` before asserting has been
rewritten to assert the postcondition of the public operation and to say, in the file, that
the interleaving case belongs in the barrier suite.

## 3. An identical retry could not finish a partial transfer

**Reproduced.** Gina's personal week, failure injected on the first `TodoDay.updateMany`:
the week moves into B, its days and tasks stay personal, the request returns 500. Repeating
**the identical request** — personal source, same id, target B — returned **404**, because the
week is no longer in the workspace the request names. The old recovery test avoided this by
issuing a *reverse* transfer from B back to personal, which is not a retry and which a client
that just got a 500 has no way to know to do.

**Fixed** by giving the operation an identity. The lock is left behind on failure, marked
`failed`, recording who was moving what, from where, to where. The identical request finds
it, **re-authorizes from scratch against current membership**, and finishes the move.

- A request naming a **different target** does not match and is refused 409 rather than
  blended into the unfinished one.
- A caller who has since **lost access** to either end is refused 403, and the refusal writes
  nothing. Resuming is not a replay past revoked permissions.
- Repeating a transfer that **already succeeded** is a 404 — it genuinely is not in the
  workspace the request names any more.
- `running` vs `failed` is what separates a retry from a duplicate. Two concurrent identical
  requests are not both let through; a repeat after a 500 is.
- A run abandoned by a process that died expires after `TODO_TRANSFER_LOCK_TTL_MS`
  (default 30s), after which ordinary work resumes and another authorized caller may take the
  same operation over. A `failed` lock does not bar ordinary writes at all.
- **A resumed run that is itself refused keeps the record.** Found while reviewing the fix:
  if a resume took the lock and the re-check under it then refused, releasing the lock would
  have discarded the only thing that lets the *next* identical request find a week that is no
  longer in the workspace it names — turning a recoverable tear into a permanent one. A
  resumed run is marked `failed` again instead of released. The regression test drives it with
  a barrier on the lock acquisition and fails without the fix.

**Covered:** an identical retry after a failure injected at *each* of the three write
boundaries (container, days, tasks); target hijack; membership revoked between failure and
retry; duplicate retry after success.

**The honest limitation.** Between the failure and the retry the board is genuinely split —
the container has moved and its contents have not — so writes to it are refused from **both**
workspaces rather than landing in the wrong one. That is the price of stopping in the
direction that exposes nothing, and a test states it as the expected behaviour rather than
papering over it. The owner's other boards are unaffected, and the retry puts it back
together. Standalone transfer is **not** disabled; it is resumable.

## What the response now carries

`{ kind, id, days, tasks, detachedLineage, atomic, resumed, recovered, strayElsewhere }`.
`resumed` says an unfinished run was recognised; `recovered` counts documents that were not
where the source said they would be (the container included); `strayElsewhere` is the
anomaly counter that makes a foreign row visible instead of silent.

Documented for consumers in `werewolf-dapp/docs/20-workspaces.md`, new section
"Moving work between workspaces".

---

# Test and build evidence

Every number is from a run on 2026-09-21, not a recollection.

| What | Command | Result |
| --- | --- | --- |
| New regression suite, **against the unfixed code** | `node --test test/integration/todoTransferSafety.test.js` | **11 fail / 4 pass** — the three bugs, reproduced |
| New regression suite, after the fix | same | **16 pass, 0 fail** |
| dapp server, standalone mongo | `cd server && npm test` | **661 pass, 0 fail** |
| dapp server, single-node replica set on :27099 | same, `MONGODB_URI_TEST` → that rs | **661 pass, 0 fail** |
| dapp client | `cd client && npm test` | **49 pass** (6 files) |
| dapp client types | `npx tsc -b --noEmit` | clean |
| dapp version gate self-test | `npm run test:version` | **27 pass** |
| dapp version gate | `npm run check:version` | OK, 0.1.4 → 0.5.3 |
| psm | `npm test` | **534 pass, 0 fail** |
| psm types | `npm run typecheck` | clean |
| todo-app | `npm test` | **11 pass, 0 fail** |
| todo client types | `npx tsc -b --noEmit` | clean |
| todo production build | `npm run build` | built, 266 kB main bundle |

Baseline before this round: dapp 645. The 16 new tests are the whole difference; no existing
test was deleted, and the two that were rewritten (the retry test and the concurrency test in
`todoWorkspaces.test.js`) are stricter than before, not weaker.

**Both deployment shapes were exercised.** The transaction-capable path ran against a
disposable single-node replica set started on port 27099 from a temporary directory and shut
down afterwards; `supportsTransactions()` returned `true` there and `Single`/`false` against
the machine's own standalone mongod. **The machine's MongoDB was not reconfigured.**

The version gate was **not** weakened: `scripts/check-version.mjs` is unchanged and its own
self-test passes. 0.5.2 was never committed or released, so 0.5.3 is this round's Z bump on
top of it.

---

# Browser verification

**Real browser, not an HTTP 200.** Playwright 1.61.0 driving the Chromium already in
`~/.cache/ms-playwright/chromium-1140`, headless, against a full local stack:

| Piece | Where | Data |
| --- | --- | --- |
| werewolf-dapp API | `localhost:3000` | **disposable database `werewolf-browsercheck`**, dropped afterwards |
| werewolf-dapp portal | `localhost:5174` | the user's own dev server on 5173 was left alone |
| todo-app board | `localhost:5200` | the port its callback is registered for |
| psm cockpit | `localhost:4318` | a second instance; the user's own on 4317 was left alone, and every `PSM_*` state file was redirected to a temp directory |

Two disposable accounts (`ada@`, `bo@browsercheck.test`) and three businesses that exist
nowhere else. **No real account or customer data was touched**, and the server ran with its
own `.env` in a scratch directory so the repository's `.env` — which holds live Stripe and
provider keys — was never loaded.

Evidence: 40 screenshots and the scenario reports in
`~/werewolf-browser-evidence-2026-09-21/` (`shots/`, `report-*.json`, and the scripts that
produced them). Delete it when it has served its purpose.

| # | Scenario | Expected | Actual | |
| --- | --- | --- | --- | --- |
| 1 | Sign-in and business selection | dashboard, owned business in the header | `/dashboard`, header "Alpha Works", greets Ada | pass |
| 2 | Business creation | created through the real modal and listed | "Gamma Test Co" created (logo upload, name, industry, email, phone), list went 1 → 2 businesses | pass |
| 3 | Launcher deep links | workspace ref only, no credential | `…/?workspace=personal` and `…/?workspace=business%3A<id>` for both Todo and PSM; no token/code/secret in any of them | pass |
| 4 | Todo opens where the link said | switcher reads that business | switcher `business:<id>`; the query is removed from the address bar after it is taken | pass |
| 5 | Task creation on a business board | task appears | "ALPHA shared task" on the board | pass |
| 6 | Workspace switching | the two boards do not mix | personal board has the personal task and not the business one; switching back reverses it exactly | pass |
| 7 | Two users, two businesses | only what you belong to | Bo sees Personal, Alpha Works (member), Beta Labs (owner) — **not** Ada's Gamma Test Co | pass |
| 8 | Isolation | shared yes, private never | Bo sees "ALPHA shared task"; never "ADA private task". His own Beta Labs board shows neither | pass |
| 9 | Viewer restrictions | marked read-only, write refused | read-only wording present; the typed task did not appear | pass |
| 10 | Revoked access | gone immediately | Alpha Works vanished from Bo's launcher; a direct deep link to it opened no board | pass |
| 11 | Failed membership load | visible, and **no** silent personal board | with `/apps/todo/workspaces` forced to 500 the app showed an error and a "Try again", and rendered no board at all | pass |
| 12 | Transfer, confirmed in the browser | the move is what the UI then shows | after the API transfer, the week is gone from the personal board and present on the business board | pass |
| 13 | PSM cockpit | runs, offers workspace selection | loads over loopback; `GET /api/cloud/workspaces` 200; selector lists Personal | pass |
| 14 | PSM project assignment | accepted and reported back | `PUT …/workspaces/projects/browsercheck-widget {ref:"personal"}` → 200 `{from:"personal", workspace:"personal", cloudDataMoved:false}` | pass |
| 15 | PSM business assignment with no cloud session | fails closed | 401 "Sign in with Werewolf to use a business workspace" | pass |

**Transfer UX: there is none, and that is deliberate.** The Todo client was searched for any
control matching move/transfer wording — none exists, which matches what `todo-app/CLAUDE.md`
and `docs/20-workspaces.md` already say. Transfers were therefore exercised through the API
against this running stack, and the *result* confirmed in the browser (#12). Two live API
checks worth recording:

- Ada moves her personal week to a business: **200**, week + 7 days + 1 task all arrive, her
  own row takes the `team` audience she asked for, and the lock is cleared to `null`.
- Bo, revoked from Alpha Works, tries to move a week out of it: **403**, and the full
  before/after placement is byte-identical. The refusal wrote nothing, on the running stack.

**Console and network.** The only recurring console errors across every context are Google
Sign-In complaining that `localhost:5174` is not an allowed origin for the client ID (an
artefact of running the portal on a non-registered dev port), and the expected 401/403/404s
from unauthenticated probes and refused requests. No 5xx and no page errors in any scenario.

## Two findings the browser work turned up

Both are **pre-existing, committed, outside this round's scope, and not fixed here.**

### A. PSM cloud sign-in is blocked twice over

`psm/docs/werewolf-psm-registration.md` (2026-08-17) says the `psm` CloudApplication row must
be `clientType: 'web'` with an exact redirect-URI list, and names werewolf-dapp as the repo
that owes it. **`werewolf-dapp/server/scripts/bootstrap-psm-cloud.js:68` still writes
`clientType: 'native'` with no `redirectUris`** — unmodified committed state. The cockpit
refuses sign-in with a sentence naming exactly that, which is good behaviour.

With the row corrected in the disposable database per that document, a **second** problem
appears, and it is the one nobody has written down yet:

```
POST /apps/psm/auth/authorize  → 200
POST /apps/psm/auth/exchange   → 401
```

The cause was isolated by replaying the same authorize+exchange three times, changing only
one header:

| `Origin` on the exchange | Result |
| --- | --- |
| absent — **what the psm agent actually sends** | **401** |
| `http://localhost:4318` (a registered callback origin) | **200** |
| `http://evil.example` | 401 — the check itself is working |

`server/utils/appSessionCookie.js:55` `isOriginAllowed` returns `false` for an empty Origin
whenever the application uses the refresh cookie, and psm's code exchange is made
**server-side** by the local agent (`psm/src/server/session.ts:89`, a plain `fetch` that sets
only `Content-Type`). A server-to-server request sends no Origin, so it can never pass.

Which side should change is a real design question — whether `Origin` should be load-bearing
for a confidential server-side client at all — so it is reported rather than patched.

### B. A viewer is offered inputs that cannot work

On a read-only business board the client still renders all seven "+ add" textareas. The
server correctly refuses the write and nothing lands, so this is cosmetic, not a security
gap — but a viewer can type a task and watch it vanish.

---

# Staging

Targets: Todo staging `https://todo.werewolf.solutions`, identity/API
`https://staging.werewolf.solutions`. **No production change was made, nothing was deployed,
no DNS or host state was written, and no paid resource was created.**

## Re-verified now, not carried forward

| Check | How | Result |
| --- | --- | --- |
| `todo.werewolf.solutions` | `getent hosts` | **no record** |
| `staging.werewolf.solutions` | `getent hosts`, HTTPS GET | 46.101.29.222, **200** |
| `werewolf.solutions`, `psm.werewolf.solutions` | `getent hosts` | the same address — so **the address alone is not host identity**, and was not treated as such |
| Staging dapp version | version string in the served main bundle | **0.5.1** |
| Manifest dependency `werewolf-api` | GET staging `/api/v1/health` | 200, as declared |
| Manifest dependency `todo-api` | GET staging `/api/v1/apps/todo/board` | 401, as declared |
| Manifest dependency `todo-sign-in` | GET staging todo `/public?redirectUri=…` | 200, `redirectAllowed: true` for the exact callback |
| `.psm/deployments.json` | PSM's own `loadDeploymentManifest` | **valid** — `prj_e471…`, one environment, `staging` (risk `staging`) |
| Artifact pipeline | `prepare-static-artifact.mjs environment` + `prepare`, twice | builds and packages; **byte-identical `archiveDigest` on both runs** (`sha256:bd5d4be7…`); `version.json` carries 0.6.0 and the commit |
| `Werewolf-Solutions/deployment-control` | `gh repo list` over **all 26 org repos including private** | **does not exist** — an authoritative listing, not a failed lookup |

## Completed here

- **The release controller's action pin is resolved and reviewed**, which the follow-up asked
  for and the controller README had deliberately left blank. `release-static.yml` now pins
  `actions/create-github-app-token` to
  `bcd2ba49218906704ab6c1aa796996da409d3eb1` (v3.2.0, published 2026-05-12, **signature
  verified**), resolved through the git-ref API rather than guessed. The README records the
  review: v3.0.0's two breaking changes are proxy handling (this workflow sets no proxy) and a
  self-hosted runner floor (both jobs are `runs-on: ubuntu-latest`), so neither reaches it;
  and the v2.2.2 SHA is recorded too, in case the user prefers to stay on v2.
  **The four remaining `REPLACE_…` values are all enrollment-derived** (contract revision,
  droplet hostname, deploy account, host key fingerprint) and were **not** invented.
- Manifest, dependency probes and the artifact pipeline re-verified against the current tree,
  including reproducibility.

## What PSM itself says is left

Read-only inspection of the running local agent — `GET /api/connections`,
`/api/deployment-targets`, `/api/projects/prj_e471…/deployments/staging`. This **corrects**
the previous status document:

- **The host target is enrolled.** `werewolf:todo-staging-web` exists with
  `fingerprint: sha256:cc2889cf…`, `revision: todo-staging-v1`, root
  `/var/www/todo.werewolf.solutions`, on `46.101.29.222` as `psm-infra`. All three
  connections (DNS, GitHub, SSH host helper) are bound with no missing secret slots.
- PSM reports exactly **two** blockers, and `canPrepare: false`:

| Blocker | PSM's own message |
| --- | --- |
| `connection:host` / `connection-missing` | "target root is not within an allowed component-aware prefix" |
| `release-controller:web` / `release-controller-unpinned` | "The github connection has no reviewed release workflow for `werewolf:todo-staging-web`. PSM pins it once it can read the release repository." |

The first is precise: the host connection's `allowedTargetRootPrefixes` is still
`["/var/www/a6s1j3p3zh.werewolf.solutions"]` — the superseded generated hostname — while the
manifest and the enrolled target both say `/var/www/todo.werewolf.solutions`. That is why
`directory`, `ingress` and `certificate` all report "differs from the target contract". DNS
reports `state: create`, which is correct: the manifest's `digitalocean-dns-record@1` creates
the A record as part of a release, so it must **not** be made by hand first.

## The smallest remaining operator actions

Two, and both are the user's to authorize because both expand authority:

1. **Widen the host connection's allowed root prefix** to `/var/www/todo.werewolf.solutions`
   (connection `con_67802210-4432-4790-847b-4edaedd9cea5`). This is a local PSM change, but it
   widens what a live-droplet SSH credential may touch, so it was not done unasked.
2. **Create `Werewolf-Solutions/deployment-control`** from `psm/docs/deploy/controller/`, then
   register and install the GitHub App and add a GitHub Environment named `todo-staging-web`
   holding `PSM_TARGET_SSH_PRIVATE_KEY` and `PSM_TARGET_KNOWN_HOSTS`. The signed-in account
   **is** an org admin (`role: admin, state: active`) and holds `repo`, so **creating the
   repository is within its authority** — the earlier "no `admin:org`, so it could not" was
   wrong, and `admin:org` is not what repository creation needs anyway. Creating a repository
   in the organization is still an organization change, so it waits for a yes. Registering and
   installing the App is a web-UI action in any case and cannot be done from here.

Once both are done PSM pins the controller, `canPrepare` becomes true, and the release itself
creates the DNS record, the directory, the nginx vhost and the certificate in dependency
order, with rollback, through the path the system was built for.

## Still not done, and not claimed

- **No authenticated call against staging.** Every path under `/api/v1/apps/todo/` answers
  401 unauthenticated, *including paths that do not exist*, so a 401 from `/workspaces` is
  not evidence the route is deployed, and was not treated as such.
- **No staging database was inspected.** No staging credentials exist in this checkout, so
  `migrate-todo-workspaces.js` has not been run there even in read-only report mode. Run it,
  and take a backup, before `--apply`.
- **No browser session against staging or production.** The browser work above is entirely
  local and disposable. Nothing was clicked against a real environment.
- **Deploying 0.5.3 to staging was not attempted.** It would restart the shared droplet's
  dapp process, which handles live Stripe, and is out of bounds without explicit approval.
  Until it happens, staging keeps all three regressions.
- ~~PSM's business-workspace project assignment could not be exercised end to end, because
  cloud sign-in is blocked by finding A.~~ **Resolved 2026-09-21** — see *Cloud sign-in*
  below. Sign-in now works in a browser against a local dapp, and the business branch was
  exercised: `GET /api/cloud/workspaces` listed the signed-in user's business with
  `role: owner`, and `PUT /api/cloud/workspaces/selected` switched to it.

## Nothing was disturbed

The user's dev servers on 5173 and 4317 were left running and untouched. The disposable
database was dropped; `werewolf-solutions` and every `werewolf-test-*` database is as it was.
No `.psm/identity.json` was written into any real project — the only project assigned was a
throwaway one in a temp directory, and personal assignment writes no identity file at all.
The user's `psm/.psm-agent.json` and `.psm-links.json` still carry their August dates.
todo-app's working tree is at the same 10 dirty paths it started with; psm's at 38.

**This round (cloud sign-in, 2026-09-21)** disturbed nothing either. The user's dev servers
on 5173 and 4317 were left running: the disposable dapp API, its Vite client and a second
psm agent ran on 3999, 5199 and 4321 and were stopped by port, and only those. The
disposable database `psm-login-verify-disposable` was dropped; the dev database's `psm` row
still reads `updatedAt: 2026-08-17`, which is also proof the bootstrap scripts wrote nothing
there. No Stripe call was made. `server/services/psmCloud.js` is unmodified.

# Cloud sign-in (added 2026-09-21)

The blocker recorded above as "finding A" was **two** bugs, in two repositories. Both are
fixed in the working tree; neither is committed, pushed or deployed.

## 1. Registration drift — werewolf-dapp

`server/scripts/bootstrap-psm-cloud.js` upserted psm's whole `CloudApplication` row on its
way to provisioning Stripe prices, including `clientType: 'native'` and its own scope list.
`npm run bootstrap:psm` pointed at **that** script, so the obvious response to a broken
login re-broke it: psm's page signs in as a `web` client and refuses a `native` row, because
a native row hands a browser its refresh token in the response body.

The desired shape now lives in one pure module and the scripts are split by subject:

| Command (`werewolf-dapp/server`) | Writes | Stripe? |
|---|---|---|
| `npm run repair:psm` | nothing, without `--apply` | no |
| `npm run bootstrap:psm` | identity only | no |
| `npm run bootstrap:psm-billing` | `stripe.*` + paid storage limits only | yes |

`repair-psm-registration.js` reports by default, preserves the publishing business, all
`stripe.*` fields, device limits and any scope it did not add, requires an explicit
`PSM_BUSINESS_ID` to *create* a row, and registers exact per-environment callbacks with no
wildcard. `bootstrap-psm-cloud.js` no longer upserts and now refuses to run until the
identity row exists — billing depends on identity, never the reverse.

## 2. The agent sent no `Origin` — psm

dapp pins a web client's cookie endpoints to an origin in the row's `redirectUris`
(`isOriginAllowed`), because those endpoints return a bearer token. A browser sets that
header; psm's agent is a server and sent none, and an absent Origin is not an allowed one —
so the exchange answered **401** and every refresh **403**.

**dapp's check is unchanged and still rejects a missing or foreign Origin.** psm now derives
the header from the callback the sign-in actually used, after checking it is the callback
this psm issues, and retains it on the in-memory session for refresh and logout. PKCE, the
single-use code, the exact redirect binding and the cookie's isolation are all untouched.

## Evidence

Browser, against a local dapp with a disposable account and its own database (dropped
afterwards): cockpit → consent screen at `/authorize?…&code_challenge_method=S256` →
approve → `/auth/callback` → signed in; then the business-workspace calls above.

The refresh half cannot be reached in a browser inside a test window — dapp's app access
token lives fifteen minutes — so it was driven through psm's **real** `session.ts` against
the **running** dapp: exchange succeeded, a genuine refresh with the retained origin
succeeded, and the same refresh with no origin was refused.

| Suite | Result |
|---|---|
| `cd psm && npm test` | 540 pass |
| `cd psm && npm run typecheck` | clean |
| `cd werewolf-dapp/server && npm test` | 687 pass |
| Reverting `appOrigin()` alone | 7 psm tests fail |

## Not verified

- **Production.** It still has no `CloudApplication` rows at all. Registering it is a script
  run against the production database, which was not done and needs a decision about which
  business publishes psm.
- **psm behind a proxy** (`PSM_PUBLIC_ORIGIN` set) — covered by unit tests, not by a browser.
- **The hosted page posture** (`psm.werewolf.solutions`), which depends on production.

This work does **not** touch the transfer lock-expiry race, which remains open and
out of scope. None of it is deployed, so **nothing here makes the release ready**.

# Host, DNS and staging DB (added 2026-09-21, later the same day)

Four things were investigated against the live droplet with the privileged
`DO_SSH_*` account. Host key checked against psm's enrolled fingerprint first:
`SHA256:dOuQrjCMszNHv3XdjsqWoz/SHsEhtCI4o9BvjcMCNJU`, matching both psm's
connection record and `deployment-control/todo-staging.known_hosts`.

## The staging index migration is a no-op — that blocker does not exist

Run on the droplet, in the app's own directory, report mode, **no `--apply`**:

```
Database: 'werewolf-app'-staging  mode: report only
todoweeks/tododays/todotasks/todonotes/todoperiods/todoobjectives/todokeyresults:
  0 rows, 0 personal/legacy, 0 in a business
todoweeks indexes:   drop: (none)  create: (none — already present)
businesses indexes:  drop: (none)  create: (none — already present)
```

Staging's Todo collections are **empty** and its indexes are **already correct**.
The blocking `user_1_startDate_1` index is not there to drop. Nothing needs to be
applied, now or before a deploy.

**Why it could not be run before.** The script's own header said to "point
`MONGODB_URI` at the database you mean". That is only true in development: the
droplet sets `NODE_ENV=production`, and `config/database.js` then builds an Atlas
URI from `MONGO_USERNAME` / `MONGO_PASSWORD` / `MONGO_HOSTNAME` / `MONGO_DB_NAME`.
No `MONGODB_URI` exists anywhere, so the script was reaching for a variable that
was never going to be set. It connects through `config/database.js` like the
server does, so running it **on the host** needs no credential to be copied
anywhere. The header now says that.

## DNS: psm already has the capability; the record is blocked by the host

`todo.werewolf.solutions` has no A record. Nothing needs to be added to psm to fix
that — it is already wired end to end:

| | |
|---|---|
| Adapter | `src/server/deploy/adapters/digitalocean.ts` (A records: list/create/update/delete) |
| Connection | `con_do_dns`, `digitalocean-api@1`, **ready**, token stored (`secretGeneration: 2`) |
| Scope | zone `werewolf.solutions`, project `prj_e4713173923933470bd3`, env `staging` |
| Manifest | todo-app already declares the `todo` A record, value from the host connection |
| Plan | `resource:dns#reconciled → reconcile-dns@1` is planned and **not blocked** |

The record is missing because the plan has never been applied, and the plan is
held by the *host* resources, not by DNS.

## What is actually blocking: nothing is enrolled on the droplet

The helper binary is installed (`/usr/local/libexec/psm-host-helper`, 2026-09-09)
and `/etc/psm-deploy/targets/` exists (root:psm-deploy, 0750), but its contents
are unreadable without root and psm cannot observe a contract for this target —
hence three blockers that all say the same thing:

```
BLOCKER  directory    release directory differs from the target contract
BLOCKER  ingress      ingress hostname or document root differs from the enrolled target
BLOCKER  certificate  certificate differs from the target contract
```

Note the distinction that an earlier note got wrong. **psm's connection
constraints were already corrected** — `allowedTargetRootPrefixes` is
`/var/www/todo.werewolf.solutions` at metadata revision 2. What is stale is the
contract *on the droplet*. Also, there is no `/var/www/todo.werewolf.solutions`
directory and no `todo.werewolf.solutions` in `sites-enabled` yet.

**This could not be completed.** Enrollment is
`sudo /usr/local/libexec/psm-host-helper enroll < target.json`, and `lorenzo`'s
sudo requires a password — which is not something to hand to an agent. The
contract is written out ready at
[`docs/deploy/host-targets/werewolf__todo-staging-web.json`](../deploy/host-targets/werewolf__todo-staging-web.json);
it needs one `scp` and one `sudo`, both by a person. Its `certbotEmail` is a
guess (`ops@werewolf.solutions`) and should be confirmed before enrolling.

Once enrolled, the DNS record, directory, nginx site and certificate are all
reconciled by the same plan — DNS was never the missing piece.

## Still blocked after this round

- **Host enrollment** — needs an interactive sudo on the droplet.
- **Release controller** — `release-controller-unpinned`. Needs the
  `deployment-control` repository to exist (the local scaffold is still not a git
  repository), a Todo target file, and an artifact-reader GitHub App that only a
  repository owner can install.
- **An artifact** — `artifact-missing`; nothing has been prepared to deploy.
