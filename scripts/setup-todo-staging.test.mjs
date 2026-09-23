import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { CONNECTION, TARGET, PROJECT, ROOT, OLD_ROOT, agentUrl, rootPlan, targetDocument, restorePlan, scaffoldFiles, writeScaffold } from './setup-todo-staging.mjs';

const fixture = () => ({
  connection: { connectionId: CONNECTION, kind: 'ssh-host-helper@1', metadataRevision: 3,
    constraints: { allowedProjectIds: [PROJECT], allowedEnvironmentIds: ['staging'], allowedTargetIds: [TARGET],
      maximumAuthorizedRisk: 'staging', allowedTargetRootPrefixes: [OLD_ROOT],
      ssh: { host: '192.0.2.1', user: 'psm-infra', port: 22, hostKeyFingerprint: 'SHA256:' + 'a'.repeat(43) } },
    publicMetadata: { knownHost: '192.0.2.1 ssh-ed25519 PUBLIC_TEST_FIXTURE',
      targetContracts: { [TARGET]: { revision: 'todo-staging-v1', fingerprint: 'sha256:' + 'b'.repeat(64) } } } },
  target: { targetId: TARGET, project: { id: PROJECT }, environment: 'staging', root: ROOT },
});

test('only local agent origins, with no credentials/path/redirect ambiguity', () => {
  assert.equal(agentUrl('http://127.0.0.1:4317'), 'http://127.0.0.1:4317');
  for (const url of ['https://example.com', 'http://192.0.2.1', 'http://u:p@localhost', 'http://localhost/api', 'http://localhost/?x=1'])
    assert.throws(() => agentUrl(url));
});
test('root plan replaces, never broadens, and preserves every other constraint', () => {
  const { connection, target } = fixture();
  const before = structuredClone(connection);
  const plan = rootPlan(connection, target);
  assert.deepEqual(plan.after, { ...connection.constraints, allowedTargetRootPrefixes: [ROOT] });
  assert.deepEqual(connection, before);
  assert.equal(plan.expectedMetadataRevision, 3);
  connection.constraints = plan.after;
  assert.equal(rootPlan(connection, target).changed, false);
});
test('wrong connection, environment, project, target or unexpected roots fail closed', () => {
  for (const mutate of [
    f => f.connection.connectionId = 'other',
    f => f.connection.constraints.allowedEnvironmentIds = ['production'],
    f => f.connection.constraints.allowedProjectIds.push('other'),
    f => f.connection.constraints.allowedTargetIds = ['other'],
    f => f.connection.constraints.maximumAuthorizedRisk = 'production',
    f => f.connection.constraints.allowedTargetRootPrefixes = ['/var/www'],
    f => f.connection.constraints.allowedTargetRootPrefixes.push('/unrelated'),
    f => f.target.root = '/wrong',
  ]) {
    const f = fixture(); mutate(f);
    assert.throws(() => rootPlan(f.connection, f.target));
  }
});
test('controller target comes from metadata, never placeholder or production copy', () => {
  const { connection, target } = fixture();
  const doc = targetDocument(connection, target);
  assert.equal(doc.canonicalRoot, ROOT);
  assert.equal(doc.targetId, TARGET);
  assert.equal(doc.sshHost, '192.0.2.1');
  assert.equal(doc.contractRevision, 'todo-staging-v1');
  connection.publicMetadata.targetContracts[TARGET].fingerprint = 'REPLACE_ME';
  assert.throws(() => targetDocument(connection, target));
});
test('rollback refuses changed revisions or backup scope tampering', () => {
  const { connection, target } = fixture();
  const plan = rootPlan(connection, target);
  const backup = { schema: 'psm.todo-staging-root-backup/v1', ...plan };
  connection.constraints = plan.after;
  connection.metadataRevision++;
  assert.deepEqual(restorePlan(connection, target, backup).constraints, plan.before);
  connection.metadataRevision++;
  assert.throws(() => restorePlan(connection, target, backup));
  connection.metadataRevision--;
  backup.before.allowedEnvironmentIds = ['production'];
  assert.throws(() => restorePlan(connection, target, backup));
});
test('scaffold has exactly the staging target and refuses overwrites', async () => {
  const { connection, target } = fixture();
  const files = await scaffoldFiles(connection, target);
  assert.match(files['.github/workflows/release-static.yml'], /permissions:\n  contents: read/);
  assert.deepEqual(Object.keys(files).filter(f => f.startsWith('targets/')), ['targets/werewolf__todo-staging-web.json']);
  assert.ok(!Object.values(files).some(v => v.includes('REPLACE_')));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'psm-setup-test-'));
  try {
    const output = path.join(tmp, 'controller');
    await writeScaffold(output, files);
    assert.equal(await fs.readFile(path.join(output, 'targets/werewolf__todo-staging-web.json'), 'utf8'),
      files['targets/werewolf__todo-staging-web.json']);
    await assert.rejects(writeScaffold(output, files), { code: 'EEXIST' });
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});
test('CLI defaults to read-only; explicit apply uses revision, backup and read-back', async () => {
  const f = fixture();
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push(req.method);
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') {
      res.end(JSON.stringify(req.url === '/api/connections' ? { connections: [f.connection] } : { targets: [f.target] }));
    } else {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      assert.equal(body.expectedMetadataRevision, f.connection.metadataRevision);
      assert.ok(req.headers.origin.startsWith('http://127.0.0.1:'));
      f.connection.constraints = body.constraints; f.connection.metadataRevision++;
      res.end(JSON.stringify({ ok: true }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'psm-setup-cli-test-'));
  const run = args => new Promise(resolve => {
    const p = spawn(process.execPath, [new URL('./setup-todo-staging.mjs', import.meta.url).pathname,
      ...args, '--agent', 'http://127.0.0.1:' + server.address().port]);
    let output = ''; p.stdout.on('data', b => output += b); p.stderr.on('data', b => output += b);
    p.on('exit', code => resolve({ code, output }));
  });
  try {
    assert.equal((await run(['fix-root'])).code, 0);
    assert.ok(requests.every(v => v === 'GET'));
    const backup = path.join(tmp, 'backup.json');
    const result = await run(['fix-root', '--apply', '--backup', backup]);
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(f.connection.constraints.allowedTargetRootPrefixes, [ROOT]);
    assert.equal(requests.filter(v => v === 'PATCH').length, 1);
    assert.equal((await fs.stat(backup)).mode & 0o777, 0o600);
    const undone = await run(['restore-root', '--apply', '--backup', backup]);
    assert.equal(undone.code, 0, undone.output);
    assert.deepEqual(f.connection.constraints.allowedTargetRootPrefixes, [OLD_ROOT]);
  } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(tmp, { recursive: true, force: true }); }
});
