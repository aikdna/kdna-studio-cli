'use strict';

// Terminal I/O and Studio API orchestration. Public semantics stay upstream.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const tty = require('node:tty');
const { TextDecoder } = require('node:util');
const { createRequire } = require('node:module');
const bindings = require('./public-bindings.json');
const LIMIT = 1024 * 1024;
function fail(code) { throw Object.assign(new Error(code), { code }); }
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('CLI_INPUT_INVALID');
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail('CLI_FIELD_FORBIDDEN');
}
function text(value) {
  if (typeof value !== 'string' || !value.trim() || !value.isWellFormed() || Buffer.byteLength(value) > LIMIT) fail('CLI_TEXT_INVALID');
  return value;
}
function json(value) { return JSON.stringify(value) + '\n'; }
function emit(value) { process.stdout.write(json(value)); }
function parse(raw) { try { return JSON.parse(raw); } catch { fail('CLI_JSON_INVALID'); } }
function decode(raw) { try { return new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { fail('CLI_UTF8_INVALID'); } }

async function* lines(stream) {
  let pending = Buffer.alloc(0);
  for await (const chunk of stream) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    let end;
    while ((end = pending.indexOf(10)) !== -1) {
      if (end > LIMIT) fail('CLI_FRAME_LIMIT');
      const raw = pending.subarray(0, end); pending = pending.subarray(end + 1);
      yield decode(raw);
    }
    if (pending.length > LIMIT) fail('CLI_FRAME_LIMIT');
  }
  if (pending.length) fail('CLI_FRAME_INCOMPLETE');
}

function agentInput(stream, onStop, eofCode) {
  let pending = Buffer.alloc(0);
  let queued = null;
  let waiter = null;
  let failure = null;
  let completed = false;
  let closing = false;
  const error = code => Object.assign(new Error(code), { code });
  function stop(reason) {
    if (failure || completed || closing) return;
    failure = reason; pending = Buffer.alloc(0); queued = null;
    if (waiter) { const current = waiter; waiter = null; current.reject(reason); }
    stream.destroy();
    onStop();
  }
  function data(chunk) {
    if (failure || completed || closing) return;
    try {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      let end;
      while ((end = pending.indexOf(10)) !== -1) {
        if (end > LIMIT) fail('CLI_FRAME_LIMIT');
        const value = decode(pending.subarray(0, end));
        pending = pending.subarray(end + 1);
        // One operation is executing; retain at most one next frame. Keeping
        // this reader active lets native EOF interrupt a pending human read.
        if (waiter) { const current = waiter; waiter = null; current.resolve({ value, done: false }); }
        else if (queued === null) queued = value;
        else fail('CLI_INPUT_QUEUE_LIMIT');
      }
      if (pending.length > LIMIT) fail('CLI_FRAME_LIMIT');
    } catch (reason) { stop(reason); }
  }
  const end = () => stop(error(pending.length ? 'CLI_FRAME_INCOMPLETE' : eofCode()));
  const closed = () => stop(error('CLI_AGENT_CHANNEL_CLOSED'));
  stream.on('data', data); stream.on('end', end);
  stream.on('error', stop); stream.on('close', closed);
  return {
    check() { if (failure) throw failure; },
    next() {
      if (failure) return Promise.reject(failure);
      if (queued !== null) { const value = queued; queued = null; return Promise.resolve({ value, done: false }); }
      if (waiter || completed || closing) return Promise.reject(error('CLI_AGENT_CHANNEL_CLOSED'));
      return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
    },
    complete() { completed = true; pending = Buffer.alloc(0); queued = null; },
    async close() {
      closing = true; pending = Buffer.alloc(0); queued = null;
      if (waiter) { const current = waiter; waiter = null; current.reject(error('CLI_AGENT_CHANNEL_CLOSED')); }
      if (!stream.closed) await new Promise(resolve => { stream.once('close', resolve); stream.destroy(); });
      stream.off('data', data); stream.off('end', end);
      stream.off('error', stop); stream.off('close', closed);
    },
  };
}

function capture(file, limit = LIMIT) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > limit) fail('CLI_FILE_INVALID');
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, null); size += count;
      if (size > limit) fail('CLI_FILE_LIMIT');
      if (!count) return buffer.subarray(0, size);
    }
  } finally { fs.closeSync(fd); }
}

function dependencies() {
  // Verify the declared exact extracted dependency contents before executing them.
  // These local checks do not authenticate an archive origin or a provider.
  const roots = new Map();
  for (const archive of bindings.archives) {
    let publicPath;
    try { publicPath = require.resolve(archive.name); }
    catch { fail('CLI_DEPENDENCY_MISSING'); }
    const suffix = path.sep + archive.publicEntry.split('/').join(path.sep);
    if (!publicPath.endsWith(suffix)) fail('CLI_DEPENDENCY_PATHSET_MISMATCH');
    const root = publicPath.slice(0, -suffix.length);
    const packagePath = path.join(root, 'package.json');
    const rootInfo = fs.lstatSync(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('CLI_DEPENDENCY_PATHSET_MISMATCH');
    const metadata = parse(decode(capture(packagePath)));
    if (metadata.name !== archive.name || metadata.version !== archive.version) fail('CLI_DEPENDENCY_MISMATCH');
    const expected = new Map(archive.files.map(item => [item.path, item]));
    const actual = [];
    function walk(directory, prefix = '') {
      for (const name of fs.readdirSync(directory).sort()) {
        const relative = prefix ? prefix + '/' + name : name;
        const file = path.join(directory, name);
        const info = fs.lstatSync(file);
        if (info.isSymbolicLink()) fail('CLI_DEPENDENCY_PATHSET_MISMATCH');
        if (info.isDirectory()) walk(file, relative);
        else if (info.isFile()) {
          const entry = expected.get(relative);
          if (!entry || info.size !== entry.bytes) fail('CLI_DEPENDENCY_PATHSET_MISMATCH');
          const bytes = capture(file, entry.bytes);
          if (crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) fail('CLI_DEPENDENCY_CONTENT_MISMATCH');
          actual.push(relative);
        } else fail('CLI_DEPENDENCY_PATHSET_MISMATCH');
      }
    }
    walk(root);
    if (actual.length !== expected.size) fail('CLI_DEPENDENCY_PATHSET_MISMATCH');
    roots.set(archive.name, { root, packagePath, publicPath, scoped: createRequire(packagePath) });
  }
  for (const archive of bindings.archives) {
    const { scoped } = roots.get(archive.name);
    for (const name of new Set([...Object.keys(archive.dependencies), ...Object.keys(archive.peerDependencies)])) {
      const bound = roots.get(name);
      if (!bound || scoped.resolve(name) !== bound.publicPath) fail('CLI_DEPENDENCY_GRAPH_MISMATCH');
    }
    for (const name of Object.keys(archive.optionalDependencies)) {
      if (roots.has(name)) continue;
      try { scoped.resolve(name); }
      catch (error) { if (error.code === 'MODULE_NOT_FOUND') continue; throw error; }
      fail('CLI_OPTIONAL_DEPENDENCY_UNBOUND');
    }
  }
  for (const [name, version] of Object.entries(bindings.packages)) {
    if (!roots.has(name) || require(name + '/package.json').version !== version) fail('CLI_DEPENDENCY_MISMATCH');
  }
  const studio = require('@aikdna/kdna-studio-core');
  const core = require('@aikdna/kdna-core');
  const read = require('@aikdna/kdna-read');
  const corePath = require.resolve('@aikdna/kdna-core');
  for (const name of Object.keys(bindings.packages)) {
    const scoped = createRequire(require.resolve(name));
    if (scoped.resolve('@aikdna/kdna-core') !== corePath || scoped('@aikdna/kdna-core') !== core) fail('CLI_MULTIPLE_CORE_INSTANCES');
  }
  if (Object.keys(studio).sort().join(',') !== 'createSession,verifyCreationEvidence') fail('CLI_STUDIO_SURFACE_MISMATCH');
  return { studio, core, read };
}

function options(argv) {
  const command = argv[0] || 'help';
  if (!['help', '--help', '--version', 'session', 'verify', 'read'].includes(command)) fail('CLI_COMMAND_UNSUPPORTED');
  const opts = { command, materials: [] };
  const allowed = command === 'session' ? ['--out', '--human-fd', '--agent-adoption-fd', '--delegation-record', '--text', '--interview', '--synthetic-fixture'] :
    ['verify', 'read'].includes(command) ? ['--bundle', ...(command === 'read' ? ['--allow-read', '--budget', '--judgment'] : [])] : [];
  const seen = new Set();
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (!allowed.includes(flag)) fail('CLI_OPTION_UNSUPPORTED');
    if (!['--text', '--interview'].includes(flag) && seen.has(flag)) fail('CLI_OPTION_REPEATED');
    seen.add(flag);
    if (['--allow-read', '--synthetic-fixture'].includes(flag)) { opts[flag] = true; continue; }
    const value = argv[++i];
    if (!value || value.startsWith('--')) fail('CLI_OPTION_VALUE_REQUIRED');
    if (['--text', '--interview'].includes(flag)) opts.materials.push({ kind: flag.slice(2), file: value });
    else opts[flag] = value;
  }
  if (command === 'session' && !opts['--out']) fail('CLI_OUTPUT_REQUIRED');
  if (['verify', 'read'].includes(command) && !opts['--bundle']) fail('CLI_BUNDLE_REQUIRED');
  if (opts['--human-fd'] && (!/^\d+$/.test(opts['--human-fd']) || Number(opts['--human-fd']) < 3)) fail('CLI_HUMAN_CHANNEL_INVALID');
  if (opts['--agent-adoption-fd'] && (!/^\d+$/.test(opts['--agent-adoption-fd']) || Number(opts['--agent-adoption-fd']) < 3)) fail('CLI_AGENT_ADOPTION_CHANNEL_INVALID');
  if (Boolean(opts['--agent-adoption-fd']) !== Boolean(opts['--delegation-record']) || (opts['--agent-adoption-fd'] && opts['--human-fd'])) fail('CLI_ADOPTION_OPTIONS_INVALID');
  if (opts['--judgment'] && (!/^[1-9]\d*$/.test(opts['--judgment']) || !Number.isSafeInteger(Number(opts['--judgment'])))) fail('CLI_SELECTION_INVALID');
  return opts;
}

function humanChannel(opts) {
  let fd;
  let input;
  try {
    fd = opts['--agent-adoption-fd'] ? Number(opts['--agent-adoption-fd']) : opts['--human-fd'] ? Number(opts['--human-fd']) : fs.openSync('/dev/tty', 'r+');
    const info = fs.fstatSync(fd);
    // The CLI child owns its inherited read endpoint. Native stream handles
    // cancel reads on destroy; fs.ReadStream can retain a blocking pipe read.
    if (tty.isatty(fd)) input = new tty.ReadStream(fd, { highWaterMark: 4096 });
    else if (info.isFIFO() || info.isSocket()) input = new net.Socket({ fd, readable: true, writable: false, highWaterMark: 4096 });
    else fail('CLI_HUMAN_CHANNEL_REQUIRED');
  } catch (error) {
    if (fd !== undefined && !input) {
      try { fs.closeSync(fd); } catch (closeError) { if (closeError.code !== 'EBADF') throw closeError; }
    }
    fail('CLI_HUMAN_CHANNEL_REQUIRED');
  }
  const iterator = lines(input)[Symbol.asyncIterator]();
  return {
    cancel() { input.destroy(); },
    async receive(prompt) {
      const visible = prompt.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,
        char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
      process.stderr.write(visible + '\n');
      const next = await iterator.next();
      if (next.done) fail('CLI_HUMAN_CHANNEL_CLOSED');
      return text(next.value);
    },
    async close() {
      if (input.closed) return;
      await new Promise(resolve => {
        input.once('close', resolve);
        input.destroy();
      });
    },
  };
}

function humanReview(review) {
  return (review.kind === 'delegated_agent_editorial' ? 'Authorized Agent editorial review (identity not verified):' : 'Human-declared review (identity not verified):') + '\n' + JSON.stringify(review, null, 2);
}

function writeExport(session, destination) {
  const parent = fs.realpathSync(path.dirname(path.resolve(destination)));
  const target = path.join(parent, path.basename(destination));
  fs.mkdirSync(target, { mode: 0o700 }); // exclusive reservation, never replace an existing bundle
  const created = [];
  try {
    const result = session.exportAsset();
    const files = [['asset.kdna', result.bytes], ['creation-evidence.json', Buffer.from(json(result.evidence))],
      ['binding.json', Buffer.from(json(result.binding))]];
    for (const [name, bytes] of files) {
      const file = path.join(target, name);
      fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o400 }); created.push(file);
    }
    const readback = capture(path.join(target, 'asset.kdna'), 16 * LIMIT);
    const verification = session.completeSave(readback);
    const verificationFile = path.join(target, 'verification.json');
    fs.writeFileSync(verificationFile, json(verification), {flag:'wx',mode:0o400});created.push(verificationFile);
    const complete = path.join(target, 'complete.json');
    fs.writeFileSync(complete, json({ kind: 'private-studio-export-bundle', version: 2 }), { flag: 'wx', mode: 0o400 });
    created.push(complete); fs.chmodSync(target, 0o500);
    return { directory: target, binding: result.binding, verification };
  } catch (error) {
    for (const file of created.reverse()) fs.unlinkSync(file);
    fs.rmdirSync(target); throw error;
  }
}

async function session(opts) {
  const { studio } = dependencies();
  const kind = opts['--agent-adoption-fd'] ? 'delegated_agent_editorial' : 'human_claim_unverified';
  const authorization = kind === 'delegated_agent_editorial' ? parse(decode(capture(opts['--delegation-record']))) : null;
  if (authorization) {record(authorization,['coordinate','statement']);text(authorization.coordinate);text(authorization.statement);}
  const human = humanChannel(opts);
  let phase = 'request';
  const input = agentInput(process.stdin, () => human.cancel(),
    () => phase === 'interpret' ? 'CLI_AGENT_CHANNEL_CLOSED' : 'CLI_SESSION_UNEXPORTED');
  const seen = new Set();
  function request(raw, op) {
    input.check();
    const value = parse(raw); record(value, ['id', 'op', 'data']); text(value.id); text(value.op);
    if (seen.has(value.id)) fail('CLI_REQUEST_REPLAY');
    seen.add(value.id);
    if (op && value.op !== op) fail('CLI_REVIEW_IN_PROGRESS');
    return value;
  }
  let currentReview = null;
  const channelName = (kind === 'delegated_agent_editorial' ? 'terminal-authorized-agent:' : 'terminal-human:') + crypto.randomUUID();
  const workspace = studio.createSession({
    agent: { name: 'external-terminal-agent', version: '1' }, syntheticFixture: Boolean(opts['--synthetic-fixture']),
    adoptionInput: { kind, channel: channelName, ...(authorization ? {authorization} : {}), async receive(review) {
      currentReview = { ticket: crypto.randomUUID(), review };
      const reply = await human.receive(humanReview(review));
      input.check(); phase = 'interpret';
      emit({ event: 'adoption_reply', replyTo: currentReview.ticket, text: reply, review });
      return { id: 'message:' + crypto.randomUUID(), role: kind === 'delegated_agent_editorial' ? 'agent' : 'human', channel: channelName, review_id: review.review_id, text: reply };
    } },
    async interpretReply() {
      const next = await input.next();
      if (next.done) fail('CLI_AGENT_CHANNEL_CLOSED');
      const value = request(next.value, 'interpret'); record(value.data, ['replyTo', 'kind', 'choices']);
      if (value.data.replyTo !== currentReview.ticket) fail('CLI_REPLY_STALE');
      const intent = { kind: value.data.kind };
      if (Object.hasOwn(value.data,'choices')) intent.choices = value.data.choices;
      return intent;
    },
  });
  const operations = require('./component-operations').componentOperations(workspace, () => workspace.inspect().materials.map(m=>m.id));
  try {
    for (const item of opts.materials) {
      if (!['.txt', '.md', '.text'].includes(path.extname(item.file).toLowerCase())) fail('CLI_MATERIAL_TYPE_UNSUPPORTED');
      workspace.agent.recordMaterial({ kind: item.kind, title: path.basename(item.file), content: decode(capture(item.file)), coordinate: 'private-file:' + crypto.randomUUID() });
    }
    emit({ event: 'ready', workspace: workspace.inspect(), protocol: 'private-terminal-session-components-2' });
    for (;;) {
      phase = 'request';
      const next = await input.next(); if (next.done) fail('CLI_SESSION_UNEXPORTED');
      const value = request(next.value); let result;
      switch (value.op) {
        case 'brief': result = workspace.agent.setBrief(value.data); break;
        case 'propose': result = operations.propose(value.data); break;
        case 'revise': result = operations.revise(value.data); break;
        case 'interview': {
          record(value.data, ['title', 'question']); const question = text(value.data.question);
          phase = 'human';
          const answer = await human.receive(question);
          input.check();
          result = workspace.agent.recordMaterial({ kind: 'interview', title: value.data.title, content: question + '\n' + answer, coordinate: 'private-interview:' + crypto.randomUUID() }); break;
        }
        case 'review': record(value.data, []); phase = 'human'; result = await workspace.receiveAdoptionReply(); currentReview = null; break;
        case 'preview': record(value.data, []); result = workspace.agent.compilePreview(); break;
        case 'status': record(value.data, []); result = workspace.inspect(); break;
        case 'export': record(value.data, []); input.check(); result = writeExport(workspace, opts['--out']); input.complete(); break;
        default: fail('CLI_OPERATION_UNSUPPORTED');
      }
      input.check();
      emit({ id: value.id, status: 'ok', result });
      if (value.op === 'export') return;
    }
  } catch (error) {
    workspace.abort();
    input.check();
    throw error;
  } finally { await human.close(); await input.close(); }
}

async function consume(opts) {
  const { studio, core, read } = dependencies();
  const { readNode } = require('@aikdna/kdna-read/node');
  const { createTrustedReadControlProvider, createTrustedHostReadProvider } = require('@aikdna/kdna-read/embedding');
  const control = createTrustedReadControlProvider(() => ({ admission_response_limit_bytes: 65536 }));
  const request = { request_id: 'read:' + crypto.randomUUID(), tuple: bindings.tuple, mode: 'whole_asset', selection: null, handle: null,
    budget_bytes: opts['--budget'] === undefined ? 65536 : Number(opts['--budget']) };
  if (opts.command === 'read') {
    const admission = read.admitReadRequest(request, control);
    if (admission.channel !== 'admitted_request') { emit(admission); process.exitCode = 3; return; }
  }
  const directory = fs.realpathSync(opts['--bundle']);
  const bytes = capture(path.join(directory, 'asset.kdna'), 16 * LIMIT);
  const accepted = core.admitBytes(bytes);
  if (accepted.status !== 'accepted') { emit(accepted); process.exitCode = 3; return; }
  const complete = parse(decode(capture(path.join(directory, 'complete.json'))));
  record(complete, ['kind', 'version']);
  if (complete.kind !== 'private-studio-export-bundle' || complete.version !== 2) fail('CLI_BUNDLE_INCOMPLETE');
  const evidence = parse(decode(capture(path.join(directory, 'creation-evidence.json'), 16 * LIMIT)));
  const binding = parse(decode(capture(path.join(directory, 'binding.json'))));
  const verified = studio.verifyCreationEvidence(bytes, evidence, binding);
  if (verified.status !== 'consistent' || opts.command === 'verify') {
    emit(verified); if (verified.status !== 'consistent') process.exitCode = 3; return;
  }
  if (opts['--judgment']) {
    const item = accepted.snapshot.ir.catalog[Number(opts['--judgment']) - 1]; if (!item) fail('CLI_SELECTION_INVALID');
    request.mode = 'exact_selection';
    request.selection = { asset_id: accepted.snapshot.asset.asset_id, asset_version: accepted.snapshot.asset.asset_version, judgment_id: item.judgment_id };
  }
  let observations = 0;
  const host = opts['--allow-read'] ? createTrustedHostReadProvider({ observe: ({ request: current, snapshot }) => {
    const time = Date.now();
    return { host_id: 'host:terminal-local-read', host_epoch: request.request_id, decision_id: 'decision:' + (++observations), request_id: current.request_id,
      snapshot_id: snapshot.snapshot_id, A: snapshot.digests.A.observed, C: snapshot.digests.C.observed, scope: snapshot.ir.nodes.map(node => node.id),
      issued_at: time, expires_at: time + 10000, current_ms: time, decision: 'allow', policy_id: 'policy:explicit-local-read-only' };
  } }) : undefined;
  const result = await readNode(bytes, request, control, host); emit(result);
  if (result.channel !== 'read_envelope' || result.envelope.status !== 'ready') process.exitCode = 3;
}

async function main(argv) {
  const opts = options(argv);
  if (opts.command === '--version') { process.stdout.write(require('../package.json').version + '\n'); return; }
  if (['help', '--help'].includes(opts.command)) {
    process.stdout.write('kdna-studio session --out NEW_DIRECTORY [--text FILE] [--interview FILE] [--human-fd 3 | --agent-adoption-fd 3 --delegation-record FILE]\n' +
      'kdna-studio verify --bundle DIRECTORY\nkdna-studio read --bundle DIRECTORY [--allow-read] [--judgment 1] [--budget BYTES]\n' +
      'Agent operation JSONL uses stdin/stdout. Adoption replies use the terminal or a separate human/authorized-Agent fd, with explicit channel kind.\n' +
      'Ordinary and component-rich alternatives use the same current live creation graph. See docs/TERMINAL_AGENT_CREATION.md.\n'); return;
  }
  if (opts.command === 'session') await session(opts); else await consume(opts);
}
module.exports = { main };
