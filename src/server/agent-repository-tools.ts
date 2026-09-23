import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { AgentPermission, PermissionSnapshot } from "./agent-permissions.ts";
import { AgentPermissionStore, PermissionError } from "./agent-permissions.ts";

const MAX_FILE = 1024 * 1024;
const PROTECTED = /^(?:\.git|\.claude|\.codex|\.agents|\.ssh|\.psm-data|\.psm-sessions\.json|\.env(?:\..*)?|\.npmrc|\.netrc|\.mcp\.json|.*\.(?:pem|key|p12|pfx))$/i;
const IGNORED = new Set(["node_modules", "vendor", "dist", "build", ".next", "coverage"]);
export class RepositoryTools {
  private readonly staged = new Map<string, { index: string; head: string }>();
  constructor(readonly snapshot: PermissionSnapshot, private readonly store: AgentPermissionStore, private readonly protectedRoots: readonly string[] = []) {}
  private allow(permission: AgentPermission): void { this.store.check(this.snapshot, permission); }
  /** Reject aliases rather than relying on a lexical path-prefix check. */
  resolve(relative: string, missing = false, writing = false): string {
    if (!relative || path.isAbsolute(relative) || relative.includes("\\") || relative.includes("\0")) throw new PermissionError("Use a repository-relative file path.");
    const parts = relative.split("/");
    if (parts.some((part) => !part || part === "." || part === ".." || PROTECTED.test(part))) throw new PermissionError("This path is protected or outside the repository.");
    if (writing && parts[0] === ".psm" && /^(?:identity|capabilities|permissions)\.json$/.test(parts[1] ?? "")) throw new PermissionError("Project identity and permission declarations are operator-managed.");
    let current = this.snapshot.project.path;
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      if (this.protectedRoots.some((root) => current === root || current.startsWith(root + path.sep))) throw new PermissionError("PSM authority and runtime files are protected.");
      if (!fs.existsSync(current)) {
        // lstat catches broken symlinks, which existsSync follows.
        try { if (fs.lstatSync(current).isSymbolicLink()) throw new PermissionError("Symlinks are not permitted."); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (missing && index === parts.length - 1) return current;
        throw new PermissionError("The parent directory or file does not exist.");
      }
      const stat = fs.lstatSync(current);
      if (stat.isDirectory() && fs.existsSync(path.join(current, ".git"))) throw new PermissionError("Nested repositories require their own project scope and grants.");
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) throw new PermissionError("Symlinks and hard-linked files are not permitted.");
      if (index < parts.length - 1 && !stat.isDirectory()) throw new PermissionError("A parent is not a directory.");
    }
    return current;
  }
  read(file: string): string {
    this.allow("repo.read");
    const resolved = this.resolve(file);
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > MAX_FILE) throw new PermissionError("Read a regular file of at most 1 MiB.");
    const content = fs.readFileSync(resolved, "utf8");
    if (content.includes("\0")) throw new PermissionError("Binary files are not supported.");
    return content;
  }
  list(): string[] {
    this.allow("repo.read");
    const files: string[] = [];
    let inspected = 0;
    const walk = (directory: string, prefix: string, depth: number) => {
      if (depth > 12 || inspected > 10_000) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (++inspected > 10_000) return;
        if (PROTECTED.test(entry.name) || IGNORED.has(entry.name) || entry.isSymbolicLink()) continue;
        const relative = prefix + entry.name;
        try { this.resolve(relative); } catch { continue; }
        if (entry.isDirectory()) walk(path.join(directory, entry.name), relative + "/", depth + 1);
        else if (entry.isFile()) files.push(relative);
      }
    };
    walk(this.snapshot.project.path, "", 0);
    return files;
  }
  /** Files that define the current test input. In Git checkouts, ignored runtime
   * output (logs, caches, uploads, and other generated data) must not turn into
   * source merely because it exists beside the checkout. */
  taskFiles(): string[] {
    this.allow("repo.read");
    const dotGit = path.join(this.snapshot.project.path, ".git");
    if (!fs.existsSync(dotGit) || !fs.lstatSync(dotGit).isDirectory()) return this.list();
    return this.git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
      .split("\0")
      .filter(Boolean)
      .filter((file) => {
        try { return fs.statSync(this.resolve(file)).isFile(); }
        catch { return false; }
      });
  }
  search(text: string): Array<{ file: string; line: number; text: string }> {
    this.allow("repo.read");
    if (!text || text.length > 200) throw new PermissionError("Search for 1–200 literal characters.");
    const hits: Array<{ file: string; line: number; text: string }> = [];
    for (const file of this.list()) {
      if (hits.length >= 100) break;
      let content: string;
      try { content = this.read(file); } catch { continue; }
      for (const [index, line] of content.split("\n").entries()) {
        if (line.includes(text)) hits.push({ file, line: index + 1, text: line.slice(0, 500) });
        if (hits.length >= 100) break;
      }
    }
    return hits;
  }
  write(file: string, content: string): string {
    this.allow("repo.edit");
    if (Buffer.byteLength(content) > MAX_FILE || content.includes("\0")) throw new PermissionError("Write at most 1 MiB of text.");
    const resolved = this.resolve(file, true, true);
    // No implicit parent creation: each directory is checked separately.
    const fd = fs.openSync(resolved, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o644);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new PermissionError("Write a regular, unlinked file.");
      fs.ftruncateSync(fd, 0); fs.writeFileSync(fd, content);
    } finally { fs.closeSync(fd); }
    return `Updated ${file}`;
  }
  mkdir(directory: string): string {
    this.allow("repo.edit");
    fs.mkdirSync(this.resolve(directory, true, true));
    return `Created ${directory}`;
  }
  delete(file: string): string {
    this.allow("repo.delete");
    const resolved = this.resolve(file, false, true);
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) fs.rmdirSync(resolved);
    else if (stat.isFile()) fs.unlinkSync(resolved);
    else throw new PermissionError("Delete an ordinary file or empty directory.");
    return `Deleted ${file}`;
  }
  private git(args: string[], input?: string | Buffer, remote = false): string {
    const root = this.snapshot.project.path;
    const dotGit = path.join(root, ".git");
    if (!fs.lstatSync(dotGit).isDirectory() || fs.lstatSync(dotGit).isSymbolicLink()) throw new PermissionError("Managed Git requires an ordinary checkout; linked worktrees are not supported.");
    // Git's own state may not redirect writes into another checkout or authority file.
    const check = (directory: string, depth = 0): void => {
      if (depth > 12) throw new PermissionError("Git metadata nesting is unsupported.");
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, item.name);
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new PermissionError("Git metadata contains a link; managed Git is unavailable.");
        if (item.isDirectory()) check(target, depth + 1);
      }
    };
    check(dotGit);
    const env: NodeJS.ProcessEnv = remote
      ? { PATH: process.env.PATH || "/usr/bin:/bin", HOME: homedir(), LANG: "C.UTF-8", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_LITERAL_PATHSPECS: "1", ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}) }
      : { PATH: "/usr/bin:/bin", HOME: root, LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_LITERAL_PATHSPECS: "1" };
    const base = ["--git-dir", dotGit, "--work-tree", root];
    // Even status and commit may invoke clean/process filters while refreshing
    // the index. Disable every configured filter, including include-file entries.
    let keys = "";
    try { keys = execFileSync("/usr/bin/git", [...base, "config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"], { cwd: root, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: MAX_FILE, timeout: 5000 }); }
    catch (error) { if ((error as { status?: number }).status !== 1) throw error; }
    const filters = keys.split("\0").filter(Boolean).flatMap((key) => ["-c", `${key}=${key.endsWith(".required") ? "false" : ""}`]);
    // Commit as whoever Git on this machine would commit as: repository, global
    // and system config, the GIT_AUTHOR_*/GIT_COMMITTER_* environment, and, when
    // none of those name anyone, Git's own detection from the account name and
    // host. Asking `git var` instead of reading user.name/user.email is the point:
    // a machine with no configured identity still commits fine by hand, and
    // refusing it there made psm stricter than Git. The lookup reads identity
    // only; the command below still runs with global config, hooks, filters and
    // signing disabled.
    const identity = (kind: "AUTHOR" | "COMMITTER"): { name: string; email: string } => {
      const lookup: NodeJS.ProcessEnv = { PATH: env.PATH, HOME: homedir(), LANG: env.LANG, GIT_TERMINAL_PROMPT: "0" };
      for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) if (process.env[key]) lookup[key] = process.env[key];
      let ident = "";
      try { ident = execFileSync("/usr/bin/git", [...base, "var", `GIT_${kind}_IDENT`], { cwd: root, env: lookup, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 }).trim(); }
      catch { /* Git itself has no identity it would commit with */ }
      const match = /^(.+?) <([^<>]+)> \d+ [+-]\d{4}$/.exec(ident);
      if (!match) throw new PermissionError("Git cannot tell who to commit as in this checkout. Set user.name and user.email (for example git config --global user.name \"Your Name\"), then resume preparation.");
      return { name: match[1], email: match[2] };
    };
    if (args.includes("commit") || args.includes("merge") || args[0] === "var") {
      const author = identity("AUTHOR"), committer = identity("COMMITTER");
      env.GIT_AUTHOR_NAME = author.name; env.GIT_AUTHOR_EMAIL = author.email;
      env.GIT_COMMITTER_NAME = committer.name; env.GIT_COMMITTER_EMAIL = committer.email;
    }
    return execFileSync("/usr/bin/git", ["--git-dir", dotGit, "--work-tree", root, "--no-pager", ...filters, "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false", "-c", "core.splitIndex=false", "-c", "core.untrackedCache=false", ...args], { cwd: root, env, input, encoding: "utf8", maxBuffer: 2 * MAX_FILE, timeout: 15_000, stdio: ["pipe", "pipe", "pipe"] });
  }
  preflightCommit(): void {
    this.allow("repo.read"); this.allow("git.commit");
    this.git(["var", "GIT_AUTHOR_IDENT"]);
    this.headIdentity();
    if (this.stagedNames().length) throw new PermissionError("The index contains previously staged work. Commit or unstage it before starting preparation; PSM will preserve it.");
  }
  gitRead(operation: "status" | "log" | "diff", file?: string): string {
    this.allow("repo.read");
    if (operation === "status") return this.git(["status", "--short", "--untracked-files=normal", "--ignore-submodules=all"]);
    if (operation === "log") return this.git(["log", "-20", "--oneline", "--no-decorate"]);
    if (operation !== "diff" || !file) throw new PermissionError("Diff requires a named file.");
    this.resolve(file, true);
    return this.git(["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "HEAD", "--", file]);
  }
  private headIdentity(): string { return this.git(["rev-parse", "HEAD"]).trim() + ":" + this.git(["symbolic-ref", "HEAD"]).trim(); }
  private indexDigest(): string { return createHash("sha256").update(this.git(["ls-files", "--stage", "-z"])).digest("hex"); }
  private stagedNames(): string[] { return this.git(["diff", "--cached", "--name-only", "-z", "--no-renames"]).split("\0").filter(Boolean).sort(); }
  stage(files: string[]): string {
    this.allow("git.commit"); this.allow("repo.read");
    if (!files.length || files.length > 100 || new Set(files).size !== files.length) throw new PermissionError("Stage 1–100 explicit, distinct file paths.");
    const key = this.snapshot.project.path;
    if (this.staged.has(key) ? (this.staged.get(key)?.index !== this.indexDigest() || this.staged.get(key)?.head !== this.headIdentity()) : this.stagedNames().length > 0) throw new PermissionError("The index contains changes staged outside this turn. Ask the operator to handle those first.");
    const entries = files.map((file) => {
      const resolved = this.resolve(file, true);
      if (/[\r\n\t]/.test(file)) throw new PermissionError("Control characters in Git paths are unsupported.");
      if (!fs.existsSync(resolved)) return { file, mode: "0", hash: "0".repeat(40) };
      const stat = fs.statSync(resolved);
      if (!stat.isFile() || stat.size > MAX_FILE) throw new PermissionError("Only regular files up to 1 MiB can be staged.");
      const hash = this.git(["hash-object", "-w", "--no-filters", "--stdin"], fs.readFileSync(resolved)).trim();
      return { file, mode: stat.mode & 0o111 ? "100755" : "100644", hash };
    });
    // index-info uses raw blob hashes: never execute repository clean filters.
    this.git(["update-index", "-z", "--index-info"], entries.map(({ file, mode, hash }) => `${mode} ${hash}\t${file}\0`).join(""));
    this.staged.set(key, { index: this.indexDigest(), head: this.headIdentity() });
    return `Staged ${files.join(", ")}`;
  }
  commit(message: string): string {
    this.allow("git.commit");
    if (!message.trim() || message.length > 4000 || message.includes("\0")) throw new PermissionError("Provide a commit message of 1–4000 characters.");
    const key = this.snapshot.project.path;
    if (!this.staged.has(key) || this.staged.get(key)?.index !== this.indexDigest() || this.staged.get(key)?.head !== this.headIdentity()) throw new PermissionError("Commit only files staged by this turn; the index changed or belongs to another turn.");
    const result = this.git(["-c", "core.editor=false", "commit", "--no-verify", "--no-gpg-sign", "-m", message]);
    this.staged.delete(key);
    return result;
  }
  private branchName(name: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(name)) throw new PermissionError("Use a simple Git branch or ref name.");
    this.git(["check-ref-format", "--branch", name]);
    return name;
  }
  private remoteName(name: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(name)) throw new PermissionError("Use the name of a configured Git remote.");
    const remotes = this.git(["remote"]).split("\n").filter(Boolean);
    if (!remotes.includes(name)) throw new PermissionError(`Git remote ${name} is not configured for this project.`);
    return name;
  }
  branch(name: string): string {
    this.allow("git.branch");
    const branch = this.branchName(name);
    this.git(["branch", "--no-track", branch, "HEAD"]);
    return `Created ${branch}; the current branch is unchanged.`;
  }
  deleteBranch(name: string): string {
    this.allow("git.branch");
    const branch = this.branchName(name);
    this.git(["branch", "-d", branch]);
    return `Deleted local branch ${branch}.`;
  }
  switchBranch(name: string): string {
    this.allow("git.switch");
    const branch = this.branchName(name);
    this.git(["switch", branch]);
    this.staged.delete(this.snapshot.project.path);
    return `Switched to ${branch}.`;
  }
  merge(ref: string): string {
    this.allow("git.merge");
    const source = this.branchName(ref);
    const result = this.git(["merge", "--no-edit", "--no-verify", source]);
    this.staged.delete(this.snapshot.project.path);
    return result || `Merged ${source}.`;
  }
  fetch(remote = "origin"): string {
    this.allow("git.fetch");
    const name = this.remoteName(remote);
    const result = this.git(["fetch", name], undefined, true);
    return result || `Fetched ${name}.`;
  }
  push(remote = "origin", branch?: string): string {
    this.allow("git.push");
    const name = this.remoteName(remote);
    const target = this.branchName(branch || this.git(["branch", "--show-current"]).trim());
    const result = this.git(["push", "--porcelain", name, `HEAD:refs/heads/${target}`], undefined, true);
    return result || `Pushed HEAD to ${name}/${target}.`;
  }
}
