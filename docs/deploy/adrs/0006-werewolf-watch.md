# ADR 0006: Werewolf-owned monitoring

Status: accepted, 2026-10-06. Supersedes ADR 0001 as the default monitoring choice.

## Decision

The operator requires monitoring without a Better Stack account. Build and run
Werewolf Watch on company infrastructure. PSM reads its snapshots through a
pinned SSH connection with a forced command and a dedicated read-only key.
The existing monitor interfaces remain compatible; existing Better Stack
connections are optional legacy adapters and are not required by this workflow.

Watch runs independently of the cockpit as a systemd service. Public HTTPS
checks validate the expected status, TLS trust and expiry, and optionally a
small JSON health predicate. Two consecutive failures confirm an incident;
two successes recover it. Unconfirmed failures cannot remain green. SQLite
retains samples for seven days and resolved incidents for ninety days; open
incidents remain until recovered. Journald records incident transitions. No
response bodies, credentials, customer records or headers enter the evidence.

PSM shows health, observation age, latency, certificate expiry and incident
history. Refresh reads monitoring only; it does not build or deploy. Receipts
older than the manifest freshness limit become stale, and unavailable observers
become unknown. Existing fresh-watch release policy uses these same receipts.

## Failure domains and next milestones

The initial werewolf-alpha installation shares the applications' server and is
labelled `same-host`. It detects application, public routing and TLS failures
while the server is running. It cannot itself detect the entire server losing
power or connectivity. An unreachable reader gives PSM unknown evidence.

Production acceptance needs a second company-controlled observation host in a
separate failure domain, plus tests that prove down/recovery notification and
whole-host failure detection while the cockpit is closed. No external monitoring
account is needed. Initial notifications are recorded incidents in PSM and
journald; background delivery into the Werewolf company notification system is
an explicit follow-up. HTTP health does not establish sign-in or business/API
contract correctness.

The broader zero-external-account goal belongs to the ecosystem roadmap.
Existing GitHub and DigitalOcean deployment connections are still in use;
this monitoring implementation does not remove those dependencies.
