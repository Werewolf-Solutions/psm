/**
 * Machine bootstrap plans: what PSM will do to a server, as data first and a
 * script second.
 *
 * The Todo staging runbook proved the shape by hand — a dedicated command
 * account with a root-owned home, a key PSM generated, a working directory, no
 * sudo — but its script hard-coded one host and one account. Here every value
 * a script needs is validated against a strict pattern, then written into one
 * quoted parameter block. Nothing the operator typed is ever concatenated into
 * shell syntax, so a machine name or project slug cannot become a command.
 *
 * The same generated script runs three ways: piped through an administrator
 * SSH connection, pasted into a server terminal as one copyable command, or
 * run in `--inspect` mode, which never changes anything and reports what it
 * would find. Its report is a flat `psm.key=value` list that `parseInspection`
 * reads back, so the server's own observation — not the script's exit code —
 * decides whether setup succeeded.
 */
import { createHash, randomBytes } from "node:crypto";

export const MACHINE_PLAN_SCHEMA = 1 as const;
export const INSPECTION_SCHEMA = "1";

export class MachinePlanError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = "MachinePlanError";
  }
}

export type MachineRole = "command" | "helper" | "deploy" | "admin";
export type RiskClass = "development" | "staging" | "production";

/** How PSM came to trust a machine's host key. Only the last two allow setup. */
export type HostKeySource = "scanned-unverified" | "operator-confirmed" | "pinned-connection";

export interface MachineIdentity {
  id: string;
  name: string;
  host: string;
  port: number;
  /** One OpenSSH known_hosts line, e.g. `203.0.113.4 ssh-ed25519 AAAA…`. */
  knownHost: string;
  hostKeyFingerprint: string;
  hostKeySource: HostKeySource;
}

export interface CommandAccessRequest {
  machine: MachineIdentity;
  projectId: string;
  projectName: string;
  environmentId: string;
  risk: RiskClass;
  /** The public half of a key PSM generated for this access. */
  publicKey: string;
  now?: number;
}

export interface CommandAccessPlan {
  schema: typeof MACHINE_PLAN_SCHEMA;
  role: "command";
  machineId: string;
  host: string;
  port: number;
  hostKeyFingerprint: string;
  projectId: string;
  environmentId: string;
  risk: RiskClass;
  account: string;
  home: string;
  workdir: string;
  comment: string;
  publicKeyFingerprint: string;
  /** Plain-language changes, in the order the script makes them. */
  operations: string[];
  /** What this access can do once created — shown before anyone approves it. */
  authority: string[];
  script: string;
  scriptDigest: string;
  /** Digest over every field above; approving a plan approves exactly this. */
  digest: string;
  createdAt: number;
}

const HOST_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_RE = /^[0-9a-fA-F:]{2,39}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACCOUNT_RE = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;
const ED25519_RE = /^ssh-ed25519 (AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/]{48,52}={0,2})(?: [^\u0000-\u001f\u007f]{0,256})?$/;
const RISKS: readonly RiskClass[] = ["development", "staging", "production"];

export function validateHost(value: unknown): string {
  const host = String(value ?? "").trim();
  if (!host || host.length > 253 || !(IPV4_RE.test(host) || HOST_RE.test(host) || (host.includes(":") && IPV6_RE.test(host)))) {
    throw new MachinePlanError("Enter a hostname or IP address, without a user, port or path.", "host");
  }
  return host.toLowerCase();
}

export function validatePort(value: unknown): number {
  const port = value === undefined || value === null || value === "" ? 22 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new MachinePlanError("SSH port must be a whole number from 1 to 65535.", "port");
  return port;
}

export function validateMachineName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new MachinePlanError("Give the machine a short name (up to 80 characters).", "name");
  return name;
}

export function validateId(value: unknown, field: string): string {
  const id = String(value ?? "");
  if (!ID_RE.test(id)) throw new MachinePlanError(`${field} is not a valid identifier.`, field);
  return id;
}

export function validateRisk(value: unknown): RiskClass {
  const risk = String(value ?? "staging") as RiskClass;
  if (!RISKS.includes(risk)) throw new MachinePlanError("Risk must be development, staging or production.", "risk");
  return risk;
}

/** SHA-256 of a base64 key blob, formatted the way `ssh-keygen -l` prints it. */
function keyFingerprint(blob: string): string {
  return `SHA256:${createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "")}`;
}

/**
 * Parse one known_hosts line for this endpoint. The line's host field must name
 * exactly the machine being registered — a key pinned for another address is
 * not evidence about this one.
 */
export function parseKnownHost(line: unknown, host: string, port: number): { knownHost: string; fingerprint: string; keyType: string } {
  const text = String(line ?? "").trim();
  if (!text || text.includes("\n") || text.length > 16_384) throw new MachinePlanError("Provide one known_hosts line.", "knownHost");
  const fields = text.split(/\s+/);
  if (fields.length < 3 || fields[0].startsWith("@") || fields[0].startsWith("|")) throw new MachinePlanError("Use a plain (unhashed) known_hosts line.", "knownHost");
  if (!/^(?:ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|rsa-sha2-(?:256|512)|ssh-rsa)$/.test(fields[1])) throw new MachinePlanError("Unsupported host key type.", "knownHost");
  const blob = fields[2];
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(blob) || Buffer.from(blob, "base64").byteLength < 32) throw new MachinePlanError("Host key is not valid base64.", "knownHost");
  const expected = port === 22 ? host : `[${host}]:${port}`;
  if (!fields[0].split(",").map((entry) => entry.toLowerCase()).includes(expected)) {
    throw new MachinePlanError(`The known_hosts line is for ${fields[0]}, not ${expected}.`, "knownHost");
  }
  return { knownHost: `${expected} ${fields[1]} ${blob}`, fingerprint: keyFingerprint(blob), keyType: fields[1] };
}

export function validateFingerprint(value: unknown): string {
  const fingerprint = String(value ?? "").trim();
  if (!FINGERPRINT_RE.test(fingerprint)) throw new MachinePlanError("Fingerprints look like SHA256: followed by 43 characters.", "fingerprint");
  return fingerprint;
}

/** Validate a generated Ed25519 public key and return it without its comment. */
export function parsePublicKey(value: unknown): { line: string; fingerprint: string } {
  const text = String(value ?? "").trim();
  const match = ED25519_RE.exec(text);
  if (!match) throw new MachinePlanError("Expected one Ed25519 public key.", "publicKey");
  return { line: `ssh-ed25519 ${match[1]}`, fingerprint: keyFingerprint(match[1]) };
}

function slug(value: string, max: number): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
}

/**
 * A short, stable Unix account name for one project environment on one machine.
 *
 * Display names are not trusted as usernames: the readable part is a slug, and
 * the suffix hashes the stable ids, so two projects both called "api" on one
 * machine get different accounts, while re-planning the same access always
 * lands on the same one. Linux caps names at 32 characters.
 */
export function commandAccountName(machineId: string, projectId: string, projectName: string, environmentId: string): string {
  return roleAccountName("x", machineId, projectId, projectName, environmentId);
}

/** `psm-<role letter>-<slug>-<hash>`: x = command, i = infrastructure, r = release, a = administrator. */
export function roleAccountName(letter: "x" | "i" | "r" | "a", machineId: string, projectId: string, projectName: string, environmentId: string): string {
  const suffix = createHash("sha256").update(`${machineId}\0${projectId}\0${environmentId}`).digest("hex").slice(0, 6);
  const readable = slug(`${projectName}-${environmentId}`, 32 - `psm-${letter}--`.length - suffix.length) || "app";
  const name = `psm-${letter}-${readable}-${suffix}`;
  if (!ACCOUNT_RE.test(name)) throw new MachinePlanError("Could not derive a valid account name.", "account");
  return name;
}

/** POSIX single-quote a value that has already passed a strict pattern. */
export function quote(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new MachinePlanError("Control characters cannot appear in a setup script.");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function digest(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/**
 * The generated setup script. Kept as one template so its behaviour can be read
 * top to bottom; only the parameter block differs between plans.
 */
function commandAccountScript(parameters: Record<string, string>): string {
  const block = Object.entries(parameters).map(([name, value]) => `readonly ${name}=${quote(value)}`).join("\n");
  return `#!/usr/bin/env bash
# Generated by PSM. Prepares one command account; changes nothing else.
# Modes: --inspect (read-only report) and --apply (requires root).
set -euo pipefail
umask 077
export LC_ALL=C PATH=/usr/sbin:/usr/bin:/sbin:/bin

${block}

mode=\${1:---inspect}
[[ $# -le 1 && ( "$mode" == --inspect || "$mode" == --apply ) ]] || { echo 'usage: setup.sh [--inspect|--apply]' >&2; exit 64; }

conflicts=()
conflict() { conflicts+=("$1"); }
report() { printf 'psm.%s=%s\\n' "$1" "$(printf '%s' "$2" | tr -d '\\000-\\037\\177' | cut -c1-200)"; }

# Parents of anything the account can write must be root-owned and not
# group/other-writable, or the account could swap its own key policy.
root_directory() {
  local directory=$1 permissions
  if [[ -L "$directory" ]]; then conflict "symlink:$directory"; return; fi
  [[ -e "$directory" ]] || return 0
  if [[ ! -d "$directory" || $(stat -c %u "$directory") != 0 ]]; then conflict "not-root-owned:$directory"; return; fi
  permissions=$(stat -c %a "$directory")
  (( (8#$permissions & 0022) == 0 )) || conflict "writable-by-others:$directory"
}

inspect() {
  conflicts=()
  local directory row _ uid gid comment home shell os_id='' os_version=''
  if [[ -r /etc/os-release ]]; then
    os_id=$(. /etc/os-release && printf '%s' "\${ID:-}")
    os_version=$(. /etc/os-release && printf '%s' "\${VERSION_ID:-}")
  fi
  report hostname "$(hostname 2>/dev/null || true)"
  report os_id "$os_id"
  report os_version "$os_version"
  report arch "$(uname -m)"
  report kernel "$(uname -s)"
  report uid "$(id -u)"
  if [[ -d /run/systemd/system ]]; then report systemd yes; else report systemd no; fi
  if [[ $(id -u) == 0 ]]; then report sudo root
  elif sudo -n true 2>/dev/null; then report sudo noninteractive
  elif command -v sudo >/dev/null 2>&1; then report sudo password
  else report sudo absent; fi
  for tool in useradd getent install stat flock; do
    command -v "$tool" >/dev/null 2>&1 || conflict "missing-tool:$tool"
  done
  [[ $(uname -s) == Linux ]] || conflict "unsupported-kernel:$(uname -s)"

  for directory in /home /srv /srv/psm /srv/psm/commands "$PSM_HOME" "$PSM_HOME/.ssh"; do
    root_directory "$directory"
  done
  [[ ! -L "$PSM_WORKDIR" ]] || conflict "symlink:$PSM_WORKDIR"
  [[ ! -L "$PSM_HOME/.ssh/authorized_keys" ]] || conflict "symlink:$PSM_HOME/.ssh/authorized_keys"

  if row=$(getent passwd "$PSM_ACCOUNT"); then
    IFS=: read -r _ _ uid gid comment home shell <<< "$row"
    report account_uid "$uid"
    if [[ "$uid" == 0 || "$home" != "$PSM_HOME" || "$shell" != /bin/bash || "$comment" != "$PSM_COMMENT" ]]; then
      report account conflict; conflict "account-differs:$PSM_ACCOUNT"
    elif [[ $(id -gn "$PSM_ACCOUNT") != "$PSM_ACCOUNT" || $(id -G "$PSM_ACCOUNT") != "$gid" ]]; then
      report account conflict; conflict "account-groups:$PSM_ACCOUNT"
    else
      report account present
    fi
    if [[ -e "$PSM_WORKDIR" ]] && [[ ! -d "$PSM_WORKDIR" || $(stat -c %u "$PSM_WORKDIR") != "$uid" ]]; then
      conflict "workdir-owner:$PSM_WORKDIR"
    fi
  else
    report account absent
    getent group "$PSM_ACCOUNT" >/dev/null && conflict "group-exists:$PSM_ACCOUNT"
    [[ -e "$PSM_HOME" ]] && conflict "home-exists:$PSM_HOME"
    [[ -e "$PSM_WORKDIR" ]] && conflict "workdir-exists:$PSM_WORKDIR"
  fi
  if [[ -e "$PSM_WORKDIR" ]]; then report workdir present; else report workdir absent; fi

  if [[ -e "$PSM_HOME/.ssh/authorized_keys" ]]; then
    if [[ ! -f "$PSM_HOME/.ssh/authorized_keys" || $(stat -c %u "$PSM_HOME/.ssh/authorized_keys") != 0 ]]; then
      report key conflict; conflict "authorized-keys-owner"
    elif [[ $(cat "$PSM_HOME/.ssh/authorized_keys") == "$PSM_AUTHORIZED" ]]; then
      report key match
    else
      report key differs; conflict "key-differs:rotate-explicitly"
    fi
  else
    report key absent
  fi

  # Existing deployment roles are reported for explicit adoption, never changed.
  local existing=()
  for name in psm-infra psm-release; do getent passwd "$name" >/dev/null && existing+=("$name"); done
  report existing_accounts "$(IFS=,; printf '%s' "\${existing[*]:-}")"
  if getent group psm-deploy >/dev/null; then report deploy_group present; else report deploy_group absent; fi
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet psm-host-helper.service 2>/dev/null; then report helper active
  elif [[ -e /etc/systemd/system/psm-host-helper.service ]]; then report helper installed
  else report helper absent; fi
  for item in "\${conflicts[@]}"; do report conflict "$item"; done
}

report schema ${INSPECTION_SCHEMA}
report plan "$PSM_PLAN"
if [[ "$mode" == --apply ]]; then
  [[ $(id -u) == 0 ]] || { report result needs-root; echo 'setup: apply requires root (run through sudo)' >&2; exit 77; }
  install -d -m 0755 /run/lock
  exec 9>"/run/lock/$PSM_ACCOUNT.psm-setup.lock"
  flock -n 9 || { report result locked; echo 'setup: another setup is running' >&2; exit 75; }
fi

inspect
if [[ "$mode" == --inspect ]]; then report result inspected; exit 0; fi
if (( \${#conflicts[@]} )); then report result conflict; echo 'setup: stopped before changing anything' >&2; exit 65; fi

if ! getent passwd "$PSM_ACCOUNT" >/dev/null; then
  useradd --user-group --no-create-home --home-dir "$PSM_HOME" --shell /bin/bash --password '!' --comment "$PSM_COMMENT" "$PSM_ACCOUNT"
fi
install -d -o root -g root -m 0755 /srv/psm /srv/psm/commands
install -d -o root -g "$PSM_ACCOUNT" -m 0750 "$PSM_HOME" "$PSM_HOME/.ssh"
install -d -o "$PSM_ACCOUNT" -g "$PSM_ACCOUNT" -m 0700 "$PSM_WORKDIR"
# Never replace an existing key; a partial run resumes from here.
if [[ ! -e "$PSM_HOME/.ssh/authorized_keys" ]]; then
  temporary=$(mktemp "$PSM_HOME/.ssh/.authorized_keys.XXXXXX")
  trap 'rm -f -- "\${temporary:-}"' EXIT
  printf '%s\\n' "$PSM_AUTHORIZED" > "$temporary"
  chown root:"$PSM_ACCOUNT" "$temporary"
  chmod 0640 "$temporary"
  mv -- "$temporary" "$PSM_HOME/.ssh/authorized_keys"
  trap - EXIT
fi
inspect
if (( \${#conflicts[@]} )); then report result conflict; exit 65; fi
report result applied
`;
}

export function buildCommandAccessPlan(request: CommandAccessRequest): CommandAccessPlan {
  const { machine } = request;
  if (machine.hostKeySource === "scanned-unverified") {
    throw new MachinePlanError("Confirm the machine's host key fingerprint before planning setup.", "hostKey");
  }
  const projectId = validateId(request.projectId, "projectId");
  const environmentId = validateId(request.environmentId, "environmentId");
  const risk = validateRisk(request.risk);
  const key = parsePublicKey(request.publicKey);
  const account = commandAccountName(machine.id, projectId, request.projectName, environmentId);
  const home = `/home/${account}`;
  const workdir = `/srv/psm/commands/${account}`;
  const comment = `PSM command account ${projectId}/${environmentId}`.slice(0, 120);
  const createdAt = request.now ?? Date.now();
  const planId = `${machine.id}:${projectId}:${environmentId}:command`;
  const script = commandAccountScript({
    PSM_PLAN: planId,
    PSM_ACCOUNT: account,
    PSM_HOME: home,
    PSM_WORKDIR: workdir,
    PSM_COMMENT: comment,
    PSM_AUTHORIZED: `restrict ${key.line} ${account}`,
  });
  const operations = [
    `Create or reuse the Unix account ${account} with its own group, no password and no sudo.`,
    `Create a root-owned home ${home} so the account cannot change its own SSH key policy.`,
    `Create the working directory ${workdir}, writable only by ${account}.`,
    `Authorize one PSM-generated Ed25519 key (${key.fingerprint}) with forwarding and terminals disabled.`,
  ];
  const authority = [
    `Run ordinary commands as ${account} in ${workdir}.`,
    "Read world-readable files and use network services available to the host, like any unprivileged user.",
    "No sudo, no deployment-helper group, no access to other PSM accounts. This is not a container or tenant isolation boundary.",
  ];
  const body = {
    schema: MACHINE_PLAN_SCHEMA as typeof MACHINE_PLAN_SCHEMA,
    role: "command" as const,
    machineId: machine.id,
    host: machine.host,
    port: machine.port,
    hostKeyFingerprint: machine.hostKeyFingerprint,
    projectId,
    environmentId,
    risk,
    account,
    home,
    workdir,
    comment,
    publicKeyFingerprint: key.fingerprint,
    operations,
    authority,
    script,
    scriptDigest: digest(script),
    createdAt,
  };
  return { ...body, digest: digest(JSON.stringify(body)) };
}

/**
 * A read-only probe of a machine before any project is chosen. It runs the same
 * script with a sentinel account that setup never creates, so the machine-wide
 * facts (OS, sudo, helper, existing PSM roles) come from the code that setup
 * itself relies on. Its apply mode refuses to run.
 */
export function machineInspectionScript(machineId: string): string {
  validateId(machineId, "machineId");
  const script = commandAccountScript({
    PSM_PLAN: `${machineId}:inspection`,
    PSM_ACCOUNT: "psm-x-inspection-000000",
    PSM_HOME: "/home/psm-x-inspection-000000",
    PSM_WORKDIR: "/srv/psm/commands/psm-x-inspection-000000",
    PSM_COMMENT: "PSM inspection only",
    PSM_AUTHORIZED: "inspection-only",
  });
  return script.replace('mode=${1:---inspect}', 'mode=${1:---inspect}\n[[ "$mode" == --inspect ]] || { echo "setup: inspection script cannot apply" >&2; exit 64; }');
}

export interface InspectionReport {
  schema: string;
  plan: string;
  hostname: string;
  osId: string;
  osVersion: string;
  arch: string;
  kernel: string;
  uid: number | null;
  systemd: boolean;
  sudo: "root" | "noninteractive" | "password" | "absent" | "unknown";
  account: "absent" | "present" | "conflict" | "unknown";
  accountUid: number | null;
  key: "absent" | "match" | "differs" | "conflict" | "unknown";
  workdir: "absent" | "present" | "unknown";
  existingAccounts: string[];
  deployGroup: boolean;
  helper: "active" | "installed" | "absent" | "unknown";
  conflicts: string[];
  result: string;
  /** Every reported key, for role-specific fields. */
  values: Record<string, string>;
}

/**
 * Read a script report. Unknown keys are ignored and missing ones are
 * "unknown", so output from a newer or truncated script cannot pass as success.
 */
export function parseInspection(output: string): InspectionReport {
  const values = new Map<string, string>();
  const conflicts: string[] = [];
  for (const line of output.split("\n")) {
    const match = /^psm\.([a-z_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    if (match[1] === "conflict") conflicts.push(match[2]);
    else values.set(match[1], match[2]);
  }
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const value = values.get(key) as T | undefined;
    return value && allowed.includes(value) ? value : fallback;
  };
  const integer = (key: string) => {
    const value = values.get(key);
    return value && /^\d+$/.test(value) ? Number(value) : null;
  };
  if (values.get("schema") !== INSPECTION_SCHEMA) throw new MachinePlanError("The server did not return a PSM inspection report.");
  return {
    schema: INSPECTION_SCHEMA,
    plan: values.get("plan") ?? "",
    hostname: values.get("hostname") ?? "",
    osId: values.get("os_id") ?? "",
    osVersion: values.get("os_version") ?? "",
    arch: values.get("arch") ?? "",
    kernel: values.get("kernel") ?? "",
    uid: integer("uid"),
    systemd: values.get("systemd") === "yes",
    sudo: pick("sudo", ["root", "noninteractive", "password", "absent"] as const, "unknown"),
    account: pick("account", ["absent", "present", "conflict"] as const, "unknown"),
    accountUid: integer("account_uid"),
    key: pick("key", ["absent", "match", "differs", "conflict"] as const, "unknown"),
    workdir: pick("workdir", ["absent", "present"] as const, "unknown"),
    existingAccounts: (values.get("existing_accounts") ?? "").split(",").filter((name) => /^[a-z][a-z0-9-]*$/.test(name)),
    deployGroup: values.get("deploy_group") === "present",
    helper: pick("helper", ["active", "installed", "absent"] as const, "unknown"),
    conflicts,
    result: values.get("result") ?? "",
    values: Object.fromEntries(values),
  };
}

/** Supported hosts for this bootstrap: systemd Linux with the usual shadow tools. */
export function compatibility(report: InspectionReport): { supported: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (report.kernel !== "Linux") reasons.push(`${report.kernel || "This system"} is not Linux.`);
  if (!["x86_64", "aarch64"].includes(report.arch)) reasons.push(`Architecture ${report.arch || "unknown"} is not supported yet.`);
  for (const conflict of report.conflicts.filter((entry) => entry.startsWith("missing-tool:"))) {
    reasons.push(`The server has no ${conflict.slice("missing-tool:".length)} command.`);
  }
  return { supported: reasons.length === 0, reasons };
}

/**
 * One copyable command that writes the script, checks its digest and runs it
 * through sudo. No placeholder paths and no credentials: the script carries
 * only the public key, and sudo prompts in that terminal if it needs to.
 */
export function copyableSetupCommand(plan: { script: string; scriptDigest: string; account: string }): string {
  const encoded = Buffer.from(plan.script, "utf8").toString("base64");
  const hex = plan.scriptDigest.slice("sha256:".length);
  const file = `/tmp/psm-setup-${plan.account}-${hex.slice(0, 12)}.sh`;
  return `printf '%s' '${encoded}' | base64 -d > ${file} && echo '${hex}  ${file}' | sha256sum -c --quiet && sudo bash ${file} --apply; rm -f ${file}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

export const _internals = { commandAccountScript, keyFingerprint };
