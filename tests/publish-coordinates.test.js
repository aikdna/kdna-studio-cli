'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { findingsFor } = require('../scripts/check-publish-coordinates');

// C01: a non-private package may not carry `file:` coordinates into a publish.
// This repository is non-private and now declares the exact registry
// coordinates of the published candidates, so the gate is green here; the
// negatives below keep it from being green for the wrong reason.

const root = path.resolve(__dirname, '..');
const checker = path.join(root, 'scripts', 'check-publish-coordinates.js');

test('the committed publishable manifest carries no publish-coordinate finding', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.private, undefined);
  assert.deepEqual(findingsFor(manifest), []);
  const result = spawnSync(process.execPath, [checker], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /KDNA-PUBLISH-COORDINATES: ok .*private=false findings=0/);
});

test('a non-private package on a file: coordinate is a finding', () => {
  const findings = findingsFor({
    name: '@aikdna/probe',
    dependencies: { '@aikdna/kdna-core': 'file:vendor/aikdna-kdna-core-0.37.1-rc.browser.1.tgz' },
  });
  assert.deepEqual(
    findings.map((finding) => finding.rule),
    ['non_private_package_declares_file_coordinate'],
  );
  assert.ok(findings[0].spec.startsWith('file:'));
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
