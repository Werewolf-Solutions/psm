# First PSM machine: Todo staging command access

Selected by the user on 2026-09-23: `46.101.29.222` (`werewolf-alpha`).
This is the first machine-onboarding bootstrap draft, not a completed PSM UI or
hosted runner integration. The host also serves other workloads; this setup
does not deploy applications or restart shared services.

**Product direction:** use the proposed [web machine-onboarding feature](../../../roadmaps/machine-onboarding.md)
for ordinary setup. The script below remains a concrete implementation reference;
continuing this manual procedure is not a prerequisite for designing or building
the reusable web flow.

## Verified remotely, 2026-09-23

- SSH as `lorenzo` succeeds using the existing pinned host identity.
- OS: Ubuntu 20.04.6 LTS, x86_64.
- `lorenzo`: UID 1000, member of `sudo`; `sudo -n -l` requires a password.
- `psm-infra`: UID 1001, `/bin/sh`.
- `psm-release`: UID 1002, `/bin/sh`.
- Both PSM accounts belong to `psm-deploy` (GID 998).
- `psm-host-helper.service` is active; helper and client binaries are root-owned.
- `psm-exec-todo-staging` does not exist; `/srv/psm` is absent.

The existing infra/release users should be reused. Enrollment contents and SSH
key restrictions still need verification through an authorized privileged read
or the helper protocol; account existence does not prove either.

## Prepared account

`bootstrap-command-user.sh` creates `psm-exec-todo-staging`, with a dedicated
Ed25519 key, a root-owned home/SSH authorization directory and a writable working
directory at `/srv/psm/commands/todo-staging`. It adds no sudo or helper membership.
The root-owned home keeps this account from replacing its authorized key policy.
Key authentication permits command execution with forwarding and PTY disabled.

This account has ordinary Unix process access. It can read world-readable files
and use network services available to the host. It is not a container or a tenant
isolation boundary. Application credentials and stronger execution isolation are
separate grants in the overall plan. The account cannot use ordinary home-based
tool caches until suitable writable paths are explicitly configured.

The script defaults to inspection and rejects a conflicting account, directory,
group or key. Apply must be run as root and can resume after partial setup.
It never reads the private key or changes existing deployment accounts.

## Apply and verify

The public key and script are staged at
`/home/lorenzo/psm-machine-setup/todo-staging-20260923/` on the selected server.
Both uploaded SHA-256 digests match their local files. The read-only preflight
passed on the server; invalid key input and apply without root were rejected.
No account has been created yet because the connected administrator requires
interactive sudo authentication.

Public-key fingerprint:
`SHA256:wOZ88ymtgGl6cUk8XFexwndPdaAhGjagkL8/r9R1lvk`.
The private key remains on the PSM development machine under ignored, private
`.psm-data/machines/46.101.29.222/psm-exec-todo-staging/` state. It was not uploaded.
That folder also contains `ssh-config` for subsequent connection verification.
This local key will need explicit import into the future hosted credential broker;
its existence does not make it available to hosted runners.

Run this from your development machine to authenticate sudo in your own terminal:

```sh
ssh -t -o StrictHostKeyChecking=yes lorenzo@46.101.29.222 \
  'sudo bash /home/lorenzo/psm-machine-setup/todo-staging-20260923/bootstrap-command-user.sh --apply /home/lorenzo/psm-machine-setup/todo-staging-20260923/id_ed25519.pub'
```

Do not enter the administrator password into a chat or store it in PSM files.

After apply, verify from the PSM machine using the dedicated key:

1. SSH authentication with strict host-key checking.
2. `id` reports the new account and only its own group.
3. Create/read/remove a temporary file inside its working directory.
4. `sudo -n true` fails and the helper socket is inaccessible to this account.
5. Re-running bootstrap with the same key preserves the UID and key; a different
   key or conflicting account is rejected.

From this checkout, the first connection check after apply is:

```sh
ssh -F .psm-data/machines/46.101.29.222/psm-exec-todo-staging/ssh-config \
  psm-todo-staging-exec 'id; cd /srv/psm/commands/todo-staging && pwd'
```

Root apply and post-creation checks have not been executed. Preflight success is
not evidence that SSH login as the new account already works.

Creating this account does not add a shell tool to PSM. Next implement a command
connection and executor that selects this identity, checks the current grant,
sets the working directory and timeout, streams output, supports cancellation
and records the actual result. Connect it to the Add machine flow and hosted
runner; retain the helper connections for infrastructure and releases.
