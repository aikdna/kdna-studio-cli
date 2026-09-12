'use strict';
/**
 * Shared creation evidence: the committed legacy producer fixture and the
 * current refusal contract.
 *
 * This file drove the retired format-1 shared creation-evidence producer path
 * through the retired `pd275` session harness. It was recorded as retired on a
 * *diagnostic* line the harness printed at import time, not on a statement about
 * the failure - and a diagnostic line is a reason only together with the
 * differential that shows it appears because the declared object is absent. That
 * differential does not hold here: with `legacy_origin` written back into
 * `src/terminal-workspace.js` the suite is still red (4 failing assertions) and
 * the same diagnostic still appears, so the diagnostic does not identify the
 * object as the cause.
 *
 * Restored as a current test, this file keeps what the current CLI is obliged to
 * keep: the committed legacy producer fixture stays byte-exact, so "actual
 * original producer bytes" remains a reproducible claim, and the current CLI
 * refuses a retired-format bundle instead of silently reinterpreting it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'bin', 'kdna-studio.js');
const LEGACY_ROOT = path.join(ROOT, 'fixtures', 'legacy-shared-evidence');
const ORIGIN = JSON.parse(fs.readFileSync(path.join(LEGACY_ROOT, 'ORIGIN.json'), 'utf8'));
const LEGACY_BUNDLE_NAMES = Object.freeze({
  'artifact.kdna': 'asset.kdna',
  'evidence.json': 'creation-evidence.json',
  'binding.json': 'binding.json',
  'verification.json': 'verification.json',
});

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function withScratch(body) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-shared-evidence-'));
  try {
    return body(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('the committed legacy producer fixture still matches its own origin manifest', () => {
  assert.equal(ORIGIN.kind, 'synthetic-legacy-producer-fixture');
  assert.equal(ORIGIN.legacyFormat, 'absent');
  for (const file of ORIGIN.files) {
    const bytes = fs.readFileSync(path.join(LEGACY_ROOT, file.name));
    assert.equal(bytes.length, file.bytes, `${file.name} byte length`);
    assert.equal(digest(bytes), file.sha256, `${file.name} sha256`);
  }
});

test('a retired-format bundle assembled from the fixture is refused, not reinterpreted', () => {
  withScratch((directory) => {
    for (const [from, to] of Object.entries(LEGACY_BUNDLE_NAMES)) {
      fs.copyFileSync(path.join(LEGACY_ROOT, from), path.join(directory, to));
    }
    fs.writeFileSync(path.join(directory, 'complete.json'), '{"kind":"private-studio-export-bundle","version":1}\n');
    for (const command of ['verify', 'read']) {
      const args = [command, '--bundle', directory, ...(command === 'read' ? ['--allow-read'] : [])];
      const result = run(args);
      assert.equal(result.status, 2, result.stderr);
      assert.equal(JSON.parse(result.stderr).code, 'CLI_BUNDLE_INCOMPLETE');
    }
  });
});

test('a current-contract bundle carrying a non-current evidence format is refused', () => {
  withScratch((directory) => {
    fs.copyFileSync(path.join(LEGACY_ROOT, 'artifact.kdna'), path.join(directory, 'asset.kdna'));
    fs.writeFileSync(path.join(directory, 'complete.json'), '{"kind":"private-studio-export-bundle","version":2}\n');
    fs.writeFileSync(
      path.join(directory, 'creation-evidence.json'),
      '{"format":"kdna.studio-creation-evidence/unsupported"}\n',
    );
    fs.writeFileSync(path.join(directory, 'binding.json'), '{}\n');
    for (const command of ['verify', 'read']) {
      const args = [command, '--bundle', directory, ...(command === 'read' ? ['--allow-read'] : [])];
      const result = run(args);
      assert.equal(result.status, 3, result.stderr);
      assert.equal(JSON.parse(result.stdout).reason, 'STUDIO_EVIDENCE_FORMAT_NOT_CURRENT');
    }
  });
});
