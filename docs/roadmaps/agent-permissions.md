# Project agent permissions

## Outcome

A preparation workroom must have effective permission to edit, stage and commit
before it starts. Missing authority is an actionable readiness blocker, never a
failed repair attempt. Grants originate in the local cockpit, never in chat or
repository configuration. Existing infrastructure approval remains unchanged.

## Implementation checklist

- [ ] Store project/checkout-scoped grants and an append-only audit trail in PSM's
  database; missing and legacy identity files confer no grants.
- [ ] Define preparation requirements and instructions together. Check before
  repair, on resumed turns and after engine changes; preserve attempt budgets.
- [ ] Execute managed project/workroom turns through a Claude SDK tool broker.
  Disable built-in shell/file/network tools, filesystem settings and external
  MCP discovery. Expose only bounded repository file and Git operations.
- [ ] Check the current grant revision on every broker call. Stop affected turns
  and clear queued work when grants change. Never resume a legacy CLI session
  into the managed runtime.
- [ ] Protect permission config, PSM state, Git internals and credentials from
  broker file access. Reject path traversal, symlinks and linked worktrees.
- [ ] Stage explicit files and commit only broker-staged changes; preserve
  unrelated work. Disable Git hooks, filters, signing and external diff tools.
- [ ] Extend Capabilities with Agent permissions and Deployment connections;
  preserve Attached tools. Show grant provenance, unavailable operations and
  sanitized connection diagnostics grouped with their dependents.
- [ ] Cover grant forgery, stale revisions, revocation, unsupported engines,
  no-attempt preflight, path escapes and real repository staging/committing.
- [ ] Run typecheck, focused tests and the repository test suite.

## Supported boundary

The enforceable boundary is the set of tools exposed to managed project and
workroom agents. The agent has no general shell, HTTP client, permission API tool,
or access to PSM's database. Local operator grant requests require same-origin
browser metadata and an exact revision. The broker checks grants itself rather
than trusting model output, a transcript, or SDK automatic-approval rules.

This is not OS isolation against another process running as the operator. Workspace
chat, operator terminals and other applications retain their own permissions.
Deployments and publishing continue to use their existing approval mechanisms.
Attached integrations remain visible, but are not automatically loaded into a
managed permission session.

## Deliberately unavailable until enforceable

- Codex managed execution needs a corresponding broker adapter. Its workrooms
  must fail preflight rather than silently fall back to unrestricted tools.
- Arbitrary test scripts and package installation need a separate sandboxed
  runner: they can execute repository code and access the network.
- Discarding edits, deleting/switching branches and pushing are not implied by
  commit or branch-creation grants. Publishing stays PSM-managed per plan.
- GitHub builds still need the source published through an approved workflow;
  a local commit is not evidence that GitHub has received it.

## Acceptance

Granting repository read/edit and git.commit permits explicit staging and a local
commit without a prompt. Revoking blocks further tool calls and stops work.
Missing grants identify the gap before a repair is counted. There are no automatic
grants, identity migrations granting authority, permission bypasses or secret
rewrites. UI states distinguish credential presence from verified provider access.
