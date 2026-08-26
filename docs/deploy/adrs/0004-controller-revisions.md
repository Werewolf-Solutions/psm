# ADR-0004: Controller revisions are immutable release tags

Status: accepted — 2026-08-26

## Decision

`Werewolf-Solutions/deployment-control` advances through signed or GitHub-verified `controller-vX.Y.Z`
release tags. A PSM connection pins the full tag commit and the release workflow blob SHA. Existing
tags are never moved. Updating the controller is a local-policy revision: observe the new commit and
blob, review the diff, then create a new connection metadata revision before any plan may use it.

The default branch is protected, pull requests and passing controller tests are required, and the
production Environment requires an approving reviewer. Workflows and third-party actions are pinned
to full commits.

## Why

An immutable, human-readable tag is operable during an incident, while the full commit/blob pins
retain the exact trust property. Moving a convenient major tag would make an old approval dispatch
different code.

## Consequences

- Controller upgrades deliberately invalidate pending plans.
- Emergency fixes publish a new tag; they never rewrite the tag a plan reviewed.
