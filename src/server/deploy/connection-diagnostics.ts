import type { PlanConnectionSnapshot } from "./planner.ts";
export interface ConnectionDiagnostic {
  code: string;
  title: string;
  detail: string;
  dependents: string[];
}
/** Inputs are public adapter diagnostics, already secret-redacted at observation. */
export function connectionDiagnostics(input: {
  ready: boolean; detail: string;
  resources: Array<{ id: string; state: string; detail: string }>;
}): ConnectionDiagnostic[] {
  const grouped = new Map<string, ConnectionDiagnostic>();
  const add = (raw: string, dependent?: string) => {
    const detail = raw
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[private key redacted]")
      .replace(/Load key "[^"]*"/g, 'Load key "[credential file]"')
      .replace(/\x1b\[[0-9;]*m/g, "").slice(0, 4000);
    const code = /error in libcrypto|invalid format|incorrect passphrase/i.test(detail) ? "ssh-key-load-failed"
      : /permission denied \(publickey/i.test(detail) ? "ssh-key-rejected"
      : /not a ready .* profile/i.test(detail) ? "connection-profile-not-ready"
      : "connection-check-failed";
    const title = code === "ssh-key-load-failed" ? "SSH private key could not be loaded"
      : code === "ssh-key-rejected" ? "SSH key was rejected by the host"
      : code === "connection-profile-not-ready" ? "Connection profile is not ready"
      : "Connection or dependent resource needs attention";
    const key = `${code}:${detail}`;
    const diagnostic = grouped.get(key) ?? { code, title, detail, dependents: [] };
    if (dependent && !diagnostic.dependents.includes(dependent)) diagnostic.dependents.push(dependent);
    grouped.set(key, diagnostic);
  };
  if (!input.ready) add(input.detail);
  for (const resource of input.resources) {
    if (["blocked", "unknown", "conflict"].includes(resource.state) && resource.detail !== "Choose Discover changes") add(resource.detail, resource.id);
  }
  return [...grouped.values()];
}

/** Never attribute observations from an old binding or credential to its replacement. */
export function sameObservedConnection(current: PlanConnectionSnapshot, observed: PlanConnectionSnapshot): boolean {
  return (["slot", "kind", "connectionId", "metadataRevision", "bindingRevision", "secretGeneration", "scopeFingerprint"] as const)
    .every((key) => current[key] === observed[key]);
}
