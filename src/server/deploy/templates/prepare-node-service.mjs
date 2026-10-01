import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// A Node service bundle: bundle/app (the service root with its production
// dependencies and built client), bundle/runtime/bin/node (this exact runtime)
// and bundle/version.json. The digest is the static tree digest plus each
// file's executable bit, matching the host helper's psm-service-tree-sha256@1.
const ALGORITHM = 'psm-service-tree-sha256@1';
const LIMITS = { maxFiles: 50000, maxPathBytes: 1024, maxFileBytes: 200_000_000, maxUnpackedBytes: 900_000_000 };
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const RELATIVE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const root = path.resolve(import.meta.dirname, '..', '..');
const work = path.join(process.env.RUNNER_TEMP || '', 'psm-service-artifact');
const bundle = path.join(work, 'bundle');

function fail(message) {
  throw new Error(`prepare-node-service: ${message}`);
}

function relative(name) {
  const value = process.env[name] || '';
  if (!RELATIVE.test(value) || value.split('/').some((part) => part === '..' || part === '.')) fail(`${name} must be a safe relative path`);
  return value;
}

function required(name, pattern = IDENTIFIER) {
  const value = process.env[name] || '';
  if (!pattern.test(value)) fail(`${name} is invalid`);
  return value;
}

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  fail('build profile is not canonical JSON data');
}

function digest(domain, value) {
  return `sha256:${createHash('sha256').update(domain).update('\0').update(canonical(value)).digest('hex')}`;
}

function contract() {
  let buildProfile;
  try { buildProfile = JSON.parse(process.env.PSM_BUILD_PROFILE_JSON || ''); } catch { fail('PSM_BUILD_PROFILE_JSON is invalid'); }
  const expectedProfileDigest = required('PSM_BUILD_PROFILE_DIGEST', DIGEST);
  if (digest('psm-deployment-build-profile:v1', buildProfile) !== expectedProfileDigest) fail('build profile digest mismatch');
  const environmentId = required('PSM_ENVIRONMENT_ID');
  if (buildProfile.id !== environmentId || !buildProfile.publicInputs || typeof buildProfile.publicInputs !== 'object') fail('unsupported build profile');
  return {
    psmRunId: required('PSM_RUN_ID'),
    psmArtifactId: required('PSM_ARTIFACT_ID'),
    projectId: required('PSM_PROJECT_ID'),
    environmentId,
    unitId: required('PSM_UNIT_ID'),
    commitSha: required('PSM_COMMIT_SHA', COMMIT),
    manifestDigest: required('PSM_MANIFEST_DIGEST', DIGEST),
    buildProfile,
    buildProfileDigest: expectedProfileDigest,
  };
}

function environment() {
  const { buildProfile } = contract();
  // Public inputs end up in the shipped client, so only VITE_ names are accepted.
  for (const [key, value] of Object.entries(buildProfile.publicInputs)) {
    if (!/^VITE_[A-Z0-9_]{1,64}$/.test(key)) fail(`${key} is not a public VITE_ build input`);
    if (typeof value !== 'string' || value.length > 2048 || /[\r\n\0]/.test(value)) fail(`${key} is invalid`);
    process.stdout.write(`${key}=${value}\n`);
  }
}

function canonicalPath(name) {
  const normalized = name.normalize('NFC').split(path.sep).join('/');
  if (!name || normalized !== name.split(path.sep).join('/') || normalized.includes('\\') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) fail(`non-canonical path: ${name}`);
  return normalized;
}

function walk(directory, base = directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    const name = canonicalPath(path.relative(base, filename));
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail(`links and special files are not allowed: ${name}`);
    if (stat.isDirectory()) walk(filename, base, files);
    else files.push({ filename, name, size: stat.size, executable: (stat.mode & 0o111) !== 0 });
  }
  return files;
}

/** The exact algorithm the host helper recomputes; see host-helper/digest.go. */
export function treeDigest(directory) {
  const files = walk(directory).sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  if (files.length > LIMITS.maxFiles) fail(`bundle has ${files.length} files; the limit is ${LIMITS.maxFiles}`);
  const hash = createHash('sha256').update(ALGORITHM).update('\0');
  let total = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    if (name.length > LIMITS.maxPathBytes || file.size > LIMITS.maxFileBytes) fail(`bundle limit exceeded by ${file.name}`);
    total += file.size;
    if (total > LIMITS.maxUnpackedBytes) fail('bundle is too large');
    const header = Buffer.alloc(5);
    header[0] = 1;
    header.writeUInt32BE(name.length, 1);
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(file.size));
    hash.update(header).update(name).update(size)
      .update(createHash('sha256').update(fs.readFileSync(file.filename)).digest())
      .update(Buffer.from([file.executable ? 1 : 0]));
  }
  return { payloadDigest: `sha256:${hash.digest('hex')}`, fileCount: files.length, payloadBytes: total };
}

const ENV_FILE = /^\.env(\..+)?$/;
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/;

/**
 * Copy the service root, refusing what must never ship: an environment file
 * (secrets come from PSM at run time), a private key in the app's own code,
 * and a native addon compiled for this runner rather than the target host.
 */
function copyService(source, destination, insideModules = false) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o755 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) fail(`${path.relative(root, from)} is a symbolic link; install with --install-links --no-bin-links`);
    if (stat.isDirectory()) {
      if (!insideModules && (entry.name === '.git' || entry.name === 'logs')) continue;
      copyService(from, to, insideModules || entry.name === 'node_modules');
      continue;
    }
    if (!stat.isFile()) fail(`${path.relative(root, from)} is not a regular file`);
    if (ENV_FILE.test(entry.name)) {
      if (entry.name === '.env.example' || entry.name === '.env.sample') continue;
      fail(`${path.relative(root, from)} would ship an environment file; runtime values come from PSM`);
    }
    if (entry.name.endsWith('.node')) fail(`${path.relative(root, from)} is a native addon; node-service@1 ships no native modules`);
    if (!insideModules && stat.size < 1_000_000 && PRIVATE_KEY.test(fs.readFileSync(from, 'utf8'))) fail(`${path.relative(root, from)} contains a private key`);
    fs.copyFileSync(from, to);
    fs.chmodSync(to, (stat.mode & 0o111) !== 0 ? 0o755 : 0o644);
  }
}

function prepare() {
  const input = contract();
  const serviceRoot = relative('PSM_SERVICE_ROOT');
  const entry = relative('PSM_SERVICE_ENTRY');
  const publicDir = relative('PSM_SERVICE_PUBLIC');
  const runtimeMajor = required('PSM_RUNTIME_MAJOR', /^(20|22|24)$/);
  const source = path.join(root, ...serviceRoot.split('/'));
  if (!fs.statSync(source).isDirectory()) fail(`${serviceRoot} does not exist`);
  if (!fs.existsSync(path.join(source, ...entry.split('/')))) fail(`${serviceRoot}/${entry} does not exist`);
  if (!fs.existsSync(path.join(source, 'node_modules'))) fail(`${serviceRoot}/node_modules is missing; install production dependencies first`);
  const nodeVersion = process.version;
  if (nodeVersion.split('.')[0] !== `v${runtimeMajor}`) fail(`runner Node ${nodeVersion} is not the declared node@${runtimeMajor}`);
  fs.rmSync(work, { recursive: true, force: true });
  copyService(source, path.join(bundle, 'app'));
  const served = path.join(bundle, 'app', ...publicDir.split('/'));
  fs.mkdirSync(served, { recursive: true, mode: 0o755 });
  if (fs.existsSync(path.join(served, 'version.json'))) fail(`${serviceRoot}/${publicDir}/version.json is reserved for release metadata`);
  fs.mkdirSync(path.join(bundle, 'runtime', 'bin'), { recursive: true, mode: 0o755 });
  fs.copyFileSync(process.execPath, path.join(bundle, 'runtime', 'bin', 'node'));
  fs.chmodSync(path.join(bundle, 'runtime', 'bin', 'node'), 0o755);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!VERSION.test(pkg.version || '')) fail('root package version is invalid');
  const metadata = `${JSON.stringify({
    version: pkg.version,
    commit: input.commitSha,
    psmArtifactId: input.psmArtifactId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    unitId: input.unitId,
    node: nodeVersion,
  })}\n`;
  // Once beside the bundle for the helper, once where the app serves it for probes.
  fs.writeFileSync(path.join(bundle, 'version.json'), metadata, { mode: 0o644, flag: 'wx' });
  fs.writeFileSync(path.join(served, 'version.json'), metadata, { mode: 0o644, flag: 'wx' });
  const identity = treeDigest(bundle);
  const archive = path.join(work, 'payload.tar');
  const tar = spawnSync('tar', ['--sort=name', '--format=ustar', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', archive, '-C', work, 'bundle'], { stdio: 'inherit' });
  if (tar.status !== 0) fail('deterministic tar creation failed');
  const archiveDigest = `sha256:${createHash('sha256').update(fs.readFileSync(archive)).digest('hex')}`;
  fs.writeFileSync(path.join(work, 'prepared.json'), `${JSON.stringify({ ...input, version: pkg.version, ...identity, archiveDigest })}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`Bundle ${identity.payloadDigest}: ${identity.fileCount} files, ${identity.payloadBytes} bytes, Node ${nodeVersion}.`);
}

function result() {
  const prepared = JSON.parse(fs.readFileSync(path.join(work, 'prepared.json'), 'utf8'));
  const githubArtifactId = required('PSM_GITHUB_ARTIFACT_ID', /^[1-9]\d{0,30}$/);
  const producerRunId = required('PSM_GITHUB_RUN_ID', /^[1-9]\d{0,30}$/);
  const retainedUntil = new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString();
  const value = {
    schema: 'psm.werewolf.solutions/prepare-artifact-result/v1',
    psm_run_id: prepared.psmRunId,
    psm_artifact_id: prepared.psmArtifactId,
    project_id: prepared.projectId,
    environment_id: prepared.environmentId,
    unit_id: prepared.unitId,
    source_repository: process.env.GITHUB_REPOSITORY,
    producer_run_id: producerRunId,
    github_artifact_id: githubArtifactId,
    commit_sha: prepared.commitSha,
    version: prepared.version,
    manifest_digest: prepared.manifestDigest,
    build_profile_digest: prepared.buildProfileDigest,
    payload_algorithm: ALGORITHM,
    payload_limits: LIMITS,
    payload_digest: prepared.payloadDigest,
    archive_digest: prepared.archiveDigest,
    retained_until: retainedUntil,
  };
  fs.writeFileSync(path.join(work, 'psm-artifact-result.json'), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

// Run as a workflow step; imported (by PSM's tests) it only exports treeDigest.
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const command = process.argv[2];
  if (command === 'environment') environment();
  else if (command === 'prepare') prepare();
  else if (command === 'result') result();
  else fail('expected environment, prepare or result');
}
