# DSH Super-agent compared with our projects

Written 2026-11-09. Source: [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) at commit `8c32a9d` (2026-10-31), read from its `docs/` (000–007); its code was not reviewed line by line. The repository is a research prototype, and its README says some designs in the accompanying article are not implemented. Project facts were checked against the local checkouts on the same day.

Used by the implementation plan [P15 — DSH-style ticket model](../roadmaps/p15-dsh-ticket-model.md).

Our projects already cover most of what DSH (the DeepSeek Super-agent repo) does, but the pieces are spread across several of them. The closest match is **psm**, not Daedalus, because Daedalus is no longer an agent harness.

**Daedalus has become a different product.** The repo was restarted on 2026-07-13 as a Go "infrastructure operating system": inventory graph, monitoring, deploys that need approval, audit log, homelab mode. The July Node harness (skills, Argus web UI, single-track `coding-cto`) isn't in its git history. I didn't find it anywhere else either, though my search timed out before covering the whole workspace.

## What DSH is

- **What it does:** an always-on coding agent for one GitHub repo, listening to GitHub and Feishu (a chat app, like Slack). About 15k lines of TypeScript with 70 test files. It's a plugin for DeepSeek Harness, so it can't run without that host.
- **How it works:** a long-running **router session** reads incoming events and decides what's real work. Each accepted job becomes a **Ticket**, and each Ticket gets its own **worker session**, folder and branch. The worker ends with a pull request.
- **Core rule:** take as little human attention as possible. It acts only when someone allowed asks, or when a rule the team wrote allows it. It only messages people when they must act or can use a result.
- **Main ideas:**
  - **Follow-ups go straight to the job.** A later comment on a Ticket's issue or PR reaches its worker directly, with no new decision by the router.
  - **Rules for unrequested work have three modes:** `off`, `observe` (only records what it would have done) and `auto`.
  - **Workers report in fixed states:** progress, waiting, ready, blocked, failed or dropped. Questions for a person go through one structured field.
  - **Restart-safe:** every action is saved to SQLite before it's carried out, so a restart doesn't lose or repeat work.
  - **The panel shows only what waits for a person.**

## How each of our projects compares

| Project | Closest DSH part | Biggest difference |
|---|---|---|
| **psm** (executor + hub) | The whole Ticket flow: Todo note → one-shot triage (like DSH's accept/reject decision) → **Go** (permission for that one job) → isolated clone + Docker sandbox → Accept/Reject/Revise | psm's sandbox is stronger; DSH admits its own isn't a security boundary. psm has no long-running router, takes work only from Todo (no GitHub or Telegram), and follow-up comments don't reach a running job. Report states are looser. |
| **wfq** (`workflow`, cto branch) | Running many workers at once in git worktrees, with a human check before merge | Built the opposite way: wfq is a planned pipeline with six stages and a CTO → team leads → devs hierarchy. DSH has no stages and no hierarchy: many independent Tickets, one PR each, and the PR is the review. |
| **aurora** | The interface side: Telegram bridge (like DSH's Feishu link), `aurora:ask` (like the structured question field), handoff briefings (DSH has matching handoff prompts) | Aurora is one chat session with you. DSH's router never does the work itself; it only routes. |
| **ai-mesh** (coding farm) | DSH's Executor, the part that runs a Ticket. DSH deliberately keeps it swappable. | The farm already has leases, fencing, encrypted source and results, and it names psm as the owner of jobs. Coding agents on open models (F03–F07) aren't built yet. |
| **Daedalus** (Go) | Same philosophy: AI as a governed actor, propose → approve → execute | Different area: it runs infrastructure, not code tasks. It could later send its alerts in as triggers. |

## psm's MCP as the "rundown of all projects"

- It exists: `/mcp` with read-only `list_projects`, `get_project`, `get_access_status`, `list_plans` and `get_plan`. Claude Code and Codex have both called it successfully.
- It isn't accepted yet. It's waiting on P02a.2, because any local process can still bypass it with a plain `curl` to psm's REST API.
- Only 14 projects have the `prj_` id it needs to address them.
- It doesn't report live git state, version or next step per project yet, which a "most updated state" rundown would need.

## Recommendation

Use psm as the hub, with DSH's design as the blueprint:

- **Sources:** Todo, GitHub, and Telegram through aurora's bridge.
- **Executors:** a local Docker clone today, ai-mesh's farm later.
- **wfq's hierarchy:** drop it, or keep it only as a mode for very large tasks.

The DSH ideas worth taking, in order:

1. Follow-ups on an issue or PR go straight to the running job.
2. Fixed report states plus a "needs a person" view.
3. `observe` mode before letting psm start work nobody asked for.
4. Save each action before doing it, so restarts are safe.
5. A router that never waits and never does technical work.
