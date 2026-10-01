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
// The build output, relative to the repository root, as the workflow names it.
const outputRelative = process.env.PSM_STATIC_OUTPUT || '';
if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(outputRelative) || outputRelative.split('/').some((part) => part === '..' || part === '.')) {
  throw new Error('prepare-static-artifact: PSM_STATIC_OUTPUT must be a safe relative path');
}
const output = path.join(root, ...outputRelative.split('/'));
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
  // The profile must be the one belonging to the environment psm asked us to
  // build, so a staging profile can never be baked into a production artifact
  // (or the reverse) — VITE_API_BASE differs between them.
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
  // Public inputs are the digest-checked build profile's own keys. They end up in
  // the shipped bundle, so only VITE_ names are accepted, and a value can never
  // break out of its GITHUB_ENV line.
  for (const [key, value] of Object.entries(buildProfile.publicInputs)) {
    if (!/^VITE_[A-Z0-9_]{1,64}$/.test(key)) fail(`${key} is not a public VITE_ build input`);
    if (typeof value !== 'string' || value.length > 2048 || /[\r\n\0]/.test(value)) fail(`${key} is invalid`);
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
  if (!fs.statSync(output).isDirectory()) fail(`${outputRelative} does not exist`);
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
