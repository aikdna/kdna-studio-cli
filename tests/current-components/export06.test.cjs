'use strict';
// export06: the explicit 0.6 export step. It invokes the published kdna CLI's
// `convert` on the bundle's asset.kdna and never writes the bundle itself.
//
// Placement: a delivered session bundle is a sealed read-only unit (directory
// dr-x------, files -r--------), so the default output is the sibling file
// <bundle>.0.6.kdna; inside the bundle is never written.
//
// Byte anchors: the two fixtures under fixtures/export06/ are the recorded
// design samples (plain 1524a09b…, system 93c3ca0c…) whose conversions were
// recorded as ff446e6f… / bcc53b18…. A live session re-drive is NOT
// byte-reproducible (each session embeds a fresh asset UUID and timestamps),
// so byte-exact assertions anchor on the recorded samples while the live case
// asserts structure and digest linkage.
//
// Conversion-dependent cases take the kdna CLI from STUDIO_TEST_KDNA_CLI
// (default: a local kdna-cli checkout); when none is available they skip,
// while the command-face and absence cases always run. The wrapper is test
// scaffolding only and is never committed. KDNA_CLI_TEST_BIN is deliberately
// not used: tests/current/dependency-binding.test.js reads it as a package
// source-root selector, and a conversion-CLI path there names a root without
// the studio-style src/public-bindings.json it requires.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const base = path.resolve(process.env.STUDIO_TEST_PACKAGE_ROOT || path.resolve(__dirname, '../..'));
const bin = path.join(base, 'bin/kdna-studio.js');
const fixtures = path.join(__dirname, 'fixtures/export06');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const PLAIN_0_5 = '1524a09b47d1f1921751c4b1d09aa95a908bd5ba6b69956df30b5c92195a8953';
const SYSTEM_0_5 = '93c3ca0ce0488aae8172405dacda290d6971a88fb4f104fb5568acbac547ee0f';
const PLAIN_0_6 = 'ff446e6fe23a7a0ae035ca08d11b2fb6f737aa7cf809156f047d46983cdc7b19';
const SYSTEM_0_6 = 'bcc53b18a095062348f249e51095c1ea8b5a4b4f6e69880549cff778609a2fe5';
const LOCAL_CHECKOUT = path.resolve(base, '../kdna-cli/src/cli.js');
const KDNA_CLI = process.env.STUDIO_TEST_KDNA_CLI || (fs.existsSync(LOCAL_CHECKOUT) ? LOCAL_CHECKOUT : null);
const conversion = { skip: KDNA_CLI ? false : 'no kdna CLI available (set STUDIO_TEST_KDNA_CLI)' };

const root = path.resolve(process.env.STUDIO_TEST_ARTIFACT_ROOT || path.join(__dirname, '.artifacts', String(process.pid)));
const scratch = path.join(root, 'export06');
fs.mkdirSync(scratch, { recursive: true });
test.after(() => { try { spawnSync('chmod', ['-R', 'u+w', scratch]); fs.rmSync(scratch, { recursive: true, force: true }); } catch {} });

function runStudio(argv, onSpawn) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [bin, ...argv], { cwd: base, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    let out = '', err = '', partial = '';
    const events = [];
    const timer = setTimeout(() => p.kill('SIGTERM'), 20000);
    p.stdout.on('data', (b) => { out += b; partial += b; let k; while ((k = partial.indexOf('\n')) >= 0) { const line = partial.slice(0, k); partial = partial.slice(k + 1); try { events.push(JSON.parse(line)); } catch {} } });
    p.stderr.on('data', (b) => { err += b; });
    p.stdin.on('error', () => {}); p.stdio[3].on('error', () => {});
    p.on('error', reject);
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err, events }); });
    if (onSpawn) onSpawn(p);
  });
}
const alt = (key, statement) => ({ localKey: key, title: 'Candidate ' + key, subject: 'A synthetic observation', scope: 'Declared scope only', statement, rationale: 'Stated basis for the synthetic candidate.', materials: [1], method: { method: { term: 'feeling' }, components: [{ localKey: 'states', type: 'taxonomy', method: { term: 'feeling' }, role: '个人感受', statement: 'The authored preference rests on an actual felt priority.', content: { items: [{ key: 'known', title: 'Observed', meaning: 'Input observation is present.' }], broader: [] } }] } });
let serial = 0;
async function liveSession() {
  const label = 'live-' + (++serial), folder = path.join(scratch, label); fs.mkdirSync(folder);
  const source = path.join(folder, 'material.txt'); fs.writeFileSync(source, 'SYNTHETIC_EXPORT06_MATERIAL');
  const delegation = path.join(folder, 'delegation.json'); fs.writeFileSync(delegation, JSON.stringify({ coordinate: 'fixture:authorized-local-agent', statement: 'Synthetic provider execution only, no real editorial acceptance.' }));
  const bundle = path.join(folder, 'bundle');
  let proc; let buffer = '';
  const send = (id, op, data) => proc.stdin.write(JSON.stringify({ id, op, data }) + '\n');
  const finished = await runStudio(['session', '--out', bundle, '--text', source, '--synthetic-fixture', '--agent-adoption-fd', '3', '--delegation-record', delegation], (p) => {
    proc = p;
    p.stdout.on('data', (b) => {
      buffer += b; let k;
      while ((k = buffer.indexOf('\n')) >= 0) {
        const raw = buffer.slice(0, k); buffer = buffer.slice(k + 1); let e; try { e = JSON.parse(raw); } catch { continue; }
        if (e.event === 'ready') send('brief', 'brief', { title: 'Export06 fixture', scope: 'Independent process synthetic integration.', highest_question: 'Which choice carries the ordering?' });
        else if (e.id === 'brief') send('proposal-a', 'propose', { localKey: 'system-a', alternatives: [alt('a-preserve', 'Retain unknown when evidence is absent.'), alt('a-infer', 'Treat absence as a negative.')] });
        else if (e.id === 'proposal-a') send('proposal-b', 'propose', { localKey: 'system-b', alternatives: [alt('b-preserve', 'Keep the boundary until the author decides.'), alt('b-infer', 'Move the boundary immediately.')] });
        else if (e.id === 'proposal-b') { send('select-review', 'review', {}); p.stdio[3].write('Select the preserve alternatives.\n'); }
        else if (e.event === 'adoption_reply') send('interpret-' + e.replyTo, 'interpret', { replyTo: e.replyTo, kind: e.review?.preview ? 'confirm' : 'select', ...(e.review?.preview ? {} : { choices: [{ judgmentLocalKey: 'system-a', alternativeLocalKey: 'a-preserve' }, { judgmentLocalKey: 'system-b', alternativeLocalKey: 'b-preserve' }] }) });
        else if (e.id === 'select-review') send('preview', 'preview', {});
        else if (e.id === 'preview') { send('confirm-review', 'review', {}); p.stdio[3].write('Confirm this preview.\n'); }
        else if (e.id === 'confirm-review') send('export', 'export', {});
      }
    });
  });
  assert.equal(finished.code, 0, finished.err);
  return bundle;
}
function wrapper() {
  const file = path.join(scratch, 'kdna-wrapper');
  fs.writeFileSync(file, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(KDNA_CLI)} "$@"\n`);
  fs.chmodSync(file, 0o755);
  return file;
}
function export06(argv, env = {}) {
  return spawnSync(process.execPath, [bin, 'export06', ...argv], { cwd: base, encoding: 'utf8', env: { ...process.env, ...env } });
}
function staged(name, fixture) {
  const bundle = path.join(scratch, name, 'bundle');
  fs.mkdirSync(bundle, { recursive: true });
  fs.copyFileSync(path.join(fixtures, fixture), path.join(bundle, 'asset.kdna'));
  return bundle;
}
function snapshot(dir) {
  return fs.readdirSync(dir).sort().map((name) => name + ':' + sha256(fs.readFileSync(path.join(dir, name))));
}
function validate(file) {
  return spawnSync(wrapper(), ['validate', file, '--json'], { encoding: 'utf8' });
}

test('the recorded plain sample converts byte-identically and the bundle is untouched', conversion, () => {
  const bundle = staged('plain', 'plain.0.5.kdna');
  assert.equal(sha256(fs.readFileSync(path.join(bundle, 'asset.kdna'))), PLAIN_0_5);
  const before = snapshot(bundle);
  const first = export06(['--bundle', bundle, '--kdna', wrapper()]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const row = JSON.parse(first.stdout.trim());
  assert.equal(row.status, 'saved');
  assert.equal(row.output.file, bundle + '.0.6.kdna');
  assert.equal(row.output.sha256, PLAIN_0_6);
  assert.equal(row.output.bytes, 36903);
  assert.equal(row.observation.source_A, 'sha256:' + PLAIN_0_5);
  assert.equal(row.observation.origin.source_format_version, '0.5.0');
  assert.equal(row.observation.origin.source_container_digest, 'sha256:' + PLAIN_0_5);
  const second = export06(['--bundle', bundle, '--kdna', wrapper(), '--output', path.join(scratch, 'plain-repeat.kdna')]);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(JSON.parse(second.stdout.trim()).output.sha256, PLAIN_0_6);
  assert.ok(fs.readFileSync(path.join(scratch, 'plain-repeat.kdna')).equals(fs.readFileSync(bundle + '.0.6.kdna')));
  assert.deepEqual(snapshot(bundle), before);
  const checked = validate(bundle + '.0.6.kdna');
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout.trim()).status, 'accepted');
});

test('the recorded system sample carries the declared layer through conversion', conversion, () => {
  const bundle = staged('system', 'system.0.5.kdna');
  assert.equal(sha256(fs.readFileSync(path.join(bundle, 'asset.kdna'))), SYSTEM_0_5);
  const result = export06(['--bundle', bundle, '--kdna', wrapper()]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const row = JSON.parse(result.stdout.trim());
  assert.equal(row.output.sha256, SYSTEM_0_6);
  assert.equal(row.output.bytes, 48780);
  const converted = fs.readFileSync(bundle + '.0.6.kdna');
  for (const sentence of ['Practice before novelty.', 'Boundary first.']) assert.ok(converted.includes(Buffer.from(sentence)));
  assert.equal(converted.toString('binary').split('backs the earlier choice').length - 1, 2);
  const checked = validate(bundle + '.0.6.kdna');
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout.trim()).status, 'accepted');
});

test('a repeat call passes the no-replace refusal through by name', conversion, () => {
  const bundle = staged('repeat', 'plain.0.5.kdna');
  const first = export06(['--bundle', bundle, '--kdna', wrapper()]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const before = sha256(fs.readFileSync(bundle + '.0.6.kdna'));
  const second = export06(['--bundle', bundle, '--kdna', wrapper()]);
  assert.equal(second.status, 1, second.stdout + second.stderr);
  const row = JSON.parse(second.stdout.trim());
  assert.equal(row.status, 'save_failed');
  assert.equal(row.code, 'KDNA_OUTPUT_EXISTS');
  assert.equal(sha256(fs.readFileSync(bundle + '.0.6.kdna')), before);
});

test('a live session bundle converts end to end and keeps every delivered file byte-identical', conversion, async () => {
  const bundle = await liveSession();
  const before = snapshot(bundle);
  const sealed = fs.statSync(bundle);
  assert.equal(sealed.mode & 0o200, 0, 'the delivered bundle directory is sealed read-only');
  const asset = fs.readFileSync(path.join(bundle, 'asset.kdna'));
  const result = export06(['--bundle', bundle, '--kdna', wrapper()]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const row = JSON.parse(result.stdout.trim());
  assert.equal(row.status, 'saved');
  assert.equal(row.output.file, bundle + '.0.6.kdna');
  assert.equal(row.observation.source_A, 'sha256:' + sha256(asset));
  assert.equal(row.observation.origin.source_container_digest, 'sha256:' + sha256(asset));
  assert.equal(row.observation.origin.source_format_version, '0.5.0');
  assert.deepEqual(snapshot(bundle), before);
  assert.equal(sha256(fs.readFileSync(bundle + '.0.6.kdna')), row.output.sha256);
  const checked = validate(bundle + '.0.6.kdna');
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout.trim()).status, 'accepted');
});

test('a missing kdna CLI is a named refusal with guidance and no output', () => {
  const bundle = staged('absent', 'plain.0.5.kdna');
  const result = export06(['--bundle', bundle, '--kdna', path.join(scratch, 'does-not-exist')], { PATH: '/usr/bin:/bin', KDNA_CLI_BIN: '' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /obtain it per the public instructions/);
  assert.match(result.stderr, /--kdna EXECUTABLE or set KDNA_CLI_BIN/);
  assert.match(result.stderr, /CLI_KDNA_CONVERT_MISSING/);
  assert.equal(fs.existsSync(bundle + '.0.6.kdna'), false);
  assert.deepEqual(snapshot(bundle), ['asset.kdna:' + PLAIN_0_5]);
});

test('input-face refusals are named and leave the bundle alone', () => {
  const missing = export06(['--bundle', path.join(scratch, 'no-such-bundle')]);
  assert.equal(missing.status, 2); assert.match(missing.stderr, /CLI_BUNDLE_ASSET_MISSING/);
  const bundle = staged('face', 'plain.0.5.kdna');
  const overwrite = export06(['--bundle', bundle, '--output', path.join(bundle, 'asset.kdna'), '--kdna', 'x']);
  assert.equal(overwrite.status, 2); assert.match(overwrite.stderr, /CLI_EXPORT06_OUTPUT_INVALID/);
  const noBundle = export06([]);
  assert.equal(noBundle.status, 2); assert.match(noBundle.stderr, /CLI_BUNDLE_REQUIRED/);
  const foreignOption = export06(['--bundle', bundle, '--text', 'x']);
  assert.equal(foreignOption.status, 2); assert.match(foreignOption.stderr, /CLI_OPTION_UNSUPPORTED/);
  const passwordArgv = export06(['--bundle', bundle, '--password', 'x']);
  assert.equal(passwordArgv.status, 2); assert.match(passwordArgv.stderr, /CLI_PASSWORD_ARGV_FORBIDDEN/);
  assert.deepEqual(snapshot(bundle), ['asset.kdna:' + PLAIN_0_5]);
});

test('convert refusals pass through by their own names, with no output created', conversion, () => {
  const source = path.join(fixtures, 'plain.0.5.kdna');
  const variant = (label, names, mutate) => {
    const dir = path.join(scratch, 'v-' + label); fs.mkdirSync(dir, { recursive: true });
    spawnSync('unzip', ['-o', '-q', source, '-d', dir]);
    mutate(dir);
    const file = path.join(scratch, label + '.kdna');
    spawnSync('zip', ['-0', '-X', '-q', file, ...names], { cwd: dir });
    const bundle = path.join(scratch, 'b-' + label); fs.mkdirSync(bundle, { recursive: true });
    fs.copyFileSync(file, path.join(bundle, 'asset.kdna'));
    return bundle;
  };
  const rewrite = (dir, mutate) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'kdna.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'kdna.json'), JSON.stringify(mutate(manifest)));
  };
  const cases = [
    [variant('checksums', ['mimetype', 'kdna.json', 'payload.kdnab', 'checksums.json'], (dir) => fs.writeFileSync(path.join(dir, 'checksums.json'), '{}\n')), 'source_failed', 'MIGRATION_SOURCE_EXTENSION_UNSUPPORTED'],
    [variant('historical', ['mimetype', 'kdna.json', 'payload.kdnab'], (dir) => rewrite(dir, (m) => ({ ...m, format_version: '0.4.0' }))), 'source_failed', 'MIGRATION_SOURCE_UNSUPPORTED_VERSION'],
    [variant('protected', ['mimetype', 'kdna.json', 'payload.kdnab'], (dir) => rewrite(dir, (m) => ({ ...m, payload: { ...m.payload, encrypted: true } }))), 'source_failed', 'MIGRATION_SOURCE_PROTECTED_UNSUPPORTED'],
  ];
  for (const [bundle, status, code] of cases) {
    const result = export06(['--bundle', bundle, '--kdna', wrapper()]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const row = JSON.parse(result.stdout.trim());
    assert.equal(row.status, status);
    assert.equal(row.diagnostic.code, code);
    assert.deepEqual(fs.readdirSync(bundle), ['asset.kdna']);
    assert.equal(fs.existsSync(bundle + '.0.6.kdna'), false);
  }
  const save = export06(['--bundle', staged('savefail', 'plain.0.5.kdna'), '--kdna', wrapper(), '--output', path.join(scratch, 'no-such-parent', 'out.kdna')]);
  assert.equal(save.status, 1, save.stdout + save.stderr);
  const saveRow = JSON.parse(save.stdout.trim());
  assert.equal(saveRow.status, 'save_failed');
  assert.equal(saveRow.code, 'KDNA_SAVE_FAILED');
  assert.equal(fs.existsSync(path.join(scratch, 'no-such-parent')), false);
});
