# ADR-0001: Better Stack supplies external Watch

Status: accepted — 2026-08-26

## Decision

`external-http-monitor@1` binds an already-created Better Stack Uptime monitor by numeric monitor
ID. PSM reads `GET /api/v2/monitors/:id` and unresolved incidents through a locally stored API
token. It validates the returned URL hostname, requires TLS verification and a configured SSL
expiration threshold for HTTPS targets, and normalizes provider timestamps and states. It never
creates, edits, pauses, or deletes a monitor.

The monitor remains authoritative for continuous health while PSM is stopped. A missing, paused,
pending, mismatched, or stale monitor is not healthy. Certificate-expiry incidents are surfaced
with their provider-reported expiry; absence of such an incident is not represented as a measured
expiry date because Better Stack's monitor response does not publish one.

## Why

Better Stack is off-machine, supports uptime and TLS checks on the same monitor, exposes a bounded
HTTP API, and was selected by the operator. Read-only observation keeps PSM from turning provider
account authority into an implicit side effect of planning.

## Consequences

- The operator creates the monitor and API token out of band, then binds its ID locally.
- TLS-expiration alerting requires a Better Stack plan that supports it.
- API responses are schema-checked and reduced to normalized evidence before persistence.

## Superseded default, 2026-10-06

[ADR 0006](0006-werewolf-watch.md) replaces the external account requirement with Werewolf-owned monitoring. Existing adapters remain optional compatibility.
