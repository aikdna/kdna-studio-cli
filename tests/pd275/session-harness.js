'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const assert = require('node:assert/strict');
const ROOT = fs.mkdtempSync(path.join(process.env.KDNA_CLI_TEST_ROOT || os.tmpdir(), 'cli-observations-'));
const BIN = process.env.KDNA_CLI_TEST_BIN || path.resolve(__dirname, '../../bin/kdna-studio.js');
let sequence = 0;
function save(name, value) { fs.writeFileSync(path.join(ROOT, `${++sequence}-${name}.json`), JSON.stringify(value, null, 2) + '\n'); }
function isolated(command) {
  return ['-i', ...Object.entries(process.env).map(([key, value]) => key + '=' + value),
    '/bin/sh', '-c', 'exec "$@"', 'pd308-existing-test', ...command];
}
function invoke(args) {
  const start = new Date().toISOString();
  const argv = isolated([process.execPath, BIN, ...args]);
  const result = spawnSync('/usr/bin/env', argv, { encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  const record = { pid: result.pid, argv: ['/usr/bin/env', ...argv], start, end: new Date().toISOString(), status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error?.message };
  save('command', record); return record;
}
function launch(extra = [], destination) {
  const directory = destination || path.join(ROOT, 'bundle-' + crypto.randomUUID());
  const args = [BIN, 'session', '--out', directory, '--human-fd', '3', '--synthetic-fixture', ...extra];
  const argv = isolated([process.execPath, ...args]);
  const child = spawn('/usr/bin/env', argv, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; const writes = []; const start = new Date().toISOString();
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const iterator = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  const finished = new Promise(resolve => child.on('close', (status, signal) => {
    clearTimeout(timer);
    const record = { pid: child.pid, argv: ['/usr/bin/env', ...argv], start, end: new Date().toISOString(), status, signal, stdout, stderr, writes };
    save('session', record); resolve(record);
  }));
  child.stdin.on('error', () => {}); child.stdio[3].on('error', () => {});
  let id = 0;
  const api = {
    directory, child, finished,
    send(value) { writes.push({ channel: 'agent', value }); child.stdin.write(JSON.stringify(value) + '\n'); },
    human(value) { writes.push({ channel: 'synthetic-human', value }); child.stdio[3].write(value + '\n'); },
    async next() { const next = await iterator.next(); if (next.done) throw new Error('CLI ended: ' + stderr); return JSON.parse(next.value); },
    async op(op, data = {}) { const request = { id: 'step-' + (++id), op, data }; api.send(request); return api.next(); },
    async review(reply, kind, candidates, ticketOverride) {
      const request = { id: 'step-' + (++id), op: 'review', data: {} }; api.send(request); api.human(reply);
      const event = await api.next(); assert.equal(event.event, 'human_reply'); assert.equal(event.text, reply);
      const data = { replyTo: ticketOverride || event.replyTo, kind };
      if (candidates !== undefined) data.candidates = candidates;
      api.send({ id: 'step-' + (++id), op: 'interpret', data });
      if (ticketOverride) return event;
      const result = await api.next(); assert.equal(result.id, request.id); return { ...result, ticket: event.replyTo };
    },
  };
  return api;
}
const crypto = require('node:crypto');
const TEXT = path.join(ROOT, 'ordinary-text.md');
const INTERVIEW = path.join(ROOT, 'ordinary-interview.txt');
fs.writeFileSync(TEXT, '合成中文普通材料：实验样本标签破损时，保留原标签，核对记录后再补充。PRIVATE_TEXT_MARKER');
fs.writeFileSync(INTERVIEW, '合成访谈：问：看不清编号怎么办？答：不要凭记忆补编号，应先隔离保留。PRIVATE_INTERVIEW_MARKER');
const authored = {
  title: '保留原始样本标记', subject: '本次虚构实验的样本标签', scope: '仅用于合成实验记录',
  statement: '保留原标签，再核对实验记录。', rationale: '原始记录支持后续核查。', materials: [1, 2],
};
async function prepare(destination, withInterview = false) {
  const session = launch(['--text', TEXT, '--interview', INTERVIEW], destination);
  const ready = await session.next(); assert.equal(ready.event, 'ready'); assert.equal(ready.workspace.materials.length, 2);
  assert.deepEqual(ready.workspace.materials.map(x => x.type), ['text', 'interview']);
  await session.op('brief', { title: '样本记录整理', scope: '只处理虚构实验材料' });
  if (withInterview) {
    session.human('合成新访谈：先留存原记录，不以猜测替代。');
    const interview = await session.op('interview', { title: '补充访谈', question: '记录有疑问时怎样处理？' });
    assert.equal(interview.result.type, 'interview');
  }
  await session.op('propose', authored);
  await session.op('propose', { ...authored, title: '直接猜测编号', statement: '按印象补全所有编号。' });
  await session.review('第二条没有依据，拒绝。', 'reject', [2]);
  await session.review('第一条补充：不确定的编号先留空，核对原记录后再补。', 'revise', [1]);
  await session.op('revise', { candidate: 1, authored: { ...authored, statement: '保留原标签；不确定的编号先留空，核对原记录后再补。' }, explanation: '落实本次合成人类回复要求。' });
  await session.review('选择修改后的第一条。', 'select', [1]);
  const preview = await session.op('preview'); assert.equal(preview.result.format_valid, true);
  const confirm = await session.review('我确认当前展示的这版合成预览。', 'confirm');
  assert.equal(confirm.result.final_decision.artifact_digest, preview.result.artifact_digest);
  return { session, preview, confirm };
}
module.exports = { ROOT, BIN, TEXT, INTERVIEW, authored, invoke, launch, prepare, save };
