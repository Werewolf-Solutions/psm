/**
 * One-click "Connect" for AI hosts: mint a client, keep its credential in a
 * private connection file, and add psm to the host's own MCP configuration.
 *
 * Every host is connected the same way, through the stdio relay
 * (scripts/psm-mcp-stdio.mjs): the host's config holds a command and the path of
 * the connection file, never the credential, and no shell profile has to export
 * anything. That is why one button works for Claude Code, Codex, an IDE
 * extension or a local-model harness alike.
 *
 * A provider here is only "how to put that command into this host's config":
 *   - claude, codex: their own CLI does it (`claude mcp add-json`, `codex mcp add`);
 *   - other: nothing is installed; psm returns the snippet to paste.
 *
 * Unlike a hand-minted client (hash only, shown once), a connected client's
 * token is kept on disk, in the connection file: 0600, in a 0700 directory
 * outside every project. Revoking the client deletes the file and removes psm
 * from the host's config.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ProviderId = "claude" | "codex" | "other";

export interface ConnectCommand {
  /** The program a host runs to reach psm, and its arguments. */
  command: string;
  args: string[];
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Its CLI was found, so Connect can configure it. Always true for "other". */
  installed: boolean;
  /** What Connect does for this provider, in a sentence. */
  does: string;
}

/** The name psm goes by in a host's MCP configuration. */
export const SERVER_NAME = "psm";

const ADAPTER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "psm-mcp-stdio.mjs");

export const connectDirectory = (): string => process.env.PSM_MCP_CONNECT_DIR || path.join(os.homedir(), ".config", "psm", "mcp");

/** Where a client's connection file lives. The id is psm's own (`mcpc_<uuid>`). */
export function connectionFile(clientId: string, directory = connectDirectory()): string {
  if (!/^mcpc_[0-9a-f-]{36}$/.test(clientId)) throw new Error("Not an MCP client id.");
  return path.join(directory, `${clientId}.json`);
}

export function writeConnection(file: string, connection: { url: string; token: string }): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  // Created 0600 from the start, so the credential is never readable by others, even briefly.
  fs.writeFileSync(file, `${JSON.stringify(connection, null, 2)}\n`, { mode: 0o600, flag: "w" });
  fs.chmodSync(file, 0o600);
}

export function removeConnection(file: string): void {
  fs.rmSync(file, { force: true });
}

export function connectCommand(file: string, node = process.execPath, adapter = ADAPTER): ConnectCommand {
  return { command: node, args: [adapter, "--connection", file] };
}

/** What to paste into a host psm cannot configure itself. */
export function snippets(command: ConnectCommand) {
  const quote = (value: string) => (/^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);
  return {
    /** The `mcpServers` shape most hosts read (Claude Desktop, Cursor, Cline, Continue, LM Studio and others). */
    json: JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: command.command, args: command.args } } }, null, 2),
    /** One line, for hosts configured with a command. */
    shell: [command.command, ...command.args].map(quote).join(" "),
    toml: `[mcp_servers.${SERVER_NAME}]\ncommand = ${JSON.stringify(command.command)}\nargs = ${JSON.stringify(command.args)}`,
  };
}

/* ---------- finding and running a host's CLI ---------- */

export type Run = (program: string, args: string[]) => Promise<{ ok: boolean; output: string }>;

/** A program on PATH, or in the places user-level CLIs install themselves. */
export function findProgram(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const directories = [...(env.PATH || "").split(path.delimiter), path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), "bin"), "/usr/local/bin", "/opt/homebrew/bin"];
  for (const directory of directories) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* not here */
    }
  }
  return null;
}

const runProgram: Run = (program, args) =>
  new Promise((resolve) => {
    execFile(program, args, { timeout: 30_000, encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout}\n${stderr}`.trim() });
    });
  });

interface Provider {
  id: ProviderId;
  label: string;
  cli: string | null;
  does: string;
  /** argv (after the program) that removes psm from the host's config; failure is fine. */
  remove: () => string[];
  add: (command: ConnectCommand) => string[];
}

const PROVIDERS: Provider[] = [
  {
    id: "claude",
    label: "Claude Code",
    cli: "claude",
    does: "Adds psm to Claude Code for your user (all folders). Start a new Claude Code session to load it.",
    remove: () => ["mcp", "remove", "--scope", "user", SERVER_NAME],
    add: (command) => ["mcp", "add-json", "--scope", "user", SERVER_NAME, JSON.stringify({ type: "stdio", command: command.command, args: command.args })],
  },
  {
    id: "codex",
    label: "Codex",
    cli: "codex",
    does: "Adds psm to ~/.codex/config.toml. Start a new Codex session to load it.",
    remove: () => ["mcp", "remove", SERVER_NAME],
    add: (command) => ["mcp", "add", SERVER_NAME, "--", command.command, ...command.args],
  },
  {
    id: "other",
    label: "Another harness or a local model",
    cli: null,
    does: "Gives you the command to paste into any MCP host: an IDE extension, a desktop app, or the harness that runs your local model.",
    remove: () => [],
    add: () => [],
  },
];

export const isProviderId = (value: unknown): value is ProviderId => PROVIDERS.some((provider) => provider.id === value);

export function listProviders(find: (name: string) => string | null = findProgram): ProviderInfo[] {
  return PROVIDERS.map((provider) => ({ id: provider.id, label: provider.label, installed: provider.cli === null || find(provider.cli) !== null, does: provider.does }));
}

export const providerLabel = (id: ProviderId): string => PROVIDERS.find((provider) => provider.id === id)!.label;

export type InstallOutcome =
  | { ok: true; configured: boolean; message: string }
  | { ok: false; message: string };

/**
 * Put psm into the host's config. Any earlier "psm" entry is replaced, so
 * connecting again is safe. "other" configures nothing and says so.
 */
export async function installInto(id: ProviderId, command: ConnectCommand, options: { find?: (name: string) => string | null; run?: Run } = {}): Promise<InstallOutcome> {
  const provider = PROVIDERS.find((entry) => entry.id === id)!;
  if (provider.cli === null) return { ok: true, configured: false, message: "Paste the command below into your host's MCP settings." };
  const program = (options.find ?? findProgram)(provider.cli);
  if (!program) return { ok: false, message: `${provider.label} was not found on this machine (no \`${provider.cli}\` command). Install it, or use "Another harness" and paste the command yourself.` };
  const run = options.run ?? runProgram;
  await run(program, provider.remove()); // an earlier entry, if any
  const added = await run(program, provider.add(command));
  if (!added.ok) return { ok: false, message: `${provider.label} refused the change: ${added.output.split("\n").filter(Boolean).pop()?.slice(0, 300) || "no message"}` };
  return { ok: true, configured: true, message: provider.does };
}

/** Take psm back out of the host's config. Best effort: a missing CLI or entry is not an error. */
export async function uninstallFrom(id: ProviderId, options: { find?: (name: string) => string | null; run?: Run } = {}): Promise<void> {
  const provider = PROVIDERS.find((entry) => entry.id === id)!;
  if (provider.cli === null) return;
  const program = (options.find ?? findProgram)(provider.cli);
  if (program) await (options.run ?? runProgram)(program, provider.remove());
}

/* ---------- a host psm started must not call psm ---------- */

/** The parent of a process, or null when it cannot be read. */
export function parentPid(pid: number): number | null {
  try {
    // /proc/<pid>/stat: "pid (comm) state ppid …"; comm may contain spaces and parentheses.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    return Number.isInteger(parent) && parent > 0 ? parent : null;
  } catch {
    return null;
  }
}

/** Is `pid` a descendant of `ancestor`? Walks parents, bounded. */
export function isDescendantOf(pid: number, ancestor: number, parent: (pid: number) => number | null = parentPid): boolean {
  let current: number | null = pid;
  for (let depth = 0; depth < 64 && current && current > 1; depth++) {
    current = parent(current);
    if (current === ancestor) return true;
  }
  return false;
}

/** A client name for a connection: "Claude Code on my-laptop", within the store's name rule. */
export function connectionName(id: ProviderId, host = os.hostname()): string {
  const label = id === "other" ? "MCP host" : providerLabel(id);
  const clean = host.replace(/[^\p{L}\p{N}._-]/gu, "-").slice(0, 30) || "this-machine";
  return `${label} on ${clean}`.slice(0, 60);
}
