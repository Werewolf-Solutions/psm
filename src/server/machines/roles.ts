/**
 * Deployment roles on a machine: the host helper (once per machine) and the
 * infrastructure and release identities a project environment deploys with.
 *
 * Same discipline as command access (plan.ts): every value is validated and
 * written into one quoted parameter block; scripts inspect before they apply
 * and stop on anything they did not create; the report is `psm.key=value`.
 *
 * The helper binary is built from this repository's `host-helper/` for the
 * target architecture and uploaded as an unprivileged file first. The script
 * copies it somewhere only root can write and installs it only if its SHA-256
 * matches the digest in the reviewed plan, so the upload location is never
 * trusted.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  digest,
  MACHINE_PLAN_SCHEMA,
  MachinePlanError,
  parsePublicKey,
  quote,
  roleAccountName,
  validateId,
  validateRisk,
  type MachineIdentity,
  type RiskClass,
} from "./plan.ts";

const HELPER_ROOT = fileURLToPath(new URL("../../../host-helper/", import.meta.url));
export const HELPER_BINARY = "/usr/local/libexec/psm-host-helper";
export const HELPER_CLIENT = "/usr/local/libexec/psm-host-helper-client";
export const HELPER_UNIT = "/etc/systemd/system/psm-host-helper.service";
export const HELPER_SOCKET = "/run/psm-deploy/helper.sock";
export const REPLACED_DIR = "/var/lib/psm-deploy/replaced";
export const TARGET_SCHEMA = "psm.werewolf.solutions/host-target/v1";
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const UPLOAD_RE = "^/tmp/psm-host-helper\\.[A-Za-z0-9]{6,32}$";

export interface HelperBuild {
  arch: "x86_64" | "aarch64";
  sha256: string;
  bytes: number;
  sourceDigest: string;
  file: string;
}

/** Digest of the helper's Go sources: the build is cached and named by it. */
export function helperSourceDigest(): string {
  const hash = createHash("sha256");
  for (const name of fs.readdirSync(HELPER_ROOT).filter((entry) => /\.go$|^go\.(mod|sum)$/.test(entry) && !entry.endsWith("_test.go")).sort()) {
    hash.update(name).update("\0").update(fs.readFileSync(path.join(HELPER_ROOT, name))).update("\0");
  }
  return hash.digest("hex");
}

/**
 * Build the helper for a Linux architecture, reproducibly (static, trimmed
 * paths, no VCS stamp), caching by source digest. The cache is private to
 * this user; the digest of the file is what the plan pins.
 */
export function buildHostHelper(arch: string, cacheDir = path.join(os.homedir(), ".cache", "psm", "host-helper")): HelperBuild {
  const goarch = arch === "x86_64" ? "amd64" : arch === "aarch64" ? "arm64" : null;
  if (!goarch) throw new MachinePlanError(`No host helper build for ${arch}.`, "arch");
  const sourceDigest = helperSourceDigest();
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const file = path.join(cacheDir, `psm-host-helper-${sourceDigest.slice(0, 16)}-linux-${goarch}`);
  if (!fs.existsSync(file)) {
    const temporary = `${file}.${process.pid}.tmp`;
    execFileSync("go", ["build", "-trimpath", "-buildvcs=false", "-ldflags=-s -w -buildid=", "-o", temporary, "."], {
      cwd: HELPER_ROOT,
      env: { ...process.env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: goarch, GOFLAGS: "-mod=readonly" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    fs.renameSync(temporary, file);
  }
  const bytes = fs.readFileSync(file);
  return { arch: arch as HelperBuild["arch"], sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength, sourceDigest, file };
}

interface BasePlan {
  schema: typeof MACHINE_PLAN_SCHEMA;
  machineId: string;
  host: string;
  port: number;
  hostKeyFingerprint: string;
  projectId: string;
  environmentId: string;
  risk: RiskClass;
  /** Primary account, working path and key, shown in the same places as command access. */
  account: string;
  home: string;
  workdir: string;
  comment: string;
  publicKeyFingerprint: string;
  operations: string[];
  authority: string[];
  script: string;
  scriptDigest: string;
  digest: string;
  createdAt: number;
}

/** Installed files a plan may overwrite, each named by its exact current SHA-256. */
export interface HelperReplacements { binary?: string; client?: string; unit?: string }

export interface HelperInstallPlan extends BasePlan {
  role: "helper";
  helper: { sha256: string; bytes: number; arch: string; sourceDigest: string };
  replaces?: HelperReplacements;
}

export interface DeployAccessPlan extends BasePlan {
  role: "deploy";
  /** Public halves of the two keys, so the plan can be rebuilt unchanged except for what is reviewed again. */
  publicKey: string;
  release: { account: string; publicKeyFingerprint: string; publicKey: string };
  target: {
    targetId: string;
    unitId: string;
    hostname: string;
    canonicalRoot: string;
    allowedRootPrefix: string;
    certbotEmail: string;
    revision: string;
    file: string;
    replaces?: string;
  };
}

function finish<T extends Omit<BasePlan, "scriptDigest" | "digest">>(body: T): T & { scriptDigest: string; digest: string } {
  const withScript = { ...body, scriptDigest: digest(body.script) };
  return { ...withScript, digest: digest(JSON.stringify(withScript)) };
}

function parameters(values: Record<string, string>): string {
  return Object.entries(values).map(([name, value]) => `readonly ${name}=${quote(value)}`).join("\n");
}

const PRELUDE = `set -euo pipefail
umask 022
export LC_ALL=C PATH=/usr/sbin:/usr/bin:/sbin:/bin
conflicts=()
conflict() { conflicts+=("$1"); }
report() { printf 'psm.%s=%s\\n' "$1" "$(printf '%s' "$2" | tr -d '\\000-\\037\\177' | cut -c1-200)"; }
file_sha() { sha256sum -- "$1" | cut -d' ' -f1; }
root_directory() {
  local directory=$1 permissions
  if [[ -L "$directory" ]]; then conflict "symlink:$directory"; return; fi
  [[ -e "$directory" ]] || return 0
  if [[ ! -d "$directory" || $(stat -c %u "$directory") != 0 ]]; then conflict "not-root-owned:$directory"; return; fi
  permissions=$(stat -c %a "$directory")
  (( (8#$permissions & 0022) == 0 )) || conflict "writable-by-others:$directory"
}
facts() {
  report kernel "$(uname -s)"
  report arch "$(uname -m)"
  report uid "$(id -u)"
  if [[ -d /run/systemd/system ]]; then report systemd yes; else report systemd no; fi
}`;

function helperInstallScript(values: Record<string, string>): string {
  return `#!/usr/bin/env bash
# Generated by PSM. Installs the PSM host helper service; changes nothing else.
# Modes: --inspect, and --apply [UPLOADED_BINARY] as root.
${PRELUDE}

${parameters(values)}

mode=\${1:---inspect}
upload=\${2:-}
[[ "$mode" == --inspect || "$mode" == --apply ]] || { echo 'usage: helper.sh --inspect | --apply [binary]' >&2; exit 64; }

declare -A states=()
inspect() {
  conflicts=()
  facts
  [[ -d /run/systemd/system ]] || conflict "no-systemd"
  local state observed
  states=()
  # A file that differs is replaced only when the reviewed plan names its exact
  # current digest; anything else stops, reporting the digest for review.
  for pair in "binary:${HELPER_BINARY}:$PSM_HELPER_SHA256:$PSM_REPLACE_BINARY" "client:${HELPER_CLIENT}:$PSM_CLIENT_SHA256:$PSM_REPLACE_CLIENT" "unit:${HELPER_UNIT}:$PSM_UNIT_SHA256:$PSM_REPLACE_UNIT"; do
    IFS=: read -r name file expected replaceable <<< "$pair"
    if [[ -L "$file" ]]; then state=conflict; conflict "symlink:$file"
    elif [[ ! -e "$file" ]]; then state=absent
    else
      observed=$(file_sha "$file")
      if [[ "$observed" == "$expected" ]]; then state=match
      else
        report "\${name}_sha" "$observed"
        if [[ -n "$replaceable" && "$observed" == "$replaceable" ]]; then state=replace
        else state=differs; conflict "helper-differs:$file"; fi
      fi
    fi
    states[$name]=$state
    report "$name" "$state"
  done
  if systemctl is-active --quiet psm-host-helper.service 2>/dev/null; then report service active
  elif systemctl cat psm-host-helper.service >/dev/null 2>&1; then report service inactive
  else report service absent; fi
  if [[ -S ${HELPER_SOCKET} ]]; then report socket present; else report socket absent; fi
  if getent group psm-deploy >/dev/null; then report deploy_group present; else report deploy_group absent; fi
  local missing=()
  command -v nginx >/dev/null 2>&1 || missing+=(nginx)
  command -v certbot >/dev/null 2>&1 || missing+=(certbot)
  report missing_packages "$(IFS=,; printf '%s' "\${missing[*]:-}")"
  if (( \${#missing[@]} )) && ! command -v apt-get >/dev/null 2>&1; then conflict "no-apt:\${missing[*]}"; fi
  for directory in /usr/local/libexec /etc/psm-deploy /etc/psm-deploy/targets /var/lib/psm-deploy; do root_directory "$directory"; done
  for item in "\${conflicts[@]}"; do report conflict "$item"; done
}

report schema 1
report plan "$PSM_PLAN"
if [[ "$mode" == --apply ]]; then
  [[ $(id -u) == 0 ]] || { report result needs-root; echo 'setup: apply requires root (run through sudo)' >&2; exit 77; }
  install -d -m 0755 /run/lock
  exec 9>/run/lock/psm-host-helper.psm-setup.lock
  flock -n 9 || { report result locked; exit 75; }
fi
inspect
if [[ "$mode" == --inspect ]]; then report result inspected; exit 0; fi
if (( \${#conflicts[@]} )); then report result conflict; echo 'setup: stopped before changing anything' >&2; exit 65; fi

staged=$(mktemp -d /root/.psm-helper.XXXXXX)
trap 'rm -rf -- "$staged"; [[ -n "$upload" ]] && rm -f -- "$upload"' EXIT
if [[ \${states[binary]} == absent || \${states[binary]} == replace ]]; then
  [[ "$upload" =~ ${UPLOAD_RE} && -f "$upload" && ! -L "$upload" ]] || { report result missing-binary; echo 'setup: the helper binary was not uploaded' >&2; exit 66; }
  cp -- "$upload" "$staged/helper"
  [[ $(file_sha "$staged/helper") == "$PSM_HELPER_SHA256" ]] || { report result digest-mismatch; echo 'setup: uploaded binary does not match the reviewed digest' >&2; exit 65; }
fi
printf '%s' "$PSM_CLIENT_B64" | base64 -d > "$staged/client"
printf '%s' "$PSM_UNIT_B64" | base64 -d > "$staged/unit"
[[ $(file_sha "$staged/client") == "$PSM_CLIENT_SHA256" && $(file_sha "$staged/unit") == "$PSM_UNIT_SHA256" ]] || { report result digest-mismatch; exit 65; }

if [[ -n "$(inspect | sed -n 's/^psm.missing_packages=//p')" ]]; then
  DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends nginx certbot >/dev/null
fi
install -d -o root -g root -m 0755 /var/www /etc/letsencrypt /var/lib/letsencrypt /var/log/letsencrypt /var/www/certbot
groupadd --system --force psm-deploy
install -d -o root -g root -m 0755 /usr/local/libexec
install -d -o root -g root -m 0755 /etc/psm-deploy
install -d -o root -g psm-deploy -m 0750 /etc/psm-deploy/targets /var/lib/psm-deploy
replaced=0
place() {
  local name=$1 source=$2 file=$3 mode=$4
  case \${states[$name]} in
    absent) ;;
    replace)
      # The previous file is kept, root-only, named by its digest.
      install -d -o root -g root -m 0700 ${REPLACED_DIR}
      cp -p -- "$file" "${REPLACED_DIR}/$name.$(file_sha "$file")"
      replaced=1 ;;
    *) return 0 ;;
  esac
  # Written beside the target and renamed, so a running binary is never truncated.
  install -o root -g root -m "$mode" "$source" "$file.psm-new"
  mv -f -- "$file.psm-new" "$file"
}
place binary "$staged/helper" ${HELPER_BINARY} 0755
place client "$staged/client" ${HELPER_CLIENT} 0755
place unit "$staged/unit" ${HELPER_UNIT} 0644
systemctl daemon-reload
systemctl enable --now psm-host-helper.service >/dev/null 2>&1
if (( replaced )); then systemctl restart psm-host-helper.service; fi
for _ in $(seq 1 20); do [[ -S ${HELPER_SOCKET} ]] && break; sleep 0.5; done
inspect
if (( \${#conflicts[@]} )); then report result conflict; exit 65; fi
[[ -S ${HELPER_SOCKET} ]] || { report result service-failed; systemctl status psm-host-helper.service --no-pager -l 2>&1 | tail -5 >&2; exit 70; }
report result applied
`;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

function replacementDigest(value: unknown, field: string): string {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string" || !SHA256_RE.test(value)) throw new MachinePlanError(`${field} must be a SHA-256 digest.`, field);
  return value;
}

export function buildHelperInstallPlan(input: { machine: MachineIdentity; build: HelperBuild; replaces?: HelperReplacements; now?: number }): HelperInstallPlan {
  const replaces = {
    binary: replacementDigest(input.replaces?.binary, "replaces.binary"),
    client: replacementDigest(input.replaces?.client, "replaces.client"),
    unit: replacementDigest(input.replaces?.unit, "replaces.unit"),
  };
  const replacing = Object.entries(replaces).filter(([, value]) => value);
  const files: Record<string, string> = { binary: HELPER_BINARY, client: HELPER_CLIENT, unit: HELPER_UNIT };
  const unit = fs.readFileSync(path.join(HELPER_ROOT, "packaging", "psm-host-helper.service"));
  const client = fs.readFileSync(path.join(HELPER_ROOT, "packaging", "psm-host-helper-client.sh"));
  const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  const script = helperInstallScript({
    PSM_PLAN: `${input.machine.id}:helper`,
    PSM_HELPER_SHA256: input.build.sha256,
    PSM_CLIENT_SHA256: sha(client),
    PSM_UNIT_SHA256: sha(unit),
    PSM_CLIENT_B64: client.toString("base64"),
    PSM_UNIT_B64: unit.toString("base64"),
    PSM_REPLACE_BINARY: replaces.binary,
    PSM_REPLACE_CLIENT: replaces.client,
    PSM_REPLACE_UNIT: replaces.unit,
  });
  return finish({
    schema: MACHINE_PLAN_SCHEMA,
    role: "helper" as const,
    machineId: input.machine.id,
    host: input.machine.host,
    port: input.machine.port,
    hostKeyFingerprint: input.machine.hostKeyFingerprint,
    projectId: "_machine",
    environmentId: "helper",
    risk: "production" as RiskClass,
    account: "root",
    home: "/",
    workdir: "/etc/psm-deploy/targets",
    comment: "PSM host helper",
    publicKeyFingerprint: "",
    helper: { sha256: input.build.sha256, bytes: input.build.bytes, arch: input.build.arch, sourceDigest: input.build.sourceDigest },
    ...(replacing.length ? { replaces: Object.fromEntries(replacing) as HelperReplacements } : {}),
    operations: [
      ...replacing.map(([name, value]) => `Replace the installed ${files[name]} (sha256 ${value.slice(0, 16)}…) and restart psm-host-helper.service; the previous file is kept in ${REPLACED_DIR}.`),
      "Install nginx and certbot with apt, if either is missing.",
      `Install the PSM host helper (${input.build.arch}, sha256 ${input.build.sha256.slice(0, 16)}…) at ${HELPER_BINARY}, after checking its digest on the server.`,
      `Install its forced-command client ${HELPER_CLIENT} and systemd unit, and create the psm-deploy group.`,
      "Create root-owned /etc/psm-deploy/targets and /var/lib/psm-deploy, then enable and start psm-host-helper.service.",
    ],
    authority: [
      "The helper runs as root and accepts only the closed host-helper protocol on a local socket.",
      "It acts only for targets explicitly enrolled later, and only for the Unix accounts each target names.",
      "Installing it grants no project any access by itself.",
    ],
    script,
    createdAt: input.now ?? Date.now(),
  });
}

function deployAccessScript(values: Record<string, string>): string {
  return `#!/usr/bin/env bash
# Generated by PSM. Creates one project environment's infrastructure and release
# accounts and enrolls its host-helper target; changes nothing else.
${PRELUDE}

${parameters(values)}

mode=\${1:---inspect}
[[ $# -le 1 && ( "$mode" == --inspect || "$mode" == --apply ) ]] || { echo 'usage: deploy.sh [--inspect|--apply]' >&2; exit 64; }

target_state=
account_state() {
  local account=$1 authorized=$2 prefix=$3 row _ uid gid comment home shell
  local keys="/home/$account/.ssh/authorized_keys"
  root_directory "/home/$account"; root_directory "/home/$account/.ssh"
  if row=$(getent passwd "$account"); then
    IFS=: read -r _ _ uid gid comment home shell <<< "$row"
    report "\${prefix}_uid" "$uid"
    report "\${prefix}_gid" "$gid"
    if [[ "$uid" == 0 || "$home" != "/home/$account" || "$shell" != /bin/sh || "$comment" != "$PSM_COMMENT" ]]; then
      report "$prefix" conflict; conflict "account-differs:$account"
    elif [[ " $(id -Gn "$account") " != " $account psm-deploy " ]]; then
      report "$prefix" conflict; conflict "account-groups:$account"
    else
      report "$prefix" present
    fi
  else
    report "$prefix" absent
    getent group "$account" >/dev/null && conflict "group-exists:$account"
    [[ -e "/home/$account" ]] && conflict "home-exists:/home/$account"
  fi
  if [[ -L "$keys" ]]; then report "\${prefix}_key" conflict; conflict "symlink:$keys"
  elif [[ ! -e "$keys" ]]; then report "\${prefix}_key" absent
  elif [[ $(stat -c %u "$keys") != 0 ]]; then report "\${prefix}_key" conflict; conflict "authorized-keys-owner"
  elif [[ $(cat "$keys") == "$authorized" ]]; then report "\${prefix}_key" match
  else report "\${prefix}_key" differs; conflict "key-differs:rotate-explicitly"; fi
  return 0
}

inspect() {
  conflicts=()
  target_state=
  facts
  if [[ -x ${HELPER_BINARY} ]] && systemctl is-active --quiet psm-host-helper.service 2>/dev/null && getent group psm-deploy >/dev/null; then
    report helper active
  else
    report helper missing; conflict "helper-missing"
  fi
  account_state "$PSM_INFRA" "$PSM_INFRA_AUTHORIZED" infra
  account_state "$PSM_RELEASE" "$PSM_RELEASE_AUTHORIZED" release
  if [[ -L "$PSM_TARGET_FILE" ]]; then report target conflict; conflict "symlink:$PSM_TARGET_FILE"
  elif [[ ! -e "$PSM_TARGET_FILE" ]]; then report target absent
  else
    local infra_uid
    infra_uid=$(id -u "$PSM_INFRA" 2>/dev/null || true)
    if [[ -n "$infra_uid" ]] && grep -q "\\"deployUid\\": $infra_uid," "$PSM_TARGET_FILE" && grep -q "\\"revision\\": \\"$PSM_REVISION\\"," "$PSM_TARGET_FILE"; then
      report target match
    elif [[ -n "$infra_uid" ]] && grep -q "\\"deployUid\\": $infra_uid," "$PSM_TARGET_FILE"; then
      report target revision-differs
    else
      # Enrolled for other accounts: replaced only when the reviewed plan names
      # this exact contract's digest.
      local observed
      observed=$(file_sha "$PSM_TARGET_FILE")
      report target_sha "$observed"
      if [[ -n "$PSM_REPLACE_TARGET" && "$observed" == "$PSM_REPLACE_TARGET" ]]; then target_state=replace; report target replace
      else report target conflict; conflict "target-owned-by-other:$PSM_TARGET_ID"; fi
    fi
  fi
  for item in "\${conflicts[@]}"; do report conflict "$item"; done
}

create_account() {
  local account=$1 authorized=$2
  if ! getent passwd "$account" >/dev/null; then
    useradd --user-group --no-create-home --home-dir "/home/$account" --shell /bin/sh --password '!' --comment "$PSM_COMMENT" "$account"
  fi
  usermod -a -G psm-deploy "$account"
  install -d -o root -g "$account" -m 0750 "/home/$account" "/home/$account/.ssh"
  if [[ ! -e "/home/$account/.ssh/authorized_keys" ]]; then
    local temporary
    temporary=$(mktemp "/home/$account/.ssh/.authorized_keys.XXXXXX")
    printf '%s\\n' "$authorized" > "$temporary"
    chown root:"$account" "$temporary"; chmod 0640 "$temporary"
    mv -- "$temporary" "/home/$account/.ssh/authorized_keys"
  fi
}

report schema 1
report plan "$PSM_PLAN"
if [[ "$mode" == --apply ]]; then
  [[ $(id -u) == 0 ]] || { report result needs-root; echo 'setup: apply requires root (run through sudo)' >&2; exit 77; }
  install -d -m 0755 /run/lock
  exec 9>"/run/lock/$PSM_INFRA.psm-setup.lock"
  flock -n 9 || { report result locked; exit 75; }
fi
inspect
if [[ "$mode" == --inspect ]]; then report result inspected; exit 0; fi
if (( \${#conflicts[@]} )); then report result conflict; echo 'setup: stopped before changing anything' >&2; exit 65; fi

create_account "$PSM_INFRA" "$PSM_INFRA_AUTHORIZED"
create_account "$PSM_RELEASE" "$PSM_RELEASE_AUTHORIZED"
infra_uid=$(id -u "$PSM_INFRA"); infra_gid=$(id -g "$PSM_INFRA"); release_uid=$(id -u "$PSM_RELEASE")
[[ "$infra_uid" =~ ^[1-9][0-9]*$ && "$infra_gid" =~ ^[1-9][0-9]*$ && "$release_uid" =~ ^[1-9][0-9]*$ ]] || { report result bad-ids; exit 70; }
contract=$(mktemp)
trap 'rm -f -- "$contract"' EXIT
printf '%s' "$PSM_CONTRACT_B64" | base64 -d | sed -e "s/\\"__INFRA_UID__\\"/$infra_uid/g" -e "s/\\"__INFRA_GID__\\"/$infra_gid/g" -e "s/\\"__RELEASE_UID__\\"/$release_uid/g" > "$contract"
if [[ "$target_state" == replace ]]; then
  install -d -o root -g root -m 0700 ${REPLACED_DIR}
  cp -p -- "$PSM_TARGET_FILE" "${REPLACED_DIR}/target.$(file_sha "$PSM_TARGET_FILE").json"
fi
${HELPER_BINARY} enroll < "$contract" >/dev/null
inspect
if (( \${#conflicts[@]} )); then report result conflict; exit 65; fi
report result applied
`;
}

export interface DeployAccessRequest {
  machine: MachineIdentity;
  projectId: string;
  projectName: string;
  environmentId: string;
  risk: unknown;
  unitId: unknown;
  targetId?: unknown;
  hostname: unknown;
  certbotEmail: unknown;
  canonicalRoot?: unknown;
  allowedRootPrefix?: unknown;
  infraPublicKey: string;
  releasePublicKey: string;
  /** The exact SHA-256 of a contract enrolled for other accounts, which this plan may replace. */
  replacesTarget?: unknown;
  now?: number;
}

function canonicalPath(value: unknown, field: string): string {
  const text = String(value ?? "");
  if (!/^\/[A-Za-z0-9._/-]{1,200}$/.test(text) || path.posix.normalize(text) !== text || text === "/" || text.endsWith("/")) {
    throw new MachinePlanError(`${field} must be a canonical absolute path.`, field);
  }
  return text;
}

export function buildDeployAccessPlan(request: DeployAccessRequest): DeployAccessPlan {
  const { machine } = request;
  if (machine.hostKeySource === "scanned-unverified") throw new MachinePlanError("Confirm the machine's host key fingerprint before planning setup.", "hostKey");
  const projectId = validateId(request.projectId, "projectId");
  const environmentId = validateId(request.environmentId, "environmentId");
  const risk = validateRisk(request.risk);
  const unitId = validateId(request.unitId ?? "web", "unitId");
  const hostname = String(request.hostname ?? "").trim().toLowerCase();
  // A certificate needs a name; the helper refuses IP addresses too.
  if (!HOSTNAME_RE.test(hostname) || /^[0-9.]+$/.test(hostname)) throw new MachinePlanError("Enter the site's domain name, e.g. todo.example.com.", "hostname");
  // Never invented: Let's Encrypt sends expiry and account notices here.
  const certbotEmail = String(request.certbotEmail ?? "").trim();
  if (!EMAIL_RE.test(certbotEmail)) throw new MachinePlanError("Enter the email address that should receive certificate notices.", "certbotEmail");
  const allowedRootPrefix = canonicalPath(request.allowedRootPrefix ?? "/var/www", "allowedRootPrefix");
  const canonicalRoot = canonicalPath(request.canonicalRoot ?? `${allowedRootPrefix}/${hostname}`, "canonicalRoot");
  if (!canonicalRoot.startsWith(`${allowedRootPrefix}/`)) throw new MachinePlanError("The site root must be inside the allowed root.", "canonicalRoot");
  const targetId = validateId(request.targetId ?? `psm:${projectId}:${environmentId}:${unitId}`, "targetId");
  const infraKey = parsePublicKey(request.infraPublicKey);
  const releaseKey = parsePublicKey(request.releasePublicKey);
  const infra = roleAccountName("i", machine.id, projectId, request.projectName, environmentId);
  const release = roleAccountName("r", machine.id, projectId, request.projectName, environmentId);
  const comment = `PSM deployment ${projectId}/${environmentId}`.slice(0, 120);
  // Placeholder ids become numbers on the server, once the accounts exist.
  const template = {
    schema: TARGET_SCHEMA, revision: "", targetId, projectId, environmentId, unitId, canonicalRoot, allowedRootPrefix, hostname,
    deployUid: "__INFRA_UID__", deployGid: "__INFRA_GID__", infrastructureUids: ["__INFRA_UID__"], releaseUids: ["__RELEASE_UID__"],
    certbotEmail, pm2User: infra, pm2Home: `/home/${infra}/.pm2`, retainReleases: 5,
    nginxAvailableDir: "/etc/nginx/sites-available", nginxEnabledDir: "/etc/nginx/sites-enabled", acmeWebroot: "/var/www/certbot",
  };
  const revision = `psm-${digest(JSON.stringify(template)).slice(7, 19)}`;
  template.revision = revision;
  const file = `/etc/psm-deploy/targets/${createHash("sha256").update(targetId).digest("hex")}.json`;
  const replacesTarget = replacementDigest(request.replacesTarget, "replacesTarget");
  const forced = (key: { line: string }, account: string) => `command="${HELPER_CLIENT}",restrict ${key.line} ${account}`;
  const script = deployAccessScript({
    PSM_PLAN: `${machine.id}:${projectId}:${environmentId}:deploy`,
    PSM_INFRA: infra,
    PSM_RELEASE: release,
    PSM_COMMENT: comment,
    PSM_INFRA_AUTHORIZED: forced(infraKey, infra),
    PSM_RELEASE_AUTHORIZED: forced(releaseKey, release),
    PSM_TARGET_ID: targetId,
    PSM_TARGET_FILE: file,
    PSM_REVISION: revision,
    PSM_CONTRACT_B64: Buffer.from(JSON.stringify(template)).toString("base64"),
    PSM_REPLACE_TARGET: replacesTarget,
  });
  return finish({
    schema: MACHINE_PLAN_SCHEMA,
    role: "deploy" as const,
    machineId: machine.id,
    host: machine.host,
    port: machine.port,
    hostKeyFingerprint: machine.hostKeyFingerprint,
    projectId,
    environmentId,
    risk,
    account: infra,
    home: `/home/${infra}`,
    workdir: canonicalRoot,
    comment,
    publicKeyFingerprint: infraKey.fingerprint,
    publicKey: infraKey.line,
    release: { account: release, publicKeyFingerprint: releaseKey.fingerprint, publicKey: releaseKey.line },
    target: { targetId, unitId, hostname, canonicalRoot, allowedRootPrefix, certbotEmail, revision, file, ...(replacesTarget ? { replaces: replacesTarget } : {}) },
    operations: [
      ...(replacesTarget ? [`Replace the contract already enrolled for ${targetId} (sha256 ${replacesTarget.slice(0, 16)}…), which names other accounts; those accounts lose access to it. The previous contract is kept in ${REPLACED_DIR}.`] : []),
      `Create ${infra} (infrastructure) and ${release} (release), each with its own group, no password and no sudo, in psm-deploy.`,
      `Authorize one PSM-generated key per account, forced to the host-helper client (${infraKey.fingerprint}, ${releaseKey.fingerprint}).`,
      `Enroll helper target ${targetId} for ${hostname} at ${canonicalRoot}, revision ${revision}, certificate notices to ${certbotEmail}.`,
    ],
    authority: [
      `${infra} can ask the helper to observe and reconcile ${canonicalRoot}, its nginx site and certificate for ${hostname}.`,
      `${release} can stage, activate and roll back releases in ${canonicalRoot}.`,
      "Neither key opens a shell or runs other commands; both can act only on this target.",
    ],
    script,
    createdAt: request.now ?? Date.now(),
  });
}

export interface AdminAccessPlan extends BasePlan {
  role: "admin";
  sudoersFile: string;
}

function adminAccessScript(values: Record<string, string>): string {
  return `#!/usr/bin/env bash
# Generated by PSM. Gives PSM administrator access to this server through one
# dedicated account and key; changes nothing else. Remove it with PSM's
# "Remove administrator access" (or delete the sudoers file and the key).
${PRELUDE}

${parameters(values)}

mode=\${1:---inspect}
[[ $# -le 1 && ( "$mode" == --inspect || "$mode" == --apply ) ]] || { echo 'usage: admin.sh [--inspect|--apply]' >&2; exit 64; }

inspect() {
  conflicts=()
  facts
  local row _ uid gid comment home shell keys="/home/$PSM_ACCOUNT/.ssh/authorized_keys"
  root_directory "/home/$PSM_ACCOUNT"; root_directory "/home/$PSM_ACCOUNT/.ssh"
  if row=$(getent passwd "$PSM_ACCOUNT"); then
    IFS=: read -r _ _ uid gid comment home shell <<< "$row"
    if [[ "$uid" == 0 || "$home" != "/home/$PSM_ACCOUNT" || "$shell" != /bin/bash || "$comment" != "$PSM_COMMENT" ]]; then report account conflict; conflict "account-differs:$PSM_ACCOUNT"
    else report account present; fi
  else
    report account absent
    getent group "$PSM_ACCOUNT" >/dev/null && conflict "group-exists:$PSM_ACCOUNT"
    [[ -e "/home/$PSM_ACCOUNT" ]] && conflict "home-exists:/home/$PSM_ACCOUNT"
  fi
  if [[ -L "$keys" ]]; then report key conflict; conflict "symlink:$keys"
  elif [[ ! -e "$keys" ]]; then report key absent
  elif [[ $(stat -c %u "$keys") != 0 ]]; then report key conflict; conflict "authorized-keys-owner"
  elif [[ $(cat "$keys") == "$PSM_AUTHORIZED" ]]; then report key match
  else report key differs; conflict "key-differs:rotate-explicitly"; fi
  if [[ -L "$PSM_SUDOERS" ]]; then report sudoers conflict; conflict "symlink:$PSM_SUDOERS"
  elif [[ ! -e "$PSM_SUDOERS" ]]; then report sudoers absent
  elif [[ $(cat "$PSM_SUDOERS") == "$PSM_SUDOERS_LINE" ]]; then report sudoers match
  else report sudoers differs; conflict "sudoers-differs:$PSM_SUDOERS"; fi
  command -v visudo >/dev/null 2>&1 || conflict "missing-tool:visudo"
  for item in "\${conflicts[@]}"; do report conflict "$item"; done
}

report schema 1
report plan "$PSM_PLAN"
if [[ "$mode" == --apply ]]; then
  [[ $(id -u) == 0 ]] || { report result needs-root; echo 'setup: apply requires root (run through sudo)' >&2; exit 77; }
  install -d -m 0755 /run/lock
  exec 9>"/run/lock/$PSM_ACCOUNT.psm-setup.lock"
  flock -n 9 || { report result locked; exit 75; }
fi
inspect
if [[ "$mode" == --inspect ]]; then report result inspected; exit 0; fi
if (( \${#conflicts[@]} )); then report result conflict; echo 'setup: stopped before changing anything' >&2; exit 65; fi
getent passwd "$PSM_ACCOUNT" >/dev/null || useradd --user-group --no-create-home --home-dir "/home/$PSM_ACCOUNT" --shell /bin/bash --password '!' --comment "$PSM_COMMENT" "$PSM_ACCOUNT"
install -d -o root -g "$PSM_ACCOUNT" -m 0750 "/home/$PSM_ACCOUNT" "/home/$PSM_ACCOUNT/.ssh"
if [[ ! -e "/home/$PSM_ACCOUNT/.ssh/authorized_keys" ]]; then
  temporary=$(mktemp "/home/$PSM_ACCOUNT/.ssh/.authorized_keys.XXXXXX")
  printf '%s\\n' "$PSM_AUTHORIZED" > "$temporary"; chown root:"$PSM_ACCOUNT" "$temporary"; chmod 0640 "$temporary"
  mv -- "$temporary" "/home/$PSM_ACCOUNT/.ssh/authorized_keys"
fi
if [[ ! -e "$PSM_SUDOERS" ]]; then
  staged=$(mktemp /etc/sudoers.d/.psm.XXXXXX)
  printf '%s\\n' "$PSM_SUDOERS_LINE" > "$staged"; chmod 0440 "$staged"
  visudo -cf "$staged" >/dev/null || { rm -f -- "$staged"; report result invalid-sudoers; exit 70; }
  mv -- "$staged" "$PSM_SUDOERS"
fi
inspect
if (( \${#conflicts[@]} )); then report result conflict; exit 65; fi
report result applied
`;
}

export function buildAdminAccessPlan(input: { machine: MachineIdentity; publicKey: string; now?: number }): AdminAccessPlan {
  const { machine } = input;
  if (machine.hostKeySource === "scanned-unverified") throw new MachinePlanError("Confirm the machine's host key fingerprint before planning setup.", "hostKey");
  const key = parsePublicKey(input.publicKey);
  const account = roleAccountName("a", machine.id, "_machine", "psm", "admin");
  const sudoersFile = `/etc/sudoers.d/${account}`;
  const comment = "PSM administrator access";
  const script = adminAccessScript({
    PSM_PLAN: `${machine.id}:admin`,
    PSM_ACCOUNT: account,
    PSM_COMMENT: comment,
    PSM_AUTHORIZED: `no-agent-forwarding,no-port-forwarding,no-X11-forwarding ${key.line} ${account}`,
    PSM_SUDOERS: sudoersFile,
    PSM_SUDOERS_LINE: `${account} ALL=(ALL) NOPASSWD:ALL`,
  });
  return finish({
    schema: MACHINE_PLAN_SCHEMA,
    role: "admin" as const,
    machineId: machine.id, host: machine.host, port: machine.port, hostKeyFingerprint: machine.hostKeyFingerprint,
    projectId: "_machine", environmentId: "admin", risk: "production" as RiskClass,
    account, home: `/home/${account}`, workdir: "/", comment, publicKeyFingerprint: key.fingerprint, sudoersFile,
    operations: [
      `Create the account ${account} with its own group and no password.`,
      `Authorize one PSM-generated key (${key.fingerprint}) for it, with forwarding disabled.`,
      `Let ${account} run any command as root without a password (${sudoersFile}, checked with visudo first).`,
    ],
    authority: [
      "Full administration of this server: anything root can do, including reading every file and changing every service.",
      "PSM uses it to install the helper and create each project's own limited accounts, and you can remove it after setup.",
      "Removing it deletes the sudoers entry and the key; project accounts keep working.",
    ],
    script,
    createdAt: input.now ?? Date.now(),
  });
}

export interface ReleaseCiKeyPlan extends BasePlan {
  role: "ci";
  /** The deployment access whose release account this key is added to. */
  deployAccessId: string;
  target: { targetId: string };
}

function releaseCiKeyScript(values: Record<string, string>): string {
  return `#!/usr/bin/env bash
# Generated by PSM. Adds one more key to an existing release account, for a CI
# release controller; changes nothing else. Both keys stay forced to the helper.
${PRELUDE}

${parameters(values)}

mode=\${1:---inspect}
[[ $# -le 1 && ( "$mode" == --inspect || "$mode" == --apply ) ]] || { echo 'usage: ci-key.sh [--inspect|--apply]' >&2; exit 64; }
keys="/home/$PSM_RELEASE/.ssh/authorized_keys"
wanted=$(printf '%s\n%s' "$PSM_RELEASE_AUTHORIZED" "$PSM_CI_AUTHORIZED")

inspect() {
  conflicts=()
  facts
  if getent passwd "$PSM_RELEASE" >/dev/null && [[ " $(id -Gn "$PSM_RELEASE") " == " $PSM_RELEASE psm-deploy " ]]; then report release present
  else report release conflict; conflict "release-missing:$PSM_RELEASE"; fi
  root_directory "/home/$PSM_RELEASE"; root_directory "/home/$PSM_RELEASE/.ssh"
  # Only the two expected contents are recognised: the release key alone, or
  # the release key followed by this CI key. Anything else was changed by hand.
  if [[ -L "$keys" ]]; then report key conflict; conflict "symlink:$keys"
  elif [[ ! -e "$keys" ]]; then report key conflict; conflict "release-key-missing:$PSM_RELEASE"
  elif [[ $(stat -c %u "$keys") != 0 ]]; then report key conflict; conflict "authorized-keys-owner"
  elif [[ $(cat "$keys") == "$wanted" ]]; then report key match
  elif [[ $(cat "$keys") == "$PSM_RELEASE_AUTHORIZED" ]]; then report key absent
  else report key differs; conflict "key-differs:rotate-explicitly"; fi
  for item in "\${conflicts[@]}"; do report conflict "$item"; done
}

report schema 1
report plan "$PSM_PLAN"
if [[ "$mode" == --apply ]]; then
  [[ $(id -u) == 0 ]] || { report result needs-root; echo 'setup: apply requires root (run through sudo)' >&2; exit 77; }
  install -d -m 0755 /run/lock
  exec 9>"/run/lock/$PSM_RELEASE.psm-setup.lock"
  flock -n 9 || { report result locked; exit 75; }
fi
inspect
if [[ "$mode" == --inspect ]]; then report result inspected; exit 0; fi
if (( \${#conflicts[@]} )); then report result conflict; echo 'setup: stopped before changing anything' >&2; exit 65; fi
temporary=$(mktemp "/home/$PSM_RELEASE/.ssh/.authorized_keys.XXXXXX")
printf '%s\n' "$wanted" > "$temporary"
chown root:"$PSM_RELEASE" "$temporary"; chmod 0640 "$temporary"
mv -- "$temporary" "$keys"
inspect
if (( \${#conflicts[@]} )); then report result conflict; exit 65; fi
report result applied
`;
}

/** The release account's exact authorized line, as the reviewed deploy plan wrote it. */
export function releaseAuthorizedLine(plan: DeployAccessPlan): string {
  const line = /^readonly PSM_RELEASE_AUTHORIZED='([^']+)'$/m.exec(plan.script)?.[1];
  if (!line) throw new MachinePlanError("The deployment plan does not record its release key.", "plan");
  return line;
}

export function buildReleaseCiKeyPlan(input: { machine: MachineIdentity; deployAccessId: string; deploy: DeployAccessPlan; ciPublicKey: string; label: string; now?: number }): ReleaseCiKeyPlan {
  const { machine, deploy } = input;
  if (machine.hostKeySource === "scanned-unverified") throw new MachinePlanError("Confirm the machine's host key fingerprint before planning setup.", "hostKey");
  const key = parsePublicKey(input.ciPublicKey);
  const label = String(input.label).replace(/[^A-Za-z0-9._@-]+/g, "-").slice(0, 60);
  const account = deploy.release.account;
  const script = releaseCiKeyScript({
    PSM_PLAN: `${machine.id}:${deploy.projectId}:${deploy.environmentId}:ci`,
    PSM_RELEASE: account,
    PSM_RELEASE_AUTHORIZED: releaseAuthorizedLine(deploy),
    PSM_CI_AUTHORIZED: `command="${HELPER_CLIENT}",restrict ${key.line} ${label}`,
  });
  return finish({
    schema: MACHINE_PLAN_SCHEMA,
    role: "ci" as const,
    machineId: machine.id, host: machine.host, port: machine.port, hostKeyFingerprint: machine.hostKeyFingerprint,
    projectId: deploy.projectId, environmentId: deploy.environmentId, risk: deploy.risk,
    account, home: `/home/${account}`, workdir: deploy.workdir, comment: deploy.comment,
    publicKeyFingerprint: key.fingerprint,
    deployAccessId: input.deployAccessId,
    target: { targetId: deploy.target.targetId },
    operations: [
      `Authorize a second key (${key.fingerprint}) for the release account ${account}, forced to the host-helper client like the first.`,
    ],
    authority: [
      `Whoever holds this key can stage, activate and roll back releases of ${deploy.target.targetId} — the same as ${account}, nothing more.`,
      "It is meant for the release controller's CI environment, so it can be revoked on its own without touching PSM's key.",
    ],
    script,
    createdAt: input.now ?? Date.now(),
  });
}

export const _internals = { helperInstallScript, deployAccessScript, adminAccessScript, releaseCiKeyScript, UPLOAD_RE };
