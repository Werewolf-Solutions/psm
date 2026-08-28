/**
 * Builds psm's immutable static artifact for one managed deployment run.
 *
 * A near-copy of todo-app's script of the same name; the three differences are
 * psm's payload directory (`web/`, which has no build step and is served as
 * authored), its one allowed public build input, and the message when the
 * directory is missing. The payload digest algorithm, canonical-path rules,
 * limits and result contract are the deployment system's, not this project's —
 * keep them identical across repositories or two projects will disagree about
 * what the same bytes are called.
 *
 * `environment` exposes the vetted public inputs, `prepare` produces the
 * deterministic archive and its independent digest, and `result` writes the
 * redacted contract psm reads back. Nothing here may print a secret.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ALGORITHM = 'psm-static-tree-sha256@1';
const LIMITS = { maxFiles: 5000, maxPathBytes: 1024, maxFileBytes: 20_000_000, maxUnpackedBytes: 200_000_000 };
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const root = path.resolve(import.meta.dirname, '..', '..');
const output = path.join(root, 'web');
const work = path.join(process.env.RUNNER_TEMP || '', 'psm-static-artifact');

function fail(message) {
  throw new Error(`prepare-static-artifact: ${message}`);
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
  if (buildProfile.id !== 'production' || !buildProfile.publicInputs || typeof buildProfile.publicInputs !== 'object') fail('unsupported build profile');
  return {
    psmRunId: required('PSM_RUN_ID'),
    psmArtifactId: required('PSM_ARTIFACT_ID'),
    projectId: required('PSM_PROJECT_ID'),
    environmentId: required('PSM_ENVIRONMENT_ID'),
    unitId: required('PSM_UNIT_ID'),
    commitSha: required('PSM_COMMIT_SHA', COMMIT),
    manifestDigest: required('PSM_MANIFEST_DIGEST', DIGEST),
    buildProfile,
    buildProfileDigest: expectedProfileDigest,
  };
}

function environment() {
  const { buildProfile } = contract();
  const allowed = new Set(['PSM_BASE_URL']);
  const entries = Object.entries(buildProfile.publicInputs);
  if (entries.length !== allowed.size || entries.some(([key]) => !allowed.has(key))) fail('public build inputs differ from the production profile');
  for (const [key, value] of entries) {
    if (typeof value !== 'string' || value.length > 2048 || /[\r\n\0]/.test(value)) fail(`${key} is invalid`);
    let url;
    try { url = new URL(value); } catch { fail(`${key} is not a URL`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail(`${key} is not a public HTTPS origin or base`);
    process.stdout.write(`${key}=${value}\n`);
  }
}

function canonicalPath(relative) {
  const normalized = relative.normalize('NFC').split(path.sep).join('/');
  if (!relative || normalized !== relative.split(path.sep).join('/') || normalized.includes('\\') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) fail(`non-canonical path: ${relative}`);
  return normalized;
}

function walk(directory, base = directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    const relative = canonicalPath(path.relative(base, filename));
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail(`special entry is forbidden: ${relative}`);
    if (stat.isDirectory()) walk(filename, base, files);
    else files.push({ filename, relative, size: stat.size });
  }
  return files;
}

function treeDigest(directory) {
  const files = walk(directory).sort((left, right) => Buffer.compare(Buffer.from(left.relative), Buffer.from(right.relative)));
  if (files.length > LIMITS.maxFiles) fail('payload has too many files');
  const hash = createHash('sha256').update(ALGORITHM).update('\0');
  let total = 0;
  for (const file of files) {
    const name = Buffer.from(file.relative);
    if (name.length > LIMITS.maxPathBytes || file.size > LIMITS.maxFileBytes) fail(`payload limit exceeded by ${file.relative}`);
    total += file.size;
    if (total > LIMITS.maxUnpackedBytes) fail('payload is too large');
    const header = Buffer.alloc(5);
    header[0] = 1;
    header.writeUInt32BE(name.length, 1);
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(file.size));
    hash.update(header).update(name).update(size).update(createHash('sha256').update(fs.readFileSync(file.filename)).digest());
  }
  return { payloadDigest: `sha256:${hash.digest('hex')}`, fileCount: files.length, payloadBytes: total };
}

function prepare() {
  const input = contract();
  if (!fs.statSync(output).isDirectory()) fail('web/ does not exist');
  for (const reserved of ['release.json', '.psm-release.json']) if (fs.existsSync(path.join(output, reserved))) fail(`${reserved} is reserved`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(path.join(work, 'site'), { recursive: true, mode: 0o755 });
  fs.cpSync(output, path.join(work, 'site'), { recursive: true, dereference: false, errorOnExist: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!VERSION.test(pkg.version || '')) fail('root package version is invalid');
  fs.writeFileSync(path.join(work, 'site', 'version.json'), `${JSON.stringify({
    version: pkg.version,
    commit: input.commitSha,
    psmArtifactId: input.psmArtifactId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    unitId: input.unitId,
  })}\n`, { mode: 0o644, flag: 'wx' });
  const identity = treeDigest(path.join(work, 'site'));
  const archive = path.join(work, 'payload.tar');
  const tar = spawnSync('tar', ['--sort=name', '--format=ustar', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', archive, '-C', work, 'site'], { stdio: 'inherit' });
  if (tar.status !== 0) fail('deterministic tar creation failed');
  const archiveDigest = `sha256:${createHash('sha256').update(fs.readFileSync(archive)).digest('hex')}`;
  fs.writeFileSync(path.join(work, 'prepared.json'), `${JSON.stringify({ ...input, version: pkg.version, ...identity, archiveDigest })}\n`, { mode: 0o600, flag: 'wx' });
}

function result() {
  const prepared = JSON.parse(fs.readFileSync(path.join(work, 'prepared.json'), 'utf8'));
  const githubArtifactId = required('PSM_GITHUB_ARTIFACT_ID', /^[1-9]\d{0,30}$/);
  const producerRunId = required('PSM_GITHUB_RUN_ID', /^[1-9]\d{0,30}$/);
  const retainedUntil = new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString();
  const value = {
    schema: 'psm.werewolf.solutions/prepare-artifact-result/v1',
    psmRunId: prepared.psmRunId,
    psmArtifactId: prepared.psmArtifactId,
    projectId: prepared.projectId,
    environmentId: prepared.environmentId,
    unitId: prepared.unitId,
    sourceRepository: process.env.GITHUB_REPOSITORY,
    producerRunId,
    githubArtifactId,
    commitSha: prepared.commitSha,
    version: prepared.version,
    manifestDigest: prepared.manifestDigest,
    buildProfileDigest: prepared.buildProfileDigest,
    payloadAlgorithm: ALGORITHM,
    payloadLimits: LIMITS,
    payloadDigest: prepared.payloadDigest,
    archiveDigest: prepared.archiveDigest,
    retainedUntil,
  };
  fs.writeFileSync(path.join(work, 'psm-artifact-result.json'), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

const command = process.argv[2];
if (command === 'environment') environment();
else if (command === 'prepare') prepare();
else if (command === 'result') result();
else fail('expected environment, prepare or result');
