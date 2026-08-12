import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { ProjectIdentity } from "./types.ts";

/**
 * A project's stable id lives in the project folder (`.psm/identity.json`), not in psm's
 * overrides.json, so it survives a rename, a move, or a clone on another machine. Ids are
 * minted lazily — psm never writes into a project until you ask it to.
 */

const ID_PATTERN = /^prj_[0-9a-f]{20}$/;

function identityFile(projectDir: string): string {
  return path.join(projectDir, ".psm", "identity.json");
}

export function isProjectId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function mintProjectId(): string {
  return `prj_${randomBytes(10).toString("hex")}`;
}

/** The identity recorded in the folder, or null when none has been assigned yet. */
export function readIdentity(projectDir: string): ProjectIdentity | null {
  try {
    const raw = JSON.parse(fs.readFileSync(identityFile(projectDir), "utf8"));
    if (!isProjectId(raw?.id)) return null;
    return {
      version: 1,
      id: raw.id,
      name: typeof raw.name === "string" ? raw.name : "",
      createdAt: Number(raw.createdAt) || 0,
    };
  } catch {
    return null;
  }
}

export function readProjectId(projectDir: string): string | null {
  return readIdentity(projectDir)?.id ?? null;
}

/** Assign an id if the folder has none; returns the existing identity untouched when it has one. */
export function ensureProjectId(projectDir: string, projectName: string): ProjectIdentity {
  const existing = readIdentity(projectDir);
  if (existing) return existing;

  const identity: ProjectIdentity = {
    version: 1,
    id: mintProjectId(),
    name: projectName,
    createdAt: Date.now(),
  };
  const file = identityFile(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(identity, null, 2) + "\n");
  fs.renameSync(temp, file);
  return identity;
}
