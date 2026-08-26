# ADR-0005: Retain artifacts for 30 days and five target releases

Status: accepted — 2026-08-26

## Decision

Prepared GitHub artifacts request 30-day retention. A target retains at least five completed
releases per unit, always including the active release, its immediate predecessor, and every
release referenced by a non-terminal PSM run. Immutable receipts are retained after their bytes are
garbage-collected. A manifest may request a larger release count but never a smaller one in
production policy.

## Why

Thirty days covers ordinary discovery and approval delays without treating GitHub as the permanent
release archive. Five target copies give several immediate rollbacks while keeping small static
sites cheap on the shared host.

## Consequences

- Rollback past retained target bytes is unavailable even if source history remains.
- Garbage collection is lock-protected, refuses referenced releases and records what it removed.
- Provider retention shortening blocks plans whose selected artifact would expire first.
