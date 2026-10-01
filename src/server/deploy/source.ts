import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const COMMIT = /^[0-9a-f]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export class DeploymentSourceError extends Error {
  constructor(message: string, readonly code = "source-invalid") {
    super(message);
  }
}

export interface DeploymentSourceSnapshot {
  checkoutId: string;
  checkoutPath: string;
  commit: string;
  branch: string | null;
  manifestText: string;
  manifestDigest: string;
  identityText: string;
  identityDigest: string;
  packageText: string;
  packageDigest: string;
  projectId: string;
  version: string;
  subject: string;
}

function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024,
    }).trimEnd();
  } catch (error) {
    const stderr = String((error as { stderr?: string | Buffer }).stderr ?? "").trim();
    throw new DeploymentSourceError(stderr || `git ${args[0]} failed`, "source-git-failed");
  }
}

const sha256 = (text: string) =>
  `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

export function checkoutId(checkoutPath: string): string {
  const real = fs.realpathSync(checkoutPath);
  return `chk_${createHash("sha256").update(real).digest("hex").slice(0, 20)}`;
}

export function resolveCommit(checkoutPath: string, revision = "HEAD"): string {
  const root = fs.realpathSync(checkoutPath);
  const commit = git(root, ["rev-parse", "--verify", `${revision}^{commit}`]).trim();
  if (!COMMIT.test(commit)) throw new DeploymentSourceError("source did not resolve to a full commit");
  return commit;
}

export function commitReachableFrom(
  checkoutPath: string,
  commit: string,
  allowedRef: string,
): boolean {
  if (!COMMIT.test(commit)) throw new DeploymentSourceError("commit must be a full SHA");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(allowedRef) || allowedRef.includes("..")) {
    throw new DeploymentSourceError("allowed source ref is invalid");
  }
  try {
    execFileSync("git", ["-C", checkoutPath, "merge-base", "--is-ancestor", commit, allowedRef], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function compareWorkspaceVersions(left: string, right: string): number {
  const a = left.match(VERSION);
  const b = right.match(VERSION);
  if (!a || !b) throw new DeploymentSourceError("version must use X.Y.Z");
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export function readDeploymentSource(
  checkoutPath: string,
  revision = "HEAD",
): DeploymentSourceSnapshot {
  const root = fs.realpathSync(checkoutPath);
  const commit = resolveCommit(root, revision);
  const read = (file: string) => git(root, ["show", `${commit}:${file}`]) + "\n";
  const manifestText = read(".psm/deployments.json");
  const identityText = read(".psm/identity.json");
  const packageText = read("package.json");
  let identity: unknown;
  let pkg: unknown;
  try {
    identity = JSON.parse(identityText);
    pkg = JSON.parse(packageText);
  } catch {
    throw new DeploymentSourceError("identity or root package metadata is invalid JSON");
  }
  const projectId = String((identity as { id?: unknown })?.id ?? "");
  if (!/^prj_[0-9a-f]{20}$/.test(projectId)) {
    throw new DeploymentSourceError("commit does not contain a valid PSM project identity");
  }
  const version = String((pkg as { version?: unknown })?.version ?? "");
  if (!VERSION.test(version)) {
    throw new DeploymentSourceError("repo-root package.json version must use X.Y.Z");
  }
  let branch: string | null = null;
  try {
    const current = git(root, ["symbolic-ref", "--short", "HEAD"]).trim();
    branch = current || null;
  } catch {
    // A detached checkout is a valid exact source.
  }
  return {
    checkoutId: checkoutId(root),
    checkoutPath: root,
    commit,
    branch,
    manifestText,
    manifestDigest: sha256(manifestText),
    identityText,
    identityDigest: sha256(identityText),
    packageText,
    packageDigest: sha256(packageText),
    projectId,
    version,
    subject: git(root, ["show", "-s", "--format=%s", commit]),
  };
}

/** A build of HEAD cannot include any uncommitted source, including new files. */
export function deploymentInputsDirty(checkoutPath: string): boolean {
  const output = git(checkoutPath, [
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
    "--ignore-submodules=all",
  ]);
  return output.trim().length > 0;
}

export function artifactOutputPath(checkoutPath: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
    throw new DeploymentSourceError("artifact output must be a safe relative path");
  }
  const root = fs.realpathSync(checkoutPath);
  const candidate = path.resolve(root, relative);
  const relation = path.relative(root, candidate);
  if (relation === ".." || relation.startsWith(`..${path.sep}`)) {
    throw new DeploymentSourceError("artifact output escapes the checkout");
  }
  return candidate;
}
