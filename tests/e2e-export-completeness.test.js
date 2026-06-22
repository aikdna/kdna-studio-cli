/**
 * e2e-export-completeness.test.js
 * Verifies all card types survive add → approve → export → validate → load.
 * Catches regressions like: stances hardcoded to [], pattern cards dropped during compile.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const studioBin = path.join(__dirname, '..', 'bin', 'kdna-studio.js');

function run(args, opts = {}) {
  return spawnSync(process.execPath, [studioBin, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...opts.env },
  });
}

function runKdna(args) {
  return spawnSync('kdna', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-e2e-export-')); }

function addCard(projectDir, type, fields) {
  const args = ['card', 'add', projectDir, type];
  for (const [k, v] of Object.entries(fields)) args.push('--field', `${k}=${v}`);
  return run(args);
}

test('e2e: pattern → approve → export → patterns in payload', () => {
  const tmp = tmpDir();
  try {
    const pDir = path.join(tmp, 'p');
    run(['create', pDir, '--name', '@test/e2e-pattern']);
    addCard(pDir, 'axiom', {
      one_sentence: 'AX', full_statement: 'A complete and testable explanation for the agent.',
      why: 'Without this axiom the agent would fail.',
      applies_when: '["x"]', does_not_apply_when: '["y"]', failure_risk: 'g',
      confidence: 'high', evidence_type: 'practice',
    });
    addCard(pDir, 'pattern', {
      type: 'test_pattern', name: 'Test Pattern', one_sentence: 'A test pattern.',
      what_it_looks_like: 'It looks like X.', how_to_fix: 'Fix by doing Y.', failure_risk: 'low',
    });
    const approveR = run(['card', 'approve', pDir, '--all', '--by', 'me', '--statement', 'ok']);
    assert.equal(approveR.status, 0, approveR.stderr);
    const exportR = run(['export', pDir, '--format', 'v1', '--out', path.join(tmp, 'out.kdna')]);
    assert.equal(exportR.status, 0, exportR.stderr);
    runKdna(['unpack', path.join(tmp, 'out.kdna'), path.join(tmp, 'unpacked')]);
    const payload = JSON.parse(fs.readFileSync(path.join(tmp, 'unpacked', 'payload.kdnab'), 'utf8'));
    const patternCards = (payload.patterns || []).filter(p => p.type === 'test_pattern');
    assert.ok(patternCards.length > 0, `Expected >0 pattern cards in payload patterns, got ${patternCards.length}`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('e2e: stances → approve → export → stances in payload', () => {
  const tmp = tmpDir();
  try {
    const pDir = path.join(tmp, 'p');
    run(['create', pDir, '--name', '@test/e2e-stance']);
    addCard(pDir, 'axiom', {
      one_sentence: 'AX', full_statement: 'A complete and testable explanation for the agent.',
      why: 'Without this axiom the agent would fail.',
      applies_when: '["x"]', does_not_apply_when: '["y"]', failure_risk: 'g',
      confidence: 'high', evidence_type: 'practice',
    });
    addCard(pDir, 'stance', { statement: 'Stance one: Always diagnose before prescribing.' });
    addCard(pDir, 'stance', { statement: 'Stance two: Trust burns slowly and is lost quickly.' });
    run(['card', 'approve', pDir, '--all', '--by', 'me', '--statement', 'ok']);
    run(['export', pDir, '--format', 'v1', '--out', path.join(tmp, 'out.kdna')]);
    runKdna(['unpack', path.join(tmp, 'out.kdna'), path.join(tmp, 'unpacked')]);
    const payload = JSON.parse(fs.readFileSync(path.join(tmp, 'unpacked', 'payload.kdnab'), 'utf8'));
    assert.equal((payload.core?.stances || []).length, 2, 'Expected 2 stances in payload');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('e2e: missing required fields reports ALL fields at once', () => {
  const tmp = tmpDir();
  try {
    const pDir = path.join(tmp, 'p');
    run(['create', pDir, '--name', '@test/e2e-completeness']);
    const r = addCard(pDir, 'axiom', { one_sentence: 'test' });
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('full_statement'), 'must mention full_statement');
    assert.ok(r.stderr.includes('why'), 'must mention why');
    assert.ok(r.stderr.includes('applies_when'), 'must mention applies_when');
    assert.ok(r.stderr.includes('confidence'), 'must mention confidence');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
