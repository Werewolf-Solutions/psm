import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { AgentPermission, PermissionSnapshot } from "./agent-permissions.ts";
import { PermissionError, type PermissionChecker } from "./agent-permissions.ts";
import { taskInputs, packageDirectory } from "./agent-task-inputs.ts";
import { operationDigest } from "./agent-policy.ts";
import { bumpWorkspaceVersion, compareWorkspaceVersions, type ReleaseBump } from "./deploy/source.ts";

const MAX_FILE = 1024 * 1024;
const PROTECTED = /^(?:\.git|\.claude|\.codex|\.agents|\.ssh|\.psm-data|\.psm-sessions\.json|\.env(?:\..*)?|\.npmrc|\.netrc|\.mcp\.json|.*\.(?:pem|key|p12|pfx))$/i;
const IGNORED = new Set(["node_modules", "vendor", "dist", "build", ".next", "coverage"]);
export class RepositoryTools {
  private readonly verifiedBuilds = new Map<string, string>();
  private readonly verifiedPreviews = new Map<string, string>();
  /** The latest run_tests outcome; a red run keeps the work unverified until tests pass again. */
  private lastTests: { digest: string; ok: boolean } | null = null;
  private readonly staged = new Map<string, { index: string; head: string }>();
  constructor(readonly snapshot: PermissionSnapshot, private readonly store: PermissionChecker, private readonly protectedRoots: readonly string[] = [], private readonly affectedFiles?: () => string[]) {}
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
    const tracked = this.git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
      .split("\0")
      .filter(Boolean)
      .filter((file) => {
        try { return fs.statSync(this.resolve(file)).isFile(); }
        catch { return false; }
      });
    // A job clone contains plain, locally copied files for recorded submodules.
    // Parent Git reports only the gitlink, so include those files in test inputs.
    const modulesFile = path.join(this.snapshot.project.path, ".gitmodules");
    if (!fs.existsSync(modulesFile)) return tracked;
    const configured = new Set([...fs.readFileSync(modulesFile, "utf8").matchAll(/^\s*path\s*=\s*(\S+)\s*$/gm)].map(match => match[1]));
    const gitlinks = this.git(["ls-files", "--stage", "-z"]).split("\0").filter(Boolean)
      .map(entry => /^160000 [0-9a-f]{40} 0\t(.+)$/s.exec(entry)?.[1]).filter((file): file is string => !!file && configured.has(file));
    if (!gitlinks.length) return tracked;
    return [...new Set([...tracked, ...this.list().filter(file => gitlinks.some(link => file.startsWith(`${link}/`)) )])];
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
  /** Root X.Y.Z belongs to the managed commit, not to the model remembering a rule. */
  private prepareCommitVersion(message: string, releaseBump: ReleaseBump): string | null {
    const names = this.stagedNames();
    if (names.length && names.every((file) => /\.(?:md|rst)$/i.test(file))) return null;
    const tracked = this.git(["ls-files", "-z", "--", "package.json"]).split("\0").includes("package.json");
    if (!tracked) return null; // Non-package projects retain their existing commit behavior.
    const stagedText = this.git(["show", ":package.json"]);
    const pkg = JSON.parse(stagedText);
    let previous: string | undefined;
    const hadPackage = this.git(["ls-tree", "--name-only", "HEAD", "--", "package.json"]).trim();
    if (hadPackage) previous = JSON.parse(this.git(["show", "HEAD:package.json"])).version;
    if (typeof pkg.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg.version))
      throw new PermissionError("Managed commits require the root package.json version to use X.Y.Z.");
    let version: string = pkg.version;
    if (previous) {
      const compared = compareWorkspaceVersions(version, previous);
      if (compared < 0 && !/(?:version[- ]regression[- ]reason|version decrease|lower version)\s*:/i.test(message))
        throw new PermissionError("A lower version requires a version-regression-reason: in the commit message.");
      if (compared >= 0) {
        const selected = bumpWorkspaceVersion(previous, releaseBump);
        if (compareWorkspaceVersions(version, selected) < 0) version = selected;
      }
    }
    const edits: Array<{ file: string; text: string }> = [];
    const files = ["package.json", "package-lock.json", "npm-shrinkwrap.json"];
    for (const file of files) {
      const present = this.git(["ls-files", "-z", "--", file]).split("\0").includes(file);
      if (!present) {
        if (fs.existsSync(path.join(this.snapshot.project.path, file)))
          throw new PermissionError(`Review and stage ${file} before committing; PSM will not include an untracked version file automatically.`);
        continue;
      }
      const text = file === "package.json" ? stagedText : this.git(["show", `:${file}`]);
      // Never replace or silently include an operator's partially staged edits.
      if (this.read(file) !== text) throw new PermissionError(`Review and stage ${file} before committing; it has unstaged changes that PSM will preserve.`);
      const data = JSON.parse(text);
      const changed = data.version !== version || (file !== "package.json" && data.packages?.[""] && data.packages[""].version !== version);
      if (!changed) continue;
      data.version = version;
      if (file !== "package.json" && data.packages?.[""]) data.packages[""].version = version;
      const indent = /\n([\t ]+)"/.exec(text)?.[1] ?? "  ";
      edits.push({ file, text: JSON.stringify(data, null, indent) + "\n" });
    }
    if (edits.length) {
      this.allow("repo.edit");
      // Validate every destination before the first write.
      for (const edit of edits) this.resolve(edit.file, false, true);
      for (const edit of edits) this.write(edit.file, edit.text);
      this.stage(edits.map((edit) => edit.file));
    }
    return version;
  }
  /** Only the managed runner records successful checks; there is no agent tool to bypass them. */
  recordVerification(directory: string, kind: "build" | "preview", digest: string): void {
    (kind === "build" ? this.verifiedBuilds : this.verifiedPreviews).set(directory, digest);
  }
  invalidateVerification(directory: string, kind: "build" | "preview"): void {
    (kind === "build" ? this.verifiedBuilds : this.verifiedPreviews).delete(directory);
  }
  recordTests(digest: string, ok: boolean): void {
    this.lastTests = { digest, ok };
  }
  verificationStatus() {
    const packages = this.verificationPackages();
    const digest = taskInputs(this).digest;
    const tests = this.lastTests
      ? { ran: true, passed: this.lastTests.ok, current: this.lastTests.digest === digest }
      : { ran: false, passed: null, current: false };
    return { verified: (!this.lastTests || this.lastTests.ok) && packages.every(pkg => (!pkg.build || this.verifiedBuilds.get(pkg.directory) === digest) && (!pkg.browser || this.verifiedPreviews.get(pkg.directory) === digest)), packages: packages.map(pkg => ({ ...pkg, buildVerified: !pkg.build || this.verifiedBuilds.get(pkg.directory) === digest, browserVerified: !pkg.browser || this.verifiedPreviews.get(pkg.directory) === digest })), tests, note: tests.ran && !tests.passed ? "The latest run_tests failed, so this work is not verified, whatever caused the failure." : tests.ran ? "" : "run_tests has not been run in this session; this status covers builds and browser checks only." };
  }
  verificationPackages(): Array<{ directory: string; build: boolean; browser: boolean }> {
    const packages = taskInputs(this).entries.filter(({ file }) => path.posix.basename(file) === "package.json").map(({ file }) => {
      const pkg = JSON.parse(this.read(file));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const browser = ["react", "vue", "@angular/core", "svelte", "next", "nuxt", "vite"].some(name => name in deps);
      return { directory: packageDirectory(file), build: typeof pkg.scripts?.build === "string", browser };
    });
    const changed = this.affectedFiles?.();
    const affected = changed ? new Set(changed.map(file => packages
      .filter(pkg => pkg.directory === "." || file.startsWith(`${pkg.directory}/`))
      .sort((a, b) => b.directory.length - a.directory.length)[0]?.directory)) : null;
    return packages.filter(pkg => (pkg.build || pkg.browser) && (!affected || affected.has(pkg.directory)));
  }
  private requireVerification(): void {
    const names = this.stagedNames();
    if (!names.length || names.every(file => /\.(?:md|rst)$/i.test(file))) return;
    const packages = this.verificationPackages();
    if (!packages.length) return;
    const digest = taskInputs(this).digest;
    const missing: string[] = [];
    for (const pkg of packages) {
      if (pkg.build && this.verifiedBuilds.get(pkg.directory) !== digest) missing.push(`build in ${pkg.directory}`);
      if (pkg.browser && this.verifiedPreviews.get(pkg.directory) !== digest) missing.push(`browser preview in ${pkg.directory}`);
    }
    if (missing.length) throw new PermissionError(`Commit blocked: current source is unverified. Required: ${missing.join(", ")}. Run install_packages and run_script(build), then preview_check for frontend packages. Checks that fail or are blocked do not count as completion.`);
    // A passing worktree build cannot certify a different, partially staged file.
    for (const file of names) {
      const source = this.resolve(file, true);
      const staged = this.git(["ls-files", "--stage", "-z", "--", file]);
      if (!fs.existsSync(source)) {
        if (staged) throw new PermissionError(`Commit blocked: ${file} differs from verified source. Restage and verify.`);
      } else {
        const hash = this.git(["hash-object", "--no-filters", "--stdin"], fs.readFileSync(source)).trim();
        const mode = fs.statSync(source).mode & 0o111 ? "100755" : "100644";
        if (!staged.startsWith(`${mode} ${hash} 0\t`)) throw new PermissionError(`Commit blocked: ${file} differs from verified source. Restage and verify.`);
      }
    }
  }
  commit(message: string, releaseBump: ReleaseBump = "patch"): string {
    this.allow("git.commit");
    if (!message.trim() || message.length > 4000 || message.includes("\0")) throw new PermissionError("Provide a commit message of 1–4000 characters.");
    const key = this.snapshot.project.path;
    if (!this.staged.has(key) || this.staged.get(key)?.index !== this.indexDigest() || this.staged.get(key)?.head !== this.headIdentity()) throw new PermissionError("Commit only files staged by this turn; the index changed or belongs to another turn.");
    this.requireVerification();
    const version = this.prepareCommitVersion(message, releaseBump);
    const result = this.git(["-c", "core.editor=false", "commit", "--no-verify", "--no-gpg-sign", "-m", message]);
    this.staged.delete(key);
    return version ? `${result}\nPSM committed release version ${version} (root package and lockfiles synchronized).` : result;
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
    const name = this.remoteName(remote);
    const target = this.branchName(branch || this.git(["branch", "--show-current"]).trim());
    const head = this.git(["rev-parse", "HEAD"]).trim();
    // A one-time approval covers exactly this commit to exactly this branch.
    this.store.check(this.snapshot, "git.push", { connectionId: name, operation: operationDigest("git.push", [name, target, head]) }, `Push ${head.slice(0, 12)} to ${name}/${target} in ${this.snapshot.project.name}`);
    const result = this.git(["push", "--porcelain", name, `HEAD:refs/heads/${target}`], undefined, true);
    return result || `Pushed HEAD to ${name}/${target}.`;
  }
}
