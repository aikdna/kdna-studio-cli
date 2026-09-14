'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ROOT, TEXT, INTERVIEW, authored, invoke, launch, prepare, save } = require('./session-harness');
let completed;
test('Chinese text/interview and live interview through revised preview and immutable export', async () => {
  const { session, preview } = await prepare(undefined, true);
  const changed = await session.op('brief', { title: '样本记录整理复核版', scope: '只处理虚构实验材料，补充复核说明' });
  assert.equal(changed.result.final_decision, null); assert.equal(changed.result.preview, null);
  const second = await session.op('preview'); assert.notEqual(second.result.artifact_digest, preview.result.artifact_digest);
  await session.review('我确认重新编译的当前预览，并导出此合成测试文件。', 'confirm');
  const exported = await session.op('export'); const result = await session.finished;
  assert.equal(result.status, 0, result.stderr); completed = session.directory;
  assert.equal(exported.result.verification.confirmation, 'claimed_unverified');
  assert.equal(exported.result.verification.identity, 'not_verified');
  assert.equal(exported.result.verification.creation_accepted, 'not_evaluated');
  assert.equal(exported.result.verification.action_authorization, 'not_evaluated');
  assert.match(result.stderr, /不确定的编号先留空/);
  const bytes = fs.readFileSync(path.join(completed, 'asset.kdna'));
  assert.equal(bytes.includes(Buffer.from('PRIVATE_TEXT_MARKER')), false);
  assert.equal(bytes.includes(Buffer.from('PRIVATE_INTERVIEW_MARKER')), false);
  assert.equal(fs.statSync(completed).mode & 0o777, 0o500);
  for (const file of fs.readdirSync(completed)) assert.equal(fs.statSync(path.join(completed, file)).mode & 0o777, 0o400);
  save('completed-bundle', { directory: completed, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
});
test('fresh process verifies and Read requires explicit permission while preserving mandatory selected text', () => {
  const verified = invoke(['verify', '--bundle', completed]); assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).status, 'consistent');
  const denied = invoke(['read', '--bundle', completed]); assert.equal(denied.status, 3);
  const noHost = JSON.parse(denied.stdout); assert.equal(noHost.envelope.content, null);
  assert.equal(noHost.envelope.diagnostics[0].code, 'READ_HOST_CONTEXT_UNTRUSTED');
  const allowed = invoke(['read', '--bundle', completed, '--allow-read', '--judgment', '1']); assert.equal(allowed.status, 0, allowed.stderr);
  const envelope = JSON.parse(allowed.stdout).envelope;
  assert.equal(envelope.status, 'ready'); assert.equal(envelope.states.action_authorization, 'not_evaluated');
  assert.equal(envelope.states.read_permission, 'allowed');
  assert.equal(envelope.content.closure.find(x => x.role === 'result').value.value.value, '保留原标签；不确定的编号先留空，核对原记录后再补。');
});
test('Read budget admission rejects before filesystem access; zero budget gives no body', () => {
  for (const limit of ['-1', '9007199254740992', 'NaN']) {
    const result = invoke(['read', '--bundle', '/nonexistent-private-cli-test', '--budget', limit]);
    assert.equal(result.status, 3); assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).channel, 'admission_rejection');
  }
  const zero = invoke(['read', '--bundle', completed, '--allow-read', '--budget', '0']); assert.equal(zero.status, 3);
  assert.equal(JSON.parse(zero.stdout).channel, 'no_body_control');
});
test('corrupt Core bytes reject before private evidence; evidence tampering prevents disclosure', () => {
  const bad = path.join(ROOT, 'corrupt-core'); fs.mkdirSync(bad);
  fs.writeFileSync(path.join(bad, 'asset.kdna'), 'synthetic invalid container');
  const core = invoke(['verify', '--bundle', bad]); assert.equal(core.status, 3); assert.equal(JSON.parse(core.stdout).reason, 'READ_CORE_INVALID');
  const tampered = path.join(ROOT, 'tampered-evidence'); fs.mkdirSync(tampered);
  for (const file of fs.readdirSync(completed)) fs.copyFileSync(path.join(completed, file), path.join(tampered, file));
  const p = path.join(tampered, 'creation-evidence.json'); const evidence = JSON.parse(fs.readFileSync(p));
  evidence.materials[0].content += 'tampered'; fs.chmodSync(p, 0o600); fs.writeFileSync(p, JSON.stringify(evidence));
  const result = invoke(['read', '--bundle', tampered, '--allow-read']); assert.equal(result.status, 3);
  assert.equal(JSON.parse(result.stdout).reason, 'CREATION_BINDING_MISMATCH');
});
test('old commands and raw options fail before source/output access', () => {
  for (const command of ['create', 'create-agent', 'resume', 'card', 'migrate', 'fork', 'export-agent', 'finalize-agent', 'identity', 'llm', 'distill', 'interview']) {
    const result = invoke([command]); assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.match(result.stderr, /CLI_COMMAND_UNSUPPORTED/);
  }
  const raw = invoke(['session', '--out', '/nonexistent-parent/output', '--wire', '/nonexistent-secret']);
  assert.equal(raw.status, 2); assert.match(raw.stderr, /CLI_OPTION_UNSUPPORTED/); assert.doesNotMatch(raw.stderr, /nonexistent-secret/);
  const channel = invoke(['session', '--out', '/nonexistent-parent/output', '--text', '/nonexistent-secret', '--human-fd', '0']);
  assert.equal(channel.status, 2); assert.match(channel.stderr, /CLI_HUMAN_CHANNEL_INVALID/);
});
test('duplicate operations and injected human fields fail closed with no output', async () => {
  for (const injection of [false, true]) {
    const session = launch(['--text', TEXT, '--interview', INTERVIEW]); await session.next();
    if (injection) session.send({ id: 'bad', op: 'review', data: { human: '我同意', final_decision: true } });
    else {
      const value = { id: 'reused', op: 'brief', data: { title: '合成标题', scope: '合成范围' } };
      session.send(value); await session.next(); session.send(value);
    }
    const result = await session.finished; assert.equal(result.status, 2);
    assert.match(result.stderr, injection ? /CLI_FIELD_FORBIDDEN/ : /CLI_REQUEST_REPLAY/);
    assert.equal(fs.existsSync(session.directory), false);
  }
});
test('old reply ticket cannot be replayed into a new human review', async () => {
  const session = launch(['--text', TEXT, '--interview', INTERVIEW]); await session.next();
  await session.op('brief', { title: '合成标题', scope: '合成范围' }); await session.op('propose', authored);
  const first = await session.review('先保留第一条。', 'select', [1]);
  await session.review('新的回复仅供重新审查。', 'note', undefined, first.ticket);
  const result = await session.finished; assert.equal(result.status, 2); assert.match(result.stderr, /CLI_REPLY_STALE/);
  assert.equal(fs.existsSync(session.directory), false);
});
test('edit invalidates confirmed preview and stale export leaves no partial directory', async () => {
  const { session } = await prepare();
  await session.op('brief', { title: '修改后的标题', scope: '修改后的范围' });
  session.send({ id: 'stale-export', op: 'export', data: {} });
  const result = await session.finished; assert.equal(result.status, 2); assert.match(result.stderr, /CREATION_EVIDENCE_REQUIRED/);
  assert.equal(fs.existsSync(session.directory), false);
});
test('existing export directory is not replaced', async () => {
  const before = fs.readFileSync(path.join(completed, 'asset.kdna'));
  const { session } = await prepare(completed); session.send({ id: 'overwrite', op: 'export', data: {} });
  const result = await session.finished; assert.equal(result.status, 2); assert.match(result.stderr, /EEXIST/);
  assert.deepEqual(fs.readFileSync(path.join(completed, 'asset.kdna')), before);
});
test('missing material, unknown fields and EOF have no successful export', async () => {
  const session = launch(); await session.next();
  session.send({ id: 'without-material', op: 'propose', data: { ...authored, materials: [] } });
  const result = await session.finished; assert.equal(result.status, 2); assert.match(result.stderr, /MATERIAL_REQUIRED/);
  const empty = launch(); await empty.next(); empty.child.stdin.end();
  const eof = await empty.finished; assert.equal(eof.status, 2); assert.match(eof.stderr, /CLI_SESSION_UNEXPORTED/);
});
test.after(() => { console.log(JSON.stringify({ evidence_root: ROOT, completed_bundle: completed })); });
