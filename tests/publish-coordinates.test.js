'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { findingsFor } = require('../scripts/check-publish-coordinates');

// C01: a non-private package may not carry `file:` coordinates into a publish.
// The committed kdna-studio-cli manifest is non-private and is still on the
// vendored graph, so this gate is expected to be RED today and has to be green
// before any push/publish batch: the finding is the record, not a suppression.

const root = path.resolve(__dirname, '..');
const checker = path.join(root, 'scripts', 'check-publish-coordinates.js');

test('the committed manifest is reported, not suppressed', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.notEqual(manifest.private, true);
  const findings = findingsFor(manifest);
  assert.ok(findings.length > 0, 'the vendored file: graph of a non-private package must be reported');
  for (const finding of findings) {
    assert.equal(finding.rule, 'non_private_package_declares_file_coordinate');
    assert.ok(finding.spec.startsWith('file:'));
  }
  const result = spawnSync(process.execPath, [checker], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /KDNA-PUBLISH-COORDINATES: findings=/);
  const reported = spawnSync(process.execPath, [checker, '--report-only'], { encoding: 'utf8' });
  assert.equal(reported.status, 0, reported.stdout + reported.stderr);
  assert.match(reported.stdout, /KDNA-PUBLISH-COORDINATES: findings=/);
});

test('a private package with the same graph is not a finding', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(findingsFor({ ...manifest, private: true }), []);
});

test('a non-private package on exact registry coordinates is not a finding', () => {
  assert.deepEqual(
    findingsFor({ name: '@aikdna/probe', dependencies: { '@aikdna/kdna-core': '0.24.0-rc.component-semantics.2' } }),
    [],
  );
  assert.equal(
    findingsFor({ name: '@aikdna/probe', dependencies: { '@aikdna/kdna-core': 'file:vendor/a.tgz' } }).length,
    1,
  );
  assert.equal(
    findingsFor({ name: '@aikdna/probe', devDependencies: { '@aikdna/kdna-core': 'file:vendor/a.tgz' } }).length,
    1,
  );
});

test('the gate points at the tree it is given', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-publish-coordinates-'));
  try {
    fs.writeFileSync(
      path.join(sandbox, 'package.json'),
      `${JSON.stringify({ name: '@aikdna/probe', dependencies: { '@aikdna/kdna-core': 'file:vendor/a.tgz' } }, null, 2)}\n`,
    );
    const result = spawnSync(process.execPath, [checker, '--root', sandbox], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /non_private_package_declares_file_coordinate/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
