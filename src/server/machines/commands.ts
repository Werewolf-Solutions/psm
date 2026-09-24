/**
 * Commands on connected servers, for managed agents.
 *
 * A command runs over SSH as the project environment's own command account
 * (set up and verified in P01): no sudo, no deployment helper, its own
 * working directory. That account is the boundary; the policy decides whether
 * the agent may use it at all, per environment, and a one-time approval covers
 * exactly one command on exactly one connection.
 */
import type { AgentPermissionStore, PermissionSnapshot } from "../agent-permissions.ts";
import { operationDigest } from "../agent-policy.ts";
import { quote } from "./plan.ts";
import type { MachineTransport } from "./ssh.ts";
import type { MachineStore } from "./store.ts";

const MAX_COMMAND = 16 * 1024;
const MAX_STDOUT = 48 * 1024;

export interface ServerEnvironment {
  environmentId: string;
  machine: string;
  host: string;
  account: string;
  workdir: string;
  connectionId: string;
}

export class MachineCommands {
  constructor(private readonly store: MachineStore, private readonly transport: MachineTransport) {}

  /** Servers this project can run commands on: verified command access only. */
  environments(projectId: string): ServerEnvironment[] {
    return this.store.accessForProject(projectId)
      .filter((access) => access.role === "command" && access.state === "ready")
      .map((access) => {
        const machine = this.store.getMachine(access.machineId);
        return { environmentId: access.environmentId, machine: machine.name, host: machine.host, account: access.account, workdir: access.workdir, connectionId: access.connectionId };
      });
  }

  async run(input: { snapshot: PermissionSnapshot; permissions: AgentPermissionStore; environmentId: string; command: string; timeoutSeconds?: number; signal?: AbortSignal }) {
    const command = String(input.command ?? "");
    if (!command.trim() || command.length > MAX_COMMAND || command.includes("\0")) throw new Error("Give one command of up to 16 KB.");
    const access = this.store.accessForProject(input.snapshot.project.id)
      .find((entry) => entry.role === "command" && entry.state === "ready" && entry.environmentId === input.environmentId);
    if (!access) {
      throw new Error(`No server is connected for ${input.snapshot.project.name} ${input.environmentId}. Needs connection: add a machine and set up command access in Machines.`);
    }
    const machine = this.store.getMachine(access.machineId);
    input.permissions.check(
      input.snapshot, "machine.command",
      { environmentId: access.environmentId, connectionId: access.connectionId, operation: operationDigest("machine.command", [access.connectionId, command]) },
      `Run on ${machine.name} (${access.environmentId}) as ${access.account} in ${access.workdir}:\n${command}`,
    );
    const seconds = Math.min(600, Math.max(5, Math.floor(input.timeoutSeconds ?? 120)));
    // The account's login shell runs this line; the command itself is one quoted word.
    const remote = `cd ${quote(access.workdir)} && exec timeout --kill-after=5s ${seconds}s bash -c ${quote(command)}`;
    const result = await this.transport.run(
      { host: machine.host, port: machine.port, user: access.account, knownHost: machine.knownHost, connectionId: access.connectionId },
      remote, "", { signal: input.signal, timeoutMs: (seconds + 15) * 1000 },
    );
    const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}\n[… ${text.length - limit} more characters]` : text;
    return {
      server: `${machine.name} (${machine.host})`,
      account: access.account,
      directory: access.workdir,
      exitCode: result.code,
      timedOut: result.code === 124,
      stdout: clip(result.stdout, MAX_STDOUT),
      stderr: clip(result.stderr, 8 * 1024),
    };
  }
}
