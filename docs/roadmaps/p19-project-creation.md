# P19 — Create a project from a conversation

Status: **pending; planned 2026-11-13.** C1 and C2 can start now. P11d
(conversational scaffolding with stack templates and components) extends this
plan once P11a bundles exist.

## What the user asked for (2026-11-13)

> If in Claude I'm saying I'd like to create this new thing, can it use psm to
> check if the current projects have anything to compare to, then research
> online what other people do, and then actually create it with the things we
> want in each project?

In short: one conversation, in the cockpit or in an MCP client such as Claude
Code, takes an idea through four steps:

1. **Compare.** Does this belong in an existing project? What overlaps, and what
   can be reused?
2. **Research.** How do other people build this? Cite the sources.
3. **Propose.** Produce a concrete proposal the operator can read and edit.
4. **Create.** Make the project with the standard set of practices, house rules
   and capabilities, and hand it its first piece of work.

## Starting point (checked 2026-11-13)

| Piece | State | Where |
| --- | --- | --- |
| Create a folder | Built, cockpit only. Makes the folder, a README, `git init`, the selected practices' starter files, the managed house-rules region in CLAUDE.md/AGENTS.md, and saves the description to overrides. No stack template or starter code. | `POST /api/projects/new` (`src/server/index.ts`), `createProject()` in `web/app.js` |
| Practices | Built: versioning, docs/ADRs, CI/CD, conventional commits, security review, human-gated AI. Each one writes its starter files and never overwrites an existing file. | `PRACTICES`, `scaffoldPractice()` in `src/server/rules.ts` |
| Capabilities | Built: attached after creation through a preview, then an apply step. | `/api/projects/:name/attachments/preview`, `/api/projects/:name/attachments` |
| Compare | Built as a prompt only. The workspace assistant's "new-project brainstorming protocol" checks for overlaps and reusable pieces, recommends the smallest starting setup, and waits for confirmation. Its output has no fixed structure. | `workspaceRundown()` in `src/server/index.ts` |
| Research | Missing. Nothing in the protocol asks for it. The managed Codex runtime runs with `web_search: "disabled"`. Claude sessions depend on their permission mode. | `src/server/agent-codex-runtime.ts` |
| MCP | Read-only tools, plus `submit_request`, which needs an existing `projectId`. No MCP tool can ask for a new project. | `src/server/mcp/server.ts` |

## Slices

| ID | Deliverable | Depends on | Acceptance |
| --- | --- | --- | --- |
| **C1** | **Research step and a fixed proposal.** Extend the brainstorming protocol: compare (existing behaviour), then an opt-in research step whose notes keep their source URLs, then a proposal in a fixed shape (below). The cockpit shows the proposal as a card that can open the New project form already filled in. | None. Web access for the managed engines is open decision 1. | On a real idea, the assistant names overlapping projects, gives cited research notes, and produces a proposal that fills the New project form. With research turned off, no web call is made. |
| **C2** | **`propose_project` over MCP.** It sends a proposal in the same shape. psm saves it to a local queue (table `project_proposals`) and it never creates anything. Companion tools: `list_project_proposals`, `get_project_proposal`, `withdraw_project_proposal`. Each client starts with this off until the operator ticks "May propose projects" (behind the P02a.2 operator token). It is idempotent on the client's key, has a daily cap, and the proposal text is returned under `untrusted`. | MCP-1 read slice (built), P02a.2 (built 2026-11-12). Scope is open decision 2. | A real Claude Code client compares with `list_projects`/`get_project`, researches, then proposes. The proposal shows up in the cockpit. Refusals are tested and named: switch off, wrong scope, cap reached, bad name, a folder that already exists. `curl` without the operator token cannot turn the switch on. |
| **C3** | **Review and create in the cockpit.** The Agents page lists pending proposals. Opening one fills the New project form (name, description, folder link, practices, house rules). The operator edits it, then Create runs the existing `/api/projects/new`. Each proposed capability then goes through its own attachment preview and apply. The proposal records the new `prj_` id and moves to `created`; Reject records a reason the client can read. | C2 | A proposal sent from Claude Code becomes a project: practices' starter files present, house rules written, capabilities attached after their previews, the `prj_` id visible to `get_project_proposal`. A rejected proposal creates nothing. |
| **C4** | **First work.** The proposal's first steps become one intake on the new project (the same path as `submit_request`, source `psm`). It is triaged and waits for the operator's Go like any other request. | C3, P14 E (built) | Starting from one conversation: compare → research → propose → create → first request triaged → Go → branch → review, with no hand-copied text. |
| **→ P11d** | **Stack templates and components.** The proposal can name a starting stack and P11a components. Creation installs pinned versions, with the usual ownership and permission checks. | P11a, the P11d conversation contract | Tracked in [engineering workflows](engineering-workflows.md). |

## Proposal shape (C1/C2)

```jsonc
{
  "name": "folder-safe-name",            // same rule as /api/projects/new
  "purpose": "one paragraph",
  "linkId": "optional linked folder",
  "overlaps": [{ "projectId": "prj_…", "what": "…", "decision": "reuse | extend | separate" }],
  "reuse":    [{ "projectId": "prj_…", "piece": "package / API / MCP server / UI pattern", "how": "…" }],
  "research": [{ "finding": "…", "source": "https://…" }],
  "stack":    "suggested stack, free text until P11d",
  "practices": ["versioning", "docs", "ci-cd", "…"],   // ids from PRACTICES
  "capabilities": ["workspace:…"],                     // each still gets its own preview
  "firstSteps": "self-contained text for the first intake (C4)"
}
```

Nothing in a proposal grants anything. Every practice id and capability ref is
checked against the catalog when the operator opens the proposal. Unknown
entries are shown as unsupported, not dropped silently.

## Boundaries

- No MCP client creates a folder. Creation always runs from the cockpit, after
  the operator reads the proposal.
- Research text and URLs are untrusted data. They are shown, never run, and
  never turned into commands or attachments.
- A proposal cannot pick a folder outside the linked project folders, and cannot
  overwrite an existing one. `/api/projects/new` already enforces both, and C3
  keeps that check.

## Open decisions

1. **Web research for managed engines.** Turn on web search for the workspace
   assistant only (Codex `web_search`, Claude WebSearch/WebFetch), or keep
   research to MCP clients that already have it, such as Claude Code.
   Recommended: only the workspace assistant, only when research is ticked.
2. **Who may propose.** Only all-projects MCP clients (a client limited to some
   projects cannot do a complete comparison), or any client with the switch on.
   Recommended: all-projects clients only.
