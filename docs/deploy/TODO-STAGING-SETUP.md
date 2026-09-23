# Todo staging: operator setup (2026-09-21)

This runbook addresses the two PSM deployment blockers. It does **not** deploy,
restart services, provision paid resources, migrate customer data, or fix application
code. The transfer-lock expiry bug and PSM auth defects are separate release blockers.

## Where to run what

- **Your development machine running PSM on port 4317:** repair the saved host
  connection and generate the controller repository.
- **GitHub:** create the private control repository and its environment; register
  and install a narrowly scoped artifact-reader App.
- **Droplet:** verify existing host enrollment and SSH key restrictions only.
  Do not reinstall/re-enroll merely because the local PSM connection is stale.

The script defaults to read-only. It accepts only loopback agent URLs, checks the
specific project/environment/target, preserves all non-root constraints and secrets,
and uses the API's metadata revision to reject concurrent changes. The existing root
permission is **replaced**, not supplemented with broad access to /var/www.

## 1. Repair the local PSM connection

Run from the existing PSM checkout while its local agent is running:

```bash
cd /home/oznerol/projects/werewolf-solutions/psm
node scripts/setup-todo-staging.mjs check
node scripts/setup-todo-staging.mjs fix-root
```

Review the old/new paths. To perform exactly that change:

```bash
node scripts/setup-todo-staging.mjs fix-root --apply --backup /tmp/todo-staging-root-before.json
node scripts/setup-todo-staging.mjs check
```

The backup path must not exist. Backups are written mode 0600 and contain only the
connection's constraints/revision, not private keys. Move the backup somewhere durable
if needed; /tmp may be cleaned on reboot. Repeating the fix after success is a no-op.

Rollback, before any intervening connection edit:

```bash
node scripts/setup-todo-staging.mjs restore-root --backup /tmp/todo-staging-root-before.json
node scripts/setup-todo-staging.mjs restore-root --backup /tmp/todo-staging-root-before.json --apply
```

Rollback restores the old permission only; it does not roll back a deployed app.
Changed metadata revisions require manual review rather than overwriting newer state.

## 2. Generate a staging-only controller

The existing draft includes a **production PSM** target, not Todo. The helper copies
the workflow/controller code but generates only the Todo staging target from the
public enrollment metadata already saved in PSM. It never copies production target files.

```bash
node scripts/setup-todo-staging.mjs scaffold --output /home/oznerol/projects/werewolf-solutions/deployment-control
node scripts/setup-todo-staging.mjs scaffold --output /home/oznerol/projects/werewolf-solutions/deployment-control --apply
```

The output directory must not exist. Inspect every generated file, particularly:

- targets/werewolf__todo-staging-web.json
- .github/workflows/release-static.yml
- scripts/psm_controller.py

The target revision/fingerprint comes from local PSM metadata, **not a new remote
attestation**. Verify it against enrollment records before entrusting credentials.
Verify the public host key independently (e.g. via the DigitalOcean console), then
compare it to the generated known-hosts file:

```bash
ssh-keygen -lf /home/oznerol/projects/werewolf-solutions/deployment-control/todo-staging.known_hosts
```

Do not replace a mismatching fingerprint with a fresh ssh-keyscan result just to proceed.

## 3. Create the private GitHub repository

These commands create an organization repository and push the reviewed scaffold.
They are intentionally not executed by the helper. Run them only when you approve
that exact organization change. If the repository already exists, inspect it instead
of force-pushing or trying to recreate it.

```bash
gh auth status
cd /home/oznerol/projects/werewolf-solutions/deployment-control
git init -b main
git add .github/workflows/release-static.yml scripts/psm_controller.py targets/werewolf__todo-staging-web.json todo-staging.known_hosts .gitignore README.md
git diff --cached --stat
git diff --cached
git commit -m "Initialize Todo staging release controller"
gh repo create Werewolf-Solutions/deployment-control --private --source=. --remote=origin --push
```

Set the default branch to main if your organization assigns a different default.
Pushing this scaffold does not deploy: its workflow has workflow_dispatch only.
Review and protect the default branch; source artifacts and controller commits must
be pinned/reviewed through PSM before release.

Official CLI reference: https://cli.github.com/manual/gh_repo_create

## 4. Register/install the artifact-reader GitHub App

This is a GitHub administrator step, not something a root shell on the droplet solves.
Use the organization settings → Developer settings → GitHub Apps → New GitHub App.

- Name: a unique name such as Werewolf PSM Artifact Reader.
- Homepage: your organization page.
- Webhooks: inactive; no user OAuth/device flow needed for this installation-token use.
- Repository permissions: **Actions: Read-only**, plus GitHub's mandatory metadata read.
  Do not grant contents-write, administration, or access to unrelated repositories.
- Installation: only this account, then install on **only Werewolf-Solutions/todo-app**.
- Record the App ID, generate a private key, and store it securely outside any repository.

The App reads the prepared artifact from Todo; the control repository's own GITHUB_TOKEN
checks out the controller with contents-read. These are different credentials.
Official registration guide:
https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app
Action permissions reference: https://github.com/actions/create-github-app-token

## 5. Create the staging GitHub Environment and add credentials

Use Settings → Environments in deployment-control to create **todo-staging-web**.
Before adding secrets, configure required reviewers where your plan supports them,
disable self-approval where appropriate, and restrict deployment branches to the
reviewed controller branch. Do not silently remove protections if your plan cannot
provide them; decide the acceptable staging policy explicitly.

In that Environment add:

| Type | Name | Value |
| --- | --- | --- |
| Variable | PSM_ARTIFACT_READER_APP_ID | the registered App ID |
| Secret | PSM_ARTIFACT_READER_PRIVATE_KEY | the generated App PEM |
| Secret | PSM_TARGET_SSH_PRIVATE_KEY | the existing enrolled **release-only** target key |
| Secret | PSM_TARGET_KNOWN_HOSTS | the independently verified known-hosts entry |

The SSH key must be the one authorized for the enrolled Todo target. **Do not upload a
root/general-purpose SSH key or a personal SSH identity.** On the droplet, its public
key should be restricted to the installed host-helper client, with SSH forwarding
disabled, as documented in ../../host-helper/README.md. Review existing enrollment;
this runbook does not generate or authorize a replacement key.

After creating/protecting the Environment, you can enter secrets in GitHub's UI.
Alternatively these CLI commands read files on stdin without putting key contents
into shell arguments/history. Replace the absolute file paths; never commit them:

```bash
gh variable set PSM_ARTIFACT_READER_APP_ID --repo Werewolf-Solutions/deployment-control --env todo-staging-web
gh secret set PSM_ARTIFACT_READER_PRIVATE_KEY --repo Werewolf-Solutions/deployment-control --env todo-staging-web < /absolute/path/to/artifact-reader.pem
gh secret set PSM_TARGET_SSH_PRIVATE_KEY --repo Werewolf-Solutions/deployment-control --env todo-staging-web < /absolute/path/to/enrolled-release-key
gh secret set PSM_TARGET_KNOWN_HOSTS --repo Werewolf-Solutions/deployment-control --env todo-staging-web < /home/oznerol/projects/werewolf-solutions/deployment-control/todo-staging.known_hosts
```

Do not run shell tracing (set -x) while provisioning credentials. Private environment
support/protection options depend on your GitHub plan; stop on permission/plan errors
instead of making the repository public or substituting broader credentials.

## 6. Recheck PSM, then prepare an actual release

Refresh Todo → Deployments → staging in the local cockpit. Re-test the host and GitHub
connections and let PSM discover/review/pin the controller. Record its exact commit SHA;
do not substitute a moving branch/tag for a reviewed pin.

Removing the two original blockers may expose later prerequisites. It is **not** a
promise that canPrepare becomes true immediately. Follow the resulting readiness
report. Review artifact source, checks, target fingerprint/revision and the deployment
plan before authorizing release.

Before deploying workspace functionality:

- Fix the remaining transfer-lock expiry race.
- Finish PSM auth repair and browser verification.
- Commit/push only reviewed in-scope application changes: PSM builds a committed tree,
  so uncommitted Todo 0.6.0 does not become the released artifact.
- Verify staging identity/API versions and database/index prerequisites; do not run a
  live migration merely because an old document says it is pending.
- Let the approved PSM release manage Todo DNS, directory, nginx and TLS. Do not create
  manual competing resources or restart shared droplet services as a shortcut.

## Auth defects: the intended fix

The existing one-app contract is web-client PSM in both hosted and local postures.
Fixing it does **not** require relaxing the backend's Origin allowlist:

1. Identity-only registration sets clientType web and the exact approved redirect URIs.
   The billing bootstrap must preserve that registration, existing scopes, owner and
   Stripe data rather than reverting it to native.
2. The local agent derives Origin from its validated callback URI, retains that origin
   with the in-memory session, and sends it on code exchange and refresh. Logout should
   follow the same session binding. Keep PKCE, exact code/redirect matching, and the
   API's untrusted-origin/missing-origin rejection for browser cookie endpoints.
3. Test a successful local exchange **and subsequent refresh**, malicious/unregistered
   callbacks, hosted browser auth, logout/revocation and legacy token transport if retained.

Opus session ac59ec5c was assigned these local fixes but hit its Claude session usage
limit before applying them. They are **not implemented or deployed by this setup helper**.
Do not run bootstrap-psm-cloud.js to repair login: that script has Stripe side effects.
A report-first identity-only repair script should be completed and reviewed before
touching any live database. The stale documentation describing an untracked bootstrap
is not proof that the file exists or is safe on the droplet.

## Verification of this helper

Run:

```bash
node --test scripts/setup-todo-staging.test.mjs
```

Tests use mock HTTP/temporary directories, including dry-run, revision-checked apply,
backup/read-back/rollback, rejection of broad authority and no-overwrite scaffolding.
No actual connection change, repository creation, key upload or deployment was performed
while preparing this helper.

