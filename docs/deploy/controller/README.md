# Release controller draft

**Current status, 2026-09-29:** Todo's controller repository exists and its
verified commit `661ab2bb67a19225fb0d1b388532a6ddf1a1e657` delivered the first
successful managed release. The files here are the reviewed source for a PSM
button that previews and publishes a controller bundle. For an App-bound
connection, PSM generates a workflow variant using `PSM_SOURCE_READ_TOKEN` in
place of the legacy artifact-reader App key. That variant is locally tested but
has not yet been applied to the live controller. The legacy workflow below
describes the existing controller and its historical pin.

A reviewed source of the contents of `Werewolf-Solutions/deployment-control`, the
repository where the `werewolf-static@1` release controller runs.

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

## Legacy setup requirements

These were the manual requirements for the original Todo controller. P07a's
generated bundle replaces the first requirement and automates the controller
files, branch and Environment checks after GitHub Create/Install consent:

1. **A GitHub App** with Actions-read on the source repositories, installed in the org. Its
   ID goes in `vars.PSM_ARTIFACT_READER_APP_ID`, its key in
   `secrets.PSM_ARTIFACT_READER_PRIVATE_KEY`. Creating and installing the App is a repository
   *owner* action in GitHub's web UI; nothing in this repository can do it. [P07a](../../roadmaps/github-button-setup.md)
   replaces this App with a per-release token minted by PSM's own GitHub App. **The action pin
   it used to need is now resolved — see below.**
2. **The host helper installed on the droplet**, with this target enrolled. Enrollment is
   where `contractRevision`, the deploy account, the canonical root and the host key
   fingerprint come from — every `REPLACE_…` in `targets/*.json`.
3. **A GitHub Environment per target** in the control repository, named by that target
   file's `githubEnvironment`, holding `PSM_TARGET_SSH_PRIVATE_KEY` and
   `PSM_TARGET_KNOWN_HOSTS`, with whatever protection rules the target's risk deserves.

## The action pin

`actions/create-github-app-token` is now pinned to a **full commit SHA**, resolved and
reviewed on 2026-09-21 rather than guessed:

```yaml
uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
```

A SHA and not a tag, because this is the one step that holds the App's private key and a
tag can be repointed at any time by anyone who can push one.

| | |
|---|---|
| Resolved how | `GET /repos/actions/create-github-app-token/git/ref/tags/v3.2.0` → a lightweight tag pointing straight at this commit (no tag object to dereference) |
| Release | v3.2.0, published 2026-05-12 |
| Commit signature | verified |

**Why v3 and not the v2 line this draft originally named.** v3.0.0 has exactly two breaking
changes and neither reaches this workflow: custom proxy handling was removed (it now needs
`NODE_USE_ENV_PROXY=1`, and this workflow sets no proxy), and self-hosted runners must be
on Actions Runner ≥ v2.327.1 (both jobs are `runs-on: ubuntu-latest`). v3 is the maintained
line, and its release commit carries a verified signature where the latest v2 release commit
(v2.2.2, `fee1f7d63c2ff003460e3d139729b119787bc349`, 2026-03-13) does not.

To stay on v2 instead, use that v2.2.2 SHA — it is recorded here so the choice does not have
to be re-derived. Re-review on every bump; a pin is only as good as the last time somebody
looked at what it points to.

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
