# Todo staging deployment

The staging target requested on 2026-09-07 is
`https://a6s1j3p3zh.werewolf.solutions`, serving todo-app's Vite build through
nginx. GitHub Actions prepares `client/dist`; the managed SSH host helper installs
the artifact under `/var/www/a6s1j3p3zh.werewolf.solutions` and activates its
`current` release. No additional application process is needed on the host.

The browser uses `https://staging.werewolf.solutions/api/v1` for the API and
`https://staging.werewolf.solutions` for sign-in. Its exact callback is
`https://a6s1j3p3zh.werewolf.solutions/auth/callback`. Production remains a
separate environment, currently configured for `https://todo.werewolf.solutions`;
a different production domain has not been selected.

## Readiness observed on 2026-09-07

These are point-in-time checks; run **Check if ready to deploy** for current evidence.

| Requirement | Observed state | Work needed |
| --- | --- | --- |
| Committed deployment source | The todo manifest, managed build workflow, and artifact script are untracked; `HEAD` has no manifest | Review and commit the intended deployment files and application version, then make that commit available to GitHub Actions. Preserve unrelated working-tree edits. |
| Local connections | PSM has no deployment connection profiles or bindings | Configure and bind GitHub, DigitalOcean DNS, and SSH host-helper profiles for staging. Supply credentials through local secret storage and verify their scopes. |
| Staging hostname | DNS lookup for `a6s1j3p3zh.werewolf.solutions` returned `ENOTFOUND` | Plan and apply the DNS record, release directory, nginx ingress, and TLS certificate once the host and DNS connections are ready. |
| Werewolf staging health | `/api/v1/health` returned HTTP 200 | Keep the health check, alongside the app-specific checks below. |
| Todo API on staging | Unauthenticated `/api/v1/apps/todo/board` returned HTTP 404, `API endpoint not found` | Deploy the todo API through werewolf-dapp's staging workflow; the guarded route must return HTTP 401 without credentials. |
| Todo sign-in on staging | `/api/v1/apps/todo/public?redirectUri=…` returned HTTP 404, `Application not found` | Select the publishing business and register the todo web application in staging, allowing the exact callback above. The current bootstrap script only allows production and localhost callbacks. |

The todo manifest should check the guarded API route and public registration
response before release. Registration requires HTTP 200 with `success: true`,
`data.key: "todo"`, `data.clientType: "web"`, and
`data.redirectAllowed: true` for the exact staging callback. These probes read
public readiness metadata and do not sign in or fetch customer data.

## Deployment flow

Select **Staging**, then **Check if ready to deploy** to see the current checklist.
**Make it ready to deploy** can prepare the artifact and reconcile infrastructure
through configured connections, with the required plan review and approval. It
must report missing credentials, source commits, and upstream application setup
as concrete prerequisites and check again after each preparation run. **Deploy**
becomes available only after the selected environment passes readiness; its
release verification checks HTTPS, the sign-in callback SPA route, the sealed
`/api/` path, and exact release metadata.

The attached Werewolf capability is read-only and exposes PSM paid-cloud service
status. It does not provide todo app registration or infrastructure deployment
access. No DNS, host, GitHub, application registration, or production changes
were performed during the audit.
