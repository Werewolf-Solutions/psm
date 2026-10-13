# Werewolf Watch

First-party public monitoring; no external account or monitoring subscription.
Decision: [ADR 0006](adrs/0006-werewolf-watch.md).

## Current installation

`psm-watch.service` runs on werewolf-alpha. It checks these endpoints every
60 seconds with a ten-second deadline:

| Monitor ID | Endpoint | Check |
| --- | --- | --- |
| todo-staging-web | https://todo.werewolf.solutions/ | HTTP 200 and trusted TLS |
| handymanservices-staging-web | https://handymanservices-staging.werewolf.solutions/healthz | HTTP 200, JSON `ok: true`, trusted TLS |
| werewolf-staging-api | https://staging.werewolf.solutions/api/v1/health | HTTP 200 and trusted TLS |

All three passed live checks on October 6. This is a **same-host** observer.
A separate company server is required for whole-server outage coverage.

Todo's committed manifest declares `todo-public-web` with provider key
`todo-staging-web`, hostname `todo.werewolf.solutions` and a 300-second freshness
limit. The local `monitor` slot is bound to `werewolf-watch-alpha-reader`.
The managed configuration commit assigns source version 0.6.6; the active
application remains verified 0.6.5 until a subsequent app build/release.
Monitoring does not require changing the running app.

## UI

Open **Todo → Deploy**. Public Watch appears in the pinned release summary.
Click **View monitoring →** next to Public Watch, or open the **Monitoring** tab.
The tab has 24-hour and 7-day views, hourly availability/failed-check and response
time graphs, CPU/memory/disk graphs, resource totals, confirmed incident time
and the latest incident history. Hover points for values. Select the environment
and refresh independently of deployment controls.

The **Werewolf monitoring** section in Deploy also shows health, latency, TLS
expiry and open or recovered incidents. **Refresh monitoring** reads the independent observer;
the view also refreshes every minute while open. Old evidence becomes stale.
The Connections form defaults to Werewolf Watch and uses a read-only SSH key.
Do not paste private keys into notes, logs, tickets or evidence.

## Build and install

Requires a trusted Node 22 runtime with `node:sqlite`, Linux/systemd, and a
previously verified SSH server key. Build using `npm run watch:build`.
Review `scripts/watch/monitors.json` and `scripts/watch/install.sh`.

For a new server, stage `dist/watch.mjs` as `watch.mjs`, the config as
`monitors.json`, `install.sh`, and a single generated Ed25519 public reader key
as `reader.pub`. Run the installer as root with `WATCH_NODE_SOURCE` pointing
to the trusted Node binary and `WATCH_FAILURE_DOMAIN` set to `same-host` or
`independent-host` as appropriate. Generate the key through PSM's SSH transport
and save the private part directly through its secret broker. The administrator
connection is used only for reviewed installation; monitoring uses its own key.

Installer owns only `/opt/psm-watch`, `/etc/psm-watch`, `/var/lib/psm-watch`,
`/var/lib/psm-watch-reader`, two dedicated accounts and `psm-watch.service`.
It does not edit existing application services or Nginx routes. Existing
unowned installation directories/accounts cause installation to stop.
The reader's forced command allows only `watch <monitor-id>`; shell commands,
port forwarding and interactive access are disabled. Host identity is pinned.
Its output includes public health evidence only.

## Operations and recovery

- `systemctl status psm-watch.service` checks the observer itself.
- `journalctl -u psm-watch.service` contains incident/recovery transitions.
- `/var/lib/psm-watch/watch.db` stores samples and incidents. Preserve this
  directory when upgrading. Back it up using SQLite's online backup mechanism.
- Edit the root-owned config and restart this service after validating it with
  `monitorsFromConfig`. PSM manifests must use the same IDs and hostnames.
- A stopped observer retains its last receipt; PSM marks it stale after five
  minutes, or unknown when it cannot read the observer. Never create synthetic
  healthy receipts to clear a deployment gate.
- To recover, restore the bundle/config or trusted runtime, start the service
  and require new real checks. Service restarts preserve incident state.
- Removal: stop/disable `psm-watch.service`, remove its unit, and review removal
  of the dedicated accounts and owned directories. Keep incident history for
  the agreed retention period. Remove only corresponding monitor bindings.

Validate outage/recovery on a disposable test endpoint, not by taking a
customer application down. Automated tests exercise real HTTPS with a trusted
local certificate, rejected certificates, incorrect health JSON/status,
timeouts, oversized responses, TLS warnings, durable incidents and stale or
mismatched receipts. Live acceptance also verifies forced-command refusal.

## Remaining acceptance

Handymanservices staging is being probed independently but its committed PSM
manifest has not yet declared/bound the monitor. Its production migration must
use its own production-scoped monitor and target. Add a second independent
Werewolf observer and company notification delivery before treating this as
complete production monitoring. Synthetic sign-in/API journeys, metrics and
central logs are subsequent milestones; public uptime is only one signal.

## Monitoring dashboard, October 6 — PSM 0.3.33

The collector reads Linux CPU counters, available memory and the filesystem
containing `/srv` as its unprivileged service account. CPU is the busy fraction
between minute samples, with guest ticks excluded from the total to avoid
counting them twice. The first sample after a restart has no CPU delta and is
shown as unavailable until the next sample. Memory use is total minus available
memory; disk use is allocated blocks on the filesystem, including other apps.
Load and system uptime are captured alongside these metrics.

SQLite stores resource samples for seven days. Hourly buckets contain mean CPU,
memory and load; disk buckets show their maximum observed usage. Availability
is the passing fraction of recorded checks (certificate warnings retain public
availability); missing observations do not become successful checks. Confirmed
incident time is summed from all stored incidents intersecting the selected
window, independently of the latest-20 incident list. Short unconfirmed failures
are visible as failed checks; incident intervals can contain gaps between probes.

Resource metrics identify the observer host. The current observer also hosts
Todo; if an independent observer is introduced, its CPU/disk graphs do not
represent the app server. A target-side collector will be needed in that case.
Metrics older than five minutes are shown as unavailable. No credentials,
process environments or customer records are collected.

History grows from real samples; graphs do not invent earlier data. Automated
rendering checks verify the actual dashboard script, missing CPU values, gap
handling, failed-check graph marks and incident window clipping. Live API and
served assets were checked; rendered-browser acceptance remains separate.
