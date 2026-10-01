import { randomBytes, randomUUID } from "node:crypto";
import { githubAppJwt, githubAppRequest, GitHubAppTokens } from "./github-app.ts";
import { deploymentConnectionProfile } from "./runtime-adapters.ts";
import type { DeploymentService } from "./service.ts";
import type { JsonValue } from "./store.ts";

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonValue;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
export const APP_PERMISSIONS = { actions: "write", contents: "write", workflows: "write", administration: "write", environments: "write", metadata: "read" };
interface PendingApp {
  expires: number; browserNonce: string; owner: string; accountKind: "organization" | "personal";
  projectId: string; environmentId: string; controllerRepository: string; bindingRevision: number | null;
}

/** Manifest conversion is tied to one local browser, project and ten-minute intent. */
export class GitHubSetup {
  readonly #pending = new Map<string, PendingApp>();
  constructor(readonly service: DeploymentService, readonly fetcher = fetch, readonly now = Date.now) {}

  start(projectId: string, environmentId: string, input: { owner: string; accountKind: string; controllerName: string }, origin: string) {
    const local = new URL(origin);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(local.hostname) || !["http:", "https:"].includes(local.protocol)) throw new Error("Open GitHub setup from the local cockpit");
    if (!input || !OWNER.test(input.owner) || !NAME.test(input.controllerName) || !["organization", "personal"].includes(input.accountKind)) throw new Error("Enter a GitHub account and controller repository name");
    const context = this.service.releaseControllerUnit(projectId, environmentId);
    const unit = context.unit;
    if (unit.executor.sourceRepository.split("/")[0].toLowerCase() !== input.owner.toLowerCase()) throw new Error("Choose the GitHub account that owns this project's source repository");
    let bindingRevision: number | null = null;
    try { bindingRevision = this.service.store.getConnectionBinding(context.checkoutId, environmentId, unit.executor.connection).bindingRevision; } catch { /* first connection */ }
    const state = randomBytes(32).toString("hex");
    const browserNonce = randomBytes(32).toString("hex");
    for (const [key, entry] of this.#pending) if (entry.expires <= this.now()) this.#pending.delete(key);
    if (this.#pending.size >= 32) throw new Error("Too many GitHub connections in progress; wait for an earlier setup to expire");
    this.#pending.set(state, { expires: this.now() + 600_000, browserNonce, owner: input.owner, accountKind: input.accountKind as PendingApp["accountKind"],
      projectId: context.projectId, environmentId, controllerRepository: `${input.owner}/${input.controllerName}`, bindingRevision });
    return {
      state, browserNonce,
      action: input.accountKind === "organization" ? `https://github.com/organizations/${input.owner}/settings/apps/new?state=${state}` : `https://github.com/settings/apps/new?state=${state}`,
      manifest: { name: `PSM ${input.owner} ${state.slice(0, 6)}`, url: "https://psm.werewolf.solutions", public: false,
        // GitHub validates the hook host even when delivery is disabled. The App
        // subscribes to no events; this public PSM URL is never used for setup.
        hook_attributes: { url: "https://psm.werewolf.solutions/api/deployment-github/events", active: false },
        redirect_url: `${local.origin}/api/deployment-github/callback`, setup_url: `${local.origin}/#/p/${context.projectId}/deploy`,
        // An organization's members are visible to the App only with Members: read,
        // which the controller's push-access check needs.
        default_permissions: input.accountKind === "organization" ? { ...APP_PERMISSIONS, members: "read" } : APP_PERMISSIONS, default_events: [] },
    };
  }

  async convert(state: string, code: string, browserNonce: string) {
    const pending = this.#pending.get(state);
    if (!pending || pending.expires <= this.now() || !browserNonce || browserNonce !== pending.browserNonce) throw new Error("GitHub setup expired or belongs to another browser. Start Connect GitHub again.");
    this.#pending.delete(state);
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(code)) throw new Error("Invalid GitHub manifest code");
    const app = await githubAppRequest(`/app-manifests/${code}/conversions`, null, "POST", undefined, this.fetcher);
    if (!Number.isSafeInteger(app.id) || app.id < 1 || typeof app.pem !== "string" || typeof app.slug !== "string" || !/^[a-zA-Z0-9-]+$/.test(app.slug)
      || app.owner?.login?.toLowerCase() !== pending.owner.toLowerCase()) throw new Error("GitHub returned an App for a different account");
    githubAppJwt(String(app.id), app.pem, this.now());
    const context = this.service.releaseControllerUnit(pending.projectId, pending.environmentId);
    const unit = context.unit;
    const connectionId = `con_${randomUUID()}`;
    this.service.store.createConnection({ connectionId, kind: "github-actions@1", label: `GitHub App · ${pending.owner}`, readiness: "missing-secret", secretGeneration: 0,
      metadata: json({ requiredSecretSlots: ["appPrivateKey"], publicMetadata: {
        revision: 1, prepareWorkflows: [{ repository: unit.executor.sourceRepository, workflow: unit.executor.prepareWorkflow,
          workflowPath: `.github/workflows/${unit.executor.prepareWorkflow}`, refs: [{ ref: context.environment.releasePolicy.allowedBranch }] }], releaseControllers: [],
        githubAppSetup: { id: String(app.id), slug: app.slug, owner: pending.owner, accountKind: pending.accountKind, projectId: pending.projectId,
          environmentId: pending.environmentId, slot: unit.executor.connection, bindingRevision: pending.bindingRevision,
          controllerRepository: pending.controllerRepository },
      } }),
      constraints: json({ allowedProjectIds: [pending.projectId], allowedEnvironmentIds: [pending.environmentId], maximumAuthorizedRisk: context.environment.risk,
        allowedRepositories: [...new Set([unit.executor.sourceRepository, pending.controllerRepository])], allowedSourceRefs: [context.environment.releasePolicy.allowedBranch], allowedTargetIds: [unit.target.targetId] }),
      createdAt: this.now() });
    await this.service.secretBroker.put(connectionId, "appPrivateKey", app.pem);
    return { connectionId, installUrl: `https://github.com/apps/${app.slug}/installations/new`, projectId: pending.projectId };
  }

  async finish(connectionId: string) {
    const record = this.service.store.getConnection(connectionId);
    const profile = deploymentConnectionProfile(record);
    const setup = profile.publicMetadata?.githubAppSetup as Record<string, any> | undefined;
    if (!setup || typeof setup.id !== "string" || !OWNER.test(setup.owner)) throw new Error("Start Connect GitHub first");
    const installations = await this.service.secretBroker.withLease(connectionId, ["appPrivateKey"], (lease) => lease.useUtf8("appPrivateKey", (pem) =>
      githubAppRequest("/app/installations?per_page=100", githubAppJwt(setup.id, pem, this.now()), "GET", undefined, this.fetcher)));
    if (!Array.isArray(installations)) throw new Error("GitHub returned an invalid installation list");
    const matches = installations.filter((item) => item.account?.login?.toLowerCase() === setup.owner.toLowerCase() && !item.suspended_at);
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id)) throw new Error("Install the App on this account, then check again");
    const install = matches[0];
    const context = this.service.releaseControllerUnit(setup.projectId, setup.environmentId);
    const source = context.unit.executor.sourceRepository;
    const installedProfile = { ...profile, publicMetadata: { ...profile.publicMetadata,
      githubApp: { id: setup.id, slug: setup.slug, owner: setup.owner, installationId: String(install.id) } } };
    await new GitHubAppTokens(this.service.secretBroker, this.fetcher, this.now).token(installedProfile, source, { actions: "read", contents: "read" });
    const metadata = { ...(record.metadata as Record<string, JsonValue>), publicMetadata: { ...profile.publicMetadata,
      githubApp: { id: setup.id, slug: setup.slug, owner: setup.owner, installationId: String(install.id) } } };
    const status = await this.service.secretBroker.status(connectionId, ["appPrivateKey"]);
    this.service.store.updateConnection({ connectionId, expectedMetadataRevision: record.metadataRevision, label: record.label,
      metadata: json(metadata), constraints: record.constraints, readiness: status.ready ? "ready" : "missing-secret", secretGeneration: status.generation, updatedAt: this.now() });
    const currentBinding = (() => { try { return this.service.store.getConnectionBinding(context.checkoutId, setup.environmentId, setup.slot); } catch { return null; } })();
    if (currentBinding?.connectionId !== connectionId) {
      if ((currentBinding?.bindingRevision ?? null) !== setup.bindingRevision) throw new Error("The GitHub connection changed during setup. Select this App connection explicitly.");
      await this.service.bindConnection(setup.projectId, setup.environmentId, setup.slot, connectionId, setup.bindingRevision);
    }
    return { connectionId, owner: setup.owner, installationId: String(install.id), controllerRepository: setup.controllerRepository };
  }
}
