# Local operator authority hardening (P02a)

Status: P02a.1 implemented 2026-10-22 (working tree, browser walkthrough open);
**P02a.2 implemented 2026-11-12 (working tree, not committed; see
[below](#p02a2-as-built-2026-11-12))**; **P02a.4 code and tests 2026-11-12
([below](#p02a4-as-built-2026-11-12)), live acceptance open**; P02a.3 needs a decision. Found 2026-10-22 while reviewing the
[PSM MCP operations plan](psm-mcp-operations.md). These are defects in the
current local API, independent of MCP. They must be fixed before MCP-1, because
MCP's per-client credentials and operator reviews mean nothing while any local
caller can act as the operator.

This is a P02 authority slice. It does not change the priority or acceptance
state of other phases in the [delivery index](README.md).

## Findings

| # | Defect | Where | Consequence |
| --- | --- | --- | --- |
| F1 | Any page on a loopback origin, on **any port**, is trusted with no token. | `agentGuard` in `src/server/agent.ts` (`loopbackOrigin` skips `tokenMatches`); `localRequest` in `src/server/index.ts` | A project's dev server, or PSM's own preview proxy at `http://localhost:<proxyPort>/` (`/api/projects/:name/preview`), runs repository and dependency code in the operator's browser. That code can `fetch("http://127.0.0.1:4317/...")`, receives CORS headers, and gets local authority: read the pairing token, confirm plans and start sessions, change resource levels, run Data Preview/Apply, flip switches. Answering reviews and editing agent permissions were already safe from this, because they require same-origin `Sec-Fetch-*` headers (`isPermissionOperatorRequest`). **Fixed in P02a.1.** |
| F2 | A loopback-origin page can read the pairing token. | `GET /api/agent/token` uses `localRequest` | The same page can take the token, which also authorizes the hosted origin path. **Fixed in P02a.1.** |
| F3 | Requests with no `Origin` header (curl, any local process) are the operator. | `agentGuard` (`if (!origin) return next()`); Data `local()` gate in `src/server/resources/api.ts` | Any process running as the user — an MCP client's shell, a PSM-managed Claude/Codex session with full access, a project script — can approve its own reviews and run authority-granting actions. Prompt-injected agents can do this without the operator noticing. |
| F4 | Data Apply freshness is bound to the command string, not the script's content. | `previews` map and `clean` check in `src/server/resources/api.ts`; `scriptCommand` in `resources/scripts.ts` | The script file can change between a clean Preview and Apply, so Apply runs code the operator never previewed. |
| F5 | Preview is treated as a read, but it executes repository code. | `scriptCommand(script, "preview")` runs `node <script>` in the project with its environment | A **Read** target relies on the script honouring the missing `--apply`. Anyone who can edit the script can write to a Read database by clicking or calling Preview. |

## Fix plan

### Phase 1 — browser origins (implemented 2026-10-22)

Implemented as `isOwnLoopbackOrigin` in `src/server/agent.ts`, used by
`agentGuard` and `localRequest`. The own origin is a loopback `http:` Origin on
the same port as the request's Host. Remaining: the browser walkthrough below.
The `Access-Control-Allow-Private-Network` item is moot: an unpaired page now
gets 401 on everything except discovery.

- Trust a loopback origin without a token only when it is **exactly** the agent's
  own origin (`http://127.0.0.1:<PORT>` and `http://localhost:<PORT>`, the port
  this process is listening on). Any other loopback port is treated as a paired
  origin and must present the pairing token. The static `scripts/static.sh`
  page on `localhost:8080` already pairs like the hosted page, so it keeps
  working through the existing pairing flow.
- `localRequest` (token read/rotate, local approval without sign-in) uses the
  same exact-origin rule.
- Refuse `Access-Control-Allow-Private-Network` to loopback origins that are
  not paired.
- Tests: preview-proxy origin and an arbitrary `localhost:5173` origin get 401
  without a token and cannot read `/api/agent/token`. The cockpit served by the
  agent and the paired 8080 page keep working.

### Phase 2 — operator credential on authority-granting actions

Mint an operator session for the cockpit: an `HttpOnly`, `SameSite=Strict`
cookie set when the cockpit loads from the agent's own origin, plus a CSRF
header. Require it (or the pairing token for a paired origin) on every action
that grants or exercises authority, not on plain reads:

- answering operation reviews and standing grants (these already require
  same-origin browser headers, which a local process can forge);
- plan confirmation (it starts an AI session);
- resource levels and Data Apply;
- deployment approval, machine plan application, firewall apply;
- pairing token read/rotate, switches, credential minting (including MCP
  credentials from [the MCP plan](psm-mcp-operations.md)).

A request with no `Origin` and no operator credential can still read, but it
gets 401 on these endpoints. CLI tools that need them get their own scoped,
revocable credentials, like MCP clients.

**Limit to state plainly:** a cookie or file credential is a speed bump, not a
boundary, against a process running as the same OS user. It can read the
browser profile or drive the browser. Phase 2 stops careless agents and
prompt-injected tool calls from approving by `curl`. It does not stop
deliberate malware running as the user.

#### P02a.2 as built (2026-11-12)

Built differently from the cookie described above, for one reason: **cookies
ignore the port.** A `localhost` cookie set by psm would also be sent to every
project dev server opened on `localhost:<port>` — repository and dependency
code that could read it from its request headers. So:

- psm keeps an operator token (`psm_op_…`) in `.psm-operator.json` (0600), made
  on first start and kept across restarts so open pages keep working
  (`src/server/operator.ts`).
- The cockpit page psm serves carries it in a `<meta>` tag (served `no-store`).
  `web/operator.js`, loaded first, removes the tag and adds `X-PSM-Operator` to
  the page's **same-origin** `fetch` calls only. Other loopback ports cannot
  read the page: agentGuard refuses them without the pairing token. The hosted
  and 8080 pages have no tag, so the script does nothing there.
- `operatorGate`, right after agentGuard, refuses (401 `operator_required`)
  every request that is not GET/HEAD/OPTIONS from the own origin or with no
  Origin, unless it carries the token. It also covers the pairing-token read
  `GET /api/agent/token`. This is wider than the endpoint list above: every
  local write needs the token, so a new endpoint is covered by default.
  Paired origins pass (agentGuard checked their pairing token); `/mcp` has its
  own per-client credentials.
- `POST /api/operator/rotate` makes a new token (revocation); other open pages
  get 401 until reloaded.
- A cockpit tab loaded before this change has no token: after psm restarts with
  it, that tab's actions return 401 with "reload the page". No other local
  caller of the write API was found in this repository.

Checked: `src/server/operator.test.ts` (writes and the pairing-token read 401
without the token, pass with it and from a paired origin, rotation revokes);
on a disposable psm copy, `curl` got 401 on `POST /api/units/start`,
`PUT /api/switches`, `POST /api/mcp/clients` and `GET /api/agent/token` while
reads answered 200; in the browser the same copy started and stopped a stack,
saved a runbook edit with a plain `fetch`, and logged no 401. Not yet walked
through: every Phase 2 action in a real browser (deploy approval, machine plan
apply, firewall, Data Apply, review answers), and the hosted page against an
agent with this change.

### Phase 3 — a real boundary for approvals (needs a decision)

Pick one:

1. **User-presence approvals (recommended):** high-risk approvals (production
   deploy, Data Apply, standing grants, MCP credential minting) need a WebAuthn
   assertion with user verification (passkey, touch or biometric), bound to the
   review's digest. A process can't produce one without the operator.
2. **Separate OS user:** run the PSM agent as its own user so state, keys and
   approval files are not readable by the developer user's processes. This is
   stronger but changes installation, file ownership and project access.

### Phase 4 — Data Preview and Apply binding

- On Preview, record a SHA-256 of the script file, its package's lockfile and
  the target key. Apply requires the same hashes, the same target, a clean exit
  and freshness, as today.
- Show in the Data card when the script has uncommitted changes. For a **Read**
  target, refuse Preview of a script with uncommitted or unreviewed changes;
  Preview is code execution with database credentials.
- Persist the Preview record (SQLite, with the hashes) so a restart fails closed
  without losing what was previewed.
- Tests: edit the script after Preview → Apply returns `preview-required`;
  uncommitted script on a Read target → Preview refused.

#### P02a.4 as built (2026-11-12)

- `src/server/resources/script-binding.ts`: Preview records a SHA-256 of the
  script file, its package lockfile (the package's, else the root's) and the
  target key. Apply needs the same digest, besides the same target, a clean
  exit and freshness; otherwise 409 `preview-stale`, and the stale preview is
  spent.
- On a **Read** target, Preview refuses (403 `uncommitted-script`) a script
  with uncommitted changes, one git does not track, or one outside a git
  repository. The Data card shows the reason before the click, and on a Full
  target it notes uncommitted changes without blocking.
- Not done: the Preview record is still in memory, not SQLite. A restart
  forgets it, which fails closed (Apply asks for a new Preview); persisting it
  only saves a click.
- Checked: `src/server/resources/api.test.ts` — script edited after Preview,
  lockfile changed after Preview, uncommitted and then committed script on a
  Read target. Open: the acceptance run of a real project's Data script against
  a throwaway MongoDB, which writes to a database and so waits for the
  operator.

## Acceptance

| Step | Gate |
| --- | --- |
| P02a.1 | F1/F2 tests pass; the cockpit, the paired 8080 page and the hosted page are walked through in a real browser. |
| P02a.2 | Every endpoint in the Phase 2 list returns 401 to `curl` without a credential; the cockpit still performs each action; credential revocation works. |
| P02a.3 | Decision recorded; the chosen boundary is demonstrated on one high-risk approval. |
| P02a.4 | F4/F5 tests pass; a real project's Data script is previewed and applied against the throwaway MongoDB. |

P02a.1 and P02a.4 can start now. P02a.2 is a prerequisite of MCP-1. P02a.3 is a
prerequisite of exposing MCP operations that request deployment or Data Apply
(MCP-3). Record results in the [evidence register](acceptance-evidence.md).
