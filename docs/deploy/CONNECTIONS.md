# Deployment connections

Open a project's Deploy pane, expand **Add a connection**, and fill in the labeled
fields. PSM fills in the project, environment, and declared deployment settings.
Review those settings, choose **Create and use connection**, then save the API
token or SSH private key in the credential field. Private keys can also be uploaded
as a file. Credentials are stored separately from the public connection settings.

PSM also reuses public settings from a compatible saved connection. For the static
release controller it suggests the documented repository and workflow, reads the
target's GitHub Environment from that repository, and pins the release ref and
the commit/file hashes from a matching local checkout, or through an existing
GitHub CLI login when no unique checkout is available. These lookups are read-only and cached for
one minute. Each detected field names its source and remains editable; public
edits survive readiness refreshes. Missing settings remain blank when they cannot
be discovered, and saved review pins are never silently replaced.

JSON is an advanced import format, not a requirement for ordinary setup. Use
**Advanced: import JSON** for custom scopes, different release controllers per
target, or provider-specific options. Imported profiles can be selected with
**Use connection**.

## JSON templates

- [Host connection](examples/host-connection.json)
- [GitHub connection](examples/github-connection.json)

These are templates, not discovered server settings. Replace every `REPLACE_…`
value, including object keys. Set the environment, risk, branch names, directories,
and workflow filenames to match your deployment. The project ID appears in the
advanced import panel. The target ID must match the deployment manifest and the
enrolled host target. Do not put private keys or API tokens in these files.

## Host settings

The host must already have the [PSM host helper](../../host-helper/README.md)
installed and its target enrolled. Use the enrolled deployment account, release
directory, target contract fingerprint, and contract revision.

The SSH host key is the server's public identity, separate from your private login
key. Supply a verified `known_hosts` entry and its matching SHA256 fingerprint.
For a nonstandard port, the entry must name `[hostname]:port` and the profile's
SSH port must match. The public IPv4 address is used by DNS records that point to
this host.

## GitHub settings

The build workflow must implement PSM artifact preparation. The release workflow
must implement the PSM static release controller; arbitrary Actions workflows do
not satisfy those contracts. The release repository can differ from the source
repository.

The guided form asks for the release repository, and for the GitHub Environment
only when it cannot read one. PSM pins the release controller itself: it takes the
release ref, the commit that ref resolves to, and the release workflow's blob hash
from a local checkout of that repository or through your GitHub CLI login, then
shows what it pinned and where it came from. Before every release it rechecks that
the ref still resolves to the pinned commit and that the workflow file still
matches the pinned blob, so a workflow rewritten after review cannot deploy.

When PSM cannot read the release repository — it does not exist yet, or there is
no checkout and no GitHub CLI login — the connection can still be created and
bound. It prepares artifacts, and the environment reports a
`release-controller-unpinned` blocker until the pins can be read. Nothing is
invented, and no hash is ever typed by hand.

Set the pins explicitly through **Advanced: import JSON** only for a controller PSM
cannot reach. In a checkout of the release repository, these read-only commands
return them:

```sh
git rev-parse <reviewed-ref>
git rev-parse <reviewed-ref>:.github/workflows/<release-workflow.yml>
```

The second hash identifies the Git blob, not a SHA256 checksum of the file, and the
profile's release ref must resolve to the pinned commit.

Add the GitHub API token through the credential form after creating or importing
the connection.
