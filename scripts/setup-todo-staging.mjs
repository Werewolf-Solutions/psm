#!/usr/bin/env node
/**
 * Local operator helper. No shell/SSH/GitHub calls, secrets, deployments or DNS writes.
 * Without --apply every command is read-only. Run beside the local PSM agent,
 * not on the droplet. Explicit root updates use the supported revision-checked API.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const CONNECTION = 'con_67802210-4432-4790-847b-4edaedd9cea5';
export const TARGET = 'werewolf:todo-staging-web';
export const PROJECT = 'prj_e4713173923933470bd3';
export const OLD_ROOT = '/var/www/a6s1j3p3zh.werewolf.solutions';
export const ROOT = '/var/www/todo.werewolf.solutions';
const REPO = 'Werewolf-Solutions/deployment-control';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.resolve(SCRIPT_DIR, '../docs/deploy/controller');

function requireValue(ok, message) {
  if (!ok) throw new Error(message);
}

export function agentUrl(value) {
  const url = new URL(value);
  requireValue(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
    'Use the local loopback PSM API over HTTP; remote agent URLs are refused.');
  requireValue(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/',
    'The agent URL must be an origin, without credentials, path, query or fragment.');
  return url.origin;
}

export function rootPlan(connection, target) {
  requireValue(connection?.connectionId === CONNECTION && connection.kind === 'ssh-host-helper@1',
    'The expected Todo staging host connection was not found.');
  requireValue(Number.isSafeInteger(connection.metadataRevision), 'Missing connection metadata revision.');
  const c = connection.constraints;
  requireValue(c && isDeepStrictEqual(c.allowedProjectIds, [PROJECT])
    && isDeepStrictEqual(c.allowedEnvironmentIds, ['staging'])
    && isDeepStrictEqual(c.allowedTargetIds, [TARGET])
    && c.maximumAuthorizedRisk === 'staging', 'Unexpected host authority; review manually.');
  requireValue(target?.targetId === TARGET && target.project?.id === PROJECT
    && target.environment === 'staging' && target.root === ROOT,
  'PSM does not describe the expected Todo staging target/root.');
  const current = c.allowedTargetRootPrefixes;
  requireValue(isDeepStrictEqual(current, [OLD_ROOT]) || isDeepStrictEqual(current, [ROOT]),
    'Unexpected allowed roots; refusing to overwrite a broader or changed connection.');
  return {
    changed: !isDeepStrictEqual(current, [ROOT]),
    connectionId: CONNECTION,
    expectedMetadataRevision: connection.metadataRevision,
    before: structuredClone(c),
    after: { ...structuredClone(c), allowedTargetRootPrefixes: [ROOT] },
  };
}

export function targetDocument(connection, target) {
  rootPlan(connection, target);
  const ssh = connection.constraints.ssh;
  const contract = connection.publicMetadata?.targetContracts?.[TARGET];
  requireValue(ssh && typeof ssh.host === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(ssh.host)
    && typeof ssh.user === 'string' && /^[a-z_][a-z0-9_-]*$/.test(ssh.user)
    && Number.isInteger(ssh.port) && ssh.port > 0 && ssh.port <= 65535
    && /^SHA256:[a-zA-Z0-9+/]{43}=?$/.test(ssh.hostKeyFingerprint || ''),
  'Incomplete/invalid enrolled SSH metadata; do not guess it.');
  requireValue(contract && /^[a-zA-Z0-9_.:-]+$/.test(contract.revision || '')
    && /^sha256:[a-f0-9]{64}$/.test(contract.fingerprint || ''),
  'Missing reviewed target contract revision/fingerprint.');
  requireValue(typeof connection.publicMetadata.knownHost === 'string'
    && connection.publicMetadata.knownHost.trim(), 'Missing enrolled known-host entry.');
  return {
    schema: 'psm.werewolf.solutions/control-target/v1',
    targetId: TARGET,
    contractRevision: contract.revision,
    githubEnvironment: 'todo-staging-web',
    sshHost: ssh.host,
    sshUser: ssh.user,
    sshPort: ssh.port,
    hostKeyFingerprint: ssh.hostKeyFingerprint,
    canonicalRoot: ROOT,
    helperProtocol: 'psm.werewolf.solutions/host-helper-request/v1',
  };
}

export function restorePlan(connection, target, backup) {
  const current = rootPlan(connection, target);
  requireValue(backup?.schema === 'psm.todo-staging-root-backup/v1'
    && backup.connectionId === CONNECTION
    && connection.metadataRevision === backup.expectedMetadataRevision + 1
    && isDeepStrictEqual(current.before, backup.after)
    && isDeepStrictEqual(backup.before, { ...backup.after, allowedTargetRootPrefixes: [OLD_ROOT] }),
  'Connection changed since the repair, or backup is invalid; refusing automatic rollback.');
  return { expectedMetadataRevision: connection.metadataRevision, constraints: backup.before };
}

async function request(base, route, body) {
  const response = await fetch(base + route, {
    method: body === undefined ? 'GET' : 'PATCH',
    headers: { Origin: base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  requireValue(response.ok, 'Local PSM API refused the request (HTTP ' + response.status + '). Use the local cockpit; do not disable its guard.');
  return data;
}

async function snapshot(base) {
  const [connections, targets] = await Promise.all([
    request(base, '/api/connections'), request(base, '/api/deployment-targets'),
  ]);
  const connection = connections.connections?.find(c => c.connectionId === CONNECTION);
  const target = targets.targets?.find(t => t.targetId === TARGET);
  rootPlan(connection, target);
  return { connection, target };
}

export async function scaffoldFiles(connection, target) {
  const document = targetDocument(connection, target);
  const workflow = await fs.readFile(path.join(TEMPLATE_DIR, 'release-static.yml'), 'utf8');
  requireValue(!workflow.includes('REPLACE_'), 'The controller workflow still contains placeholders.');
  return {
    '.github/workflows/release-static.yml': workflow,
    'scripts/psm_controller.py': await fs.readFile(path.join(TEMPLATE_DIR, 'scripts/psm_controller.py'), 'utf8'),
    'targets/werewolf__todo-staging-web.json': JSON.stringify(document, null, 2) + '\n',
    'todo-staging.known_hosts': connection.publicMetadata.knownHost.trim() + '\n',
    '.gitignore': '*.pem\n*.key\n.env*\n',
    'README.md': '# Werewolf deployment controller\n\nStaging-only scaffold for ' + REPO
      + '. No production target is included.\n\nGenerated from local PSM public metadata, not a new host attestation. Before adding credentials, independently verify the SSH fingerprint and the enrolled target digest/revision.\n\nRecorded target digest: '
      + connection.publicMetadata.targetContracts[TARGET].fingerprint
      + '\n\nConfigure the todo-staging-web GitHub Environment and artifact-reader App using psm/docs/deploy/TODO-STAGING-SETUP.md. No deployment is triggered by pushing this scaffold. Do not dispatch until the controller commit has been reviewed and pinned in PSM.\n',
  };
}

export async function writeScaffold(output, files) {
  requireValue(path.isAbsolute(output), '--output must be an absolute NEW directory.');
  // mkdir without recursive: fails for existing directories, including symlinks.
  await fs.mkdir(output, { mode: 0o700 });
  for (const [name, content] of Object.entries(files)) {
    const filename = path.join(output, name);
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await fs.writeFile(filename, content, { flag: 'wx', mode: 0o600 });
  }
}

const HELP = `Run from the machine hosting PSM (not the droplet):
  node scripts/setup-todo-staging.mjs check
  node scripts/setup-todo-staging.mjs fix-root
  node scripts/setup-todo-staging.mjs fix-root --apply --backup /absolute/new-backup.json
  node scripts/setup-todo-staging.mjs restore-root --backup /absolute/new-backup.json [--apply]
  node scripts/setup-todo-staging.mjs scaffold --output /absolute/new-controller-directory [--apply]
Optional: --agent http://127.0.0.1:4317
All commands are dry-run unless --apply is present.
Scaffold only writes local files; review and use the runbook to create the private GitHub repository.
No SSH, DNS, secret upload, GitHub mutation, restart or deployment is performed.`;

async function main(args) {
  if (!args.length || args.includes('--help')) { console.log(HELP); return; }
  const command = args.shift();
  requireValue(['check', 'fix-root', 'restore-root', 'scaffold'].includes(command), HELP);
  const options = {};
  while (args.length) {
    const key = args.shift();
    requireValue(!Object.hasOwn(options, key), 'Duplicate option: ' + key);
    if (key === '--apply') options[key] = true;
    else {
      requireValue(['--agent', '--backup', '--output'].includes(key), 'Unknown option: ' + key);
      const value = args.shift();
      requireValue(value && !value.startsWith('--'), 'Missing value for ' + key);
      options[key] = value;
    }
  }
  requireValue(!options['--backup'] || ['fix-root', 'restore-root'].includes(command), '--backup is only valid for root changes.');
  requireValue(!options['--output'] || command === 'scaffold', '--output is only valid for scaffold.');
  requireValue(command !== 'check' || !options['--apply'], 'check never applies changes.');
  const base = agentUrl(options['--agent'] || 'http://127.0.0.1:4317');
  const { connection, target } = await snapshot(base);
  const plan = rootPlan(connection, target);
  console.log(JSON.stringify({ mode: options['--apply'] ? 'APPLY' : 'DRY RUN', command,
    connectionId: CONNECTION, targetId: TARGET, expectedMetadataRevision: connection.metadataRevision,
    oldRoots: plan.before.allowedTargetRootPrefixes, intendedRoots: plan.after.allowedTargetRootPrefixes }, null, 2));
  if (command === 'check') {
    console.log(plan.changed ? 'The obsolete root must be replaced.' : 'The exact Todo root is already allowed.');
    targetDocument(connection, target);
    console.log('Public enrollment metadata present. This is not a live host attestation or deployment readiness check.');
    return;
  }
  if (command === 'scaffold') {
    requireValue(options['--output'], 'Provide --output /absolute/new-directory.');
    const files = await scaffoldFiles(connection, target);
    console.log('Scaffold files: ' + Object.keys(files).join(', '));
    if (options['--apply']) {
      await writeScaffold(options['--output'], files);
      console.log('Local scaffold written. No repository created/pushed; follow docs/deploy/TODO-STAGING-SETUP.md.');
    }
    return;
  }
  let body;
  if (command === 'restore-root') {
    requireValue(options['--backup'], '--backup is required.');
    body = restorePlan(connection, target, JSON.parse(await fs.readFile(options['--backup'], 'utf8')));
    console.log('Will restore only the previous exact root permission.');
  } else {
    if (!plan.changed) { console.log('Already correct; nothing to change.'); return; }
    body = { expectedMetadataRevision: plan.expectedMetadataRevision, constraints: plan.after };
  }
  if (!options['--apply']) { console.log('No changes made. Add --apply to perform this exact change.'); return; }
  if (command === 'fix-root') {
    requireValue(options['--backup'] && path.isAbsolute(options['--backup']), '--apply requires --backup /absolute/new-file.json.');
    await fs.writeFile(options['--backup'], JSON.stringify({ schema: 'psm.todo-staging-root-backup/v1', ...plan }, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 });
  }
  await request(base, '/api/connections/' + encodeURIComponent(CONNECTION), body);
  const after = await snapshot(base);
  requireValue(isDeepStrictEqual(after.connection.constraints, body.constraints),
    'Read-back differs from the intended constraints. Inspect the local cockpit and backup; do not retry blindly.');
  console.log('Verified exact root permission update. Credentials, target fingerprint and all other constraints were preserved.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}

