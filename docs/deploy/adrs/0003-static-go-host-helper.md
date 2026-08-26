# ADR-0003: The privileged host helper is a static Go service

Status: accepted — 2026-08-26

## Decision

The Linux target helper is a small Go binary built with `CGO_ENABLED=0`, installed root-owned at
`/usr/local/libexec/psm-host-helper`, and exposed by a root-owned systemd service over a
group-restricted Unix socket. SSH identities reach that socket only through the helper's fixed
`client` command. Root-owned target contracts live below `/etc/psm-deploy/targets`; state,
receipts and definitive lock files live below `/var/lib/psm-deploy`.

Infrastructure and release SSH identities use separate non-root Unix accounts. Their numeric UIDs
are enrolled per target and operation class in the root-owned contract. Clients send one framed,
versioned JSON request plus optional archive bytes and receive one bounded framed JSON result. The
helper accepts neither shell text nor caller-selected argv. Enrollment is a separate local-root
command and cannot be requested through the protocol.

## Why

A static binary gives the smallest install and dependency surface for a root-owned component. Go's
standard library supplies strict JSON decoding, descriptor-oriented filesystem APIs, hashing and
process execution without installing Node or repository dependencies on the 1 GB production host.

## Consequences

- The repository publishes checksummed Linux amd64/arm64 helper artifacts.
- system packages still provide nginx, certbot and PM2; the helper probes and reports when one is
  unavailable.
- Helper protocol changes require a new explicit protocol version.
