# Machine observation and approved operations

Status: proposed, 2026-10-13. This defines the next machine feature; it does
not grant PSM new host authority or change the current production route.

## Operator experience

The Machines view should open to a fresh, timestamped snapshot for each
registered host: uptime and load, CPU use, memory and swap, filesystem usage,
listening ports, systemd services, and the busiest processes. Show the owning
user, PID, command, CPU and resident memory for processes when the observer can
read them. Group PSM-managed deployment services separately from other host
services and processes. Link a PSM service to its project, environment,
release, target port and public health. A public site can be healthy while its
managed service is stopped, so show those observations independently. Label
partial data and stale snapshots rather than presenting them as healthy.

The detail view offers Start, Stop and Restart only for an app or worker with a
known supervisor unit and an installed operations grant covering that unit.
Show whether the unit is running, stopped, failed or restarting, its recent
exit reason, restart count and current resource use. For workers, also show
queue/heartbeat health when the application exposes it; a running process
alone does not prove that a worker is processing jobs. A process that is
merely visible in `ps` has no restart action: restarting requires its
supervisor, command, environment and working directory. "Remove" in the
operator's request means stop the running app or worker, **not** uninstall it,
delete its files or disable future startup. Unknown, shared and core host
services remain observe-only.

## Authority model

A web confirmation is the operator's **approval**, not an OS credential. Host
authority must be installed once by a person or an existing administrator. The
existing machine onboarding wizard already supports a one-time setup command
and a static Go host helper, but its administrator role currently includes
unrestricted passwordless sudo. Machine operations should instead use a
dedicated, revocable machine-level key and a narrow helper interface. The key
can request only allowlisted operations on named PSM-owned units; it cannot run
shell commands, edit nginx, access application secrets, or install/remove
arbitrary packages. Observation uses a separate read-only identity and works
without sudo where Linux permits it. If a metric or process detail needs more
privilege, report it as unavailable until the owner explicitly installs a
bounded read capability.

For each mutation, PSM must show a plan containing the exact machine, unit,
current state, requested result, public impact, recovery path and authority
grant. Approval is bound to that plan digest, actor, workspace and short expiry.
Re-read the unit identity and state immediately before acting; reject drift.
The server checks the authenticated operator and local/hosted authorization,
then sends the fixed operation to the helper. The helper independently checks
the grant and unit allowlist. Persist the request, approval, execution result
and fresh post-action observation in an audit log. A declined or expired popup
must have no effect. No generic `sudo`, shell, PID signal or file deletion
endpoint should be exposed through this feature.

Production actions need the existing deployment approval standard and a clear
impact warning. The operator may revoke the machine operations key without
removing deployment accounts. The setup screen should show exactly which units
and verbs the key controls, and how to revoke it. A production outage must not
silently create a broader grant. Existing SSH host-key pinning still applies.

## Delivery sequence and acceptance

1. Add a read-only machine snapshot endpoint and dashboard. Use a bounded
   collector, redact environment variables and secret-bearing command
   arguments, limit process rows and response size, and distinguish collector
   failure from zero usage. Validate on a disposable host and on the registered
   production host without changing either.
2. Add a separately installable operations grant for one named PSM-managed
   systemd app or worker unit. Plan, approve, start, stop and restart that unit;
   verify actual unit state and its local health after start/restart. Prove a
   different unit, changed plan, expired approval and revoked grant all fail
   closed. Keep unowned processes read-only.
3. Show worker heartbeat and queue health when the project declares a safe,
   read-only probe. Show "unknown" if no probe exists. Do not imply that a
   running worker is processing jobs successfully.
4. Add an explicit, reviewed route-cutover playbook for the current
   Handymanservices legacy nginx conflict. It checks the managed service's
   loopback health and exact release identity, transfers hostname ownership,
   verifies the public site and restores the previous route on failure. It is
   not a generic process-control action.

Success for the current incident means the managed service is running, nginx
has one effective owner for `handymanservices.werewolf.solutions`, the public
`/healthz` and `/version.json` return the managed release metadata, and a fresh
PSM plan records a successful verification receipt. A dashboard alone does not
complete that cutover.
