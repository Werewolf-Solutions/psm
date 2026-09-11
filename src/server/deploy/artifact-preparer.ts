import type { SourcePublicationController } from "./source-publication.ts";
import { randomUUID } from "node:crypto";

import { canonicalDigest } from "./canonical.ts";
import { GitHubActionsAdapter, type GitHubActionsConnectionMetadata, type GitHubDispatchReceipt } from "./adapters/github.ts";
import type { PrepareArtifactDispatch } from "./adapters/executor-contract.ts";
import type { ArtifactPreparationController } from "./api.ts";
import { DeploymentService } from "./service.ts";
import { DeploymentStore, type DeploymentRun, type DeploymentRunState, type JsonValue } from "./store.ts";
import { SecretBroker, type ConnectionProfile } from "./connections.ts";

const PREPARATION_EVENT_SCHEMA = "psm.werewolf.solutions/artifact-preparation-event/v1";
const TERMINAL = new Set<DeploymentRunState>(["succeeded", "failed", "cancelled", "interrupted", "stale-plan", "rolled-back"]);

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function metadata(profile: ConnectionProfile): GitHubActionsConnectionMetadata {
  return profile.publicMetadata as unknown as GitHubActionsConnectionMetadata;
}

export class GitHubArtifactPreparer implements ArtifactPreparationController {
  readonly #service: DeploymentService;
  readonly #store: DeploymentStore;
  readonly #broker: SecretBroker;
  readonly #pollMs: number;
  readonly #maximumPolls: number;
  readonly #publisher?: SourcePublicationController;

  constructor(options: {
    service: DeploymentService;
    store: DeploymentStore;
    broker: SecretBroker;
    pollMs?: number;
    maximumPolls?: number;
    publisher?: SourcePublicationController;
  }) {
    this.#publisher = options.publisher;
    this.#service = options.service;
    this.#store = options.store;
    this.#broker = options.broker;
    this.#pollMs = Math.max(250, options.pollMs ?? 2_000);
    this.#maximumPolls = Math.max(1, options.maximumPolls ?? 900);
  }

  #event(runId: string, type: string, phase: string, message: string, data: Record<string, JsonValue> = {}, level: "info" | "warning" | "error" = "info"): void {
    this.#store.appendEvent({
      runId,
      at: Date.now(),
      type,
      phase,
      level,
      message,
      data: { schema: PREPARATION_EVENT_SCHEMA, ...data },
    });
  }

  #move(runId: string, state: DeploymentRunState, phase: string): DeploymentRun {
    const current = this.#store.getRun(runId);
    if (TERMINAL.has(current.state)) return current;
    return this.#store.transitionRun({ runId, expectedStates: [current.state], state, phase, at: Date.now() });
  }

  #adapter(profile: ConnectionProfile): GitHubActionsAdapter {
    return new GitHubActionsAdapter({
      metadata: metadata(profile),
      token: () => this.#broker.withLease(
        profile.connectionId,
        ["apiToken"],
        (lease) => lease.useUtf8("apiToken", (token) => token),
      ),
    });
  }

  async prepare(input: { projectId: string; environmentId: string; unitId?: string }): Promise<{ runId: string }> {
    // Ask, don't record: refusing here must not leave a pending publication review
    // that nothing will show. Make ready records the review itself before it gets
    // this far, and a remote it just verified is not fetched a second time.
    if (await this.#publisher?.needsPublication(input.projectId, input.environmentId, input.unitId)) throw new Error("Source needs publication approval. Use Make ready to deploy to review the exact commit and branch before building.");
    const context = await this.#service.artifactPreparationContext(input.projectId, input.environmentId, input.unitId);
    const run = this.#store.createPreparationRun({ projectId: context.project.id, environmentId: context.environment.id, createdAt: Date.now() });
    const psmArtifactId = `artifact_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const buildProfile = { id: context.unit.artifact.buildProfile.id, publicInputs: context.unit.artifact.buildProfile.publicInputs };
    const dispatch: PrepareArtifactDispatch = {
      repository: context.unit.executor.sourceRepository,
      workflow: context.unit.executor.prepareWorkflow,
      ref: `refs/heads/${context.environment.releasePolicy.allowedBranch}`,
      psmRunId: run.runId,
      psmArtifactId,
      projectId: context.project.id,
      environmentId: context.environment.id,
      unitId: context.unit.id,
      commitSha: context.source.commit,
      manifestDigest: context.source.manifestDigest,
      buildProfile: json(buildProfile),
      buildProfileDigest: canonicalDigest("psm-deployment-build-profile:v1", buildProfile),
    };
    void this.#execute(run.runId, context.connection, dispatch).catch(() => {});
    return { runId: run.runId };
  }

  async #execute(runId: string, profile: ConnectionProfile, dispatch: PrepareArtifactDispatch): Promise<void> {
    let receipt: GitHubDispatchReceipt | null = null;
    try {
      const adapter = this.#adapter(profile);
      this.#move(runId, "dispatching", "dispatching");
      this.#event(runId, "prepare-dispatching", "dispatching", "Dispatching the exact source workflow", {
        repository: dispatch.repository,
        workflow: dispatch.workflow,
        ref: dispatch.ref,
        commitSha: dispatch.commitSha,
        psmArtifactId: dispatch.psmArtifactId,
      });
      receipt = await adapter.dispatchPrepare(dispatch);
      this.#event(runId, "prepare-dispatched", "waiting-executor", "Artifact workflow accepted", { receipt: json(receipt) });
      this.#move(runId, "waiting-executor", "waiting-executor");
      let completed = false;
      for (let attempt = 0; attempt < this.#maximumPolls; attempt += 1) {
        const current = this.#store.getRun(runId);
        if (current.cancellationRequestedAt !== null) {
          await adapter.cancelRun(receipt).catch(() => undefined);
          this.#move(runId, "cancelled", "complete");
          this.#event(runId, "prepare-cancelled", "complete", "Artifact preparation was cancelled", {}, "warning");
          return;
        }
        const polled = await adapter.pollRun(receipt);
        receipt = polled.receipt;
        if (polled.run?.status === "completed") {
          if (polled.run.conclusion !== "success") throw new Error(`artifact workflow concluded ${polled.run.conclusion ?? "without a conclusion"}`);
          completed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, this.#pollMs));
      }
      if (!completed) throw new Error("artifact workflow exceeded the observation limit");
      this.#move(runId, "importing-artifact", "importing-artifact");
      const resultValue = await adapter.downloadRunArtifactJson(
        receipt,
        `${dispatch.psmArtifactId}-result`,
        "psm-artifact-result.json",
      );
      const imported = await adapter.importPreparedArtifact(receipt, dispatch, resultValue);
      this.#store.recordArtifact({
        artifactId: imported.psmArtifactId,
        producingRunId: runId,
        provenance: "managed",
        projectId: imported.projectId,
        kind: "static-files@1",
        sourceRepository: imported.sourceRepository,
        githubArtifactId: imported.githubArtifactId,
        producerRunId: imported.producerRunId,
        commitSha: imported.commitSha,
        version: imported.version,
        buildProfileDigest: imported.buildProfileDigest,
        payloadAlgorithm: imported.payloadAlgorithm,
        payloadDigest: imported.payloadDigest,
        archiveDigest: imported.archiveDigest,
        providerLocator: json({ ...imported.provider, payloadLimits: imported.payloadLimits }),
        provenanceUrl: imported.provider.provenanceUrl,
        createdAt: Date.now(),
        retainedUntil: Date.parse(imported.retainedUntil),
      });
      this.#move(runId, "succeeded", "complete");
      this.#event(runId, "artifact-imported", "complete", "Immutable artifact provenance was verified and recorded", {
        psmArtifactId: imported.psmArtifactId,
        githubArtifactId: imported.githubArtifactId,
        payloadDigest: imported.payloadDigest,
        archiveDigest: imported.archiveDigest,
      });
    } catch (error) {
      const current = this.#store.getRun(runId);
      if (!TERMINAL.has(current.state)) this.#move(runId, "failed", "complete");
      this.#event(
        runId,
        "prepare-failed",
        "complete",
        error instanceof Error ? error.message.slice(0, 1_000) : "Artifact preparation failed",
        { receipt: receipt ? json(receipt) : null },
        "error",
      );
      throw error;
    }
  }
}
