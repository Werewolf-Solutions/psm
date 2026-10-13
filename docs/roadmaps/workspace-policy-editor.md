# P02 — workspace restriction editor

Implemented in the working tree on 2026-10-05, PSM 0.3.26. This is the local
workspace-policy slice; person-to-person delegation and hosted policy management
remain separate work.

## Operator workflow

Open a registered project, then **Capabilities → Agent permissions → Workspace
restrictions**. The section edits the workspace that owns that project, regardless
of which workspace the board currently displays.

- Choose an operation, or all supported operations, to deny across the workspace.
- Leave scope fields empty for all operations of that kind, or match an exact
  environment, connection, capability and/or tool. All filled fields must match
  the operation's context; a missing field in that context does not match.
- Choose a standing restriction or an expiry after 1, 8 or 24 hours.
- Review the affected workspace, scope and duration before saving. New restrictions
  stop running managed turns and clear queued messages for registered projects in
  that workspace, including workrooms containing those projects.
- Remove a restriction explicitly. Project grants and rules continue to determine
  access; removal does not create a grant or revive a stopped turn.
- Use **Refresh policy** after another view changes the revision. Review the
  **Workspace policy history** for actor, operation, revision and time.

Project presets cannot override a workspace deny. Expired restrictions stop
matching but remain visible and auditable until removed. Unknown operations
remain denied independently of a wildcard restriction.

## Enforcement and persistence

`AgentPermissionStore` persists restrictions in the existing `agent_permissions`
workspace row (`project_id = ws:<canonical reference>`, empty checkout). It writes
the new revision and audit event in one SQLite transaction. No schema migration
or rewrite of project grants is required. Stale revisions and invalid changes
leave state untouched. Workspace policy accepts Deny rules only: workspace Allow
or Ask is not supported by the existing decision contract.

Managed snapshots carry the workspace revision and the last restrictive workspace
revision. A new restriction invalidates older snapshots at the next broker call.
The provider continuity key includes workspace identity and restriction revision,
so retained provider state cannot resume with the authority it had before the
change. Removing a restriction leaves that revision fence in place.

Endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/workspaces/:ref/agent-policy` | Policy, supported operations, workspace name and audit history. |
| POST | `/api/workspaces/:ref/agent-policy/rules` | Add a Deny rule with the expected `revision`, scope and duration. |
| DELETE | `/api/workspaces/:ref/agent-policy/rules/:rule` | Remove a rule with the expected `revision`. |

Mutations require the existing local same-origin operator boundary. Personal
works offline. Business policy reads and edits require current management
authority from Werewolf; owners/admins qualify according to its `canManage`
response. Signed-out, revoked and unverifiable membership fails closed. The server
sets actor/source itself; request fields cannot impersonate an operator. These
are local PSM policy writes, not writes to customer records or cloud resources.

## Acceptance scope

Automated checks cover workspace isolation and precedence, revision conflicts,
atomic rejection, persistence, expiry, removal without granting authority, HTTP
operator metadata, current management-role checks, provider-session restart and
the shipped UI's save/remove/refresh handlers. UI behavior runs with a DOM test
double, not a rendered browser. A real browser walkthrough and hosted authority
acceptance remain open; no live business policy, staging release or production
deployment was changed by these tests.

See the [evidence register](acceptance-evidence.md) for commands and results and
the [delivery index](README.md) for the next eligible implementation work.
