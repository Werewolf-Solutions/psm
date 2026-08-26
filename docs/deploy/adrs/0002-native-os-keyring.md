# ADR-0002: Native OS keyrings persist local secrets

Status: accepted — 2026-08-26

## Decision

PSM uses `@napi-rs/keyring` to store managed-deployment secret slots in the operating system's
credential service. Each connection/slot address is encoded into a versioned account name under
the `werewolf.psm.deployments` service. A keyring-resident index lists slot names without exposing
values. SQLite continues to store only readiness, generations, constraints and keyed fingerprints.

At process start the backend probes the keyring. If the native service is unavailable or locked,
PSM chooses its existing zeroizing in-memory backend for that process and reports the backend as
ephemeral. It never falls back to a plaintext file. Backend selection does not switch halfway
through a process.

## Why

The former default lost every deployment credential on restart. The archived `keytar` package is
not suitable for a new Node 22 integration; `@napi-rs/keyring` provides current prebuilt native
bindings while preserving the same OS-owned trust boundary.

## Consequences

- Headless Linux agents need a Secret Service implementation and an unlocked session keyring for
  persistence.
- A process using the memory fallback must be restarted after the keyring becomes available.
- Backup code continues to exclude credential material because the values do not belong to PSM's
  database or filesystem.
