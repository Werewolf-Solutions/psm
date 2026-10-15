import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { RepositoryTools } from "./agent-repository-tools.ts";

const ASSET = /\.(?:jpe?g|png|webp|gif|avif|ico|svg|woff2?|ttf|otf|mp4|webm|mp3|ogg|wav)$/i;
/** Never copied, even when a project forgets to ignore them: the sandbox gets only generated values. */
const SECRET = /(?:^|\/)\.env(?:\.(?!example$|sample$|template$)[^/]*)?$/;
const OUTPUT = /(?:^|\/)(?:node_modules|vendor|dist|build|\.next|coverage)(?:\/|$)/;
/** Hash every input, including assets, without retaining the whole project in memory. */
export function taskInputs(repository: RepositoryTools, destination?: string, directory = ".") {
  const hash = createHash("sha256");
  let total = 0;
  const within = directory === "." ? "" : `${directory.replace(/\/+$/, "")}/`;
  const files = repository.taskFiles().filter(file => file.startsWith(within) && !OUTPUT.test(file) && !SECRET.test(file) && !file.startsWith(".psm/") && !file.startsWith(".psm-")).sort();
  const entries = files.map(file => {
    const source = repository.resolve(file);
    const stat = fs.statSync(source);
    const limit = (ASSET.test(file) ? 32 : 8) * 1024 * 1024;
    if (!stat.isFile() || stat.size > limit) throw new Error(`Task snapshot rejected ${file}: ${stat.size} bytes; limit ${limit} bytes. Verification has not run.`);
    total += stat.size;
    if (total > 512 * 1024 * 1024) throw new Error(`Task snapshot exceeds 512 MiB at ${file}. Verification has not run.`);
    const bytes = fs.readFileSync(source);
    hash.update(file).update("\0").update(String(stat.mode & 0o777)).update("\0").update(String(bytes.length)).update("\0").update(bytes);
    if (destination) {
      const target = path.join(destination, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { mode: stat.mode & 0o777 });
    }
    return { file, source, mode: stat.mode & 0o777 };
  });
  return { entries, digest: hash.digest("hex") };
}
export function packageDirectory(file: string): string { return path.posix.dirname(file); }
