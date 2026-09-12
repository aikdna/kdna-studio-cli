#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

// Retired test material stays in the repository but out of this gate. Each
// entry is announced with one explicit receipt line so the shrinkage is never
// silent; see tests/retired.json and tests/legacy/README.md.
const retired = JSON.parse(
  fs.readFileSync(path.join(root, 'tests', 'retired.json'), 'utf8'),
).entries;
for (const entry of retired) {
  assert.ok(
    entry.file.startsWith('tests/legacy/'),
    `retired test ${entry.file} must live under tests/legacy/`,
  );
}

function node(args, label) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', shell: false });
  assert.equal(result.error, undefined, `${label} failed to start`);
  assert.equal(result.signal, null, `${label} was interrupted`);
  assert.equal(result.status, 0, `${label} failed`);
}

for (const entry of retired) {
  console.log(
    `KDNA-CI-NOT-RUN: ${entry.file} reason=retired_object_economy retired_object=${entry.retired_object}`,
  );
}

node(['scripts/acquire-trusted-npm-release.js'], 'trusted npm release acquisition');
node(['scripts/run-lint.js'], 'syntax checks');
node(['scripts/check-current-protocol-names.js'], 'protocol naming gate');
const retiredFiles = new Set(retired.map((entry) => entry.file));
const tests = fs.readdirSync(path.join(root, 'tests'))
  .filter((name) => name.endsWith('.test.js'))
  .filter((name) => !retiredFiles.has(path.join('tests', name)))
  .sort()
  .map((name) => path.join('tests', name));
node(['--test', ...tests], 'test suite');
console.log(`KDNA-CI-GATE: tests=${tests.length} retired=${retired.length}`);
