# Attach & Capability Marketplace — implementation plan

Status: implementation record. Workspace MCP attach, copy-pinned docs/skills, custom MCP,
detach, the ownership ledger, both engine adapters, and the structured-plan UI are built on
`feature/capabilities-plan-workflow`.

The hosted verified registry and conversational project scaffolder remain deferred because
registry ownership/review keys and the exact new-project conversation contract are still open
product decisions. This document keeps those phases visible without presenting them as shipped.

## 1. The idea in one line

Any project in the workspace can **attach** a capability — a workspace project, an MCP
server, a skill, a doc, an API — and psm makes the project's AI able to use it, without
psm ever running that capability itself.

## 2. Layering (why psm stays small)

```
capability          daedalus · control-room · feedback-hub · vps1777 · some-dev's MCP
   ↑ does the work
psm                 catalog · provenance/integrity · writes config into the project dir
   ↑ wires
claude / codex      reads .mcp.json + .claude/skills/ + CLAUDE.md, executes
```

psm never proxies MCP traffic, never runs a skill, never holds a capability's runtime.
It resolves a capability to **config files in the target project directory**, and the
coding CLI (which psm already shells out to in `src/server/ai.ts`) does the rest.

The marketplace adds exactly one runtime concern to psm: fetching and verifying catalog
entries. Everything else stays file-writing.

## 3. Terminology

| Term | Meaning |
|---|---|
| **Capability** | Anything attachable. Has a kind, an id, and a way to be wired in. |
| **Kind** | `mcp` · `skill` · `doc` · `api` · `project` |
| **Catalog** | The set of capabilities psm can offer. Union of the three sources below. |
| **Source** | Where a catalog entry came from: `workspace` · `verified` · `custom` |
| **Attachment** | A capability bound to a specific project, recorded in `overrides.json`. |
| **Wiring** | The concrete files psm writes so the AI can use the attachment. |

## 4. Trust tiers

This is the crux, because the third case is another dev's code running with your
credentials inside your project.

| Source | Provenance | Integrity | Execution posture |
|---|---|---|---|
| `workspace` | sibling project + explicit psm manifest | mutable workspace reference, or copied artifact digest | review the preview; workspace origin is not a trust guarantee |
| `registry` | future registry owner/reviewer | must be artifact-pinned and signature-verified | not enabled until registry policy/key ownership is decided |
| `custom` | user-entered command or URL | manifest-pinned, not code-verified | **untrusted**, two separate confirms |

Rules:

- A `custom` MCP entry with a `command` field is arbitrary code execution on attach-use.
  psm must show the exact command string and require a distinct confirm — never a
  one-click attach.
- `verified` entries are **pinned by digest** at attach time. Auto-pull refreshes the
  catalog, never silently re-points an existing attachment at new code.
- Secrets never enter `overrides.json` or either catalog. Manifests declare variable names;
  psm checks that those names exist in its own process environment. Users export them before
  launching psm. Custom manifests reject environment values, static auth headers, URL
  credentials, secret-shaped query parameters, and credential-shaped argv.
  `overrides.json` is committed to git in this repo — treat it as public.

## 5. Capability manifest

One shape for all kinds. Workspace entries are derived, not hand-written.

```jsonc
{
  "id": "feedback-hub",
  "kind": "mcp",
  "providerProject": "feedback-hub",
  "title": "Feedback Hub",
  "summary": "Register an app, collect feedback, triage with Claude, promote to roadmap.",
  "requiredEnv": [],
  "mcp": {
    "transport": "stdio",
    "launch": { "type": "npm-script", "script": "mcp" },
    "env": { "DB_PATH": "${providerRoot}/data/feedback-hub.db" }
  },
  "usage": "Use this to inspect and triage feedback. Never promote without approval."
}
```

- `guidance` is the text psm appends to the project's `CLAUDE.md`. This is what actually
  teaches the AI *when* to reach for the capability — without it, an attached MCP server
  is invisible in practice.
- `kind: "project"` is sugar: it resolves to whichever of the other kinds that project
  exposes (feedback-hub → `mcp`; a project with only docs → `doc`).

## 6. Catalog sources

### 6.1 workspace (explicit executable contracts, derived safe copies)

The catalog consumes the project paths already produced by the scanner. Executable MCP
surfaces require an explicit entry in `docs/workspace-capabilities.json`; heuristics only
produce disabled candidates. Copy-only skills can be derived safely:

| Detect | Emit |
|---|---|
| explicit manifest | ready `mcp`, `doc`, `skill`, or `api` capability |
| package `scripts.mcp` without manifest | disabled MCP candidate requiring review |
| `.claude/skills/*/SKILL.md` | copy-pinned `skill` (one per skill) |

This is the highest-value, lowest-cost half of the whole feature. It makes daedalus,
control-room, and feedback-hub attachable today.

### 6.2 verified (the auto-pull)

A registry file fetched on a schedule and cached:

```
docs/registry.json          ← local fallback / seed
<REGISTRY_URL>/index.json   ← pulled, cached to .psm-catalog.json (gitignored)
```

Pull rules:

- Refresh on `Rescan`, plus a TTL (24h). Never on server boot — keep startup offline-clean.
- Failure to reach the registry is **non-fatal**: log, keep the cached catalog, show a
  staleness badge. psm must work with no network.
- Each entry carries a `digest`. On attach, psm records the digest in the attachment.
  A later catalog refresh that changes the digest surfaces an **update available**
  prompt — it does not rewrite the project.

Open: who runs the registry. For a single-user workspace, `docs/registry.json` committed
to this repo is a legitimate v1 and defers the whole hosting question.

### 6.3 custom

User pastes an MCP command/URL, a skill directory, a doc path, or an API spec. Stored in
`.psm-catalog.json` under `custom`. Always untrusted tier.

## 7. Storage

### Attachments — `overrides.json`

Add one field to `Override` in `src/types.ts`:

```ts
attachments?: Attachment[];

interface Attachment {
  id: string;                       // capability id
  kind: "mcp" | "skill" | "doc" | "api" | "project";
  source: "workspace" | "verified" | "custom";
  mode: "reference" | "copy";
  digest?: string | null;           // pinned, for verified/custom
  attachedAt: number;
}
```

This fits the existing pattern: `overrides.json` is the human-curated layer, and an
attachment is a human decision. It survives rescans, which derived state does not.

### Catalog — `.psm-catalog.json` (new, gitignored)

Custom entries only in the implemented phases. Workspace entries are re-derived. A remote
registry will use a separate cache only after its trust/signature policy is defined.

## 8. Reference vs copy — resolved

I raised this last message; here's the answer.

- **`reference` is the default for `workspace` and `verified` MCP/API.** The attachment
  points at the live thing. daedalus improves, every project attached to it benefits.
  This is the whole reason a workspace-aware tool is worth building.
- **`copy` for `skill` and `doc`.** Skills and docs are small, and a skill silently
  changing under a project is a debugging nightmare. Copy into `.claude/skills/<id>/`
  and record the digest so psm can offer "update available."
- **Custom MCP is an explicitly untrusted reference.** A pasted command or URL does not
  identify a copyable artifact, so psm pins the manifest and uses two confirms; it does not
  pretend that this verifies the referenced code.

Rule of thumb: reference things that are *services*, copy things that are *instructions*.

## 9. Wiring — what psm writes

Target project directory:

```
.mcp.json                    mcpServers entry            (kind: mcp)
.claude/skills/<id>/         copied skill dir            (kind: skill)
.agents/skills/<id>/         copied skill dir for Codex  (kind: skill)
.psm/capabilities/<id>/      copied docs / API specs     (kind: doc/api)
.codex/config.toml           project MCP entries         (kind: mcp)
CLAUDE.md + AGENTS.md        attributed guidance block   (all kinds)
```

Constraints:

- **Merge, never overwrite.** These files may already exist (the new-project handler at
  `src/server/index.ts:118-127` already writes `README.md` and `CLAUDE.md`). Read, merge
  the psm-owned section, write back.
- Delimit the psm-owned region so detach is exact:
  `<!-- psm:attachments:start -->` … `<!-- psm:attachments:end -->`.
  Everything outside the markers is the user's and is never touched.
- **Detach must fully reverse an attach.** If it can't (user hand-edited inside the
  markers), say so rather than clobbering.

### Engine split — verified

psm supports two engines (`aiEngine: "claude" | "codex"` in `src/types.ts`). Claude Code
uses project `.mcp.json` and `.claude/skills/`. The installed Codex and current official
manual confirm trusted-project `.codex/config.toml`, `mcp_servers`, and repository skills
under `.agents/skills/`. psm writes both adapters and both guidance files (`CLAUDE.md` and
`AGENTS.md`). A new engine session is required after attachment.

## 10. Integration points (real files)

| File | Change |
|---|---|
| `src/types.ts` | `Attachment`, `Capability` types; `attachments?` on `Override`; surface on `Project` |
| `src/scan.ts` | unchanged; existing project paths feed catalog discovery |
| `src/classify.ts` | merge attachments through to `Project` (it already loads/saves overrides) |
| `src/server/catalog.ts` *(new)* | build catalog: workspace ∪ cached verified ∪ custom; pull + TTL + digest |
| `src/server/attach.ts` *(new)* | attach/detach → the file writes in §9. Pure-ish, unit-testable |
| `src/server/index.ts` | `GET /api/catalog`, `POST/DELETE /api/projects/:name/attachments`; call attach from the new-project handler at `:102` |
| `src/server/ai.ts` | nothing structural. Optionally note attachments in `extraContext` so the AI knows what it has |
| `web/app.js` | attach picker in the project editor; capability list on the card |
| `src/render.ts` | optional: list attachments per project in `PROJECTS.md` |
| `.gitignore` | add `.psm-catalog.json` |

**Do not:** put wiring logic in the Express handlers, or let `attach.ts` import anything
from `ai.ts`. Attachment is a filesystem operation and should be testable without a
server or a model.

## 11. Phases

**Phase 1 — workspace attach, reference-only. Implemented.** Explicit manifests plus safe
heuristic candidates expose workspace capability surfaces.
`attachments` on `Override`. Attach a workspace project → writes `.mcp.json` + a
`CLAUDE.md` block. UI: a picker listing sibling projects. No registry, no trust tiers.
*Ships the daedalus/control-room/feedback-hub use case, which is the actual ask.*

**Phase 2 — skills, docs, custom. Implemented for v1.** Skills and docs are copied as
UTF-8 text with an artifact digest and exact ledger ownership. Control Room's specification
is an explicit doc capability. Custom stdio/HTTP MCP entries require a catalog confirm and
then a separate attach confirm. Detach shipped with Phase 1.

**Phase 3 — the hosted marketplace. Deferred.** `docs/registry.json` seed, then remote pull with TTL,
digest pinning, staleness badge, "update available." Verified tier.

**Phase 4 — conversational new-project. Deferred.** The sketch's left branch: `POST
/api/projects/new` becomes a chat that ends by scaffolding *and attaching*. Depends on
Phase 1 existing, which is why it's last despite being the headline.

## 12. Failure modes

| Failure | Handling |
|---|---|
| Registry unreachable | non-fatal, use cache, badge as stale |
| Attached workspace project deleted | scan flags the attachment `broken`; UI shows it; never auto-detach |
| `.mcp.json` hand-edited / malformed | fail loudly, refuse to write, show the parse error |
| Capability id collides across sources | workspace wins; others get `source:id` |
| Digest mismatch on refresh | prompt, never auto-update |
| Copy target already exists | fail loudly; never overwrite a non-owned file |

## 13. Acceptance criteria

1. Attaching `feedback-hub` to a project makes that project's Claude session able to call
   its MCP tools, verified by an actual tool call — not by the file existing.
2. Detach restores every touched file to its pre-attach content, byte for byte, when the
   psm-owned regions are untouched.
3. A project with hand-written `.mcp.json` and `CLAUDE.md` content keeps all of it
   through an attach → detach cycle.
4. psm boots, scans, and serves with no network and no catalog cache.
5. A `custom` MCP entry cannot be attached without the command string being displayed and
   separately confirmed.
6. No secret value ever lands in `overrides.json` or `.psm-catalog.json`.

## 14. Open questions

1. **"One in particular should pull the verified ones automatically"** — ambiguous in the
   brief. Either (a) psm pulls the verified registry, or (b) one specific capability
   (control-room? daedalus?) is the thing that auto-pulls. This plan assumes (a).
   Needs confirming before Phase 3.
2. **Who hosts the registry**, and what does "verified" mean — self-attested, digest-only,
   or reviewed? `docs/registry.json` in-repo defers this through Phase 3 v1.
3. **Is attachment ever bidirectional?** "Attach feedback-hub to print-shop" may also mean
   print-shop should register itself *in* feedback-hub. This plan does one direction only.
4. **Deploy-time attachment.** "When I want to go to production I can use control-room" —
   is that an attachment, or does it belong to the existing `deployStaging` /
   `deployProduction` fields in `src/types.ts`? Possibly both, and they should not diverge.

## 15. UI: plan editor & work-session page

Status: implemented. This section records how psm *presents*
an AI implementation plan and where work sessions live in the UI. It is orthogonal to the
marketplace (no dependency either way) but shares its posture: **the AI proposes, the
human shapes and confirms, then execution starts.**

### 15.1 The session boundary

Planning and implementation use different provider conversations. The Plan tab starts a
fresh dedicated planner session; a second session on the other engine independently
reviews its structured output. Both are technically read-only (Codex `read-only` sandbox,
Claude `plan` permission mode). The normal per-project AI conversation is not reused for
planning. It starts fresh only after the human confirms an immutable plan revision.

### 15.2 Plan as data, not prose

When the dedicated planner produces an implementation plan, it emits it in a structured block,
using the same marker protocol as `<psm-question>`:

```
<psm-plan>{ ...json... }</psm-plan>
```

```jsonc
{
  "id": "plan_a1b2",
  "project": "psm",
  "title": "Attach & Capability Marketplace",
  "status": "draft",        // draft → edited → ai-reviewed → confirmed → in-progress → done
  "revision": 1,
  "phases": [
    {
      "id": "ph_1",
      "title": "Workspace attach, reference-only",
      "summary": "Ships the daedalus/control-room/feedback-hub use case.",
      "steps": [
        { "id": "st_1", "text": "Extend scan.ts to detect capability surface", "done": false,
          "children": [
            { "id": "st_1a", "text": "Detect .mcp.json / mcp entry", "done": false }
          ] }
      ]
    }
  ],
  "notes": "Anything the AI wants to flag (risks, assumptions)."
}
```

- Steps can nest up to five levels (`children`) and are capped with the rest of the plan.
- `done` exists so the same structure doubles as the execution checklist later.
- Plans are stored server-side in `.psm-plans/<project>/<id>.json` (gitignored), with
  `revision` bumped on every save. The transcript keeps only the marker; the file is the
  source of truth.
- Malformed JSON in a `<psm-plan>` block → render the raw text as markdown with a
  "couldn't parse plan" notice. Never lose the content.

### 15.3 The editor

Rendered wherever a plan block appears (new **Plan** tab in the work session, §15.6).
Interactions, in priority order:

1. **Phases as cards in a vertical list.** Each shows title, summary, and its nested
   step list. A drag handle moves a phase up/down (Trello-column feel, but vertical —
   phases are ordered, not parallel lanes).
2. **Steps drag within and across phases**, VS Code-explorer style: drop a step into
   another phase, reorder inside a phase, drag onto a step to nest under it, drag out to
   un-nest. Indent/outdent also available via keyboard (Tab / Shift+Tab) for precision.
3. **Click-to-edit text** on phase titles, summaries, and step text (single
   `contenteditable` span or swap-to-input — whichever stays closest to existing app.js
   patterns). Enter commits, Esc reverts.
4. **Add / delete** phase and step controls, small and out of the way.

Implementation constraint: **native HTML5 drag & drop, vanilla JS, no new dependency.**
web/app.js is framework-free and this feature doesn't justify changing that. If native
DnD edge-cases (nesting drop targets) get gnarly, pointer-event-based dragging is the
fallback — still no library.

Editing is local until saved. A dirty indicator + "Save plan" / "Discard" bar appears
once anything changes.

### 15.4 The planner/reviewer loop

The initial task brief starts a new planner provider session. When it emits a valid plan:

1. psm changes the same revision to `reviewing` without incrementing it.
2. The other engine receives that exact revision in its own read-only reviewer session and
   emits a revision-bound `<psm-plan-review>` marker.
3. With no warning/blocking issues, the loop becomes `ready`. Otherwise the planner receives
   the reviewed plan, emits a complete replacement with the same id and a new revision, and
   review repeats. The automated loop is bounded at three reviews.
4. Planner and reviewer transcripts, actual/configured models, active role, and round status
   are visible separately in the Planning room. Questions reuse the existing question popup
   but answer the correct planning session.

On a human **Save & review**, `PUT /api/projects/:name/plans/:id` increments the revision and
queues the same cross-model reviewer loop. While any loop is active the editor and feedback
composer are read-only, preventing stale reviewers and concurrent edits from racing.

The user can send feedback after a loop settles or start an explicitly fresh planner session.
Nothing executes during planning.

### 15.5 Confirm & start

A **"Confirm & start working"** button sits on the plan header and is enabled only when
the current revision is `ai-reviewed`. Draft, edited, reviewing, and interrupted revisions
cannot bypass the planning loop at the API or UI layer.
Clicking it:

1. Sets status `confirmed`, records the confirmed revision.
2. Cancels any remaining planner work, clears the normal project's previous provider thread,
   opens the AI tab, and starts a fresh normal project-agent session with the confirmed plan
   plus "implement this, phase by phase; report progress against step ids."
3. Status moves to `in-progress`. As the AI reports steps complete it re-emits the plan
   with `done: true` flipped (or a lighter `<psm-plan-progress>` marker updating ids);
   the Plan tab becomes a live checklist of execution.

The plan is pinned at its confirmed revision during execution. The UI and API both reject
edits after confirmation; changed scope requires a new plan id.

### 15.6 Workspace: popup → page

The current `#workspace` overlay (`web/index.html`) becomes a **page** with its own
URL, replacing the modal-over-the-board pattern:

- **Hash routing** in app.js (static SPA, no server change): `#/` = home board,
  `#/p/<name>` = that project's work session. Browser back/forward and reload work;
  session state already lives server-side (procs, AI sessions), so a reload rehydrates.
- **Same header.** The existing `.topbar` (brand, search, Ask psm, Usage, House rules,
  New, Export, Rescan) stays on both pages — it is the constant chrome.
- **Quick-switch strip** added to the header (or directly under it): a `Home` pill plus
  one pill per project currently marked **Working on** (the existing `workingOn` flag /
  "Mark working" button). One click moves between active projects and home without
  losing anything — sessions keep running server-side regardless of what's on screen.
- **Tabs stay, plus Plan and Capabilities:** `Plan · Capabilities · Logs · Web · AI · Session · Deploy`. The Plan tab
  shows the latest plan plus the dedicated Planning room (or an empty state that focuses
  the task-brief composer instead of redirecting to the normal AI tab).
- The question popup (`#question-modal`) stays a popup — it's an interrupt, not a place
  you work. Same for Usage / House rules / New.

### 15.7 Integration points (real files)

| File | Change |
|---|---|
| `web/index.html` | project page, quick-switch strip, Plan editor, and Planning room |
| `web/app.js` | hash router; plan editor; separate planner/reviewer SSE transcripts, questions, and handoff |
| `web/styles.css` | page layout, plan cards, drag affordances, and responsive planning-room layout |
| `src/server/ai.ts` | distinct session identities; read-only planning enforcement; bounded cross-model loop; fresh normal-agent kickoff |
| `src/server/plans.ts` *(new)* | plan CRUD + storage under `.psm-plans/`; revision handling. No Express imports — same testability rule as attach.ts |
| `src/server/index.ts` | plan CRUD/confirm plus planner state, stream, start, message, question, and cancel routes |
| `.gitignore` | add `.psm-plans/` |

The shared interaction protocol restricts `<psm-plan>` to the planner,
`<psm-plan-review>` to the reviewer, and `<psm-plan-progress>` to the normal project agent.
The server independently enforces those ownership rules.

### 15.8 Phasing

Independent of marketplace Phases 1–4; interleave freely.

- **UI-A — the page.** Workspace overlay → routed page, same header, quick-switch strip.
  No plan features yet. Smallest change with immediate daily value.
- **UI-B — read-only plans.** `<psm-plan>` marker parsing, storage, Plan tab rendering
  phases/steps. House-rules addition ships here.
- **UI-C — the editor.** Drag & drop (phases + steps), inline edit, save with revision
  bump. No AI round-trip yet — save just stores.
- **UI-D — the loop.** Dedicated read-only planner, cross-engine reviewer, save-triggered
  review, fresh-agent confirm/start, and execution progress checklist. Implemented.

### 15.9 Acceptance criteria

7. A plan emitted by the dedicated planner renders as phases/steps in the Plan tab; malformed plan
   JSON degrades to visible markdown, never a blank pane.
8. Reordering two phases, moving a step across phases, and editing a step's text all
   survive save → reload byte-for-byte (against the stored JSON).
9. Saving an edited plan produces a revision-bound reply from the other engine, and the
   editor is locked while the bounded planner/reviewer loop is in flight.
10. "Confirm & start working" clears the old normal-agent provider thread, opens the AI
    tab with the kickoff prompt in a fresh project-agent session, and marks the plan
    `in-progress` only when that turn was accepted.
11. Navigating home and back to a project mid-session loses nothing: logs, transcript,
    and plan state all rehydrate.
12. Hand-written markdown plans (no marker) keep rendering exactly as today.

### 15.10 Open questions

5. **Plan ↔ `next` field.** A confirmed plan arguably *is* the project's "next step" —
   should confirming a plan update the `next` override (and PROJECTS.md)? Leaning yes,
   one line: "Executing plan: <title> (phase N/M)."
6. **One plan or many per project?** Storage supports many; the UI shows the latest.
   History/compare of revisions is deferred until wanted.
7. **Codex sessions** don't share the marker protocol conventions unprompted — does the
   house-rules addition suffice, or is plan emission Claude-only in v1? Verify alongside
   the §9 engine-split check.
