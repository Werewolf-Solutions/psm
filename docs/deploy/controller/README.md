# Release controller draft

A draft of the contents of `Werewolf-Solutions/deployment-control`, the repository the
`werewolf-static@1` release controller lives in. **Nothing here has run.** The repository
does not exist yet, and this is kept in psm so the controller can be reviewed before it
does.

```
release-static.yml            → .github/workflows/release-static.yml
scripts/psm_controller.py     → scripts/psm_controller.py
targets/werewolf__psm-production-web.json → targets/…
```

## What it does

PSM dispatches `release-static.yml` with 20 inputs and later reads back one artifact.
The workflow runs as two jobs, and the split is the point:

- **`contract`** holds no credentials. It recomputes `execution_contract_digest` over the
  contract PSM sent, rejects it unless the digest matches, checks every flat input against
  the contract field that duplicates it, refuses an expired plan, and reads
  `targets/<targetId>.json` at the pinned commit to learn which Environment this target is
  allowed to use. A caller cannot name the Environment whose credentials it wants.
- **`release`** runs in that Environment. It mints a short-lived installation token scoped
  to the source repository, downloads exactly the approved artifact ID from exactly the
  approved run, proves the archive hashes to the approved `archive_digest`, deletes the
  token, then speaks the host helper's framed protocol over SSH: one
  `deploy-static-release` request that stages, activates, re-checks the PM2 invariant, runs
  the contract's probes and conditionally rolls back. It writes the result even on failure.

The canonical-JSON and digest implementation in `scripts/psm_controller.py` was verified to
produce byte-identical output and identical digests to `src/server/deploy/canonical.ts`,
including non-ASCII strings, escapes and nested key ordering.

## Before this can exist

None of these are in place, and the first two are outside psm:

1. **A GitHub App** with Actions-read on the source repositories, installed in the org. Its
   ID goes in `vars.PSM_ARTIFACT_READER_APP_ID`, its key in
   `secrets.PSM_ARTIFACT_READER_PRIVATE_KEY`. The `actions/create-github-app-token` ref in
   the workflow is a `REPLACE_…` placeholder — pin it to a reviewed full commit SHA rather
   than a tag. It is deliberately not filled in with a guess.
2. **The host helper installed on the droplet**, with this target enrolled. Enrollment is
   where `contractRevision`, the deploy account, the canonical root and the host key
   fingerprint come from — every `REPLACE_…` in `targets/*.json`.
3. **A GitHub Environment per target** in the control repository, named by that target
   file's `githubEnvironment`, holding `PSM_TARGET_SSH_PRIVATE_KEY` and
   `PSM_TARGET_KNOWN_HOSTS`, with whatever protection rules the target's risk deserves.

## Known gaps

These are real disagreements between existing contracts, not things left to write. The
release version the helper requires used to be one of them; it now travels inside the
approved contract as `artifact.version`, covered by `execution_contract_digest`.

- **The helper does not attest the contract revision.** It returns `targetDigest` — a plain
  SHA-256 over its own target file (`host-helper/server.go:116`), which the draft checks
  against `contract.target.fingerprint` — but nothing in the deploy receipt carries the
  revision. The revision check is therefore control-repository-side only.
- **PSM does not read `targets/*.json` yet.** `DEPLOYMENT-SYSTEM.md` §11.2 says PSM hashes
  that file at the pinned commit before approval; today `runtime-adapters.ts:271` takes the
  fingerprint and revision from the bound connection profile's `targetContracts` instead.
  Until that changes, the two must be kept in agreement by hand.
- **Target file naming.** The spec says `targets/<targetId>.json`, but a canonical target ID
  contains a colon. The draft maps `:` and `/` to `__`. If PSM starts reading these files it
  must use the same rule.
