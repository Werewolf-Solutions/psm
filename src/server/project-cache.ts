import fs from "node:fs";

/**
 * The project list, scanned once and reused.
 *
 * A scan reads every project folder and runs four `git` processes per
 * repository — about 900ms for a 60-project workspace — and the server asked
 * for the list on nearly every request, some of them several times. Opening a
 * project or switching a tab therefore waited seconds for work that had
 * already been done a moment earlier.
 *
 * A cached list is replaced when it is older than `ttlMs`, when any input file
 * (config, overrides, links) changed on disk — including edits made outside
 * psm — or when `invalidate()` is called for a change the files do not show,
 * such as a new project folder or identity file. Git details can therefore lag
 * by up to `ttlMs`; nothing that acts on a repository reads them from here.
 */
export interface ProjectCacheOptions<T> {
  scan: () => T[];
  /** Files whose change means the list may have changed. */
  inputs: () => string[];
  ttlMs?: number;
  now?: () => number;
}

export function createProjectCache<T>(options: ProjectCacheOptions<T>): { get(): T[]; invalidate(): void } {
  const ttl = options.ttlMs ?? 30_000;
  const now = options.now ?? Date.now;
  let value: T[] | null = null;
  let scannedAt = 0;
  let fingerprint = "";
  const stamp = () => options.inputs().map((file) => {
    try { const stat = fs.statSync(file); return `${file}:${stat.mtimeMs}:${stat.size}`; }
    catch { return `${file}:missing`; }
  }).join("|");
  return {
    get() {
      // Stamped before scanning: a file that changes mid-scan differs next time.
      const current = stamp();
      if (!value || now() - scannedAt >= ttl || current !== fingerprint) {
        value = options.scan();
        scannedAt = now();
        fingerprint = current;
      }
      // Each caller gets its own copy, so one route sorting or annotating the
      // list cannot change what the next request reads.
      return structuredClone(value);
    },
    invalidate() { value = null; },
  };
}
