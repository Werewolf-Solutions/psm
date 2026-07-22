import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Project } from "../types.ts";
import { cloudRequest } from "./cloud.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SETTINGS_FILE = path.join(ROOT, ".psm-cloud.json");
const CHUNK_SIZE = 8 * 1024 * 1024;
const HARD_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "bower_components", "dist", "build",
  ".cache", ".next", ".nuxt", "coverage", "target", "__pycache__", ".venv",
  "venv", "logs", ".ssh", ".aws", ".gnupg", ".azure", ".kube", ".docker",
  ".direnv", ".terraform",
]);
const HARD_FILES = new Set([
  ".npmrc", ".pypirc", ".netrc", ".psm-sessions.json", ".psm-cloud-device.json",
  ".psm-cloud.json", "id_rsa", "id_ed25519", "terraform.tfstate",
  "terraform.tfstate.backup",
]);
const BLOB_ID = /^[A-Za-z0-9_-]{43}$/;
const MAX_FILES = 50_000;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

interface CloudSettings {
  backupProjects: string[];
  lastBackupAt: Record<string, number>;
}

interface ManifestChunk {
  id: string;
  plainSize: number;
}

interface ManifestFile {
  path: string;
  size: number;
  mode: number;
  mtimeMs: number;
  chunks: ManifestChunk[];
}

interface BackupManifest {
  version: 1;
  projectId: string;
  projectName: string;
  createdAt: string;
  files: ManifestFile[];
  skipped: string[];
}

function atomicJson(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}

export function cloudSettings(): CloudSettings {
  try {
    const value = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    return {
      backupProjects: Array.isArray(value.backupProjects) ? value.backupProjects.map(String) : [],
      lastBackupAt: value.lastBackupAt && typeof value.lastBackupAt === "object" ? value.lastBackupAt : {},
    };
  } catch {
    return { backupProjects: [], lastBackupAt: {} };
  }
}

export function setBackupEnabled(projectName: string, enabled: boolean): CloudSettings {
  const settings = cloudSettings();
  settings.backupProjects = enabled
    ? [...new Set([...settings.backupProjects, projectName])].sort()
    : settings.backupProjects.filter((name) => name !== projectName);
  atomicJson(SETTINGS_FILE, settings);
  return settings;
}

function wildcard(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^$(){}|[\]\\]/g, "\\$&").replaceAll("**", "§§").replaceAll("*", "[^/]*").replaceAll("§§", ".*").replaceAll("?", ".");
  return new RegExp(`^(?:${escaped})(?:/.*)?$`);
}

function ignorePatterns(root: string): RegExp[] {
  try {
    return fs.readFileSync(path.join(root, ".psmignore"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"))
      .map((line) => wildcard(line.replace(/^\//, "").replace(/\/$/, "")));
  } catch {
    return [];
  }
}

export function exclusionReason(relative: string, patterns: RegExp[] = []): string | null {
  const normalized = relative.split(path.sep).join("/");
  const parts = normalized.split("/");
  const base = parts.at(-1) || "";
  if (parts.some((part) => HARD_DIRS.has(part))) return "generated/dependency directory";
  if (base.startsWith(".env")) return "environment file";
  if (HARD_FILES.has(base)) return "credential/session file";
  if (/\.log(?:\.\d+)?$/i.test(base)) return "log file";
  if (/\.(?:pem|key|p12|pfx|jks|keystore|tfstate|tfvars)$/i.test(base)) {
    return "private key or credential store";
  }
  if (patterns.some((pattern) => pattern.test(normalized))) return ".psmignore";
  return null;
}

function collectFiles(root: string): { files: string[]; skipped: string[] } {
  const files: string[] = [];
  const skipped: string[] = [];
  const patterns = ignorePatterns(root);
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      const reason = exclusionReason(relative, patterns);
      if (reason) {
        skipped.push(`${relative} (${reason})`);
        continue;
      }
      if (entry.isSymbolicLink()) {
        skipped.push(`${relative} (symbolic link)`);
        continue;
      }
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(relative);
    }
  };
  visit(root);
  if (files.length > MAX_FILES) throw new Error("Project contains more than 50,000 backup-eligible files");
  return { files: files.sort(), skipped: skipped.slice(0, 1000) };
}

export function encryptBackupObject(dataKey: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", dataKey, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptBackupObject(dataKey: Buffer, encrypted: Buffer, aad: string): Buffer {
  if (encrypted.length < 29 || encrypted[0] !== 1) throw new Error("Unsupported or truncated encrypted backup object");
  const decipher = crypto.createDecipheriv("aes-256-gcm", dataKey, encrypted.subarray(1, 13));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(encrypted.subarray(13, 29));
  return Buffer.concat([decipher.update(encrypted.subarray(29)), decipher.final()]);
}

async function dataKey(): Promise<Buffer> {
  const data = await cloudRequest("/backups/key");
  const key = Buffer.from(String(data.dataKey || ""), "base64");
  if (key.length !== 32) throw new Error("Werewolf returned an invalid PSM backup data key");
  return key;
}

async function put(url: string, data: Buffer): Promise<void> {
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(data.length),
    },
    body: new Uint8Array(data),
  });
  if (!response.ok) throw new Error(`Object upload failed (${response.status})`);
}

async function get(url: string, maxBytes: number): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Object download failed (${response.status})`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("Encrypted backup object exceeds its declared size");
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > maxBytes) throw new Error("Encrypted backup object exceeds its declared size");
  return data;
}

export async function backupProject(project: Project): Promise<any> {
  const key = await dataKey();
  const { files, skipped } = collectFiles(project.path);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "psm-backup-"));
  const manifest: BackupManifest = {
    version: 1,
    projectId: project.name,
    projectName: project.name,
    createdAt: new Date().toISOString(),
    files: [],
    skipped,
  };
  const blobs = new Map<string, { id: string; size: number; file: string }>();
  let totalBytes = 0;
  try {
    for (const relative of files) {
      const absolute = path.join(project.path, relative);
      const noFollow = fs.constants.O_NOFOLLOW || 0;
      const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | noFollow);
      const chunks: ManifestChunk[] = [];
      const stat = fs.fstatSync(descriptor);
      try {
        if (!stat.isFile()) throw new Error(`Backup input changed while reading: ${relative}`);
        let position = 0;
        while (position < stat.size) {
          const plain = Buffer.allocUnsafe(Math.min(CHUNK_SIZE, stat.size - position));
          const read = fs.readSync(descriptor, plain, 0, plain.length, position);
          const chunk = plain.subarray(0, read);
          const id = crypto.createHmac("sha256", key).update(chunk).digest("base64url");
          chunks.push({ id, plainSize: read });
          totalBytes += read;
          if (!blobs.has(id)) {
            const encrypted = encryptBackupObject(key, chunk, `psm:blob:${id}`);
            const blobFile = path.join(temp, id);
            fs.writeFileSync(blobFile, encrypted, { mode: 0o600 });
            blobs.set(id, { id, size: encrypted.length, file: blobFile });
          }
          position += read;
        }
      } finally {
        fs.closeSync(descriptor);
      }
      manifest.files.push({
        path: relative.split(path.sep).join("/"),
        size: stat.size,
        mode: stat.mode & 0o777,
        mtimeMs: stat.mtimeMs,
        chunks,
      });
    }
    const encryptedManifest = encryptBackupObject(key, Buffer.from(JSON.stringify(manifest)), "psm:manifest");
    if (encryptedManifest.length > MAX_MANIFEST_BYTES) throw new Error("Encrypted backup manifest exceeds 8 MB");
    const initiated = await cloudRequest("/backups", {
      method: "POST",
      body: JSON.stringify({
        projectId: project.name,
        projectName: project.name,
        manifestSize: encryptedManifest.length,
        totalBytes,
        fileCount: manifest.files.length,
        blobs: [...blobs.values()].map(({ id, size }) => ({ id, size })),
      }),
    });
    await put(initiated.manifestUpload.url, encryptedManifest);
    for (const upload of initiated.blobs || []) {
      const blob = blobs.get(upload.id);
      if (!blob) throw new Error("Server requested an unknown encrypted blob");
      await put(upload.url, fs.readFileSync(blob.file));
    }
    const completed = await cloudRequest(`/backups/${initiated.snapshotId}/complete`, {
      method: "POST",
      body: "{}",
    });
    const settings = cloudSettings();
    settings.lastBackupAt[project.name] = Date.now();
    atomicJson(SETTINGS_FILE, settings);
    return { ...completed, skipped, reused: initiated.reused };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

export function safeRestoreDestination(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.includes("\0")) throw new Error("Backup manifest contains an invalid path");
  const target = path.resolve(root, relative);
  const prefix = path.resolve(root) + path.sep;
  if (!target.startsWith(prefix)) throw new Error("Backup manifest attempted to escape the restore directory");
  return target;
}

export function validateBackupManifest(value: unknown): BackupManifest {
  if (!value || typeof value !== "object") throw new Error("Backup manifest must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.files) || raw.files.length > MAX_FILES) {
    throw new Error("Unsupported backup manifest");
  }
  const projectId = String(raw.projectId || "").trim();
  const projectName = String(raw.projectName || "").trim();
  const createdAt = String(raw.createdAt || "");
  if (!projectId || projectId.length > 200 || !projectName || projectName.length > 300) {
    throw new Error("Backup manifest has invalid project identity");
  }
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) {
    throw new Error("Backup manifest has an invalid creation time");
  }

  const seenPaths = new Set<string>();
  const chunkSizes = new Map<string, number>();
  let chunkCount = 0;
  const files = raw.files.map((item): ManifestFile => {
    if (!item || typeof item !== "object") throw new Error("Backup manifest file must be an object");
    const file = item as Record<string, unknown>;
    const filePath = String(file.path || "");
    const size = Number(file.size);
    const mode = Number(file.mode);
    const mtimeMs = Number(file.mtimeMs);
    if (!filePath || filePath.length > 4096 || filePath.includes("\\") || seenPaths.has(filePath)) {
      throw new Error("Backup manifest contains an invalid or duplicate file path");
    }
    seenPaths.add(filePath);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Backup manifest file size is invalid");
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error("Backup manifest file mode is invalid");
    if (!Number.isFinite(mtimeMs) || mtimeMs < 0) throw new Error("Backup manifest file time is invalid");
    if (!Array.isArray(file.chunks)) throw new Error("Backup manifest file chunks are invalid");

    let reconstructedSize = 0;
    const chunks = file.chunks.map((item): ManifestChunk => {
      chunkCount += 1;
      if (chunkCount > 1_000_000 || !item || typeof item !== "object") {
        throw new Error("Backup manifest contains too many or invalid chunks");
      }
      const chunk = item as Record<string, unknown>;
      const id = String(chunk.id || "");
      const plainSize = Number(chunk.plainSize);
      if (!BLOB_ID.test(id) || !Number.isInteger(plainSize) || plainSize < 1 || plainSize > CHUNK_SIZE) {
        throw new Error("Backup manifest chunk is invalid");
      }
      const previousSize = chunkSizes.get(id);
      if (previousSize != null && previousSize !== plainSize) {
        throw new Error("Backup manifest reuses a chunk id with a different size");
      }
      chunkSizes.set(id, plainSize);
      reconstructedSize += plainSize;
      return { id, plainSize };
    });
    if (reconstructedSize !== size) throw new Error("Backup manifest file size does not match its chunks");
    return { path: filePath, size, mode, mtimeMs, chunks };
  });

  return {
    version: 1,
    projectId,
    projectName,
    createdAt,
    files,
    skipped: Array.isArray(raw.skipped)
      ? raw.skipped.slice(0, 1000).map((item) => String(item).slice(0, 1000))
      : [],
  };
}

export async function restoreSnapshot(snapshotId: string, destination: string): Promise<any> {
  if (!path.isAbsolute(destination)) throw new Error("Restore destination must be an absolute path");
  const finalRoot = path.resolve(destination);
  if (fs.existsSync(finalRoot) && fs.readdirSync(finalRoot).length) {
    throw new Error("Restore destination must be new or empty");
  }
  const parent = path.dirname(finalRoot);
  fs.mkdirSync(parent, { recursive: true });
  const tempRoot = path.join(parent, `.${path.basename(finalRoot)}.psm-restore-${crypto.randomUUID()}`);
  fs.mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  try {
    const key = await dataKey();
    const restore = await cloudRequest(`/backups/${encodeURIComponent(snapshotId)}/restore`, {
      method: "POST",
      body: "{}",
    });
    const manifestSize = Number(restore.manifest?.size);
    if (!Number.isInteger(manifestSize) || manifestSize < 29 || manifestSize > MAX_MANIFEST_BYTES) {
      throw new Error("Restore manifest size is invalid");
    }
    const manifestEncrypted = await get(restore.manifest.url, manifestSize);
    if (manifestEncrypted.length !== manifestSize) throw new Error("Restore manifest size does not match");
    const manifest = validateBackupManifest(
      JSON.parse(decryptBackupObject(key, manifestEncrypted, "psm:manifest").toString("utf8")),
    );
    const downloads = new Map(
      (Array.isArray(restore.blobs) ? restore.blobs : []).map((blob: any) => [String(blob.id), blob]),
    );
    for (const file of manifest.files) {
      const target = safeRestoreDestination(tempRoot, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const output = fs.openSync(target, "wx", file.mode & 0o777);
      try {
        for (const chunk of file.chunks) {
          const remote: any = downloads.get(chunk.id);
          if (!remote) throw new Error(`Backup chunk is missing: ${chunk.id}`);
          const encryptedSize = Number(remote.size);
          if (encryptedSize !== chunk.plainSize + 29) {
            throw new Error("Backup chunk encrypted size is invalid");
          }
          const encrypted = await get(String(remote.url || ""), encryptedSize);
          if (encrypted.length !== encryptedSize) throw new Error("Backup chunk encrypted size does not match");
          const plain = decryptBackupObject(key, encrypted, `psm:blob:${chunk.id}`);
          const actual = crypto.createHmac("sha256", key).update(plain).digest("base64url");
          if (actual !== chunk.id || plain.length !== chunk.plainSize) throw new Error("Backup chunk integrity check failed");
          let offset = 0;
          while (offset < plain.length) offset += fs.writeSync(output, plain, offset);
        }
      } finally {
        fs.closeSync(output);
      }
      fs.chmodSync(target, file.mode & 0o777);
      fs.utimesSync(target, new Date(), new Date(file.mtimeMs));
    }
    if (fs.existsSync(finalRoot)) fs.rmdirSync(finalRoot);
    fs.renameSync(tempRoot, finalRoot);
    return { destination: finalRoot, files: manifest.files.length, skipped: manifest.skipped || [] };
  } catch (err) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw err;
  }
}

export async function snapshots(projectId?: string): Promise<any[]> {
  const suffix = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return (await cloudRequest(`/backups${suffix}`)).snapshots || [];
}

export async function deleteSnapshot(snapshotId: string): Promise<void> {
  await cloudRequest(`/backups/${encodeURIComponent(snapshotId)}`, { method: "DELETE" });
}

export async function runDueBackups(projects: Project[]): Promise<void> {
  const settings = cloudSettings();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of settings.backupProjects) {
    if ((settings.lastBackupAt[name] || 0) > cutoff) continue;
    const project = projects.find((candidate) => candidate.name === name);
    if (!project) continue;
    try { await backupProject(project); }
    catch (err) { console.error(`Daily cloud backup failed for ${name}:`, (err as Error).message); }
  }
}
