import type {
  DeploymentActionNode,
  DeploymentGraphPhase,
  DeploymentManifestV1,
  EnvironmentManifest,
  ExpandedDeploymentGraph,
  ResourceManifest,
  UnitManifest,
} from "./types.ts";

const PHASE_ORDER: Record<DeploymentGraphPhase, number> = {
  dependencies: 0,
  reconcile: 1,
  release: 2,
  activate: 3,
  verify: 4,
  watch: 5,
};

export class DeploymentGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentGraphError";
  }
}

function actionId(ownerRef: string, action: string): string {
  return `${ownerRef}#${action}`;
}

function nodeCompare(a: DeploymentActionNode, b: DeploymentActionNode): number {
  return PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase] || a.id.localeCompare(b.id);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function refParts(reference: string): { resourceId: string; substate?: string } {
  const match = /^resource:([^#]+)(?:#(.+))?$/.exec(reference);
  if (!match) throw new DeploymentGraphError(`Invalid resource reference ${JSON.stringify(reference)}`);
  return { resourceId: match[1], ...(match[2] ? { substate: match[2] } : {}) };
}

function resourceReadyAction(resource: ResourceManifest, substate?: string): string {
  if (substate === "http-ready" && resource.kind === "nginx-static-site@1") {
    return actionId(`resource:${resource.id}`, "http-ready");
  }
  if (substate === "tls-ready" && resource.kind === "nginx-static-site@1") {
    return actionId(`resource:${resource.id}`, "tls-ready");
  }
  if (substate === "certificate-ready" && resource.kind === "letsencrypt-certificate@1") {
    return actionId(`resource:${resource.id}`, "certificate-ready");
  }
  if (substate) throw new DeploymentGraphError(`${resource.kind} does not expose #${substate}`);
  switch (resource.kind) {
    case "digitalocean-dns-record@1": return actionId(`resource:${resource.id}`, "reconciled");
    case "host-release-directory@1": return actionId(`resource:${resource.id}`, "reconciled");
    case "nginx-static-site@1": return actionId(`resource:${resource.id}`, "tls-ready");
    case "letsencrypt-certificate@1": return actionId(`resource:${resource.id}`, "certificate-ready");
  }
}

function explicitDependencies(
  resource: ResourceManifest,
  resources: Map<string, ResourceManifest>,
  gates: string[],
): string[] {
  const dependencies = [...gates];
  for (const reference of resource.dependsOn ?? []) {
    const { resourceId, substate } = refParts(reference);
    const target = resources.get(resourceId);
    if (!target) throw new DeploymentGraphError(`Resource ${resource.id} references missing resource ${resourceId}`);
    dependencies.push(resourceReadyAction(target, substate));
  }
  return uniqueSorted(dependencies);
}

function addNode(nodes: Map<string, DeploymentActionNode>, node: DeploymentActionNode): void {
  if (nodes.has(node.id)) throw new DeploymentGraphError(`Duplicate expanded action ${node.id}`);
  nodes.set(node.id, { ...node, dependsOn: uniqueSorted(node.dependsOn) });
}

function addDependencies(nodes: Map<string, DeploymentActionNode>, id: string, dependencies: string[]): void {
  const node = nodes.get(id);
  if (!node) throw new DeploymentGraphError(`Cannot add recipe edges to missing action ${id}`);
  node.dependsOn = uniqueSorted([...node.dependsOn, ...dependencies]);
}

function referencedResources(unit: UnitManifest, resources: Map<string, ResourceManifest>): ResourceManifest[] {
  return unit.resourceRefs.map((reference) => {
    const { resourceId, substate } = refParts(reference);
    if (substate) throw new DeploymentGraphError(`Unit ${unit.id} cannot reference resource substate ${reference}`);
    const resource = resources.get(resourceId);
    if (!resource) throw new DeploymentGraphError(`Unit ${unit.id} references missing resource ${resourceId}`);
    return resource;
  });
}

function onlyResource<T extends ResourceManifest["kind"]>(
  unit: UnitManifest,
  resources: ResourceManifest[],
  kind: T,
): Extract<ResourceManifest, { kind: T }> {
  const matches = resources.filter((resource) => resource.kind === kind);
  if (matches.length !== 1) {
    throw new DeploymentGraphError(`${unit.recipe} unit ${unit.id} requires exactly one ${kind}; found ${matches.length}`);
  }
  return matches[0] as Extract<ResourceManifest, { kind: T }>;
}

/**
 * Returns a deterministic topological order. It validates every edge even when callers construct
 * a graph independently of manifest validation.
 */
export function topologicallySortDeploymentActions(nodesInput: readonly DeploymentActionNode[]): string[] {
  const nodes = new Map<string, DeploymentActionNode>();
  for (const node of nodesInput) {
    if (nodes.has(node.id)) throw new DeploymentGraphError(`Duplicate action ID ${node.id}`);
    nodes.set(node.id, node);
  }
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of nodes.values()) {
    incoming.set(node.id, node.dependsOn.length);
    for (const dependency of node.dependsOn) {
      if (!nodes.has(dependency)) throw new DeploymentGraphError(`Action ${node.id} depends on missing action ${dependency}`);
      const dependants = outgoing.get(dependency) ?? [];
      dependants.push(node.id);
      outgoing.set(dependency, dependants);
    }
  }
  const ready = [...nodes.values()].filter((node) => incoming.get(node.id) === 0).sort(nodeCompare);
  const order: string[] = [];
  while (ready.length) {
    const node = ready.shift()!;
    order.push(node.id);
    for (const dependantId of (outgoing.get(node.id) ?? []).sort((a, b) => a.localeCompare(b))) {
      const remaining = (incoming.get(dependantId) ?? 0) - 1;
      incoming.set(dependantId, remaining);
      if (remaining === 0) {
        ready.push(nodes.get(dependantId)!);
        ready.sort(nodeCompare);
      }
    }
  }
  if (order.length !== nodes.size) {
    const cyclic = [...nodes.keys()].filter((id) => !order.includes(id)).sort();
    throw new DeploymentGraphError(`Expanded action graph is cyclic: ${cyclic.join(", ")}`);
  }
  return order;
}

function expandEnvironment(manifest: DeploymentManifestV1, environment: EnvironmentManifest): ExpandedDeploymentGraph {
  const nodes = new Map<string, DeploymentActionNode>();
  const resources = new Map(environment.resources.map((resource) => [resource.id, resource]));

  for (const dependency of [...environment.dependencies].sort((a, b) => a.id.localeCompare(b.id))) {
    const ownerRef = `dependency:${dependency.id}`;
    addNode(nodes, {
      id: actionId(ownerRef, "asserted"),
      kind: "assert-dependency@1",
      phase: "dependencies",
      ownerRef,
      dependsOn: [],
      ...("connection" in dependency && dependency.connection ? { connection: dependency.connection } : {}),
      metadata: { probeKind: dependency.kind },
    });
  }
  const gates = [...nodes.keys()].sort();

  for (const resource of [...environment.resources].sort((a, b) => a.id.localeCompare(b.id))) {
    const ownerRef = `resource:${resource.id}`;
    const dependencies = explicitDependencies(resource, resources, gates);
    switch (resource.kind) {
      case "digitalocean-dns-record@1":
        addNode(nodes, {
          id: actionId(ownerRef, "reconciled"),
          kind: "reconcile-dns@1",
          phase: "reconcile",
          ownerRef,
          dependsOn: dependencies,
          connection: resource.connection,
          metadata: { hostname: `${resource.desired.name}.${resource.desired.zone}` },
        });
        break;
      case "host-release-directory@1":
        addNode(nodes, {
          id: actionId(ownerRef, "reconciled"),
          kind: "reconcile-release-directory@1",
          phase: "reconcile",
          ownerRef,
          dependsOn: dependencies,
          connection: resource.connection,
          metadata: { root: resource.desired.root },
        });
        break;
      case "nginx-static-site@1":
        addNode(nodes, {
          id: actionId(ownerRef, "http-ready"),
          kind: "reconcile-ingress-http@1",
          phase: "reconcile",
          ownerRef,
          dependsOn: dependencies,
          connection: resource.connection,
          metadata: { hostname: resource.desired.hostname },
        });
        // tls-ready receives its certificate edge during unit recipe composition below.
        break;
      case "letsencrypt-certificate@1":
        addNode(nodes, {
          id: actionId(ownerRef, "certificate-ready"),
          kind: "reconcile-certificate@1",
          phase: "reconcile",
          ownerRef,
          dependsOn: dependencies,
          connection: resource.connection,
          metadata: { hostname: resource.desired.hostname },
        });
        break;
    }
  }

  for (const unit of [...environment.units].sort((a, b) => a.id.localeCompare(b.id))) {
    if (unit.recipe !== "static-ssh-nginx@1") throw new DeploymentGraphError(`Unsupported recipe ${unit.recipe}`);
    const recipeResources = referencedResources(unit, resources);
    const dns = onlyResource(unit, recipeResources, "digitalocean-dns-record@1");
    const directory = onlyResource(unit, recipeResources, "host-release-directory@1");
    const ingress = onlyResource(unit, recipeResources, "nginx-static-site@1");
    const certificate = onlyResource(unit, recipeResources, "letsencrypt-certificate@1");
    const ingressRef = `resource:${ingress.id}`;
    const dnsReadyId = actionId(`resource:${dns.id}`, "reconciled");
    const directoryReadyId = actionId(`resource:${directory.id}`, "reconciled");
    // The recipe fixes first-certificate ordering even if a hand-built typed manifest omitted
    // the recommended explicit resource edges.
    addDependencies(nodes, directoryReadyId, [dnsReadyId]);
    addDependencies(nodes, actionId(ingressRef, "http-ready"), [dnsReadyId, directoryReadyId]);
    addDependencies(nodes, actionId(`resource:${certificate.id}`, "certificate-ready"), [dnsReadyId, actionId(ingressRef, "http-ready")]);
    const tlsReadyId = actionId(ingressRef, "tls-ready");
    addNode(nodes, {
      id: tlsReadyId,
      kind: "reconcile-ingress-tls@1",
      phase: "reconcile",
      ownerRef: ingressRef,
      dependsOn: uniqueSorted([
        actionId(ingressRef, "http-ready"),
        actionId(`resource:${certificate.id}`, "certificate-ready"),
      ]),
      connection: ingress.connection,
      metadata: { hostname: ingress.desired.hostname },
    });
    const validateId = actionId(ingressRef, "nginx-valid");
    addNode(nodes, {
      id: validateId,
      kind: "validate-nginx@1",
      phase: "reconcile",
      ownerRef: ingressRef,
      dependsOn: [tlsReadyId],
      connection: ingress.connection,
    });
    const reloadId = actionId(ingressRef, "reloaded");
    addNode(nodes, {
      id: reloadId,
      kind: "reload-nginx@1",
      phase: "reconcile",
      ownerRef: ingressRef,
      dependsOn: [validateId],
      connection: ingress.connection,
    });

    const resourceVerifyIds = recipeResources.map((resource) => {
      const id = actionId(`unit:${unit.id}/resource:${resource.id}`, "verified");
      const dependency = resource.kind === "nginx-static-site@1" || resource.kind === "letsencrypt-certificate@1"
        ? reloadId
        : resourceReadyAction(resource);
      addNode(nodes, {
        id,
        kind: "verify-resource@1",
        phase: "reconcile",
        ownerRef: `resource:${resource.id}`,
        dependsOn: [dependency],
        connection: resource.connection,
        metadata: { resourceKind: resource.kind },
      });
      return id;
    });

    const unitRef = `unit:${unit.id}`;
    const pm2BeforeId = actionId(unitRef, "pm2-before");
    addNode(nodes, {
      id: pm2BeforeId,
      kind: "snapshot-pm2@1",
      phase: "release",
      ownerRef: unitRef,
      dependsOn: uniqueSorted(resourceVerifyIds),
      connection: unit.target.observerConnection,
    });
    const stageId = actionId(unitRef, "staged");
    addNode(nodes, {
      id: stageId,
      kind: "stage-static-release@1",
      phase: "release",
      ownerRef: unitRef,
      dependsOn: [pm2BeforeId],
      connection: unit.executor.connection,
      metadata: { targetId: unit.target.targetId, targetRoot: directory.desired.root },
    });
    const activateId = actionId(unitRef, "activated");
    addNode(nodes, {
      id: activateId,
      kind: "activate-static-release@1",
      phase: "activate",
      ownerRef: unitRef,
      dependsOn: [stageId],
      connection: unit.executor.connection,
      metadata: { targetId: unit.target.targetId },
    });
    const verificationIds = [...unit.verification].sort((a, b) => a.id.localeCompare(b.id)).map((verification) => {
      const id = actionId(`${unitRef}/verification:${verification.id}`, "passed");
      addNode(nodes, {
        id,
        kind: "verify-release@1",
        phase: "verify",
        ownerRef: `verification:${verification.id}`,
        dependsOn: [activateId],
        metadata: { probeKind: verification.kind },
      });
      return id;
    });
    const pm2AfterId = actionId(unitRef, "pm2-unchanged");
    addNode(nodes, {
      id: pm2AfterId,
      kind: "compare-pm2@1",
      phase: "verify",
      ownerRef: unitRef,
      dependsOn: uniqueSorted([pm2BeforeId, ...verificationIds]),
      connection: unit.target.observerConnection,
    });

    for (const watch of environment.watch.filter((entry) => entry.unit === unit.id).sort((a, b) => a.id.localeCompare(b.id))) {
      addNode(nodes, {
        id: actionId(`watch:${watch.id}`, "observed"),
        kind: "observe-watch@1",
        phase: "watch",
        ownerRef: `watch:${watch.id}`,
        dependsOn: [pm2AfterId],
        connection: watch.connection,
        metadata: { monitorKey: watch.monitorKey, hostname: watch.hostname },
      });
    }
  }

  const nodeList = [...nodes.values()].sort(nodeCompare);
  return {
    projectId: manifest.projectId,
    environmentId: environment.id,
    nodes: nodeList,
    order: topologicallySortDeploymentActions(nodeList),
  };
}

/** Expands one validated environment into its stored, deterministic action graph. */
export function expandDeploymentGraph(manifest: DeploymentManifestV1, environmentId: string): ExpandedDeploymentGraph {
  const environment = manifest.environments.find((candidate) => candidate.id === environmentId);
  if (!environment) throw new DeploymentGraphError(`Unknown deployment environment ${JSON.stringify(environmentId)}`);
  return expandEnvironment(manifest, environment);
}
