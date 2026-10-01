export const DEPLOYMENT_API_VERSION = "psm.werewolf.solutions/deployments/v1" as const;
export const DEPLOYMENT_MANIFEST_KIND = "DeploymentManifest" as const;

export type RiskClass = "development" | "staging" | "production";

export type ConnectionKind =
  | "github-actions@1"
  | "digitalocean-api@1"
  | "ssh-host-helper@1"
  | "werewolf-api@1"
  | "external-monitor@1";

export interface ConnectionSlot {
  kind: ConnectionKind;
}

export interface ProbeRequest {
  url: string;
  method: "GET" | "HEAD";
  timeoutMs?: number;
  maxResponseBytes?: number;
  followSameOriginRedirects?: boolean;
}

export interface HttpStatusProbe {
  id: string;
  kind: "http-status@1";
  projectId?: string;
  connection?: string;
  request: ProbeRequest;
  expect: { status: number };
}

export interface JsonEquality {
  path: string;
  value: string | number | boolean | null;
}

export interface HttpJsonProbe {
  id: string;
  kind: "http-json@1";
  projectId?: string;
  connection?: string;
  request: ProbeRequest;
  expect: { status: number; equals: JsonEquality[] };
}

export interface GitHubChecksProbe {
  id: string;
  kind: "github-checks@1";
  connection: string;
  repository: string;
  commit: string;
  expect: { checks: string[]; conclusion: "success" };
}

export interface ProjectReleaseProbe {
  id: string;
  kind: "project-release@1";
  projectId: string;
  environment: string;
  capability: string;
  expect: { state: "active" };
}

export interface WerewolfBackupPolicyProbe {
  id: string;
  kind: "werewolf-backup-policy@1";
  connection: string;
  projectId: string;
  environment: string;
  expect: { scheduled: boolean; lastSuccessMaxAgeHours: number };
}

export type DependencyManifest =
  | HttpStatusProbe
  | HttpJsonProbe
  | GitHubChecksProbe
  | ProjectReleaseProbe
  | WerewolfBackupPolicyProbe;

export interface ReleaseMetadataProbe {
  id: string;
  kind: "release-metadata@1";
  request: ProbeRequest;
  expect: {
    commit: "$release.commit";
    psmArtifactId: "$release.psmArtifactId";
    version?: "$release.version";
  };
}

export type VerificationManifest = HttpStatusProbe | HttpJsonProbe | ReleaseMetadataProbe;

export interface DigitalOceanDnsResource {
  id: string;
  kind: "digitalocean-dns-record@1";
  connection: string;
  dependsOn?: string[];
  desired: {
    zone: string;
    type: "A";
    name: string;
    valueFrom: { connection: string; field: "address" };
    ttl: number;
  };
}

export interface HostReleaseDirectoryResource {
  id: string;
  kind: "host-release-directory@1";
  connection: string;
  dependsOn?: string[];
  desired: {
    root: string;
    retainReleases: number;
  };
}

export interface NginxStaticSiteResource {
  id: string;
  kind: "nginx-static-site@1";
  connection: string;
  dependsOn?: string[];
  desired: {
    hostname: string;
    documentRoot: string;
    spaFallback: boolean;
    denyPrefixes: string[];
    cachePolicy: "vite-hashed" | "no-cache";
    securityHeaders: "werewolf-static-spa@1";
  };
}

export interface LetsEncryptCertificateResource {
  id: string;
  kind: "letsencrypt-certificate@1";
  connection: string;
  dependsOn?: string[];
  desired: {
    hostname: string;
    renewal: "automatic";
  };
}

/**
 * A supervised Node process: the host helper renders its systemd unit from the
 * root-owned target contract, and these fields must equal what was enrolled.
 */
export interface SystemdNodeServiceResource {
  id: string;
  kind: "systemd-node-service@1";
  connection: string;
  dependsOn?: string[];
  desired: {
    entry: string;
    healthPath: string;
    startupTimeoutSeconds: number;
    memoryMaxMb: number;
    /** Non-secret runtime configuration, shown in plans. */
    config: Record<string, string>;
  };
}

/** Names of the runtime secrets; values live only in PSM's secret store and on the host. */
export interface ServiceSecretsResource {
  id: string;
  kind: "service-secrets@1";
  connection: string;
  dependsOn?: string[];
  desired: {
    names: string[];
  };
}

export interface NginxNodeProxyResource {
  id: string;
  kind: "nginx-node-proxy@1";
  connection: string;
  dependsOn?: string[];
  desired: {
    hostname: string;
    securityHeaders: "app-managed@1";
    maxBodyMb: number;
  };
}

export type ResourceManifest =
  | DigitalOceanDnsResource
  | HostReleaseDirectoryResource
  | NginxStaticSiteResource
  | LetsEncryptCertificateResource
  | SystemdNodeServiceResource
  | ServiceSecretsResource
  | NginxNodeProxyResource;

export interface StaticFilesArtifact {
  kind: "static-files@1";
  output: string;
  buildProfile: {
    id: string;
    publicInputs: Record<string, string>;
  };
}

/**
 * A Node server plus its built client and the Node runtime, built once on
 * GitHub Actions. The generated workflow bakes in the same values.
 */
export interface NodeServiceArtifact {
  kind: "node-service@1";
  runtime: "node@20" | "node@22" | "node@24";
  /** Directories (repository-relative) whose lockfiles are installed before the build. */
  install: string[];
  /** A script in the root package.json that builds the client into the service. */
  buildScript: string;
  /** The directory that becomes the release's app/. */
  serviceRoot: string;
  /** The entry point, relative to serviceRoot; also the systemd service's entry. */
  entry: string;
  /** The served static directory, relative to serviceRoot; version.json is written there. */
  publicDir: string;
  buildProfile: {
    id: string;
    publicInputs: Record<string, string>;
  };
}

export interface GitHubActionsExecutor {
  kind: "github-actions@1";
  connection: string;
  sourceRepository: string;
  prepareWorkflow: string;
  releaseController: "werewolf-static@1";
}

export interface SshReleaseTarget {
  kind: "ssh-release-directory@1";
  targetId: string;
  observerConnection: string;
  root: string;
}

export interface StaticSshNginxUnit {
  id: string;
  recipe: "static-ssh-nginx@1";
  resourceRefs: string[];
  artifact: StaticFilesArtifact;
  executor: GitHubActionsExecutor;
  target: SshReleaseTarget;
  verification: VerificationManifest[];
}

export interface NodeServiceSshNginxUnit {
  id: string;
  recipe: "node-service-ssh-nginx@1";
  resourceRefs: string[];
  artifact: NodeServiceArtifact;
  executor: GitHubActionsExecutor;
  target: SshReleaseTarget;
  verification: VerificationManifest[];
}

export type UnitManifest = StaticSshNginxUnit | NodeServiceSshNginxUnit;

export interface ExternalHttpWatch {
  id: string;
  kind: "external-http-monitor@1";
  connection: string;
  unit: string;
  monitorKey: string;
  hostname: string;
  maxObservationAgeSeconds: number;
}

export interface ReleasePolicyManifest {
  allowedBranch: string;
  requireReachableFromBranch: boolean;
  requireChecks: boolean;
  approval: "authenticated-local-operator" | "none";
}

export interface DeploymentPolicyManifest {
  planTtlSeconds: number;
  rollbackOnVerificationFailure: boolean;
  allowDelete: boolean;
  requireFreshWatchBeforeRelease: boolean;
}

export interface EnvironmentManifest {
  id: string;
  risk: RiskClass;
  releasePolicy: ReleasePolicyManifest;
  connections: Record<string, ConnectionSlot>;
  dependencies: DependencyManifest[];
  resources: ResourceManifest[];
  units: UnitManifest[];
  watch: ExternalHttpWatch[];
  policy: DeploymentPolicyManifest;
}

export interface DeploymentManifestV1 {
  apiVersion: typeof DEPLOYMENT_API_VERSION;
  kind: typeof DEPLOYMENT_MANIFEST_KIND;
  projectId: string;
  environments: EnvironmentManifest[];
}

export interface LoadedDeploymentManifest {
  manifest: DeploymentManifestV1;
  manifestPath: string;
  projectRoot: string;
  projectId: string;
  packageVersion: string;
}

export interface ManifestValidationIssue {
  code: string;
  path: string;
  message: string;
}

export interface ManifestValidationOptions {
  projectRoot: string;
  expectedProjectId?: string;
  packageVersion?: string;
  /** Used by tests or callers that already loaded identity.json. */
  identityProjectId?: string;
}

export type DeploymentGraphPhase =
  | "dependencies"
  | "reconcile"
  | "release"
  | "activate"
  | "verify"
  | "watch";

export type DeploymentActionKind =
  | "assert-dependency@1"
  | "reconcile-dns@1"
  | "reconcile-release-directory@1"
  | "reconcile-service@1"
  | "reconcile-service-secrets@1"
  | "reconcile-ingress-http@1"
  | "reconcile-certificate@1"
  | "reconcile-ingress-tls@1"
  | "validate-nginx@1"
  | "reload-nginx@1"
  | "verify-resource@1"
  | "snapshot-pm2@1"
  | "stage-static-release@1"
  | "activate-static-release@1"
  | "stage-service-release@1"
  | "activate-service-release@1"
  | "verify-release@1"
  | "compare-pm2@1"
  | "observe-watch@1";

export interface DeploymentActionNode {
  id: string;
  kind: DeploymentActionKind;
  phase: DeploymentGraphPhase;
  ownerRef: string;
  dependsOn: string[];
  connection?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface ExpandedDeploymentGraph {
  projectId: string;
  environmentId: string;
  nodes: DeploymentActionNode[];
  order: string[];
}
