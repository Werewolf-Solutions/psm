# P08 — application deployment and operations milestones

Status: in progress. Delivery priority and dependencies are owned by the
[delivery index](README.md); evidence is collected in the
[acceptance register](acceptance-evidence.md).

P08 is an umbrella for independently accepted capabilities. Its first Node
service release is recorded; completing that release does not complete worker,
database or recovery support. Later phases depend on named milestones below,
so an unrelated recipe does not block every other feature.

| Milestone | Deliverable | Prerequisites | Acceptance and recorded position |
| --- | --- | --- | --- |
| **P08a.1 — service baseline** | Immutable frontend + Node service, scoped systemd runtime, secrets, nginx/TLS and public probes. | P07 local release baseline; usable P07a controller for the selected target. | Handymanservices staging version 1.0.1 verified in run `run_29d57729336843e6` on 2026-10-01. This milestone has recorded target acceptance. |
| **P08a.2 — service recovery** | Repeated release, retained manual rollback, failed-release recovery and secret/config compatibility. | P08a.1. | Through PSM on staging, deploy a newer release, restore retained bytes, inject a failed verification and prove recovery with public probes. Homelab helper-level rollback evidence exists; this complete managed-target acceptance remains open. |
| **P08a.3 — uninterrupted switching** | Start and health-check a candidate before traffic switches, drain the previous service and retain recovery. | P08a.2. | Continuous requests during switching show no release-induced failed requests; a failing candidate receives no traffic and the old service remains available. Record concurrent-session behavior and rollback. Required follow-up, pending. |
| **P08b — workers and application jobs** | Independently released workers and application schedules, queue health, graceful draining and compatible messages. | P08a.2 plus the chosen queue/runtime adapter. | Update a representative API + worker app, prove retry/idempotency, drain/restart and recovery without losing or duplicating accepted work. Pending. |
| **P08c — databases and migrations** | Scoped data-service adapters, versioned migrations, backup scheduling and restore-tested recovery. | P08a.2 plus an explicit database recipe and data owner. | With disposable data, prove ownership, backup/restore, a compatible migration, a failed migration and recovery. Record recovery time and data-loss objectives. Production use additionally needs evidence for that actual data service. Pending. |
| **P08d — operational observation** | Service status, logs, external Watch, dependency health, capacity and retention information in PSM. | P08a.1 and the selected observation providers. | Induce a service/dependency failure, detect it externally while the UI is closed, show the affected target and recover. Record CPU/memory/disk headroom and artifact retention. Pending; immediate release probes are already evidenced separately. |
| **P08e — machine operations** | Whole-machine CPU, memory, disk, process, port and app/worker status; approved Start, Stop and Restart for named PSM-managed units. | P04 machine identity/access, P02 operator policy, P08a.1 for app units; P08b for managed workers. | A read-only snapshot distinguishes stale/partial data; a bounded, revocable host grant controls one named unit without general sudo; a reviewed action verifies post-action state. Unowned processes remain observe-only. Pending. [Feature plan](../deploy/MACHINE-OPERATIONS.md). |

P08d covers external and dependency observation; P08e adds a machine-level
inventory and bounded controls. Worker queue and heartbeat health use the
application's read-only probe when available; process state alone is
insufficient. The existing machine administrator account is not the authority
model for routine P08e controls. The current Handymanservices nginx cutover is
an explicit reviewed playbook, not a generic process operation.

P08a is delivered by the [Node-service recipe](../deploy/NODE-SERVICE-RECIPE.md).
It continues to accept a restart gap until P08a.3 is proven. Native modules and
container images need their own recipe acceptance; a host OS/runtime upgrade in
M1 can unlock that work. M1 inventory can start after P04's machine inventory,
while application migration uses the relevant P08a.2 rollback path.

P08b's application schedules execute product workloads. P09's schedules execute
PSM maintenance/control tasks. Both use durable jobs and current authority, but
neither milestone implies the other is implemented.

P09 and P12 use P08a.2/P08a.3/P08d/P08e where their target needs them. A static target
uses its equivalent accepted recipe. Any target with persistent data must have
an accepted backup/restore and migration path before automatic production is
enabled; this can use an existing proven provider procedure while the general
P08c adapter is still pending. The P08 umbrella closes only when every milestone
has its own accepted result.

Distributed traffic rollout and regional scaling belong to P13. P08 covers one
representative service, worker and data stack with clear operational recovery.

## Capacity decisions and historical observations

User clarification, 2026-10-05: **print-shop is intentionally stopped to free
capacity on the droplet**. Its restoration is not an active roadmap incident or
prerequisite. The October 1 recipe notes about disk contents and missing
dependencies remain historical evidence to check if the owner later chooses to
restart it. Restarting any unmanaged app requires checking that its on-disk code
and configuration can start successfully.

## October 6: company-owned monitoring implementation

[Werewolf Watch](../deploy/WEREWOLF-WATCH.md) now runs on werewolf-alpha,
checking Todo staging, Handymanservices staging and the Werewolf staging API.
Todo has its committed monitor binding and PSM health/incident panel. This
closes the first-party public probe implementation; P08d production acceptance
still requires an independent Werewolf host, company notification delivery and
an outage/recovery exercise with the cockpit closed. No external monitoring
account is a prerequisite. Evidence is in the [acceptance register](acceptance-evidence.md).
