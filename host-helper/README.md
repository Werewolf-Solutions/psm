# PSM host helper

`psm-host-helper` is the only component in managed static deployments that runs as root. It accepts
the closed `psm.werewolf.solutions/host-helper-request/v1` framed protocol over a Unix socket and
authorizes every operation against a root-owned target contract and the connecting Unix UID.

## Build and test

```sh
go test ./...
CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o dist/psm-host-helper .
```

`psm-host-helper digest --root <tree>` is the unprivileged cross-implementation check used by
artifact packaging tests. It performs no mutation and gains no privilege from the installed file.

Build separately for `GOOS=linux GOARCH=amd64` and `arm64`, publish the SHA-256 checksums, then run
`packaging/install.sh` as root from this directory. The install creates only the service, group and
root-owned base directories. Target enrollment remains explicit:

```sh
sudo /usr/local/libexec/psm-host-helper enroll < target.json
```

Each SSH key is attached to a non-root account whose UID is named in that target contract. Restrict
the key in `authorized_keys` to `command="/usr/local/libexec/psm-host-helper-client",restrict`.
The account must belong to `psm-deploy`; it receives no sudo permission. Infrastructure and release
keys should use different accounts so the target contract can authorize different operations.
