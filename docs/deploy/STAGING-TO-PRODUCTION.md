# Todo monitoring and Handymanservices production migration

Started 2026-10-06. Operator direction: finish Todo staging monitoring first,
then replace the Handymanservices staging address with
`handymanservices.werewolf.solutions`. The old staging address is retained only
until the cutover is verified and recovery is available.

## Observed baseline

| Application / address | Verified position | Remaining work |
| --- | --- | --- |
| Todo, `todo.werewolf.solutions` | Managed staging 0.6.5, commit `cc9942ab317c2f652f68c137c6917a2a1f1995f9`; public release metadata matches. | Werewolf Watch installed; Todo monitor declared and bound. |
| Handymanservices, `handymanservices-staging.werewolf.solutions` | Managed staging 1.0.1, commit `ff17b6a769c3be1a316a98040725d2adc568661b`; public health JSON and release metadata match. Nginx proxies to `127.0.0.1:41000`. | Monitor the service and prepare the production cutover. |
| Handymanservices, `handymanservices.werewolf.solutions` | Existing legacy Nginx site proxies to port 3001; PM2 app `handymanservices` is online. Responses at `/healthz` and `/version.json` are HTTP 200 but do not contain the managed health/release metadata. | Transfer routing to the managed deployment with a recovery path. |

Read-only inventory found approximately 247 MiB memory available and 16.5 GiB
disk available on werewolf-alpha. Recheck immediately before provisioning or
activation. Printshop remains intentionally stopped. Evidence:
[sanitized host inventory](../evidence/staging-production-inventory-2026-10-06.json).
No customer records, credentials or process environments were read into evidence.

## 1. Finish Todo staging monitoring

The operator replaced the Better Stack direction with **Werewolf-owned
monitoring and no external monitoring account**. See [Werewolf Watch](WEREWOLF-WATCH.md)
and [ADR 0006](adrs/0006-werewolf-watch.md).

The independent systemd service is installed on werewolf-alpha and public
Todo, Handymanservices staging and Werewolf staging API checks pass. Todo's
monitor declaration is committed through its existing managed source grant
and bound to a restricted reader connection. Deploy refresh reads snapshots
without building or deploying. Certificate expiry, latency and durable
incidents are visible. Monitoring can continue with the cockpit closed.

This initial observer shares the app server: it is explicitly labelled
`same-host`, not full server-outage coverage. A second company-controlled host
and company notification delivery remain production acceptance gates. Browser
sign-in and business API correctness need separate acceptance. Existing
GitHub/DigitalOcean deployment accounts have not been removed by this change.

## 2. Move Handymanservices to the requested production address

The [production manifest draft](candidates/handymanservices-production.draft.json)
has passed `parseDeploymentManifest` using the actual project checkout and is
committed in the app as version 1.0.3. It declares only production and includes:

- production risk and authenticated local approval;
- current source branch `dev`, reachable-source and check requirements;
- separate target `werewolf:handymanservices-production-web` and root
  `/srv/handymanservices.werewolf.solutions`;
- the requested hostname in DNS, TLS, frontend configuration and verification;
- a production build profile and fresh external-monitor requirement.

Its Werewolf monitor key is `handymanservices-production-web`; a bootstrap check
of the current main route is healthy. Change it to managed JSON health verification
after the production health endpoint is available. Existing staging connections and
runtime secrets do not automatically authorize production. Production bindings,
credentials, GitHub controller target/environment and host enrollment must be
reviewed and scoped for this target. Verify the chosen source checks and prepare
the correct artifact; the draft does not declare that those gates are satisfied.

Cutover sequence:

1. Accept Todo monitoring, then add a monitor for Handymanservices staging
   (`/healthz`) and verify the managed service's current health and retained release.
2. Preserve the legacy route, TLS configuration and process restart information;
   test a concrete route-restoration procedure. Recheck capacity and source.
3. Prepare the production bindings, service secrets, target enrollment, build and
   exact infrastructure/release plans. Verify configuration uses the intended API
   service; the existing staging manifest already points to the production
   Werewolf API. Do not infer backend isolation from the environment name.
4. Review the transfer of the existing legacy Nginx route. Existing-target setup
   returns the saved access, and replacement rebuilds its recorded hostname;
   renaming the old manifest alone cannot retarget that enrolled contract. The
   new production target needs its own enrollment. Legacy Nginx ownership must
   be transferred explicitly before enabling the helper-managed site, so two
   enabled sites do not compete for the same hostname.
5. Apply the reviewed cutover and verify the managed production release at `/`,
   `/healthz` and `/version.json`, its systemd state, external health and TLS.
   Record any activation gap; the current Node recipe accepts a restart gap.
6. After verification, retire the old staging address and the legacy PM2 process
   through the authorized migration cleanup after checking the successful run receipt. Keep retained bytes and the tested
   recovery route until the recovery window is closed. Do not delete shared
   services or modify other applications.

Production automation follows the accepted staging evidence and policy milestones
in [P12](../roadmaps/release-and-api-lifecycle.md). This first migration uses the
existing explicit production approval contract.

## Current next action

### Production route transferred; PSM Watch receipt still pending (2026-10-13)

The operator completed the guarded cutover. Public `/healthz` now returns
`{"ok":true}` and `/version.json` reports Handymanservices 1.1.0, commit
`625ff22266171ccac8523a82e2b3eae4ab87494d` and artifact
`artifact_67c6fb1bae6840e6893ff5e8`. The managed systemd service is active.
PSM runs `run_8c6b332c5bbd4de3` and `run_99e3a530a69e4b0f` passed the
release's health, home, metadata and process checks but stopped at the final
Watch observation. The observer itself reports healthy. Its seven-day history
makes the returned action result about 43 KB, exceeding the runner's 32 KB
durable-result limit. PSM now records only the current Watch verdict in that
action; the full history remains available in Monitoring. Restart the local PSM
server to load that fix, close the held read-only observation through the local
cockpit, then review and approve a fresh verification plan. Do not remove the
legacy recovery archive until PSM has a successful verification receipt.

### Production routing state observed 2026-10-13

PSM selected release `1.1.0` (`625ff22266171ccac8523a82e2b3eae4ab87494d`, artifact
`artifact_67c6fb1bae6840e6893ff5e8`) under the production target's `current`
symlink, but it has **no successful public verification receipt**. The managed
service `psm-svc-handymanservices-pr-366a60` is inactive after the failed first
release. Both nginx links remain enabled:

- `/etc/nginx/sites-enabled/handymanservices` routes this hostname to the legacy
  app on `localhost:3001`.
- `/etc/nginx/sites-enabled/handymanservices.werewolf.solutions` is the managed
  route to `127.0.0.1:41001`.

The public `/healthz` and `/version.json` currently return legacy HTML, so a
verification-only PSM run fails its `$.ok == true` check. Repeating that run
before transferring the route cannot verify this release.

The operator cutover is prepared in
[`candidates/handymanservices-cutover.py`](candidates/handymanservices-cutover.py).
Before its `switch` mode, start the managed unit under reviewed production
authority and confirm `http://127.0.0.1:41001/healthz` returns `{"ok":true}`
and its loopback `/version.json` names the exact commit, artifact and version
above. Inspect the unit journal if startup fails. The script checks the target
contract, legacy file digest, backup, managed proxy and candidate identity;
on public verification failure it restores the legacy nginx link. Run its
`inspect` mode first, then review the exact `switch` command with `--commit`,
`--artifact` and `--version` values above. It requires root on the target host.
After a successful public cutover, review a fresh PSM verification plan for the
same artifact. Retain the legacy process and recovery archive until PSM records
a successful verification receipt.

The controller setup, source publication, build and first release attempt have
already run. This cutover remains a separate production action. Independent
observer and company notification acceptance are still required before
production automation.


## Production preparation checkpoint — 2026-10-06

Handymanservices `dev` commit `4405cb7ee1367fae696037b80eda551306bd5f24`
(version 1.0.3) declares **production only** at the requested main hostname.
The staging service remains running for recovery until production verification
succeeds. Production DNS, GitHub App, host helper, CI release access and Werewolf
Watch connections are prepared with production scope. The operator selected the
existing production business identity; its service credentials are stored in the
production secret broker, with no values in this document.

PSM 0.3.34 permits targets to share an existing controller repository. The
Handymanservices production preview reuses
`Werewolf-Solutions/deployment-control-handymanservices` at
`28d07a9d6ceca09fc1ef9465bbd97cb645d02b4d` with **zero file changes**.
Each target retains a separate GitHub Environment and release key. Registration
preserves other target files and refuses changes to shared workflow/script files.
When registration advances the shared branch, unchanged verified peer bundles
receive compatible commit pins in one local database transaction. Changed peer
metadata or push access requires a fresh review.

The legacy route, PM2 process and staging service have **not been removed**.
A root-only recovery archive and bounded routing switch are prepared. Controller
apply, source publication/build, and production execution still require the local
cockpit reviews defined by the current deployment contract. The production monitor
currently checks the existing public root for availability; exact new-release
health/version checks remain required at cutover.

See [preparation evidence](../evidence/handymanservices-production-preparation-2026-10-06.json).


### Readiness navigation correction — PSM 0.3.35

The initial production profile still pins the pre-registration controller commit
until local setup apply succeeds. At that old commit, readiness can report the
production target file missing even though it exists on the current branch.
App-managed readiness now sends pin, target-file and environment-credential
failures to one **Review controller setup / update** task. It does not offer the
manual pin endpoint or GitHub file creation for those checks. The current main
bundle has been verified with zero proposed file changes; apply still needs the
local cockpit approval to install credentials and save the verified pin.


### Local operator policy — PSM 0.3.36, 2026-10-06

The operator clarified that local PSM must not require Werewolf sign-in. A verified
same-origin browser on the exact loopback cockpit can approve source publication,
production deployment, held-run recovery and production cancellation while signed
out. Existing authenticated approval modes retain their hosted/remote meaning;
local mode records the machine operator instead. One-use actor-bound intents,
review digests, acknowledgements and expiry still apply. The session endpoint
advertises the local capability so the UI does not open sign-in for these approvals.
A valid waiting publication review survives restart without starting any work.
Hosted SaaS sign-in and workspace authorization are deferred to the roadmap's
hosted authorization milestone. No publication or deployment is approved by reload.


### Repeated stale-plan correction — PSM 0.3.37

Run `run_f8fa593b0c1f471a` stopped before locks because rolling Werewolf Watch
telemetry was included in the approved plan digest. A read-only rebuild using
the live adapters showed only monitoring-history and probe-duration differences;
source, policy, target and credentials had not changed. Canonicalization now
excludes those diagnostics while preserving health and identity checks. No old
approval is replayed; the next infrastructure review uses the corrected digest.
